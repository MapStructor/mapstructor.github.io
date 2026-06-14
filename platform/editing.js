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
      (bundle.projectLayers || []).forEach(function (pl) { if (pl.layers && pl.layers.slug != null) slugToLayerDbId[pl.layers.slug] = pl.layers.id; if (pl.sort_order > maxSort) maxSort = pl.sort_order; });
      if (typeof layers !== 'undefined') attachIds(layers, sMap, gMap);
      nextSort = maxSort + 1;
      loaded = true;
    } catch (e) { console.warn('editing: could not load project ids', e); }
  }
  // Stamp the db id onto each existing container node so we can nest under it.
  function attachIds(arr, sMap, gMap) {
    (arr || []).forEach(function (n) {
      if (n.type === 'section' && sMap[n.id] != null) n._dbId = sMap[n.id];
      else if (n.type === 'group' && gMap[n.id] != null) n._dbId = gMap[n.id];
      if (n.children) attachIds(n.children, sMap, gMap);
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
    var hasKids = node.children && node.children.length;
    if (!window.confirm('Delete "' + (node.label || node.id) + '"' + (hasKids ? ' and everything inside it' : '') + '?')) return;
    if (idsReady) { try { await idsReady; } catch (e) {} }
    setStatus('Saving…');
    try {
      // Surgical: delete only this subtree's rows; existing siblings are untouched.
      var acc = { sections: [], groups: [], layerIds: [] };
      collectDbIds(node, acc);
      if (acc.layerIds.length) { var d = await db.from('project_layers').delete().eq('project_id', projectId).in('layer_id', acc.layerIds); if (d.error) throw new Error(d.error.message); }
      if (acc.groups.length)   { var dg = await db.from('layer_groups').delete().in('id', acc.groups); if (dg.error) throw new Error(dg.error.message); }
      if (acc.sections.length) { var ds = await db.from('layer_sections').delete().in('id', acc.sections); if (ds.error) throw new Error(ds.error.message); }
      removeFromTree(layers, node);
      rerender();
      setStatus('Saved');
    } catch (e) { console.warn('editing: delete failed', e); setStatus('Delete failed: ' + e.message); }
  }
  async function onRename(id) {
    var node = findNodeById(layers, id); if (!node) return;
    var name = window.prompt('Rename:', node.label || '');
    if (name == null) return; name = name.trim(); if (!name) return;
    if (idsReady) { try { await idsReady; } catch (e) {} }
    setStatus('Saving…');
    try {
      if (node.type === 'section')      { var rs = await db.from('layer_sections').update({ name: name }).eq('id', node._dbId); if (rs.error) throw new Error(rs.error.message); }
      else if (node.type === 'group')   { var rg = await db.from('layer_groups').update({ name: name }).eq('id', node._dbId); if (rg.error) throw new Error(rg.error.message); }
      else { var lid = slugToLayerDbId[node.id]; if (lid) { var rl = await db.from('layers').update({ name: name }).eq('id', lid); if (rl.error) throw new Error(rl.error.message); } }
      node.label = name;
      rerender();
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
    bar.innerHTML = '<div class="erow">' +
      '<button data-type="layer">+ Layer</button>' +
      '<button data-type="group">+ Group</button>' +
      '<button data-type="section">+ Section</button></div>';
    bar.querySelectorAll('button').forEach(function (b) { b.addEventListener('click', function () { showForm(b.getAttribute('data-type')); }); });
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
      '.layer-list-row.editor-active{background:rgba(74,158,255,0.12);}';
    document.head.appendChild(style);
    var status = document.createElement('div'); status.id = 'editor-save-status';
    var bar = document.createElement('div'); bar.id = 'editor-add-bar';
    panel.parentNode.insertBefore(status, panel.nextSibling);
    panel.parentNode.insertBefore(bar, status.nextSibling);
    showButtons();
  }

  // ── Slice 4: drawing (mapbox-gl-draw → the `features` table) ─────────────────
  var draw = null;
  var activeLayerId = null;
  var featureToDb = {};   // mapbox-draw feature id → features.feature_id
  var GEOM_TO_TYPE = { Point: 'circle', LineString: 'line', Polygon: 'fill' };
  var TYPE_TO_GEOM = { circle: 'point', line: 'line', fill: 'polygon' };
  var GEOM_TO_ICON = { Point: 'circle', LineString: 'slash', Polygon: 'draw-polygon' };

  // Each drawn feature carries its layer's color in properties.color (exposed by
  // MapboxDraw as user_color); inactive features paint by it, active (editing)
  // features highlight orange. Mirrors mapbox-gl-draw's default style shape.
  var COLOR = ['coalesce', ['get', 'user_color'], '#3bb2d0'];
  var DRAW_STYLES = [
    { id: 'gl-draw-polygon-fill-inactive', type: 'fill', filter: ['all', ['==', 'active', 'false'], ['==', '$type', 'Polygon'], ['!=', 'mode', 'static']], paint: { 'fill-color': COLOR, 'fill-outline-color': COLOR, 'fill-opacity': 0.35 } },
    { id: 'gl-draw-polygon-fill-active', type: 'fill', filter: ['all', ['==', 'active', 'true'], ['==', '$type', 'Polygon']], paint: { 'fill-color': '#fbb03b', 'fill-outline-color': '#fbb03b', 'fill-opacity': 0.25 } },
    { id: 'gl-draw-polygon-stroke-inactive', type: 'line', filter: ['all', ['==', 'active', 'false'], ['==', '$type', 'Polygon'], ['!=', 'mode', 'static']], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': COLOR, 'line-width': 2 } },
    { id: 'gl-draw-polygon-stroke-active', type: 'line', filter: ['all', ['==', 'active', 'true'], ['==', '$type', 'Polygon']], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#fbb03b', 'line-dasharray': [0.2, 2], 'line-width': 2 } },
    { id: 'gl-draw-line-inactive', type: 'line', filter: ['all', ['==', 'active', 'false'], ['==', '$type', 'LineString'], ['!=', 'mode', 'static']], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': COLOR, 'line-width': 2 } },
    { id: 'gl-draw-line-active', type: 'line', filter: ['all', ['==', '$type', 'LineString'], ['==', 'active', 'true']], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#fbb03b', 'line-dasharray': [0.2, 2], 'line-width': 2 } },
    { id: 'gl-draw-polygon-and-line-vertex-halo-active', type: 'circle', filter: ['all', ['==', 'meta', 'vertex'], ['==', '$type', 'Point'], ['!=', 'mode', 'static']], paint: { 'circle-radius': 5, 'circle-color': '#fff' } },
    { id: 'gl-draw-polygon-and-line-vertex-active', type: 'circle', filter: ['all', ['==', 'meta', 'vertex'], ['==', '$type', 'Point'], ['!=', 'mode', 'static']], paint: { 'circle-radius': 3, 'circle-color': '#fbb03b' } },
    { id: 'gl-draw-polygon-midpoint', type: 'circle', filter: ['all', ['==', '$type', 'Point'], ['==', 'meta', 'midpoint']], paint: { 'circle-radius': 3, 'circle-color': '#fbb03b' } },
    { id: 'gl-draw-point-inactive', type: 'circle', filter: ['all', ['==', 'active', 'false'], ['==', '$type', 'Point'], ['==', 'meta', 'feature'], ['!=', 'mode', 'static']], paint: { 'circle-radius': 5, 'circle-color': COLOR, 'circle-stroke-width': 1.5, 'circle-stroke-color': '#000' } },
    { id: 'gl-draw-point-active', type: 'circle', filter: ['all', ['==', '$type', 'Point'], ['==', 'active', 'true'], ['==', 'meta', 'feature']], paint: { 'circle-radius': 6, 'circle-color': '#fbb03b' } },
  ];

  function setActiveLayer(id) {
    activeLayerId = id;
    var panel = document.getElementById('layers-panel-content'); if (!panel) return;
    panel.querySelectorAll('.layer-list-row.editor-active').forEach(function (el) { el.classList.remove('editor-active'); });
    panel.querySelectorAll('.layer-list-row[data-node-id="' + id + '"]').forEach(function (row) { row.classList.add('editor-active'); });
  }
  function activeLayerDbId() {
    if (!activeLayerId) return null;
    var node = findNodeById(layers, activeLayerId);
    if (!node || node.source_type !== 'geojson-supabase') return null;     // only drawable layers
    return slugToLayerDbId[activeLayerId] || null;
  }
  function setupDraw() {
    if (draw || typeof MapboxDraw === 'undefined' || typeof beforeMap === 'undefined' || !beforeMap) return;
    draw = new MapboxDraw({ displayControlsDefault: false, controls: { point: true, line_string: true, polygon: true, trash: true }, styles: DRAW_STYLES });
    beforeMap.addControl(draw, 'top-right');
    beforeMap.on('draw.create', onDrawCreate);
    beforeMap.on('draw.update', onDrawUpdate);
    beforeMap.on('draw.delete', onDrawDelete);
    loadFeatures();
  }
  async function onDrawCreate(e) {
    var f = e.features && e.features[0]; if (!f) return;
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
      if (draw && node.iconColor) draw.setFeatureProperty(f.id, 'color', node.iconColor);  // paint in the layer's color
      setStatus('Saved');
    } catch (err) { console.warn('editing: feature save failed', err); setStatus('Draw save failed: ' + err.message); }
  }
  async function onDrawUpdate(e) {
    for (var i = 0; i < (e.features || []).length; i++) {
      var f = e.features[i], fid = featureToDb[f.id]; if (!fid) continue;
      try { await db.from('features').update({ geom: f.geometry }).eq('feature_id', fid); } catch (err) { console.warn('feature update failed', err); }
    }
    setStatus('Saved');
  }
  async function onDrawDelete(e) {
    for (var i = 0; i < (e.features || []).length; i++) {
      var f = e.features[i], fid = featureToDb[f.id]; if (!fid) continue;
      try { await db.from('features').delete().eq('feature_id', fid); delete featureToDb[f.id]; } catch (err) { console.warn('feature delete failed', err); }
    }
    setStatus('Saved');
  }
  async function loadFeatures() {
    if (idsReady) { try { await idsReady; } catch (e) {} }
    if (!draw) return;
    var ids = Object.keys(slugToLayerDbId).map(function (k) { return slugToLayerDbId[k]; });
    if (!ids.length) return;
    // map each drawn layer's db id → its color, so loaded features keep their color
    var dbColor = {};
    (function walk(arr) { (arr || []).forEach(function (n) { if (n.source_type === 'geojson-supabase') { var did = slugToLayerDbId[n.id]; if (did) dbColor[did] = n.iconColor || '#3bb2d0'; } if (n.children) walk(n.children); }); })(layers);
    try {
      var res = await db.from('features').select('feature_id, layer_id, geom').in('layer_id', ids);
      if (res.error) return;
      var feats = [];
      (res.data || []).forEach(function (row) {
        if (!row.geom) return;
        var did = 'db-' + row.feature_id;
        featureToDb[did] = row.feature_id;
        feats.push({ type: 'Feature', id: did, geometry: { type: row.geom.type, coordinates: row.geom.coordinates }, properties: { color: dbColor[row.layer_id] || '#3bb2d0' } });
      });
      draw.set({ type: 'FeatureCollection', features: feats });
    } catch (e) { console.warn('editing: load features failed', e); }
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
