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
      source_type: isTilesUrl ? "vector-tiles-url" : (src.url ? "mapbox-tileset" : null),
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
  function makeNode(type, name) {
    var id = uid();
    if (type === 'section') return { type: 'section', id: id, label: name, caretId: 'caret-' + id, containerId: 'cont-' + id, children: [] };
    if (type === 'group')   return { type: 'group', id: id, label: name, caretId: 'caret-' + id, containerId: 'cont-' + id, itemSelector: '.' + id + '_item', children: [], checked: true, collapsed: false };
    return { id: id, label: name, containerId: 'cont-' + id, className: id, topLayerClass: id, iconType: 'square', iconColor: '#4a9eff', isSolid: true, checked: true };
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
      '#editor-save-status{font-size:11px;color:#8a99a8;padding:2px 6px;min-height:13px;}';
    document.head.appendChild(style);
    var status = document.createElement('div'); status.id = 'editor-save-status';
    var bar = document.createElement('div'); bar.id = 'editor-add-bar';
    panel.parentNode.insertBefore(status, panel.nextSibling);
    panel.parentNode.insertBefore(bar, status.nextSibling);
    showButtons();
  }

  start();
  (function whenReady() {
    if (document.getElementById('layers-panel-content')) injectChrome();
    else setTimeout(whenReady, 150);
  })();
})();
