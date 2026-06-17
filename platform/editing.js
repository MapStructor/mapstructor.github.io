/* editing.js — the ONLY editor-specific code, loaded dead-last in editor_temp.html.
   It adds editing chrome ON TOP of the viewer and never changes how the viewer
   renders. The engine renders the layer tree (generateLayersPanel); editing.js
   mutates the shared `layers` config, asks the engine to re-render, and persists.
   The tree is always identical to the viewer — only the editing chrome is added.

   Slice 2: anonymous sign-in, the +Layer/+Group/+Section bar with an inline name
   field and a parent picker (nesting), and INSERT-ON-ADD persistence — each new
   item inserts exactly its own row(s); existing rows are never touched (so a
   failure can never corrupt the project, unlike a delete-and-rewrite). Field
   mapping mirrors tools/seed/seed.js. */
(function () {
  if (typeof platformProjectId === 'undefined' || !platformProjectId) return;

  var SUPABASE_URL = 'https://eqpxlwbjqiwfjlsuapvu.supabase.co';
  var SUPABASE_KEY = 'sb_publishable_ijLmSmMUeNBrgMGL8Aol4g_S5-xwUzD';
  var db = (window.supabase) ? window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY) : null;
  var projectId = platformProjectId;
  var userId = null;

  var loaded = false;
  var nextSort = 1;
  var slugToLayerDbId = {};
  var idsReady = null;
  var _dragId = null;

  // ── Sign in (for saving), then load the project's db ids ────────────────────
  function start() {
    if (!db) return;
    idsReady = (async function () {
      try {
        var s = await db.auth.getSession();
        if (s.data && s.data.session) userId = s.data.session.user.id;
        else { var a = await db.auth.signInAnonymously(); if (a.data && a.data.session) userId = a.data.session.user.id; }
      } catch (e) { console.warn('editing: sign-in failed', e); }
      await loadIds();
    })();
  }
  async function loadIds() {
    try {
      var bundle = await ConfigLoader.fetchProjectBundle(db, projectId);
      var maxSort = 0, sMap = {}, gMap = {};
      (bundle.sections || []).forEach(function (s) { if (s.slug != null) sMap[s.slug] = s.id; if (s.sort_order > maxSort) maxSort = s.sort_order; });
      (bundle.groups || []).forEach(function (g) { if (g.slug != null) gMap[g.slug] = g.id; if (g.sort_order > maxSort) maxSort = g.sort_order; });
      var stMap = {};
      (bundle.projectLayers || []).forEach(function (pl) { if (pl.layers && pl.layers.slug != null) { slugToLayerDbId[pl.layers.slug] = pl.layers.id; stMap[pl.layers.slug] = pl.layers.source_type; } if (pl.sort_order > maxSort) maxSort = pl.sort_order; });
      if (typeof layers !== 'undefined') attachIds(layers, sMap, gMap, stMap);
      nextSort = maxSort + 1;
      loaded = true;
      rerender();   // re-render so enhanceRows wires toggle/draw for now-typed drawn layers
    } catch (e) { console.warn('editing: could not load project ids', e); }
  }
  // Stamp the db id onto each existing container node so we can nest under it.
  function attachIds(arr, sMap, gMap, stMap) {
    (arr || []).forEach(function (n) {
      if (n.type === 'section' && sMap[n.id] != null) n._dbId = sMap[n.id];
      else if (n.type === 'group' && gMap[n.id] != null) n._dbId = gMap[n.id];
      else if (n.id && stMap && stMap[n.id] != null) n.source_type = stMap[n.id];  // so loaded drawn layers are drawable + toggleable
      if (n.children) attachIds(n.children, sMap, gMap, stMap);
    });
  }

  // ── config → db (mirror of tools/seed/seed.js) ──────────────────────────────
  function val(v) { return v === undefined ? null : v; }
  var LEAF_CONSUMED = ["id","label","iconColor","checked","type","source","layout","source-layer","paint","highlight","popupStyle","prop","click","infoId","zoomCenter","zoomLevel","zoomLevelLeft","zoomLevelRight","panel"];
  var GROUP_CONSUMED = ["type","id","label","children","zoomCenter","zoomLevel","infoId","collapsed","checked"];
  var SECTION_CONSUMED = ["type","id","label","children"];
  var PANEL_CONSUMED = ["encyclopediaBase","nidProp","color","render"];
  function rawFrom(node, consumed) { var raw = {}; Object.keys(node).forEach(function (k) { if (consumed.indexOf(k) === -1) raw[k] = node[k]; }); return raw; }

  function leafRow(node) {
    var raw = rawFrom(node, LEAF_CONSUMED);
    var panel = node.panel || null;
    if (panel) { var extras = {}; Object.keys(panel).forEach(function (k) { if (PANEL_CONSUMED.indexOf(k) === -1) extras[k] = panel[k]; }); if (Object.keys(extras).length) raw.panel = extras; }
    var src = node.source || {}; var isTilesUrl = !!src.tiles;
    return {
      slug: node.id, name: val(node.label), color: val(node.iconColor), type: val(node.type),
      source_type: node.source_type || (isTilesUrl ? "vector-tiles-url" : (src.url ? "mapbox-tileset" : null)),
      source_url: isTilesUrl ? src.tiles[0] : val(src.url), source_layer: val(node["source-layer"]),
      source_minzoom: val(src.minzoom), source_maxzoom: val(src.maxzoom),
      paint: val(node.paint), layout: val(node.layout),
      hover: node.highlight ? true : null, hover_paint: val(node.highlight), click: val(node.click),
      popup_style: val(node.popupStyle), popup_prop: val(node.prop), info_id: val(node.infoId),
      enabled_by_default: val(node.checked),
      zoom_center_lng: node.zoomCenter ? node.zoomCenter[0] : null, zoom_center_lat: node.zoomCenter ? node.zoomCenter[1] : null,
      zoom_level: val(node.zoomLevel), zoom_level_left: val(node.zoomLevelLeft), zoom_level_right: val(node.zoomLevelRight),
      content_base_url: panel ? val(panel.encyclopediaBase) : null, content_id_prop: panel ? val(panel.nidProp) : null,
      panel_color: panel ? val(panel.color) : null, is_public: true,
      raw_config: Object.keys(raw).length ? raw : null,
    };
  }
  function sectionRow(node, sort) {
    var sRaw = rawFrom(node, SECTION_CONSUMED);
    return { project_id: projectId, name: val(node.label), sort_order: sort, slug: node.id, raw_config: Object.keys(sRaw).length ? sRaw : null };
  }
  function groupRow(node, sectionId, sort) {
    var gRaw = rawFrom(node, GROUP_CONSUMED);
    return { project_id: projectId, section_id: sectionId, name: val(node.label), sort_order: sort, slug: node.id, collapsed: val(node.collapsed), checked: val(node.checked), info_id: val(node.infoId), raw_config: Object.keys(gRaw).length ? gRaw : null };
  }
  async function insertOne(table, row) {
    var res = await db.from(table).insert(row).select('id').single();
    if (res.error) throw new Error(table + ' insert: ' + res.error.message);
    return res.data.id;
  }

  // ── tree helpers ────────────────────────────────────────────────────────────
  function rerender() { if (typeof generateLayersPanel === 'function') generateLayersPanel(); }
  function uid() { return 'new-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5); }
  var LAYER_COLORS = ['#4a9eff', '#e8553e', '#3bb273', '#b56cd6', '#e8a33e', '#3ec0d0', '#d64576'];
  function nextColor() {
    var n = 0;
    (function count(arr) { (arr || []).forEach(function (x) { if (x.source_type === 'geojson-supabase') n++; if (x.children) count(x.children); }); })(typeof layers !== 'undefined' ? layers : []);
    return LAYER_COLORS[n % LAYER_COLORS.length];
  }
  function makeNode(type, name) {
    var id = uid();
    if (type === 'section') return { type: 'section', id: id, label: name, caretId: 'caret-' + id, containerId: 'cont-' + id, children: [] };
    if (type === 'group')   return { type: 'group', id: id, label: name, caretId: 'caret-' + id, containerId: 'cont-' + id, itemSelector: '.' + id + '_item', children: [], checked: true, collapsed: false };
    return { id: id, label: name, containerId: 'cont-' + id, className: id, topLayerClass: id, iconType: 'square', iconColor: nextColor(), isSolid: true, checked: true, source_type: 'geojson-supabase' };
  }
  // A tileset layer is an engine-shaped leaf backed by a hosted vector source (NOT geojson-supabase,
  // so MapboxDraw never touches it and leafRow derives source_type 'mapbox-tileset' from source.url).
  var TILESET_ICON = { fill: 'square', line: 'slash', circle: 'circle' };
  function tilesetDefaultPaint(type, color) {
    if (type === 'fill') return { 'fill-color': color, 'fill-opacity': 0.4, 'fill-outline-color': color };
    if (type === 'line') return { 'line-color': color, 'line-width': 1.5 };
    return { 'circle-radius': 5, 'circle-color': color, 'circle-stroke-width': 1, 'circle-stroke-color': '#000' };
  }
  function makeTilesetNode(name, url, sourceLayer, type, color) {
    var id = uid();
    var node = { id: id, label: name, type: type, source: { type: 'vector', url: url }, paint: tilesetDefaultPaint(type, color),
      containerId: 'cont-' + id, className: id, topLayerClass: id, iconType: TILESET_ICON[type] || 'square', iconColor: color, isSolid: true, checked: true, toggleElement: id };
    if (sourceLayer) node['source-layer'] = sourceLayer;
    return node;
  }
  // A tileset/vector layer renders via the engine's map layers (not MapboxDraw), so it's styled by
  // setPaintProperty on <id>-left/right. True for freshly-added (node.source.type) and loaded
  // (source_type stamped from the column) tilesets; false for drawn layers + containers.
  function isTilesetNode(node) {
    if (!node || node.type === 'section' || node.type === 'group') return false;
    if (node.source && node.source.type && node.source.type !== 'geojson') return true;
    if (node.source_type && node.source_type !== 'geojson-supabase') return true;
    return false;
  }
  function findNodeById(arr, id) {
    for (var i = 0; i < (arr || []).length; i++) { var n = arr[i]; if (n.id === id) return n; if (n.children) { var f = findNodeById(n.children, id); if (f) return f; } }
    return null;
  }
  function findParent(arr, target, parent) {
    for (var i = 0; i < (arr || []).length; i++) {
      if (arr[i] === target) return parent || null;
      if (arr[i].children) { var r = findParent(arr[i].children, target, arr[i]); if (r !== undefined) return r; }
    }
    return undefined;
  }
  function containers(arr, depth, out) {
    (arr || []).forEach(function (n) {
      if (n.type === 'section' || n.type === 'group') { out.push({ node: n, depth: depth, type: n.type }); containers(n.children, depth + 1, out); }
    });
    return out;
  }
  function removeFromTree(arr, target) {
    for (var i = 0; i < (arr || []).length; i++) {
      if (arr[i] === target) { arr.splice(i, 1); return true; }
      if (arr[i].children && removeFromTree(arr[i].children, target)) return true;
    }
    return false;
  }

  // ── Slice 3: rename + delete on the engine-rendered rows ─────────────────────
  // Identify a rendered row's node: leaves/groups carry the slug on their checkbox
  // id; a section header is the first child of <div id="<slug>">.
  function rowNodeId(row) {
    var cb = row.querySelector('input[type="checkbox"]');
    if (cb && cb.id) return cb.id;
    var p = row.parentElement;
    if (p && p.id && p.firstElementChild === row) return p.id;
    return null;
  }
  function collectDbIds(node, acc) {
    if (node.type === 'section') { if (node._dbId) acc.sections.push(node._dbId); (node.children || []).forEach(function (c) { collectDbIds(c, acc); }); }
    else if (node.type === 'group') { if (node._dbId) acc.groups.push(node._dbId); (node.children || []).forEach(function (c) { collectDbIds(c, acc); }); }
    else { var lid = slugToLayerDbId[node.id]; if (lid) acc.layerIds.push(lid); }
  }
  async function onDelete(id) {
    var node = findNodeById(layers, id); if (!node) return;
    var isContainer = node.type === 'section' || node.type === 'group';
    var kids = isContainer && node.children && node.children.length;
    if (!window.confirm('Delete "' + (node.label || node.id) + '"?' + (kids ? ' Its contents will move out — they are NOT deleted.' : ''))) return;
    if (idsReady) { try { await idsReady; } catch (e) {} }
    setStatus('Saving…');
    try {
      if (isContainer) {
        // Ungroup: splice the children into the container's place, then delete ONLY
        // the container row. persistOrder re-parents the children + renumbers.
        var loc = locate(layers, node);
        if (loc) loc.arr.splice.apply(loc.arr, [loc.idx, 1].concat(node.children || []));
        else removeFromTree(layers, node);
        if (node._dbId) { var dc = await db.from(node.type === 'group' ? 'layer_groups' : 'layer_sections').delete().eq('id', node._dbId); if (dc.error) throw new Error(dc.error.message); }
        rerender();
        await persistOrder();
      } else {
        // Leaf: remove from the project but KEEP the features + layers row, so it's fully undoable
        // (re-adding its project_layers row restores it with its data — works for any layer size).
        var lid = slugToLayerDbId[node.id];
        var loc = locate(layers, node), plf = null;
        if (lid) {
          try { var cur = await db.from('project_layers').select('section_id, group_id, sort_order').eq('project_id', projectId).eq('layer_id', lid).single(); plf = cur.data || null; } catch (e) {}
          var dp = await db.from('project_layers').delete().eq('project_id', projectId).eq('layer_id', lid); if (dp.error) throw new Error(dp.error.message);
        }
        removeMapLayers(node.id);           // drop tileset / engine-rendered map layers
        removeFromTree(layers, node);
        (function (n, llid, fields, arr, idx) {
          async function readd() {
            if (llid) { try { await db.from('project_layers').insert({ project_id: projectId, layer_id: llid, section_id: fields ? fields.section_id : null, group_id: fields ? fields.group_id : null, sort_order: fields ? fields.sort_order : nextSort++ }); } catch (e) {} }
            if (arr) arr.splice(Math.min(idx, arr.length), 0, n); else layers.push(n);
            rerender(); await loadFeatures();
            if (isTilesetNode(n)) renderTilesetOnMap(n);   // (large geojson layers re-render on reload)
          }
          async function reremove() {
            if (llid) { try { await db.from('project_layers').delete().eq('project_id', projectId).eq('layer_id', llid); } catch (e) {} }
            removeMapLayers(n.id); removeFromTree(layers, n); rerender(); await loadFeatures();
          }
          pushUndo(readd, reremove, 'delete ' + (n.label || 'layer'));
        })(node, lid, plf, loc ? loc.arr : null, loc ? loc.idx : 0);
        rerender(); await loadFeatures();   // drops its MapboxDraw features too (after the undo entry exists)
      }
      setStatus('Saved');
    } catch (e) { console.warn('editing: delete failed', e); setStatus('Delete failed: ' + e.message); }
  }
  async function setNodeName(id, name) {
    var node = findNodeById(layers, id); if (!node) return;
    if (node.type === 'section')      { try { await db.from('layer_sections').update({ name: name }).eq('id', node._dbId); } catch (e) {} }
    else if (node.type === 'group')   { try { await db.from('layer_groups').update({ name: name }).eq('id', node._dbId); } catch (e) {} }
    else { var lid = slugToLayerDbId[node.id]; if (lid) { try { await db.from('layers').update({ name: name }).eq('id', lid); } catch (e) {} } }
    node.label = name; rerender();
  }
  async function onRename(id) {
    var node = findNodeById(layers, id); if (!node) return;
    var oldName = node.label || '';
    var name = window.prompt('Rename:', oldName);
    if (name == null) return; name = name.trim(); if (!name || name === oldName) return;
    if (idsReady) { try { await idsReady; } catch (e) {} }
    setStatus('Saving…');
    try {
      await setNodeName(id, name);
      pushUndo(function () { return setNodeName(id, oldName); }, function () { return setNodeName(id, name); }, 'rename');
      setStatus('Saved');
    } catch (e) { console.warn('editing: rename failed', e); setStatus('Rename failed: ' + e.message); }
  }
  function enhanceRows() {
    var panel = document.getElementById('layers-panel-content');
    if (!panel) return;
    panel.querySelectorAll('.layer-list-row').forEach(function (row) {
      if (row.getAttribute('data-enh')) return;
      var id = rowNodeId(row); if (!id) return;
      row.setAttribute('data-enh', '1');
      row.setAttribute('data-node-id', id);
      if (id === activeLayerId) row.classList.add('editor-active');
      // click the row body (not a control) to make it the active draw target
      row.addEventListener('click', function (e) {
        if (e.target.closest('input,.layer-buttons-block,.editor-del,.compress-expand-icon,.toggle')) return;
        setActiveLayer(id);
      });
      var enNode = findNodeById(layers, id);
      if (enNode && enNode.source_type === 'geojson-supabase') {
        var enCb = row.querySelector('input[type="checkbox"]');
        if (enCb) enCb.addEventListener('change', function () { toggleDrawnLayer(id, enCb.checked); });
      }
      var del = document.createElement('span');
      del.className = 'editor-del'; del.innerHTML = '&times;'; del.title = 'Delete';
      del.addEventListener('click', function (e) { e.stopPropagation(); e.preventDefault(); onDelete(id); });
      row.appendChild(del);
      var label = row.querySelector('label') || row.querySelector('.container-name');
      if (label) label.addEventListener('dblclick', function (e) { e.stopPropagation(); e.preventDefault(); onRename(id); });

      // drag-reorder
      row.draggable = true;
      row.addEventListener('dragstart', function (e) { _dragId = id; if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'; row.classList.add('editor-dragging'); });
      row.addEventListener('dragend', function () { row.classList.remove('editor-dragging'); clearDropMarks(); _dragId = null; });
      row.addEventListener('dragover', function (e) {
        if (!_dragId || _dragId === id) return;
        e.preventDefault();
        var t = findNodeById(layers, id); if (!t) return;
        clearDropMarks();
        var pos = dropPos(row, t, e.clientY);
        row.classList.add(pos === 'into' ? 'editor-drop-into' : (pos === 'before' ? 'editor-drop-before' : 'editor-drop-after'));
      });
      row.addEventListener('dragleave', function () { row.classList.remove('editor-drop-before', 'editor-drop-after', 'editor-drop-into'); });
      row.addEventListener('drop', function (e) {
        e.preventDefault(); e.stopPropagation();
        clearDropMarks();
        var dragId = _dragId; _dragId = null;
        if (!dragId || dragId === id) return;
        var dragNode = findNodeById(layers, dragId), targetNode = findNodeById(layers, id);
        if (!dragNode || !targetNode) return;
        if (moveNode(dragNode, targetNode, dropPos(row, targetNode, e.clientY))) { rerender(); persistOrder(); }
      });
    });
  }

  // ── drag-reorder: move a node in the tree, then renumber the whole tree's
  // sort_order + parent links with UPDATEs only (never delete — so it's safe). ──
  function locate(arr, target) {
    for (var i = 0; i < (arr || []).length; i++) { if (arr[i] === target) return { arr: arr, idx: i }; if (arr[i].children) { var r = locate(arr[i].children, target); if (r) return r; } }
    return null;
  }
  function isAncestor(a, b) {
    if (!a.children) return false;
    for (var i = 0; i < a.children.length; i++) { if (a.children[i] === b) return true; if (isAncestor(a.children[i], b)) return true; }
    return false;
  }
  function moveNode(dragNode, targetNode, pos) {
    if (dragNode === targetNode || isAncestor(dragNode, targetNode)) return false;
    if (dragNode.type === 'section' && pos === 'into') return false;               // sections stay top-level
    if (pos === 'into' && targetNode.type !== 'section' && targetNode.type !== 'group') pos = 'after';
    removeFromTree(layers, dragNode);
    if (pos === 'into') { targetNode.children = targetNode.children || []; targetNode.children.push(dragNode); targetNode.collapsed = false; }
    else { var loc = locate(layers, targetNode); if (!loc) layers.push(dragNode); else loc.arr.splice(loc.idx + (pos === 'after' ? 1 : 0), 0, dragNode); }
    return true;
  }
  async function up(table, patch, id) { if (!id) return; var r = await db.from(table).update(patch).eq('id', id); if (r.error) throw new Error(r.error.message); }
  async function persistOrder() {
    if (idsReady) { try { await idsReady; } catch (e) {} }
    if (!loaded) return;
    setStatus('Saving…');
    var sort = 0;
    async function walk(node, sectionId, groupId) {
      var s = sort++;
      if (node.type === 'section') {
        await up('layer_sections', { sort_order: s }, node._dbId);
        for (var i = 0; i < (node.children || []).length; i++) await walk(node.children[i], node._dbId, null);
      } else if (node.type === 'group') {
        await up('layer_groups', { sort_order: s, section_id: sectionId }, node._dbId);
        for (var j = 0; j < (node.children || []).length; j++) await walk(node.children[j], sectionId, node._dbId);
      } else {
        var lid = slugToLayerDbId[node.id];
        if (lid) { var r = await db.from('project_layers').update({ sort_order: s, section_id: sectionId, group_id: groupId }).eq('project_id', projectId).eq('layer_id', lid); if (r.error) throw new Error(r.error.message); }
      }
    }
    try { for (var k = 0; k < layers.length; k++) await walk(layers[k], null, null); setStatus('Saved'); }
    catch (e) { console.warn('editing: reorder save failed', e); setStatus('Reorder save failed: ' + e.message); }
  }
  // Where would a drop land on this row? top 30% = before, bottom 30% = after,
  // middle of a container = into it.
  function dropPos(row, targetNode, clientY) {
    var rect = row.getBoundingClientRect();
    var frac = rect.height ? (clientY - rect.top) / rect.height : 0.5;
    var isC = targetNode.type === 'section' || targetNode.type === 'group';
    return frac < 0.3 ? 'before' : (frac > 0.7 ? 'after' : (isC ? 'into' : 'after'));
  }
  function clearDropMarks() {
    var panel = document.getElementById('layers-panel-content'); if (!panel) return;
    panel.querySelectorAll('.editor-drop-before,.editor-drop-after,.editor-drop-into').forEach(function (el) {
      el.classList.remove('editor-drop-before', 'editor-drop-after', 'editor-drop-into');
    });
  }

  // ── add (insert-on-add) ─────────────────────────────────────────────────────
  async function addItem(type, name, parent) {
    if (typeof layers === 'undefined') return;
    if (idsReady) { try { await idsReady; } catch (e) {} }
    if (!loaded) { setStatus('Still loading — try again'); return; }
    var node = makeNode(type, name);
    var sort = nextSort++;
    setStatus('Saving…');
    try {
      if (type === 'section') {
        node._dbId = await insertOne('layer_sections', sectionRow(node, sort));
      } else if (type === 'group') {
        var secId = (parent && parent.type === 'section') ? parent._dbId : null;
        node._dbId = await insertOne('layer_groups', groupRow(node, secId, sort));
      } else {
        var sId = null, gId = null;
        if (parent && parent.type === 'group') { gId = parent._dbId; var ps = findParent(layers, parent); if (ps && ps.type === 'section') sId = ps._dbId; }
        else if (parent && parent.type === 'section') { sId = parent._dbId; }
        var layerId = await insertOne('layers', leafRow(node));
        slugToLayerDbId[node.id] = layerId;
        await insertOne('project_layers', { project_id: projectId, layer_id: layerId, sort_order: sort, section_id: sId, group_id: gId });
      }
      // persisted OK → show it in the tree
      if (parent) { parent.children = parent.children || []; parent.children.push(node); parent.collapsed = false; parent.open = true; }
      else layers.push(node);
      rerender();
      if (type === 'layer') setActiveLayer(node.id);  // draw into the layer you just made
      setStatus('Saved');
    } catch (e) {
      console.warn('editing: add failed', e);
      setStatus('Save failed: ' + e.message);
    }
  }

  // Add a hosted vector tileset as a first-class layer (persist like addItem's leaf branch,
  // then render it on both maps the way the engine does at load).
  async function addTileset(name, url, sourceLayer, type, parent) {
    if (typeof layers === 'undefined') return;
    if (idsReady) { try { await idsReady; } catch (e) {} }
    if (!loaded) { setStatus('Still loading — try again'); return; }
    var node = makeTilesetNode(name, url, sourceLayer, type, nextColor());
    var sort = nextSort++;
    setStatus('Saving…');
    try {
      var sId = null, gId = null;
      if (parent && parent.type === 'group') { gId = parent._dbId; var ps = findParent(layers, parent); if (ps && ps.type === 'section') sId = ps._dbId; }
      else if (parent && parent.type === 'section') { sId = parent._dbId; }
      var layerId = await insertOne('layers', leafRow(node));
      slugToLayerDbId[node.id] = layerId;
      await insertOne('project_layers', { project_id: projectId, layer_id: layerId, sort_order: sort, section_id: sId, group_id: gId });
      if (parent) { parent.children = parent.children || []; parent.children.push(node); parent.collapsed = false; parent.open = true; }
      else layers.push(node);
      rerender();
      renderTilesetOnMap(node);
      if (typeof refreshLayers === 'function') refreshLayers();  // sync visibility to the new checkbox
      setActiveLayer(node.id);   // open its style panel (color/opacity/outline/width + Split for fills)
      setStatus('Saved');
    } catch (e) { console.warn('editing: add tileset failed', e); setStatus('Save failed: ' + e.message); }
  }
  // Mirror addLayersToMap for a single node: add <id>-left / <id>-right on both maps via the
  // engine's addMapLayer (same call the viewer uses), filtered by the current timeline date.
  function renderTilesetOnMap(node) {
    if (typeof addMapLayer !== 'function') return;
    var date;
    try { var d = (window.moment && window.$) ? moment($('#date').text()).format('YYYYMMDD') : ''; date = /^\d{8}$/.test(d) ? parseInt(d, 10) : undefined; } catch (e) { date = undefined; }
    [['left', beforeMap], ['right', (typeof afterMap !== 'undefined' ? afterMap : null)]].forEach(function (pair) {
      var side = pair[0], map = pair[1]; if (!map) return;
      var id = node.id + '-' + side;
      try { if (!map.getLayer(id)) addMapLayer(map, Object.assign({}, node, { id: id }), date); }
      catch (e) { console.warn('editing: tileset render failed', e); }
      // a fill tileset's outline renders as a real line layer (sharing the fill's source) so it can
      // exceed Mapbox's 1px fill-outline cap — mirrors the engine's stroke block, with source-layer.
      if (node.type === 'fill' && node.paint && node.paint['fill-outline-color']) {
        var sid = node.id + '-stroke-' + side;
        if (!map.getLayer(sid)) {
          var sc = { id: sid, type: 'line', source: id, paint: { 'line-color': node.paint['fill-outline-color'], 'line-width': node.paint['line-width'] || 1, 'line-opacity': node.paint['line-opacity'] != null ? node.paint['line-opacity'] : 1 }, layout: { 'line-cap': 'round', 'line-join': 'round' } };
          if (node['source-layer']) sc['source-layer'] = node['source-layer'];
          try { addMapLayer(map, sc, date); } catch (e) { console.warn('editing: tileset stroke failed', e); }
        }
      }
    });
  }

  // ── additive chrome (sibling of #layers-panel-content, survives re-render) ──
  function commit(type) {
    var name = (document.getElementById('editor-name').value || '').trim();
    if (!name) return;
    var sel = document.getElementById('editor-parent');
    var parent = (sel && sel.value) ? findNodeById(layers, sel.value) : null;
    showButtons();
    addItem(type, name, parent);
  }
  function showButtons() {
    var bar = document.getElementById('editor-add-bar');
    bar.innerHTML = '<div class="erow" style="margin-bottom:6px;">' +
      '<button data-type="layer">+ Layer</button>' +
      '<button data-type="tileset">+ Tileset</button>' +
      '<button data-type="import">+ Import</button></div>' +
      '<div class="erow">' +
      '<button data-type="group">+ Group</button>' +
      '<button data-type="section">+ Section</button></div>';
    bar.querySelectorAll('button').forEach(function (b) { b.addEventListener('click', function () { var t = b.getAttribute('data-type'); if (t === 'tileset') showTilesetForm(); else if (t === 'import') showImportForm(); else showForm(t); }); });
  }
  function parentOptions() {
    var opts = '<option value="">Top level</option>';
    containers(layers, 0, []).forEach(function (c) { opts += '<option value="' + c.node.id + '">' + (c.depth ? '— ' : '') + (c.node.label || c.node.id) + '</option>'; });
    return opts;
  }
  function showTilesetForm() {
    var bar = document.getElementById('editor-add-bar');
    bar.innerHTML =
      '<input id="editor-name" type="text" placeholder="tileset name…" />' +
      '<input id="editor-ts-url" type="text" placeholder="mapbox://username.tilesetid" />' +
      '<input id="editor-ts-sl" type="text" list="editor-ts-sl-list" placeholder="source layer (e.g. buildings)" /><datalist id="editor-ts-sl-list"></datalist>' +
      '<div id="editor-ts-sl-status" style="font-size:11px;color:#8a99a8;margin:-3px 0 6px;min-height:13px;"></div>' +
      '<select id="editor-ts-type"><option value="fill">Polygon (fill)</option><option value="line">Line</option><option value="circle">Point (circle)</option></select>' +
      '<select id="editor-parent">' + parentOptions() + '</select>' +
      '<div class="erow"><button id="editor-ok">Add tileset</button><button id="editor-cancel">Cancel</button></div>';
    document.getElementById('editor-name').focus();
    var urlInput = document.getElementById('editor-ts-url');
    urlInput.addEventListener('change', function () { detectSourceLayers(urlInput.value.trim()); });   // paste URL + tab/click away → list its layers
    document.getElementById('editor-ok').addEventListener('click', commitTileset);
    document.getElementById('editor-cancel').addEventListener('click', showButtons);
  }
  function mapboxTilesetId(url) { return (url && url.indexOf('mapbox://') === 0) ? url.slice(9) : null; }
  // Read a mapbox:// tileset's vector layers from its TileJSON and offer them as autocomplete,
  // so the mapmaker doesn't have to know the exact source-layer name. Manual entry still works.
  async function detectSourceLayers(url) {
    var status = document.getElementById('editor-ts-sl-status'), list = document.getElementById('editor-ts-sl-list');
    if (!status || !list) return;
    var id = mapboxTilesetId(url);
    if (!id) { status.textContent = url ? 'Auto-detect needs a mapbox:// URL — type the source layer' : ''; list.innerHTML = ''; return; }
    var token = (window.mapboxgl && mapboxgl.accessToken) || '';
    status.textContent = 'Reading tileset…'; list.innerHTML = '';
    try {
      var res = await fetch('https://api.mapbox.com/v4/' + encodeURIComponent(id) + '.json?access_token=' + token);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var tj = await res.json();
      var layers = (tj.vector_layers || []).map(function (v) { return v.id; }).filter(Boolean);
      if (!layers.length) { status.textContent = 'No vector layers found — type the source layer'; return; }
      list.innerHTML = layers.map(function (l) { return '<option value="' + String(l).replace(/"/g, '&quot;') + '"></option>'; }).join('');
      var sl = document.getElementById('editor-ts-sl'); if (sl && !sl.value) sl.value = layers[0];
      status.textContent = layers.length === 1 ? '✓ source layer: ' + layers[0] : '✓ ' + layers.length + ' layers — pick one ▾';
    } catch (e) { status.textContent = "Couldn't read tileset — type the source layer"; list.innerHTML = ''; }
  }
  function commitTileset() {
    var name = (document.getElementById('editor-name').value || '').trim();
    var url = (document.getElementById('editor-ts-url').value || '').trim();
    var sl = (document.getElementById('editor-ts-sl').value || '').trim();
    var type = document.getElementById('editor-ts-type').value || 'fill';
    if (!name || !url || !sl) { setStatus('Name, tileset URL + source layer required'); return; }
    var sel = document.getElementById('editor-parent');
    var parent = (sel && sel.value) ? findNodeById(layers, sel.value) : null;
    showButtons();
    addTileset(name, url, sl, type, parent);
  }

  // ── import: GeoJSON / KML / Shapefile(.zip) → editable geojson-supabase layer(s) ──
  var LIB = { togeojson: 'https://cdn.jsdelivr.net/npm/@tmcw/togeojson@5.8.1/dist/togeojson.umd.js', shp: 'https://unpkg.com/shpjs@4.0.4/dist/shp.js', turf: 'https://cdn.jsdelivr.net/npm/@turf/turf@6.5.0/turf.min.js' };
  var _scripts = {};
  function loadScript(url) {   // lazy-load a parser lib only when that format is imported
    if (_scripts[url]) return _scripts[url];
    _scripts[url] = new Promise(function (resolve, reject) {
      var s = document.createElement('script'); s.src = url; s.async = true;
      s.onload = function () { resolve(); }; s.onerror = function () { reject(new Error('could not load ' + url)); };
      document.head.appendChild(s);
    });
    return _scripts[url];
  }
  function showImportForm() {
    var bar = document.getElementById('editor-add-bar');
    bar.innerHTML =
      '<div style="font-size:11px;color:#5a6c7e;margin-bottom:5px;">Import a file → a new editable layer.<br>GeoJSON · KML · Shapefile (.zip)</div>' +
      '<input id="editor-import-file" type="file" accept=".geojson,.json,.kml,.zip" style="width:100%;box-sizing:border-box;margin-bottom:6px;font-size:12px;" />' +
      '<select id="editor-parent">' + parentOptions() + '</select>' +
      '<div id="editor-import-status" style="font-size:11px;color:#8a99a8;margin:2px 0 6px;min-height:13px;"></div>' +
      '<div class="erow"><button id="editor-cancel">Cancel</button></div>';
    var fileInput = document.getElementById('editor-import-file');
    fileInput.addEventListener('change', function () {
      if (!fileInput.files || !fileInput.files.length) return;
      var sel = document.getElementById('editor-parent');
      var parent = (sel && sel.value) ? findNodeById(layers, sel.value) : null;
      handleImportFile(fileInput.files[0], parent);
    });
    document.getElementById('editor-cancel').addEventListener('click', showButtons);
  }
  function importStatus(m) { var s = document.getElementById('editor-import-status'); if (s) s.textContent = m; else setStatus(m); }
  // Route a file by extension → a GeoJSON FeatureCollection → import it.
  async function handleImportFile(file, parent) {
    var ext = (file.name.split('.').pop() || '').toLowerCase();
    importStatus('Reading ' + file.name + '…');
    try {
      var fc = null, fmt = '';
      if (ext === 'geojson' || ext === 'json') { fc = JSON.parse(await file.text()); fmt = 'GeoJSON'; }
      else if (ext === 'kml') { await loadScript(LIB.togeojson); var dom = new DOMParser().parseFromString(await file.text(), 'text/xml'); if (dom.querySelector('parsererror')) throw new Error('not valid KML/XML'); fc = window.toGeoJSON.kml(dom); fmt = 'KML'; }
      else if (ext === 'zip') { await loadScript(LIB.shp); var r = await window.shp(await file.arrayBuffer()); fc = Array.isArray(r) ? { type: 'FeatureCollection', features: r.reduce(function (a, c) { return a.concat(c.features || []); }, []) } : r; fmt = 'Shapefile'; }
      else if (ext === 'kmz') throw new Error('KMZ not supported yet — unzip to KML first');
      else if (ext === 'tif' || ext === 'tiff') throw new Error('GeoTIFF (raster) import is coming soon');
      else throw new Error('Unsupported format .' + ext);
      if (!fc || !fc.features || !fc.features.length) throw new Error('no features found');
      await importFeatureCollection(fc, stripExt(file.name), parent);
    } catch (e) { console.warn('editing: import failed', e); importStatus('Import failed: ' + e.message); }
  }
  // Split a FeatureCollection by geometry type (one type per layer) → persist layers + features.
  async function importFeatureCollection(fc, baseName, parent) {
    if (typeof layers === 'undefined') return;
    if (idsReady) { try { await idsReady; } catch (e) {} }
    if (!loaded) { importStatus('Still loading — try again'); return; }
    // MapboxDraw can't render Multi* geometries — explode them into single pieces so they show + edit.
    var groups = { circle: [], line: [], fill: [] };
    (fc.features || []).forEach(function (f) {
      explodeMulti(f).forEach(function (sf) {
        var t = sf.geometry && sf.geometry.type;
        var bt = t === 'Point' ? 'circle' : t === 'LineString' ? 'line' : t === 'Polygon' ? 'fill' : null;
        if (bt) groups[bt].push(sf);
      });
    });
    var kinds = Object.keys(groups).filter(function (k) { return groups[k].length; });
    if (!kinds.length) throw new Error('no point/line/polygon geometries');
    // shapefiles are often in a projected CRS; if it didn't come through as lng/lat, say so clearly
    var bnds = computeImportBounds(fc);
    if (bnds && (Math.abs(bnds[0][0]) > 180 || Math.abs(bnds[1][0]) > 180 || Math.abs(bnds[0][1]) > 90 || Math.abs(bnds[1][1]) > 90)) throw new Error('coordinates look projected, not lng/lat — re-export as WGS84 / EPSG:4326');
    var total = kinds.reduce(function (n, k) { return n + groups[k].length; }, 0);
    if (total > 3000 && !window.confirm('Import ' + total + ' features? Large imports may be slow to edit.')) { importStatus('Cancelled'); return; }
    var TYPE_LABEL = { circle: 'points', line: 'lines', fill: 'polygons' };
    var sId = null, gId = null;
    if (parent && parent.type === 'group') { gId = parent._dbId; var ps = findParent(layers, parent); if (ps && ps.type === 'section') sId = ps._dbId; }
    else if (parent && parent.type === 'section') { sId = parent._dbId; }
    var made = [];
    try {
      for (var i = 0; i < kinds.length; i++) {
        var type = kinds[i];
        importStatus('Saving ' + groups[type].length + ' ' + TYPE_LABEL[type] + '…');
        var node = makeNode('layer', kinds.length > 1 ? baseName + ' (' + TYPE_LABEL[type] + ')' : baseName);
        node.type = type; node.iconType = TILESET_ICON[type] || 'square';
        var layerId = await insertOne('layers', leafRow(node));
        slugToLayerDbId[node.id] = layerId;
        await insertOne('project_layers', { project_id: projectId, layer_id: layerId, sort_order: nextSort++, section_id: sId, group_id: gId });
        await batchInsertFeatures(layerId, groups[type]);
        if (parent) { parent.children = parent.children || []; parent.children.push(node); parent.collapsed = false; parent.open = true; }
        else layers.push(node);
        made.push(node);
      }
      rerender();
      await loadFeatures();   // pull the imported features into MapboxDraw so they render + are editable
      var b = computeImportBounds(fc); if (b && typeof beforeMap !== 'undefined' && beforeMap) { try { beforeMap.fitBounds(b, { padding: 60, maxZoom: 16 }); } catch (e) {} }
      if (made.length) setActiveLayer(made[0].id);
      showButtons();
      setStatus('Imported ' + total + ' feature' + (total !== 1 ? 's' : ''));
    } catch (e) { console.warn('editing: import persist failed', e); importStatus('Import failed: ' + e.message); }
  }
  async function batchInsertFeatures(layerId, feats) {
    var BATCH = 500;
    for (var i = 0; i < feats.length; i += BATCH) {
      var rows = feats.slice(i, i + BATCH).map(function (f) { return { layer_id: layerId, geom: f.geometry, label: importLabel(f.properties), start_date: null, end_date: null }; });
      var r = await db.from('features').insert(rows);
      if (r.error) throw new Error('feature insert: ' + r.error.message);
    }
  }
  function importLabel(props) {
    if (!props) return null;
    var keys = ['name', 'Name', 'NAME', 'label', 'Label', 'title', 'Title'];
    for (var i = 0; i < keys.length; i++) { if (props[keys[i]] != null && props[keys[i]] !== '') return String(props[keys[i]]).slice(0, 250); }
    return null;
  }
  function stripExt(name) { return String(name).replace(/\.[^.]+$/, ''); }
  function computeImportBounds(fc) {
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    (fc.features || []).forEach(function (f) { collectImportCoords(f.geometry, function (lng, lat) { if (lng < x0) x0 = lng; if (lat < y0) y0 = lat; if (lng > x1) x1 = lng; if (lat > y1) y1 = lat; }); });
    return isFinite(x0) ? [[x0, y0], [x1, y1]] : null;
  }
  function collectImportCoords(g, fn) { if (!g) return; if (g.type === 'GeometryCollection') (g.geometries || []).forEach(function (s) { collectImportCoords(s, fn); }); else if (g.coordinates) walkImportCoords(g.coordinates, fn); }
  function walkImportCoords(c, fn) { if (!c || !c.length) return; if (typeof c[0] === 'number') fn(c[0], c[1]); else c.forEach(function (x) { walkImportCoords(x, fn); }); }
  // Split a Multi* (or GeometryCollection) feature into single-geometry features (MapboxDraw needs singles).
  function explodeMulti(f) {
    var g = f && f.geometry; if (!g) return [];
    function feat(geom) { return { type: 'Feature', properties: f.properties, geometry: geom }; }
    if (g.type === 'MultiPolygon') return (g.coordinates || []).map(function (c) { return feat({ type: 'Polygon', coordinates: c }); });
    if (g.type === 'MultiLineString') return (g.coordinates || []).map(function (c) { return feat({ type: 'LineString', coordinates: c }); });
    if (g.type === 'MultiPoint') return (g.coordinates || []).map(function (c) { return feat({ type: 'Point', coordinates: c }); });
    if (g.type === 'GeometryCollection') return (g.geometries || []).reduce(function (a, sub) { return a.concat(explodeMulti(feat(sub))); }, []);
    return [f];
  }

  function showForm(type) {
    var bar = document.getElementById('editor-add-bar');
    var picker = '';
    if (type !== 'section') {
      var opts = '<option value="">Top level</option>';
      containers(layers, 0, []).forEach(function (c) {
        if (type === 'group' && c.type !== 'section') return; // groups only nest in sections
        opts += '<option value="' + c.node.id + '">' + (c.depth ? '— ' : '') + (c.node.label || c.node.id) + '</option>';
      });
      picker = '<select id="editor-parent">' + opts + '</select>';
    }
    bar.innerHTML =
      '<input id="editor-name" type="text" placeholder="' + type + ' name…" />' + picker +
      '<div class="erow"><button id="editor-ok">Add ' + type + '</button>' +
      '<button id="editor-cancel">Cancel</button></div>';
    var input = document.getElementById('editor-name');
    input.focus();
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); commit(type); } if (e.key === 'Escape') showButtons(); });
    document.getElementById('editor-ok').addEventListener('click', function () { commit(type); });
    document.getElementById('editor-cancel').addEventListener('click', showButtons);
  }
  function setStatus(msg) {
    var el = document.getElementById('editor-save-status');
    if (!el) return;
    el.textContent = msg;
    if (msg === 'Saved') setTimeout(function () { if (el.textContent === 'Saved') el.textContent = ''; }, 1500);
  }
  function injectChrome() {
    var panel = document.getElementById('layers-panel-content');
    if (!panel || document.getElementById('editor-add-bar')) return;
    var style = document.createElement('style');
    style.textContent =
      '#editor-add-bar{padding:6px;}' +
      '#editor-add-bar .erow{display:flex;gap:6px;}' +
      '#editor-add-bar button{flex:1;padding:6px 0;border:none;border-radius:4px;cursor:pointer;font-size:12px;font-weight:600;background:#eef1f5;color:#23374d;}' +
      '#editor-add-bar button:hover{background:#dfe6ed;}' +
      '#editor-add-bar input,#editor-add-bar select{width:100%;box-sizing:border-box;margin-bottom:6px;padding:5px 6px;border:1px solid #cdd6df;border-radius:4px;font-size:12px;}' +
      '#editor-save-status{font-size:11px;color:#8a99a8;padding:2px 6px;min-height:13px;}' +
      '.layer-list-row{position:relative;}' +
      '.editor-del{position:absolute;right:44px;top:50%;transform:translateY(-50%);opacity:0;cursor:pointer;color:#8a99a8;font-size:15px;font-weight:bold;line-height:1;padding:0 3px;z-index:2;}' +
      '.layer-list-row:hover .editor-del{opacity:1;}' +
      '.editor-del:hover{color:#c0392b;}' +
      '.layer-list-row.editor-dragging{opacity:0.4;}' +
      '.layer-list-row.editor-drop-before{box-shadow:inset 0 2px 0 #4a9eff;}' +
      '.layer-list-row.editor-drop-after{box-shadow:inset 0 -2px 0 #4a9eff;}' +
      '.layer-list-row.editor-drop-into{background:rgba(74,158,255,0.18);box-shadow:inset 0 0 0 1px #4a9eff;}' +
      '.layer-list-row.editor-active{background:rgba(74,158,255,0.12);}' +
      // draw toolbar: float on the LEFT just past the 325px layers sidebar (was top-right, hidden under the right swipe map)
      '#before .mapboxgl-ctrl-top-left{left:400px;z-index:50;}' +
      '#editor-map-tools{position:fixed;top:92px;left:534px;z-index:50;display:flex;gap:3px;padding:3px;background:rgba(255,255,255,0.96);border-radius:4px;box-shadow:0 1px 3px rgba(0,0,0,0.3);pointer-events:auto;width:max-content;}' +
      '#editor-map-tools button{width:29px;height:29px;border:1px solid #cdd6df;border-radius:4px;background:#fff;color:#23374d;cursor:pointer;font-size:14px;line-height:1;padding:0;}' +
      '#editor-map-tools button:disabled{opacity:0.4;cursor:default;}' +
      '#editor-map-tools button:not(:disabled):hover{background:#eef1f5;}' +
      '#editor-map-tools button.active{background:#4a9eff;color:#fff;border-color:#4a9eff;}' +
      '#editor-measure-readout{position:fixed;top:90px;left:calc(50% + 160px);transform:translateX(-50%);z-index:60;display:none;background:rgba(35,55,77,0.96);color:#fff;font-size:14px;font-weight:600;padding:7px 14px;border-radius:6px;box-shadow:0 2px 8px rgba(0,0,0,0.3);cursor:pointer;font-family:Source Sans Pro,Arial,sans-serif;white-space:nowrap;}';
    document.head.appendChild(style);
    var status = document.createElement('div'); status.id = 'editor-save-status';
    var bar = document.createElement('div'); bar.id = 'editor-add-bar';
    panel.parentNode.insertBefore(status, panel.nextSibling);
    panel.parentNode.insertBefore(bar, status.nextSibling);
    // editing tools float on the MAP, next to the draw toolbar (icon buttons; hover for labels)
    var maptools = document.createElement('div'); maptools.id = 'editor-map-tools';
    maptools.innerHTML =
      '<button id="editor-undo" title="Undo (Ctrl+Z)" disabled>↶</button>' +
      '<button id="editor-redo" title="Redo (Ctrl+Shift+Z)" disabled>↷</button>' +
      '<button id="editor-copy" title="Copy feature (Ctrl+C)">⧉</button>' +
      '<button id="editor-paste" title="Paste (Ctrl+V)" disabled>⎘</button>' +
      '<button id="editor-measure-dist" title="Measure distance">📏</button>' +
      '<button id="editor-measure-area" title="Measure area">⬟</button>' +
      '<button id="editor-merge" title="Merge selected polygons (union) or lines (join)">∪</button>' +
      '<button id="editor-split" title="Split a polygon or line — select one, then draw a line across it">✂</button>';
    document.body.appendChild(maptools);
    var measureReadout = document.createElement('div'); measureReadout.id = 'editor-measure-readout'; measureReadout.title = 'Click to dismiss';
    measureReadout.addEventListener('click', function () { this.style.display = 'none'; clearMeasureShape(); });
    document.body.appendChild(measureReadout);
    document.getElementById('editor-undo').addEventListener('click', doUndo);
    document.getElementById('editor-redo').addEventListener('click', doRedo);
    document.getElementById('editor-copy').addEventListener('click', doCopy);
    document.getElementById('editor-paste').addEventListener('click', doPaste);
    document.getElementById('editor-measure-dist').addEventListener('click', function () { doMeasure('distance'); });
    document.getElementById('editor-measure-area').addEventListener('click', function () { doMeasure('area'); });
    document.getElementById('editor-merge').addEventListener('click', doMerge);
    document.getElementById('editor-split').addEventListener('click', enterSplitMode);
    try { window.infoPanelDefaultHandle = function () {}; } catch (e) {}   // suspend "click map → toggle sidebar" (use the sidebar button instead)
    document.addEventListener('keydown', function (e) {   // Esc cancels measure/split; Ctrl+Z/Y, Ctrl+C/V
      if (e.key === 'Escape' && _measuring) { e.preventDefault(); cancelMeasure(); return; }
      if (e.key === 'Escape' && _splitMode) { e.preventDefault(); cancelSplit(); return; }
      if (!(e.ctrlKey || e.metaKey)) return;
      var tag = (document.activeElement || {}).tagName || ''; if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      var isZ = e.key === 'z' || e.key === 'Z', isY = e.key === 'y' || e.key === 'Y', isC = e.key === 'c' || e.key === 'C', isV = e.key === 'v' || e.key === 'V';
      if (isZ && !e.shiftKey) { e.preventDefault(); doUndo(); }
      else if (isY || (isZ && e.shiftKey)) { e.preventDefault(); doRedo(); }
      else if (isC && draw && draw.getSelected && draw.getSelected().features.length) { e.preventDefault(); doCopy(); }   // only hijack Ctrl+C with a feature selected
      else if (isV && _clipboard) { e.preventDefault(); doPaste(); }
    }, true);
    showButtons();
  }

  // ── Slice 4: drawing (mapbox-gl-draw → the `features` table) ─────────────────
  var draw = null;
  var activeLayerId = null;
  var MAX_DRAW = 1500;        // a geojson layer with more features than this renders via the ENGINE (like a tileset), not MapboxDraw
  var _drawLayerSlugs = {};   // slugs currently loaded into MapboxDraw (the small/editable layers) — drives hideDrawnEngineLayers
  var featureToDb = {};   // mapbox-draw feature id → features.feature_id
  var featureMeta = {};   // mapbox-draw feature id → { label, notes }
  var featureLayer = {};  // mapbox-draw feature id → layer db id (for show/hide)
  var featureCache = {};  // mapbox-draw feature id → cached GeoJSON while hidden
  var _suppressFeatureDelete = false;  // set during a hide-toggle so onDrawDelete skips the DB
  var selectedDrawId = null;
  var _featTimer = null;
  var GEOM_TO_TYPE = { Point: 'circle', LineString: 'line', Polygon: 'fill' };
  var TYPE_TO_GEOM = { circle: 'point', line: 'line', fill: 'polygon' };
  var GEOM_TO_ICON = { Point: 'circle', LineString: 'slash', Polygon: 'draw-polygon' };

  // Each drawn feature carries its layer's color in properties.color (exposed by
  // MapboxDraw as user_color); inactive features paint by it, active (editing)
  // features highlight orange. Mirrors mapbox-gl-draw's default style shape.
  var COLOR = ['coalesce', ['get', 'user_color'], '#3bb2d0'];
  var FILL_OPACITY = ['coalesce', ['get', 'user_opacity'], 0.35];   // per-feature, so layer-style edits preview live
  var STROKE_OPACITY = ['coalesce', ['get', 'user_opacity'], 1];
  var OUTLINE_FILL = ['coalesce', ['get', 'user_outline'], COLOR];   // polygon outline → defaults to fill color
  var OUTLINE_PT = ['coalesce', ['get', 'user_outline'], '#000'];    // point stroke → defaults to black
  var OUTLINE_OPACITY = ['coalesce', ['get', 'user_strokeopacity'], 1];   // polygon outline opacity, INDEPENDENT of fill — so fill→0 leaves the lines
  var STROKE_WIDTH = ['coalesce', ['get', 'user_strokewidth'], 2];        // polygon outline / line width, per-feature so width edits preview live
  var POINT_STROKE_WIDTH = ['coalesce', ['get', 'user_strokewidth'], 1.5]; // circle outline width — NOT 1px-capped like fill-outline, no separate layer needed
  var RADIUS = ['coalesce', ['get', 'user_radius'], 5];                    // circle size; the circle-stroke is drawn at this edge, so it auto-follows
  var DRAW_STYLES = [
    { id: 'gl-draw-polygon-fill-inactive', type: 'fill', filter: ['all', ['==', 'active', 'false'], ['==', '$type', 'Polygon'], ['!=', 'mode', 'static']], paint: { 'fill-color': COLOR, 'fill-outline-color': OUTLINE_FILL, 'fill-opacity': FILL_OPACITY } },
    { id: 'gl-draw-polygon-fill-active', type: 'fill', filter: ['all', ['==', 'active', 'true'], ['==', '$type', 'Polygon']], paint: { 'fill-color': '#fbb03b', 'fill-outline-color': '#fbb03b', 'fill-opacity': 0.25 } },
    { id: 'gl-draw-polygon-stroke-inactive', type: 'line', filter: ['all', ['==', 'active', 'false'], ['==', '$type', 'Polygon'], ['!=', 'mode', 'static']], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': OUTLINE_FILL, 'line-width': STROKE_WIDTH, 'line-opacity': OUTLINE_OPACITY } },
    { id: 'gl-draw-polygon-stroke-active', type: 'line', filter: ['all', ['==', 'active', 'true'], ['==', '$type', 'Polygon']], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#fbb03b', 'line-dasharray': [0.2, 2], 'line-width': 2 } },
    { id: 'gl-draw-line-inactive', type: 'line', filter: ['all', ['==', 'active', 'false'], ['==', '$type', 'LineString'], ['!=', 'mode', 'static']], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': COLOR, 'line-width': STROKE_WIDTH, 'line-opacity': STROKE_OPACITY } },
    { id: 'gl-draw-line-active', type: 'line', filter: ['all', ['==', '$type', 'LineString'], ['==', 'active', 'true']], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#fbb03b', 'line-dasharray': [0.2, 2], 'line-width': 2 } },
    { id: 'gl-draw-polygon-and-line-vertex-halo-active', type: 'circle', filter: ['all', ['==', 'meta', 'vertex'], ['==', '$type', 'Point'], ['!=', 'mode', 'static']], paint: { 'circle-radius': 5, 'circle-color': '#fff' } },
    { id: 'gl-draw-polygon-and-line-vertex-active', type: 'circle', filter: ['all', ['==', 'meta', 'vertex'], ['==', '$type', 'Point'], ['!=', 'mode', 'static']], paint: { 'circle-radius': 3, 'circle-color': '#fbb03b' } },
    { id: 'gl-draw-polygon-midpoint', type: 'circle', filter: ['all', ['==', '$type', 'Point'], ['==', 'meta', 'midpoint']], paint: { 'circle-radius': 3, 'circle-color': '#fbb03b' } },
    { id: 'gl-draw-point-inactive', type: 'circle', filter: ['all', ['==', 'active', 'false'], ['==', '$type', 'Point'], ['==', 'meta', 'feature'], ['!=', 'mode', 'static']], paint: { 'circle-radius': RADIUS, 'circle-color': COLOR, 'circle-stroke-width': POINT_STROKE_WIDTH, 'circle-stroke-color': OUTLINE_PT, 'circle-opacity': STROKE_OPACITY } },
    { id: 'gl-draw-point-active', type: 'circle', filter: ['all', ['==', '$type', 'Point'], ['==', 'active', 'true'], ['==', 'meta', 'feature']], paint: { 'circle-radius': 6, 'circle-color': '#fbb03b' } },
  ];

  function setActiveLayer(id) {
    activeLayerId = id;
    var panel = document.getElementById('layers-panel-content'); if (!panel) return;
    panel.querySelectorAll('.layer-list-row.editor-active').forEach(function (el) { el.classList.remove('editor-active'); });
    panel.querySelectorAll('.layer-list-row[data-node-id="' + id + '"]').forEach(function (row) { row.classList.add('editor-active'); });
    var node = findNodeById(layers, id);
    // drawn layers always get the style panel; tilesets get it too once they have a styleable type
    var styleable = node && (node.source_type === 'geojson-supabase' || (isTilesetNode(node) && ['fill', 'line', 'circle'].indexOf(node.type) > -1));
    if (styleable) showLayerPanel(id); else hideLayerPanel();
  }
  function activeLayerDbId() {
    if (!activeLayerId) return null;
    var node = findNodeById(layers, activeLayerId);
    if (!node || node.source_type !== 'geojson-supabase') return null;     // only drawable layers
    return slugToLayerDbId[activeLayerId] || null;
  }
  function setupDraw() {
    if (draw || typeof MapboxDraw === 'undefined' || typeof beforeMap === 'undefined' || !beforeMap) return;
    // The engine's refreshLayers (re)shows drawn layers' engine copy on every checkbox
    // change; in the editor MapboxDraw owns them, so re-hide after each refresh.
    if (typeof window.refreshLayers === 'function' && !window._editorWrappedRefresh) {
      var _origRefresh = window.refreshLayers;
      window.refreshLayers = function () { var r = _origRefresh.apply(this, arguments); try { hideDrawnEngineLayers(); } catch (e) {} return r; };
      window._editorWrappedRefresh = true;
    }
    draw = new MapboxDraw({ displayControlsDefault: false, userProperties: true, controls: { point: true, line_string: true, polygon: true, trash: true }, styles: DRAW_STYLES });
    beforeMap.addControl(draw, 'top-left');   // left side, clear of the right swipe map (offset past the sidebar in CSS)
    beforeMap.on('draw.render', measureRender);   // live distance while measuring
    beforeMap.on('draw.create', onDrawCreate);
    beforeMap.on('draw.update', onDrawUpdate);
    beforeMap.on('draw.delete', onDrawDelete);
    beforeMap.on('draw.selectionchange', onSelectionChange);
    injectFeaturePanel();
    loadFeatures();
  }
  // ── undo / redo (in-session stack; mirrors v3 undoEngine) ────────────────────
  var _undoStack = [], _redoStack = [], _undoing = false, _geomSnap = {};
  function pushUndo(undo, redo, label) {
    if (_undoing) return;                 // changes made BY undo/redo aren't themselves recorded
    _undoStack.push({ undo: undo, redo: redo, label: label || '' });
    if (_undoStack.length > 100) _undoStack.shift();
    _redoStack = [];
    updateUndoButtons();
  }
  async function doUndo() {
    if (_undoing || !_undoStack.length) return;
    var op = _undoStack.pop(); _undoing = true; setStatus('Undoing…');
    try { await op.undo(); _redoStack.push(op); setStatus('Undone' + (op.label ? ' — ' + op.label : '')); }
    catch (e) { console.warn('editing: undo failed', e); _undoStack.push(op); setStatus('Undo failed'); }
    _undoing = false; updateUndoButtons();
  }
  async function doRedo() {
    if (_undoing || !_redoStack.length) return;
    var op = _redoStack.pop(); _undoing = true; setStatus('Redoing…');
    try { await op.redo(); _undoStack.push(op); setStatus('Redone' + (op.label ? ' — ' + op.label : '')); }
    catch (e) { console.warn('editing: redo failed', e); _redoStack.push(op); setStatus('Redo failed'); }
    _undoing = false; updateUndoButtons();
  }
  function updateUndoButtons() {
    var u = document.getElementById('editor-undo'), r = document.getElementById('editor-redo');
    if (u) u.disabled = !_undoStack.length;
    if (r) r.disabled = !_redoStack.length;
  }
  // shared by the draw-undo closures (DB + MapboxDraw together; draw.delete is suppressed so the
  // draw.delete handler doesn't double-act). draw.add does not fire draw.create, so no re-entrancy.
  async function removeDrawnFeature(drawId) {
    var fid = featureToDb[drawId];
    _suppressFeatureDelete = true;
    try { if (draw && draw.get(drawId)) draw.delete(drawId); } catch (e) {}
    setTimeout(function () { _suppressFeatureDelete = false; }, 0);
    if (fid) { try { await db.from('features').delete().eq('feature_id', fid); } catch (e) {} }
    delete featureToDb[drawId]; delete featureMeta[drawId]; delete featureLayer[drawId]; delete _geomSnap[drawId];
  }
  async function addDrawnFeature(drawId, geom, lyr, props) {
    var ins = await db.from('features').insert({ layer_id: lyr, geom: geom }).select('feature_id').single();
    if (!ins.error) { featureToDb[drawId] = ins.data.feature_id; featureMeta[drawId] = { label: '', notes: '', start: '', end: '' }; featureLayer[drawId] = lyr; }
    try { if (draw && !draw.get(drawId)) draw.add({ type: 'Feature', id: drawId, geometry: geom, properties: props || {} }); } catch (e) {}
    _geomSnap[drawId] = JSON.parse(JSON.stringify(geom));
  }
  async function setDrawnGeom(drawId, geom) {
    var fid = featureToDb[drawId];
    if (fid) { try { await db.from('features').update({ geom: geom }).eq('feature_id', fid); } catch (e) {} }
    try { var f = draw && draw.get(drawId); var props = f ? f.properties : {}; _suppressFeatureDelete = true; if (f) draw.delete(drawId); if (draw) draw.add({ type: 'Feature', id: drawId, geometry: geom, properties: props }); setTimeout(function () { _suppressFeatureDelete = false; }, 0); } catch (e) {}
    _geomSnap[drawId] = JSON.parse(JSON.stringify(geom));
  }

  // ── tools: copy / paste / measure ───────────────────────────────────────────
  var _clipboard = null, _clipboardLayer = null, _measuring = false, _measureType = 'distance', _splitMode = false, _splitTarget = null;
  function updateToolButtons() {
    var p = document.getElementById('editor-paste'); if (p) p.disabled = !_clipboard;
    var md = document.getElementById('editor-measure-dist'); if (md) md.classList.toggle('active', _measuring && _measureType === 'distance');
    var ma = document.getElementById('editor-measure-area'); if (ma) ma.classList.toggle('active', _measuring && _measureType === 'area');
    var sp = document.getElementById('editor-split'); if (sp) sp.classList.toggle('active', !!_splitMode);
  }
  function nodeByLayerDbId(lid) {
    var slug = Object.keys(slugToLayerDbId).filter(function (s) { return slugToLayerDbId[s] === lid; })[0];
    return slug ? findNodeById(layers, slug) : null;
  }
  // the full per-feature style (user_* props) for a layer, so a NEW feature matches the layer immediately
  function featureProps(node) {
    var p = { color: (node && node.iconColor) || '#3bb2d0' };
    var paint = node && node.paint; if (!paint) return p;
    var op = paintOpacity(paint); if (op != null) p.opacity = op;
    var ol = paintOutline(paint); if (ol != null) p.outline = ol;
    if (paint['line-opacity'] != null) p.strokeopacity = paint['line-opacity'];
    var w = paintWidth(paint); if (w != null) p.strokewidth = w;
    if (paint['circle-radius'] != null) p.radius = paint['circle-radius'];
    return p;
  }
  function fmtDist(km) {
    var m = km * 1000, mi = km * 0.621371;
    var metric = km >= 1 ? km.toFixed(2) + ' km' : Math.round(m) + ' m';
    var imperial = mi >= 0.19 ? mi.toFixed(2) + ' mi' : Math.round(m * 3.28084).toLocaleString() + ' ft';
    return metric + '  ·  ' + imperial;
  }
  function fmtArea(sqm) {
    var ha = sqm / 10000, km2 = sqm / 1e6, acre = sqm / 4046.856;
    var primary = ha >= 100 ? km2.toFixed(2) + ' km²' : (ha >= 1 ? ha.toFixed(2) + ' ha' : Math.round(sqm).toLocaleString() + ' m²');
    var secondary = acre >= 0.1 ? acre.toFixed(2) + ' acres' : Math.round(sqm * 10.7639).toLocaleString() + ' ft²';
    return primary + ' &nbsp;·&nbsp; ' + secondary;
  }
  function setMeasureReadout(html) { var el = document.getElementById('editor-measure-readout'); if (el) { el.innerHTML = html; el.style.display = 'block'; } }
  function measureText(f) {   // distance for a line; area + perimeter for a polygon
    if (!window.turf || !f || !f.geometry) return '';
    if (f.geometry.type === 'Polygon') {
      var ring = (f.geometry.coordinates || [])[0] || [];
      if (ring.length < 4) return '⬟ Keep clicking to define the area';
      return '⬟ ' + fmtArea(turf.area(f)) + ' &nbsp;·&nbsp; perimeter ' + fmtDist(turf.length(turf.lineString(ring), { units: 'kilometers' }));
    }
    return '📏 ' + fmtDist(turf.length(f, { units: 'kilometers' }));
  }
  function measureRender() {   // live readout as the measuring feature grows
    if (!_measuring || !draw || !window.turf) return;
    try { var t = _measureType === 'area' ? 'Polygon' : 'LineString'; var fs = draw.getAll().features.filter(function (f) { return f.geometry && f.geometry.type === t; }); var f = fs[fs.length - 1]; if (f) { var txt = measureText(f); if (txt) setMeasureReadout(txt); } } catch (e) {}
  }
  // the finished measurement renders on its OWN layer (not MapboxDraw), so it stays visible + isn't an editable feature
  function ensureMeasureLayers() {
    if (typeof beforeMap === 'undefined' || !beforeMap || beforeMap.getSource('editor-measure-src')) return;
    try {
      beforeMap.addSource('editor-measure-src', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      beforeMap.addLayer({ id: 'editor-measure-fill', type: 'fill', source: 'editor-measure-src', filter: ['==', '$type', 'Polygon'], paint: { 'fill-color': '#4a9eff', 'fill-opacity': 0.18 } });
      beforeMap.addLayer({ id: 'editor-measure-line', type: 'line', source: 'editor-measure-src', paint: { 'line-color': '#2d7dd2', 'line-width': 2.5, 'line-dasharray': [2, 1.5] } });
    } catch (e) {}
  }
  function showMeasureShape(geom) { ensureMeasureLayers(); try { var s = beforeMap.getSource('editor-measure-src'); if (s) s.setData({ type: 'Feature', geometry: geom, properties: {} }); } catch (e) {} }
  function clearMeasureShape() { try { var s = beforeMap && beforeMap.getSource('editor-measure-src'); if (s) s.setData({ type: 'FeatureCollection', features: [] }); } catch (e) {} }
  function doCopy() {
    var sel = (draw && draw.getSelected) ? draw.getSelected().features : [];
    if (!sel.length) { setStatus('Select a feature to copy'); return; }
    _clipboard = JSON.parse(JSON.stringify(sel[0].geometry));
    _clipboardLayer = featureLayer[sel[0].id] || null;   // so paste can fall back to its own layer
    updateToolButtons(); setStatus('Copied');
  }
  async function doPaste() {
    if (!_clipboard) { setStatus('Nothing to paste'); return; }
    var lid = null, node = null;
    if (_clipboardLayer) { lid = _clipboardLayer; node = nodeByLayerDbId(lid); }   // paste into the COPIED feature's OWN layer (coincident duplicate)
    if (!node) { lid = activeLayerDbId(); node = activeLayerId ? findNodeById(layers, activeLayerId) : null; }
    if (!lid || !node) { setStatus('Select a drawn layer to paste into'); return; }
    var gtype = GEOM_TO_TYPE[_clipboard.type];
    if (node.type && node.type !== gtype) { setStatus('Paste needs a ' + (TYPE_TO_GEOM[node.type] || node.type) + ' layer'); return; }
    var geom = JSON.parse(JSON.stringify(_clipboard));   // coincident with the original (like v3/AHM)
    var drawId = 'pst-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    var props = featureProps(node);   // full styling (radius, opacity, outline, width…) so the copy matches the layer immediately
    await addDrawnFeature(drawId, geom, lid, props);
    if (!node.type) { node.type = gtype; node.iconType = GEOM_TO_ICON[_clipboard.type] || node.iconType; try { await db.from('layers').update({ type: gtype }).eq('id', lid); } catch (e) {} rerender(); }
    pushUndo(function () { return removeDrawnFeature(drawId); }, function () { return addDrawnFeature(drawId, geom, lid, props); }, 'paste');
    setStatus('Pasted');
  }
  async function doMeasure(type) {
    if (!draw) return;
    try { await loadScript(LIB.turf); } catch (e) { setStatus('Measure unavailable (offline?)'); return; }
    clearMeasureShape();   // clear the previous measurement
    _measuring = true; _measureType = type; updateToolButtons();
    setMeasureReadout(type === 'area' ? '⬟ Click around an area, double-click to finish' : '📏 Click points, double-click to finish');
    try { draw.changeMode(type === 'area' ? 'draw_polygon' : 'draw_line_string'); } catch (e) {}
  }
  function cancelMeasure() {
    _measuring = false; updateToolButtons();
    try { if (draw) draw.changeMode('simple_select'); } catch (e) {}
    clearMeasureShape();
    var ro = document.getElementById('editor-measure-readout'); if (ro) ro.style.display = 'none';
  }

  // ── merge (union selected polygons) + split (cut a polygon with a line) — adapts v3 ──
  async function doMerge() {
    if (!draw) return;
    try { await loadScript(LIB.turf); } catch (e) { setStatus('Merge unavailable (offline?)'); return; }
    var sel = (draw.getSelected ? draw.getSelected().features : []).filter(Boolean);
    if (sel.length < 2) { setStatus('Select 2+ features to merge (shift-click)'); return; }
    var allPoly = sel.every(function (f) { return f.geometry && (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon'); });
    var allLine = sel.every(function (f) { return f.geometry && (f.geometry.type === 'LineString' || f.geometry.type === 'MultiLineString'); });
    var merged;
    if (allPoly) {
      try { merged = turf.feature(sel[0].geometry); for (var i = 1; i < sel.length; i++) { merged = turf.union(merged, turf.feature(sel[i].geometry)); if (!merged) throw 0; } } catch (e) { setStatus('Merge failed — invalid geometry'); return; }
      if (merged.geometry.type === 'MultiPolygon') { setStatus('Merge failed — the polygons must touch or overlap'); return; }
      merged = merged.geometry;
    } else if (allLine) {
      merged = { type: 'LineString', coordinates: joinLines(sel.map(function (f) { return f.geometry.coordinates; })) };
    } else { setStatus('Merge: select all polygons, or all lines'); return; }
    var lid = featureLayer[sel[0].id], node = lid ? nodeByLayerDbId(lid) : null;
    var origs = sel.map(function (f) { return { drawId: f.id, geom: JSON.parse(JSON.stringify(f.geometry)), lyr: featureLayer[f.id], props: JSON.parse(JSON.stringify(f.properties || {})) }; });
    var mergedGeom = JSON.parse(JSON.stringify(merged)), mergedId = 'mrg-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 4), mprops = node ? featureProps(node) : (origs[0].props || {});
    setStatus('Merging…');
    try {
      for (var j = 0; j < origs.length; j++) await removeDrawnFeature(origs[j].drawId);
      await addDrawnFeature(mergedId, mergedGeom, lid, mprops);
      try { draw.changeMode('simple_select', { featureIds: [mergedId] }); } catch (e) {}
      pushUndo(
        async function () { await removeDrawnFeature(mergedId); for (var k = 0; k < origs.length; k++) await addDrawnFeature(origs[k].drawId, origs[k].geom, origs[k].lyr, origs[k].props); },
        async function () { for (var k = 0; k < origs.length; k++) await removeDrawnFeature(origs[k].drawId); await addDrawnFeature(mergedId, mergedGeom, lid, mprops); },
        'merge');
      setStatus('Merged ' + sel.length + (allLine ? ' lines' : ' polygons'));
    } catch (e) { console.warn('editing: merge failed', e); setStatus('Merge failed: ' + e.message); }
  }
  async function enterSplitMode() {
    if (!draw) return;
    if (_splitMode) { cancelSplit(); return; }
    var sel = (draw.getSelected ? draw.getSelected().features : []);
    if (sel.length !== 1 || !sel[0].geometry || (sel[0].geometry.type !== 'Polygon' && sel[0].geometry.type !== 'LineString')) { setStatus('Select ONE polygon or line, then Split'); return; }
    try { await loadScript(LIB.turf); } catch (e) { setStatus('Split unavailable (offline?)'); return; }
    _splitTarget = sel[0].id; _splitMode = true; updateToolButtons();
    setStatus('Split: draw a line across the ' + (sel[0].geometry.type === 'Polygon' ? 'polygon' : 'line') + ', double-click to finish');
    try { draw.changeMode('draw_line_string'); } catch (e) {}
  }
  function cancelSplit() { _splitMode = false; _splitTarget = null; updateToolButtons(); try { if (draw) draw.changeMode('simple_select'); } catch (e) {} }
  function splitPolygonWithLine(polygon, lineFeature) {   // v3 half-plane intersect
    var coords = lineFeature.geometry.coordinates, p1 = coords[0], p2 = coords[coords.length - 1];
    var dx = p2[0] - p1[0], dy = p2[1] - p1[1], len = Math.sqrt(dx * dx + dy * dy); if (len === 0) return [];
    var nx = dx / len, ny = dy / len, px = -ny, py = nx;
    var bbox = turf.bbox(turf.feature(polygon.geometry));
    var far = Math.sqrt(Math.pow(bbox[2] - bbox[0], 2) + Math.pow(bbox[3] - bbox[1], 2)) * 2 + 1;
    var eA = [p1[0] - nx * far, p1[1] - ny * far], eB = [p2[0] + nx * far, p2[1] + ny * far];
    var leftHalf = turf.polygon([[eA, eB, [eB[0] + px * far, eB[1] + py * far], [eA[0] + px * far, eA[1] + py * far], eA]]);
    var rightHalf = turf.polygon([[eA, eB, [eB[0] - px * far, eB[1] - py * far], [eA[0] - px * far, eA[1] - py * far], eA]]);
    var poly = turf.feature(polygon.geometry);
    return [turf.intersect(poly, leftHalf), turf.intersect(poly, rightHalf)].filter(Boolean);
  }
  function _samePt(a, b) { return a && b && Math.abs(a[0] - b[0]) < 1e-7 && Math.abs(a[1] - b[1]) < 1e-7; }
  function joinLines(lineCoords) {   // chain lines at shared endpoints (reversing as needed); append any disconnected
    if (!lineCoords.length) return [];
    var chain = lineCoords[0].slice(), rest = lineCoords.slice(1), changed = true;
    while (rest.length && changed) {
      changed = false;
      for (var i = 0; i < rest.length; i++) {
        var ln = rest[i], s = ln[0], e = ln[ln.length - 1], cs = chain[0], ce = chain[chain.length - 1];
        if (_samePt(ce, s)) { chain = chain.concat(ln.slice(1)); rest.splice(i, 1); changed = true; break; }
        if (_samePt(ce, e)) { chain = chain.concat(ln.slice(0, -1).reverse()); rest.splice(i, 1); changed = true; break; }
        if (_samePt(cs, e)) { chain = ln.slice(0, -1).concat(chain); rest.splice(i, 1); changed = true; break; }
        if (_samePt(cs, s)) { chain = ln.slice(1).reverse().concat(chain); rest.splice(i, 1); changed = true; break; }
      }
    }
    rest.forEach(function (ln) { chain = chain.concat(ln); });   // disconnected pieces appended in order
    return chain;
  }
  async function doSplit(lineFeature) {
    var target = _splitTarget && draw.get(_splitTarget);
    _suppressFeatureDelete = true; try { draw.delete(lineFeature.id); } catch (e) {} setTimeout(function () { _suppressFeatureDelete = false; }, 0);  // the cut line isn't a feature
    if (!target) { cancelSplit(); return; }
    var isPoly = target.geometry.type === 'Polygon', pieces = [];
    try {
      if (isPoly) pieces = splitPolygonWithLine(target, lineFeature).filter(function (h) { return h && h.geometry; }).map(function (h) { return h.geometry; });
      else if (target.geometry.type === 'LineString') pieces = turf.lineSplit(turf.feature(target.geometry), lineFeature).features.filter(function (s) { return s && s.geometry; }).map(function (s) { return s.geometry; });
    } catch (e) { pieces = []; }
    if (pieces.length < 2) { setStatus('Split failed — the line must cross the ' + (isPoly ? 'polygon completely' : 'line')); cancelSplit(); return; }
    var origDrawId = _splitTarget, origGeom = JSON.parse(JSON.stringify(target.geometry)), lyr = featureLayer[origDrawId], props = JSON.parse(JSON.stringify(target.properties || {}));
    _splitMode = false; _splitTarget = null; updateToolButtons();
    var node = lyr ? nodeByLayerDbId(lyr) : null, fp = node ? featureProps(node) : props;
    var base = Date.now().toString(36), newIds = pieces.map(function (_, i) { return 'spl-' + base + String.fromCharCode(97 + i); });
    var pieceGeoms = pieces.map(function (g) { return JSON.parse(JSON.stringify(g)); });
    setStatus('Splitting…');
    try {
      await removeDrawnFeature(origDrawId);
      for (var pi = 0; pi < pieceGeoms.length; pi++) await addDrawnFeature(newIds[pi], pieceGeoms[pi], lyr, fp);
      pushUndo(
        async function () { for (var k = 0; k < newIds.length; k++) await removeDrawnFeature(newIds[k]); await addDrawnFeature(origDrawId, origGeom, lyr, props); },
        async function () { await removeDrawnFeature(origDrawId); for (var k = 0; k < newIds.length; k++) await addDrawnFeature(newIds[k], pieceGeoms[k], lyr, fp); },
        'split');
      setStatus('Split into ' + newIds.length);
    } catch (e) { console.warn('editing: split failed', e); setStatus('Split failed: ' + e.message); }
  }

  async function onDrawCreate(e) {
    var f = e.features && e.features[0]; if (!f) return;
    if (_splitMode) { doSplit(f); return; }   // the line just drawn is a split cut, not a feature
    if (_measuring) {   // a measuring line/polygon — report distance/area + keep the shape, don't persist it
      _measuring = false; updateToolButtons();
      try { setMeasureReadout(measureText(f)); } catch (err) {}
      try { showMeasureShape(f.geometry); } catch (e) {}   // keep the measured shape visible on the display layer
      try { draw.delete(f.id); } catch (e) {}              // remove the MapboxDraw copy (it lives on the display layer now)
      return;
    }
    var lid = activeLayerDbId();
    var node = activeLayerId ? findNodeById(layers, activeLayerId) : null;
    if (!lid || !node) { window.alert('Select a drawn layer first — click a layer you added (or make one with + Layer).'); if (draw) draw.delete(f.id); return; }

    // One geometry type per layer: the first feature fixes the type; a mismatch
    // is rejected (draw it into / create a layer of the right type instead).
    var mapType = GEOM_TO_TYPE[f.geometry.type];
    if (!node.type) {
      node.type = mapType;
      node.iconType = GEOM_TO_ICON[f.geometry.type] || node.iconType;
      try { await db.from('layers').update({ type: mapType }).eq('id', lid); } catch (err) { console.warn('editing: set layer type failed', err); }
      rerender();
    } else if (node.type !== mapType) {
      if (draw) draw.delete(f.id);
      window.alert('"' + (node.label || 'This layer') + '" holds ' + (TYPE_TO_GEOM[node.type] || node.type) + ' features only. Draw a ' + (TYPE_TO_GEOM[node.type] || node.type) + ', or add/select a separate layer for ' + f.geometry.type.toLowerCase() + 's.');
      return;
    }

    setStatus('Saving…');
    try {
      var ins = await db.from('features').insert({ layer_id: lid, geom: f.geometry }).select('feature_id').single();
      if (ins.error) throw new Error(ins.error.message);
      featureToDb[f.id] = ins.data.feature_id;
      featureMeta[f.id] = { label: '', notes: '', start: '', end: '' };
      featureLayer[f.id] = lid;
      _geomSnap[f.id] = JSON.parse(JSON.stringify(f.geometry));
      try { if (draw) { var fp = featureProps(node); Object.keys(fp).forEach(function (k) { draw.setFeatureProperty(f.id, k, fp[k]); }); } } catch (e) {}  // stamp the layer's full style so the new feature matches
      (function (drawId, geom, lyr, col) {
        pushUndo(function () { return removeDrawnFeature(drawId); },
          function () { return addDrawnFeature(drawId, geom, lyr, col ? { color: col } : {}); },
          'draw ' + (TYPE_TO_GEOM[node.type] || 'feature'));
      })(f.id, JSON.parse(JSON.stringify(f.geometry)), lid, node.iconColor);
      setStatus('Saved');
    } catch (err) { console.warn('editing: feature save failed', err); setStatus('Draw save failed: ' + err.message); }
  }
  async function onDrawUpdate(e) {
    for (var i = 0; i < (e.features || []).length; i++) {
      var f = e.features[i], fid = featureToDb[f.id]; if (!fid) continue;
      var oldGeom = _geomSnap[f.id], newGeom = JSON.parse(JSON.stringify(f.geometry));
      try { await db.from('features').update({ geom: f.geometry }).eq('feature_id', fid); } catch (err) { console.warn('feature update failed', err); }
      _geomSnap[f.id] = newGeom;
      if (oldGeom) (function (drawId, oldG, newG) {
        pushUndo(function () { return setDrawnGeom(drawId, oldG); }, function () { return setDrawnGeom(drawId, newG); }, 'move feature');
      })(f.id, oldGeom, newGeom);
    }
    setStatus('Saved');
  }
  async function onDrawDelete(e) {
    if (_suppressFeatureDelete) return;  // a hide-toggle removed it from the canvas, not the project
    for (var i = 0; i < (e.features || []).length; i++) {
      var f = e.features[i], fid = featureToDb[f.id]; if (!fid) continue;
      var drawId = f.id, geom = JSON.parse(JSON.stringify(f.geometry)), lyr = featureLayer[f.id], props = JSON.parse(JSON.stringify(f.properties || {}));
      try { await db.from('features').delete().eq('feature_id', fid); delete featureToDb[f.id]; delete featureMeta[f.id]; delete featureLayer[f.id]; delete _geomSnap[f.id]; } catch (err) { console.warn('feature delete failed', err); continue; }
      (function (drawId, geom, lyr, props) {
        pushUndo(function () { return addDrawnFeature(drawId, geom, lyr, props); }, function () { return removeDrawnFeature(drawId); }, 'delete feature');
      })(drawId, geom, lyr, props);
    }
    setStatus('Saved');
  }
  async function loadFeatures() {
    if (idsReady) { try { await idsReady; } catch (e) {} }
    if (!draw) return;

    // map each drawn layer's db id → its style, + collect the geojson layers
    var dbColor = {}, dbOpacity = {}, dbOutline = {}, dbStrokeOp = {}, dbStrokeWidth = {}, dbRadius = {}, gjList = [];
    (function walk(arr) { (arr || []).forEach(function (n) { if (n.source_type === 'geojson-supabase') { var did = slugToLayerDbId[n.id]; if (did) { dbColor[did] = n.iconColor || '#3bb2d0'; var op = paintOpacity(n.paint); if (op != null) dbOpacity[did] = op; var ol = paintOutline(n.paint); if (ol != null) dbOutline[did] = ol; if (n.paint && n.paint['line-opacity'] != null) dbStrokeOp[did] = n.paint['line-opacity']; var wd = paintWidth(n.paint); if (wd != null) dbStrokeWidth[did] = wd; if (n.paint && n.paint['circle-radius'] != null) dbRadius[did] = n.paint['circle-radius']; if (n.outlineSplit) dbStrokeOp[did] = 0; gjList.push({ slug: n.id, did: did }); } } if (n.children) walk(n.children); }); })(layers);

    // Classify by size: small layers edit in MapboxDraw; large ones (imported 10k+ datasets) render
    // via the engine like a tileset — MapboxDraw can't hold tens of thousands of features (it freezes).
    _drawLayerSlugs = {};
    var smallIds = [];
    for (var gi = 0; gi < gjList.length; gi++) {
      try { var cq = await db.from('features').select('feature_id', { count: 'exact', head: true }).eq('layer_id', gjList[gi].did); var cn = cq.count || 0; if (cn > 0 && cn <= MAX_DRAW) { smallIds.push(gjList[gi].did); _drawLayerSlugs[gjList[gi].slug] = true; } } catch (e) {}
    }
    hideDrawnEngineLayers();   // hides only small (MapboxDraw) layers' engine copies; large ones stay engine-rendered
    if (!smallIds.length) { try { draw.set({ type: 'FeatureCollection', features: [] }); } catch (e) {} return; }
    try {
      var rows = [];
      for (var from = 0; from < 200000; from += 1000) {
        var res = await db.from('features').select('feature_id, layer_id, geom, label, description, start_date, end_date').in('layer_id', smallIds).order('feature_id').range(from, from + 999);
        if (res.error) { console.warn('editing: load features failed', res.error); break; }
        var batch = res.data || [];
        rows = rows.concat(batch);
        if (batch.length < 1000) break;
      }
      var feats = [];
      rows.forEach(function (row) {
        if (!row.geom) return;
        var did = 'db-' + row.feature_id;
        featureToDb[did] = row.feature_id;
        featureMeta[did] = { label: row.label || '', notes: row.description || '', start: row.start_date ? String(row.start_date).slice(0, 10) : '', end: row.end_date ? String(row.end_date).slice(0, 10) : '' };
        featureLayer[did] = row.layer_id;
        var props = { color: dbColor[row.layer_id] || '#3bb2d0' };
        if (dbOpacity[row.layer_id] != null) props.opacity = dbOpacity[row.layer_id];
        if (dbOutline[row.layer_id] != null) props.outline = dbOutline[row.layer_id];
        if (dbStrokeOp[row.layer_id] != null) props.strokeopacity = dbStrokeOp[row.layer_id];
        if (dbStrokeWidth[row.layer_id] != null) props.strokewidth = dbStrokeWidth[row.layer_id];
        if (dbRadius[row.layer_id] != null) props.radius = dbRadius[row.layer_id];
        feats.push({ type: 'Feature', id: did, geometry: { type: row.geom.type, coordinates: row.geom.coordinates }, properties: props });
        _geomSnap[did] = { type: row.geom.type, coordinates: row.geom.coordinates };
      });
      draw.set({ type: 'FeatureCollection', features: feats });
    } catch (e) { console.warn('editing: load features failed', e); }
  }
  // The engine (P0) renders geojson-supabase layers as real GeoJSON layers; in the
  // EDITOR those same features live in MapboxDraw, so hide the engine's copy (both maps).
  function hideDrawnEngineLayers() {
    if (typeof layers === 'undefined') return;
    (function walk(arr) {
      (arr || []).forEach(function (n) {
        if (n.id && n.source_type === 'geojson-supabase' && !n.outlineOf && _drawLayerSlugs[n.id]) {  // only small layers live in MapboxDraw; large + outline layers render via the engine
          ['-left', '-right', '-stroke-left', '-stroke-right'].forEach(function (sfx) {
            var id = n.id + sfx;
            try { if (beforeMap && beforeMap.getLayer(id)) beforeMap.setLayoutProperty(id, 'visibility', 'none'); } catch (e) {}
            try { if (typeof afterMap !== 'undefined' && afterMap && afterMap.getLayer(id)) afterMap.setLayoutProperty(id, 'visibility', 'none'); } catch (e) {}
          });
        }
        if (n.children) walk(n.children);
      });
    })(layers);
  }

  // ── feature panel: click a drawn feature → edit its label/notes ─────────────
  function onSelectionChange(e) {
    if (e.features && e.features.length) showFeaturePanel(e.features[0].id);
    else hideFeaturePanel();
  }
  function injectFeaturePanel() {
    if (document.getElementById('editor-feature-panel')) return;
    var p = document.createElement('div');
    p.id = 'editor-feature-panel';
    p.style.cssText = 'position:fixed;top:120px;right:12px;width:240px;background:#fff;border:1px solid #cdd6df;border-radius:6px;box-shadow:0 2px 10px rgba(0,0,0,0.18);padding:10px;font-size:13px;z-index:1000;display:none;font-family:Source Sans Pro,Arial,sans-serif;';
    p.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;"><b>Feature</b><span id="efp-close" style="cursor:pointer;color:#8a99a8;font-size:16px;">&times;</span></div>' +
      '<label style="display:block;font-size:11px;color:#5a6c7e;margin-bottom:2px;">Label</label>' +
      '<input id="efp-label" type="text" style="width:100%;box-sizing:border-box;margin-bottom:8px;padding:5px 6px;border:1px solid #cdd6df;border-radius:4px;font-size:13px;" />' +
      '<label style="display:block;font-size:11px;color:#5a6c7e;margin-bottom:2px;">Notes</label>' +
      '<textarea id="efp-notes" rows="3" style="width:100%;box-sizing:border-box;margin-bottom:8px;padding:5px 6px;border:1px solid #cdd6df;border-radius:4px;font-size:13px;resize:vertical;"></textarea>' +
      '<div style="display:flex;gap:8px;">' +
        '<div style="flex:1;"><label style="display:block;font-size:11px;color:#5a6c7e;margin-bottom:2px;">Start date</label>' +
        '<input id="efp-start" type="date" style="width:100%;box-sizing:border-box;padding:4px 5px;border:1px solid #cdd6df;border-radius:4px;font-size:12px;" /></div>' +
        '<div style="flex:1;"><label style="display:block;font-size:11px;color:#5a6c7e;margin-bottom:2px;">End date</label>' +
        '<input id="efp-end" type="date" style="width:100%;box-sizing:border-box;padding:4px 5px;border:1px solid #cdd6df;border-radius:4px;font-size:12px;" /></div>' +
      '</div>' +
      '<div style="font-size:10px;color:#8a99a8;margin-top:4px;">Blank = always visible on the timeline.</div>';
    document.body.appendChild(p);
    document.getElementById('efp-close').addEventListener('click', function () { if (draw) draw.changeMode('simple_select'); hideFeaturePanel(); });
    document.getElementById('efp-label').addEventListener('input', function () { onFeatureField('label', this.value); });
    document.getElementById('efp-notes').addEventListener('input', function () { onFeatureField('notes', this.value); });
    document.getElementById('efp-start').addEventListener('change', function () { onFeatureField('start', this.value); });
    document.getElementById('efp-end').addEventListener('change', function () { onFeatureField('end', this.value); });
  }
  function showFeaturePanel(drawId) {
    selectedDrawId = drawId;
    injectFeaturePanel();
    var meta = featureMeta[drawId] || { label: '', notes: '', start: '', end: '' };
    var p = document.getElementById('editor-feature-panel'); if (!p) return;
    document.getElementById('efp-label').value = meta.label || '';
    document.getElementById('efp-notes').value = meta.notes || '';
    document.getElementById('efp-start').value = meta.start || '';
    document.getElementById('efp-end').value = meta.end || '';
    p.style.display = 'block';
  }
  function hideFeaturePanel() {
    selectedDrawId = null;
    var p = document.getElementById('editor-feature-panel'); if (p) p.style.display = 'none';
  }
  function onFeatureField(field, value) {
    if (!selectedDrawId) return;
    var meta = featureMeta[selectedDrawId] = featureMeta[selectedDrawId] || { label: '', notes: '' };
    meta[field] = value;
    clearTimeout(_featTimer);
    _featTimer = setTimeout(function () { saveFeatureMeta(selectedDrawId); }, 600);
  }
  async function saveFeatureMeta(drawId) {
    var fid = featureToDb[drawId]; if (!fid) return;
    var meta = featureMeta[drawId] || {};
    setStatus('Saving…');
    try { var r = await db.from('features').update({ label: meta.label || null, description: meta.notes || null, start_date: meta.start || null, end_date: meta.end || null }).eq('feature_id', fid); if (r.error) throw new Error(r.error.message); setStatus('Saved'); }
    catch (e) { console.warn('editing: feature meta save failed', e); setStatus('Save failed'); }
  }
  // Toggling a drawn layer's checkbox shows/hides its features by removing them from
  // (and re-adding them to) the draw control. _suppressFeatureDelete keeps the DB intact.
  function toggleDrawnLayer(slug, visible) {
    if (!draw) return;
    var dbId = slugToLayerDbId[slug];
    var ids = Object.keys(featureLayer).filter(function (d) { return featureLayer[d] === dbId; });
    if (!visible) {
      _suppressFeatureDelete = true;
      ids.forEach(function (drawId) { try { var f = draw.get(drawId); if (f) { featureCache[drawId] = JSON.parse(JSON.stringify(f)); draw.delete(drawId); } } catch (e) {} });
      setTimeout(function () { _suppressFeatureDelete = false; }, 0);
    } else {
      ids.forEach(function (drawId) { try { if (!draw.get(drawId) && featureCache[drawId]) draw.add(featureCache[drawId]); } catch (e) {} });
    }
  }

  // ── layer style panel: per-layer color + opacity, persisted to layers.color/paint ──
  var _layerStyleTimer = null;
  function paintOpacity(paint) {
    if (!paint) return null;
    var v = paint['fill-opacity']; if (v == null) v = paint['line-opacity']; if (v == null) v = paint['circle-opacity'];
    return typeof v === 'number' ? v : null;
  }
  function paintOutline(paint) {
    if (!paint) return null;
    var v = paint['fill-outline-color']; if (v == null) v = paint['circle-stroke-color'];
    return typeof v === 'string' ? v : null;
  }
  function paintWidth(paint) {   // outline/line thickness — line-width (line/polygon stroke) or circle-stroke-width
    if (!paint) return null;
    var v = paint['line-width']; if (v == null) v = paint['circle-stroke-width'];
    return typeof v === 'number' ? v : null;
  }
  function buildLayerPaint(type, color, op, outline, outlineVis, width, radius) {
    var w = width != null ? width : 2;
    if (type === 'fill') return { 'fill-color': color, 'fill-outline-color': outline || color, 'fill-opacity': op != null ? op : 0.35, 'line-opacity': outlineVis != null ? outlineVis : 1, 'line-width': w };
    if (type === 'line') return { 'line-color': color, 'line-width': w, 'line-opacity': op != null ? op : 1 };
    return { 'circle-color': color, 'circle-radius': radius != null ? radius : 5, 'circle-stroke-width': width != null ? width : 1.5, 'circle-stroke-color': outline || '#000', 'circle-opacity': op != null ? op : 1 };
  }
  function injectLayerPanel() {
    if (document.getElementById('editor-layer-panel')) return;
    var p = document.createElement('div');
    p.id = 'editor-layer-panel';
    p.style.cssText = 'position:fixed;top:120px;left:362px;width:210px;background:#fff;border:1px solid #cdd6df;border-radius:6px;box-shadow:0 2px 10px rgba(0,0,0,0.18);padding:10px;font-size:13px;z-index:1000;display:none;font-family:Source Sans Pro,Arial,sans-serif;';
    p.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;"><b id="elp-title">Layer style</b><span id="elp-close" style="cursor:pointer;color:#8a99a8;font-size:16px;">&times;</span></div>' +
      '<label style="display:block;font-size:11px;color:#5a6c7e;margin-bottom:2px;">Color</label>' +
      '<input id="elp-color" type="color" style="width:100%;height:30px;box-sizing:border-box;margin-bottom:8px;padding:1px;border:1px solid #cdd6df;border-radius:4px;cursor:pointer;" />' +
      '<label style="display:block;font-size:11px;color:#5a6c7e;margin-bottom:2px;">Opacity <span id="elp-opacity-val"></span></label>' +
      '<input id="elp-opacity" type="range" min="0" max="1" step="0.05" style="width:100%;box-sizing:border-box;" />' +
      '<div id="elp-radius-row" style="margin-top:8px;"><label style="display:block;font-size:11px;color:#5a6c7e;margin-bottom:2px;">Radius <span id="elp-radius-val"></span></label>' +
      '<input id="elp-radius" type="range" min="1" max="30" step="1" style="width:100%;box-sizing:border-box;" /></div>' +
      '<div id="elp-outline-row" style="margin-top:8px;"><label style="display:block;font-size:11px;color:#5a6c7e;margin-bottom:2px;">Outline color</label>' +
      '<input id="elp-outline" type="color" style="width:100%;height:28px;box-sizing:border-box;padding:1px;border:1px solid #cdd6df;border-radius:4px;cursor:pointer;" /></div>' +
      '<div id="elp-width-row" style="margin-top:8px;"><label style="display:block;font-size:11px;color:#5a6c7e;margin-bottom:2px;"><span id="elp-width-label">Width</span> <span id="elp-width-val"></span></label>' +
      '<input id="elp-width" type="range" min="0.5" max="12" step="0.5" style="width:100%;box-sizing:border-box;" /></div>' +
      '<div id="elp-vis-row" style="margin-top:8px;display:flex;gap:12px;font-size:12px;color:#5a6c7e;">' +
        '<label style="cursor:pointer;"><input id="elp-fill-vis" type="checkbox" style="vertical-align:middle;margin:0 3px 0 0;" />Show fill</label>' +
        '<label style="cursor:pointer;"><input id="elp-outline-vis" type="checkbox" style="vertical-align:middle;margin:0 3px 0 0;" />Show outline</label>' +
      '</div>' +
      '<button id="elp-split" style="margin-top:10px;width:100%;padding:6px;border:1px solid #cdd6df;border-radius:4px;background:#f3f6f9;cursor:pointer;font-size:12px;">Split outline into its own layer</button>';
    document.body.appendChild(p);
    document.getElementById('elp-close').addEventListener('click', hideLayerPanel);
    document.getElementById('elp-color').addEventListener('input', function () { onLayerStyle('color', this.value); });
    document.getElementById('elp-opacity').addEventListener('input', function () { document.getElementById('elp-opacity-val').textContent = this.value; onLayerStyle('opacity', parseFloat(this.value)); });
    document.getElementById('elp-outline').addEventListener('input', function () { onLayerStyle('outline', this.value); });
    document.getElementById('elp-width').addEventListener('input', function () { document.getElementById('elp-width-val').textContent = this.value; onLayerStyle('width', parseFloat(this.value)); });
    document.getElementById('elp-radius').addEventListener('input', function () { document.getElementById('elp-radius-val').textContent = this.value; onLayerStyle('radius', parseFloat(this.value)); });
    document.getElementById('elp-fill-vis').addEventListener('change', function () { onLayerStyle('fillVisible', this.checked); });
    document.getElementById('elp-outline-vis').addEventListener('change', function () { onLayerStyle('outlineVisible', this.checked); });
    document.getElementById('elp-split').addEventListener('click', function () {
      var n = activeLayerId && findNodeById(layers, activeLayerId);
      if (n && (n.outlineOf || n.outlineSplit)) onUnsplitOutline(); else onSplitOutline();
    });
  }
  function showLayerPanel(slug) {
    var node = findNodeById(layers, slug); if (!node) return;
    var isGeojson = node.source_type === 'geojson-supabase';   // split is drawn-layer only
    var fillStroke = (isGeojson || isTilesetNode(node)) && node.type === 'fill';  // drawn AND tileset fills get the real line outline + its width/show toggles
    injectLayerPanel();
    var p = document.getElementById('editor-layer-panel'); if (!p) return;
    var color = (node.iconColor && /^#[0-9a-fA-F]{6}$/.test(node.iconColor)) ? node.iconColor : '#3bb2d0';
    var op = paintOpacity(node.paint); if (op == null) op = (node.type === 'fill') ? 0.35 : 1;
    var outline = paintOutline(node.paint) || (node.type === 'fill' ? color : '#000000');
    document.getElementById('elp-title').textContent = node.label || 'Layer style';
    document.getElementById('elp-color').value = color;
    document.getElementById('elp-opacity').value = op;
    document.getElementById('elp-opacity-val').textContent = op;
    document.getElementById('elp-outline').value = /^#[0-9a-fA-F]{6}$/.test(outline) ? outline : '#000000';
    document.getElementById('elp-outline-row').style.display = (node.type === 'line' || node.outlineSplit) ? 'none' : 'block';  // lines + split polygons have no separate outline here
    var strokeVis = (node.paint && node.paint['line-opacity'] != null) ? node.paint['line-opacity'] : 1;
    document.getElementById('elp-fill-vis').checked = op > 0;
    document.getElementById('elp-outline-vis').checked = strokeVis !== 0;
    document.getElementById('elp-vis-row').style.display = (fillStroke && !node.outlineSplit) ? 'flex' : 'none';  // fill + outline toggles ride the real stroke line layer
    var splitBtn = document.getElementById('elp-split');   // doubles as split / merge (un-split)
    if (node.outlineOf) { splitBtn.textContent = 'Merge into polygon'; splitBtn.style.display = 'block'; }
    else if (fillStroke) { splitBtn.textContent = node.outlineSplit ? 'Merge outline back in' : 'Split outline into its own layer'; splitBtn.style.display = 'block'; }
    else { splitBtn.style.display = 'none'; }
    var width = paintWidth(node.paint); if (width == null) width = (node.type === 'circle') ? 1.5 : 2;
    document.getElementById('elp-width').value = width;
    document.getElementById('elp-width-val').textContent = width;
    document.getElementById('elp-width-label').textContent = (node.type === 'line') ? 'Width' : 'Outline width';
    // width = line/outline thickness: lines, un-split polygons (auto-outline), and circles (circle-stroke-width — uncapped, no split needed)
    document.getElementById('elp-width-row').style.display = ((node.type === 'line') || (fillStroke && !node.outlineSplit) || node.type === 'circle') ? 'block' : 'none';
    var radius = (node.paint && node.paint['circle-radius'] != null) ? node.paint['circle-radius'] : 5;
    document.getElementById('elp-radius').value = radius;
    document.getElementById('elp-radius-val').textContent = radius;
    document.getElementById('elp-radius-row').style.display = (node.type === 'circle') ? 'block' : 'none';
    p.style.display = 'block';
  }
  function hideLayerPanel() { var p = document.getElementById('editor-layer-panel'); if (p) p.style.display = 'none'; }
  var _styleSession = null, _styleBefore = null;   // capture the pre-edit style once per edit session (debounced edits → one undo)
  function onLayerStyle(field, value) {
    if (!activeLayerId) return;
    var node = findNodeById(layers, activeLayerId); if (!node) return;
    if (_styleSession !== node.id) { _styleSession = node.id; _styleBefore = { color: node.iconColor, paint: node.paint ? JSON.parse(JSON.stringify(node.paint)) : null }; }
    if (field === 'color') node.iconColor = value;
    var color = node.iconColor || '#3bb2d0';
    var curStrokeVis = (node.paint && node.paint['line-opacity'] != null) ? node.paint['line-opacity'] : 1;
    var op = field === 'opacity' ? value : (field === 'fillVisible' ? (value ? 0.35 : 0) : paintOpacity(node.paint));
    var outline = field === 'outline' ? value : paintOutline(node.paint);
    var outlineVis = field === 'outlineVisible' ? (value ? 1 : 0) : curStrokeVis;
    var width = field === 'width' ? value : paintWidth(node.paint);
    var radius = field === 'radius' ? value : ((node.paint && node.paint['circle-radius'] != null) ? node.paint['circle-radius'] : null);
    node.paint = buildLayerPaint(node.type, color, op, outline, outlineVis, width, radius);
    applyLayerStylePreview(node, op, outline, outlineVis, width, radius);
    clearTimeout(_layerStyleTimer);
    _layerStyleTimer = setTimeout(function () { saveLayerStyle(node.id); }, 500);
  }
  function applyLayerStylePreview(node, op, outline, outlineVis, width, radius) {
    if (node.outlineOf) {
      // a split-off outline is an engine LINE layer (no MapboxDraw features) — repaint it
      // directly via setPaintProperty (which updates live, unlike MapboxDraw).
      var pp = node.paint || {};
      [['left', beforeMap], ['right', (typeof afterMap !== 'undefined' ? afterMap : null)]].forEach(function (pair) {
        var m = pair[1]; if (!m) return; var id = node.id + '-' + pair[0]; if (!m.getLayer(id)) return;
        try {
          if (node.iconColor) m.setPaintProperty(id, 'line-color', node.iconColor);
          if (pp['line-width'] != null) m.setPaintProperty(id, 'line-width', pp['line-width']);
          if (op != null) m.setPaintProperty(id, 'line-opacity', op);
        } catch (e) {}
      });
    } else if (isTilesetNode(node)) {
      // a tileset is an engine map layer (fill/line/circle) — repaint <id>-left/right via
      // setPaintProperty; apply only paint keys that match the layer type (e.g. 'fill-*' to a fill).
      var tp = node.paint || {};
      [['left', beforeMap], ['right', (typeof afterMap !== 'undefined' ? afterMap : null)]].forEach(function (pair) {
        var m = pair[1]; if (!m) return; var id = node.id + '-' + pair[0]; var ml = m.getLayer(id); if (!ml) return;
        Object.keys(tp).forEach(function (k) { if (k.indexOf(ml.type + '-') === 0) { try { m.setPaintProperty(id, k, tp[k]); } catch (e) {} } });
        // a fill tileset's outline is a separate line layer — repaint its color/width/opacity too
        var sid = node.id + '-stroke-' + pair[0];
        if (m.getLayer(sid)) {
          if (tp['fill-outline-color'] != null) { try { m.setPaintProperty(sid, 'line-color', tp['fill-outline-color']); } catch (e) {} }
          if (tp['line-width'] != null) { try { m.setPaintProperty(sid, 'line-width', tp['line-width']); } catch (e) {} }
          if (tp['line-opacity'] != null) { try { m.setPaintProperty(sid, 'line-opacity', tp['line-opacity']); } catch (e) {} }
        }
      });
    } else if (draw) {
      // Repaint the layer's features with the new color/opacity. Only a delete+add
      // actually refreshes MapboxDraw's cold render source (draw.set / setFeatureProperty
      // update the store but don't repaint). _suppressFeatureDelete keeps the DB intact.
      var dbId = slugToLayerDbId[node.id];
      var ids = Object.keys(featureLayer).filter(function (d) { return featureLayer[d] === dbId; });
      if (ids.length) {
        _suppressFeatureDelete = true;
        ids.forEach(function (drawId) {
          try {
            var f = draw.get(drawId); if (!f) return;
            if (node.iconColor) f.properties.color = node.iconColor;
            if (op != null) f.properties.opacity = op;
            if (outline != null) f.properties.outline = outline;
            if (outlineVis != null) f.properties.strokeopacity = outlineVis;
            if (width != null) f.properties.strokewidth = width;
            if (radius != null) f.properties.radius = radius;
            draw.delete(drawId); draw.add(f);
          } catch (e) {}
        });
        setTimeout(function () { _suppressFeatureDelete = false; }, 0);
      }
    }
    var panel = document.getElementById('layers-panel-content');
    var row = panel && panel.querySelector('.layer-list-row[data-node-id="' + node.id + '"]');
    var icon = row && row.querySelector('label i');
    if (icon && node.iconColor) icon.style.color = node.iconColor;
  }
  async function saveLayerStyle(slug) {
    var node = findNodeById(layers, slug); if (!node) return;
    var lid = slugToLayerDbId[slug]; if (!lid) return;
    setStatus('Saving…');
    try { var r = await db.from('layers').update({ color: node.iconColor || '#3bb2d0', paint: node.paint }).eq('id', lid); if (r.error) throw new Error(r.error.message); setStatus('Saved'); }
    catch (e) { console.warn('editing: layer style save failed', e); setStatus('Save failed'); }
    if (_styleSession === slug && _styleBefore) {   // one undo entry per debounced edit session
      var before = _styleBefore, after = { color: node.iconColor, paint: node.paint ? JSON.parse(JSON.stringify(node.paint)) : null };
      pushUndo(function () { return applyLayerStyleState(slug, before.color, before.paint); }, function () { return applyLayerStyleState(slug, after.color, after.paint); }, 'style');
      _styleSession = null; _styleBefore = null;
    }
  }
  // restore a layer's color+paint (used by style undo/redo): re-paint live + persist + refresh the panel
  async function applyLayerStyleState(slug, color, paint) {
    var node = findNodeById(layers, slug); if (!node) return;
    node.iconColor = color || '#3bb2d0'; node.paint = paint ? JSON.parse(JSON.stringify(paint)) : null;
    var op = paintOpacity(paint), outline = paintOutline(paint), ov = (paint && paint['line-opacity'] != null) ? paint['line-opacity'] : null, w = paintWidth(paint), rad = (paint && paint['circle-radius'] != null) ? paint['circle-radius'] : null;
    applyLayerStylePreview(node, op, outline, ov, w, rad);
    var lid = slugToLayerDbId[slug]; if (lid) { try { await db.from('layers').update({ color: node.iconColor, paint: node.paint }).eq('id', lid); } catch (e) {} }
    var icon = (document.querySelector('.layer-list-row[data-node-id="' + slug + '"] label i')); if (icon && node.iconColor) icon.style.color = node.iconColor;
    if (activeLayerId === slug) showLayerPanel(slug);
  }

  // Split a polygon's outline into its own standalone, independently-toggleable layer.
  // Drawn (geojson) P → O borrows P's features; tileset P → O is a line over P's vector source.
  async function onSplitOutline() {
    var P = activeLayerId && findNodeById(layers, activeLayerId);
    if (!P || P.type !== 'fill' || P.outlineSplit) return;
    if (idsReady) { try { await idsReady; } catch (e) {} }
    var isTs = isTilesetNode(P);
    setStatus('Splitting…');
    try {
      var color = (P.paint && P.paint['fill-outline-color']) || P.iconColor || '#3bb2d0';
      var owidth = (P.paint && P.paint['line-width']) || (isTs ? 1 : 2);
      var oNode;
      if (isTs) {
        // a tileset outline is a standalone LINE layer over the SAME vector source + source-layer
        var oid = uid();
        oNode = { id: oid, label: (P.label || 'Polygon') + ' outline', type: 'line', source: P.source, 'source-layer': P['source-layer'],
          paint: { 'line-color': color, 'line-width': owidth, 'line-opacity': 1 }, outlineOf: P.id, toggleElement: oid,
          containerId: 'cont-' + oid, className: oid, topLayerClass: oid, iconType: 'slash', iconColor: color, isSolid: true, checked: true };
      } else {
        oNode = makeNode('layer', (P.label || 'Polygon') + ' outline');
        oNode.type = 'line';
        oNode.iconType = 'slash';
        oNode.outlineOf = P.id;                 // borrows the polygon's features → adapter draws its edges
        oNode.toggleElement = oNode.id;         // so refreshLayers toggles the outline's engine layer
        oNode.iconColor = color;
        oNode.paint = { 'line-color': color, 'line-width': owidth, 'line-opacity': 1 };
      }
      // place the outline layer next to the polygon, under the same parent
      var pParent = findParent(layers, P);
      var sId = null, gId = null;
      if (pParent && pParent.type === 'group') { gId = pParent._dbId; var ps = findParent(layers, pParent); if (ps && ps.type === 'section') sId = ps._dbId; }
      else if (pParent && pParent.type === 'section') { sId = pParent._dbId; }
      var oLayerId = await insertOne('layers', leafRow(oNode));
      slugToLayerDbId[oNode.id] = oLayerId;
      await insertOne('project_layers', { project_id: projectId, layer_id: oLayerId, sort_order: nextSort++, section_id: sId, group_id: gId });
      // mark the polygon split (its auto-stroke is now handed off) + persist (merge, don't clobber raw_config)
      P.outlineSplit = true;
      var pLid = slugToLayerDbId[P.id];
      if (pLid) {
        var cur = await db.from('layers').select('raw_config').eq('id', pLid).single();
        var rc = (cur.data && cur.data.raw_config) || {}; rc.outlineSplit = true;
        var r = await db.from('layers').update({ raw_config: rc }).eq('id', pLid); if (r.error) throw new Error(r.error.message);
      }
      var loc = locate(layers, P);
      if (loc) loc.arr.splice(loc.idx + 1, 0, oNode); else layers.push(oNode);
      rerender();
      if (isTs) {
        renderTilesetOnMap(oNode);     // O is a standalone tileset line layer over P's source-layer
        removeTilesetStroke(P);        // drop P's auto-outline stroke — O owns the outline now
        if (typeof refreshLayers === 'function') refreshLayers();
      } else {
        addOutlineMapLayer(oNode, P);  // engine added map layers at load — add the outline's now
        hideDrawnEngineLayers();       // skips the outline layer (outlineOf) so it stays visible
        hideSplitPolygonStroke(P);     // hide the polygon's own MapboxDraw stroke so it doesn't double
      }
      setActiveLayer(oNode.id);
      setStatus('Saved');
    } catch (e) { console.warn('editing: split outline failed', e); setStatus('Split failed: ' + e.message); }
  }
  // Remove a split tileset polygon's auto-outline stroke layers (the new O line layer replaces them).
  function removeTilesetStroke(P) {
    [['left', beforeMap], ['right', (typeof afterMap !== 'undefined' ? afterMap : null)]].forEach(function (pair) {
      var m = pair[1]; if (!m) return; var sid = P.id + '-stroke-' + pair[0];
      try { if (m.getLayer(sid)) m.removeLayer(sid); } catch (e) {}
    });
  }
  // Reverse a split: delete the outline layer O and fold its styling back into the polygon P's
  // auto-outline. Works whether the active layer is the polygon (P) or its outline (O).
  async function onUnsplitOutline() {
    var node = activeLayerId && findNodeById(layers, activeLayerId); if (!node) return;
    var P = node.outlineOf ? findNodeById(layers, node.outlineOf) : node;
    if (!P || !P.outlineSplit) return;
    var O = node.outlineOf ? node : (function () { var o = null; (function walk(a) { (a || []).forEach(function (n) { if (n.outlineOf === P.id) o = n; if (n.children) walk(n.children); }); })(layers); return o; })();
    if (idsReady) { try { await idsReady; } catch (e) {} }
    var isTs = isTilesetNode(P);
    setStatus('Merging…');
    try {
      // carry O's outline styling back into P's paint so the merged auto-outline keeps its look
      if (O && O.paint) {
        P.paint = P.paint || {};
        if (O.paint['line-color']) P.paint['fill-outline-color'] = O.paint['line-color'];
        if (O.paint['line-width'] != null) P.paint['line-width'] = O.paint['line-width'];
        if (O.paint['line-opacity'] != null) P.paint['line-opacity'] = O.paint['line-opacity'];
      }
      // delete the outline layer O from the project
      if (O) {
        var oLid = slugToLayerDbId[O.id];
        if (oLid) {
          await db.from('features').delete().eq('layer_id', oLid);
          var dp = await db.from('project_layers').delete().eq('project_id', projectId).eq('layer_id', oLid); if (dp.error) throw new Error(dp.error.message);
          var dl = await db.from('layers').delete().eq('id', oLid); if (dl.error) throw new Error(dl.error.message);
        }
      }
      // clear P.outlineSplit + persist P's restored paint (so the adapter re-emits its auto-stroke)
      var pLid = slugToLayerDbId[P.id];
      if (pLid) {
        var cur = await db.from('layers').select('raw_config').eq('id', pLid).single();
        var rc = (cur.data && cur.data.raw_config) || {}; delete rc.outlineSplit;
        var r = await db.from('layers').update({ raw_config: Object.keys(rc).length ? rc : null, paint: P.paint }).eq('id', pLid); if (r.error) throw new Error(r.error.message);
      }
      if (O) { removeMapLayers(O.id); removeFromTree(layers, O); delete slugToLayerDbId[O.id]; }
      delete P.outlineSplit;
      rerender();
      if (isTs) addTilesetStrokeOn(P);     // re-add P's auto-outline stroke line layer
      else showDrawnPolygonStroke(P);      // un-hide the drawn polygon's MapboxDraw stroke
      setActiveLayer(P.id);
      setStatus('Saved');
    } catch (e) { console.warn('editing: unsplit failed', e); setStatus('Merge failed: ' + e.message); }
  }
  function removeMapLayers(id) {
    [['left', beforeMap], ['right', (typeof afterMap !== 'undefined' ? afterMap : null)]].forEach(function (pair) {
      var m = pair[1]; if (!m) return; var main = id + '-' + pair[0], strk = id + '-stroke-' + pair[0];
      try { if (m.getLayer(strk)) m.removeLayer(strk); } catch (e) {}
      try { if (m.getLayer(main)) m.removeLayer(main); } catch (e) {}
      try { if (m.getSource(main)) m.removeSource(main); } catch (e) {}
    });
  }
  function currentMapDate() {
    try { var d = (window.moment && window.$) ? moment($('#date').text()).format('YYYYMMDD') : ''; return /^\d{8}$/.test(d) ? parseInt(d, 10) : undefined; } catch (e) { return undefined; }
  }
  function addTilesetStrokeOn(P) {   // re-create a fill tileset's auto-outline stroke line layer (mirrors renderTilesetOnMap)
    if (typeof addMapLayer !== 'function' || P.type !== 'fill' || !P.paint || !P.paint['fill-outline-color']) return;
    var date = currentMapDate();
    [['left', beforeMap], ['right', (typeof afterMap !== 'undefined' ? afterMap : null)]].forEach(function (pair) {
      var side = pair[0], m = pair[1]; if (!m) return; var sid = P.id + '-stroke-' + side; if (m.getLayer(sid)) return;
      var sc = { id: sid, type: 'line', source: P.id + '-' + side, paint: { 'line-color': P.paint['fill-outline-color'], 'line-width': P.paint['line-width'] || 1, 'line-opacity': P.paint['line-opacity'] != null ? P.paint['line-opacity'] : 1 }, layout: { 'line-cap': 'round', 'line-join': 'round' } };
      if (P['source-layer']) sc['source-layer'] = P['source-layer'];
      try { addMapLayer(m, sc, date); } catch (e) { console.warn('editing: restore tileset stroke failed', e); }
    });
  }
  function showDrawnPolygonStroke(P) {   // un-hide a drawn polygon's MapboxDraw stroke (reverse hideSplitPolygonStroke)
    if (!draw) return;
    var dbId = slugToLayerDbId[P.id];
    var ids = Object.keys(featureLayer).filter(function (d) { return featureLayer[d] === dbId; });
    if (!ids.length) return;
    var so = (P.paint && P.paint['line-opacity'] != null) ? P.paint['line-opacity'] : 1;
    var sw = (P.paint && P.paint['line-width'] != null) ? P.paint['line-width'] : 2;
    var oc = P.paint && P.paint['fill-outline-color'];
    _suppressFeatureDelete = true;
    ids.forEach(function (drawId) { try { var f = draw.get(drawId); if (f) { f.properties.strokeopacity = so; f.properties.strokewidth = sw; if (oc) f.properties.outline = oc; draw.delete(drawId); draw.add(f); } } catch (e) {} });
    setTimeout(function () { _suppressFeatureDelete = false; }, 0);
  }
  // Add the outline layer's map layer to the editor, built from the polygon's live features
  // (a `line` layer over the polygon geometry draws its edges). Reloading rebuilds it via the adapter.
  function addOutlineMapLayer(oNode, P) {
    if (!draw) return;
    var dbId = slugToLayerDbId[P.id];
    var pFeats = Object.keys(featureLayer).filter(function (d) { return featureLayer[d] === dbId; }).map(function (d) { return draw.get(d); }).filter(Boolean);
    var fc = { type: 'FeatureCollection', features: pFeats.map(function (f) { return { type: 'Feature', geometry: f.geometry, properties: { DayStart: 0, DayEnd: 99999999 } }; }) };
    [['left', beforeMap], ['right', (typeof afterMap !== 'undefined' ? afterMap : null)]].forEach(function (pair) {
      var side = pair[0], m = pair[1]; if (!m) return;
      var id = oNode.id + '-' + side;
      try {
        if (m.getLayer(id)) m.removeLayer(id);
        if (m.getSource(id)) m.removeSource(id);
        m.addLayer({ id: id, type: 'line', source: { type: 'geojson', data: fc }, paint: oNode.paint, layout: { 'line-cap': 'round', 'line-join': 'round' } });
      } catch (e) {}
    });
  }
  // After a split, hide the polygon's in-editor MapboxDraw stroke (the outline layer owns it now).
  function hideSplitPolygonStroke(P) {
    if (!draw) return;
    var dbId = slugToLayerDbId[P.id];
    var ids = Object.keys(featureLayer).filter(function (d) { return featureLayer[d] === dbId; });
    if (!ids.length) return;
    _suppressFeatureDelete = true;
    ids.forEach(function (drawId) { try { var f = draw.get(drawId); if (f) { f.properties.strokeopacity = 0; draw.delete(drawId); draw.add(f); } } catch (e) {} });
    setTimeout(function () { _suppressFeatureDelete = false; }, 0);
  }

  // After the engine renders the tree (on boot and after every edit), add the
  // row affordances. enhanceRows is idempotent — generateLayersPanel replaces the
  // panel's innerHTML, so each render starts from fresh, un-enhanced rows.
  if (typeof window.generateLayersPanel === 'function') {
    var _origGenPanel = window.generateLayersPanel;
    window.generateLayersPanel = function () { var r = _origGenPanel.apply(this, arguments); try { enhanceRows(); } catch (e) {} return r; };
  }

  start();
  (function whenReady() {
    if (document.getElementById('layers-panel-content')) { injectChrome(); enhanceRows(); }
    else setTimeout(whenReady, 150);
  })();
  (function waitForMap() {
    if (typeof beforeMap !== 'undefined' && beforeMap && typeof MapboxDraw !== 'undefined') setupDraw();
    else setTimeout(waitForMap, 250);
  })();
})();
