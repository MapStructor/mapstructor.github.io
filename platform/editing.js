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
  console.log('%c[editing.js] BUILD 2026-06-18z — fix: re-render no longer setStyles (layers stay); map radio switches basemap', 'background:#ce5c00;color:#fff;padding:2px 6px;border-radius:3px;font-weight:bold;');
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
  // Set a layer/group's zoom-to target to the CURRENT view, so its (always-rendered) crosshairs ◎ flies here.
  async function onSetZoom(id) {
    var node = findNodeById(layers, id); if (!node || !beforeMap) return;
    var c = beforeMap.getCenter(), z = beforeMap.getZoom();
    node.zoomCenter = [c.lng, c.lat]; node.zoomLevel = z;
    var _zi = document.getElementById('elp-zoom-info'); if (_zi && activeLayerId === id) _zi.textContent = fmtNodeZoom(node);   // live-update the panel readout
    setStatus('Saving…');
    try {
      if (node.type === 'section') { setStatus('Sections have no zoom button'); return; }
      if (node.type === 'group') { var gid = node._dbId; if (!gid) throw new Error('no group id'); var rg = await db.from('layer_groups').update({ zoom_center_lng: c.lng, zoom_center_lat: c.lat, zoom_level: z }).eq('id', gid); if (rg.error) throw new Error(rg.error.message); }
      else { var lid = slugToLayerDbId[id]; if (!lid) throw new Error('no layer id'); var rl = await db.from('layers').update({ zoom_center_lng: c.lng, zoom_center_lat: c.lat, zoom_level: z }).eq('id', lid); if (rl.error) throw new Error(rl.error.message); }
      setStatus('Zoom target set — its ◎ now flies here');
    } catch (e) { setStatus('Save failed'); }
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
        if (e.target.closest('input,.layer-buttons-block,.editor-del,.editor-setzoom,.compress-expand-icon,.toggle')) return;
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
      // set-zoom: styleable layers set it from the layer editing panel now; keep the row ◎ only for groups +
      // non-styleable layers (which get no panel), and never for sections (they have no zoom target).
      var szHasPanel = enNode && (enNode.type === 'group' || enNode.source_type === 'geojson-supabase' || (isTilesetNode(enNode) && ['fill', 'line', 'circle'].indexOf(enNode.type) > -1));
      if (enNode && enNode.type !== 'section' && !szHasPanel) {
        var setz = document.createElement('span');
        setz.className = 'editor-setzoom'; setz.innerHTML = '◎'; setz.title = 'Set this group’s zoom-to target to the current view';
        setz.addEventListener('click', function (e) { e.stopPropagation(); e.preventDefault(); onSetZoom(id); });
        row.appendChild(setz);
      }
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
      wireEngineEditClicks();
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

  // ── tileset / large-layer editing: pull ONE engine-rendered feature into MapboxDraw, hide the read-only
  //    render of just that feature (filter-exclude its id on both maps), then edit + save in place via the
  //    normal draw flow. The lean version of AHM's "promoted overlay" — no status lifecycle. ──
  var _engineEditIds = {};      // slug → [feature_id,…] currently pulled into draw (excluded from the engine render)
  var _engineBaseFilter = {};   // layerId → its filter before exclusion (so it can be restored)
  var _engineEditWired = {};    // slug → true once click handlers are attached
  var _engineWasMulti = {};     // drawId → true if the DB geom was a MultiPolygon — mapbox-gl-draw renders/edits Polygons, not MultiPolygons (so an unconverted building vanishes on click), convert in + convert back on save
  var _engineOrigMulti = {};    // drawId → the original MultiPolygon, so extra parts survive a save
  function toDrawPolygon(geom) { return (geom && geom.type === 'MultiPolygon') ? { type: 'Polygon', coordinates: (geom.coordinates && geom.coordinates[0]) || [] } : geom; }
  function toDbGeom(drawId, geom) {
    if (!_engineWasMulti[drawId] || !geom || geom.type !== 'Polygon') return geom;
    var rest = ((_engineOrigMulti[drawId] || {}).coordinates || []).slice(1);   // keep any extra polygon parts the user didn't edit
    return { type: 'MultiPolygon', coordinates: [geom.coordinates].concat(rest) };
  }
  function isEngineEditable(node) {
    if (!node || !node.id) return false;
    if (node.editable === false) return false;   // display-only layers (e.g. a Mapbox tileset whose features aren't in `features`) opt out of click-to-edit

    if (node.source_type === 'geojson-supabase' && !_drawLayerSlugs[node.id]) return true;   // large drawn layer (engine-rendered, not in MapboxDraw)
    return isTilesetNode(node);                                                               // any tileset (once its data lives in features, id-aligned)
  }
  function wireEngineEditClicks() {
    if (typeof layers === 'undefined' || !draw) return;
    if (!_panelClickPatched && typeof window.handlePanelClick === 'function') {   // editor: editable layers own their clicks (edit), so the engine's encyclopedia panel-click must not ALSO fire — the page shows via the feature panel instead
      _panelClickPatched = true; var _origHPC = window.handlePanelClick;
      window.handlePanelClick = function (layer, event) {
        try { var n = findNodeById(layers, layer && layer.id); if (n && isEngineEditable(n)) return; } catch (e) {}
        return _origHPC.apply(this, arguments);
      };
    }
    if (!_changeDatePatched && typeof window.changeDate === 'function') {   // the timeline's changeDate re-sets each layer's date filter, clobbering our edit-exclusion → re-apply it after
      _changeDatePatched = true; var _origCD = window.changeDate;
      window.changeDate = function () {
        var r = _origCD.apply(this, arguments);
        try {
          Object.keys(_engineEditIds).forEach(function (slug) {
            if (!(_engineEditIds[slug] || []).length) return;
            var n = findNodeById(layers, slug); if (!n) return;
            [['left', beforeMap], ['right', (typeof afterMap !== 'undefined' ? afterMap : null)]].forEach(function (pair) { var m = pair[1]; if (!m) return; [n.id + '-' + pair[0], n.id + '-stroke-' + pair[0], n.id + '-highlighted-' + pair[0]].forEach(function (lid) { delete _engineBaseFilter[lid]; }); });   // re-capture the new date filter as the base
            applyEngineEditFilter(n);
          });
        } catch (e) {}
        return r;
      };
    }
    // ONE map-level click handler per side that queries the editable layers at CLICK time — robust, unlike
    // per-layer handlers that depend on the layer already existing when wiring runs (the flaky "bolting" race).
    if (!_engineMapClickWired) {
      _engineMapClickWired = true;
      [['left', beforeMap], ['right', (typeof afterMap !== 'undefined' ? afterMap : null)]].forEach(function (pair) {
        var map = pair[1], side = pair[0]; if (!map) return;
        map.on('click', function (e) {
          // The swipe routes a click to ONE map, but the editable layer may render only on the OTHER side.
          // Both maps share the view, so e.point is valid on both — query both and edit whichever has the feature.
          var found = null;
          [['left', beforeMap], ['right', (typeof afterMap !== 'undefined' ? afterMap : null)]].forEach(function (pr) {
            if (found) return; var mm = pr[1], sd = pr[0]; if (!mm) return;
            var lids = [];
            (function walk(arr) { (arr || []).forEach(function (n) { if (isEngineEditable(n) && mm.getLayer(n.id + '-' + sd)) lids.push(n.id + '-' + sd); if (n.children) walk(n.children); }); })(layers);
            if (!lids.length) return;
            var fs; try { fs = mm.queryRenderedFeatures(e.point, { layers: lids }); } catch (err) { return; }
            if (fs && fs.length) found = fs;
          });
          if (!found) return;
          var node = findNodeById(layers, found[0].layer.id.replace(/-(left|right)$/, ''));
          if (node) onEngineFeatureClick(node, { features: found });
        });
      });
    }
  }
  function onEngineFeatureClick(node, e) {
    if (!e.features || !e.features.length) return;
    var fid = e.features[0].id; if (fid == null) return;   // tile features carry the db id (Tippecanoe --use-attribute-for-id=id)
    enterEngineEdit(node, fid);
  }
  // ── Edit-backend adapter (Phase 2a): which DB + table a layer's feature edits read/write, keyed off
  //    source_type. Drawn (geojson-supabase) AND every tileset that hasn't declared its own backend
  //    resolve to the platform `features` table — today's behavior. A tileset can later carry
  //    node.editBackend = { db_url, anon_key, table, id_col, geom_col, layer_col } to route its edits to
  //    its OWN source table (e.g. curr-builds → ames_buildings_2026) instead of `features`. (Phase 2b wires
  //    that config + tile regen; INSERT/DELETE routing also lands then — for now only geom read/write is
  //    routed, which is enough to prove the seam without changing any behavior.) ──
  var PLATFORM_FEATURES = { db: db, table: 'features', idCol: 'feature_id', layerCol: 'layer_id', geomCol: 'geom' };
  var _editClients = {};
  function getEditBackend(node) {
    var eb = node && node.editBackend;
    if (!eb || !eb.table) return PLATFORM_FEATURES;                       // drawn + unconfigured tilesets → platform features (unchanged)
    var client = db;
    if (eb.db_url && eb.anon_key && window.supabase) {                    // a tileset pointing at its own DB
      client = _editClients[eb.db_url] || (_editClients[eb.db_url] = window.supabase.createClient(eb.db_url, eb.anon_key));
    }
    return { db: client, table: eb.table, idCol: eb.id_col || 'feature_id', layerCol: eb.layer_col || 'layer_id', geomCol: eb.geom_col || 'geom' };
  }

  async function enterEngineEdit(node, fid) {
    var drawId = 'db-' + fid;
    if (draw && draw.get(drawId)) { try { draw.changeMode('simple_select', { featureIds: [drawId] }); } catch (e) {} showFeaturePanel(drawId); return; }
    var lyrId = (typeof slugToLayerDbId !== 'undefined') ? slugToLayerDbId[node.id] : null;
    if (!lyrId) return;   // this layer's data isn't in our `features` table → not editable here
    // Scope to THIS layer's id. feature_id alone is GLOBAL, so a tile id can collide with an unrelated
    // migrated feature on another layer and "edit" (and hide) the wrong thing — the vanishing-feature bug.
    var EB = getEditBackend(node);   // Phase 2a: read from this layer's edit backend (platform `features` unless the tileset declared its own)
    var res; try { res = await EB.db.from(EB.table).select(EB.idCol + ', ' + EB.layerCol + ', ' + EB.geomCol + ', label, description, start_date, end_date, content_id').eq(EB.idCol, fid).eq(EB.layerCol, lyrId).single(); } catch (e) { res = { error: e }; }
    if (res.error || !res.data || !res.data[EB.geomCol]) return;   // not a feature of this layer → ignore the click, don't filter/hide it
    var row = res.data, rowGeom = row[EB.geomCol], origGeom = { type: rowGeom.type, coordinates: rowGeom.coordinates };
    if (origGeom.type === 'MultiPolygon') { _engineWasMulti[drawId] = true; _engineOrigMulti[drawId] = origGeom; }
    var geom = toDrawPolygon(origGeom);   // mapbox-gl-draw needs a Polygon
    featureToDb[drawId] = fid; featureLayer[drawId] = row[EB.layerCol]; _engineEditNode[drawId] = node;
    featureMeta[drawId] = { label: row.label || '', notes: row.description || '', start: row.start_date ? String(row.start_date).slice(0, 10) : '', end: row.end_date ? String(row.end_date).slice(0, 10) : '', pageid: row.content_id != null ? String(row.content_id) : '' };
    _geomSnap[drawId] = JSON.parse(JSON.stringify(geom));
    try { draw.add({ type: 'Feature', id: drawId, geometry: geom, properties: featureProps(node) || {} }); } catch (e) { setStatus('Edit failed'); return; }
    (_engineEditIds[node.id] = _engineEditIds[node.id] || []); if (_engineEditIds[node.id].indexOf(fid) < 0) _engineEditIds[node.id].push(fid);
    if (_engineEdited[node.id] && _engineEdited[node.id][fid] != null) { delete _engineEdited[node.id][fid]; refreshEditedOverlay(node); }   // pull it back off the overlay while editing
    applyEngineEditFilter(node);   // hide the read-only render of just this feature, so only the editable copy shows
    [['left', beforeMap], ['right', (typeof afterMap !== 'undefined' ? afterMap : null)]].forEach(function (pair) {   // clear any stuck hover-highlight: the tile copy is now filtered out, so the engine's mouseleave won't fire to un-green it (otherwise every clicked feature stays glowing)
      var m = pair[1]; if (!m) return; var tgt = { source: node.id + '-' + pair[0], id: Number(fid) }; if (node['source-layer']) tgt.sourceLayer = node['source-layer'];
      try { m.setFeatureState(tgt, { hover: false }); } catch (e) {}
    });
    try { draw.changeMode('simple_select', { featureIds: [drawId] }); } catch (e) {}
    showFeaturePanel(drawId);
    setStatus('Editing feature ' + fid);
  }
  function applyEngineEditFilter(node) {
    var ids = (_engineEditIds[node.id] || []).map(Number);
    [['left', beforeMap], ['right', (typeof afterMap !== 'undefined' ? afterMap : null)]].forEach(function (pair) {
      var map = pair[1]; if (!map) return;
      [node.id + '-' + pair[0], node.id + '-stroke-' + pair[0], node.id + '-highlighted-' + pair[0]].forEach(function (lid) {   // also exclude the highlight layer, else edited features stay green-glowing
        if (!map.getLayer(lid)) return;
        if (!(lid in _engineBaseFilter)) { try { _engineBaseFilter[lid] = map.getFilter(lid) || null; } catch (e) { _engineBaseFilter[lid] = null; } }
        var base = _engineBaseFilter[lid], filt;
        if (!ids.length) { filt = base; }
        else {   // legacy ["!in","$id",…] to match the engine's legacy date filter — mixing legacy + expression makes setFilter throw (the AHM filter bug)
          var excl = ['!in', '$id'].concat(ids);
          filt = (base && base[0] === 'all') ? base.concat([excl]) : (base ? ['all', base, excl] : excl);
        }
        try { map.setFilter(lid, filt); } catch (e) { console.warn('editing: engine edit filter', e); }
      });
    });
  }

  // ── "Done editing": fold the feature out of MapboxDraw and show its SAVED geometry on a normal-styled
  //    GeoJSON overlay. The tile copy stays filtered out (no stale double-render until tiles regenerate),
  //    so the edit stays visible. Re-clicking the overlay re-enters edit. ──
  var _engineEdited = {};     // node.id → { feature_id: geometry } currently shown on the overlay
  var _engineEditNode = {};   // drawId → node (so the feature panel knows it's an engine edit → show "Done editing")
  var _panelClickPatched = false;
  var _changeDatePatched = false;
  var _engineMapClickWired = false;
  function ensureEditedOverlay(node) {
    [['left', beforeMap], ['right', (typeof afterMap !== 'undefined' ? afterMap : null)]].forEach(function (pair) {
      var map = pair[1]; if (!map) return; var sid = node.id + '-edited-' + pair[0];
      if (map.getSource(sid)) return;
      try {
        map.addSource(sid, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
        var orig = (map.getStyle().layers || []).filter(function (l) { return l.id === node.id + '-' + pair[0]; })[0];
        var paint = (orig && orig.paint) || node.paint || { 'fill-color': '#ffb255', 'fill-outline-color': '#ff0000' };
        map.addLayer({ id: sid, type: 'fill', source: sid, paint: paint });   // styled like the layer, above the tile copy
        map.on('click', sid, (function (n) { return function (e) { onEngineFeatureClick(n, e); }; })(node));   // re-click → re-edit
      } catch (e) { console.warn('editing: edited overlay', e); }
    });
  }
  function refreshEditedOverlay(node) {
    var store = _engineEdited[node.id] || {};
    var feats = Object.keys(store).map(function (fid) { return { type: 'Feature', id: Number(fid), geometry: store[fid], properties: {} }; });
    [['left', beforeMap], ['right', (typeof afterMap !== 'undefined' ? afterMap : null)]].forEach(function (pair) {
      var map = pair[1]; if (!map) return; var src = map.getSource(node.id + '-edited-' + pair[0]);
      if (src) try { src.setData({ type: 'FeatureCollection', features: feats }); } catch (e) {}
    });
  }
  function finishEngineEdit(node, fid) {
    if (!node || fid == null) return;
    var drawId = 'db-' + fid, geom = null;
    try { var f = draw && draw.get(drawId); if (f) geom = f.geometry; } catch (e) {}
    if (!geom) geom = _geomSnap[drawId];
    if (geom) { (_engineEdited[node.id] = _engineEdited[node.id] || {})[fid] = geom; ensureEditedOverlay(node); refreshEditedOverlay(node); }
    try { if (draw && draw.get(drawId)) draw.delete(drawId); } catch (e) {}
    // fid stays in _engineEditIds → the tile copy remains hidden; the overlay shows the saved geometry instead
    delete _engineEditNode[drawId]; delete featureToDb[drawId]; delete featureLayer[drawId]; delete featureMeta[drawId]; delete _geomSnap[drawId]; delete _engineWasMulti[drawId]; delete _engineOrigMulti[drawId];
    hideFeaturePanel();
    setStatus('Done editing — saved');
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
      '<button data-type="import">+ Import</button>' +
      '<button data-type="export">⬇ Export</button></div>' +
      '<div class="erow">' +
      '<button data-type="group">+ Group</button>' +
      '<button data-type="section">+ Section</button></div>';
    bar.querySelectorAll('button').forEach(function (b) { b.addEventListener('click', function () { var t = b.getAttribute('data-type'); if (t === 'tileset') showTilesetForm(); else if (t === 'import') showImportForm(); else if (t === 'export') showExportForm(); else showForm(t); }); });
  }
  // ── export: a layer's saved features → downloadable GeoJSON (the inverse of Import; works for drawn
  //    layers AND tileset layers whose features live in `features`, e.g. Current buildings = 18k rows). ──
  function showExportForm() {
    var bar = document.getElementById('editor-add-bar');
    var opts = '';
    (function walk(arr) { (arr || []).forEach(function (n) { if (n.id && slugToLayerDbId[n.id]) opts += '<option value="' + n.id + '"' + (n.id === activeLayerId ? ' selected' : '') + '>' + (n.label || n.id) + '</option>'; if (n.children) walk(n.children); }); })(layers);
    if (!opts) { setStatus('No exportable layers yet'); return; }
    bar.innerHTML =
      '<div style="font-size:11px;color:#555555;margin-bottom:5px;">Download a layer\'s features (for backup / reuse).</div>' +
      '<select id="editor-export-layer">' + opts + '</select>' +
      '<select id="editor-export-format"><option value="geojson">GeoJSON (.geojson)</option><option value="kml">KML (.kml)</option><option value="shp">Shapefile (.zip)</option></select>' +
      '<div id="editor-export-status" style="font-size:11px;color:#888888;margin:2px 0 6px;min-height:13px;"></div>' +
      '<div class="erow"><button id="editor-export-ok">⬇ Download</button><button id="editor-cancel">Cancel</button></div>';
    document.getElementById('editor-export-ok').addEventListener('click', exportLayer);
    document.getElementById('editor-cancel').addEventListener('click', showButtons);
  }
  async function exportLayer() {
    var sel = document.getElementById('editor-export-layer'); var slug = sel && sel.value; if (!slug) return;
    var lid = slugToLayerDbId[slug]; if (!lid) { setStatus('That layer has no database id'); return; }
    var node = findNodeById(layers, slug);
    var status = document.getElementById('editor-export-status'), btn = document.getElementById('editor-export-ok');
    if (btn) btn.disabled = true;
    try {
      var rows = [];
      for (var from = 0; from < 1000000; from += 1000) {   // paginate — Supabase caps each request at 1000 rows
        var res = await db.from('features').select('feature_id, geom, label, description, start_date, end_date, content_id, custom_fields').eq('layer_id', lid).order('feature_id').range(from, from + 999);
        if (res.error) throw new Error(res.error.message);
        var batch = res.data || []; rows = rows.concat(batch);
        if (status) status.textContent = 'Fetched ' + rows.length + ' features…';
        if (batch.length < 1000) break;
      }
      var feats = rows.filter(function (r) { return r.geom; }).map(function (r) {
        var props = { feature_id: r.feature_id };
        if (r.label) props.label = r.label;
        if (r.description) props.description = r.description;
        if (r.start_date) props.start_date = r.start_date;
        if (r.end_date) props.end_date = r.end_date;
        if (r.content_id != null) props.content_id = r.content_id;
        if (r.custom_fields && typeof r.custom_fields === 'object') Object.keys(r.custom_fields).forEach(function (k) { if (!(k in props)) props[k] = r.custom_fields[k]; });
        return { type: 'Feature', id: r.feature_id, geometry: r.geom, properties: props };
      });
      var fc = { type: 'FeatureCollection', features: feats };
      var safe = (node && node.label ? node.label : slug).replace(/[^a-z0-9_-]+/gi, '_');
      var fmt = (document.getElementById('editor-export-format') || {}).value || 'geojson';
      var blob, ext;
      if (fmt === 'kml') {
        blob = new Blob([geojsonToKml(fc)], { type: 'application/vnd.google-earth.kml+xml' }); ext = '.kml';
      } else if (fmt === 'shp') {
        if (status) status.textContent = 'Building shapefile (' + feats.length + ' features)…';
        var mod = await import('https://cdn.jsdelivr.net/npm/@mapbox/shp-write@0.4.3/+esm');   // GeoJSON → zipped .shp/.shx/.dbf/.prj
        var z = await mod.zip(fc, { outputType: 'blob', compression: 'DEFLATE' });
        blob = (z instanceof Blob) ? z : new Blob([Uint8Array.from(atob(z), function (c) { return c.charCodeAt(0); })], { type: 'application/zip' });
        ext = '.zip';
      } else {
        blob = new Blob([JSON.stringify(fc)], { type: 'application/geo+json' }); ext = '.geojson';
      }
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a'); a.href = url; a.download = safe + ext; document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 1500);
      setStatus('Downloaded ' + feats.length + ' feature' + (feats.length === 1 ? '' : 's') + ' (' + fmt + ')');
      showButtons();
    } catch (e) { console.warn('editing: export failed', e); if (status) status.textContent = 'Export failed: ' + e.message; if (btn) btn.disabled = false; }
  }
  // GeoJSON → KML (all geometry types incl. MultiPolygon/holes), properties as ExtendedData. Hand-rolled
  // so export needs no extra library for KML (Shapefile still uses shp-write).
  function geojsonToKml(fc) {
    function esc(s) { return String(s == null ? '' : s).replace(/[<>&'"]/g, function (c) { return { '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]; }); }
    function pt(c) { return c[0] + ',' + c[1] + (c.length > 2 ? ',' + c[2] : ''); }
    function ring(r) { return (r || []).map(pt).join(' '); }
    function poly(rings) {
      var s = '<Polygon><outerBoundaryIs><LinearRing><coordinates>' + ring(rings[0]) + '</coordinates></LinearRing></outerBoundaryIs>';
      for (var i = 1; i < rings.length; i++) s += '<innerBoundaryIs><LinearRing><coordinates>' + ring(rings[i]) + '</coordinates></LinearRing></innerBoundaryIs>';
      return s + '</Polygon>';
    }
    function geom(g) {
      if (!g) return '';
      switch (g.type) {
        case 'Point': return '<Point><coordinates>' + pt(g.coordinates) + '</coordinates></Point>';
        case 'MultiPoint': return '<MultiGeometry>' + g.coordinates.map(function (c) { return '<Point><coordinates>' + pt(c) + '</coordinates></Point>'; }).join('') + '</MultiGeometry>';
        case 'LineString': return '<LineString><coordinates>' + ring(g.coordinates) + '</coordinates></LineString>';
        case 'MultiLineString': return '<MultiGeometry>' + g.coordinates.map(function (l) { return '<LineString><coordinates>' + ring(l) + '</coordinates></LineString>'; }).join('') + '</MultiGeometry>';
        case 'Polygon': return poly(g.coordinates);
        case 'MultiPolygon': return '<MultiGeometry>' + g.coordinates.map(poly).join('') + '</MultiGeometry>';
        case 'GeometryCollection': return '<MultiGeometry>' + (g.geometries || []).map(geom).join('') + '</MultiGeometry>';
        default: return '';
      }
    }
    var marks = (fc.features || []).map(function (f) {
      var p = f.properties || {}, name = p.label || p.name || (p.feature_id != null ? '#' + p.feature_id : ''), desc = p.description || p.notes || '', ext = '';
      Object.keys(p).forEach(function (k) { ext += '<Data name="' + esc(k) + '"><value>' + esc(p[k]) + '</value></Data>'; });
      return '<Placemark>' + (name ? '<name>' + esc(name) + '</name>' : '') + (desc ? '<description>' + esc(desc) + '</description>' : '') + (ext ? '<ExtendedData>' + ext + '</ExtendedData>' : '') + geom(f.geometry) + '</Placemark>';
    }).join('');
    return '<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document>' + marks + '</Document></kml>';
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
      '<div id="editor-ts-sl-status" style="font-size:11px;color:#888888;margin:-3px 0 6px;min-height:13px;"></div>' +
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
      '<div style="font-size:11px;color:#555555;margin-bottom:5px;">Import a file → a new editable layer.<br>GeoJSON · KML · Shapefile (.zip)</div>' +
      '<input id="editor-import-file" type="file" accept=".geojson,.json,.kml,.zip" style="width:100%;box-sizing:border-box;margin-bottom:6px;font-size:12px;" />' +
      '<select id="editor-parent">' + parentOptions() + '</select>' +
      '<div id="editor-import-status" style="font-size:11px;color:#888888;margin:2px 0 6px;min-height:13px;"></div>' +
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
      var rows = feats.slice(i, i + BATCH).map(function (f) { return { layer_id: layerId, geom: f.geometry, label: importLabel(f.properties), start_date: null, end_date: null, custom_fields: importCustomFields(f.properties) }; });
      var r = await db.from('features').insert(rows);
      if (r.error) throw new Error('feature insert: ' + r.error.message);
    }
  }
  var LABEL_KEYS = ['name', 'Name', 'NAME', 'label', 'Label', 'title', 'Title'];
  function importLabelKey(props) {
    if (!props) return null;
    for (var i = 0; i < LABEL_KEYS.length; i++) { if (props[LABEL_KEYS[i]] != null && props[LABEL_KEYS[i]] !== '') return LABEL_KEYS[i]; }
    return null;
  }
  function importLabel(props) {
    var k = importLabelKey(props);
    return k ? String(props[k]).slice(0, 250) : null;
  }
  // Keep every OTHER property so imported datasets don't lose their attributes — they ride in
  // features.custom_fields (jsonb) and surface as editable columns in the attribute table. The
  // label-source key is dropped so it isn't duplicated (it's already the Label column).
  function importCustomFields(props) {
    if (!props || typeof props !== 'object') return null;
    var labelKey = importLabelKey(props), out = {}, n = 0;
    Object.keys(props).forEach(function (k) {
      if (k === labelKey) return;
      var v = props[k];
      if (v == null || v === '') return;
      if (typeof v === 'object') { try { v = JSON.stringify(v); } catch (e) { return; } }   // flatten nested values to a string
      out[k] = v; n++;
    });
    return n ? out : null;
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
  // ── Map settings: rename the map + save the current view as its default (per-project `projects` row) ──
  // ── In-place popup editing: clicking the ℹ "About" button (or a layer/group info button) opens the
  //    real engine popup, and its .modal-content becomes editable right there — a small formatting
  //    toolbar + Save are injected into the popup. No separate window. ──
  function setModalAbout(about) {   // feed the engine's existing ℹ "About" popup (engine reads modal_content_html["about"] on click)
    try { window.modal_header_text = window.modal_header_text || {}; window.modal_content_html = window.modal_content_html || {}; window.modal_header_text['about'] = 'About'; window.modal_content_html['about'] = about || ''; } catch (e) {}
  }
  var _editPopupId = null;
  function setupInPlaceEditing() {
    var content = document.querySelector('div.modal-content'); if (!content) return false;
    if (!document.getElementById('editor-modal-tools')) {
      var st = document.createElement('style');
      st.textContent =
        '#editor-modal-tools{display:none;gap:3px;padding:6px 0;margin:0 0 8px;flex-wrap:wrap;align-items:center;border-bottom:1px solid #eee;}' +
        '#editor-modal-tools.on{display:flex;}' +
        '#editor-modal-tools button{min-width:28px;height:26px;border:1px solid #bbb;border-radius:4px;background:#fff;cursor:pointer;font-size:12px;line-height:1;}' +
        '#editor-modal-tools button:hover{background:#e8e8e8;}' +
        '#editor-modal-save{margin-left:auto;background:#ce5c00;color:#fff;border-color:#ce5c00;font-weight:600;padding:0 12px;}' +
        'div.modal-content[contenteditable="true"]{outline:2px dashed rgba(206,92,0,0.55);outline-offset:5px;min-height:48px;}';
      document.head.appendChild(st);
      var tools = document.createElement('div'); tools.id = 'editor-modal-tools';
      tools.innerHTML =
        '<button data-cmd="bold" title="Bold" style="font-weight:bold;">B</button>' +
        '<button data-cmd="italic" title="Italic" style="font-style:italic;">I</button>' +
        '<button data-cmd="underline" title="Underline" style="text-decoration:underline;">U</button>' +
        '<button data-cmd="formatBlock" data-val="h2" title="Heading">H</button>' +
        '<button data-cmd="formatBlock" data-val="p" title="Normal text">&para;</button>' +
        '<button data-cmd="insertUnorderedList" title="Bullet list">&bull;</button>' +
        '<button data-cmd="insertOrderedList" title="Numbered list">1.</button>' +
        '<button data-cmd="createLink" title="Insert link">&#128279;</button>' +
        '<button data-cmd="removeFormat" title="Clear formatting">&times;A</button>' +
        '<button id="editor-modal-save" title="Save">Save</button>';
      content.parentNode.insertBefore(tools, content);
      Array.prototype.forEach.call(tools.querySelectorAll('button[data-cmd]'), function (b) {
        b.addEventListener('mousedown', function (e) { e.preventDefault(); });   // keep caret/selection inside .modal-content
        b.addEventListener('click', function (e) {
          e.preventDefault(); content.focus();
          var cmd = b.getAttribute('data-cmd'), val = b.getAttribute('data-val');
          if (cmd === 'createLink') { val = prompt('Link URL:'); if (!val) return; }
          try { document.execCommand(cmd, false, val || undefined); } catch (err) {}
        });
      });
      document.getElementById('editor-modal-save').addEventListener('click', function (e) { e.preventDefault(); savePopupEdit(); });
    }
    if (!window.__editorPopupEditWired) {
      window.__editorPopupEditWired = true;
      document.addEventListener('click', function (e) {   // any ℹ / info trigger → open the popup + make it editable in place
        var t = e.target && e.target.closest && e.target.closest('.trigger-popup'); if (!t) return;
        var pid, title;
        if (t.id === 'info' || t.id === 'about-info') { pid = 'about'; title = 'About'; }
        else {   // a layer/group info button — derive a stable id from the row's node (the rendered id may be empty)
          var row = t.closest('.layer-list-row'); if (!row) return;
          var cb = row.querySelector('input[type="checkbox"]'); var nodeId = cb ? cb.id : '';
          if (!nodeId) return;
          pid = nodeId + '-info';
          var lbl = row.querySelector('label'); title = lbl ? lbl.textContent.replace(/\s+/g, ' ').trim() : 'Info';
        }
        setTimeout(function () {
          var html = (window.modal_content_html && window.modal_content_html[pid]) || '';
          var hdr = (window.modal_header_text && window.modal_header_text[pid]) || title;
          openPopupForEdit(pid, hdr, html);
          enableModalEdit(pid);
        }, 70);
      }, true);
    }
    return true;
  }
  function openPopupForEdit(pid, title, html) {   // open the engine modal for editing — idempotent (skips if the engine already opened it, e.g. About)
    var cb = document.getElementById('o');
    if (cb && cb.checked) return;   // already open — keep what the engine put there
    try { window.$('div.modal-header h1').text(title || ''); window.$('div.modal-content').html(html || ''); } catch (e) {}
    var lbl = document.getElementById('open-popup'); if (lbl) lbl.click();
  }
  function enableModalEdit(popupId) {
    var content = document.querySelector('div.modal-content'); var tools = document.getElementById('editor-modal-tools');
    if (!content || !tools) return;
    _editPopupId = popupId; content.setAttribute('contenteditable', 'true'); tools.classList.add('on');
  }
  async function savePopupEdit() {
    var content = document.querySelector('div.modal-content'); if (!content || !_editPopupId) return;
    var html = content.innerHTML; setStatus('Saving…');
    try {
      var cur = await db.from('projects').select('raw_config').eq('id', projectId).single(); var rc = (cur.data && cur.data.raw_config) || {};
      if (_editPopupId === 'about') { rc.about = html; setModalAbout(html); }
      else {
        var title = ''; try { title = (document.querySelector('div.modal-header h1').textContent || '').trim(); } catch (x) {}
        rc.popups = rc.popups || {}; rc.popups[_editPopupId] = { title: title, html: html };
        try { window.modal_content_html = window.modal_content_html || {}; window.modal_header_text = window.modal_header_text || {}; window.modal_content_html[_editPopupId] = html; window.modal_header_text[_editPopupId] = title || 'Info'; } catch (x2) {}
        // persist info_id on the layer/group row so the rendered info button carries this id (viewer + on reload)
        var nodeId = _editPopupId.replace(/-info$/, ''); var node = findNodeById(layers, nodeId);
        if (node) {
          if (node.type === 'group' && node._dbId) { await db.from('layer_groups').update({ info_id: _editPopupId }).eq('id', node._dbId); }
          else if (node.type !== 'group' && node.type !== 'section' && slugToLayerDbId[nodeId]) { await db.from('layers').update({ info_id: _editPopupId }).eq('id', slugToLayerDbId[nodeId]); }
        }
      }
      var r = await db.from('projects').update({ raw_config: rc }).eq('id', projectId); if (r.error) throw new Error(r.error.message);
      setStatus('Saved');
    } catch (e) { setStatus('Save failed'); }
  }
  function injectSettingsPanel() {
    if (document.getElementById('editor-settings-panel')) return;
    var p = document.createElement('div');
    p.id = 'editor-settings-panel';
    p.style.cssText = 'position:fixed;top:130px;left:534px;width:262px;background:#fff;border:1px solid #bbbbbb;border-radius:6px;box-shadow:0 2px 10px rgba(0,0,0,0.18);padding:10px;font-size:13px;z-index:1001;display:none;font-family:Source Sans Pro,Arial,sans-serif;';
    p.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;"><b>Map settings</b><span id="esp-close" style="cursor:pointer;color:#888888;font-size:16px;">&times;</span></div>' +
      '<label style="display:block;font-size:11px;color:#555555;margin-bottom:2px;">Map name</label>' +
      '<input id="esp-name" type="text" style="width:100%;box-sizing:border-box;margin-bottom:10px;padding:5px 6px;border:1px solid #bbbbbb;border-radius:4px;font-size:13px;" />' +
      '<button id="esp-setview" style="width:100%;padding:7px;border:1px solid #bbbbbb;border-radius:4px;background:#f2f2f2;color:#222222;cursor:pointer;font-size:12px;">Set current view as default</button>' +
      '<div id="esp-viewinfo" style="font-size:10px;color:#888888;margin-top:4px;"></div>' +
      '<label style="display:block;font-size:11px;color:#555555;margin:10px 0 2px;">Timeline range</label>' +
      '<div style="display:flex;gap:6px;align-items:center;">' +
        '<input id="esp-tl-start" type="date" style="width:50%;box-sizing:border-box;padding:5px 6px;border:1px solid #bbbbbb;border-radius:4px;font-size:12px;" />' +
        '<span style="color:#888888;font-size:12px;">to</span>' +
        '<input id="esp-tl-end" type="date" style="width:50%;box-sizing:border-box;padding:5px 6px;border:1px solid #bbbbbb;border-radius:4px;font-size:12px;" />' +
      '</div>' +
      '<div style="font-size:10px;color:#888888;margin-top:3px;">Start/end of the bottom timeline slider — type a date or pick one (down to the day).</div>' +
      '<label style="cursor:pointer;font-size:12px;color:#555555;display:block;margin-top:5px;"><input id="esp-tl-today" type="checkbox" style="vertical-align:middle;margin:0 5px 0 0;" />End at today (updates each visit)</label>' +
      '<label style="display:block;font-size:11px;color:#555555;margin:12px 0 2px;border-top:1px solid #eee;padding-top:8px;">Header logo</label>' +
      '<input id="esp-logo-file" type="file" accept="image/*" style="width:100%;box-sizing:border-box;font-size:11px;margin-bottom:8px;" />' +
      '<label style="display:block;font-size:11px;color:#555555;margin-bottom:2px;">Logo link (URL)</label>' +
      '<input id="esp-logo-link" type="text" placeholder="https://…" style="width:100%;box-sizing:border-box;padding:5px 6px;border:1px solid #bbbbbb;border-radius:4px;font-size:13px;" />' +
      '<div style="font-size:10px;color:#888888;margin-top:12px;border-top:1px solid #eee;padding-top:8px;">To edit the <b>About</b> text, click the &#9432; button on the map and edit the popup directly.</div>';
    document.body.appendChild(p);
    document.getElementById('esp-close').addEventListener('click', function () { p.style.display = 'none'; });
    document.getElementById('esp-name').addEventListener('change', onSettingsName);
    document.getElementById('esp-setview').addEventListener('click', onSetDefaultView);
    document.getElementById('esp-tl-start').addEventListener('change', onTimelineSave);
    document.getElementById('esp-tl-end').addEventListener('change', onTimelineSave);
    document.getElementById('esp-tl-today').addEventListener('change', function () { document.getElementById('esp-tl-end').disabled = this.checked; onTimelineSave(); });
    document.getElementById('esp-logo-file').addEventListener('change', onLogoFile);
    document.getElementById('esp-logo-link').addEventListener('change', onLogoLink);
  }
  // Re-init the bottom timeline slider + rulers to a [startYear, endYear] range (the engine reads a static
  // const at load, so we update the live jQuery-UI slider + ruler labels + globals instead).
  function applyTimelineRange(startDate, endDate) {
    try {
      var $ = window.$, m = window.moment; if (!$ || !m || !$('#slider').length) return false;
      var s = m(startDate).unix(), e = (endDate === 'today') ? m().unix() : m(endDate).unix();   // "today" resolves to the current date each load
      if (!s || !e || e <= s) return false;
      var mid = Math.round((s + e) / 2), step = (e - s) / 10;
      try { window.sliderStart = s; window.sliderEnd = e; window.sliderMiddle = mid; } catch (x) {}
      $('#slider').slider('option', { min: s, max: e, value: mid });
      $('#ruler-date1').text(m.unix(s + step).format('YYYY'));
      $('#ruler-date2').text(m.unix(s + step * 3).format('YYYY'));
      $('#ruler-date3').text(m.unix(mid).format('YYYY'));
      $('#ruler-date4').text(m.unix(s + step * 7).format('YYYY'));
      $('#ruler-date5').text(m.unix(s + step * 9).format('YYYY'));
      $('#date').text(m.unix(mid).format('DD MMM YYYY'));
      if (typeof changeDate === 'function') changeDate(mid);
      return true;
    } catch (err) { return false; }
  }
  async function loadProjectChrome() {   // on load, apply per-project chrome (timeline range) once the slider exists
    if (window.__editorChromeLoaded) return; window.__editorChromeLoaded = true;
    try { var r = await db.from('projects').select('raw_config').eq('id', projectId).single(); var rc = (r.data && r.data.raw_config) || {}; setModalAbout(rc.about || ''); applyHeaderChrome(rc); setTimeout(function () { applyHeaderChrome(rc); }, 600); setTimeout(function () { applyHeaderChrome(rc); }, 1500); if (rc.popups) { try { window.modal_content_html = window.modal_content_html || {}; window.modal_header_text = window.modal_header_text || {}; Object.keys(rc.popups).forEach(function (id) { var p = rc.popups[id]; var h = (p && typeof p === 'object') ? p.html : p; var ti = (p && typeof p === 'object') ? p.title : 'Info'; window.modal_content_html[id] = h || ''; window.modal_header_text[id] = ti || 'Info'; }); } catch (x) {} } var tl = rc.timeline; if (tl && tl.start && tl.end) { var tries = 0; var iv = setInterval(function () { if (applyTimelineRange(tl.start, tl.end) || ++tries > 25) clearInterval(iv); }, 400); } } catch (e) {}
  }
  async function onTimelineSave() {
    var sd = document.getElementById('esp-tl-start').value, today = document.getElementById('esp-tl-today').checked, ed = today ? 'today' : document.getElementById('esp-tl-end').value;
    var eUnix = (ed === 'today') ? window.moment().unix() : window.moment(ed).unix();
    if (!sd || (!today && !ed) || eUnix <= window.moment(sd).unix()) { setStatus('Enter a valid start date before the end'); return; }
    setStatus('Saving…');
    try { var cur = await db.from('projects').select('raw_config').eq('id', projectId).single(); var rc = (cur.data && cur.data.raw_config) || {}; rc.timeline = { start: sd, end: ed }; var r = await db.from('projects').update({ raw_config: rc }).eq('id', projectId); if (r.error) throw new Error(r.error.message); applyTimelineRange(sd, ed); setStatus('Timeline range saved'); } catch (e) { setStatus('Save failed'); }
  }
  function fmtView(lat, lng, z) { return (lat != null && lng != null) ? ('Default: ' + Number(lat).toFixed(4) + ', ' + Number(lng).toFixed(4) + ' · z' + (z != null ? Number(z).toFixed(1) : '?')) : 'Default view not set'; }
  async function openSettingsPanel() {
    injectSettingsPanel();
    var p = document.getElementById('editor-settings-panel');
    if (p.style.display === 'block') { p.style.display = 'none'; return; }   // ⚙ toggles
    try { var r = await db.from('projects').select('name, center_lng, center_lat, zoom, raw_config').eq('id', projectId).single(); if (r.data) { document.getElementById('esp-name').value = r.data.name || ''; document.getElementById('esp-viewinfo').textContent = fmtView(r.data.center_lat, r.data.center_lng, r.data.zoom); var tl = r.data.raw_config && r.data.raw_config.timeline; document.getElementById('esp-tl-start').value = (tl && tl.start) || ''; var todayEnd = !!(tl && tl.end === 'today'); document.getElementById('esp-tl-today').checked = todayEnd; document.getElementById('esp-tl-end').disabled = todayEnd; document.getElementById('esp-tl-end').value = todayEnd ? '' : ((tl && tl.end) || ''); document.getElementById('esp-logo-link').value = (r.data.raw_config && r.data.raw_config.headerLink) || ''; } } catch (e) {}
    p.style.display = 'block';
  }
  async function onSettingsName() {
    var name = (document.getElementById('esp-name').value || '').trim(); if (!name) return;
    setStatus('Saving…');
    try { var r = await db.from('projects').update({ name: name }).eq('id', projectId); if (r.error) throw new Error(r.error.message); applyHeaderText(name); setStatus('Map renamed'); } catch (e) { setStatus('Save failed'); }
  }
  // ── Header chrome: text (= map name), logo image, logo link — applied live (no refresh) + on load ──
  function applyHeaderText(name) { try { var el = document.getElementById('header-text-value'); if (el) el.textContent = name; if (name) document.title = name; } catch (e) {} }
  function applyHeaderLogo(dataUrl) { try { if (!dataUrl) return; var img = document.getElementById('logo-img-wide'); if (img) img.src = dataUrl; } catch (e) {} }
  function applyHeaderLink(url) { try { var a = document.getElementById('logo-link'); if (a) a.setAttribute('href', url || ''); } catch (e) {} }
  function applyHeaderChrome(rc) { if (!rc) return; if (rc.headerLogo) applyHeaderLogo(rc.headerLogo); if (rc.headerLink != null) applyHeaderLink(rc.headerLink); }
  function downscaleImage(file, maxW) {   // load → draw to a capped-width canvas → PNG data-URL (keeps raw_config small + transparency)
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        var img = new Image();
        img.onload = function () {
          var scale = Math.min(1, maxW / (img.width || maxW));
          var w = Math.max(1, Math.round(img.width * scale)), h = Math.max(1, Math.round(img.height * scale));
          var canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
          canvas.getContext('2d').drawImage(img, 0, 0, w, h);
          try { resolve(canvas.toDataURL('image/png')); } catch (e) { reject(e); }
        };
        img.onerror = reject; img.src = reader.result;
      };
      reader.onerror = reject; reader.readAsDataURL(file);
    });
  }
  async function onLogoFile() {
    var inp = document.getElementById('esp-logo-file'); var f = inp.files && inp.files[0]; if (!f) return;
    setStatus('Processing image…');
    try {
      var dataUrl = await downscaleImage(f, 600);
      applyHeaderLogo(dataUrl);
      var cur = await db.from('projects').select('raw_config').eq('id', projectId).single(); var rc = (cur.data && cur.data.raw_config) || {};
      rc.headerLogo = dataUrl;
      var r = await db.from('projects').update({ raw_config: rc }).eq('id', projectId); if (r.error) throw new Error(r.error.message);
      setStatus('Logo saved');
    } catch (e) { setStatus('Logo save failed'); }
  }
  async function onLogoLink() {
    var url = (document.getElementById('esp-logo-link').value || '').trim();
    applyHeaderLink(url); setStatus('Saving…');
    try { var cur = await db.from('projects').select('raw_config').eq('id', projectId).single(); var rc = (cur.data && cur.data.raw_config) || {}; rc.headerLink = url; var r = await db.from('projects').update({ raw_config: rc }).eq('id', projectId); if (r.error) throw new Error(r.error.message); setStatus('Logo link saved'); } catch (e) { setStatus('Save failed'); }
  }
  async function onSetDefaultView() {
    if (!beforeMap) return;
    var c = beforeMap.getCenter(), z = beforeMap.getZoom(), b = beforeMap.getBearing();
    setStatus('Saving…');
    try { var r = await db.from('projects').update({ center_lng: c.lng, center_lat: c.lat, zoom: z, bearing: b }).eq('id', projectId); if (r.error) throw new Error(r.error.message); document.getElementById('esp-viewinfo').textContent = fmtView(c.lat, c.lng, z); setStatus('Default view saved'); } catch (e) { setStatus('Save failed'); }
  }
  // ── Maps (basemaps) editing — Slice 1: add / edit (name + mapbox style) / delete + default L/R, persisted
  //    to raw_config.baseMaps and re-rendered live. Maps are mutually exclusive (radio), so: sections yes,
  //    groups no. (Slice 2 = map sections.) ──
  var _mapEditIdx = null;
  var _mapDragIdx = null;
  var _btnEditIdx = null;
  // baseMaps is a top-level `const` in mapData.js → a lexical global, NOT window.baseMaps. Read the bare binding.
  function bmaps() { try { return (typeof baseMaps !== 'undefined' && baseMaps) ? baseMaps : null; } catch (e) { return null; } }
  function msecs() { try { return (typeof mapSections !== 'undefined' && mapSections) ? mapSections : []; } catch (e) { return []; } }
  function bzbtns() { try { return (typeof zoomButtons !== 'undefined' && zoomButtons) ? zoomButtons : []; } catch (e) { return []; } }
  function patchMapsRender() {   // re-enhance after the engine re-renders the maps panel
    if (window.__mapsRenderPatched || typeof window.generateBaseMapsPanel !== 'function') return;
    window.__mapsRenderPatched = true;
    var orig = window.generateBaseMapsPanel;
    window.generateBaseMapsPanel = function () { var r = orig.apply(this, arguments); try { injectMapsChrome(); enhanceMapRows(); } catch (e) {} return r; };
  }
  function injectMapsChrome() {   // an add-bar below the maps list, styled like the layers section's add buttons
    var sec = document.getElementById('base-maps-section'); if (!sec) return;
    if (!document.getElementById('editor-maps-add-style')) {
      var st = document.createElement('style'); st.id = 'editor-maps-add-style';
      st.textContent =
        '#editor-maps-add-bar{padding:6px;margin-top:17px;}' +
        '#editor-maps-add-bar .erow{display:flex;gap:6px;}' +
        '#editor-maps-add-bar button{flex:1;padding:6px 0;border:none;border-radius:4px;cursor:pointer;font-size:12px;font-weight:600;background:#e8e8e8;color:#222222;}' +
        '#editor-maps-add-bar button:hover{background:#d8d8d8;}' +
        '#editor-maps-add-bar input{width:100%;box-sizing:border-box;margin-bottom:6px;padding:5px 6px;border:1px solid #bbbbbb;border-radius:4px;font-size:12px;}' +
        '#base-maps-section .map-section-title{position:relative;}' +
        '#base-maps-section .map-section-title:hover .editor-del{opacity:1;}' +
        '#base-maps-section .map-section-title.editor-drop-into{background:rgba(206,92,0,0.15);box-shadow:inset 0 0 0 1px #ce5c00;}' +
        '#base-maps-section .zoom-btn-row .editor-del{right:12px;}' +
        '#base-maps-section .zoom-btn-row:hover .editor-del{opacity:1;}';   // reveal the × on hover (maps + sections already do this; zoom buttons were missing it → couldn't be deleted)
      document.head.appendChild(st);
    }
    if (document.getElementById('editor-maps-add-bar')) return;
    var bar = document.createElement('div'); bar.id = 'editor-maps-add-bar';
    sec.parentNode.insertBefore(bar, sec.nextSibling);
    restoreMapBar();
  }
  function restoreMapBar() {
    var bar = document.getElementById('editor-maps-add-bar'); if (!bar) return;
    bar.innerHTML = '<div class="erow"><button id="editor-addmap" data-type="map">+ Map</button><button id="editor-addmapsection" data-type="mapsection">+ Section</button><button id="editor-addzbtn" data-type="zbtn">+ Button</button></div>';
    bar.querySelector('#editor-addmap').addEventListener('click', function (e) { e.preventDefault(); addMap(); });
    bar.querySelector('#editor-addmapsection').addEventListener('click', function (e) { e.preventDefault(); showMapSectionForm(); });
    bar.querySelector('#editor-addzbtn').addEventListener('click', function (e) { e.preventDefault(); addZoomButton(); });
  }
  function showMapSectionForm() {   // inline name form, like the layers + Section button
    var bar = document.getElementById('editor-maps-add-bar'); if (!bar) return;
    bar.innerHTML = '<input id="editor-mapsec-name" type="text" placeholder="section name…" /><div class="erow"><button id="editor-mapsec-ok">Add section</button><button id="editor-mapsec-cancel">Cancel</button></div>';
    var input = document.getElementById('editor-mapsec-name'); input.focus();
    function commitSec() { var name = input.value.trim(); restoreMapBar(); addMapSection(name || 'New section'); }
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); commitSec(); } if (e.key === 'Escape') restoreMapBar(); });
    document.getElementById('editor-mapsec-ok').addEventListener('click', commitSec);
    document.getElementById('editor-mapsec-cancel').addEventListener('click', restoreMapBar);
  }
  function enhanceMapRows() {
    var sec = document.getElementById('base-maps-section'); if (!sec) return;
    sec.querySelectorAll('.layer-list-row').forEach(function (row) {
      if (row.getAttribute('data-mapenh')) return;
      row.setAttribute('data-mapenh', '1');
      row.style.position = 'relative';
      var idx = parseInt(row.getAttribute('data-map-idx'), 10); if (isNaN(idx)) return;
      row.addEventListener('click', function (e) {
        if (e.target.closest('input,.layer-buttons-block,.editor-del,.trigger-popup')) return;
        openMapEdit(idx);
      });
      var del = document.createElement('span');
      del.className = 'editor-del'; del.innerHTML = '&times;'; del.title = 'Delete map';
      del.addEventListener('click', function (e) { e.stopPropagation(); e.preventDefault(); deleteMap(idx); });
      row.appendChild(del);
      row.querySelectorAll('input[type="radio"]').forEach(function (rad) {
        rad.onchange = null;   // drop the engine's setupMapSwitching handler — we do the switch + persist here (one setStyle, only on map-radio change)
        rad.addEventListener('change', function () { onMapRadio(idx, rad); });
      });
      // drag a map: reorder before/after another map (adopting its section)
      row.draggable = true;
      row.addEventListener('dragstart', function (e) { _mapDragIdx = idx; if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'; row.classList.add('editor-dragging'); });
      row.addEventListener('dragend', function () { row.classList.remove('editor-dragging'); clearMapDropMarks(); _mapDragIdx = null; });
      row.addEventListener('dragover', function (e) { if (_mapDragIdx == null || _mapDragIdx === idx) return; e.preventDefault(); clearMapDropMarks(); var r = row.getBoundingClientRect(); row.classList.add((e.clientY - r.top) / r.height > 0.5 ? 'editor-drop-after' : 'editor-drop-before'); });
      row.addEventListener('dragleave', function () { row.classList.remove('editor-drop-before', 'editor-drop-after'); });
      row.addEventListener('drop', function (e) { e.preventDefault(); e.stopPropagation(); clearMapDropMarks(); var d = _mapDragIdx; _mapDragIdx = null; if (d == null || d === idx) return; var r = row.getBoundingClientRect(); var pos = (e.clientY - r.top) / r.height > 0.5 ? 'after' : 'before'; if (moveMapToRow(d, idx, pos)) { saveBaseMaps(); rerenderMaps(); } });
    });
    sec.querySelectorAll('.map-section-title').forEach(function (h) {   // section headers: rename (dblclick), delete, drop-into
      if (h.getAttribute('data-mapenh')) return;
      h.setAttribute('data-mapenh', '1'); h.style.cursor = 'pointer';
      var sid = h.getAttribute('data-mapsection');
      var del = document.createElement('span');
      del.className = 'editor-del'; del.innerHTML = '&times;'; del.title = 'Delete section';
      del.addEventListener('click', function (e) { e.stopPropagation(); e.preventDefault(); deleteMapSection(sid); });
      h.appendChild(del);
      h.addEventListener('dblclick', function (e) { e.preventDefault(); renameMapSection(sid); });
      h.addEventListener('dragover', function (e) { if (_mapDragIdx == null) return; e.preventDefault(); clearMapDropMarks(); h.classList.add('editor-drop-into'); });
      h.addEventListener('dragleave', function () { h.classList.remove('editor-drop-into'); });
      h.addEventListener('drop', function (e) { e.preventDefault(); e.stopPropagation(); clearMapDropMarks(); var d = _mapDragIdx; _mapDragIdx = null; if (d == null) return; if (moveMapToSection(d, sid)) { saveBaseMaps(); rerenderMaps(); } });
    });
    sec.querySelectorAll('.zoom-btn-row').forEach(function (row) {   // zoom buttons: click → run action AND open the editor; × → delete
      if (row.getAttribute('data-zbtnenh')) return;
      row.setAttribute('data-zbtnenh', '1'); row.style.position = 'relative';
      var idx = parseInt(row.getAttribute('data-zbtn-idx'), 10); if (isNaN(idx)) return;
      var btnEl = row.querySelector('button'); if (btnEl) btnEl.addEventListener('click', function (e) { openButtonEdit(idx); });   // keep the inline onclick (zoom/link) AND open the editor
      var del = document.createElement('span'); del.className = 'editor-del'; del.innerHTML = '&times;'; del.title = 'Delete button';
      del.addEventListener('click', function (e) { e.stopPropagation(); e.preventDefault(); deleteZoomButton(idx); });
      row.appendChild(del);
    });
  }
  function clearMapDropMarks() {
    var sec = document.getElementById('base-maps-section'); if (!sec) return;
    sec.querySelectorAll('.editor-drop-before,.editor-drop-after,.editor-drop-into').forEach(function (el) { el.classList.remove('editor-drop-before', 'editor-drop-after', 'editor-drop-into'); });
  }
  function moveMapToRow(dragIdx, targetIdx, pos) {   // reorder; adopt the target row's section (undefined = top level)
    var bm = bmaps(); if (!bm) return false; var dragMap = bm[dragIdx], targetMap = bm[targetIdx];
    if (!dragMap || !targetMap || dragMap === targetMap) return false;
    if (targetMap.section) dragMap.section = targetMap.section; else delete dragMap.section;
    bm.splice(dragIdx, 1);
    var nt = bm.indexOf(targetMap);
    bm.splice(nt + (pos === 'after' ? 1 : 0), 0, dragMap);
    return true;
  }
  function moveMapToSection(dragIdx, sid) {   // drop a map onto a section header → joins that section (appended last)
    var bm = bmaps(); if (!bm) return false; var dragMap = bm[dragIdx]; if (!dragMap) return false;
    dragMap.section = sid; bm.splice(dragIdx, 1); bm.push(dragMap);
    return true;
  }
  function onMapRadio(idx, rad) {   // selecting a map's L/R radio sets it as that side's default + switches that side's basemap
    var bm = bmaps(); if (!bm) return;
    var side = rad.name === 'ltoggle' ? 'lChecked' : 'rChecked';
    bm.forEach(function (m, i) { m[side] = (i === idx); });
    saveBaseMaps();
    var user = (typeof siteConfig !== 'undefined' && siteConfig && siteConfig.mapboxUsername) ? siteConfig.mapboxUsername : 'mapbox';
    var map = (rad.name === 'ltoggle') ? beforeMap : afterMap;
    try { if (map && rad.value) map.setStyle('mapbox://styles/' + user + '/' + rad.value); } catch (e) {}
  }
  function injectMapsPanel() {
    if (document.getElementById('editor-maps-panel')) return;
    var p = document.createElement('div'); p.id = 'editor-maps-panel';
    p.style.cssText = 'position:fixed;top:130px;left:534px;width:262px;background:#fff;border:1px solid #bbbbbb;border-radius:6px;box-shadow:0 2px 10px rgba(0,0,0,0.18);padding:10px;font-size:13px;z-index:1001;display:none;font-family:Source Sans Pro,Arial,sans-serif;';
    p.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;"><b style="font-size:13px;">Edit map</b><span id="emp-x" style="cursor:pointer;color:#888888;font-size:16px;">&times;</span></div>' +
      '<label style="display:block;font-size:11px;color:#555555;margin-bottom:2px;">Name</label>' +
      '<input id="emp-name" style="width:100%;box-sizing:border-box;padding:5px 6px;border:1px solid #bbbbbb;border-radius:4px;font-size:13px;margin-bottom:8px;" />' +
      '<label style="display:block;font-size:11px;color:#555555;margin-bottom:2px;">Mapbox style</label>' +
      '<input id="emp-style" style="width:100%;box-sizing:border-box;padding:5px 6px;border:1px solid #bbbbbb;border-radius:4px;font-size:13px;" />' +
      '<div style="font-size:10px;color:#888888;margin-top:3px;">The style id under your Mapbox account (e.g. <code>satellite-v9</code>).</div>' +
      '<label style="display:block;font-size:11px;color:#555555;margin:8px 0 2px;">Section</label>' +
      '<select id="emp-section" style="width:100%;box-sizing:border-box;padding:5px 6px;border:1px solid #bbbbbb;border-radius:4px;font-size:13px;"></select>';
    document.body.appendChild(p);
    document.getElementById('emp-x').addEventListener('click', function () { p.style.display = 'none'; });
    document.getElementById('emp-name').addEventListener('change', onMapEditSave);
    document.getElementById('emp-style').addEventListener('change', onMapEditSave);
    document.getElementById('emp-section').addEventListener('change', onMapEditSave);
  }
  function openMapEdit(idx) {
    injectMapsPanel(); _mapEditIdx = idx;
    var m = (bmaps() || [])[idx]; if (!m) return;
    document.getElementById('emp-name').value = m.name || '';
    document.getElementById('emp-style').value = m.id || '';
    var sel = document.getElementById('emp-section');
    sel.innerHTML = '<option value="">Top level</option>' + msecs().map(function (s) { return '<option value="' + s.id + '"' + (m.section === s.id ? ' selected' : '') + '>' + String(s.name == null ? '' : s.name).replace(/</g, '&lt;') + '</option>'; }).join('');
    document.getElementById('editor-maps-panel').style.display = 'block';
  }
  async function onMapEditSave() {
    var m = (bmaps() || [])[_mapEditIdx]; if (!m) return;
    m.name = document.getElementById('emp-name').value;
    m.id = document.getElementById('emp-style').value;
    var sv = document.getElementById('emp-section').value; if (sv) m.section = sv; else delete m.section;
    await saveBaseMaps(); rerenderMaps();
  }
  async function addMap() {
    var bm = bmaps(); if (!bm) return;
    bm.push({ id: 'streets-v12', name: 'New map', lChecked: false, rChecked: false });
    await saveBaseMaps(); rerenderMaps();
  }
  async function deleteMap(idx) {
    var bm = bmaps(); if (!bm || !bm[idx]) return;
    bm.splice(idx, 1);
    if (document.getElementById('editor-maps-panel')) document.getElementById('editor-maps-panel').style.display = 'none';
    await saveBaseMaps(); rerenderMaps();
  }
  async function addMapSection(name) {
    var secs = msecs(); secs.push({ id: 'msec-' + Math.random().toString(36).slice(2, 8), name: name || 'New section' });
    await saveBaseMaps(); rerenderMaps();
  }
  async function deleteMapSection(sid) {
    var secs = msecs(); var i = secs.findIndex(function (s) { return s.id === sid; }); if (i < 0) return;
    secs.splice(i, 1);
    (bmaps() || []).forEach(function (m) { if (m.section === sid) delete m.section; });   // its maps return to top level
    await saveBaseMaps(); rerenderMaps();
  }
  async function renameMapSection(sid) {
    var secs = msecs(); var s = secs.find(function (x) { return x.id === sid; }); if (!s) return;
    var name = prompt('Section name:', s.name); if (name == null) return;
    s.name = name; await saveBaseMaps(); rerenderMaps();
  }
  // ── Zoom buttons in the maps area: add / edit (label · captured zoom OR url-in-new-tab · section) / delete ──
  async function addZoomButton() {
    var btns = bzbtns(); btns.push({ label: 'New button', icon: 'fa-location-crosshairs' });
    await saveBaseMaps(); rerenderMaps();
  }
  async function deleteZoomButton(idx) {
    var btns = bzbtns(); if (!btns[idx]) return; btns.splice(idx, 1);
    if (document.getElementById('editor-zbtn-panel')) document.getElementById('editor-zbtn-panel').style.display = 'none';
    await saveBaseMaps(); rerenderMaps();
  }
  function injectButtonPanel() {
    if (document.getElementById('editor-zbtn-panel')) return;
    var p = document.createElement('div'); p.id = 'editor-zbtn-panel';
    p.style.cssText = 'position:fixed;top:130px;left:534px;width:262px;background:#fff;border:1px solid #bbbbbb;border-radius:6px;box-shadow:0 2px 10px rgba(0,0,0,0.18);padding:10px;font-size:13px;z-index:1001;display:none;font-family:Source Sans Pro,Arial,sans-serif;';
    p.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;"><b>Edit button</b><span id="ezb-x" style="cursor:pointer;color:#888888;font-size:16px;">&times;</span></div>' +
      '<label style="display:block;font-size:11px;color:#555555;margin-bottom:2px;">Label</label>' +
      '<input id="ezb-label" style="width:100%;box-sizing:border-box;padding:5px 6px;border:1px solid #bbbbbb;border-radius:4px;font-size:13px;margin-bottom:10px;" />' +
      '<label style="display:block;font-size:11px;color:#555555;margin-bottom:3px;">Action</label>' +
      '<div style="display:flex;gap:14px;margin-bottom:8px;font-size:12px;color:#333333;">' +
        '<label style="cursor:pointer;"><input type="radio" name="ezb-mode" value="zoom" style="vertical-align:middle;margin:0 4px 0 0;" />Zoom to a view</label>' +
        '<label style="cursor:pointer;"><input type="radio" name="ezb-mode" value="link" style="vertical-align:middle;margin:0 4px 0 0;" />Open a link</label>' +
      '</div>' +
      '<div id="ezb-zoom-wrap">' +
        '<button id="ezb-setzoom" style="width:100%;padding:7px;border:1px solid #bbbbbb;border-radius:4px;background:#f2f2f2;color:#222222;cursor:pointer;font-size:12px;">Set zoom to current view</button>' +
        '<div id="ezb-zoominfo" style="font-size:10px;color:#888888;margin-top:4px;"></div>' +
      '</div>' +
      '<div id="ezb-link-wrap" style="display:none;">' +
        '<input id="ezb-url" type="text" placeholder="https://…" style="width:100%;box-sizing:border-box;padding:5px 6px;border:1px solid #bbbbbb;border-radius:4px;font-size:13px;" />' +
        '<div style="font-size:10px;color:#888888;margin-top:3px;">Opens in a new tab.</div>' +
      '</div>' +
      '<label style="display:block;font-size:11px;color:#555555;margin:10px 0 2px;">Section</label>' +
      '<select id="ezb-section" style="width:100%;box-sizing:border-box;padding:5px 6px;border:1px solid #bbbbbb;border-radius:4px;font-size:13px;"></select>';
    document.body.appendChild(p);
    document.getElementById('ezb-x').addEventListener('click', function () { p.style.display = 'none'; });
    document.getElementById('ezb-label').addEventListener('change', onButtonEditSave);
    document.getElementById('ezb-url').addEventListener('change', onButtonEditSave);
    document.getElementById('ezb-section').addEventListener('change', onButtonEditSave);
    document.getElementById('ezb-setzoom').addEventListener('click', captureButtonZoom);
    Array.prototype.forEach.call(p.querySelectorAll('input[name="ezb-mode"]'), function (r) { r.addEventListener('change', onModeChange); });
  }
  function applyMode(mode) {   // show only the chosen action's controls
    var z = document.getElementById('ezb-zoom-wrap'), l = document.getElementById('ezb-link-wrap');
    if (z) z.style.display = (mode === 'link') ? 'none' : 'block';
    if (l) l.style.display = (mode === 'link') ? 'block' : 'none';
  }
  async function onModeChange() {   // switching the toggle clears the other action's data (only one or the other)
    var sel = document.querySelector('input[name="ezb-mode"]:checked'); var mode = sel ? sel.value : 'zoom';
    applyMode(mode);
    var b = bzbtns()[_btnEditIdx]; if (!b) return;
    if (mode === 'link') { delete b.zoomCenter; delete b.zoomLevel; delete b.target; document.getElementById('ezb-zoominfo').textContent = fmtZoom(b); }
    else { delete b.url; document.getElementById('ezb-url').value = ''; }
    await saveBaseMaps(); rerenderMaps();
  }
  function fmtZoom(b) { return (b && b.zoomCenter) ? ('Zoom: ' + Number(b.zoomCenter[1]).toFixed(4) + ', ' + Number(b.zoomCenter[0]).toFixed(4) + ' · z' + (b.zoomLevel != null ? Number(b.zoomLevel).toFixed(1) : '?')) : 'Zoom not set'; }
  function openButtonEdit(idx) {
    injectButtonPanel(); _btnEditIdx = idx;
    var b = bzbtns()[idx]; if (!b) return;
    document.getElementById('ezb-label').value = b.label || '';
    document.getElementById('ezb-url').value = b.url || '';
    document.getElementById('ezb-zoominfo').textContent = fmtZoom(b);
    var mode = b.url ? 'link' : 'zoom';
    Array.prototype.forEach.call(document.querySelectorAll('input[name="ezb-mode"]'), function (r) { r.checked = (r.value === mode); });
    applyMode(mode);
    var sel = document.getElementById('ezb-section');
    sel.innerHTML = '<option value="">Top level</option>' + msecs().map(function (s) { return '<option value="' + s.id + '"' + (b.section === s.id ? ' selected' : '') + '>' + String(s.name == null ? '' : s.name).replace(/</g, '&lt;') + '</option>'; }).join('');
    document.getElementById('editor-zbtn-panel').style.display = 'block';
  }
  async function onButtonEditSave() {
    var b = bzbtns()[_btnEditIdx]; if (!b) return;
    b.label = document.getElementById('ezb-label').value;
    var sv = document.getElementById('ezb-section').value; if (sv) b.section = sv; else delete b.section;
    var modeSel = document.querySelector('input[name="ezb-mode"]:checked'); var mode = modeSel ? modeSel.value : 'zoom';
    if (mode === 'link') { var u = (document.getElementById('ezb-url').value || '').trim(); if (u) b.url = u; else delete b.url; delete b.zoomCenter; delete b.zoomLevel; delete b.target; }
    else { delete b.url; }
    await saveBaseMaps(); rerenderMaps();
  }
  async function captureButtonZoom() {
    var b = bzbtns()[_btnEditIdx]; if (!b || !beforeMap) return;
    var c = beforeMap.getCenter(); b.zoomCenter = [c.lng, c.lat]; b.zoomLevel = beforeMap.getZoom(); delete b.url;   // capturing a view = zoom mode
    document.getElementById('ezb-zoominfo').textContent = fmtZoom(b);
    await saveBaseMaps(); setStatus('Zoom set — the button now flies here');
  }
  async function saveBaseMaps() {
    setStatus('Saving…');
    try { var cur = await db.from('projects').select('raw_config').eq('id', projectId).single(); var rc = (cur.data && cur.data.raw_config) || {}; rc.baseMaps = bmaps(); rc.mapSections = msecs(); rc.zoomButtons = bzbtns(); var r = await db.from('projects').update({ raw_config: rc }).eq('id', projectId); if (r.error) throw new Error(r.error.message); setStatus('Saved'); } catch (e) { setStatus('Save failed'); }
  }
  function rerenderMaps() {   // re-render the panel only; do NOT re-run setupMapSwitching (it setStyles both maps → wipes layers). enhanceMapRows re-wires the radios.
    try { if (typeof window.generateBaseMapsPanel === 'function') window.generateBaseMapsPanel(); } catch (e) {}
  }
  function injectChrome() {
    var panel = document.getElementById('layers-panel-content');
    if (!panel || document.getElementById('editor-add-bar')) return;
    var style = document.createElement('style');
    style.textContent =
      '#editor-add-bar{padding:6px;}' +
      '#editor-add-bar .erow{display:flex;gap:6px;}' +
      '#editor-add-bar button{flex:1;padding:6px 0;border:none;border-radius:4px;cursor:pointer;font-size:12px;font-weight:600;background:#e8e8e8;color:#222222;}' +
      '#editor-add-bar button:hover{background:#d8d8d8;}' +
      '#editor-add-bar input,#editor-add-bar select{width:100%;box-sizing:border-box;margin-bottom:6px;padding:5px 6px;border:1px solid #bbbbbb;border-radius:4px;font-size:12px;}' +
      '#editor-save-status{font-size:11px;color:#888888;padding:2px 6px;min-height:13px;}' +
      '.layer-list-row{position:relative;}' +
      '.editor-del{position:absolute;right:44px;top:50%;transform:translateY(-50%);opacity:0;cursor:pointer;color:#888888;font-size:15px;font-weight:bold;line-height:1;padding:0 3px;z-index:2;}' +
      '.layer-list-row:hover .editor-del{opacity:1;}' +
      '.editor-del:hover{color:#c0392b;}' +
      '.editor-setzoom{position:absolute;right:64px;top:50%;transform:translateY(-50%);opacity:0;cursor:pointer;color:#888888;font-size:14px;line-height:1;padding:0 3px;z-index:2;}' +
      '.layer-list-row:hover .editor-setzoom{opacity:1;}' +
      '.editor-setzoom:hover{color:#ce5c00;}' +
      '.layer-list-row.editor-dragging{opacity:0.4;}' +
      '.layer-list-row.editor-drop-before{box-shadow:inset 0 2px 0 #ce5c00;}' +
      '.layer-list-row.editor-drop-after{box-shadow:inset 0 -2px 0 #ce5c00;}' +
      '.layer-list-row.editor-drop-into{background:rgba(206,92,0,0.15);box-shadow:inset 0 0 0 1px #ce5c00;}' +
      '.layer-list-row.editor-active{background:rgba(206,92,0,0.12);}' +
      // draw toolbar: float on the LEFT just past the 325px layers sidebar (was top-right, hidden under the right swipe map)
      '#before .mapboxgl-ctrl-top-left{left:400px;z-index:50;}' +
      '#editor-map-tools{position:fixed;top:92px;left:534px;z-index:50;display:flex;gap:3px;padding:3px;background:rgba(255,255,255,0.96);border-radius:4px;box-shadow:0 1px 3px rgba(0,0,0,0.3);pointer-events:auto;width:max-content;}' +
      '#editor-map-tools button{width:29px;height:29px;border:1px solid #bbbbbb;border-radius:4px;background:#fff;color:#222222;cursor:pointer;font-size:14px;line-height:1;padding:0;}' +
      '#editor-map-tools button:disabled{opacity:0.4;cursor:default;}' +
      '#editor-map-tools button:not(:disabled):hover{background:#e8e8e8;}' +
      '#editor-map-tools button.active{background:#ce5c00;color:#fff;border-color:#ce5c00;}' +
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
      '<button id="editor-split" title="Split a polygon or line — select one, then draw a line across it">✂</button>' +
      '<button id="editor-settings" title="Map settings — name + default view">⚙</button>';
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
    document.getElementById('editor-settings').addEventListener('click', openSettingsPanel);
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
    { id: 'gl-draw-polygon-fill-active', type: 'fill', filter: ['all', ['==', 'active', 'true'], ['==', '$type', 'Polygon']], paint: { 'fill-color': '#fbb03b', 'fill-outline-color': '#fbb03b', 'fill-opacity': 0.55 } },
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
    if (node && node.type !== 'section') showLayerPanel(id); else hideLayerPanel();   // every layer + group opens the panel; groups/basemap tilesets get attr/source/zoom (no style)
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
    beforeMap.on('draw.render', scheduleMirrorSync);   // mirror the MapboxDraw contents onto the right swipe side (both-sides display)
    try { if (typeof afterMap !== 'undefined' && afterMap) afterMap.once('idle', syncMirrorRight); } catch (e) {}   // initial paint once the right map is ready
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
    var EBg = _engineEditNode[drawId] ? getEditBackend(_engineEditNode[drawId]) : PLATFORM_FEATURES;   // Phase 2a
    if (fid) { try { var gpatch = {}; gpatch[EBg.geomCol] = toDbGeom(drawId, geom); await EBg.db.from(EBg.table).update(gpatch).eq(EBg.idCol, fid); } catch (e) {} }
    try { var f = draw && draw.get(drawId); var props = f ? f.properties : {}; _suppressFeatureDelete = true; if (f) draw.delete(drawId); if (draw) draw.add({ type: 'Feature', id: drawId, geometry: geom, properties: props }); setTimeout(function () { _suppressFeatureDelete = false; }, 0); } catch (e) {}
    _geomSnap[drawId] = JSON.parse(JSON.stringify(geom));
  }

  // Faithful per-feature delete (feature panel + attribute table). Captures each full DB row up front so
  // undo restores label/dates/custom_fields too — unlike the trash button, whose undo restores only geometry.
  async function deleteDrawnByFids(fids, label) {
    fids = (fids || []).map(String);
    if (!fids.length) return 0;
    var rows = [];
    try { var res = await db.from('features').select('feature_id, layer_id, geom, label, description, start_date, end_date, custom_fields').in('feature_id', fids); rows = res.data || []; } catch (e) {}
    if (!rows.length) return 0;
    var cap = rows.map(function (r) {
      var drawId = 'db-' + r.feature_id, f = draw && draw.get(drawId);
      return { drawId: drawId, lyr: r.layer_id, geom: r.geom, props: f ? JSON.parse(JSON.stringify(f.properties || {})) : {}, label: r.label, description: r.description, start_date: r.start_date, end_date: r.end_date, custom_fields: r.custom_fields };
    });
    _suppressFeatureDelete = true;   // remove the MapboxDraw copies without re-triggering onDrawDelete
    cap.forEach(function (c) { try { if (draw && draw.get(c.drawId)) draw.delete(c.drawId); } catch (e) {} });
    setTimeout(function () { _suppressFeatureDelete = false; }, 0);
    try { await db.from('features').delete().in('feature_id', fids); } catch (e) { setStatus('Delete failed'); return 0; }
    cap.forEach(function (c) { delete featureToDb[c.drawId]; delete featureMeta[c.drawId]; delete featureLayer[c.drawId]; delete _geomSnap[c.drawId]; });
    pushUndo(function () { return reinsertDrawn(cap); }, function () { return removeDrawnBatch(cap); }, label || ('delete ' + cap.length + ' feature' + (cap.length > 1 ? 's' : '')));
    return cap.length;
  }
  async function reinsertDrawn(cap) {   // undo: re-insert each captured row (new feature_id) + restore in MapboxDraw
    for (var i = 0; i < cap.length; i++) {
      var c = cap[i];
      try {
        var ins = await db.from('features').insert({ layer_id: c.lyr, geom: c.geom, label: c.label, description: c.description, start_date: c.start_date, end_date: c.end_date, custom_fields: c.custom_fields }).select('feature_id').single();
        if (!ins.error) {
          featureToDb[c.drawId] = ins.data.feature_id; featureLayer[c.drawId] = c.lyr;
          featureMeta[c.drawId] = { label: c.label || '', notes: c.description || '', start: c.start_date ? String(c.start_date).slice(0, 10) : '', end: c.end_date ? String(c.end_date).slice(0, 10) : '' };
          try { if (draw && !draw.get(c.drawId)) draw.add({ type: 'Feature', id: c.drawId, geometry: c.geom, properties: c.props || {} }); } catch (e) {}
          _geomSnap[c.drawId] = JSON.parse(JSON.stringify(c.geom));
        }
      } catch (e) {}
    }
  }
  async function removeDrawnBatch(cap) { for (var i = 0; i < cap.length; i++) { await removeDrawnFeature(cap[i].drawId); } }

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
      var saveGeom = toDbGeom(f.id, f.geometry); if (_engineWasMulti[f.id]) _engineOrigMulti[f.id] = saveGeom;
      var EBu = _engineEditNode[f.id] ? getEditBackend(_engineEditNode[f.id]) : PLATFORM_FEATURES;   // Phase 2a: tileset edits → the layer's backend; drawn → platform features
      var upatch = {}; upatch[EBu.geomCol] = saveGeom;
      try { await EBu.db.from(EBu.table).update(upatch).eq(EBu.idCol, fid); } catch (err) { console.warn('feature update failed', err); }
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
    wireEngineEditClicks(); try { if (beforeMap) beforeMap.once('idle', wireEngineEditClicks); } catch (e) {}   // BEFORE the early-return below, so tileset-only / large-layer-only projects still get click→edit
    if (!smallIds.length) { try { draw.set({ type: 'FeatureCollection', features: [] }); } catch (e) {} return; }
    try {
      var rows = [];
      for (var from = 0; from < 200000; from += 1000) {
        var res = await db.from('features').select('feature_id, layer_id, geom, label, description, start_date, end_date, content_id, custom_fields').in('layer_id', smallIds).order('feature_id').range(from, from + 999);
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
        featureMeta[did] = { label: row.label || '', notes: row.description || '', start: row.start_date ? String(row.start_date).slice(0, 10) : '', end: row.end_date ? String(row.end_date).slice(0, 10) : '', pageid: row.content_id != null ? String(row.content_id) : '', image_url: (row.custom_fields && row.custom_fields.image_url) || '' };
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
      syncMirrorRight();   // show the loaded drawn features on the right swipe side too
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

  // ── Both-sides display: everything being edited lives in the LEFT MapboxDraw (drawn features AND a
  //    clicked building pulled into edit), so the engine shows it on the left only. Mirror the whole
  //    MapboxDraw contents onto a RIGHT-side overlay (afterMap), styled to match DRAW_STYLES' inactive
  //    paint via the same per-feature props — so saved draws/edits and in-edit buildings show on the right
  //    too. It tracks draw.getAll(), so the right always matches the left by construction. ──
  var MIRROR_SRC = 'editor-draw-mirror-right';
  function ensureMirrorRight() {
    if (typeof afterMap === 'undefined' || !afterMap) return false;
    try {
      if (afterMap.getSource(MIRROR_SRC)) return true;
      if (afterMap.isStyleLoaded && !afterMap.isStyleLoaded()) return false;   // retry on the next draw.render
      var C  = ['coalesce', ['get', 'color'], '#3bb2d0'];                       // mirrors DRAW_STYLES COLOR (user_* → plain props)
      var OF = ['coalesce', ['get', 'outline'], C];                            // OUTLINE_FILL: polygon outline → fill colour
      var OP = ['coalesce', ['get', 'opacity'], 1];                            // STROKE_OPACITY: line/point opacity, default 1
      var SW = ['coalesce', ['get', 'strokewidth'], 2];                        // STROKE_WIDTH
      afterMap.addSource(MIRROR_SRC, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      afterMap.addLayer({ id: MIRROR_SRC + '-fill', type: 'fill', source: MIRROR_SRC, filter: ['==', '$type', 'Polygon'],
        paint: { 'fill-color': C, 'fill-outline-color': OF, 'fill-opacity': ['coalesce', ['get', 'opacity'], 0.35] } });
      afterMap.addLayer({ id: MIRROR_SRC + '-poly-stroke', type: 'line', source: MIRROR_SRC, filter: ['==', '$type', 'Polygon'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': OF, 'line-width': SW, 'line-opacity': ['coalesce', ['get', 'strokeopacity'], 1] } });
      afterMap.addLayer({ id: MIRROR_SRC + '-line', type: 'line', source: MIRROR_SRC, filter: ['==', '$type', 'LineString'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': C, 'line-width': SW, 'line-opacity': OP } });
      afterMap.addLayer({ id: MIRROR_SRC + '-point', type: 'circle', source: MIRROR_SRC, filter: ['==', '$type', 'Point'],
        paint: { 'circle-color': C, 'circle-radius': ['coalesce', ['get', 'radius'], 5], 'circle-stroke-width': ['coalesce', ['get', 'strokewidth'], 1.5], 'circle-stroke-color': ['coalesce', ['get', 'outline'], '#000'], 'circle-opacity': OP } });
      return true;
    } catch (e) { return false; }
  }
  function syncMirrorRight() {
    try { if (!draw || !ensureMirrorRight()) return; var src = afterMap.getSource(MIRROR_SRC); if (src) src.setData(draw.getAll()); } catch (e) {}
  }
  var _mirrorTimer = null;
  function scheduleMirrorSync() {   // coalesce the many draw.render ticks during a drag into one setData
    if (_mirrorTimer) return;
    _mirrorTimer = setTimeout(function () { _mirrorTimer = null; syncMirrorRight(); }, 120);
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
    p.style.cssText = 'position:fixed;top:120px;right:12px;width:240px;background:#fff;border:1px solid #bbbbbb;border-radius:6px;box-shadow:0 2px 10px rgba(0,0,0,0.18);padding:10px;font-size:13px;z-index:1000;display:none;font-family:Source Sans Pro,Arial,sans-serif;';
    p.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;"><b>Feature</b><span id="efp-close" style="cursor:pointer;color:#888888;font-size:16px;">&times;</span></div>' +
      '<label style="display:block;font-size:11px;color:#555555;margin-bottom:2px;">Label</label>' +
      '<input id="efp-label" type="text" style="width:100%;box-sizing:border-box;margin-bottom:8px;padding:5px 6px;border:1px solid #bbbbbb;border-radius:4px;font-size:13px;" />' +
      '<label style="display:block;font-size:11px;color:#555555;margin-bottom:2px;">Notes</label>' +
      '<div id="efp-notes-tools" style="display:flex;gap:3px;margin-bottom:3px;flex-wrap:wrap;">' +
        '<button type="button" data-cmd="bold" title="Bold" style="min-width:24px;height:22px;border:1px solid #bbb;border-radius:3px;background:#fff;cursor:pointer;font-weight:bold;font-size:11px;line-height:1;">B</button>' +
        '<button type="button" data-cmd="italic" title="Italic" style="min-width:24px;height:22px;border:1px solid #bbb;border-radius:3px;background:#fff;cursor:pointer;font-style:italic;font-size:11px;line-height:1;">I</button>' +
        '<button type="button" data-cmd="underline" title="Underline" style="min-width:24px;height:22px;border:1px solid #bbb;border-radius:3px;background:#fff;cursor:pointer;text-decoration:underline;font-size:11px;line-height:1;">U</button>' +
        '<button type="button" data-cmd="insertUnorderedList" title="Bullet list" style="min-width:24px;height:22px;border:1px solid #bbb;border-radius:3px;background:#fff;cursor:pointer;font-size:11px;line-height:1;">&bull;</button>' +
        '<button type="button" data-cmd="createLink" title="Insert link" style="min-width:24px;height:22px;border:1px solid #bbb;border-radius:3px;background:#fff;cursor:pointer;font-size:11px;line-height:1;">&#128279;</button>' +
        '<button type="button" data-cmd="removeFormat" title="Clear formatting" style="min-width:24px;height:22px;border:1px solid #bbb;border-radius:3px;background:#fff;cursor:pointer;font-size:11px;line-height:1;">&times;A</button>' +
      '</div>' +
      '<div id="efp-notes" contenteditable="true" style="width:100%;box-sizing:border-box;margin-bottom:8px;padding:5px 6px;border:1px solid #bbbbbb;border-radius:4px;font-size:13px;min-height:54px;max-height:160px;overflow:auto;background:#fff;"></div>' +
      '<label style="display:block;font-size:11px;color:#555555;margin-bottom:2px;">Image</label>' +
      '<input id="efp-image" type="text" placeholder="https://…/photo.jpg" style="width:100%;box-sizing:border-box;margin-bottom:4px;padding:5px 6px;border:1px solid #bbbbbb;border-radius:4px;font-size:12px;" />' +
      '<div style="display:flex;gap:6px;align-items:center;margin-bottom:6px;"><button id="efp-image-upload" type="button" style="flex:0 0 auto;padding:4px 8px;border:1px solid #bbbbbb;border-radius:4px;background:#e8e8e8;color:#222222;cursor:pointer;font-size:11px;">Upload…</button><span id="efp-image-status" style="font-size:10px;color:#888888;"></span></div>' +
      '<img id="efp-image-preview" alt="" style="display:none;max-width:100%;max-height:90px;border-radius:4px;margin-bottom:8px;border:1px solid #e0e0e0;" />' +
      '<input id="efp-image-file" type="file" accept="image/*" style="display:none;" />' +
      '<div style="display:flex;gap:8px;">' +
        '<div style="flex:1;"><label style="display:block;font-size:11px;color:#555555;margin-bottom:2px;">Start date</label>' +
        '<input id="efp-start" type="date" style="width:100%;box-sizing:border-box;padding:4px 5px;border:1px solid #bbbbbb;border-radius:4px;font-size:12px;" /></div>' +
        '<div style="flex:1;"><label style="display:block;font-size:11px;color:#555555;margin-bottom:2px;">End date</label>' +
        '<input id="efp-end" type="date" style="width:100%;box-sizing:border-box;padding:4px 5px;border:1px solid #bbbbbb;border-radius:4px;font-size:12px;" /></div>' +
      '</div>' +
      '<div style="font-size:10px;color:#888888;margin-top:4px;">Blank = always visible on the timeline.</div>' +
      '<div id="efp-page-row" style="display:none;margin-top:8px;"><label style="display:block;font-size:11px;color:#555555;margin-bottom:2px;">Encyclopedia page ID</label>' +
      '<input id="efp-pageid" type="text" placeholder="e.g. 42" style="width:100%;box-sizing:border-box;padding:5px 6px;border:1px solid #bbbbbb;border-radius:4px;font-size:13px;" /></div>' +
      '<button id="efp-done" style="margin-top:10px;width:100%;padding:7px;border:1px solid #a3c293;border-radius:4px;background:#eafaea;color:#2d7a2d;font-weight:600;cursor:pointer;font-size:12px;display:none;">✓ Done editing</button>' +
      '<button id="efp-delete" style="margin-top:8px;width:100%;padding:6px;border:1px solid #e0b4b4;border-radius:4px;background:#fdeaea;color:#b4453a;cursor:pointer;font-size:12px;">Delete feature</button>';
    document.body.appendChild(p);
    document.getElementById('efp-close').addEventListener('click', function () { if (draw) draw.changeMode('simple_select'); hideFeaturePanel(); });
    document.getElementById('efp-pageid').addEventListener('input', function () { onFeatureField('pageid', this.value); });
    document.getElementById('efp-delete').addEventListener('click', onDeleteFeature);
    document.getElementById('efp-done').addEventListener('click', function () { var n = _engineEditNode[selectedDrawId]; if (n) finishEngineEdit(n, featureToDb[selectedDrawId]); });
    document.getElementById('efp-label').addEventListener('input', function () { onFeatureField('label', this.value); });
    var efpNotes = document.getElementById('efp-notes');
    efpNotes.addEventListener('input', function () { onFeatureField('notes', this.innerHTML); });   // contenteditable → store HTML (WYSIWYG)
    Array.prototype.forEach.call(document.querySelectorAll('#efp-notes-tools button[data-cmd]'), function (b) {
      b.addEventListener('mousedown', function (e) { e.preventDefault(); });   // keep the caret/selection inside efp-notes
      b.addEventListener('click', function (e) {
        e.preventDefault(); efpNotes.focus();
        var cmd = b.getAttribute('data-cmd'), val;
        if (cmd === 'createLink') { val = prompt('Link URL:'); if (!val) return; }
        try { document.execCommand(cmd, false, val || undefined); } catch (err) {}
        onFeatureField('notes', efpNotes.innerHTML);   // persist the formatting change
      });
    });
    document.getElementById('efp-image').addEventListener('input', function () { onFeatureField('image_url', this.value); updateImagePreview(this.value); });
    document.getElementById('efp-image-upload').addEventListener('click', function () { document.getElementById('efp-image-file').click(); });
    document.getElementById('efp-image-file').addEventListener('change', function () { if (this.files && this.files[0]) uploadFeatureImage(this.files[0]); this.value = ''; });
    document.getElementById('efp-start').addEventListener('change', function () { onFeatureField('start', this.value); });
    document.getElementById('efp-end').addEventListener('change', function () { onFeatureField('end', this.value); });
  }
  function showFeaturePanel(drawId) {
    selectedDrawId = drawId;
    injectFeaturePanel();
    var meta = featureMeta[drawId] || { label: '', notes: '', start: '', end: '' };
    var p = document.getElementById('editor-feature-panel'); if (!p) return;
    document.getElementById('efp-label').value = meta.label || '';
    document.getElementById('efp-notes').innerHTML = meta.notes || '';
    document.getElementById('efp-start').value = meta.start || '';
    document.getElementById('efp-end').value = meta.end || '';
    document.getElementById('efp-pageid').value = meta.pageid || '';
    if (meta.image_url == null && typeof draw !== 'undefined' && draw && draw.get) { try { var _df = draw.get(drawId); if (_df && _df.properties && _df.properties.image_url != null) meta.image_url = _df.properties.image_url; } catch (e) {} }   // recover the saved image from the draw feature's props
    document.getElementById('efp-image').value = meta.image_url || '';
    document.getElementById('efp-image-status').textContent = '';
    updateImagePreview(meta.image_url || '');
    var lnode = featureLayer[drawId] ? nodeByLayerDbId(featureLayer[drawId]) : null;   // Page ID + encyclopedia preview only when the layer links to an encyclopedia
    var hasEnc = !!(lnode && lnode.panel && lnode.panel.encyclopediaBase);
    var pmode = (lnode && lnode.panel) ? (lnode.panel.mode || (hasEnc ? 'drupal' : 'notes')) : null;
    document.getElementById('efp-page-row').style.display = (pmode === 'drupal' || pmode === 'both') ? 'block' : 'none';
    var encProps = (hasEnc && meta.pageid) ? (function () { var ep = { name: meta.label || '' }; ep[(lnode.panel && lnode.panel.nidProp) || 'content_id'] = meta.pageid; return ep; })() : null;
    if (pmode === 'notes') showNotesPreview(lnode, { label: meta.label, notes: meta.notes, image_url: meta.image_url });
    else if (pmode === 'drupal') { if (encProps) showEncyclopediaPreview(lnode, encProps); else hideEncPanel(); }
    else if (pmode === 'both') { showNotesPreview(lnode, { label: meta.label, notes: meta.notes, image_url: meta.image_url }); if (encProps) showEncyclopediaPreview(lnode, encProps, true); }   // title+notes, then append the Drupal page
    else hideEncPanel();
    document.getElementById('efp-done').style.display = _engineEditNode[drawId] ? 'block' : 'none';   // engine-edited (tileset/large) features get a clean "Done editing" → overlay fold-back
    p.style.display = 'block';
  }
  function hideFeaturePanel() {
    selectedDrawId = null;
    var p = document.getElementById('editor-feature-panel'); if (p) p.style.display = 'none';
    hideEncPanel();
  }
  async function onDeleteFeature() {
    var did = selectedDrawId; if (!did) return;
    var fid = featureToDb[did];
    try { if (draw) draw.changeMode('simple_select'); } catch (e) {}
    hideFeaturePanel();
    if (!fid) { try { if (draw && draw.get(did)) draw.delete(did); } catch (e) {} return; }   // never-saved feature: just drop it
    var n = await deleteDrawnByFids([fid], 'delete feature');
    if (_attrSlug) { delete _attrById[String(fid)]; _attrRows = _attrRows.filter(function (r) { return String(r.feature_id) !== String(fid); }); _attrSel = _attrSel.filter(function (s) { return s !== String(fid); }); if (document.getElementById('editor-attr-modal') && document.getElementById('editor-attr-modal').style.display !== 'none') { buildAttrHead(); renderAttrBody(); } }   // keep an open table in sync
    setStatus(n ? 'Feature deleted' : 'Delete failed');
  }
  // ── encyclopedia info panel (editor): renders into the engine's REAL #rightInfoBar / .infoLayerElem so the
  //    styling is pixel-identical to the AHM/MHT panel. We drive the fetch + render ourselves (not the engine's
  //    fetchAndRender) only to skip setPanelHighlight — drawn layers have no `-highlighted` source. The editor's
  //    feature panel shifts left so it never covers the info panel (move the chrome, not the panel). ──
  function ensureEncPanelDiv(node) {
    var $ = window.$, divId = 'infoPanel-' + node.id;
    if (document.getElementById(divId)) return divId;   // engine setupInfoPanels may already have made it
    if (!$ || !document.getElementById('rightInfoBar')) return null;
    $('<div>').addClass('infoLayerElem').attr('id', divId).appendTo('#rightInfoBar');
    var color = (node.panel && node.panel.color) || node.iconColor || '#3bb2d0';   // AHM panels colour their border/bg from panel.color
    $('<style>').text('#' + divId + '{background-color:' + (typeof hexToRgba === 'function' ? hexToRgba(color, 0.5) : '#fff') + ';border-color:' + color + ';}').appendTo('head');
    return divId;
  }
  function shiftFeaturePanelForEnc(on) {   // keep the editing chrome clear of the right-edge info panel (~274px)
    var p = document.getElementById('editor-feature-panel'); if (p) p.style.right = on ? '290px' : '12px';
  }
  function makeEncFieldExtractor(docEl) {   // mirrors the engine's field extractor (infoPanel.js) so panel.render works the same
    var $ = window.$; if (!$) return function () { return docEl.innerHTML; };
    var $doc = $(docEl), $titleLink = $doc.find('h2.node__title a'), titleHref = $titleLink.attr('href') || '', titleText = $titleLink.text().trim() || '';
    $titleLink.closest('h2').hide();
    return function (name, mode) {
      if (!name) return $doc.html();
      if (name === 'node-url') return titleHref;
      if (name === 'node-title') return titleText;
      if (name === 'all-images') return $doc.find('img').map(function () { return this.outerHTML; }).get().join('');
      if (mode === 'hero') { var $field = $doc.find('.field--name-' + name); var img = $field.find('img').first().prop('outerHTML') || ''; $field.remove(); return img; }
      var $items = $doc.find('.field--name-' + name + ' .field__item');
      if (!$items.length) $items = $doc.find('.field--name-' + name + '.field__item');
      if (mode === 'html') return $items.first().html() || '';
      if (mode === 'imgs') return $items.find('img').map(function () { return this.outerHTML; }).get().join('');
      return $items.first().text().trim();
    };
  }
  var _encReq = 0;
  async function showEncyclopediaPreview(node, props, append) {   // append=true → "both" mode: add the Drupal page BELOW the title+notes already rendered
    var base = node && node.panel && node.panel.encyclopediaBase, nidProp = (node.panel && node.panel.nidProp) || 'content_id', nid = props[nidProp];
    if (!base || nid == null || nid === '') return;
    var $ = window.$, divId = ensureEncPanelDiv(node); if (!divId || !$) return;
    var $el = $('#' + divId), req = ++_encReq;
    if (!append) {
      Array.prototype.forEach.call(document.querySelectorAll('#rightInfoBar .infoLayerElem'), function (el) { if (el.id !== divId) el.style.display = 'none'; });   // one panel at a time
      $el.html('<p>Loading page…</p>').show();
    }
    shiftFeaturePanelForEnc(true);
    var data;
    try { data = await fetch(base.replace(/\/$/, '') + '/rendered-export-single?nid=' + encodeURIComponent(nid)).then(function (r) { return r.json(); }); }
    catch (e) { if (!append && req === _encReq) $el.html('<p>Could not load the page (network/CORS).</p>'); return; }
    if (req !== _encReq) return;   // superseded by a newer selection
    if (!data || !data[0] || !data[0].rendered_entity) { if (!append) $el.html('<p>No encyclopedia entry for id &ldquo;' + attrEsc(String(nid)) + '&rdquo;.</p>'); return; }
    var html = (typeof processEncyclopediaHtml === 'function') ? processEncyclopediaHtml(data[0].rendered_entity, base) : data[0].rendered_entity;
    var docEl = document.createElement('div'); docEl.innerHTML = html;
    var f = makeEncFieldExtractor(docEl), renderFn = (node.panel && node.panel.render) || function (_p, ff) { return ff(); };
    try { if (append) $el.append('<hr class="panel-both-sep"/>' + renderFn(props, f)); else $el.html(renderFn(props, f)); } catch (e) { if (!append) $el.html(docEl.innerHTML); }
    if (!append && typeof floatPanelToTop === 'function') { try { floatPanelToTop(divId); } catch (e) {} }
    $el.show();
  }
  function hideEncPanel() {
    Array.prototype.forEach.call(document.querySelectorAll('#rightInfoBar .infoLayerElem[id^="infoPanel-"]'), function (el) { el.style.display = 'none'; });
    shiftFeaturePanelForEnc(false);
  }
  // Notes mode (no encyclopedia): render the feature's OWN title+notes into the SAME #rightInfoBar panel +
  // chrome as the encyclopedia preview, so the editor shows exactly what the live viewer shows. No fetch.
  function showNotesPreview(node, props) {
    var $ = window.$, divId = ensureEncPanelDiv(node); if (!divId || !$) return;
    var $el = $('#' + divId);
    Array.prototype.forEach.call(document.querySelectorAll('#rightInfoBar .infoLayerElem'), function (el) { if (el.id !== divId) el.style.display = 'none'; });   // one panel at a time
    var renderFn = (window.renderRegistry && window.renderRegistry._notes) || (node.panel && node.panel.render);   // always _notes (panel.render is the Drupal one in "both" mode)
    try { $el.html(renderFn ? renderFn(props, function () { return ''; }) : ('<h3>' + attrEsc(props.label || 'Details') + '</h3>')); } catch (e) { $el.html('<h3>' + attrEsc(props.label || 'Details') + '</h3>'); }
    if (typeof floatPanelToTop === 'function') { try { floatPanelToTop(divId); } catch (e) {} }
    $el.show();
    shiftFeaturePanelForEnc(true);
  }
  function onFeatureField(field, value) {
    if (!selectedDrawId) return;
    var meta = featureMeta[selectedDrawId] = featureMeta[selectedDrawId] || { label: '', notes: '' };
    meta[field] = value;
    var _ln = featureLayer[selectedDrawId] ? nodeByLayerDbId(featureLayer[selectedDrawId]) : null;   // live-refresh the notes preview as you type label/notes
    if (_ln && _ln.panel && _ln.panel.mode === 'notes' && document.getElementById('infoPanel-' + _ln.id)) showNotesPreview(_ln, { label: meta.label, notes: meta.notes, image_url: meta.image_url });
    clearTimeout(_featTimer);
    _featTimer = setTimeout(function () { saveFeatureMeta(selectedDrawId); }, 600);
  }
  async function saveFeatureMeta(drawId) {
    var fid = featureToDb[drawId]; if (!fid) return;
    var meta = featureMeta[drawId] || {};
    setStatus('Saving…');
    // image_url lives in custom_fields (jsonb) — read-merge-write so we don't clobber imported attributes
    var cf = {};
    try { var cur = await db.from('features').select('custom_fields').eq('feature_id', fid).single(); cf = (cur.data && cur.data.custom_fields) || {}; } catch (e) { cf = {}; }
    if (meta.image_url) cf.image_url = meta.image_url; else delete cf.image_url;
    var cfVal = Object.keys(cf).length ? cf : null;
    try { var r = await db.from('features').update({ label: meta.label || null, description: meta.notes || null, start_date: meta.start || null, end_date: meta.end || null, content_id: meta.pageid || null, custom_fields: cfVal }).eq('feature_id', fid); if (r.error) throw new Error(r.error.message); setStatus('Saved'); }
    catch (e) { console.warn('editing: feature meta save failed', e); setStatus('Save failed'); }
  }
  function updateImagePreview(url) {   // small thumbnail under the URL field in the feature panel
    var img = document.getElementById('efp-image-preview'); if (!img) return;
    if (url) { img.src = url; img.style.display = 'block'; } else { img.removeAttribute('src'); img.style.display = 'none'; }
  }
  var FEATURE_IMAGE_BUCKET = 'feature-images';   // public Supabase Storage bucket (one-time setup; anon-insert RLS)
  async function uploadFeatureImage(file) {
    var st = document.getElementById('efp-image-status');
    if (!file.type || file.type.indexOf('image/') !== 0) { if (st) st.textContent = 'Not an image'; return; }
    if (st) st.textContent = 'Uploading…';
    try {
      if (!db.storage) throw new Error('storage unavailable');
      var ext = ((file.name || '').split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
      var key = 'feat/' + (featureToDb[selectedDrawId] || 'new') + '-' + (new Date().getTime()) + '.' + ext;
      var up = await db.storage.from(FEATURE_IMAGE_BUCKET).upload(key, file, { upsert: true, contentType: file.type });
      if (up.error) throw new Error(up.error.message);
      var pub = db.storage.from(FEATURE_IMAGE_BUCKET).getPublicUrl(key);
      var url = (pub && pub.data && pub.data.publicUrl) || '';
      if (!url) throw new Error('no public URL');
      var inp = document.getElementById('efp-image'); if (inp) inp.value = url;
      onFeatureField('image_url', url); updateImagePreview(url);
      if (st) st.textContent = 'Uploaded ✓';
    } catch (e) { if (st) st.textContent = 'Upload failed — create the “' + FEATURE_IMAGE_BUCKET + '” bucket'; console.warn('feature image upload failed', e); }
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
    p.style.cssText = 'position:fixed;top:120px;left:362px;width:210px;background:#fff;border:1px solid #bbbbbb;border-radius:6px;box-shadow:0 2px 10px rgba(0,0,0,0.18);padding:10px;font-size:13px;z-index:1000;display:none;font-family:Source Sans Pro,Arial,sans-serif;';
    p.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;"><b id="elp-title">Layer style</b><span id="elp-close" style="cursor:pointer;color:#888888;font-size:16px;">&times;</span></div>' +
      '<div id="elp-style-section">' +
      '<label style="display:block;font-size:11px;color:#555555;margin-bottom:2px;">Color</label>' +
      '<input id="elp-color" type="color" style="width:100%;height:30px;box-sizing:border-box;margin-bottom:8px;padding:1px;border:1px solid #bbbbbb;border-radius:4px;cursor:pointer;" />' +
      '<label style="display:block;font-size:11px;color:#555555;margin-bottom:2px;">Opacity <span id="elp-opacity-val"></span></label>' +
      '<input id="elp-opacity" type="range" min="0" max="1" step="0.05" style="width:100%;box-sizing:border-box;" />' +
      '<div id="elp-radius-row" style="margin-top:8px;"><label style="display:block;font-size:11px;color:#555555;margin-bottom:2px;">Radius <span id="elp-radius-val"></span></label>' +
      '<input id="elp-radius" type="range" min="1" max="30" step="1" style="width:100%;box-sizing:border-box;" /></div>' +
      '<div id="elp-outline-row" style="margin-top:8px;"><label style="display:block;font-size:11px;color:#555555;margin-bottom:2px;">Outline color</label>' +
      '<input id="elp-outline" type="color" style="width:100%;height:28px;box-sizing:border-box;padding:1px;border:1px solid #bbbbbb;border-radius:4px;cursor:pointer;" /></div>' +
      '<div id="elp-width-row" style="margin-top:8px;"><label style="display:block;font-size:11px;color:#555555;margin-bottom:2px;"><span id="elp-width-label">Width</span> <span id="elp-width-val"></span></label>' +
      '<input id="elp-width" type="range" min="0.5" max="12" step="0.5" style="width:100%;box-sizing:border-box;" /></div>' +
      '<div id="elp-vis-row" style="margin-top:8px;display:flex;gap:12px;font-size:12px;color:#555555;">' +
        '<label style="cursor:pointer;"><input id="elp-fill-vis" type="checkbox" style="vertical-align:middle;margin:0 3px 0 0;" />Show fill</label>' +
        '<label style="cursor:pointer;"><input id="elp-outline-vis" type="checkbox" style="vertical-align:middle;margin:0 3px 0 0;" />Show outline</label>' +
      '</div>' +
      '<button id="elp-split" style="margin-top:10px;width:100%;padding:6px;border:1px solid #bbbbbb;border-radius:4px;background:#f2f2f2;cursor:pointer;font-size:12px;">Split outline into its own layer</button>' +
      '</div>' +
      '<button id="elp-attrs" style="margin-top:8px;width:100%;padding:6px;border:1px solid #bbbbbb;border-radius:4px;background:#f2f2f2;cursor:pointer;font-size:12px;">&#9638; Attribute table</button>' +
      '<button id="elp-setzoom" style="margin-top:8px;width:100%;padding:6px;border:1px solid #bbbbbb;border-radius:4px;background:#f2f2f2;cursor:pointer;font-size:12px;">◎ Set zoom to current view</button>' +
      '<div id="elp-zoom-info" style="font-size:11px;color:#888888;margin-top:4px;text-align:center;">Zoom target: not set</div>' +
      '<div id="elp-src-row" style="display:none;margin-top:10px;border-top:1px solid #e8e8e8;padding-top:8px;">' +
        '<label style="display:block;font-size:11px;color:#555555;margin-bottom:2px;">Tileset source</label>' +
        '<input id="elp-src-url" type="text" placeholder="mapbox://user.id  or  https://…/{z}/{x}/{y}.pbf" style="width:100%;box-sizing:border-box;margin-bottom:5px;padding:5px 6px;border:1px solid #bbbbbb;border-radius:4px;font-size:12px;" />' +
        '<input id="elp-src-sl" type="text" placeholder="source layer (e.g. buildings)" style="width:100%;box-sizing:border-box;margin-bottom:5px;padding:5px 6px;border:1px solid #bbbbbb;border-radius:4px;font-size:12px;" />' +
        '<div id="elp-src-zooms" style="display:none;margin-bottom:5px;"><input id="elp-src-minz" type="number" placeholder="min zoom" style="width:48%;box-sizing:border-box;padding:5px 6px;border:1px solid #bbbbbb;border-radius:4px;font-size:12px;" /> <input id="elp-src-maxz" type="number" placeholder="max zoom" style="width:48%;box-sizing:border-box;padding:5px 6px;border:1px solid #bbbbbb;border-radius:4px;font-size:12px;" /></div>' +
        '<div id="elp-src-info" style="font-size:10px;color:#888888;margin-bottom:5px;"></div>' +
        '<button id="elp-src-apply" style="width:100%;padding:6px;border:1px solid #bbbbbb;border-radius:4px;background:#e8e8e8;color:#222222;cursor:pointer;font-size:12px;">Apply source</button>' +
      '</div>' +
      '<div id="elp-panel-row" style="margin-top:10px;border-top:1px solid #e8e8e8;padding-top:8px;"><label style="display:block;font-size:11px;color:#555555;margin-bottom:2px;">Info panel (on feature click)</label>' +
      '<select id="elp-panel-mode" style="width:100%;box-sizing:border-box;padding:5px 6px;border:1px solid #bbbbbb;border-radius:4px;font-size:12px;"><option value="notes">Title + notes</option><option value="drupal">Drupal / encyclopedia</option><option value="both">Both</option></select></div>' +
      '<div id="elp-enc-row" style="margin-top:10px;border-top:1px solid #e8e8e8;padding-top:8px;"><label style="display:block;font-size:11px;color:#555555;margin-bottom:2px;">Encyclopedia base URL</label>' +
      '<input id="elp-encurl" type="text" placeholder="https://…/encyclopedia" style="width:100%;box-sizing:border-box;padding:5px 6px;border:1px solid #bbbbbb;border-radius:4px;font-size:12px;" />' +
      '<div id="elp-nidprop-row" style="display:none;margin-top:6px;"><label style="display:block;font-size:11px;color:#555555;margin-bottom:2px;">Page-ID property</label>' +
      '<input id="elp-nidprop" type="text" placeholder="e.g. nid" style="width:100%;box-sizing:border-box;padding:5px 6px;border:1px solid #bbbbbb;border-radius:4px;font-size:12px;" />' +
      '<div style="font-size:10px;color:#888888;margin-top:3px;">For tilesets: which feature property holds the page id (drawn layers always use &ldquo;content_id&rdquo;).</div></div>' +
      '<div style="font-size:10px;color:#888888;margin-top:3px;">Set this, then give each feature a Page ID — clicking a feature opens its page.</div></div>' +
      '<div id="elp-interact-row" style="margin-top:10px;border-top:1px solid #e8e8e8;padding-top:8px;">' +
        '<label style="display:block;font-size:11px;color:#555555;margin-bottom:4px;">Interaction</label>' +
        '<label style="cursor:pointer;font-size:12px;color:#555555;display:block;margin-bottom:3px;"><input id="elp-hover" type="checkbox" style="vertical-align:middle;margin:0 5px 0 0;" />Popup on hover</label>' +
        '<label style="cursor:pointer;font-size:12px;color:#555555;display:block;margin-bottom:6px;"><input id="elp-click" type="checkbox" style="vertical-align:middle;margin:0 5px 0 0;" />Popup on click</label>' +
        '<label style="display:block;font-size:11px;color:#555555;margin-bottom:2px;">Label field</label>' +
        '<input id="elp-labelfield" type="text" placeholder="label" style="width:100%;box-sizing:border-box;padding:5px 6px;border:1px solid #bbbbbb;border-radius:4px;font-size:12px;" />' +
        '<div style="font-size:10px;color:#888888;margin-top:3px;">Label field = which property the popup shows (defaults to &ldquo;label&rdquo;). Popups are wired at page load, so <b>reload to apply</b> on/off changes.</div>' +
      '</div>';
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
    document.getElementById('elp-attrs').addEventListener('click', function () { if (activeLayerId) openAttributeTable(activeLayerId); });
    document.getElementById('elp-setzoom').addEventListener('click', function () { if (activeLayerId) onSetZoom(activeLayerId); });   // set-zoom moved here from the layer row
    document.getElementById('elp-encurl').addEventListener('change', function () { onEncUrl(this.value); });
    document.getElementById('elp-nidprop').addEventListener('change', function () { onNidProp(this.value); });
    document.getElementById('elp-panel-mode').addEventListener('change', function () { onPanelMode(this.value); });
    document.getElementById('elp-src-apply').addEventListener('click', onApplySource);
    document.getElementById('elp-src-url').addEventListener('input', function () { document.getElementById('elp-src-zooms').style.display = (this.value.trim().indexOf('mapbox://') === 0) ? 'none' : 'block'; });
    document.getElementById('elp-hover').addEventListener('change', onInteraction);
    document.getElementById('elp-click').addEventListener('change', onInteraction);
    document.getElementById('elp-labelfield').addEventListener('change', onInteraction);
  }
  // Per-layer hover/click popup toggles + which property the popup shows. The engine wires hover/click
  // only for layers that have a popupStyle (the CSS bubble class), so "Popup on hover" maps to setting it.
  async function onInteraction() {
    if (!activeLayerId) return;
    var node = findNodeById(layers, activeLayerId); if (!node) return;
    var lid = slugToLayerDbId[activeLayerId]; if (!lid) return;
    var hover = document.getElementById('elp-hover').checked;
    var click = document.getElementById('elp-click').checked;
    var labelField = (document.getElementById('elp-labelfield').value || '').trim() || 'label';
    var popupStyle = hover ? (node._popupStyle || node.popupStyle || 'infoLayerGreenPopUp') : null;
    // The engine wires hover/click popups at PAGE LOAD, so on/off applies on reload. Do NOT mutate the live
    // node's popupStyle: the popup is already wired, and nulling the style mid-session leaves the bubble
    // showing but stripped of its colour class. Persist to the DB + keep a UI shadow for the panel.
    node._uiHover = hover; node._uiClick = click; node._uiLabel = labelField; if (popupStyle) node._popupStyle = popupStyle;
    setStatus('Saving…');
    try { var r = await db.from('layers').update({ popup_style: popupStyle, popup_prop: labelField, click: click }).eq('id', lid); if (r.error) throw new Error(r.error.message); setStatus('Saved — reload to apply'); }
    catch (e) { setStatus('Save failed'); }
  }
  async function onEncUrl(value) {
    if (!activeLayerId) return;
    var node = findNodeById(layers, activeLayerId); if (!node) return;
    var lid = slugToLayerDbId[activeLayerId]; if (!lid) return;
    var url = (value || '').trim();
    var isTs = isTilesetNode(node);
    // page-id property: drawn layers use the features.content_id column; tilesets pick a feature/tile property (default nid) — never clobber an existing mapping
    var nidProp = isTs ? ((node.panel && node.panel.nidProp) || ((document.getElementById('elp-nidprop') || {}).value || '').trim() || 'nid') : 'content_id';
    if (url) { node.panel = node.panel || {}; node.panel.encyclopediaBase = url; node.panel.nidProp = nidProp; if (!node.panel.render && window.renderRegistry) node.panel.render = window.renderRegistry._default; }
    else if (node.panel) { delete node.panel.encyclopediaBase; }
    setStatus('Saving…');
    try { var r = await db.from('layers').update({ content_base_url: url || null, content_id_prop: url ? nidProp : null }).eq('id', lid); if (r.error) throw new Error(r.error.message); setStatus('Saved'); }
    catch (e) { setStatus('Save failed'); }
  }
  async function onNidProp(value) {   // #7: tilesets choose which feature property holds the Drupal page id (e.g. buildings use "nid")
    if (!activeLayerId) return;
    var node = findNodeById(layers, activeLayerId); if (!node) return;
    var lid = slugToLayerDbId[activeLayerId]; if (!lid) return;
    var prop = (value || '').trim() || 'nid';
    node.panel = node.panel || {}; node.panel.nidProp = prop;
    setStatus('Saving…');
    try { var r = await db.from('layers').update({ content_id_prop: prop }).eq('id', lid); if (r.error) throw new Error(r.error.message); setStatus('Saved'); }
    catch (e) { setStatus('Save failed'); }
  }
  async function onPanelMode(mode) {   // per-layer info-panel mode: notes / drupal / both → persisted in raw_config.panel.mode (configLoader reads it)
    if (!activeLayerId) return;
    var node = findNodeById(layers, activeLayerId); if (!node) return;
    var lid = slugToLayerDbId[activeLayerId]; if (!lid) return;
    node.panel = node.panel || {};
    node.panel.mode = mode;
    if (window.renderRegistry) node.panel.render = (mode === 'notes') ? window.renderRegistry._notes : (window.renderRegistry[activeLayerId] || window.renderRegistry._default);
    document.getElementById('elp-enc-row').style.display = (mode === 'drupal' || mode === 'both') ? 'block' : 'none';   // toggle the encyclopedia URL field live
    setStatus('Saving…');
    try {
      var cur = await db.from('layers').select('raw_config').eq('id', lid).single();
      var rc = (cur.data && cur.data.raw_config) || {};
      rc.panel = rc.panel || {}; rc.panel.mode = mode;
      var r = await db.from('layers').update({ raw_config: rc }).eq('id', lid); if (r.error) throw new Error(r.error.message);
      setStatus('Info panel: ' + mode);
    } catch (e) { setStatus('Save failed'); }
  }
  // View/edit a tileset's source — repoint the URL (mapbox:// or a {z}/{x}/{y} worker/PMTiles template),
  // source-layer, and zoom range; persist to the layers table + re-render the layer on both maps.
  async function onApplySource() {
    if (!activeLayerId) return;
    var node = findNodeById(layers, activeLayerId); if (!node || !isTilesetNode(node)) return;
    var lid = slugToLayerDbId[activeLayerId]; if (!lid) return;
    var url = (document.getElementById('elp-src-url').value || '').trim();
    var sl = (document.getElementById('elp-src-sl').value || '').trim();
    if (!url) { setStatus('Source URL required'); return; }
    var isMapbox = url.indexOf('mapbox://') === 0;
    var minz = parseInt(document.getElementById('elp-src-minz').value, 10), maxz = parseInt(document.getElementById('elp-src-maxz').value, 10);
    if (isMapbox) { node.source = { type: 'vector', url: url }; }
    else { node.source = { type: 'vector', tiles: [url] }; if (!isNaN(minz)) node.source.minzoom = minz; if (!isNaN(maxz)) node.source.maxzoom = maxz; }
    if (sl) node['source-layer'] = sl; else delete node['source-layer'];
    node.source_type = isMapbox ? 'mapbox-tileset' : 'vector-tiles-url';
    setStatus('Saving…');
    try {
      var rw = leafRow(node);
      var r = await db.from('layers').update({ source_type: rw.source_type, source_url: rw.source_url, source_layer: rw.source_layer, source_minzoom: rw.source_minzoom, source_maxzoom: rw.source_maxzoom }).eq('id', lid);
      if (r.error) throw new Error(r.error.message); setStatus('Source updated');
    } catch (e) { setStatus('Save failed'); return; }
    removeMapLayers(node.id); renderTilesetOnMap(node);   // re-render with the new source
    _engineEditWired[node.id] = false; wireEngineEditClicks();   // re-attach click→edit (removeLayer dropped the old handler)
    if (typeof refreshLayers === 'function') refreshLayers();
    showLayerPanel(activeLayerId);
  }
  function showLayerPanel(slug) {
    var node = findNodeById(layers, slug); if (!node) return;
    var isGeojson = node.source_type === 'geojson-supabase';   // split is drawn-layer only
    var fillStroke = (isGeojson || isTilesetNode(node)) && node.type === 'fill';  // drawn AND tileset fills get the real line outline + its width/show toggles
    injectLayerPanel();
    var p = document.getElementById('editor-layer-panel'); if (!p) return;
    var isGroup = node.type === 'group';
    if (isGroup) {   // groups have no style — show only the zoom controls + readout
      document.getElementById('elp-title').textContent = node.label || 'Group';
      document.getElementById('elp-style-section').style.display = 'none';
      ['elp-interact-row', 'elp-attrs', 'elp-enc-row', 'elp-src-row'].forEach(function (eid) { var el = document.getElementById(eid); if (el) el.style.display = 'none'; });
      document.getElementById('elp-setzoom').style.display = 'block';
      document.getElementById('elp-zoom-info').style.display = 'block';
      document.getElementById('elp-zoom-info').textContent = fmtNodeZoom(node);
      p.style.display = 'block';
      return;
    }
    var isStyleableLayer = isGeojson || (isTilesetNode(node) && ['fill', 'line', 'circle'].indexOf(node.type) > -1);
    document.getElementById('elp-style-section').style.display = isStyleableLayer ? '' : 'none';   // typeless/basemap tilesets: hide style, keep attr + source + zoom
    document.getElementById('elp-interact-row').style.display = isStyleableLayer ? '' : 'none';
    document.getElementById('elp-zoom-info').textContent = fmtNodeZoom(node);
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
    // attribute table: drawn + ALL tilesets (stored features → editable; pure tilesets → read-only from loaded tiles)
    document.getElementById('elp-attrs').style.display = (isGeojson || isTilesetNode(node)) ? 'block' : 'none';
    var canPanel = isGeojson || isTilesetNode(node);   // layers that can show a feature info panel
    var pmodeUI = (node.panel && node.panel.mode) || ((node.panel && node.panel.encyclopediaBase) ? 'drupal' : 'notes');
    document.getElementById('elp-panel-row').style.display = canPanel ? 'block' : 'none';
    document.getElementById('elp-panel-mode').value = pmodeUI;
    document.getElementById('elp-enc-row').style.display = (canPanel && (pmodeUI === 'drupal' || pmodeUI === 'both')) ? 'block' : 'none';   // encyclopedia URL only when Drupal is part of the mode
    document.getElementById('elp-encurl').value = (node.panel && node.panel.encyclopediaBase) || '';
    var isTsPanel = isTilesetNode(node);   // tilesets pick which property holds the page id; drawn layers always use content_id
    document.getElementById('elp-nidprop-row').style.display = (isTsPanel && (pmodeUI === 'drupal' || pmodeUI === 'both')) ? 'block' : 'none';
    document.getElementById('elp-nidprop').value = (node.panel && node.panel.nidProp) || (isTsPanel ? 'nid' : 'content_id');
    var isTs = isTilesetNode(node);   // tilesets show their Source (url / source-layer / zooms) so it can be viewed + repointed (e.g. to a PMTiles worker)
    document.getElementById('elp-src-row').style.display = isTs ? 'block' : 'none';
    if (isTs) {
      var src = node.source || {}, isTilesUrl = !!(src.tiles && src.tiles.length);
      document.getElementById('elp-src-url').value = src.url || (src.tiles && src.tiles[0]) || '';
      document.getElementById('elp-src-sl').value = node['source-layer'] || '';
      document.getElementById('elp-src-zooms').style.display = isTilesUrl ? 'block' : 'none';
      document.getElementById('elp-src-minz').value = (src.minzoom != null) ? src.minzoom : '';
      document.getElementById('elp-src-maxz').value = (src.maxzoom != null) ? src.maxzoom : '';
      document.getElementById('elp-src-info').textContent = (node.source_type || (isTilesUrl ? 'vector-tiles-url' : 'mapbox-tileset')) + (node.type ? ' · ' + node.type : '');
    }
    document.getElementById('elp-hover').checked = (node._uiHover != null) ? node._uiHover : !!node.popupStyle;
    document.getElementById('elp-click').checked = (node._uiClick != null) ? node._uiClick : !!node.click;
    document.getElementById('elp-labelfield').value = (node._uiLabel != null) ? node._uiLabel : (node.prop || 'label');
    p.style.display = 'block';
  }
  function hideLayerPanel() { var p = document.getElementById('editor-layer-panel'); if (p) p.style.display = 'none'; }
  function fmtNodeZoom(node) {   // the readout shown under the panel's "Set zoom" button
    return (node && node.zoomCenter) ? ('Zoom target: ' + Number(node.zoomCenter[1]).toFixed(4) + ', ' + Number(node.zoomCenter[0]).toFixed(4) + ' · z' + (node.zoomLevel != null ? Number(node.zoomLevel).toFixed(1) : '?')) : 'Zoom target: not set';
  }
  // ---- Attribute table: a spreadsheet view of one drawn layer's features (label / dates / notes, editable) ----
  function attrEsc(s) { return s == null ? '' : String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function injectAttrModal() {
    if (document.getElementById('editor-attr-modal')) return;
    var st = document.createElement('style');
    st.textContent =
      // wrapper is a non-blocking layer (pointer-events:none) so the MAP behind stays pannable; only the panel itself catches events
      '#editor-attr-modal{position:fixed;inset:0;z-index:4000;display:none;pointer-events:none;font-family:"Source Sans Pro",Arial,sans-serif;}' +
      '#editor-attr-panel{pointer-events:auto;position:absolute;left:540px;top:134px;width:min(820px,70vw);height:60vh;min-width:340px;min-height:180px;max-width:96vw;max-height:84vh;background:#fff;border-radius:8px;box-shadow:0 10px 40px rgba(0,0,0,0.3);display:flex;flex-direction:column;resize:both;overflow:hidden;}' +   // top:134 clears the map-tools bar (top 92–127) so undo/redo stay reachable
      '#editor-attr-head{display:flex;justify-content:space-between;align-items:center;padding:10px 14px;border-bottom:1px solid #cccccc;font-size:15px;color:#2b3a4a;cursor:move;}' +   // header doubles as the drag handle (move the panel off the map)
      '#editor-attr-head .attr-head-l{display:flex;align-items:center;gap:10px;min-width:0;}' +
      '#editor-attr-title{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}' +
      '#editor-attr-zoom{font-size:12px;padding:3px 9px;border:1px solid #bbbbbb;border-radius:4px;background:#f2f2f2;cursor:pointer;white-space:nowrap;}' +
      '#editor-attr-zoom:disabled{opacity:0.45;cursor:default;}' +
      '#editor-attr-del{font-size:12px;padding:3px 9px;border:1px solid #e0b4b4;border-radius:4px;background:#fdeaea;color:#b4453a;cursor:pointer;white-space:nowrap;}' +
      '#editor-attr-del:disabled{opacity:0.45;cursor:default;}' +
      '#editor-attr-close{cursor:pointer;color:#888888;font-size:22px;line-height:1;padding-left:8px;}' +
      '#editor-attr-wrap{overflow:auto;flex:1;}' +
      '#editor-attr-table{border-collapse:collapse;font-size:13px;table-layout:fixed;}' +   // fixed = column widths are honored exactly (so resize works); JS sets the table width = sum of columns
      '#editor-attr-table th{box-sizing:border-box;position:sticky;top:0;background:#f2f2f2;text-align:left;padding:8px 18px 8px 10px;border-bottom:1px solid #cccccc;color:#555555;font-weight:600;white-space:nowrap;cursor:pointer;user-select:none;overflow:hidden;}' +
      '#editor-attr-table th:hover{background:#eaf0f6;}' +
      '#editor-attr-table th .attr-arrow{margin-left:5px;font-size:10px;color:#ce5c00;}' +
      '#editor-attr-table th .attr-rsz{position:absolute;top:0;right:0;width:8px;height:100%;cursor:col-resize;}' +
      '#editor-attr-table th .attr-rsz:hover{background:#b9c6d4;}' +
      '#editor-attr-table td{padding:2px 6px;border-bottom:1px solid #f0f3f6;box-sizing:border-box;overflow:hidden;}' +
      '#editor-attr-table input{width:100%;box-sizing:border-box;border:1px solid transparent;border-radius:3px;padding:4px 6px;font-size:13px;background:transparent;color:#2b3a4a;}' +
      '#editor-attr-table input:hover{border-color:#d8d8d8;}' +
      '#editor-attr-table input:focus{border-color:#ce5c00;background:#fff;outline:none;}' +
      '#editor-attr-table tbody tr:hover td{background:#f8fafc;}' +
      '#editor-attr-table tbody tr.attr-row-sel td{background:#fff5cc;}' +
      '#editor-attr-table tbody tr.attr-row-sel:hover td{background:#ffefb0;}' +
      '#editor-attr-table tbody tr.attr-row-hover td{background:#d6f3ff;}' +   // brushed from the map (or direct hover) — matches the cyan map highlight
      '#editor-attr-foot{padding:8px 16px;border-top:1px solid #cccccc;font-size:12px;color:#888888;}';
    document.head.appendChild(st);
    var m = document.createElement('div'); m.id = 'editor-attr-modal';
    m.innerHTML =
      '<div id="editor-attr-panel">' +
        '<div id="editor-attr-head"><span class="attr-head-l"><b id="editor-attr-title">Attributes</b>' +
          '<button id="editor-attr-zoom" title="Zoom the map to the selected feature(s)" disabled>&#9673; Zoom to selected</button>' +
          '<button id="editor-attr-del" title="Delete the selected feature(s)" disabled>&#128465; Delete selected</button></span>' +
          '<span id="editor-attr-close" title="Close">&times;</span></div>' +
        '<div id="editor-attr-wrap"><table id="editor-attr-table"><thead id="editor-attr-thead"></thead><tbody id="editor-attr-tbody"></tbody></table></div>' +
        '<div id="editor-attr-foot"></div>' +
      '</div>';
    document.body.appendChild(m);
    document.getElementById('editor-attr-close').addEventListener('click', hideAttrModal);
    document.getElementById('editor-attr-zoom').addEventListener('click', zoomToAttrSelected);
    document.getElementById('editor-attr-del').addEventListener('click', deleteAttrSelected);
    document.getElementById('editor-attr-head').addEventListener('mousedown', startAttrPanelDrag);
  }
  var _attrCustom = {};   // fid → its custom_fields object, so a single-cell edit rewrites the whole jsonb
  var _attrRows = [], _attrCols = [], _attrSort = null, _attrSel = [];   // loaded rows + column model + {idx,dir} + selected feature_ids (highlighted on the map)
  var _attrById = {}, _attrSlug = null, _attrHover = null, _attrHoverRAF = false, _attrLastPt = null, _attrHoverWired = false;   // hover brushing (map ↔ row): id→row lookup, open layer, hovered fid
  var _attrReadonly = false;   // true when the table is sourced from vector tiles (pure tileset) rather than the editable `features` table
  var _attrDelegated = false;  // event-delegation wired once on tbody (so 18k+ rows don't each get listeners)
  function attrCellVal(r, c) { return c.kind === 'custom' ? ((r.custom_fields || {})[c.key]) : r[c.field]; }
  function attrDisp(r, c) { var v = attrCellVal(r, c); if (c.kind === 'date') return v ? String(v).slice(0, 10) : ''; return v == null ? '' : v; }
  function findAttrRow(fid) { return _attrById[String(fid)] || null; }
  async function openAttributeTable(slug) {
    var node = slug && findNodeById(layers, slug); if (!node) return;
    var lid = slugToLayerDbId[slug];
    if (!lid) { setStatus('No stored data for this layer'); return; }
    injectAttrModal();
    var modal = document.getElementById('editor-attr-modal');
    document.getElementById('editor-attr-title').textContent = (node.label || 'Layer') + ' — attributes';
    var thead = document.getElementById('editor-attr-thead'), tbody = document.getElementById('editor-attr-tbody'), foot = document.getElementById('editor-attr-foot');
    thead.innerHTML = ''; tbody.innerHTML = '<tr><td style="padding:14px;color:#888888;">Loading…</td></tr>'; foot.textContent = '';
    modal.style.display = 'block';
    _attrCustom = {}; _attrRows = []; _attrCols = []; _attrSort = null; _attrReadonly = false; clearAttrHighlight();
    var rows = [], total = 0, loadErr = null;   // fetch ALL features (paginated) — no time filter, no 1000 cap
    try {
      for (var afrom = 0; afrom < 1000000; afrom += 1000) {
        var ares = await db.from('features').select('feature_id, label, description, start_date, end_date, custom_fields, geom, content_id', afrom === 0 ? { count: 'exact' } : {}).eq('layer_id', lid).order('feature_id').range(afrom, afrom + 999);
        if (ares.error) { loadErr = ares.error; break; }
        if (afrom === 0 && ares.count != null) total = ares.count;
        var abatch = ares.data || []; rows = rows.concat(abatch);
        var fEl = document.getElementById('editor-attr-foot'); if (fEl) fEl.textContent = 'Loading ' + rows.length + (total ? ' / ' + total : '') + '…';
        if (abatch.length < 1000) break;
      }
    } catch (e) { loadErr = e; }
    if (loadErr) { tbody.innerHTML = '<tr><td style="padding:14px;color:#b4453a;">Failed to load features.</td></tr>'; return; }
    if (!total) total = rows.length;
    if (!rows.length && isTilesetNode(node)) {   // pure tileset (no rows in `features`): read its attributes from the loaded vector tiles
      var seen = {}, tfeats = [];
      [['left', beforeMap], ['right', (typeof afterMap !== 'undefined' ? afterMap : null)]].forEach(function (pair) {
        var m = pair[1]; if (!m) return;
        try {
          var q = node['source-layer'] ? { sourceLayer: node['source-layer'] } : {};
          (m.querySourceFeatures(node.id + '-' + pair[0], q) || []).forEach(function (f) {
            var key = (f.id != null ? 'i' + f.id : 'p' + JSON.stringify(f.properties));
            if (seen[key]) return; seen[key] = 1;
            tfeats.push({ feature_id: (f.id != null ? f.id : 't' + tfeats.length), custom_fields: f.properties || {}, geom: f.geometry, _tile: true });
          });
        } catch (e) {}
      });
      if (!tfeats.length) { tbody.innerHTML = '<tr><td style="padding:14px;color:#888888;">No tile features loaded here — pan/zoom to the layer, then reopen.</td></tr>'; foot.textContent = '0 features (tiles)'; return; }
      var tkeys = []; tfeats.forEach(function (r) { Object.keys(r.custom_fields).forEach(function (k) { if (tkeys.indexOf(k) < 0) tkeys.push(k); }); }); tkeys = tkeys.slice(0, 40);
      _attrRows = tfeats; _attrReadonly = true; _attrSlug = slug; _attrById = {}; tfeats.forEach(function (r) { _attrById[String(r.feature_id)] = r; }); ensureAttrMapHover();
      _attrCols = tkeys.length ? tkeys.map(function (k) { return { title: k, kind: 'custom', key: k, type: 'text', w: 140 }; }) : [{ title: 'feature', kind: 'std', field: 'feature_id', type: 'text', w: 200 }];
      buildAttrHead(); renderAttrBody(); updateAttrZoomBtn(); updateAttrDelBtn();
      foot.textContent = tfeats.length + ' feature' + (tfeats.length === 1 ? '' : 's') + ' from loaded tiles · read-only · pan/zoom to load more · click a row to highlight';
      return;
    }
    if (!rows.length) { tbody.innerHTML = '<tr><td style="padding:14px;color:#888888;">No features in this layer yet.</td></tr>'; foot.textContent = '0 features'; return; }
    // dynamic columns = the union of custom_fields keys across the loaded rows (imported attributes), capped
    var keys = [];
    rows.forEach(function (r) { var cf = r.custom_fields; if (cf && typeof cf === 'object') { _attrCustom[r.feature_id] = cf; Object.keys(cf).forEach(function (k) { if (keys.indexOf(k) < 0) keys.push(k); }); } });
    keys = keys.slice(0, 30);
    _attrRows = rows;
    _attrSlug = slug; _attrById = {}; rows.forEach(function (r) { _attrById[String(r.feature_id)] = r; }); ensureAttrMapHover();
    _attrCols = [
      { title: 'Label', kind: 'std', field: 'label', type: 'text', w: keys.length ? 180 : 240 },
      { title: 'Start', kind: 'date', field: 'start_date', type: 'date', w: 130 },
      { title: 'End', kind: 'date', field: 'end_date', type: 'date', w: 130 },
      { title: 'Notes', kind: 'std', field: 'description', type: 'text', w: 220 },
      { title: 'Page', kind: 'std', field: 'content_id', type: 'text', w: 90 }
    ].concat(keys.map(function (k) { return { title: k, kind: 'custom', key: k, type: 'text', w: 130 }; }));
    buildAttrHead(); renderAttrBody(); updateAttrZoomBtn(); updateAttrDelBtn();
    foot.textContent = total + ' feature' + (total === 1 ? '' : 's') + (keys.length ? '  ·  ' + keys.length + ' attribute' + (keys.length === 1 ? '' : 's') : '') + (total > rows.length ? '  ·  showing first ' + rows.length : '') + '  ·  click a row to highlight it on the map · Ctrl-click to add';
  }
  function buildAttrHead() {
    var thead = document.getElementById('editor-attr-thead');
    thead.innerHTML = '<tr>' + _attrCols.map(function (c, i) {
      var arrow = (_attrSort && _attrSort.idx === i) ? '<span class="attr-arrow">' + (_attrSort.dir === 'desc' ? '▼' : '▲') + '</span>' : '';
      return '<th data-ci="' + i + '" style="width:' + c.w + 'px;" title="' + attrEsc(c.title) + '">' + attrEsc(c.title) + arrow + '<span class="attr-rsz"></span></th>';
    }).join('') + '</tr>';
    Array.prototype.forEach.call(thead.querySelectorAll('th'), function (th) {
      var ci = parseInt(th.getAttribute('data-ci'), 10);
      th.addEventListener('click', function (e) { if (e.target.classList.contains('attr-rsz')) return; sortAttrBy(ci); });
      th.querySelector('.attr-rsz').addEventListener('mousedown', function (e) { startAttrResize(e, th, ci); });
    });
    applyAttrTableWidth();
  }
  function applyAttrTableWidth() {   // table width = sum of column widths, so fixed layout honors each + the wrap scrolls horizontally
    var t = document.getElementById('editor-attr-table');
    if (t) t.style.width = _attrCols.reduce(function (s, c) { return s + (c.w || 130); }, 0) + 'px';
  }
  function startAttrResize(e, th, ci) {
    e.preventDefault(); e.stopPropagation();   // don't let the drag trigger a sort
    var startX = e.pageX, startW = th.offsetWidth;
    function move(ev) { var w = Math.max(60, startW + (ev.pageX - startX)); th.style.width = w + 'px'; _attrCols[ci].w = w; applyAttrTableWidth(); }
    function up() { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); document.body.style.userSelect = ''; }
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
  }
  function sortAttrBy(ci) {
    if (_attrSort && _attrSort.idx === ci) _attrSort.dir = (_attrSort.dir === 'asc') ? 'desc' : 'asc';
    else _attrSort = { idx: ci, dir: 'asc' };
    var c = _attrCols[ci], dir = _attrSort.dir;
    _attrRows.sort(function (a, b) {
      var va = attrCellVal(a, c), vb = attrCellVal(b, c);
      var na = (va == null || va === ''), nb = (vb == null || vb === '');
      if (na && nb) return 0; if (na) return 1; if (nb) return -1;   // blanks always sort last
      var r;
      if (typeof va === 'number' && typeof vb === 'number') r = va - vb;
      else { var sa = String(va).toLowerCase(), sb = String(vb).toLowerCase(); r = sa < sb ? -1 : sa > sb ? 1 : 0; }
      return dir === 'desc' ? -r : r;
    });
    buildAttrHead(); renderAttrBody();
  }
  function renderAttrBody() {
    var tbody = document.getElementById('editor-attr-tbody');
    tbody.innerHTML = _attrRows.map(function (r) {
      var sel = _attrSel.indexOf(String(r.feature_id)) > -1 ? ' class="attr-row-sel"' : '';
      return '<tr data-fid="' + attrEsc(r.feature_id) + '"' + sel + '>' + _attrCols.map(function (c) {
        var bind = c.kind === 'custom' ? 'data-fc="' + attrEsc(c.key) + '"' : 'data-f="' + attrEsc(c.field) + '"';
        var v = attrEsc(attrDisp(r, c));
        if (_attrReadonly) return '<td><span ' + bind + ' style="display:block;padding:6px 10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + v + '</span></td>';
        return '<td><input ' + bind + ' type="' + c.type + '" value="' + v + '" /></td>';
      }).join('') + '</tr>';
    }).join('');
    if (!_attrDelegated) { _attrDelegated = true; wireAttrDelegation(tbody); }   // delegate once (scales to all features without per-row listeners)
  }
  function wireAttrDelegation(tbody) {
    tbody.addEventListener('change', function (e) {   // edit a cell → persist
      var inp = e.target.closest('input'); if (!inp) return; var tr = inp.closest('tr[data-fid]'); if (!tr) return;
      var fid = tr.getAttribute('data-fid'), std = inp.getAttribute('data-f');
      if (std) saveAttrCell(fid, std, inp.value); else saveAttrCustomCell(fid, inp.getAttribute('data-fc'), inp.value);
    });
    tbody.addEventListener('click', function (e) {   // click a row → highlight its feature on the map (Ctrl/Cmd = add); editing a cell still works
      var tr = e.target.closest('tr[data-fid]'); if (tr) selectAttrRow(tr.getAttribute('data-fid'), e.ctrlKey || e.metaKey);
    });
    tbody.addEventListener('mouseover', function (e) { var tr = e.target.closest('tr[data-fid]'); setAttrHover(tr ? tr.getAttribute('data-fid') : null, false); });   // hover a row → light up its feature
    tbody.addEventListener('mouseleave', function () { setAttrHover(null, false); });
  }
  // ---- row selection ↔ map highlight + zoom ----
  function selectAttrRow(fid, additive) {
    fid = String(fid);
    if (additive) { var i = _attrSel.indexOf(fid); if (i > -1) _attrSel.splice(i, 1); else _attrSel.push(fid); }
    else { _attrSel = [fid]; }
    applyAttrSelClasses(); updateAttrHighlight(); updateAttrZoomBtn(); updateAttrDelBtn();
  }
  function applyAttrSelClasses() {
    var tbody = document.getElementById('editor-attr-tbody'); if (!tbody) return;
    Array.prototype.forEach.call(tbody.querySelectorAll('tr[data-fid]'), function (tr) { tr.classList.toggle('attr-row-sel', _attrSel.indexOf(tr.getAttribute('data-fid')) > -1); });
  }
  function updateAttrZoomBtn() { var b = document.getElementById('editor-attr-zoom'); if (b) b.disabled = !_attrSel.length; }
  function updateAttrDelBtn() {
    var b = document.getElementById('editor-attr-del'); if (!b) return;
    b.style.display = (_attrSlug && _drawLayerSlugs[_attrSlug]) ? '' : 'none';   // per-feature delete = editable (MapboxDraw) layers only
    b.disabled = !_attrSel.length;
  }
  async function deleteAttrSelected() {
    if (!_attrSel.length) return;
    var fids = _attrSel.slice(), n = fids.length;
    if (!window.confirm('Delete ' + n + ' feature' + (n > 1 ? 's' : '') + ' from this layer? You can undo this.')) return;
    await deleteDrawnByFids(fids, 'delete ' + n + ' feature' + (n > 1 ? 's' : ''));
    fids.forEach(function (fid) { delete _attrById[String(fid)]; });
    _attrRows = _attrRows.filter(function (r) { return fids.indexOf(String(r.feature_id)) < 0; });
    _attrSel = [];
    buildAttrHead(); renderAttrBody(); updateAttrZoomBtn(); updateAttrDelBtn(); updateAttrHighlight();
    setStatus('Deleted ' + n + ' feature' + (n > 1 ? 's' : ''));
  }
  function attrMaps() { var a = []; if (typeof beforeMap !== 'undefined' && beforeMap) a.push(beforeMap); if (typeof afterMap !== 'undefined' && afterMap) a.push(afterMap); return a; }
  function ensureAttrHlLayers() {   // selection + hover overlays on BOTH swipe sides (so highlight shows left AND right)
    attrMaps().forEach(function (m) {
      if (m.getSource('editor-attr-hl-src')) return;
      try {
        m.addSource('editor-attr-hl-src', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
        m.addLayer({ id: 'editor-attr-hl-fill', type: 'fill', source: 'editor-attr-hl-src', filter: ['==', '$type', 'Polygon'], paint: { 'fill-color': '#ffd400', 'fill-opacity': 0.3 } });
        m.addLayer({ id: 'editor-attr-hl-line', type: 'line', source: 'editor-attr-hl-src', paint: { 'line-color': '#ff8c00', 'line-width': 3 } });
        m.addLayer({ id: 'editor-attr-hl-pt', type: 'circle', source: 'editor-attr-hl-src', filter: ['==', '$type', 'Point'], paint: { 'circle-radius': 9, 'circle-color': '#ffd400', 'circle-stroke-color': '#ff8c00', 'circle-stroke-width': 3 } });
        // hover overlay (cyan) — rides ABOVE the yellow selection so the brushed feature reads clearly
        m.addSource('editor-attr-hover-src', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
        m.addLayer({ id: 'editor-attr-hover-fill', type: 'fill', source: 'editor-attr-hover-src', filter: ['==', '$type', 'Polygon'], paint: { 'fill-color': '#00e5ff', 'fill-opacity': 0.25 } });
        m.addLayer({ id: 'editor-attr-hover-line', type: 'line', source: 'editor-attr-hover-src', paint: { 'line-color': '#00b8d4', 'line-width': 3.5 } });
        m.addLayer({ id: 'editor-attr-hover-pt', type: 'circle', source: 'editor-attr-hover-src', filter: ['==', '$type', 'Point'], paint: { 'circle-radius': 10, 'circle-color': '#00e5ff', 'circle-opacity': 0.5, 'circle-stroke-color': '#00b8d4', 'circle-stroke-width': 3 } });
      } catch (e) {}
    });
  }
  function updateAttrHighlight() {
    ensureAttrHlLayers();
    var feats = _attrSel.map(function (fid) { var r = findAttrRow(fid); return (r && r.geom) ? { type: 'Feature', geometry: r.geom, properties: {} } : null; }).filter(Boolean);
    attrMaps().forEach(function (m) { try { var src = m.getSource('editor-attr-hl-src'); if (src) src.setData({ type: 'FeatureCollection', features: feats }); } catch (e) {} });
  }
  function clearAttrHighlight() {
    _attrSel = [];
    attrMaps().forEach(function (m) { try { var src = m.getSource('editor-attr-hl-src'); if (src) src.setData({ type: 'FeatureCollection', features: [] }); } catch (e) {} });
  }
  // ---- hover brushing: row ↔ map feature light up together ----
  function setAttrHover(fid, scroll) {
    fid = fid ? String(fid) : null;
    if (_attrHover === fid) return;
    _attrHover = fid;
    var tbody = document.getElementById('editor-attr-tbody');
    if (tbody) {
      Array.prototype.forEach.call(tbody.querySelectorAll('tr[data-fid]'), function (tr) { tr.classList.toggle('attr-row-hover', tr.getAttribute('data-fid') === _attrHover); });
      if (scroll && _attrHover) { var row = tbody.querySelector('tr[data-fid="' + _attrHover + '"]'); if (row) row.scrollIntoView({ block: 'nearest' }); }
    }
    ensureAttrHlLayers();
    var hdata = (function () { var r = _attrHover && findAttrRow(_attrHover); return (r && r.geom) ? { type: 'Feature', geometry: r.geom, properties: {} } : { type: 'FeatureCollection', features: [] }; })();
    attrMaps().forEach(function (m) { try { var src = m.getSource('editor-attr-hover-src'); if (src) src.setData(hdata); } catch (e) {} });
  }
  function ensureAttrMapHover() {   // wire the map → row direction once
    if (_attrHoverWired || typeof beforeMap === 'undefined' || !beforeMap) return;
    _attrHoverWired = true;
    beforeMap.on('mousemove', attrMapHover);
    beforeMap.on('mouseout', function () { setAttrHover(null, false); });
  }
  function attrMapHover(e) {   // throttle to one hit-test per frame
    if (!_attrSlug) return;
    _attrLastPt = e.point;
    if (_attrHoverRAF) return;
    _attrHoverRAF = true;
    requestAnimationFrame(function () { _attrHoverRAF = false; attrMapHoverHit(_attrLastPt); });
  }
  function attrMapHoverHit(pt) {
    if (!_attrSlug || !pt) return;
    var fid = null;
    try {
      var b = 4, rf = beforeMap.queryRenderedFeatures([[pt.x - b, pt.y - b], [pt.x + b, pt.y + b]]) || [];   // small buffer box so tiny points / thin lines are easy to catch
      for (var i = 0; i < rf.length; i++) {
        var f = rf[i], pid = f.properties && f.properties.id;
        // MapboxDraw feature (small layer): its id rides as properties.id = 'db-<feature_id>'
        if (typeof pid === 'string' && pid.indexOf('db-') === 0 && _attrById[pid.slice(3)]) { fid = pid.slice(3); break; }
        // engine layer for THIS layer (large): the rendered layer id starts with the slug + the feature carries id = feature_id
        if (f.layer && f.layer.id && f.layer.id.indexOf(_attrSlug) === 0 && f.id != null && _attrById[String(f.id)]) { fid = String(f.id); break; }
      }
    } catch (e) {}
    setAttrHover(fid, true);
  }
  function geomsBounds(geoms) {
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    (geoms || []).forEach(function (g) { collectImportCoords(g, function (lng, lat) { if (lng < x0) x0 = lng; if (lat < y0) y0 = lat; if (lng > x1) x1 = lng; if (lat > y1) y1 = lat; }); });
    return isFinite(x0) ? [[x0, y0], [x1, y1]] : null;
  }
  function zoomToAttrSelected() {
    if (!_attrSel.length || typeof beforeMap === 'undefined' || !beforeMap) return;
    var geoms = _attrSel.map(function (fid) { var r = findAttrRow(fid); return r && r.geom; }).filter(Boolean);
    var b = geomsBounds(geoms); if (!b) return;
    try {
      if (b[0][0] === b[1][0] && b[0][1] === b[1][1]) beforeMap.easeTo({ center: b[0], zoom: Math.max(beforeMap.getZoom(), 16) });   // single point
      else beforeMap.fitBounds(b, { padding: 80, maxZoom: 17 });
    } catch (e) {}
  }
  function startAttrPanelDrag(e) {
    if (e.target.id === 'editor-attr-close' || e.target.id === 'editor-attr-zoom') return;   // let those buttons do their thing
    var panel = document.getElementById('editor-attr-panel'); if (!panel) return;
    e.preventDefault();
    var sx = e.clientX, sy = e.clientY, rect = panel.getBoundingClientRect(), ox = rect.left, oy = rect.top;
    function move(ev) {
      panel.style.left = Math.max(0, Math.min(window.innerWidth - 80, ox + (ev.clientX - sx))) + 'px';
      panel.style.top = Math.max(0, Math.min(window.innerHeight - 40, oy + (ev.clientY - sy))) + 'px';
    }
    function up() { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); document.body.style.userSelect = ''; }
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
  }
  function hideAttrModal() { var m = document.getElementById('editor-attr-modal'); if (m) m.style.display = 'none'; _attrSlug = null; setAttrHover(null, false); clearAttrHighlight(); updateAttrZoomBtn(); updateAttrDelBtn(); }
  async function saveAttrCustomCell(fid, key, value) {
    var cf = _attrCustom[fid];
    if (!cf) { cf = _attrCustom[fid] = {}; var row0 = findAttrRow(fid); if (row0) row0.custom_fields = cf; }   // link a fresh object back to the row so re-sort shows the edit
    var v = value.trim();
    if (v === '') delete cf[key];
    else if (/^-?\d+(\.\d+)?$/.test(v)) cf[key] = Number(v);   // keep numbers numeric
    else cf[key] = value;
    setStatus('Saving…');
    try { var r = await db.from('features').update({ custom_fields: Object.keys(cf).length ? cf : null }).eq('feature_id', fid); if (r.error) throw new Error(r.error.message); setStatus('Saved'); }
    catch (e) { setStatus('Save failed'); }
  }
  async function saveAttrCell(fid, field, value) {
    var v = (value === '') ? null : value, upd = {}; upd[field] = v;
    setStatus('Saving…');
    try { var r = await db.from('features').update(upd).eq('feature_id', fid); if (r.error) throw new Error(r.error.message); setStatus('Saved'); }
    catch (e) { setStatus('Save failed'); return; }
    var row = findAttrRow(fid); if (row) row[field] = v;   // keep the in-memory model in sync so a re-sort reflects the edit
    var did = 'db-' + fid, m = featureMeta[did];   // mirror into MapboxDraw meta + the open feature panel
    if (m) {
      if (field === 'label') m.label = v || ''; else if (field === 'description') m.notes = v || '';
      else if (field === 'start_date') m.start = v || ''; else if (field === 'end_date') m.end = v || '';
      if (selectedDrawId === did) showFeaturePanel(did);
    }
  }
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
    if (document.getElementById('layers-panel-content')) { injectChrome(); enhanceRows(); loadProjectChrome(); setupInPlaceEditing(); var _mtries = 0; var _miv = setInterval(function () { patchMapsRender(); var sec = document.getElementById('base-maps-section'); var has = sec && sec.querySelector('.layer-list-row'); if (has) { injectMapsChrome(); enhanceMapRows(); } if ((window.__mapsRenderPatched && has) || ++_mtries > 30) clearInterval(_miv); }, 400); }
    else setTimeout(whenReady, 150);
  })();
  (function waitForMap() {
    if (typeof beforeMap !== 'undefined' && beforeMap && typeof MapboxDraw !== 'undefined') setupDraw();
    else setTimeout(waitForMap, 250);
  })();
})();
