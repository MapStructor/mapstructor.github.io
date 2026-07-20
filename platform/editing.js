/* editing.js — the ONLY editor-specific code, loaded dead-last in editor.html (formerly editor_temp.html, promoted 6/23).
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

  // ── Admin-only Mapbox token + Mapbox tileset (per the multi-library / no-charge principle) ──────────
  // MapLibre is the tokenless standard; Mapbox is an OPTION. On the hosted site only the ADMIN may add
  // token-requiring (mapbox://) sources. The token lives in localStorage ONLY — never the DB (RLS isn't
  // locked down; a stored token would be world-readable). It applies to mapboxgl.accessToken at load +
  // on save, and rides into downloads via the existing token capture (download.js).
  var MB_TOKEN_KEY = 'ms-mapbox-token';
  var MS_ADMINS = ['nittyjee@gmail.com'];   // same client owner-gate as pageEditor / homeCards / admin.html
  var _isAdmin = false;
  function getStoredMapboxToken() { try { return localStorage.getItem(MB_TOKEN_KEY) || ''; } catch (e) { return ''; } }
  function applyStoredMapboxToken() { var t = getStoredMapboxToken(); if (t && window.mapboxgl) { try { mapboxgl.accessToken = t; } catch (e) {} } }

  // ── Sign in (for saving), then load the project's db ids ────────────────────
  function start() {
    if (!db) return;
    applyStoredMapboxToken();
    if (window.MapAuth) {   // resolve admin status → reveal the admin-only add buttons once known (and on auth change)
      var _resolveAdmin = function () {
        try { MapAuth.currentUser().then(function (u) {
          var was = _isAdmin;
          _isAdmin = !!(u && u.email && MS_ADMINS.indexOf(u.email) !== -1);
          if (_isAdmin !== was && document.getElementById('editor-add-bar')) showButtons();
        }).catch(function () {}); } catch (e) {}
      };
      _resolveAdmin(); try { MapAuth.onChange(_resolveAdmin); } catch (e) {}
    }
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
  function rerender() {
    if (typeof generateLayersPanel !== 'function') return;
    // generateLayersPanel rebuilds every checkbox from the SAVED default (layerData.checked), which
    // silently reset session toggles — layers "suddenly turned on" after any style change. Capture the
    // live checkbox states and restore them after the rebuild so a rerender never changes visibility.
    var live = {};
    var root = document.getElementById('layers-panel-content');
    if (root) root.querySelectorAll('input[type=checkbox][id]').forEach(function (cb) { live[cb.id] = cb.checked; });
    generateLayersPanel();
    var root2 = document.getElementById('layers-panel-content');
    if (root2) root2.querySelectorAll('input[type=checkbox][id]').forEach(function (cb) { if (cb.id in live) cb.checked = live[cb.id]; });
  }
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
    var col = nextColor();
    // panel default mirrors configLoader's notesEligible synthesis — WITHOUT it, features drawn into a
    // brand-new layer show no info-panel preview until the next full reload re-synthesizes the config
    var pnl = { mode: 'notes', color: col };
    try { if (window.renderRegistry && window.renderRegistry._notes) pnl.render = window.renderRegistry._notes; } catch (e) {}
    return { id: id, label: name, containerId: 'cont-' + id, className: id, topLayerClass: id, iconType: 'square', iconColor: col, isSolid: true, checked: true, source_type: 'geojson-supabase', panel: pnl };
  }
  // A tileset layer is an engine-shaped leaf backed by a hosted vector source (NOT geojson-supabase,
  // so MapboxDraw never touches it and leafRow derives source_type 'mapbox-tileset' from source.url).
  var TILESET_ICON = { fill: 'square', line: 'slash', circle: 'circle' };
  function tilesetDefaultPaint(type, color) {
    if (type === 'fill') return { 'fill-color': color, 'fill-opacity': 0.4, 'fill-outline-color': color };
    if (type === 'line') return { 'line-color': color, 'line-width': 1.5 };
    return { 'circle-radius': 6, 'circle-color': color, 'circle-stroke-width': 1.5, 'circle-stroke-color': '#ffffff' };   // white ring = classic marker look, reads on any basemap
  }
  function makeTilesetNode(name, url, sourceLayer, type, color) {
    var id = uid();
    // mirrors onApplySource's detection: mapbox:// is a single style url; anything else (worker /
    // PMTiles {z}/{x}/{y} endpoints) is a tiles-array source, saved as source_type 'vector-tiles-url'
    var isMapbox = url.indexOf('mapbox://') === 0;
    var source = isMapbox ? { type: 'vector', url: url } : { type: 'vector', tiles: [url] };
    var node = { id: id, label: name, type: type, source: source, paint: tilesetDefaultPaint(type, color),
      containerId: 'cont-' + id, className: id, topLayerClass: id, iconType: TILESET_ICON[type] || 'square', iconColor: color, isSolid: true, checked: true, toggleElement: id };
    if (sourceLayer) node['source-layer'] = sourceLayer;
    // same default hover/click highlight a reload would synthesize (configLoader): tileset FILLS
    // hover inline (marker `true` — the fill itself dims via addLayers.hoverInlinePaint); lines and
    // circles get the overlay twin — so it works the moment the tileset is added
    try { node.highlight = (type === 'fill') ? true : ((window.ConfigLoader && ConfigLoader.defaultHighlightPaint) ? ConfigLoader.defaultHighlightPaint(type, color) : null); } catch (e) {}
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
  async function onDelete(id, skipConfirm) {   // skipConfirm: the layer panel's in-panel Yes/No already asked
    var node = findNodeById(layers, id); if (!node) return;
    var isContainer = node.type === 'section' || node.type === 'group';
    var kids = isContainer && node.children && node.children.length;
    if (!skipConfirm && !window.confirm('Delete "' + (node.label || node.id) + '"?' + (kids ? ' Its contents will move out — they are NOT deleted.' : ''))) return;
    if (idsReady) { try { await idsReady; } catch (e) {} }
    setStatus('Saving…');
    try {
      if (isContainer) {
        // Ungroup: splice the children into the container's place, then delete ONLY
        // the container row. persistOrder re-parents the children + renumbers.
        var loc = locate(layers, node);
        var kidsMoved = (node.children || []).slice();          // capture for undo
        var parentSecId = null;                                  // a group's owning section (for undo re-insert)
        if (node.type === 'group') { var gp = findParent(layers, node); if (gp && gp.type === 'section') parentSecId = gp._dbId; }
        if (loc) loc.arr.splice.apply(loc.arr, [loc.idx, 1].concat(node.children || []));
        else removeFromTree(layers, node);
        if (node._dbId) { var dc = await db.from(node.type === 'group' ? 'layer_groups' : 'layer_sections').delete().eq('id', node._dbId); if (dc.error) throw new Error(dc.error.message); }
        rerender();
        await persistOrder();
        // Undoable: re-create the container DB row (new id), move its children back under it,
        // restore it to its slot, then re-persist. Redo re-runs the same ungroup+delete.
        (function (cnode, ctype, kids, arr, idx, secId) {
          var table = ctype === 'group' ? 'layer_groups' : 'layer_sections';
          async function readd() {
            try {
              if (ctype === 'section') cnode._dbId = await insertOne(table, sectionRow(cnode, idx));
              else cnode._dbId = await insertOne(table, groupRow(cnode, secId, idx));
            } catch (e) {}
            kids.forEach(function (k) { removeFromTree(layers, k); });   // pull them back out of wherever they landed
            cnode.children = kids;
            var a = arr || layers; a.splice(Math.min(idx, a.length), 0, cnode);
            rerender(); await persistOrder();
          }
          async function reremove() {
            var l2 = locate(layers, cnode);
            if (l2) l2.arr.splice.apply(l2.arr, [l2.idx, 1].concat(cnode.children || []));
            else removeFromTree(layers, cnode);
            if (cnode._dbId) { try { await db.from(table).delete().eq('id', cnode._dbId); } catch (e) {} }
            rerender(); await persistOrder();
          }
          pushUndo(readd, reremove, 'delete ' + (cnode.label || ctype));
        })(node, node.type, kidsMoved, loc ? loc.arr : layers, loc ? loc.idx : 0, parentSecId);
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
  async function commitRename(id, name) {
    var node = findNodeById(layers, id); if (!node) return;
    var oldName = node.label || '';
    name = (name || '').trim(); if (!name || name === oldName) return;
    if (idsReady) { try { await idsReady; } catch (e) {} }
    setStatus('Saving…');
    try {
      await setNodeName(id, name);
      pushUndo(function () { return setNodeName(id, oldName); }, function () { return setNodeName(id, name); }, 'rename');
      if (activeLayerId === id) {   // keep the open panel's title + name field in sync (both null-guarded)
        var t9 = document.getElementById('elp-title'); if (t9) t9.textContent = name;
        var n9 = document.getElementById('elp-name'); if (n9 && n9.value !== name) n9.value = name;
      }
      setStatus('Saved');
    } catch (e) { console.warn('editing: rename failed', e); setStatus('Rename failed: ' + e.message); }
  }
  // Double-click a row's name → rename IN PLACE (no dialog): the label becomes editable right there;
  // Enter or click-away saves, Esc cancels. (The panel's top Name field edits the same thing.)
  function startInlineRename(label, id) {
    var node = findNodeById(layers, id); if (!node || label._msRenaming) return;
    label._msRenaming = true;
    var oldName = node.label || '';
    label.textContent = oldName;   // strip the engine's spacing <div> while editing; rerender rebuilds it after
    label.setAttribute('contenteditable', 'true'); label.setAttribute('spellcheck', 'false');
    label.style.outline = '1px dashed #7c5cbf'; label.style.outlineOffset = '2px';
    try { var sel = window.getSelection(), rng = document.createRange(); rng.selectNodeContents(label); sel.removeAllRanges(); sel.addRange(rng); } catch (e) {}
    label.focus();
    var done = false;
    function finish(save) {
      if (done) return; done = true;
      var name = (label.textContent || '').trim();
      label.removeAttribute('contenteditable'); label.style.outline = ''; label._msRenaming = false;
      if (save && name && name !== oldName) commitRename(id, name);
      else { try { rerender(); } catch (e) { label.textContent = oldName; } }   // restore the row's exact structure
    }
    label.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
    });
    label.addEventListener('blur', function () { finish(true); }, { once: true });
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
  window.__msEditorAttr = true;   // generateLayers renders the per-row ▦ attribute-table icon when set
  if (!window.__msAttrBtnWired) {
    window.__msAttrBtnWired = true;
    document.addEventListener('click', function (e) {
      var t = e.target && e.target.closest && e.target.closest('.attr-table-btn'); if (!t) return;
      e.stopPropagation(); e.preventDefault();
      var row = t.closest('.layer-list-row'); if (!row) return;
      var cb = row.querySelector('input[type="checkbox"]');
      if (cb && cb.id) openFeaturesList(cb.id);   // the icon now opens the LIST; "Expand" in the list opens the full table
    }, true);
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
      // click the row body (not a control) to open the panel / make it the active draw target.
      // In EDIT mode ONLY the checkbox toggles visibility — a label click must not ALSO flip the
      // checkbox (it used to do both at once), so cancel the label's native for= activation.
      row.addEventListener('click', function (e) {
        if (e.target.closest('input,.layer-buttons-block,.editor-del,.editor-setzoom,.compress-expand-icon,.toggle')) return;
        if (e.target.closest('label')) e.preventDefault();
        setActiveLayer(id);
      });
      var enNode = findNodeById(layers, id);
      var enCb = row.querySelector('input[type="checkbox"]');
      // Checkbox toggles are SESSION-ONLY (defaults are set explicitly in each item's panel — see
      // elp-default-vis). Drawn layers need their MapboxDraw copies toggled by hand; group/section
      // checkboxes must cascade to them too (the engine only flips child checkbox props — no events).
      if (enNode && enCb && enNode.type !== 'group' && enNode.type !== 'section') {
        if (enNode.source_type === 'geojson-supabase') enCb.addEventListener('change', function () { toggleDrawnLayer(id, enCb.checked); });
      } else if (enNode && enCb) {
        enCb.addEventListener('change', function () {
          var on = enCb.checked;
          (function walk(n) {
            (n.children || []).forEach(function (c) {
              if (c.type === 'group' || c.type === 'section') { walk(c); return; }
              if (c.source_type === 'geojson-supabase') toggleDrawnLayer(c.id, on);
            });
          })(enNode);
        });
      }
      // #4: inline × removed for layers, groups AND sections — delete now lives inside the item's edit panel
      // (showLayerPanel → "Delete this item…"; sections get a minimal title+Delete panel).
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
      if (label) label.addEventListener('dblclick', function (e) { e.stopPropagation(); e.preventDefault(); startInlineRename(label, id); });

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
      if (parent) { parent.children = parent.children || []; parent.children.push(node); parent.collapsed = false; parent.open = true; if (parent.type === 'group') node.topLayerClass = parent.id; }   // group children need the group's _item class for the ± caret
      else layers.push(node);
      rerender();
      if (type === 'layer') setActiveLayer(node.id, { noPanel: true });  // draw into the layer you just made — creating a layer (+Layer or draw auto-create) never pops the style panel; only CLICKING a layer opens it
      setStatus('Saved');
      return node;
    } catch (e) {
      console.warn('editing: add failed', e);
      setStatus('Save failed: ' + e.message);
      return null;
    }
  }

  // Add a hosted vector tileset as a first-class layer (persist like addItem's leaf branch,
  // then render it on both maps the way the engine does at load).
  async function addTileset(name, url, sourceLayer, type, parent) {
    if (typeof layers === 'undefined') return;
    if (idsReady) { try { await idsReady; } catch (e) {} }
    if (!loaded) { setStatus('Still loading — try again'); return; }
    var node = makeTilesetNode(name, url, sourceLayer, type, nextColor());
    var _wireNew = function () { try { if (typeof window.wireLayerInteraction === 'function') window.wireLayerInteraction(node); } catch (e) {} };   // hover/highlight events for the just-added layer (boot wiring already ran)
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
      _wireNew();
      if (typeof refreshLayers === 'function') refreshLayers();  // sync visibility to the new checkbox
      setActiveLayer(node.id);   // open its style panel (color/opacity/outline/width + Split for fills)
      setStatus('Saved');
    } catch (e) { console.warn('editing: add tileset failed', e); setStatus('Save failed: ' + e.message); }
  }
  // Mirror addLayersToMap for a single node: add <id>-left / <id>-right on both maps via the
  // engine's addMapLayer (same call the viewer uses), filtered by the current timeline date.
  // A fill's outline renders as a separate line layer at every width EXCEPT exactly 1 — width 1 is
  // mapbox's own native fill-outline (identical to plain mapboxgl); anything else (thinner 0.5
  // DEFAULT, thicker 2+, or a by-column expression) needs the line layer to express it. When the
  // companion exists it OWNS the outline, so the fill's own outline goes transparent (widths read
  // exactly, not width+1).
  var FILL_BORDER_DEFAULT = 0.5;
  function fillStrokeWanted(paint) {
    if (!paint || !paint['fill-outline-color']) return false;
    var w = paint['line-width'] != null ? paint['line-width'] : FILL_BORDER_DEFAULT;
    return typeof w !== 'number' || w !== 1;
  }
  function fillEffectivePaint(paint) {   // the fill layer's own paint, with the outline blanked when a companion (or "outline off") covers it
    if (!paint) return paint;
    var hideNative = fillStrokeWanted(paint) || paint['line-opacity'] === 0;
    return hideNative ? Object.assign({}, paint, { 'fill-outline-color': 'rgba(0,0,0,0)' }) : paint;
  }
  function editorCurrentDate() {   // the timeline's date as YYYYMMDD, for addMapLayer's filter
    try { var d = (window.moment && window.$) ? moment($('#date').text()).format('YYYYMMDD') : ''; return /^\d{8}$/.test(d) ? parseInt(d, 10) : undefined; } catch (e) { return undefined; }
  }
  function renderTilesetOnMap(node) {
    if (typeof addMapLayer !== 'function') return;
    var date = editorCurrentDate();
    [['left', beforeMap], ['right', (typeof afterMap !== 'undefined' ? afterMap : null)]].forEach(function (pair) {
      var side = pair[0], map = pair[1]; if (!map) return;
      var id = node.id + '-' + side;
      try {
        if (!map.getLayer(id)) {
          var ep = (node.type === 'fill') ? fillEffectivePaint(node.paint) : node.paint;
          if (node.type === 'fill' && typeof hoverInlinePaint === 'function') ep = hoverInlinePaint(node, ep);   // inline hover-dim, same as the engine at load
          addMapLayer(map, Object.assign({}, node, { id: id, paint: ep }), date);
        }
      }
      catch (e) { console.warn('editing: tileset render failed', e); }
      // a fill tileset's THICKER-than-native outline renders as a real line layer (sharing the
      // fill's source) so it can exceed Mapbox's 1px fill-outline cap; width 1 stays native.
      if (node.type === 'fill' && fillStrokeWanted(node.paint)) {
        var sid = node.id + '-stroke-' + side;
        if (!map.getLayer(sid)) {
          var sc = { id: sid, type: 'line', source: id, paint: { 'line-color': node.paint['fill-outline-color'], 'line-width': node.paint['line-width'] != null ? node.paint['line-width'] : FILL_BORDER_DEFAULT, 'line-opacity': node.paint['line-opacity'] != null ? node.paint['line-opacity'] : 1 }, layout: { 'line-cap': 'round', 'line-join': 'round' } };
          if (node['source-layer']) sc['source-layer'] = node['source-layer'];
          try { addMapLayer(map, sc, date); } catch (e) { console.warn('editing: tileset stroke failed', e); }
        }
      }
      // hover/click highlight companion — mirrors the engine's addLayersToMap block, so a tileset
      // added IN-SESSION highlights like it will after a reload (`true` = inline hover, no overlay)
      if (node.highlight && node.highlight !== true && !map.getLayer(node.id + '-highlighted-' + side)) {
        var hp = (typeof highlightSelectablePaint === 'function') ? highlightSelectablePaint(node.highlight) : node.highlight;
        var hc = { id: node.id + '-highlighted-' + side, type: node.type, source: id, paint: hp };
        if (node['source-layer']) hc['source-layer'] = node['source-layer'];
        try { addMapLayer(map, hc, date); } catch (e) {}
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
      window._msOrigHandlePanelClick = _origHPC;   // enterEngineEdit falls back to this for display-only features (their click must still open the viewer's panel)
      window.handlePanelClick = function (layer, event) {
        // ALSO suppress for small drawn layers (their features live in MapboxDraw): if the engine copy is
        // ever visible/clickable (e.g. it rendered after hideDrawnEngineLayers ran), the engine's panel
        // toggle runs IN PARALLEL with the editor's — its second-click closePanelInfo slideUp collapses
        // the info panel the editor just opened (the vanishing-panel-on-second-click bug).
        try { var n = findNodeById(layers, layer && layer.id); if (n && (isEngineEditable(n) || _drawLayerSlugs[n.id])) return; } catch (e) {}
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
            // 10px grab corridor (user 7/16 + widened 7/17: thin lines are brutal to click exactly) —
            // the box returns candidates ordered by render order; nearest-enough beats pixel-perfect
            var bx = 10, fs;
            try { fs = mm.queryRenderedFeatures([[e.point.x - bx, e.point.y - bx], [e.point.x + bx, e.point.y + bx]], { layers: lids }); } catch (err) { return; }
            if (fs && fs.length) found = fs;
          });
          if (!found) return;
          // NEAREST candidate wins — render order picks the wrong line at crossings/parallels
          var hit = (typeof nearestFeature === 'function' && nearestFeature(found, e.point)) || found[0];
          var node = findNodeById(layers, hit.layer.id.replace(/-(left|right)$/, ''));
          if (node) onEngineFeatureClick(node, { features: [hit].concat(found.filter(function (f) { return f !== hit; })), lngLat: e.lngLat });
        });
      });
    }
  }
  function onEngineFeatureClick(node, e) {
    if (!e.features || !e.features.length) return;
    var fid = e.features[0].id; if (fid == null) { engineViewerPanel(node, e); return; }   // no tile id → can't edit, but the click still shows the viewer's panel
    enterEngineEdit(node, fid, e);
  }
  // Editor = viewer + tools: when a clicked feature can't be pulled into edit (its data isn't in the
  // edit backend — e.g. a pure Mapbox tileset), the click must still do what the VIEWER does: open the
  // layer's encyclopedia/notes panel. The engine's own click handler is suppressed for engine-editable
  // layers (patched above), so call the ORIGINAL directly.
  function engineViewerPanel(node, e) {
    try {
      if (node && node.panel && typeof window._msOrigHandlePanelClick === 'function' && e && e.features && e.features.length) {
        window._msOrigHandlePanelClick(node, e);
      }
    } catch (err) {}
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

  async function enterEngineEdit(node, fid, clickEvt) {
    var drawId = 'db-' + fid;
    if (draw && draw.get(drawId)) {   // already pulled into draw (re-click via the edited overlay) → stage 1 unless mid-geometry-edit
      if (_editingDraw !== drawId) { _editingDraw = null; _armedSet = [drawId]; try { draw.changeMode('simple_select', { featureIds: [] }); } catch (e) {} updateArmedHl(); }
      showFeaturePanel(drawId); updateGroupHl(drawId); return;
    }
    var lyrId = (typeof slugToLayerDbId !== 'undefined') ? slugToLayerDbId[node.id] : null;
    if (!lyrId) { engineViewerPanel(node, clickEvt); return; }   // this layer's data isn't in our `features` table → not editable, but still show the panel
    // Scope to THIS layer's id. feature_id alone is GLOBAL, so a tile id can collide with an unrelated
    // migrated feature on another layer and "edit" (and hide) the wrong thing — the vanishing-feature bug.
    var EB = getEditBackend(node);   // Phase 2a: read from this layer's edit backend (platform `features` unless the tileset declared its own)
    var wantCustom = EB.table === 'features';   // custom_fields is a platform column — foreign edit backends may not have it
    var res; try { res = await EB.db.from(EB.table).select(EB.idCol + ', ' + EB.layerCol + ', ' + EB.geomCol + ', label, description, start_date, end_date, content_id' + (wantCustom ? ', custom_fields' : '')).eq(EB.idCol, fid).eq(EB.layerCol, lyrId).single(); } catch (e) { res = { error: e }; }
    if (res.error || !res.data || !res.data[EB.geomCol]) { engineViewerPanel(node, clickEvt); return; }   // display-only feature (not in the edit backend) → no edit, but the viewer's panel still opens
    var row = res.data, rowGeom = row[EB.geomCol], origGeom = { type: rowGeom.type, coordinates: rowGeom.coordinates };
    if (origGeom.type === 'MultiPolygon') { _engineWasMulti[drawId] = true; _engineOrigMulti[drawId] = origGeom; }
    var geom = toDrawPolygon(origGeom);   // mapbox-gl-draw needs a Polygon
    featureToDb[drawId] = fid; featureLayer[drawId] = row[EB.layerCol]; _engineEditNode[drawId] = node;
    featureMeta[drawId] = { label: row.label || '', notes: row.description || '', start: row.start_date ? String(row.start_date).slice(0, 10) : '', end: row.end_date ? String(row.end_date).slice(0, 10) : '', pageid: row.content_id != null ? String(row.content_id) : '', custom: row.custom_fields || null };
    _geomSnap[drawId] = JSON.parse(JSON.stringify(geom));
    var epProps = featureProps(node) || {};
    // colorBy layers: the editable copy keeps the FEATURE's own category color (not the layer default)
    try { if (node.colorBy && node.colorBy.mapping && row.custom_fields) { var cbv2 = row.custom_fields[node.colorBy.prop]; var mc2 = cbv2 != null ? node.colorBy.mapping[String(cbv2)] : null; if (mc2) epProps.color = mc2; } } catch (e) {}
    try { draw.add({ type: 'Feature', id: drawId, geometry: geom, properties: epProps }); } catch (e) { setStatus('Edit failed'); return; }
    (_engineEditIds[node.id] = _engineEditIds[node.id] || []); if (_engineEditIds[node.id].indexOf(fid) < 0) _engineEditIds[node.id].push(fid);
    if (_engineEdited[node.id] && _engineEdited[node.id][fid] != null) { delete _engineEdited[node.id][fid]; refreshEditedOverlay(node); }   // pull it back off the overlay while editing
    applyEngineEditFilter(node);   // hide the read-only render of just this feature, so only the editable copy shows
    [['left', beforeMap], ['right', (typeof afterMap !== 'undefined' ? afterMap : null)]].forEach(function (pair) {   // clear any stuck hover-highlight: the tile copy is now filtered out, so the engine's mouseleave won't fire to un-green it (otherwise every clicked feature stays glowing)
      var m = pair[1]; if (!m) return; var tgt = { source: node.id + '-' + pair[0], id: Number(fid) }; if (node['source-layer']) tgt.sourceLayer = node['source-layer'];
      try { m.setFeatureState(tgt, { hover: false }); } catch (e) {}
    });
    // stage 1 (same as drawn features): highlight + panel; the pulled-in draw copy stays UNSELECTED so the
    // geometry is locked — a second click on it goes through draw's own pipeline → stage 2 (editable)
    _editingDraw = null; _armedSet = [drawId];
    try { draw.changeMode('simple_select', { featureIds: [] }); } catch (e) {}
    updateArmedHl();
    showFeaturePanel(drawId);
    updateGroupHl(drawId);
    setStatus('Feature ' + fid + ' — click it again to edit its shape');
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
  // #2: the add buttons NEVER disappear — the bar is split into a persistent button area + a form area
  // below it. Clicking a button fills the form area; clicking another button switches the form mid-action.
  function showButtons() {
    var bar = document.getElementById('editor-add-bar');
    bar.innerHTML = '<div id="editor-add-buttons"><div class="erow" style="margin-bottom:6px;">' +
      '<button data-type="layer">+ Layer</button>' +
      '<button data-type="tileset">+ Tileset</button>' +
      '<button data-type="import">+ Import</button>' +
      '<button data-type="export">⬇ Export</button></div>' +
      '<div class="erow">' +
      '<button data-type="group">+ Group</button>' +
      '<button data-type="section">+ Section</button></div>' +
      // admin-only: Mapbox needs a token, so it's gated to the owner on the hosted site (the multi-library
      // / no-charge principle). Regular users only get the tokenless + Tileset above.
      (_isAdmin ? '<div class="erow" id="editor-admin-add" style="margin-top:6px;border-top:1px dashed #ccc;padding-top:6px;">' +
        '<button data-type="mbtoken" title="Enter your Mapbox access token (admin only, stored in this browser)">🔑 Mapbox token</button>' +
        '<button data-type="mbtileset" title="Add a Mapbox tileset (admin only — uses your token)">+ Mapbox tileset</button></div>' : '') +
      '</div>' +
      '<div id="editor-add-form"></div>';
    bar.querySelectorAll('#editor-add-buttons button').forEach(function (b) { b.addEventListener('click', function () { var t = b.getAttribute('data-type'); markAddActive(t); if (t === 'tileset') showTilesetForm(); else if (t === 'import') showImportForm(); else if (t === 'export') showExportForm(); else if (t === 'mbtoken') showMapboxTokenForm(); else if (t === 'mbtileset') showMapboxTilesetForm(); else showForm(t); }); });
  }
  function markAddActive(type) {   // highlight which add-action's form is open (or none)
    var btns = document.querySelectorAll('#editor-add-buttons button');
    Array.prototype.forEach.call(btns, function (b) { b.classList.toggle('active', b.getAttribute('data-type') === type); });
  }
  function addFormEl() {   // the form area under the persistent buttons; falls back to the bar if chrome is old
    return document.getElementById('editor-add-form') || document.getElementById('editor-add-bar');
  }
  function closeAddForm() { var f = document.getElementById('editor-add-form'); if (f) f.innerHTML = ''; markAddActive(null); }
  // ── export: a layer's saved features → downloadable GeoJSON (the inverse of Import; works for drawn
  //    layers AND tileset layers whose features live in `features`, e.g. Current buildings = 18k rows). ──
  function showExportForm() {
    var bar = addFormEl();   // #2: buttons stay visible
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
    document.getElementById('editor-cancel').addEventListener('click', closeAddForm);
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
        var res = await db.from('features').select('feature_id, geom, label, description, start_date, end_date, content_id, custom_fields, image_url').eq('layer_id', lid).order('feature_id').range(from, from + 999);
        if (res.error) throw new Error(res.error.message);
        var batch = res.data || []; rows = rows.concat(batch);
        if (status) status.textContent = 'Fetched ' + rows.length + ' features…';
        if (batch.length < 1000) break;
      }
      // property order = the layer's attribute-table column order when one is saved (raw_config.attrView),
      // else the default display order (msid first, ms_* last). GeoJSON/KML/DBF all honor insertion order.
      var _custKeys = [];
      rows.forEach(function (r) { if (r.custom_fields) Object.keys(r.custom_fields).forEach(function (k) { if (_custKeys.indexOf(k) < 0) _custKeys.push(k); }); });
      var _ordKeys = (node && node.attrView && node.attrView.order && node.attrView.order.length)
        ? node.attrView.order
        : ['label', 'start_date', 'end_date', 'description', 'content_id'].concat(orderAttrKeys(_custKeys));
      var feats = rows.filter(function (r) { return r.geom; }).map(function (r) {
        var raw = { feature_id: r.feature_id };
        if (r.label) raw.label = r.label;
        if (r.description) raw.description = r.description;
        if (r.start_date) raw.start_date = r.start_date;
        if (r.end_date) raw.end_date = r.end_date;
        if (r.content_id != null) raw.content_id = r.content_id;
        if (r.image_url) raw.image_url = r.image_url;
        if (r.custom_fields && typeof r.custom_fields === 'object') Object.keys(r.custom_fields).forEach(function (k) { if (!(k in raw)) raw[k] = r.custom_fields[k]; });
        var props = { feature_id: raw.feature_id };
        _ordKeys.forEach(function (k) { if (k in raw && !(k in props)) props[k] = raw[k]; });
        Object.keys(raw).forEach(function (k) { if (!(k in props)) props[k] = raw[k]; });
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
    var bar = addFormEl();   // #2: buttons stay visible
    bar.innerHTML =
      '<input id="editor-name" type="text" placeholder="tileset name…" />' +
      '<input id="editor-ts-url" type="text" placeholder="https://…/{z}/{x}/{y}.pbf  or  TileJSON URL" />' +
      '<input id="editor-ts-sl" type="text" list="editor-ts-sl-list" placeholder="source layer (e.g. buildings)" /><datalist id="editor-ts-sl-list"></datalist>' +
      '<div id="editor-ts-sl-status" style="font-size:11px;color:#888888;margin:-3px 0 6px;min-height:13px;"></div>' +
      '<select id="editor-ts-type"><option value="fill">Polygon (fill)</option><option value="line">Line</option><option value="circle">Point (circle)</option></select>' +
      '<select id="editor-parent">' + parentOptions() + '</select>' +
      '<div class="erow"><button id="editor-ok">Add tileset</button><button id="editor-cancel">Cancel</button></div>';
    document.getElementById('editor-name').focus();
    var urlInput = document.getElementById('editor-ts-url');
    // +Tileset is the TOKENLESS path (PMTiles / XYZ / TileJSON). A mapbox:// URL needs an access token,
    // so it's rejected here with an explanation (Mapbox tilesets get their own admin-only button).
    urlInput.addEventListener('change', function () {
      var v = urlInput.value.trim();
      if (isMapboxUrl(v)) { showTilesetMapboxBlock(); return; }
      detectSourceLayers(v);
    });
    document.getElementById('editor-ok').addEventListener('click', commitTileset);
    document.getElementById('editor-cancel').addEventListener('click', closeAddForm);
  }
  function isMapboxUrl(url) { return /^mapbox:\/\//i.test(url || ''); }
  function showTilesetMapboxBlock() {
    var s = document.getElementById('editor-ts-sl-status');
    if (s) { s.innerHTML = "Mapbox tilesets (mapbox://…) can’t be added here — this button is for <b>tokenless</b> tilesets (PMTiles, XYZ, TileJSON). Mapbox tilesets need an access token."; s.style.color = '#b4453a'; }
  }
  function mapboxTilesetId(url) { return (url && url.indexOf('mapbox://') === 0) ? url.slice(9) : null; }
  // Read a mapbox:// tileset's vector layers from its TileJSON and offer them as autocomplete,
  // so the mapmaker doesn't have to know the exact source-layer name. Manual entry still works.
  async function detectSourceLayers(url) {
    var status = document.getElementById('editor-ts-sl-status'), list = document.getElementById('editor-ts-sl-list');
    if (!status || !list) return;
    var id = mapboxTilesetId(url);
    if (!id) { status.textContent = url ? 'Type the source layer (e.g. buildings)' : ''; status.style.color = '#888888'; list.innerHTML = ''; return; }
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
    if (isMapboxUrl(url)) { showTilesetMapboxBlock(); setStatus('Mapbox tilesets aren’t supported here — use the Mapbox tileset button'); return; }
    if (!name || !url || !sl) { setStatus('Name, tileset URL + source layer required'); return; }
    var sel = document.getElementById('editor-parent');
    var parent = (sel && sel.value) ? findNodeById(layers, sel.value) : null;
    showButtons();
    addTileset(name, url, sl, type, parent);
  }

  // ── admin-only: Mapbox token (localStorage) + Mapbox tileset (mapbox:// via that token) ──────────────
  function showMapboxTokenForm() {
    var bar = addFormEl();
    var cur = getStoredMapboxToken();
    bar.innerHTML =
      '<div style="font-size:11px;color:#555;margin-bottom:6px;line-height:1.5;">Your Mapbox <b>public</b> token (pk.…). Stored only in this browser — never uploaded. Used to add Mapbox tilesets and render them here and in your downloads.</div>' +
      '<input id="editor-mbtoken" type="text" placeholder="pk.eyJ…" value="' + String(cur).replace(/"/g, '&quot;') + '" />' +
      '<div id="editor-mbtoken-status" style="font-size:11px;margin:-3px 0 6px;min-height:13px;color:' + (cur ? '#2d7a2d' : '#888') + ';">' + (cur ? 'Token set ✓' : 'No token set') + '</div>' +
      '<div class="erow"><button id="editor-mbtoken-save">Save</button><button id="editor-mbtoken-clear">Clear</button><button id="editor-cancel">Close</button></div>';
    document.getElementById('editor-mbtoken').focus();
    document.getElementById('editor-mbtoken-save').addEventListener('click', saveMapboxToken);
    document.getElementById('editor-mbtoken-clear').addEventListener('click', clearMapboxToken);
    document.getElementById('editor-cancel').addEventListener('click', closeAddForm);
  }
  function saveMapboxToken() {
    var v = (document.getElementById('editor-mbtoken').value || '').trim();
    var s = document.getElementById('editor-mbtoken-status');
    function warn(msg) { if (s) { s.innerHTML = msg; s.style.color = '#b4453a'; } }
    if (!v) { warn('Enter a token, or Clear to remove.'); return; }
    if (/^sk\./i.test(v)) { warn('That’s a <b>secret</b> token (sk.…) — never use it in a browser. Use a <b>public</b> pk. token, URL-restricted to your domains.'); return; }
    if (!/^pk\./i.test(v)) { warn('A Mapbox public token starts with <b>pk.</b> — check the value.'); return; }
    try { localStorage.setItem(MB_TOKEN_KEY, v); } catch (e) {}
    try { if (window.mapboxgl) mapboxgl.accessToken = v; } catch (e) {}
    if (s) { s.textContent = 'Saved ✓ — Mapbox tilesets will use this token.'; s.style.color = '#2d7a2d'; }
  }
  function clearMapboxToken() {
    try { localStorage.removeItem(MB_TOKEN_KEY); } catch (e) {}
    // revert to the committed site token so the basemaps keep rendering
    try { if (window.mapboxgl) mapboxgl.accessToken = (typeof mapboxToken !== 'undefined' ? mapboxToken : (typeof restrictedToken !== 'undefined' ? restrictedToken : mapboxgl.accessToken)); } catch (e) {}
    var i = document.getElementById('editor-mbtoken'); if (i) i.value = '';
    var s = document.getElementById('editor-mbtoken-status'); if (s) { s.textContent = 'Cleared — using the site’s default token.'; s.style.color = '#888'; }
  }
  function showMapboxTilesetForm() {
    var bar = addFormEl();
    var hasTok = !!(getStoredMapboxToken() || (window.mapboxgl && mapboxgl.accessToken));
    bar.innerHTML =
      '<input id="editor-name" type="text" placeholder="tileset name…" />' +
      '<input id="editor-ts-url" type="text" placeholder="mapbox://username.tilesetid" />' +
      '<input id="editor-ts-sl" type="text" list="editor-ts-sl-list" placeholder="source layer (e.g. buildings)" /><datalist id="editor-ts-sl-list"></datalist>' +
      '<div id="editor-ts-sl-status" style="font-size:11px;margin:-3px 0 6px;min-height:13px;color:' + (hasTok ? '#888' : '#b4453a') + ';">' + (hasTok ? '' : 'Set your Mapbox token first (🔑 button).') + '</div>' +
      '<select id="editor-ts-type"><option value="fill">Polygon (fill)</option><option value="line">Line</option><option value="circle">Point (circle)</option></select>' +
      '<select id="editor-parent">' + parentOptions() + '</select>' +
      '<div class="erow"><button id="editor-ok">Add Mapbox tileset</button><button id="editor-cancel">Cancel</button></div>';
    document.getElementById('editor-name').focus();
    var urlInput = document.getElementById('editor-ts-url');
    urlInput.addEventListener('change', function () { detectSourceLayers(urlInput.value.trim()); });   // mapbox:// → read its source layers
    document.getElementById('editor-ok').addEventListener('click', commitMapboxTileset);
    document.getElementById('editor-cancel').addEventListener('click', closeAddForm);
  }
  function commitMapboxTileset() {
    var name = (document.getElementById('editor-name').value || '').trim();
    var url = (document.getElementById('editor-ts-url').value || '').trim();
    var sl = (document.getElementById('editor-ts-sl').value || '').trim();
    var type = document.getElementById('editor-ts-type').value || 'fill';
    var s = document.getElementById('editor-ts-sl-status');
    function warn(msg) { if (s) { s.innerHTML = msg; s.style.color = '#b4453a'; } }
    if (!isMapboxUrl(url)) { warn('This button is for mapbox:// tilesets. For PMTiles / XYZ use <b>+ Tileset</b>.'); return; }
    var tok = getStoredMapboxToken() || (window.mapboxgl && mapboxgl.accessToken) || '';
    if (!tok) { warn('No Mapbox token — set one with the 🔑 button first.'); return; }
    if (!name || !sl) { setStatus('Name, tileset URL + source layer required'); return; }
    try { if (window.mapboxgl) mapboxgl.accessToken = tok; } catch (e) {}   // render the mapbox source with the admin token
    var sel = document.getElementById('editor-parent');
    var parent = (sel && sel.value) ? findNodeById(layers, sel.value) : null;
    showButtons();
    addTileset(name, url, sl, type, parent);
  }

  // ── import: GeoJSON / KML / Shapefile(.zip) → editable geojson-supabase layer(s) ──
  var LIB = { togeojson: 'https://cdn.jsdelivr.net/npm/@tmcw/togeojson@5.8.1/dist/togeojson.umd.js', shp: 'https://unpkg.com/shpjs@4.0.4/dist/shp.js', turf: 'https://cdn.jsdelivr.net/npm/@turf/turf@6.5.0/turf.min.js', fflate: 'https://cdn.jsdelivr.net/npm/fflate@0.8.2/umd/index.js' };
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
    var bar = addFormEl();   // #2: buttons stay visible
    bar.innerHTML =
      '<div style="font-size:11px;color:#555555;margin-bottom:5px;">Import file(s) → new editable layer(s).<br>GeoJSON · KML · KMZ · Shapefile (.zip). <b>Select several at once</b> → they land in an "Untitled batch" folder.</div>' +
      '<input id="editor-import-file" type="file" multiple accept=".geojson,.json,.kml,.kmz,.zip" style="width:100%;box-sizing:border-box;margin-bottom:6px;font-size:12px;" />' +
      '<div style="font-size:11px;color:#555555;margin:8px 0 3px;border-top:1px solid #e8e8e8;padding-top:6px;">&hellip;or from a URL — ArcGIS/ESRI service, Hub page, or .geojson<br><span style="color:#999999;font-size:10px;">(any size — large layers auto-convert to tiles for fast rendering)</span></div>' +
      '<input id="editor-import-url" type="text" placeholder="https://…/MapServer · hub.arcgis.com/maps/… · ….geojson" style="width:100%;box-sizing:border-box;margin-bottom:5px;padding:5px 6px;border:1px solid #bbbbbb;border-radius:4px;font-size:12px;" />' +
      '<select id="editor-import-svc-layer" style="display:none;width:100%;box-sizing:border-box;margin-bottom:5px;padding:5px 6px;border:1px solid #bbbbbb;border-radius:4px;font-size:12px;"></select>' +
      '<select id="editor-parent">' + parentOptions() + '</select>' +
      '<div id="editor-import-status" style="font-size:13.5px;font-weight:700;color:#5b458f;margin:4px 0 8px;min-height:16px;white-space:normal;word-break:break-word;"></div>' +
      '<div class="erow"><button id="editor-import-url-go">Import from URL</button><button id="editor-cancel">Cancel</button></div>';
    var fileInput = document.getElementById('editor-import-file');
    fileInput.addEventListener('change', function () {
      if (!fileInput.files || !fileInput.files.length) return;
      var sel = document.getElementById('editor-parent');
      var parent = (sel && sel.value) ? findNodeById(layers, sel.value) : null;
      if (fileInput.files.length > 1) batchImport(fileInput.files, parent);   // several files → one "Untitled batch" folder
      else handleImportFile(fileInput.files[0], parent);
    });
    document.getElementById('editor-import-url-go').addEventListener('click', importFromUrl);
    document.getElementById('editor-cancel').addEventListener('click', closeAddForm);
  }
  // ── URL import: ArcGIS/ESRI REST services (MapServer/FeatureServer, incl. Hub links) + plain GeoJSON URLs.
  //    A service root lists its drawable sublayers first (pick → Import again); a sublayer is fetched as
  //    paged GeoJSON (outSR=4326) and runs through the SAME import pipeline as files. ──
  async function resolveHubUrl(url) {   // hub.arcgis.com/maps/<org>::<slug> → the underlying service URL
    var m = url.match(/hub\.arcgis\.com\/(?:maps|datasets)\/([^:\/]+)::([^\/?#]+)/i);
    if (!m) return null;
    var title = decodeURIComponent(m[2]).replace(/-/g, ' ');
    var r = await fetch('https://www.arcgis.com/sharing/rest/search?q=title:%22' + encodeURIComponent(title) + '%22&f=json');
    var d = await r.json();
    var hit = (d.results || []).filter(function (x) { return x.url; })[0];
    return hit ? hit.url : null;
  }
  function esriColorToHex(c) {
    if (!Array.isArray(c) || c.length < 3) return null;
    function h(n) { n = Math.max(0, Math.min(255, Math.round(n))); var s = n.toString(16); return s.length < 2 ? '0' + s : s; }
    return '#' + h(c[0]) + h(c[1]) + h(c[2]);
  }
  // Carry the service's OWN symbology over: a uniqueValue renderer becomes color-by-attribute with the
  // exact per-class colors; a simple renderer becomes the layer colour.
  async function applyEsriRenderer(node, renderer) {
    if (!node || !renderer) return;
    var lid = slugToLayerDbId[node.id]; if (!lid) return;
    var key = colorKeyFor(node.type);
    var paint = JSON.parse(JSON.stringify(node.paint || {}));
    try {
      if (renderer.type === 'uniqueValue' && renderer.field2) return;   // composite-key renderer: colour-by can't express it — the materialized ms_* columns carry the styling instead
      // alpha + fill-style aware: a transparent/hatched ESRI fill must NOT become a solid colour here
      // (Overlay District: every class is a colour with alpha 0 + a coloured outline — the fill is hollow)
      function carryColor(sym) { var st = esriSymbolStyle(sym); if (!st || st.color == null) return null; return st.color === 'none' ? 'rgba(0,0,0,0)' : st.color; }
      if (renderer.type === 'uniqueValue' && renderer.field1 && (renderer.uniqueValueInfos || []).length) {
        var mapping = {}, order = [];
        renderer.uniqueValueInfos.forEach(function (uv) {
          var col = carryColor(uv.symbol); if (!col) return;
          var v = String(uv.value); if (!(v in mapping)) { mapping[v] = col; order.push(v); }
        });
        if (!order.length) return;
        var fallback = carryColor(renderer.defaultSymbol) || node.iconColor || '#3bb2d0';
        var expr = ['match', ['to-string', ['get', renderer.field1]]];
        order.forEach(function (v) { expr.push(v, mapping[v]); });
        expr.push(fallback);
        paint[key] = expr;
        node.colorBy = { prop: renderer.field1, mode: 'category', mapping: mapping };
      } else if (renderer.type === 'simple' && renderer.symbol) {
        var col2 = carryColor(renderer.symbol); if (!col2) return;
        paint[key] = col2;
        var icon2 = esriColorToHex(renderer.symbol.color);   // sidebar icon needs a REAL colour: outline colour when the fill is hollow
        if (col2 === 'rgba(0,0,0,0)' && renderer.symbol.outline) icon2 = esriColorToHex(renderer.symbol.outline.color) || icon2;
        if (icon2) node.iconColor = icon2;
      } else return;
      node.paint = paint;
      var cur = await db.from('layers').select('raw_config').eq('id', lid).single();
      var rc = (cur.data && cur.data.raw_config) || {};
      if (node.colorBy) rc.colorBy = node.colorBy;
      var upd = { paint: paint, raw_config: rc };
      if (renderer.type === 'simple') upd.color = node.iconColor;   // sidebar icon colour comes from layers.color
      await db.from('layers').update(upd).eq('id', lid);
      rerender();   // refresh the sidebar so the icon shows the carried colour
    } catch (e) { console.warn('esri renderer apply failed', e); }
  }
  // Materialize the ESRI symbology into the UNIVERSAL STYLE COLUMNS on each feature (ms_color always;
  // ms_linecolor from the symbol's outline; ms_thickness from line width / point size / fill outline width).
  // AS-IS principle: ESRI colours are [R,G,B,A] arrays — keep the numbers verbatim as rgb()/rgba()
  // (no base-16 conversion, alpha included). Our style columns accept any CSS colour and interpret it.
  function esriCssColor(c) {
    if (!Array.isArray(c) || c.length < 3) return null;
    var r = Math.round(c[0]), g = Math.round(c[1]), b = Math.round(c[2]);
    var a = c[3] != null ? Math.round(c[3] / 255 * 100) / 100 : 1;
    return a >= 1 ? 'rgb(' + r + ',' + g + ',' + b + ')' : 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
  }
  function esriOutlineOn(o) { return o && o.style !== 'esriSLSNull' && o.style !== 'None' && Array.isArray(o.color); }
  function esriSymbolStyle(sym) {
    if (!sym) return null;
    var st = {}, t = sym.type || '';
    if (t === 'esriSFS') {
      // Only a SOLID fill is a real fill colour. Hatch/pattern styles (DiagonalCross etc.) read as mostly-open
      // in ESRI and we can't draw patterns — nearest faithful render is un-filled ('none'); the outline carries the look.
      st.color = (!sym.style || sym.style === 'esriSFSSolid') ? (esriCssColor(sym.color) || 'none') : 'none';
      if (esriOutlineOn(sym.outline)) {
        st.linecolor = esriCssColor(sym.outline.color);
        if (sym.outline.width != null) st.thickness = sym.outline.width;
      }
    } else if (t === 'esriSLS') {
      st.color = esriCssColor(sym.color); if (st.color == null) return null;
      if (sym.width != null) st.thickness = sym.width;
    } else if (t === 'esriSMS' || t === 'esriPMS') {
      // marker symbols (sometimes used on polygon layers): the marker colour is the fill; alpha kept as-is
      st.color = esriCssColor(sym.color) || 'none';
      if (sym.size != null) st.thickness = sym.size;
      if (esriOutlineOn(sym.outline)) st.linecolor = esriCssColor(sym.outline.color);
    } else {
      st.color = esriCssColor(sym.color); if (st.color == null) return null;
    }
    return st;
  }
  function esriValueKey(props, renderer) {   // uniqueValue renderers can key on up to 3 fields joined by a delimiter
    var delim = renderer.fieldDelimiter || ',';
    var parts = [];
    ['field1', 'field2', 'field3'].forEach(function (fk) { if (renderer[fk]) parts.push(String(props[renderer[fk]] != null ? props[renderer[fk]] : '')); });
    return parts.join(delim);
  }
  function materializeEsriStyle(feats, renderer) {
    var byVal = null, simple = null;
    if (renderer.type === 'uniqueValue' && renderer.field1 && (renderer.uniqueValueInfos || []).length) {
      byVal = {};
      renderer.uniqueValueInfos.forEach(function (uv) { var st = esriSymbolStyle(uv.symbol); if (st) byVal[String(uv.value)] = st; });
    } else if (renderer.type === 'simple') simple = esriSymbolStyle(renderer.symbol);
    if (!byVal && !simple) return;
    var dflt = renderer.defaultSymbol ? esriSymbolStyle(renderer.defaultSymbol) : null;
    feats.forEach(function (f) {
      var props = f.properties = f.properties || {};
      var st = simple || (byVal ? (byVal[esriValueKey(props, renderer)] || dflt) : null);
      if (!st) { if (props.ms_color == null) props.ms_color = 'none'; return; }   // unstyled in the SOURCE renderer → explicit entry ("none" renders as the layer colour)
      if (props.ms_color == null) props.ms_color = st.color;   // source columns win if they already exist
      if (st.linecolor != null && props.ms_linecolor == null) props.ms_linecolor = st.linecolor;
      if (st.opacity != null && props.ms_opacity == null) props.ms_opacity = st.opacity;
      if (st.thickness != null && props.ms_thickness == null) props.ms_thickness = st.thickness;
    });
  }
  async function importArcgisLayer(url, parent) {   // one service sublayer → import + carry its symbology
    var lmeta = null, name = null;
    try { lmeta = await (await fetch(url + '?f=json')).json(); if (lmeta && lmeta.name) name = lmeta.name; } catch (e) {}
    var feats = [], dlBytes = 0;
    for (var off = 0; ; off += 1000) {
      importStatus('Fetching ' + (name || 'features') + '… ' + nfmt(feats.length) + (dlBytes ? ' (' + (dlBytes / 1048576).toFixed(1) + ' MB)' : ''));
      var resp = await fetch(url + '/query?where=1%3D1&outFields=*&outSR=4326&f=geojson&resultOffset=' + off + '&resultRecordCount=1000');
      var pageText = await resp.text(); dlBytes += pageText.length;   // downloaded size — users should always see how big things are
      var page = JSON.parse(pageText);
      if (page.error) throw new Error(page.error.message || 'ArcGIS query failed');
      feats = feats.concat(page.features || []);
      if (!page.features || page.features.length < 1000) break;
      // no size cap (7/15): the cap predated auto-convert — big layers now become PMTiles for
      // rendering, so any service size flows through (tier storage quotas still gate non-admins)
    }
    if (!feats.length) throw new Error('no features in ' + (name || url));
    var renderer = lmeta && lmeta.drawingInfo && lmeta.drawingInfo.renderer;
    if (renderer) materializeEsriStyle(feats, renderer);   // ESRI style → ms_color / ms_opacity / ms_thickness per feature
    var made = await importFeatureCollection({ type: 'FeatureCollection', features: feats }, name || 'ArcGIS layer', parent) || [];
    if (renderer && made.length) {
      for (var i = 0; i < made.length; i++) await applyEsriRenderer(made[i], renderer);
      await loadFeatures();   // re-color the MapboxDraw copies with the carried symbology
    }
    return made;
  }
  async function importFromUrl() {
    var inp = document.getElementById('editor-import-url'); if (!inp) return;
    var url = (inp.value || '').trim(); if (!url) { importStatus('Paste a URL first'); return; }
    var sel = document.getElementById('editor-import-svc-layer');
    var pSel = document.getElementById('editor-parent');
    var parent = (pSel && pSel.value) ? findNodeById(layers, pSel.value) : null;
    if (storageGate()) return;
    try {
      importStatus('Reading URL…');
      if (/hub\.arcgis\.com\//i.test(url)) {
        var svc = await resolveHubUrl(url);
        if (!svc) throw new Error('could not resolve the Hub link — paste the REST service URL instead');
        url = svc; inp.value = url;
      }
      url = url.replace(/[?#].*$/, '').replace(/\/+$/, '');
      if (/(MapServer|FeatureServer)$/i.test(url)) {   // service root → offer its drawable sublayers (or all)
        if (sel.style.display === 'none' || sel._svcUrl !== url) {
          var meta = await (await fetch(url + '?f=json')).json();
          var lyrs = (meta.layers || []).filter(function (l) { return l.geometryType; });
          if (!lyrs.length) throw new Error('no drawable layers in this service');
          sel.innerHTML = '<option value="*">— All ' + lyrs.length + ' layers (as a group) —</option>' +
            lyrs.map(function (l) { return '<option value="' + l.id + '">' + attrEsc(l.name) + '</option>'; }).join('');
          sel.style.display = 'block'; sel._svcUrl = url; sel._svcLayers = lyrs; sel._svcMeta = meta;
          importStatus('Pick a layer (or all) above, then click Import again');
          return;
        }
        var chosen = sel.options[sel.selectedIndex];
        if (chosen.value === '*') {   // whole service → a group with every drawable sublayer inside
          var svcName = (sel._svcMeta && (sel._svcMeta.mapName || (sel._svcMeta.documentInfo && sel._svcMeta.documentInfo.Title))) || 'ArcGIS import';
          var grp = await addItem('group', svcName, (parent && parent.type === 'section') ? parent : null);
          if (!grp) throw new Error('could not create the group');
          var ok = 0, failed = [];
          for (var li = 0; li < sel._svcLayers.length; li++) {
            var lyr = sel._svcLayers[li];
            importStatus('Layer ' + (li + 1) + '/' + sel._svcLayers.length + ': ' + lyr.name);
            try { await importArcgisLayer(sel._svcUrl + '/' + lyr.id, grp); ok++; }
            catch (le) { console.warn('sublayer import failed', lyr.name, le); failed.push(lyr.name + (le && le.message ? ' (' + le.message + ')' : '')); }   // surface WHY — "failed: <name>" alone hid the 20k-cap reason
          }
          setStatus('Imported ' + ok + '/' + sel._svcLayers.length + ' layers into "' + svcName + '"' + (failed.length ? ' — failed: ' + failed.join(', ') : ''));
          sel.style.display = 'none';
          return;
        }
        await importArcgisLayer(url + '/' + chosen.value, parent);
        sel.style.display = 'none';
        return;
      }
      if (/(MapServer|FeatureServer)\/\d+$/i.test(url)) { await importArcgisLayer(url, parent); sel.style.display = 'none'; return; }
      // plain GeoJSON URL
      var fc = await (await fetch(url)).json();
      var name = stripExt(decodeURIComponent((url.split('/').pop() || '') || 'Imported layer'));
      if (!fc || !fc.features || !fc.features.length) throw new Error('no features found');
      await importFeatureCollection(fc, name || 'Imported layer', parent);
      sel.style.display = 'none';
    } catch (e) { console.warn('editing: url import failed', e); importStatus('Import failed: ' + (e && e.message)); }
  }
  function nfmt(n) { try { return Number(n).toLocaleString('en-US'); } catch (e) { return String(n); } }   // 12345 → "12,345" everywhere counts show
  // Progress lives in the EXISTING import-status line (user 7/15: "nothing separate — make what's
  // there more prominent"; the floating banner is gone). msProgress stays as the one entry point
  // for long-running work (dates apply, publish sew-up) and simply feeds that same line.
  function msProgress(m) { importStatus(m); }
  // full layer name on hover — rows ellipsize (below); the browser tooltip carries the rest
  document.addEventListener('mouseover', function (e) {
    var lb = e.target && e.target.closest && e.target.closest('#layers-panel-content .layer-list-row label');
    if (lb && !lb.title) lb.title = (lb.textContent || '').trim();
  });
  function importStatus(m) { var s = document.getElementById('editor-import-status'); if (s) s.textContent = m; else setStatus(m); }
  // KMZ = a ZIP wrapping a KML (+ optional assets). Unzip, find the .kml, parse it.
  async function kmzToFc(file) {
    await loadScript(LIB.fflate);
    await loadScript(LIB.togeojson);
    var files = window.fflate.unzipSync(new Uint8Array(await file.arrayBuffer()));
    var kmlName = Object.keys(files).filter(function (n) { return /\.kml$/i.test(n); }).sort()[0];   // doc.kml / any .kml
    if (!kmlName) throw new Error('no .kml inside the .kmz');
    var dom = new DOMParser().parseFromString(new TextDecoder().decode(files[kmlName]), 'text/xml');
    if (dom.querySelector('parsererror')) throw new Error('the KML inside the KMZ is invalid');
    return window.toGeoJSON.kml(dom);
  }
  // Parse ONE file by extension → FeatureCollection → import as layer(s). Throws on failure.
  async function importOneFile(file, parent) {
    var ext = (file.name.split('.').pop() || '').toLowerCase();
    importStatus('Reading ' + file.name + '…');
    var fc = null;
    if (ext === 'geojson' || ext === 'json') fc = JSON.parse(await file.text());
    else if (ext === 'kml') { await loadScript(LIB.togeojson); var dom = new DOMParser().parseFromString(await file.text(), 'text/xml'); if (dom.querySelector('parsererror')) throw new Error('not valid KML/XML'); fc = window.toGeoJSON.kml(dom); }
    else if (ext === 'kmz') fc = await kmzToFc(file);
    else if (ext === 'zip') { await loadScript(LIB.shp); var r = await window.shp(await file.arrayBuffer()); fc = Array.isArray(r) ? { type: 'FeatureCollection', features: r.reduce(function (a, c) { return a.concat(c.features || []); }, []) } : r; }
    else if (ext === 'tif' || ext === 'tiff') throw new Error('GeoTIFF (raster) import is coming soon');
    else throw new Error('unsupported format .' + ext);
    if (!fc || !fc.features || !fc.features.length) throw new Error('no features found');
    return await importFeatureCollection(fc, stripExt(file.name), parent);
  }
  // Single-file import (the file input's default path) — swallows errors into the status line.
  async function handleImportFile(file, parent) {
    if (storageGate()) return;   // storage hard-stop: don't import data over the limit
    try { await importOneFile(file, parent); }
    catch (e) { console.warn('editing: import failed', e); importStatus('Import failed: ' + e.message); }
  }
  // BATCH import: several files at once → each becomes a layer inside one "Untitled batch"
  // folder. Size-capped (not feature-capped — hundreds of tiny single-point files are fine).
  var BATCH_MAX_BYTES = 60 * 1024 * 1024;   // 60 MB of raw files per batch
  var BATCH_MAX_FILES = 400;                // sanity cap on file count
  async function batchImport(files, parent) {
    if (storageGate()) return;
    files = Array.prototype.slice.call(files);
    var totalMB = files.reduce(function (a, f) { return a + f.size; }, 0) / 1048576;
    if (files.length > BATCH_MAX_FILES) { importStatus('That\'s ' + files.length + ' files — the limit is ' + BATCH_MAX_FILES + ' per batch. Select fewer.'); return; }
    if (totalMB > BATCH_MAX_BYTES / 1048576) { importStatus('That batch is ' + totalMB.toFixed(1) + ' MB — the limit is ' + (BATCH_MAX_BYTES / 1048576) + ' MB per batch. Select fewer/smaller files.'); return; }
    var grp = await addItem('group', 'Untitled batch', (parent && parent.type === 'section') ? parent : null);
    if (!grp) { importStatus('Could not create the batch folder'); return; }
    var ok = 0, failed = [];
    for (var i = 0; i < files.length; i++) {
      importStatus('Importing ' + (i + 1) + '/' + files.length + ': ' + files[i].name + '  (' + totalMB.toFixed(1) + ' MB batch)');
      try { await importOneFile(files[i], grp); ok++; }
      catch (e) { console.warn('batch: file failed', files[i].name, e); failed.push(files[i].name + (e && e.message ? ' (' + e.message + ')' : '')); }
    }
    rerender();
    setStatus('Batch done — ' + ok + '/' + files.length + ' imported into "Untitled batch"' + (failed.length ? ' · failed: ' + failed.join(', ') : ''));
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
    if (total > 3000 && !window.confirm('Import ' + total + ' features? Large layers auto-convert to tiles for fast viewing; editing that many features may still be slow.')) { importStatus('Cancelled'); return; }
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
        if (parent) { parent.children = parent.children || []; parent.children.push(node); parent.collapsed = false; parent.open = true; if (parent.type === 'group') node.topLayerClass = parent.id; }
        else layers.push(node);
        made.push(node);
      }
      rerender();
      await loadFeatures();   // pull the imported features into MapboxDraw so they render + are editable
      var b = computeImportBounds(fc); if (b && typeof beforeMap !== 'undefined' && beforeMap) { try { beforeMap.fitBounds(b, { padding: 60, maxZoom: 16 }); } catch (e) {} }
      if (made.length) setActiveLayer(made[0].id);
      showButtons();
      setStatus('Imported ' + total + ' feature' + (total !== 1 ? 's' : ''));
      // auto-convert: layers past the tile thresholds become PMTiles now (no-lag viewing from the
      // NEXT load + for every visitor; this session keeps its live geojson). Fire-and-await so the
      // status line reflects real progress; a failure leaves the layer working as plain geojson.
      try {
        var bigOnes = made.filter(function (n) {
          var feats = groups[n.type] || [];   // import groups are keyed by the same kinds as node.type (circle/line/fill)
          return feats.length > (n.type === 'circle' ? 2000 : 500);
        });
        if (bigOnes.length) {
          await loadScript('../platform/tilegen.js?v=' + Date.now());   // ALWAYS fresh — a cached old tiler re-runs the 891k-tile mistake
          for (var bi = 0; bi < bigOnes.length; bi++) {
            var bn = bigOnes[bi];
            var lid2 = slugToLayerDbId[bn.id];
            if (!lid2 || !window.MSTileGen) continue;
            importStatus('Auto-converting "' + (bn.label || 'layer') + '" to tiles…');
            // read the rows back so tile feature ids = features.feature_id (the editor's tile↔DB key)
            var feats2 = [], from2 = 0;
            for (;;) {
              var fr2 = await db.from('features').select('feature_id, geom, start_date, end_date, label').eq('layer_id', lid2).order('feature_id').range(from2, from2 + 999);
              if (fr2.error || !fr2.data || !fr2.data.length) break;
              fr2.data.forEach(function (f) {
                // SKINNY TILES (7/16): id + timeline days (+ label, for map labels on tileset
                // lines) — other attributes are fetched by id on click; the days must stay baked
                // (the slider filter reads them inside the tile)
                var props = {
                  DayStart: f.start_date ? +String(f.start_date).slice(0, 10).replace(/-/g, '') || 0 : 0,
                  DayEnd: f.end_date ? +String(f.end_date).slice(0, 10).replace(/-/g, '') || 99999999 : 99999999
                };
                if (f.label != null && f.label !== '') props.label = f.label;
                feats2.push({ type: 'Feature', id: f.feature_id, properties: props, geometry: f.geom });
              });
              if (fr2.data.length < 1000) break;
              from2 += 1000;
            }
            if (!feats2.length) continue;
            await MSTileGen.convertLayer(db, projectId, lid2, feats2, { name: bn.label, geomKind: bn.type, status: importStatus });
            importStatus('"' + (bn.label || 'layer') + '" now renders from tiles (from the next load).');
          }
        }
      } catch (eConv) { console.warn('auto-convert skipped', eConv); importStatus('Imported — tile conversion skipped (' + (eConv && eConv.message) + ')'); }
      // big-data table sidecar: layers past the big-table threshold get their Parquet baked NOW,
      // in the background — the fast attribute table works immediately after import, no Publish needed
      try {
        if (window.MSBigTable) made.forEach(function (nB) {
          var featsB = groups[nB.type] || [], lidB = slugToLayerDbId[nB.id];
          if (lidB && featsB.length > MSBigTable.BIG_ROWS) MSBigTable.bakeFromDb(db, projectId, lidB, importStatus).catch(function (eB2) { console.warn('sidecar bake skipped', eB2); });
        });
      } catch (eBk) {}
      return made;
    } catch (e) { console.warn('editing: import persist failed', e); importStatus('Import failed: ' + e.message); return []; }
  }
  window._msImportFC = importFeatureCollection;   // programmatic import seam (harness + future API)
  async function batchInsertFeatures(layerId, feats) {
    var BATCH = 500;
    for (var i = 0; i < feats.length; i += BATCH) {
      if (feats.length > BATCH) importStatus('Saving features… ' + nfmt(Math.min(i + BATCH, feats.length)) + '/' + nfmt(feats.length));   // uncapped imports can be 100k+ rows — show progress, not silence
      var rows = feats.slice(i, i + BATCH).map(function (f) { return { layer_id: layerId, geom: f.geometry, label: importLabel(f.properties), start_date: null, end_date: null, custom_fields: importCustomFields(f.properties) }; });
      var r = await db.from('features').insert(rows);
      if (r.error) throw new Error('feature insert: ' + r.error.message);
    }
  }
  var LABEL_KEYS = ['name', 'Name', 'NAME', 'label', 'Label', 'LABEL', 'title', 'Title', 'TITLE'];
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
    var bar = addFormEl();   // #2: fill the form area under the buttons — the buttons stay visible
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
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); commit(type); } if (e.key === 'Escape') closeAddForm(); });
    document.getElementById('editor-ok').addEventListener('click', function () { commit(type); });
    document.getElementById('editor-cancel').addEventListener('click', closeAddForm);
  }
  // Unsaved-changes guard: browsers show the native "leave site?" prompt when we flag it. We flag when
  // (a) a save is in flight or the last save FAILED (data not persisted), or (b) an ANONYMOUS user has
  // edited this session (their map lives only at this URL — closing risks losing it). All state is kept
  // in sync from setStatus (the one funnel every save path already goes through), so later features
  // that save via setStatus get the guard for free.
  var _msPendingSave = false, _msAnonEdited = false, _msIsAnonUser = false;
  try {
    if (window.MapAuth) {
      var _syncAnon = function () { try { MapAuth.currentUser().then(function (u) { _msIsAnonUser = !!(u && !MapAuth.isReal(u)); }).catch(function () {}); } catch (e) {} };
      _syncAnon(); try { MapAuth.onChange(_syncAnon); } catch (e) {}
    }
  } catch (e) {}
  window.addEventListener('beforeunload', function (e) {
    if (_msPendingSave || (_msIsAnonUser && _msAnonEdited)) { e.preventDefault(); e.returnValue = ''; return ''; }
  });
  function setStatus(msg) {
    var s = String(msg == null ? '' : msg);
    if (s.indexOf('Saving') === 0) { _msPendingSave = true; _msAnonEdited = true; }
    else if (s.toLowerCase().indexOf('failed') === -1) { _msPendingSave = false; }   // "… failed" keeps the flag — that data is NOT persisted
    var el = document.getElementById('editor-save-status');
    if (!el) return;
    el.textContent = msg;
    if (msg === 'Saved') setTimeout(function () { if (el.textContent === 'Saved') el.textContent = ''; }, 1500);
  }
  var _toastTimer = null;
  function showToast(msg, ms) {   // #1: prominent, auto-dismissing message (the save-status text is too subtle for rejections)
    var el = document.getElementById('editor-toast'); if (!el) { setStatus(msg); return; }
    el.textContent = msg; el.style.display = 'block';
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(function () { el.style.display = 'none'; }, ms || 3200);
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
        '<button data-cmd="removeFormat" title="Clear formatting">&times;A</button>';
        // #24: Save button removed — the popup autosaves as you type, like every other field.
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
      // #24: autosave — debounced on typing (and the formatting buttons trigger it too, via execCommand → input)
      var _modalSaveTimer = null;
      content.addEventListener('input', function () {
        if (!_editPopupId) return;
        clearTimeout(_modalSaveTimer);
        _modalSaveTimer = setTimeout(savePopupEdit, 600);
      });
    }
    if (!window.__editorPopupEditWired) {
      window.__editorPopupEditWired = true;
      document.addEventListener('click', function (e) {   // any ℹ / info trigger → open the popup + make it editable in place
        var t = e.target && e.target.closest && e.target.closest('.trigger-popup'); if (!t) return;
        var pid, title;
        if (t.id === 'info' || t.id === 'about-info' || t.id === 'about') { pid = 'about'; title = 'About'; }   // 'about' = the header ABOUT button (engine headerButtons render it with that id)
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
    // Closing the modal ENDS the edit session — otherwise _editPopupId/contenteditable linger and the
    // next popup that opens WITHOUT going through the click handler above gets edited under the OLD
    // target (the About-text-saved-to-a-layer bug).
    var oCb = document.getElementById('o');
    if (oCb && !oCb.__msEditReset) {
      oCb.__msEditReset = true;
      oCb.addEventListener('change', function () {
        if (this.checked) return;
        if (_editPopupId) { try { savePopupEdit(); } catch (e) {} }   // flush — closing inside the 600ms debounce must not drop the last keystrokes
        _editPopupId = null;
        var c = document.querySelector('div.modal-content'); if (c) c.removeAttribute('contenteditable');
        var tl = document.getElementById('editor-modal-tools'); if (tl) tl.classList.remove('on');
      });
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
    // SNAPSHOT the target + html now — the close handler nulls _editPopupId and this function
    // awaits mid-flight, so reading the global later could save under the wrong (or no) key
    var content = document.querySelector('div.modal-content'); var pid = _editPopupId;
    if (!content || !pid) return;
    var html = content.innerHTML; setStatus('Saving…');
    try {
      var cur = await db.from('projects').select('raw_config').eq('id', projectId).single(); var rc = (cur.data && cur.data.raw_config) || {};
      if (pid === 'about') { rc.about = html; setModalAbout(html); }
      else {
        var nodeId = pid.replace(/-info$/, ''); var node = findNodeById(layers, nodeId);
        // a layer/group popup is titled by its ROW LABEL — the modal header can be stale (it once
        // trapped "About" here permanently), so it's only the fallback when no node matches
        var title = (node && node.label) || '';
        if (!title) { try { title = (document.querySelector('div.modal-header h1').textContent || '').trim(); } catch (x) {} }
        rc.popups = rc.popups || {}; rc.popups[pid] = { title: title, html: html };
        try { window.modal_content_html = window.modal_content_html || {}; window.modal_header_text = window.modal_header_text || {}; window.modal_content_html[pid] = html; window.modal_header_text[pid] = title || 'Info'; if (_editPopupId === pid) window.$('div.modal-header h1').text(title || 'Info'); } catch (x2) {}
        // persist info_id on the layer/group row so the rendered info button carries this id (viewer + on reload)
        if (node) {
          if (node.type === 'group' && node._dbId) { await db.from('layer_groups').update({ info_id: pid }).eq('id', node._dbId); }
          else if (node.type !== 'group' && node.type !== 'section' && slugToLayerDbId[nodeId]) { await db.from('layers').update({ info_id: pid }).eq('id', slugToLayerDbId[nodeId]); }
        }
      }
      var r = await db.from('projects').update({ raw_config: rc }).eq('id', projectId); if (r.error) throw new Error(r.error.message);
      setStatus('Saved');
      rerender();   // the row's ℹ button exists only while there is content — reflect edits immediately
    } catch (e) { setStatus('Save failed'); }
  }
  function onLayerInfoEdit() {   // panel button: edit this layer's ℹ popup — the row button appears only when content exists
    if (!activeLayerId) return;
    var node = findNodeById(layers, activeLayerId); if (!node) return;
    var pid = activeLayerId + '-info';
    var html = (window.modal_content_html && window.modal_content_html[pid]) || '';
    var hdr = (window.modal_header_text && window.modal_header_text[pid]) || node.label || 'Info';
    openPopupForEdit(pid, hdr, html);
    enableModalEdit(pid);
  }
  // Map-settings styles: SAME look/hierarchy as the layer panel (.ms-* in ensureEditorUiCss) but a
  // parallel .mss-* class set — deliberately NOT shared, so either panel can restyle without breaking the other.
  function ensureSettingsUiCss() {
    if (document.getElementById('ms-settings-ui-css')) return;
    var s = document.createElement('style');
    s.id = 'ms-settings-ui-css';
    s.textContent =
      '.mss-sec{font-size:25px;font-weight:800;letter-spacing:.07em;color:#7c5cbf;margin:0 0 8px;text-transform:uppercase;border-bottom:2px solid #ede9f7;padding-bottom:4px;text-align:center;}' +
      '.mss-sectop{margin-top:16px;padding:10px 12px 12px;border:3px solid #e5e0f3;border-radius:10px;background:#fbfaff;box-shadow:0px 0px 3px 4px rgba(124,92,191,0.09);}' +
      '.mss-lbl{display:block;font-size:11px;color:#555555;margin-bottom:2px;}' +
      '.mss-check{display:block;cursor:pointer;font-size:12px;color:#555555;}' +
      '.mss-in{width:100%;box-sizing:border-box;padding:5px 6px;border:1px solid #bbbbbb;border-radius:4px;font-size:12px;}' +
      '.mss-btn{width:100%;padding:6px;border:1px solid #bbbbbb;border-radius:4px;background:#f2f2f2;color:#222222;cursor:pointer;font-size:12px;}' +
      '.mss-btn:hover{background:#e8e8e8;}' +
      '.mss-note{font-size:10px;color:#888888;margin-top:3px;}' +
      '#esp-close:hover{background:#e9e5f5;border-color:#c9c2e2;color:#3d3857;}';
    document.head.appendChild(s);
  }
  function injectSettingsPanel() {
    if (document.getElementById('editor-settings-panel')) return;
    ensureSettingsUiCss();
    var p = document.createElement('div');
    p.id = 'editor-settings-panel';
    // container matches the layer panel: light shell, sticky white header, scrolling card body
    p.style.cssText = 'position:fixed;top:130px;left:534px;width:262px;max-height:calc(100vh - 240px);overflow-y:auto;overflow-x:hidden;background:#f8f8f8;border:1px solid #bbbbbb;border-radius:8px;box-shadow:0 3px 14px rgba(0,0,0,0.2);padding:0;font-size:13px;z-index:1001;display:none;font-family:Source Sans Pro,Arial,sans-serif;';
    var MSEC = function (t) { return '<div class="mss-sec">' + t + '</div>'; };
    p.innerHTML =
      '<div style="position:sticky;top:0;z-index:5;padding:10px 12px;background:#ffffff;border-bottom:1px solid #e2e0ea;border-radius:8px 8px 0 0;">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;"><b style="font-size:14px;">Map settings</b>' +
        '<button id="esp-close" title="Close this panel" style="flex:0 0 auto;display:inline-flex;align-items:center;gap:4px;padding:3px 9px 3px 7px;border:1px solid #d7d3e4;border-radius:6px;background:#f4f2fa;color:#544f6e;font:600 12px Source Sans Pro,Arial,sans-serif;cursor:pointer;line-height:1;"><span style="font-size:15px;line-height:1;">&times;</span> Close</button></div>' +
      '</div>' +
      '<div style="padding:12px;">' +
      // map name at the very top, bold — same idiom as the layer panel's name field
      '<input id="esp-name" type="text" placeholder="Map name" title="Rename this map" style="width:100%;box-sizing:border-box;margin-bottom:8px;padding:6px 8px;border:1px solid #bbbbbb;border-radius:4px;font-size:15px;font-weight:600;" />' +
      '<button id="esp-setview" class="mss-btn">Set current view as default</button>' +
      '<div id="esp-viewinfo" class="mss-note"></div>' +
      // ── TIMELINE ──
      '<div class="mss-sectop">' +
        MSEC('Timeline') +
        // stacked full-width date fields — side-by-side + "to" clipped the calendar icons in this narrow card
        '<label class="mss-lbl">Timeline range — start</label>' +
        '<input id="esp-tl-start" type="date" class="mss-in" />' +
        '<label class="mss-lbl" style="margin-top:6px;">End</label>' +
        '<input id="esp-tl-end" type="date" class="mss-in" />' +
        '<div class="mss-note">Start/end of the bottom timeline slider — type a date or pick one (down to the day).</div>' +
        '<label class="mss-check" style="margin-top:6px;"><input id="esp-tl-today" type="checkbox" style="vertical-align:middle;margin:0 5px 0 0;" />End at today (updates each visit)</label>' +
      '</div>' +
      // ── HEADER ──
      '<div class="mss-sectop">' +
        MSEC('Header') +
        '<label class="mss-check"><input id="esp-feat-header" type="checkbox" style="vertical-align:middle;margin:0 5px 0 0;" />Show header (logo &amp; title bar)</label>' +
        '<div class="mss-note">Off: the logo, map name and About link move to the top of the sidebar.</div>' +
        '<label class="mss-lbl" style="margin-top:8px;">Header logo</label>' +
        '<input id="esp-logo-file" type="file" accept="image/*" style="width:100%;box-sizing:border-box;font-size:11px;" />' +
        '<label class="mss-lbl" style="margin-top:8px;">Logo link (URL)</label>' +
        '<input id="esp-logo-link" type="text" placeholder="https://…" class="mss-in" />' +
      '</div>' +
      '<div class="mss-note" style="margin-top:12px;">To edit the <b>About</b> text, click the <b>ABOUT</b> button (header) or the sidebar <b>About</b> link and edit the popup directly.</div>' +
      '</div>';
    document.body.appendChild(p);
    document.getElementById('esp-close').addEventListener('click', function () { p.style.display = 'none'; });
    document.getElementById('esp-name').addEventListener('change', onSettingsName);
    document.getElementById('esp-setview').addEventListener('click', onSetDefaultView);
    document.getElementById('esp-tl-start').addEventListener('change', onTimelineSave);
    document.getElementById('esp-tl-end').addEventListener('change', onTimelineSave);
    document.getElementById('esp-tl-today').addEventListener('change', function () { document.getElementById('esp-tl-end').disabled = this.checked; onTimelineSave(); });
    document.getElementById('esp-feat-header').addEventListener('change', onFeatureHeader);
    document.getElementById('esp-logo-file').addEventListener('change', onLogoFile);
    document.getElementById('esp-logo-link').addEventListener('change', onLogoLink);
    // Sharing (who can see the map) moved to its own 🔗 Share panel in the top bar — see platform/share.js.
  }
  // ── Copy map (Google-My-Maps-style): clone the WHOLE project — sections, groups, layers (new rows, so
  //    edits never touch the original), project_layers links, and every feature — into a new private map
  //    owned by the CURRENT account. Solves "started the map before logging in" too. ──
  async function copyMapToMyAccount() {
    var btn = document.getElementById('editor-copy-btn');
    var u = window.MapAuth ? await MapAuth.currentUser() : null;
    if (!u) { if (window.MapAuth) MapAuth.openAuthModal('login'); return; }
    if (btn) { btn.disabled = true; btn.textContent = 'Copying…'; }
    setStatus('Copying map…');
    function strip(row, extra) { var o = {}; Object.keys(row).forEach(function (k) { if (k === 'id' || k === 'created_at' || k === 'updated_at' || (extra && extra.indexOf(k) > -1)) return; o[k] = row[k]; }); return o; }
    try {
      var bundle = await ConfigLoader.fetchProjectBundle(db, projectId);
      var src = bundle.project;
      // 1 — the project row (private, owned by me)
      var np = strip(src); np.name = (src.name || 'Untitled Map') + ' (copy)'; np.user_id = u.id; np.is_public = false;
      var rp = await db.from('projects').insert(np).select('id').single(); if (rp.error) throw new Error(rp.error.message);
      var newId = rp.data.id;
      // 2 — sections, 3 — groups (remap ids)
      var secMap = {}, grpMap = {};
      for (var i = 0; i < (bundle.sections || []).length; i++) {
        var s = bundle.sections[i]; var ns = strip(s); ns.project_id = newId;
        var rs = await db.from('layer_sections').insert(ns).select('id').single(); if (rs.error) throw new Error(rs.error.message);
        secMap[s.id] = rs.data.id;
      }
      for (var j = 0; j < (bundle.groups || []).length; j++) {
        var g = bundle.groups[j]; var ng = strip(g); ng.project_id = newId;
        if (ng.section_id) ng.section_id = secMap[ng.section_id] || null;
        var rg = await db.from('layer_groups').insert(ng).select('id').single(); if (rg.error) throw new Error(rg.error.message);
        grpMap[g.id] = rg.data.id;
      }
      // 4 — layers (new rows + fresh slugs), their project link, and their features
      var featTotal = 0;
      for (var k = 0; k < (bundle.projectLayers || []).length; k++) {
        var pl = bundle.projectLayers[k], L = pl.layers; if (!L) continue;
        var nl = strip(L); if (nl.slug) nl.slug = L.slug + '-c' + Math.random().toString(36).slice(2, 7);
        var rl = await db.from('layers').insert(nl).select('id').single(); if (rl.error) throw new Error(rl.error.message);
        var newLid = rl.data.id;
        var npl = strip(pl, ['layers']);
        npl.project_id = newId; npl.layer_id = newLid;
        npl.section_id = pl.section_id ? (secMap[pl.section_id] || null) : null;
        npl.group_id = pl.group_id ? (grpMap[pl.group_id] || null) : null;
        var rpl = await db.from('project_layers').insert(npl); if (rpl.error) throw new Error(rpl.error.message);
        if (L.source_type === 'geojson-supabase') {   // duplicate the features (paged; select * so custom fields survive)
          for (var off = 0; ; off += 1000) {
            var fr = await db.from('features').select('*').eq('layer_id', L.id).order('feature_id').range(off, off + 999);
            if (fr.error || !fr.data || !fr.data.length) break;
            var rows = fr.data.map(function (f) { var nf = strip(f, ['feature_id']); nf.layer_id = newLid; return nf; });
            var ri = await db.from('features').insert(rows); if (ri.error) throw new Error(ri.error.message);
            featTotal += rows.length;
            if (fr.data.length < 1000) break;
          }
        }
        setStatus('Copying… ' + (k + 1) + '/' + bundle.projectLayers.length + ' layers');
      }
      setStatus('Copied ✓ (' + featTotal + ' features)');
      window.location.href = 'editor.html?id=' + newId;
    } catch (e) {
      console.warn('copy failed', e); setStatus('Copy failed: ' + (e && e.message));
      if (btn) { btn.disabled = false; btn.textContent = '⧉ Copy'; }
    }
  }
  async function onPublish() {
    var hb = document.getElementById('editor-publish-btn');
    if (hb) { hb.disabled = true; hb.textContent = 'Publishing…'; }
    setStatus('Publishing…');
    try {
      // "sew up" tiles first: converted layers regenerate from their CURRENT features, so the
      // published snapshot always ships fresh tiles (edits since the last generate are folded in)
      try {
        await loadScript('../platform/tilegen.js?v=' + Date.now());   // ALWAYS fresh — a cached old tiler re-runs the 891k-tile mistake
        if (window.MSTileGen) await MSTileGen.sewUpProject(db, projectId, function (m) { setStatus(m); msProgress(m); });   // publish regeneration shows in the prominent sidebar line too
      } catch (eTiles) { console.warn('tile sew-up skipped', eTiles); }
      setStatus('Publishing…');
      var bundle = await ConfigLoader.fetchProjectBundle(db, projectId);   // snapshot the current live config
      await db.from('project_snapshots').delete().eq('project_id', projectId).eq('label', 'published');   // one published snapshot per project
      var r = await db.from('project_snapshots').insert({ project_id: projectId, label: 'published', state: bundle });
      if (r.error) throw new Error(r.error.message);
      setStatus('Published ✓');
      if (hb) { hb.textContent = 'Published ✓'; setTimeout(function () { hb.textContent = 'Publish'; hb.disabled = false; }, 2500); }
    } catch (e) { console.warn('publish failed', e); setStatus('Publish failed'); if (hb) { hb.textContent = 'Publish'; hb.disabled = false; } }
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
    try { var r = await db.from('projects').select('name, center_lng, center_lat, zoom, raw_config').eq('id', projectId).single(); if (r.data) { document.getElementById('esp-name').value = r.data.name || ''; document.getElementById('esp-viewinfo').textContent = fmtView(r.data.center_lat, r.data.center_lng, r.data.zoom); var tl = r.data.raw_config && r.data.raw_config.timeline; document.getElementById('esp-tl-start').value = (tl && tl.start) || ''; var todayEnd = !!(tl && tl.end === 'today'); document.getElementById('esp-tl-today').checked = todayEnd; document.getElementById('esp-tl-end').disabled = todayEnd; document.getElementById('esp-tl-end').value = todayEnd ? '' : ((tl && tl.end) || ''); document.getElementById('esp-logo-link').value = (r.data.raw_config && r.data.raw_config.headerLink) || ''; document.getElementById('esp-feat-header').checked = !!(r.data.raw_config && r.data.raw_config.features && r.data.raw_config.features.header === true); } } catch (e) {}
    p.style.display = 'block';
  }
  async function saveMapName(name) {
    name = (name || '').trim(); if (!name) return;
    setStatus('Saving…');
    try { var r = await db.from('projects').update({ name: name }).eq('id', projectId); if (r.error) throw new Error(r.error.message); applyHeaderText(name); var ei = document.getElementById('esp-name'); if (ei && ei.value !== name) ei.value = name; setStatus('Map renamed'); } catch (e) { setStatus('Save failed'); }
  }
  async function onSettingsName() { return saveMapName(document.getElementById('esp-name').value); }
  // Feature: header on/off — persists raw_config.features.header and applies live (msApplyHeaderFeature
  // moves the logo/title/About into the sidebar; a resize event re-seats the tool dock + save callout).
  async function onFeatureHeader() {
    var show = document.getElementById('esp-feat-header').checked;
    setStatus('Saving…');
    try {
      var cur = await db.from('projects').select('raw_config').eq('id', projectId).single();
      var rc = (cur.data && cur.data.raw_config) || {};
      rc.features = rc.features || {}; rc.features.header = show;
      var r = await db.from('projects').update({ raw_config: rc }).eq('id', projectId);
      if (r.error) throw new Error(r.error.message);
      if (window.msApplyHeaderFeature) msApplyHeaderFeature(show, document.getElementById('esp-name').value);
      window.dispatchEvent(new Event('resize'));
      setStatus(show ? 'Header shown' : 'Header hidden — moved to the sidebar');
    } catch (e) { setStatus('Save failed'); }
  }
  function makeHeaderTitleEditable() {
    var h = document.getElementById('header-text-value'); if (!h || h._peEditable) return; h._peEditable = true;
    h.setAttribute('contenteditable', 'true'); h.setAttribute('spellcheck', 'false'); h.title = 'Click to rename this map';
    h.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); h.blur(); } });
    h.addEventListener('blur', function () { saveMapName(h.textContent); });
  }
  // The sidebar title (shown when the header is hidden) renames the map just like the header title.
  // Exposed on window so projectLoader's msApplyHeaderFeature can wire it whenever it builds the brand.
  function makeSidebarTitleEditable() {
    var h = document.querySelector('#sidebar-brand .sb-title'); if (!h || h._peEditable) return; h._peEditable = true;
    h.setAttribute('contenteditable', 'true'); h.setAttribute('spellcheck', 'false'); h.title = 'Click to rename this map';
    h.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); h.blur(); } });
    h.addEventListener('blur', function () { saveMapName(h.textContent); });
  }
  window.msMakeSidebarTitleEditable = makeSidebarTitleEditable;
  // ── Header chrome: text (= map name), logo image, logo link — applied live (no refresh) + on load ──
  function applyHeaderText(name) { try { var el = document.getElementById('header-text-value'); if (el) el.textContent = name; var sb = document.querySelector('#sidebar-brand .sb-title'); if (sb) sb.textContent = name; if (name) document.title = name; } catch (e) {} }
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
      // #4: inline × removed — delete now lives in the Edit map panel (openMapEdit → "Delete this map…").
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
      // #4: inline × removed — delete now lives in the Edit button panel (openButtonEdit → "Delete this button…").
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
  var _sessionBasemap = {};   // ltoggle/rtoggle → the style id chosen THIS session (radios are session-only)
  function onMapRadio(idx, rad) {   // SESSION-ONLY basemap switch — the per-side DEFAULT is set explicitly in the Edit-map panel
    _sessionBasemap[rad.name] = rad.value;
    var map = (rad.name === 'ltoggle') ? beforeMap : afterMap;
    if (!map || !rad.value) return;
    // use the engine's basemapStyle() so FREE basemaps (styleUrl: inline/URL) switch correctly —
    // hardcoding mapbox://styles/<user>/<id> whited out free basemaps (7/15). Fall back to that only
    // if the engine helper isn't present. Defer off mid-load (never setStyle while loading).
    var user = (typeof siteConfig !== 'undefined' && siteConfig && siteConfig.mapboxUsername) ? siteConfig.mapboxUsername : 'mapbox';
    var style = (typeof basemapStyle === 'function') ? basemapStyle(rad.value) : ('mapbox://styles/' + user + '/' + rad.value);
    function go() { try { map.setStyle(style); } catch (e) {} }
    if (map.isStyleLoaded && map.isStyleLoaded()) go(); else map.once('style.load', go);
  }
  function restoreSessionRadios() {   // after a re-render (which draws radios from the DEFAULTS), put the SESSION selection back
    ['ltoggle', 'rtoggle'].forEach(function (nm) {
      var v = _sessionBasemap[nm]; if (!v) return;
      var r = Array.prototype.slice.call(document.querySelectorAll('#base-maps-section input[type="radio"][name="' + nm + '"]')).filter(function (x) { return x.value === v; })[0];
      if (r) r.checked = true;
    });
  }
  function onMapDefaultSide(side, checked) {   // exclusive per side; a side always keeps exactly one default
    var bm = bmaps(); var m = bm && bm[_mapEditIdx]; if (!m) return;
    var key = side === 'left' ? 'lChecked' : 'rChecked';
    var box = document.getElementById(side === 'left' ? 'emp-def-left' : 'emp-def-right');
    if (!checked) { if (box) box.checked = true; setStatus('A side always needs a default — pick another map for the ' + side + ' side instead'); return; }
    // capture what the session's radios currently show, so changing the DEFAULT doesn't flip them
    var nm = side === 'left' ? 'ltoggle' : 'rtoggle';
    if (!_sessionBasemap[nm]) {
      var cur = document.querySelector('#base-maps-section input[type="radio"][name="' + nm + '"]:checked');
      if (cur) _sessionBasemap[nm] = cur.value;
    }
    bm.forEach(function (x, i) { x[key] = (i === _mapEditIdx); });
    saveBaseMaps(); rerenderMaps();
    setTimeout(restoreSessionRadios, 150);   // rerenderMaps redraws radios from the defaults — put the session state back
    setStatus('Saved — default ' + side + ' basemap: ' + (m.name || m.id));
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
      '<select id="emp-section" style="width:100%;box-sizing:border-box;padding:5px 6px;border:1px solid #bbbbbb;border-radius:4px;font-size:13px;"></select>' +
      '<div style="margin-top:10px;border-top:1px solid #e8e8e8;padding-top:8px;">' +
        '<label style="display:block;font-size:11px;color:#555555;margin-bottom:4px;">Defaults (how the map opens — one per side)</label>' +
        '<label style="cursor:pointer;font-size:12px;color:#555555;display:block;margin-bottom:3px;"><input id="emp-def-left" type="checkbox" style="vertical-align:middle;margin:0 5px 0 0;" />Default on the left side</label>' +
        '<label style="cursor:pointer;font-size:12px;color:#555555;display:block;"><input id="emp-def-right" type="checkbox" style="vertical-align:middle;margin:0 5px 0 0;" />Default on the right side</label>' +
      '</div>' +
      '<div style="margin-top:12px;border-top:1px solid #e8e8e8;padding-top:8px;">' +   // #4: delete moved off the sidebar row into the panel
        '<button id="emp-delete" style="width:100%;padding:6px;border:1px solid #e0b4b4;border-radius:4px;background:#fdeaea;color:#b4453a;cursor:pointer;font-size:12px;">Delete this map…</button>' +
      '</div>';
    document.body.appendChild(p);
    document.getElementById('emp-x').addEventListener('click', function () { p.style.display = 'none'; });
    document.getElementById('emp-name').addEventListener('change', onMapEditSave);
    document.getElementById('emp-style').addEventListener('change', onMapEditSave);
    document.getElementById('emp-section').addEventListener('change', onMapEditSave);
    document.getElementById('emp-def-left').addEventListener('change', function () { onMapDefaultSide('left', this.checked); });
    document.getElementById('emp-def-right').addEventListener('change', function () { onMapDefaultSide('right', this.checked); });
    document.getElementById('emp-delete').addEventListener('click', function () { if (_mapEditIdx != null) { deleteMap(_mapEditIdx); p.style.display = 'none'; } });
  }
  function openMapEdit(idx) {
    injectMapsPanel(); _mapEditIdx = idx;
    var m = (bmaps() || [])[idx]; if (!m) return;
    document.getElementById('emp-name').value = m.name || '';
    document.getElementById('emp-style').value = m.id || '';
    document.getElementById('emp-def-left').checked = !!m.lChecked;
    document.getElementById('emp-def-right').checked = !!m.rChecked;
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
      '<select id="ezb-section" style="width:100%;box-sizing:border-box;padding:5px 6px;border:1px solid #bbbbbb;border-radius:4px;font-size:13px;"></select>' +
      '<div style="margin-top:12px;border-top:1px solid #e8e8e8;padding-top:8px;">' +   // #4: delete moved off the sidebar row into the panel
        '<button id="ezb-delete" style="width:100%;padding:6px;border:1px solid #e0b4b4;border-radius:4px;background:#fdeaea;color:#b4453a;cursor:pointer;font-size:12px;">Delete this button…</button>' +
      '</div>';
    document.body.appendChild(p);
    document.getElementById('ezb-x').addEventListener('click', function () { p.style.display = 'none'; });
    document.getElementById('ezb-delete').addEventListener('click', function () { if (_btnEditIdx != null) { deleteZoomButton(_btnEditIdx); p.style.display = 'none'; } });
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
  // #17: show the signed-in account in the map header, like the front page nav — email → dashboard when
  // logged in; "Login" → the shared MapAuth modal otherwise. Styled like the View/Preview header pills.
  function wireHeaderUser() {
    // lives in the site-wide top bar now (right slot); the editor's chip also offers Login
    window.__msTopbarUserByPage = true;   // tell topbar.js not to add its own generic chip
    // ...and drop ALL it already added — the boot race could stack several in the pre-mount bar
    document.querySelectorAll('#ms-topbar-user').forEach(function (n) { n.remove(); });
    var right = document.getElementById('ms-topbar-right') || document.getElementById('editor-actions-status') || document.querySelector('.header-right');
    if (!right || document.getElementById('editor-nav-user')) return;
    var a = document.createElement('a');
    a.id = 'editor-nav-user';
    a.style.cssText = 'display:none;padding:3px 10px;border:1px solid #ccc;border-radius:5px;background:#fff;color:#222;font-size:11px;font-weight:600;text-decoration:none;font-family:Source Sans Pro,Arial,sans-serif;white-space:nowrap;';
    right.appendChild(a);
    async function refresh() {
      if (!window.MapAuth) return;
      var u = await MapAuth.currentUser();
      if (MapAuth.isReal(u)) { a.textContent = u.email; a.href = '../dashboard.html'; a.title = 'Your maps & account'; a.onclick = null; }
      else { a.textContent = 'Login'; a.href = '#'; a.title = 'Log in / register'; a.onclick = function (e) { e.preventDefault(); MapAuth.openAuthModal('login'); }; }
      a.style.display = 'inline-block';
    }
    refresh();
    try { if (window.MapAuth && MapAuth.onChange) MapAuth.onChange(refresh); } catch (e) {}
  }
  function moveActionsToTopbar() {
    var left = document.getElementById('ms-topbar-left');
    var src = document.getElementById('editor-actions');
    if (!left || !src || src.getAttribute('data-moved')) return;
    src.setAttribute('data-moved', '1');
    ['editor-mode-badge', 'editor-publish-btn', 'editor-view-btn', 'editor-preview-btn', 'editor-copy-btn', 'editor-settings'].forEach(function (id9) {
      var el = document.getElementById(id9); if (!el) return;
      left.appendChild(el);   // the bar's CSS normalizes size/padding for every item
    });
    src.remove();
    // 🔗 Share sits LEFT of Settings: WHO can see the map (private / link / public) lives here now, not in
    // Settings — visibility is a deliberate act, separate from publishing (which picks WHAT they see).
    if (!document.getElementById('editor-share-btn') && window.MapShare) {
      var shb = document.createElement('button');
      shb.id = 'editor-share-btn'; shb.textContent = '🔗 Share'; shb.title = 'Who can see this map — private, anyone with the link, or public';
      var stb = document.getElementById('editor-settings');
      if (stb && stb.parentNode === left) left.insertBefore(shb, stb); else left.appendChild(shb);
      shb.addEventListener('click', function () {
        MapShare.open({
          db: db, projectId: projectId,
          viewUrl: location.href.split('#')[0].split('?')[0].replace(/editor\.html$/, 'index.html') + '?id=' + projectId
        });
      });
    }
    if (!document.getElementById('editor-guide-btn')) {   // Guide lives next to Settings (editor-only chrome, built here so the shared page markup stays viewer-identical)
      var gb = document.createElement('button');
      gb.id = 'editor-guide-btn'; gb.textContent = '📖 Guide'; gb.title = 'How to build a map — every panel and button explained';
      left.appendChild(gb);
      gb.addEventListener('click', openGuidePanel);
    }
  }
  // ── Guide: how to construct a map (auto-generated draft — see the disclaimer it opens with).
  //    EDITABLE by the platform owner: ✎ in the modal header → WYSIWYG in place → saves to the global
  //    site_content row (key 'editor-guide', same table/gate as pageEditor). The generated text below is
  //    the fallback whenever that row doesn't exist (standalone/file:// deploys keep a guide). ──
  var GUIDE_KEY = 'editor-guide', GUIDE_ADMINS = ['nittyjee@gmail.com'];   // owner allow-list (client gate; RLS restricts writes at lockdown)
  var _guideFetched = false, _guideEditing = false, _guidePreEdit = null;
  function openGuidePanel() {
    injectGuidePanel();
    var ov = document.getElementById('editor-guide-overlay');
    if (ov) ov.style.display = 'block';
    loadGuideContent(); maybeShowGuideEdit();
  }
  function closeGuidePanel() {
    if (_guideEditing) return;   // backdrop/Esc never eat an edit in progress — Save, Cancel, or ✕ (=cancel) first
    var ov = document.getElementById('editor-guide-overlay'); if (ov) ov.style.display = 'none';
  }
  async function loadGuideContent() {   // owner-edited guide (global site_content row) replaces the generated draft
    if (_guideFetched || _guideEditing) return;
    _guideFetched = true;
    try {
      var r = await db.from('site_content').select('html').eq('key', GUIDE_KEY).maybeSingle();
      var body = document.getElementById('editor-guide-body');
      if (body && !_guideEditing && r && r.data && r.data.html) body.innerHTML = r.data.html;
    } catch (e) {}
  }
  async function maybeShowGuideEdit() {
    try {
      if (!window.MapAuth) return;
      var u = await MapAuth.currentUser();
      if (!u || !u.email || GUIDE_ADMINS.indexOf(u.email) === -1) return;
      var eb = document.getElementById('editor-guide-edit'); if (eb && !_guideEditing) eb.style.display = 'inline-block';
    } catch (e) {}
  }
  function guideSetEditing(on) {
    _guideEditing = on;
    var body = document.getElementById('editor-guide-body');
    if (body) { body.contentEditable = on ? 'true' : 'false'; body.style.outline = on ? '2px dashed #7c5cbf' : 'none'; body.style.outlineOffset = '-2px'; }
    ['editor-guide-save', 'editor-guide-cancel', 'editor-guide-restore'].forEach(function (id2) { var el = document.getElementById(id2); if (el) el.style.display = on ? 'inline-block' : 'none'; });
    var eb = document.getElementById('editor-guide-edit'); if (eb) eb.style.display = on ? 'none' : 'inline-block';
  }
  async function saveGuide() {
    var body = document.getElementById('editor-guide-body'); if (!body) return;
    var btn = document.getElementById('editor-guide-save'); if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    try {
      var r = await db.from('site_content').upsert([{ key: GUIDE_KEY, html: body.innerHTML }]);
      if (r.error) throw new Error(r.error.message);
      guideSetEditing(false);
      setStatus('Guide saved');
    } catch (e) {
      window.alert('Guide save failed: ' + e.message + (/relation|does not exist|schema cache/i.test(e.message) ? '\n\n(The site_content table isn\'t created yet — run mapstructor_docs/sql/setup/site-content-setup.sql.)' : ''));
    }
    if (btn) { btn.disabled = false; btn.textContent = 'Save'; }
  }
  function injectGuidePanel() {
    if (document.getElementById('editor-guide-overlay')) return;
    var css = document.createElement('style');
    css.textContent =
      '#editor-guide-overlay{position:fixed;inset:0;background:rgba(20,18,30,0.5);z-index:4000;display:none;}' +
      '#editor-guide-panel{position:absolute;top:5vh;left:50%;transform:translateX(-50%);width:700px;max-width:93vw;max-height:88vh;display:flex;flex-direction:column;background:#fff;border-radius:12px;box-shadow:0 18px 60px rgba(0,0,0,0.4);font-family:Source Sans Pro,Arial,sans-serif;color:#2a2a33;overflow:hidden;}' +
      '#editor-guide-head{display:flex;justify-content:space-between;align-items:center;padding:16px 24px 13px;border-bottom:1px solid #ece9f4;background:linear-gradient(180deg,#faf9fd,#fff);}' +
      '#editor-guide-head b{font-size:17px;letter-spacing:.01em;color:#1e1b2e;}' +
      '#editor-guide-head small{display:block;font-weight:400;font-size:12px;color:#8a86a0;margin-top:1px;}' +
      '#editor-guide-close{cursor:pointer;color:#a09cb5;font-size:22px;line-height:1;padding:2px 6px;border-radius:6px;}' +
      '#editor-guide-close:hover{background:#f1eef9;color:#544f6e;}' +
      '#editor-guide-body{overflow-y:auto;padding:4px 26px 26px;font-size:13.5px;line-height:1.55;}' +
      '#editor-guide-body .g-note{margin:14px 0 4px;padding:7px 11px;background:#fbf7ea;border-left:3px solid #d9be62;border-radius:0 6px 6px 0;font-size:11.5px;color:#7a6820;}' +
      '#editor-guide-body h3{display:flex;align-items:center;gap:8px;margin:24px 0 7px;font-size:14.5px;color:#1e1b2e;letter-spacing:.01em;}' +
      '#editor-guide-body h3 .g-n{flex:0 0 auto;width:21px;height:21px;border-radius:50%;background:#7c5cbf;color:#fff;font-size:11.5px;font-weight:700;display:flex;align-items:center;justify-content:center;}' +
      '#editor-guide-body p{margin:6px 0;}' +
      '#editor-guide-body ul{margin:4px 0 6px;padding-left:6px;list-style:none;}' +
      '#editor-guide-body li{margin:4px 0;padding-left:16px;position:relative;}' +
      '#editor-guide-body li::before{content:"";position:absolute;left:2px;top:8px;width:5px;height:5px;border-radius:50%;background:#c4b5e6;}' +
      '#editor-guide-body b{color:#1e1b2e;}' +
      '#editor-guide-body kbd{font-family:inherit;font-size:11px;font-weight:700;background:#f1eef9;border:1px solid #d9d2ee;border-bottom-width:2px;border-radius:4px;padding:0 5px;color:#544f6e;}' +
      '#editor-guide-body .g-flow{margin:8px 0 2px;padding:9px 12px;background:#f7f5fc;border-radius:8px;font-size:12.5px;color:#544f6e;}' +
      '#editor-guide-actions{display:flex;align-items:center;gap:7px;}' +
      '#editor-guide-actions button{display:none;padding:4px 12px;border:1px solid #cfc7e8;border-radius:6px;background:#fff;color:#544f6e;font:600 12px Source Sans Pro,Arial,sans-serif;cursor:pointer;}' +
      '#editor-guide-actions button:hover{background:#f1eef9;}' +
      '#editor-guide-actions #editor-guide-save{background:#7c5cbf;border-color:#7c5cbf;color:#fff;}' +
      '#editor-guide-actions #editor-guide-save:hover{background:#6246a8;}';
    document.head.appendChild(css);
    var ov = document.createElement('div');
    ov.id = 'editor-guide-overlay';
    ov.innerHTML =
      '<div id="editor-guide-panel">' +
        '<div id="editor-guide-head">' +
          '<div><b>📖 Guide</b><small>How to build a map, panel by panel</small></div>' +
          '<div id="editor-guide-actions">' +
            '<button id="editor-guide-edit" title="Edit the guide (owner only) — saves for every map">&#9998; Edit</button>' +
            '<button id="editor-guide-restore" title="Fill the editor with the built-in generated guide (Save to keep)">Restore default</button>' +
            '<button id="editor-guide-cancel">Cancel</button>' +
            '<button id="editor-guide-save">Save</button>' +
            '<span id="editor-guide-close">&times;</span>' +
          '</div>' +
        '</div>' +
        '<div id="editor-guide-body">' + guideDefaultHtml() + '</div>' +
      '</div>';
    document.body.appendChild(ov);
    document.getElementById('editor-guide-close').addEventListener('click', function () {   // ✕ while editing = cancel the edit, then close
      if (_guideEditing) { var b2 = document.getElementById('editor-guide-body'); if (b2 && _guidePreEdit != null) b2.innerHTML = _guidePreEdit; guideSetEditing(false); }
      closeGuidePanel();
    });
    document.getElementById('editor-guide-edit').addEventListener('click', function () { var b2 = document.getElementById('editor-guide-body'); _guidePreEdit = b2 ? b2.innerHTML : null; guideSetEditing(true); });
    document.getElementById('editor-guide-cancel').addEventListener('click', function () { var b2 = document.getElementById('editor-guide-body'); if (b2 && _guidePreEdit != null) b2.innerHTML = _guidePreEdit; guideSetEditing(false); });
    document.getElementById('editor-guide-restore').addEventListener('click', function () { var b2 = document.getElementById('editor-guide-body'); if (b2) b2.innerHTML = guideDefaultHtml(); });   // still needs Save to persist
    document.getElementById('editor-guide-save').addEventListener('click', saveGuide);
    ov.addEventListener('click', function (e) { if (e.target === ov) closeGuidePanel(); });   // click the backdrop → close (no-op while editing)
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeGuidePanel(); });
  }
  function guideDefaultHtml() {
    var N = 0;
    var h = function (t) { N++; return '<h3><span class="g-n">' + N + '</span>' + t + '</h3>'; };
    return '' +
          '<div class="g-note"><b>Auto-generated draft:</b> written by the AI assistant that builds MapStructor, not yet human-reviewed — where it disagrees with the app, trust the app.</div>' +
          h('What is MapStructor?') +
          '<p>MapStructor is a tool for building <b>interactive, layered, time-aware maps</b> — two synchronized maps separated by a swipe you drag to compare them — and publishing them on the web. With it you can:</p>' +
          '<ul>' +
          '<li>Draw <b>points, lines, and shapes</b> and give each one a label, notes, an image, and dates.</li>' +
          '<li><b>Import GIS data</b> (GeoJSON, KML, Shapefile) or connect hosted <b>tilesets</b> for big datasets.</li>' +
          '<li><b>Swipe between two basemaps</b> — say, a historic map against modern satellite.</li>' +
          '<li>Put features on a <b>timeline</b> so the map changes as you drag through time.</li>' +
          '<li>Link features to <b>encyclopedia pages</b> or notes that open in a side panel.</li>' +
          '<li><b>Publish</b> a public, shareable version whenever you\'re ready — edits stay private until then.</li>' +
          '</ul>' +
          h('Drawing on the map') +
          '<p>Pick the <b>point, line, or polygon</b> tool from the dock at the top-left, then click on the <b>left side of the swipe</b> to place it. Lines and shapes take a click per corner — finish with <kbd>Enter</kbd> or a double-click.</p>' +
          '<p>The new feature opens ready to describe: type its label right away. Drawing with no layer selected auto-creates an "Untitled" layer of the right type; click a layer first to draw into it. One geometry type lives per layer.</p>' +
          h('Adding your data') +
          '<p>Use the buttons above the layer list:</p>' +
          '<ul>' +
          '<li><b>+ Import</b> — upload GeoJSON, KML, or a zipped Shapefile. Features arrive as an editable layer; very large files automatically render the fast way.</li>' +
          '<li><b>+ Tileset</b> — connect a hosted vector tileset (URL + source layer) for city-scale data.</li>' +
          '<li><b>+ Layer</b> — a new empty layer to draw into.</li>' +
          '<li><b>⬇ Export</b> — download any layer back out as GeoJSON, KML, or Shapefile.</li>' +
          '</ul>' +
          h('Editing features & their info') +
          '<p>Clicks work in two stages, so you never move something by accident:</p>' +
          '<ul>' +
          '<li><b>Click once</b> (either side of the swipe): the feature highlights, its bubble stays open, and the info panel + editor appear — <b>Label</b>, formatted <b>Notes</b>, an <b>Image</b>, and <b>Start/End dates</b>. The bubble and map labels update as you type.</li>' +
          '<li><b>Click again</b>: the shape unlocks — drag it whole, or click once more to move corners.</li>' +
          '<li><kbd>Shift</kbd>/<kbd>Ctrl</kbd>-click collects several features; click one of them to edit it.</li>' +
          '<li><b>Click empty ground</b> to put everything away.</li>' +
          '</ul>' +
          '<p>Features from tilesets edit the same way — <b>✓ Done editing</b> folds one back when finished.</p>' +
          h('Styling layers & labels') +
          '<p><b>Click a layer</b> to open its style panel — every change previews live:</p>' +
          '<ul>' +
          '<li><b>Color, opacity, outline, size</b> — or color/thickness driven by a data column.</li>' +
          '<li><b>Map labels</b> from any field — sized by zoom by default (set far/mid/close sizes), with color, halo, bold, and density controls.</li>' +
          '<li><b>Popups</b> on hover and/or click, and which field they show.</li>' +
          '<li><b>Info panel</b> — notes or an encyclopedia page per feature.</li>' +
          '<li>A <b>zoom target</b>, the <b>attribute table</b>, outline splitting, and Delete.</li>' +
          '</ul>' +
          h('Organizing the sidebar') +
          '<p><b>Layers</b> hold features; <b>groups</b> hold layers; <b>sections</b> hold groups — files, folders, drives. Checkboxes show/hide for the session ("On by default" in the style panel decides how the map opens). Drag rows to reorder or re-home them; double-click to rename; the ▦ icon opens a layer\'s attribute table.</p>' +
          h('Setting the scene') +
          '<p>In the <b>MAPS</b> section, pick each side\'s basemap — this is the heart of the swipe comparison. <b>+ Map</b> adds basemaps from a style URL; <b>+ Button</b> makes a zoom shortcut from the current view. In <b>⚙ Settings</b>, set the map\'s name, its <b>default view</b>, and the <b>timeline range</b>; features with dates then come and go as the slider moves (blank dates = always visible).</p>' +
          h('Publishing & sharing') +
          '<p>Edits <b>autosave privately</b>. <b>Publish</b> pushes the current state to the public <b>View</b> page; <b>Preview</b> shows your unpublished edits. <b>⧉ Copy</b> clones any map as a new private one. Anonymous maps live only at their URL — <b>save to an account</b> (top right) so yours can\'t be lost, and use <b>&#128279; Share</b> (top bar) to choose who can see it: private, anyone with the link, or public.</p>' +
          h('Power tools') +
          '<p><b>Undo/redo</b> cover drawing, edits, and deletes. <b>Measure</b> reads out distance or area as you draw. <b>Split</b> cuts a shape along a drawn line; <b>Merge</b> joins several of the same type. The <b>attribute table</b> edits features in bulk (click a row to select, again to edit; ★ marks a working set). The <b>search box</b> flies to any place; <b>Zoom to Layers</b> fits everything you\'ve made.</p>';
  }
  function injectChrome() {
    var panel = document.getElementById('layers-panel-content');
    if (!panel || document.getElementById('editor-add-bar')) return;
    // the top bar mounts on DOMContentLoaded, which lands AFTER this boot path — retry until it's there
    var _tbTries = 0;
    var _tbIv = setInterval(function () {
      moveActionsToTopbar(); wireHeaderUser();
      if ((document.getElementById('editor-nav-user') && !document.getElementById('editor-actions')) || ++_tbTries > 50) clearInterval(_tbIv);
    }, 200);
    moveActionsToTopbar();
    wireHeaderUser();
    var style = document.createElement('style');
    style.textContent =
      '#editor-add-bar{padding:6px;}' +
      '#editor-add-bar .erow{display:flex;gap:6px;}' +
      '#editor-add-bar button{flex:1;padding:6px 0;border:none;border-radius:4px;cursor:pointer;font-size:12px;font-weight:600;background:#e8e8e8;color:#222222;}' +
      '#editor-add-bar button:hover{background:#d8d8d8;}' +
      '#editor-add-bar #editor-add-buttons button.active{background:#23374d;color:#fff;}' +   // #2: shows which add-form is open
      '#editor-add-form{margin-top:6px;}' +
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
      // Master tool panel: one slick frosted card, body-level fixed (OUTSIDE the swipe-clipped #before
      // container — the compare plugin clips the left map's container, controls included, at the divider),
      // LEFT-aligned just past the sidebar + its collapse button. pointer-events:auto on the WHOLE card
      // means the mouse never reaches the map anywhere over the toolbar (gaps included). Grid: row1 = draw
      // group | edit group, row2 col2 = locate+search (under the edit group, never under the drawing
      // tools). Three colour-framed groups; every button 36×36; one visual system, tops/bottoms flush.
      // master card: TRANSPARENT (user devtools 7/7 — no bg/blur/shadow, 3px padding); pointer-events:auto still blocks the map everywhere over it
      '#editor-tool-dock{position:fixed;left:374px;z-index:60;display:grid;grid-template-columns:auto auto;column-gap:10px;row-gap:8px;justify-items:start;align-items:start;padding:3px;border:1px solid rgba(30,27,46,0.07);border-radius:14px;pointer-events:auto;}' +
      '#editor-tool-dock>*{margin:0 !important;pointer-events:auto;}' +
      // three colour-tinted group frames (blue = draw, amber = edit, green = search); the white button boxes sit surrounded by colour
      '#editor-draw-cluster{grid-row:1;grid-column:1;display:flex;gap:6px;padding:7px;border-radius:10px;background:#e6efff;box-shadow:inset 0 0 0 1px rgba(43,108,232,0.22);}' +
      '#editor-map-tools{grid-row:1;grid-column:2;display:flex;gap:6px;padding:7px;border-radius:10px;background:#fdeede;box-shadow:inset 0 0 0 1px rgba(206,92,0,0.22);width:max-content;}' +
      '#editor-search-cluster{grid-row:2;grid-column:2;display:flex;align-items:center;padding:7px;border-radius:10px;background:#e6f4ea;box-shadow:inset 0 0 0 1px rgba(45,122,45,0.22);}' +
      // white button boxes inside the colour frames
      '#editor-tool-dock .mapboxgl-ctrl-group,#editor-map-tools .tgrp{background:#fff;border:none;border-radius:7px;box-shadow:0 1px 3px rgba(30,27,46,0.22);overflow:hidden;}' +
      '#editor-tool-dock .mapboxgl-ctrl-group{display:flex;height:30px;}' +   // group height MUST match the button size or engine.css clips them
      '#editor-tool-dock .mapboxgl-ctrl-group button{width:30px;height:30px;border:none;border-radius:0;background-color:#fff;}' +
      // sharp shadow ring: the 3 drawing tools are THE starting point — make that box pop
      '#editor-tool-dock #editor-draw-main{box-shadow:0 0 2px 2px #2c69de,0 2px 6px rgba(30,27,46,0.4);}' +
      '#editor-tool-dock .mapboxgl-ctrl-group button:hover{background-color:#eef1f5;}' +
      '#editor-tool-dock .mapboxgl-ctrl-group button+button,#editor-map-tools .tgrp button+button{border-left:1px solid #ececec;}' +
      '#editor-map-tools .tgrp{display:flex;}' +
      // search box: one white pill holding locate + geocoder (overflow VISIBLE so the geocoder dropdown escapes)
      '#editor-search-box{display:flex;align-items:center;height:30px;background:#fff;border-radius:7px;box-shadow:0 1px 3px rgba(30,27,46,0.22);}' +
      '#editor-search-box .mapboxgl-ctrl-group{background:none;box-shadow:none;border-radius:0;height:30px;}' +
      '#editor-search-box .mapboxgl-ctrl-group button{width:30px;height:30px;}' +
      '#editor-search-box .mapboxgl-ctrl-group button .mapboxgl-ctrl-icon{background-size:18px 18px;}' +   // keep the ICON near its original size (don\'t scale with the button)
      '#editor-search-box .mapboxgl-ctrl-geocoder{position:static;box-shadow:none;border-radius:0;background:none;border-left:1px solid #ececec;width:220px;max-width:220px;min-width:0;}' +
      '#editor-search-box .mapboxgl-ctrl-geocoder--input{height:30px;padding:5px 8px 5px 32px;font-size:13px;}' +
      '#editor-search-box .mapboxgl-ctrl-geocoder--icon-search{top:6px;left:8px;width:18px;height:18px;}' +
      // the Photon search control (.ms-search) fitted into the same pill: flush input, divider on the left
      '#editor-search-box .ms-search{margin:0;border-left:1px solid #ececec;}' +
      '#editor-search-box .ms-search input{box-shadow:none;border-radius:0 7px 7px 0;height:30px;width:220px;padding:5px 10px;box-sizing:border-box;}' +
      '#editor-search-box .ms-search-list{top:32px;}' +
      '#header-text-value{cursor:text;}' +
      '#header-text-value:hover{outline:1px dashed #ccc;outline-offset:3px;border-radius:3px;}' +
      '#header-text-value:focus{outline:2px solid #7c5cbf;outline-offset:3px;border-radius:3px;}' +
      '#editor-settings,#editor-share-btn{padding:4px 12px;height:28px;border:1px solid #bbb;border-radius:6px;background:#fff;color:#444;font-size:13px;font-weight:600;cursor:pointer;vertical-align:middle;white-space:nowrap;font-family:"Source Sans Pro",Arial,sans-serif;}' +
      '#editor-settings:hover,#editor-share-btn:hover{background:#f2f2f2;}' +
      '#editor-guide-btn{padding:4px 12px;height:28px;border:1px solid #bbb;border-radius:6px;background:#fff;color:#444;font-size:13px;font-weight:600;cursor:pointer;vertical-align:middle;white-space:nowrap;}' +
      '#editor-guide-btn:hover{background:#f2f2f2;}' +
      '#editor-map-tools button{width:30px;height:30px;border:none;border-radius:0;background:#fff;color:#222222;cursor:pointer;font-size:13px;line-height:1;padding:0;}' +
      '#editor-map-tools button:disabled{opacity:0.4;cursor:default;}' +
      '#editor-map-tools button:not(:disabled):hover{background:#e8e8e8;}' +
      '#editor-map-tools button.active{background:#ce5c00;color:#fff;}' +
      '#editor-measure-readout{position:fixed;top:240px;left:374px;z-index:60;display:none;background:rgba(35,55,77,0.96);color:#fff;font-size:14px;font-weight:600;padding:7px 14px;border-radius:6px;box-shadow:0 2px 8px rgba(0,0,0,0.3);cursor:pointer;font-family:Source Sans Pro,Arial,sans-serif;white-space:nowrap;}' +
      // #1: prominent transient toast for draw rejections (the tiny save-status text was too easy to miss).
      '#editor-toast{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:9999;display:none;background:rgba(206,92,0,0.97);color:#fff;font-size:15px;font-weight:600;padding:12px 20px;border-radius:8px;box-shadow:0 4px 18px rgba(0,0,0,0.4);font-family:Source Sans Pro,Arial,sans-serif;white-space:nowrap;pointer-events:none;}' +
      // first-run nudge: a bobbing pill under the draw tools with a tail pointing up at them
      '#editor-draw-hint{position:fixed;z-index:70;display:flex;align-items:center;gap:8px;background:#2b6ce8;color:#fff;font-family:Source Sans Pro,Arial,sans-serif;font-size:12px;font-weight:600;padding:6px 9px 6px 11px;border-radius:8px;box-shadow:0 5px 14px rgba(43,108,232,0.45);animation:edHintBob 1.3s ease-in-out infinite;}' +
      '#editor-draw-hint::before{content:"";position:absolute;top:-7px;left:26px;border-left:7px solid transparent;border-right:7px solid transparent;border-bottom:7px solid #2b6ce8;}' +
      '#editor-draw-hint .ed-hint-x{cursor:pointer;opacity:0.85;font-size:16px;line-height:1;padding:0 1px;}' +
      '#editor-draw-hint .ed-hint-x:hover{opacity:1;}' +
      // second nudge: green pill under the search box ("find a place first, then draw" — the map opens
      // world-wide, so search is often the better first step); staggered bob so the two pills alternate
      '#editor-search-hint{position:fixed;z-index:70;display:flex;align-items:center;gap:8px;background:#2d7a2d;color:#fff;font-family:Source Sans Pro,Arial,sans-serif;font-size:12px;font-weight:600;padding:6px 9px 6px 11px;border-radius:8px;box-shadow:0 5px 14px rgba(45,122,45,0.45);animation:edHintBob 1.3s ease-in-out infinite;animation-delay:.65s;}' +
      '#editor-search-hint::before{content:"";position:absolute;top:-7px;left:26px;border-left:7px solid transparent;border-right:7px solid transparent;border-bottom:7px solid #2d7a2d;}' +
      '#editor-search-hint .ed-hint-x{cursor:pointer;opacity:0.85;font-size:16px;line-height:1;padding:0 1px;}' +
      '#editor-search-hint .ed-hint-x:hover{opacity:1;}' +
      '@keyframes edHintBob{0%,100%{transform:translateY(0);}50%{transform:translateY(3px);}}';
    document.head.appendChild(style);
    var status = document.createElement('div'); status.id = 'editor-save-status';
    var bar = document.createElement('div'); bar.id = 'editor-add-bar';
    panel.parentNode.insertBefore(status, panel.nextSibling);
    panel.parentNode.insertBefore(bar, status.nextSibling);
    // editing tools float on the MAP, next to the draw toolbar — paired sub-boxes (undo/redo,
    // copy/paste, distance/area, merge/split), single-word tooltips
    var maptools = document.createElement('div'); maptools.id = 'editor-map-tools';
    maptools.innerHTML =
      '<span class="tgrp"><button id="editor-undo" title="Undo" disabled>↶</button>' +
      '<button id="editor-redo" title="Redo" disabled>↷</button></span>' +
      '<span class="tgrp"><button id="editor-measure-dist" title="Distance">📏</button>' +
      '<button id="editor-measure-area" title="Area">⬟</button></span>' +
      '<span class="tgrp"><button id="editor-copy" title="Copy">⧉</button>' +
      '<button id="editor-paste" title="Paste" disabled>⎘</button></span>' +
      '<span class="tgrp"><button id="editor-merge" title="Merge">∪</button>' +
      '<button id="editor-split" title="Split">✂</button></span>';
    // body-level dock: pull the draw group, geolocate and geocoder OUT of the swipe-clipped map container.
    // Wrappers: draw cluster (point/polygon/line box + its own delete box) | edit tools; locate+search
    // combine into ONE box on the second row, left-aligned under the edit tools.
    var toolDock = document.createElement('div'); toolDock.id = 'editor-tool-dock';
    toolDock.style.visibility = 'hidden';   // stay hidden until the map controls have docked — kills the "empty frames" flash on load
    document.body.appendChild(toolDock);
    var _dockShown = false;
    function revealDock() { if (_dockShown) return; _dockShown = true; toolDock.style.visibility = 'visible'; try { if (typeof hint !== 'undefined' && hint) hint.style.visibility = 'visible'; if (typeof hint2 !== 'undefined' && hint2) hint2.style.visibility = 'visible'; if (typeof placeHint === 'function') placeHint(); } catch (e) {} }
    var drawCluster = document.createElement('div'); drawCluster.id = 'editor-draw-cluster';
    var trashBox = document.createElement('div'); trashBox.id = 'editor-draw-trash'; trashBox.className = 'mapboxgl-ctrl-group mapboxgl-ctrl';
    var searchCluster = document.createElement('div'); searchCluster.id = 'editor-search-cluster';
    var searchBox = document.createElement('div'); searchBox.id = 'editor-search-box';   // white pill inside the green frame; holds locate + geocoder
    searchCluster.appendChild(searchBox);
    toolDock.appendChild(drawCluster);
    toolDock.appendChild(maptools);
    toolDock.appendChild(searchCluster);
    function positionToolDock() {
      var t = 140;
      try { var mc = document.getElementById('comparison-container'); if (mc) t = mc.getBoundingClientRect().top + 10; } catch (e) {}
      toolDock.style.top = t + 'px';
      var mr = document.getElementById('editor-measure-readout'); if (mr) mr.style.top = (t + 100) + 'px';   // readout sits below the search row, flush with the dock
    }
    positionToolDock();
    window.addEventListener('resize', positionToolDock);
    var _dockTries = 0, _dockIv = setInterval(function () {
      try {
        var src = document.querySelector('#before .mapboxgl-ctrl-top-left');
        if (src) Array.prototype.slice.call(src.children).forEach(function (el) {
          var isDraw = el.querySelector && el.querySelector('.mapbox-gl-draw_ctrl-draw-btn');
          var isGeo = el.querySelector && el.querySelector('.mapboxgl-ctrl-geolocate');
          // search = the Photon control (.ms-search, 7/14) — the old Mapbox geocoder class kept for safety
          var isSearch = el.classList && (el.classList.contains('ms-search') || el.classList.contains('mapboxgl-ctrl-geocoder'));
          if (isDraw) {   // reorder Point → Polygon → Line, split Delete into its own slightly-separated box
            el.id = 'editor-draw-main';   // the 3 drawing tools get the sharp stand-out shadow ring
            var pt = el.querySelector('.mapbox-gl-draw_point'), pg = el.querySelector('.mapbox-gl-draw_polygon'),
                ln = el.querySelector('.mapbox-gl-draw_line'), tr = el.querySelector('.mapbox-gl-draw_trash');
            if (pt) { pt.title = 'Point'; el.appendChild(pt); }
            if (pg) { pg.title = 'Polygon'; el.appendChild(pg); }
            if (ln) { ln.title = 'Line'; el.appendChild(ln); }
            drawCluster.appendChild(el);
            if (tr) { tr.title = 'Delete'; trashBox.appendChild(tr); drawCluster.appendChild(trashBox); }
          } else if (isGeo) {
            var gb = el.querySelector('.mapboxgl-ctrl-geolocate'); if (gb) gb.title = 'Locate';
            searchBox.insertBefore(el, searchBox.firstChild);   // locate always LEFT of the search input
          } else if (isSearch) {
            searchBox.appendChild(el);
          }
        });
        positionToolDock();
        var done = toolDock.querySelector('.mapbox-gl-draw_ctrl-draw-btn') && toolDock.querySelector('.mapboxgl-ctrl-geolocate') && (toolDock.querySelector('.ms-search') || toolDock.querySelector('.mapboxgl-ctrl-geocoder'));
        if (done || ++_dockTries > 60) { revealDock(); clearInterval(_dockIv); }   // reveal only once fully docked (or give up after ~24s and show whatever's there)
      } catch (e) { if (++_dockTries > 60) { revealDock(); clearInterval(_dockIv); } }
    }, 400);
    // Nudges: draw pill (blue, under the draw tools) + search pill (green, under the search box). Both show
    // on every open, auto-hide once the map's own features load (loadFeatures) or on the first draw / ×;
    // the search pill also retires the moment the search input is focused (advice taken). Every piece is
    // independently guarded — if one pill fails to build, nothing else is affected.
    try {
      var hint = document.createElement('div'); hint.id = 'editor-draw-hint';
      hint.innerHTML = '<span>Start here — draw!</span><span class="ed-hint-x" title="Dismiss">&times;</span>';
      hint.style.visibility = 'hidden';   // revealed together with the dock (revealDock)
      document.body.appendChild(hint);
      var hint2 = document.createElement('div'); hint2.id = 'editor-search-hint';
      hint2.innerHTML = '<span>&hellip;or find a place first</span><span class="ed-hint-x" title="Dismiss">&times;</span>';
      hint2.style.visibility = 'hidden';
      document.body.appendChild(hint2);
      var placeHint = function () {
        try { if (hint) { var r = drawCluster.getBoundingClientRect(); if (r.width) { hint.style.top = (r.bottom + 11) + 'px'; hint.style.left = r.left + 'px'; } } } catch (e) {}
        try { if (hint2) { var s = searchCluster.getBoundingClientRect(); if (s.width) { hint2.style.top = (s.bottom + 11) + 'px'; hint2.style.left = s.left + 'px'; } } } catch (e) {}
      };
      placeHint();
      var _hintIv = setInterval(placeHint, 500); setTimeout(function () { clearInterval(_hintIv); }, 8000);
      window.addEventListener('resize', placeHint);
      var dismissDrawHint = function () { if (!hint) return; hint.remove(); hint = null; };
      var dismissSearchHint = function () { if (!hint2) return; hint2.remove(); hint2 = null; };
      hint.querySelector('.ed-hint-x').addEventListener('click', dismissDrawHint);
      hint2.querySelector('.ed-hint-x').addEventListener('click', dismissSearchHint);
      document.addEventListener('focusin', function (e) { try { if (e.target && e.target.closest && e.target.closest('#editor-search-box')) dismissSearchHint(); } catch (e2) {} });
      window._msDismissDrawHint = dismissDrawHint;     // onDrawCreate + loadFeatures(has-features) call these
      window._msDismissSearchHint = dismissSearchHint;
    } catch (e) {}
    var measureReadout = document.createElement('div'); measureReadout.id = 'editor-measure-readout'; measureReadout.title = 'Click to dismiss';
    measureReadout.addEventListener('click', function () { this.style.display = 'none'; clearMeasureShape(); });
    document.body.appendChild(measureReadout);
    var toastEl = document.createElement('div'); toastEl.id = 'editor-toast'; document.body.appendChild(toastEl);   // #1
    document.getElementById('editor-undo').addEventListener('click', doUndo);
    document.getElementById('editor-redo').addEventListener('click', doRedo);
    document.getElementById('editor-copy').addEventListener('click', doCopy);
    document.getElementById('editor-paste').addEventListener('click', doPaste);
    document.getElementById('editor-measure-dist').addEventListener('click', function () { doMeasure('distance'); });
    document.getElementById('editor-measure-area').addEventListener('click', function () { doMeasure('area'); });
    document.getElementById('editor-merge').addEventListener('click', doMerge);
    document.getElementById('editor-split').addEventListener('click', enterSplitMode);
    document.getElementById('editor-settings').addEventListener('click', openSettingsPanel);
    var pubBtn = document.getElementById('editor-publish-btn'); if (pubBtn) pubBtn.addEventListener('click', onPublish);
    var copyBtn = document.getElementById('editor-copy-btn'); if (copyBtn) copyBtn.addEventListener('click', copyMapToMyAccount);
    // ── Editor swipe start position (EDITOR ONLY — the viewer keeps the plugin's centered default) ──
    // The swipe handle opens 1/10th in from the RIGHT edge: ~90% of the screen is the LEFT (editable)
    // map, with only a sliver of the right/mirror side — first of the "make right-side non-editability
    // obvious" experiments. ✎ ADJUST HERE: fraction measured from the LEFT — 0 = far left (all mirror),
    // 0.5 = center, 0.90 = a tenth from the right, 1 = far right (all editable map).
    var EDITOR_SWIPE_START_FRACTION = 0.93;
    (function placeEditorSwipe() {
      var tries = 0;
      var iv = setInterval(function () {
        try {
          var cmp = window.map;   // mapinit.js keeps the mapbox-gl-compare instance in the `map` global
          var cont = document.getElementById('comparison-container');
          if (cmp && typeof cmp.setSlider === 'function' && cont && cont.offsetWidth) {
            cmp.setSlider(Math.round(cont.offsetWidth * EDITOR_SWIPE_START_FRACTION));
            clearInterval(iv);
            return;
          }
        } catch (e) {}
        if (++tries > 50) clearInterval(iv);   // compare never showed (single-map deploys) — give up quietly
      }, 200);
    })();
    setTimeout(checkStorage, 2500);   // storage-quota state (warn banner / hard-stop) once the session is ready
    makeHeaderTitleEditable();   // click the map title in the header to rename it
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
  var _hydratedLayers = {};   // layer db id → true once its feature rows have been fetched this session
  var _hydrateOne = null;     // set by loadFeatures (closes over its row-mapper): fetch ONE layer's rows now + add to draw if its checkbox is on
  var _suppressFeatureDelete = false;  // set during a hide-toggle so onDrawDelete skips the DB
  var selectedDrawId = null;
  var _featTimer = null, _lblLiveTimer = null;
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
  var STROKE_WIDTH = ['coalesce', ['get', 'user_strokewidth'], 2];        // LINE width, per-feature so width edits preview live
  var POLY_STROKE_WIDTH = ['coalesce', ['get', 'user_strokewidth'], 0.5];   // polygon outline width — 0.5 default (thinner than mapbox's native 1px)
  var POINT_STROKE_WIDTH = ['coalesce', ['get', 'user_strokewidth'], 1.5]; // circle outline width — NOT 1px-capped like fill-outline, no separate layer needed
  var RADIUS_BASE = ['coalesce', ['get', 'user_radius'], 6];               // the radius slider sets the ZOOMED-IN size; farther out points shrink like real markers
  var RADIUS = ['interpolate', ['linear'], ['zoom'], 6, ['max', 2, ['*', 0.35, RADIUS_BASE]], 11, ['*', 0.65, RADIUS_BASE], 16, RADIUS_BASE];
  var DRAW_STYLES = [
    { id: 'gl-draw-polygon-fill-inactive', type: 'fill', filter: ['all', ['==', 'active', 'false'], ['==', '$type', 'Polygon'], ['!=', 'mode', 'static']], paint: { 'fill-color': COLOR, 'fill-outline-color': OUTLINE_FILL, 'fill-opacity': FILL_OPACITY } },
    { id: 'gl-draw-polygon-fill-active', type: 'fill', filter: ['all', ['==', 'active', 'true'], ['==', '$type', 'Polygon']], paint: { 'fill-color': '#fbb03b', 'fill-outline-color': '#fbb03b', 'fill-opacity': 0.55 } },
    { id: 'gl-draw-polygon-stroke-inactive', type: 'line', filter: ['all', ['==', 'active', 'false'], ['==', '$type', 'Polygon'], ['!=', 'mode', 'static']], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': OUTLINE_FILL, 'line-width': POLY_STROKE_WIDTH, 'line-opacity': OUTLINE_OPACITY } },
    { id: 'gl-draw-polygon-stroke-active', type: 'line', filter: ['all', ['==', 'active', 'true'], ['==', '$type', 'Polygon']], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#fbb03b', 'line-dasharray': [0.2, 2], 'line-width': 2 } },
    { id: 'gl-draw-line-inactive', type: 'line', filter: ['all', ['==', 'active', 'false'], ['==', '$type', 'LineString'], ['!=', 'mode', 'static']], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': COLOR, 'line-width': STROKE_WIDTH, 'line-opacity': STROKE_OPACITY } },
    { id: 'gl-draw-line-active', type: 'line', filter: ['all', ['==', '$type', 'LineString'], ['==', 'active', 'true']], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#fbb03b', 'line-dasharray': [0.2, 2], 'line-width': 2 } },
    { id: 'gl-draw-polygon-and-line-vertex-halo-active', type: 'circle', filter: ['all', ['==', 'meta', 'vertex'], ['==', '$type', 'Point'], ['!=', 'mode', 'static']], paint: { 'circle-radius': 5, 'circle-color': '#fff' } },
    { id: 'gl-draw-polygon-and-line-vertex-active', type: 'circle', filter: ['all', ['==', 'meta', 'vertex'], ['==', '$type', 'Point'], ['!=', 'mode', 'static']], paint: { 'circle-radius': 3, 'circle-color': '#fbb03b' } },
    { id: 'gl-draw-polygon-midpoint', type: 'circle', filter: ['all', ['==', '$type', 'Point'], ['==', 'meta', 'midpoint']], paint: { 'circle-radius': 3, 'circle-color': '#fbb03b' } },
    { id: 'gl-draw-point-inactive', type: 'circle', filter: ['all', ['==', 'active', 'false'], ['==', '$type', 'Point'], ['==', 'meta', 'feature'], ['!=', 'mode', 'static']], paint: { 'circle-radius': RADIUS, 'circle-color': COLOR, 'circle-stroke-width': POINT_STROKE_WIDTH, 'circle-stroke-color': OUTLINE_PT, 'circle-opacity': STROKE_OPACITY } },
    { id: 'gl-draw-point-active', type: 'circle', filter: ['all', ['==', '$type', 'Point'], ['==', 'active', 'true'], ['==', 'meta', 'feature']], paint: { 'circle-radius': 6, 'circle-color': '#fbb03b' } },
  ];

  function setActiveLayer(id, opts) {
    activeLayerId = id;
    var panel = document.getElementById('layers-panel-content'); if (!panel) return;
    panel.querySelectorAll('.layer-list-row.editor-active').forEach(function (el) { el.classList.remove('editor-active'); });
    panel.querySelectorAll('.layer-list-row[data-node-id="' + id + '"]').forEach(function (row) { row.classList.add('editor-active'); });
    var node = findNodeById(layers, id);
    // drawn layers always get the style panel; tilesets get it too once they have a styleable type
    var styleable = node && (node.source_type === 'geojson-supabase' || (isTilesetNode(node) && ['fill', 'line', 'circle'].indexOf(node.type) > -1));
    if (node) {
      // opts.noPanel (adding a FEATURE auto-activates its layer): never OPEN the style panel — it opens
      // only when the user clicks the layer. An already-open panel still re-targets so it's never stale.
      var lp = document.getElementById('editor-layer-panel');
      if (!(opts && opts.noPanel) || (lp && lp.style.display !== 'none')) showLayerPanel(id);
    } else hideLayerPanel();   // every layer + group + section opens the panel; sections get a minimal title+Delete panel (#4)
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
    window._msDraw = draw;   // engine helpers (Zoom to Layers bounds) read the live drawn features here — guarded there, so its absence never breaks the engine
    beforeMap.addControl(draw, 'top-left');   // left side, clear of the right swipe map (offset past the sidebar in CSS)
    beforeMap.on('draw.render', measureRender);   // live distance while measuring
    beforeMap.on('draw.render', scheduleMirrorSync);   // mirror the MapboxDraw contents onto the right swipe side (both-sides display)
    try { if (typeof afterMap !== 'undefined' && afterMap) afterMap.once('idle', syncMirrorRight); } catch (e) {}   // initial paint once the right map is ready
    beforeMap.on('draw.create', onDrawCreate);
    beforeMap.on('draw.update', onDrawUpdate);
    beforeMap.on('draw.delete', onDrawDelete);
    beforeMap.on('draw.selectionchange', onSelectionChange);
    // modifier state at the moment of the click, for the multi-select bypass (selectionchange carries no originalEvent)
    try { beforeMap.getCanvasContainer().addEventListener('mousedown', function (ev) { window._msModClick = !!(ev.shiftKey || ev.ctrlKey || ev.metaKey); }, true); } catch (e) {}
    injectFeaturePanel();
    loadFeatures();
    wireDrawPopups();
    wireRightSideDrawGuard();
  }
  // ── #14: hover/click popups for MapboxDraw-rendered (edit-mode) features ─────
  // The engine's popup handlers listen on the slug-left/right layers, which are HIDDEN in the editor for
  // small drawn layers (their features live in MapboxDraw) — hidden layers fire no mouse events, so bubbles
  // never showed while editing. These handlers read the LIVE toggles (#12), and clicking still selects the
  // feature for editing (editor = viewer + tools; neither suppresses the other).
  var _drawHoverPop = null, _drawClickPop = null, _drawClickPopId = null, _hoverHlId = null, _refreshOpenPill = null;
  // ── draw-side guard: drawing only works on the LEFT map; while a draw tool is armed, hovering the RIGHT
  //    map shows a not-allowed cursor + a pill "Draw on the left side ←" that follows the cursor. ──
  var _rightHintEl = null;
  function isDrawArmed() {   // read the live mode (programmatic changeMode doesn't reliably fire draw.modechange in v1.4.3)
    try { return /^draw_/.test(draw && draw.getMode ? draw.getMode() : ''); } catch (e) { return false; }
  }
  function ensureRightHint() {
    if (_rightHintEl) return _rightHintEl;
    var el = document.createElement('div');
    el.id = 'editor-right-draw-hint';
    el.innerHTML = '&#9940; Draw on the left side &larr;';   // ⛔ + arrow pointing back to the drawable side
    el.style.cssText = 'position:fixed;z-index:2500;display:none;pointer-events:none;background:rgba(30,27,46,0.92);color:#fff;font:600 12px "Source Sans Pro",Arial,sans-serif;padding:5px 10px;border-radius:7px;box-shadow:0 2px 9px rgba(0,0,0,0.32);white-space:nowrap;transform:translate(16px,16px);';
    document.body.appendChild(el);
    _rightHintEl = el; return el;
  }
  function hideRightDrawHint() {
    if (_rightHintEl) _rightHintEl.style.display = 'none';
    try { if (typeof afterMap !== 'undefined' && afterMap) afterMap.getCanvas().style.cursor = ''; } catch (e) {}
  }
  function wireRightSideDrawGuard() {
    if (typeof beforeMap === 'undefined' || !beforeMap) return;
    beforeMap.on('draw.modechange', function () { if (!isDrawArmed()) hideRightDrawHint(); });   // returning to simple_select clears a stuck pill/cursor
    if (typeof afterMap !== 'undefined' && afterMap) {
      afterMap.on('mousemove', function (e) {
        if (!isDrawArmed()) { hideRightDrawHint(); return; }
        try { afterMap.getCanvas().style.cursor = 'not-allowed'; } catch (x) {}
        var el = ensureRightHint(), oe = e.originalEvent;
        el.style.left = ((oe ? oe.clientX : 0)) + 'px';
        el.style.top = ((oe ? oe.clientY : 0)) + 'px';
        el.style.display = 'block';
      });
      afterMap.on('mouseout', hideRightDrawHint);
    }
    beforeMap.on('mousemove', function () { if (!isDrawArmed() && _rightHintEl && _rightHintEl.style.display !== 'none') hideRightDrawHint(); });   // disarmed + moved onto the left map → clear any lingering pill
  }
  function drawNodeFor(did) { var lid = featureLayer[did]; return lid ? nodeByLayerDbId(lid) : null; }
  // Hover-highlight for MapboxDraw features: a dedicated overlay source/layers on BOTH maps, fed the hovered
  // feature's geometry (proven be-merge-hl approach — works for features drawn this session too, which the
  // engine's feature-state sources can't see). Styling mirrors configLoader's defaultHighlightPaint.
  function ensureHoverHlLayers(map) {
    try {
      if (!map || map.getSource('edit-hover-hl')) return;
      map.addSource('edit-hover-hl', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({ id: 'edit-hover-hl-fill', type: 'fill', source: 'edit-hover-hl', filter: ['==', '$type', 'Polygon'], paint: { 'fill-color': ['coalesce', ['get', 'color'], '#3bb2d0'], 'fill-opacity': 0.55 } });
      map.addLayer({ id: 'edit-hover-hl-line', type: 'line', source: 'edit-hover-hl', filter: ['==', '$type', 'LineString'], paint: { 'line-color': ['coalesce', ['get', 'color'], '#3bb2d0'], 'line-width': 5 } });
      map.addLayer({ id: 'edit-hover-hl-point', type: 'circle', source: 'edit-hover-hl', filter: ['==', '$type', 'Point'], paint: { 'circle-color': ['coalesce', ['get', 'color'], '#3bb2d0'], 'circle-radius': 9, 'circle-opacity': 0.85 } });
      if (typeof msRaiseLabelLayers === 'function') msRaiseLabelLayers(map, layers);   // the highlight must glow UNDER the labels
    } catch (e) {}
  }
  function setHoverHl(did, node) {   // did=null clears
    if (did === _hoverHlId) return;
    _hoverHlId = did;
    var fc = { type: 'FeatureCollection', features: [] };
    if (did) {
      var f = null; try { f = draw && draw.get(did); } catch (e) {}
      if (f && f.geometry) fc.features.push({ type: 'Feature', geometry: f.geometry, properties: { color: (node && node.iconColor) || '#3bb2d0' } });
    }
    [typeof beforeMap !== 'undefined' ? beforeMap : null, typeof afterMap !== 'undefined' ? afterMap : null].forEach(function (m) {
      if (!m) return;
      ensureHoverHlLayers(m);
      try { var s = m.getSource('edit-hover-hl'); if (s) s.setData(fc); } catch (e) {}
    });
  }
  function drawFeatureAt(pt) {
    try {
      // ±8px grab corridor — thin lines are brutal to hit exactly; NEAREST candidate wins
      var bx = 8;
      var fs = beforeMap.queryRenderedFeatures([[pt.x - bx, pt.y - bx], [pt.x + bx, pt.y + bx]]);
      var cands = [];
      for (var i = 0; i < fs.length; i++) {
        var f = fs[i];
        if (!f.layer || String(f.layer.id).indexOf('gl-draw') !== 0) continue;
        var did = f.properties && (f.properties.id || f.properties.parent);
        if (did && featureMeta[did]) { f._msDid = did; cands.push(f); }
      }
      if (cands.length) {
        var hit = (typeof nearestFeature === 'function' && nearestFeature(cands, pt)) || cands[0];
        return hit._msDid;
      }
    } catch (e) {}
    return null;
  }
  // pill for the GROUP corridor hover — same chrome as feature bubbles, text = the hovered
  // family's raw name (the popup rides the glow, not exact feature touch)
  function groupPillHtml(node, raw) {
    var val = String(raw == null ? '' : raw).trim();
    if (!val) return null;
    var col = (node && node.iconColor) || '#3bb2d0';
    var bg = colorTint(col, 0.5);
    return "<div style=\"background-color:" + bg + ";border:solid " + col + " 2px;padding:5px;\">" + val.replace(/[<>&]/g, function (c) { return ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]; }) + '</div>';
  }
  function drawPopupHtml(node, did) {
    var meta = featureMeta[did] || {};
    var prop = node._uiLabel || node.prop || 'label';
    // label-field lookup: meta field → imported attribute column (custom_fields, e.g. ESRI "LABEL") → label
    var val = (prop === 'label') ? (meta.label || '')
      : ((meta[prop] != null ? meta[prop] : (meta.custom && meta.custom[prop] != null ? meta.custom[prop] : meta.label)) || '');
    if (!val) return null;   // no label → no bubble (never show a stale/empty one)
    // chrome = the FEATURE's own colour (matches icons + multicolor layers), legacy pill box model
    var col = drawFeatureColor(node, did);
    var bg = colorTint(col, 0.5);
    return "<div style=\"background-color:" + bg + ";border:solid " + col + " 2px;padding:5px;\">" + String(val).replace(/[<>&]/g, function (c) { return ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]; }) + '</div>';
  }
  function colorTint(col, a) {   // translucent version of ANY css colour format (hex / rgb() / rgba() / other)
    col = String(col || '').trim();
    if (col[0] === '#' && typeof hexToRgba === 'function') return hexToRgba(col, a);
    var m = col.match(/^rgba?\(([^)]+)\)$/i);
    if (m) { var parts = m[1].split(',').slice(0, 3).map(function (x) { return x.trim(); }); return 'rgba(' + parts.join(',') + ',' + a + ')'; }
    return col;   // named colours etc. — used solid (no cheap tint available)
  }
  function drawFeatureColor(node, did) {   // the bubble chrome uses the FEATURE's own colour (colour rule) —
    try { var f = draw && draw.get(did); if (f && f.properties && f.properties.color) return f.properties.color; } catch (e) {}
    return (node && node.iconColor) || '#3bb2d0';   // identical to the layer colour on single-colour layers
  }
  function wireDrawPopups() {
    if (wireDrawPopups._done || typeof beforeMap === 'undefined') return; wireDrawPopups._done = true;
    var _clickPops = [], _hoverPops = [];
    function closeClickPops() { _clickPops.forEach(function (cp) { try { if (cp.isOpen()) cp.remove(); } catch (e) {} }); _drawClickPopId = null; }
    function closeHoverPops() { _hoverPops.forEach(function (hp) { try { if (hp.isOpen()) hp.remove(); } catch (e) {} }); }
    [beforeMap, (typeof afterMap !== 'undefined' ? afterMap : null)].forEach(function (m) {
      if (!m) return;   // BOTH swipe sides get hover/click popups (the maps are camera-synced, so the left
      var hoverPop = new mapboxgl.Popup({ closeButton: false, closeOnClick: false });          // map's rendered features answer hit-tests for either side)
      var clickPop = new mapboxgl.Popup({ closeButton: false, closeOnClick: false, offset: 5 });
      _clickPops.push(clickPop); _hoverPops.push(hoverPop);
      m.on('mousemove', function (e) {
        if (window._msPanelDrag) return;   // dragging a panel edge over the map is not a feature hover
        var did = drawFeatureAt(e.point);
        var node = did ? drawNodeFor(did) : null;
        // the RIGHT map has no MapboxDraw (which handles the left cursor) — set the pointer here
        // (but never while a draw tool is armed: the draw-side guard owns the right cursor then = not-allowed)
        if (m !== beforeMap && !isDrawArmed()) { try { m.getCanvas().style.cursor = did ? 'pointer' : ''; } catch (x) {} }
        // hover-HIGHLIGHT (independent of the popup toggle; default on, gated by the layer's elp-hl
        // setting; grouped layers never emphasize a single piece — the group overlay owns hover)
        setHoverHl((did && node && node.hoverHighlight !== false && !node.groupBy) ? did : null, node);
        // group hover: any piece of a "Treat as one" layer glows the WHOLE company (clicked group pins)
        try { groupHoverAt(e.point); } catch (egh) {}
        var on = node && (node._uiHover != null ? node._uiHover : !!node.popupStyle);
        if (did && _drawClickPopId === did) on = false;   // click bubble already labels it — never stack a hover bubble on top
        var html = (did && node && on) ? drawPopupHtml(node, did) : null;
        // the bubble rides the GLOW: a corridor hit on a grouped layer labels the company even
        // when the cursor isn't touching the feature pixel-exactly (gated by the popup toggle)
        if (!html && _lastGroupGv) {
          var gn = _lastGroupGv.node;
          var gOn = gn && (gn._uiHover != null ? gn._uiHover : !!gn.popupStyle);
          if (gOn) html = groupPillHtml(gn, _lastGroupGv.raw);
        }
        if (!html) { if (hoverPop.isOpen()) hoverPop.remove(); return; }
        hoverPop.setLngLat(e.lngLat).setHTML(html);
        if (!hoverPop.isOpen()) hoverPop.addTo(m);
      });
      m.on('click', function (e) {
        var did = drawFeatureAt(e.point);
        // click empty ground → clear EVERYTHING ourselves (highlight, panel, bubbles, stage). In stage 1
        // draw's own selection is already EMPTY, so no selectionchange will ever fire to do this — relying
        // on draw's event was the "stuck panel/highlight" hole. When something IS selected (stage 2, left
        // side), draw's own pipeline still deselects and fires; these clears are idempotent alongside it.
        if (!did && (_armedSet.length || selectedDrawId || _editingDraw)) {
          clearArmedSet();
          _editingDraw = null;
          hideFeaturePanel();
          closeClickPops(); closeHoverPops();
          syncAttrRowsFromMap([]);
        }
        // the RIGHT swipe map has no MapboxDraw — run the same two-stage click model programmatically
        // there (stage 1 = panel/highlight, stage 2 = geometry), so both sides feel identical.
        // Gate on the swipe divider TOO, not just which map fired: if the compare clip ever breaks
        // (it recomputes on resize), afterMap receives LEFT-side clicks — this path would then silently
        // pre-select and starve draw's own pipeline of its selectionchange events (verified headless).
        var rightOfSwipe = (function () {
          try { var el = document.querySelector('.mapboxgl-compare'); var cx = e.originalEvent && e.originalEvent.clientX; return !el || cx == null || cx >= el.getBoundingClientRect().left; } catch (err) { return true; }
        })();
        if (m !== beforeMap && draw && rightOfSwipe) {
          if (did && did !== _editingDraw) {
            if (_armedSet.indexOf(did) > -1) {   // stage 2: geometry editable (selection lives in draw on the left; the mirror shows it)
              _editingDraw = did; _armedSet = []; setArmedHl(null);
              try { draw.changeMode('simple_select', { featureIds: [did] }); } catch (err) {}
            } else {                              // stage 1: highlight + panel, geometry NOT editable
              _editingDraw = null; _armedSet = [did];
              try { draw.changeMode('simple_select', { featureIds: [] }); } catch (err) {}
              updateArmedHl();
            }
            showFeaturePanel(did);
            syncAttrRowsFromMap([{ id: did }]);
          } else if (!did) {
            // panel/highlight/bubble clears happened in the unified empty-click block above; only draw's
            // selection lives here (draw can't see right-side clicks). Guarded so an active draw MODE
            // (draw_point etc.) is never cancelled by a stray right-side click.
            try { if (draw.getSelectedIds().length && draw.getMode() === 'simple_select') draw.changeMode('simple_select', { featureIds: [] }); } catch (err) {}
          }
        }
        var node = did ? drawNodeFor(did) : null;
        var on = node && (node._uiClick != null ? node._uiClick : !!node.click);
        var html = (did && node && on) ? drawPopupHtml(node, did) : null;
        if (!html) { closeClickPops(); return; }
        if (_drawClickPopId !== did) closeClickPops();   // a DIFFERENT feature's bubble closes; re-clicks refresh below
        _drawClickPopId = did;
        clickPop.setLngLat(e.lngLat).setHTML(html);      // re-click = re-anchor + fresh label (no toggle-off: the selected feature's bubble stays open until you click off it)
        if (!clickPop.isOpen()) clickPop.addTo(m);
      });
    });
    // live pill refresh: typing in the feature panel updates the OPEN bubble's label in realtime
    _refreshOpenPill = function (did) {
      if (!did || _drawClickPopId !== did) return;
      var node = drawNodeFor(did);
      var on = node && (node._uiClick != null ? node._uiClick : !!node.click);
      var html = (node && on) ? drawPopupHtml(node, did) : null;
      if (!html) { closeClickPops(); return; }   // label emptied → no bubble (never show a stale one)
      _clickPops.forEach(function (cp) { try { if (cp.isOpen()) cp.setHTML(html); } catch (err) {} });
    };
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
    if (storageGate()) return;   // storage hard-stop
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
      try { _editingDraw = mergedId; _armedSet = []; setArmedHl(null); draw.changeMode('simple_select', { featureIds: [mergedId] }); } catch (e) {}   // programmatic select fires no selectionchange — set the stage bookkeeping here (a stale _skipArmOnce made the NEXT click behave unpredictably)
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

  // ── Storage enforcement (Step 22): warn at 80%, hard-stop new features at 100% ──
  var _storageOver = false, _storageInfo = null, _storageBusy = false, _storageLast = 0, _storageTries = 0;
  async function checkStorage() {
    if (_storageBusy) return; _storageBusy = true;
    try {
      var P = window.MapStructorPricing; if (!P) return;
      var u = await db.auth.getUser(); var uid = u && u.data && u.data.user && u.data.user.id;
      if (!uid) { if (_storageTries++ < 10) setTimeout(checkStorage, 1500); return; }   // session not ready yet — retry
      // the ADMIN account is quota-exempt (for now) — no banner, no gate; the platform-wide
      // free-infra alert lives on admin.html instead (30% of the Supabase free plan)
      var uEmail = u.data.user.email || '';
      if (MS_ADMINS.indexOf(uEmail) > -1) { _storageOver = false; _storageInfo = null; _storageLast = Date.now(); updateStorageBanner(); return; }
      var tierKey = 'free';
      try { var pr = await db.from('profiles').select('subscription_tier').eq('id', uid).maybeSingle(); if (pr.data && pr.data.subscription_tier) tierKey = pr.data.subscription_tier; } catch (e) {}
      var used = 0;
      try { var rpc = await db.rpc('mapstructor_user_storage'); if (!rpc.error && typeof rpc.data === 'number') used = rpc.data; } catch (e) {}
      var quota = P.tierFor(tierKey).quotaBytes;
      _storageInfo = { used: used, quota: quota, tierKey: tierKey, frac: quota ? used / quota : 0 };
      _storageOver = used >= quota;
      if (location.search.indexOf('storagefull=1') > -1) { _storageOver = true; _storageInfo = { used: quota, quota: quota, tierKey: tierKey, frac: 1 }; }   // test seam
      _storageLast = Date.now();
      updateStorageBanner();
    } catch (e) {} finally { _storageBusy = false; }
  }
  function maybeRecheckStorage() { if (Date.now() - _storageLast > 4000) checkStorage(); }
  function updateStorageBanner() {
    var P = window.MapStructorPricing, el = document.getElementById('editor-storage-banner');
    if (!_storageInfo || !P || _storageInfo.frac < 0.8) { if (el && el.parentNode) el.parentNode.removeChild(el); return; }
    if (!el) { el = document.createElement('div'); el.id = 'editor-storage-banner'; el.style.cssText = 'position:fixed;top:54px;left:50%;transform:translateX(-50%);z-index:3000;padding:9px 16px;border-radius:8px;color:#fff;font-family:Source Sans Pro,Arial,sans-serif;font-size:13px;box-shadow:0 2px 10px rgba(0,0,0,0.2);'; document.body.appendChild(el); }
    el.style.background = _storageOver ? '#b4453a' : '#d98a00';
    el.innerHTML = (_storageOver ? '<b>Storage full</b> — ' : 'Storage ' + Math.round(_storageInfo.frac * 100) + '% — ') + P.fmtBytes(_storageInfo.used) + ' / ' + P.fmtBytes(_storageInfo.quota) + '. <a href="../dashboard.html" target="_blank" style="color:#fff;text-decoration:underline;">Manage / upgrade ↗</a>';
  }
  function storageGate() {   // returns true if a new feature should be BLOCKED (and tells the user)
    if (!_storageOver) return false;
    var P = window.MapStructorPricing;
    window.alert('You’ve hit your storage limit' + (_storageInfo && P ? ' (' + P.fmtBytes(_storageInfo.used) + ' / ' + P.fmtBytes(_storageInfo.quota) + ')' : '') + '. Upgrade your plan (Dashboard → Storage) or remove some data to keep adding features.');
    updateStorageBanner();
    return true;
  }

  async function onDrawCreate(e) {
    try { if (window._msDismissDrawHint) window._msDismissDrawHint(); if (window._msDismissSearchHint) window._msDismissSearchHint(); } catch (err) {}   // first feature drawn → retire the onboarding nudges
    _skipArmOnce = true;   // a freshly drawn feature stays selected/editable — arming is for CLICKS on existing features
    var f = e.features && e.features[0]; if (!f) return;
    if (_splitMode) { doSplit(f); return; }   // the line just drawn is a split cut, not a feature
    if (_measuring) {   // a measuring line/polygon — report distance/area + keep the shape, don't persist it
      _measuring = false; updateToolButtons();
      try { setMeasureReadout(measureText(f)); } catch (err) {}
      try { showMeasureShape(f.geometry); } catch (e) {}   // keep the measured shape visible on the display layer
      try { draw.delete(f.id); } catch (e) {}              // remove the MapboxDraw copy (it lives on the display layer now)
      return;
    }
    if (storageGate()) { try { if (draw) draw.delete(f.id); } catch (e) {} return; }   // hard-stop at 100% storage
    var lid = activeLayerDbId();
    var node = activeLayerId ? findNodeById(layers, activeLayerId) : null;
    // Need a drawn layer that accepts this geometry. If nothing is selected, OR the selected layer already
    // holds a different geometry type, auto-create a fresh layer of THIS type and draw into it (Step 13) —
    // never reject the drawing. (One geometry type per layer is still enforced; we just make a new layer.)
    var mapType = GEOM_TO_TYPE[f.geometry.type];
    var geomLayerName = function (gt) { return ({ Point: 'Untitled Points', MultiPoint: 'Untitled Points', LineString: 'Untitled Lines', MultiLineString: 'Untitled Lines', Polygon: 'Untitled Shapes', MultiPolygon: 'Untitled Shapes' })[gt] || 'Untitled layer'; };
    // A feature only goes to the SELECTED layer. We look elsewhere only when no drawn layer is selected, or the
    // selected one is a different geometry type — and then: auto-create a layer for this type ONLY if none exists
    // yet; if one already exists (just not selected), reject and ask the user to select it (never silently route
    // a feature into a layer they didn't pick). Matches test/draw/create (basic + v3).
    if (!lid || !node || (node.type && node.type !== mapType)) {
      var existing = flatLayers(layers).filter(function (l) { return l.source_type === 'geojson-supabase' && l.type === mapType; })[0];
      if (existing) {
        if (draw) draw.delete(f.id);
        // #1: prominent centered toast only — no duplicate in the sidebar save-status text.
        showToast('Select or create a new layer');
        return;
      }
      try { await addItem('layer', geomLayerName(f.geometry.type), null); } catch (e) { console.warn('auto-create layer failed', e); }   // addItem activates quietly — adding a FEATURE never pops the style panel
      lid = activeLayerDbId();
      node = activeLayerId ? findNodeById(layers, activeLayerId) : null;
      // the new layer must be usable AND of this type — never fall through to add to the previously-active (wrong) layer
      if (!lid || !node || (node.type && node.type !== mapType)) { if (draw) draw.delete(f.id); setStatus('Could not create a layer — try drawing again.'); return; }
    }
    // stamp the geometry type on a fresh (type-less) layer
    if (!node.type) {
      node.type = mapType;
      node.iconType = GEOM_TO_ICON[f.geometry.type] || node.iconType;
      try { await db.from('layers').update({ type: mapType }).eq('id', lid); } catch (err) { console.warn('editing: set layer type failed', err); }
      rerender();
    }

    setStatus('Saving…');
    try {
      var ins = await db.from('features').insert({ layer_id: lid, geom: f.geometry }).select('feature_id').single();
      if (ins.error) throw new Error(ins.error.message);
      featureToDb[f.id] = ins.data.feature_id;
      maybeRecheckStorage();   // a new feature added bytes — re-check the quota (debounced)
      featureMeta[f.id] = { label: '', notes: '', start: '', end: '' };
      featureLayer[f.id] = lid;
      _geomSnap[f.id] = JSON.parse(JSON.stringify(f.geometry));
      // the create-selection opened the panel BEFORE this insert resolved featureLayer — re-show it now
      // that the layer is known, so the info-panel preview renders too (panel+editor, not editor-only)
      if (selectedDrawId === f.id) showFeaturePanel(f.id);
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
      var lnU = featureLayer[f.id] ? nodeByLayerDbId(featureLayer[f.id]) : null;   // map labels anchor to the geometry — re-anchor after a move (debounced)
      if (lnU && lnU.labels) { clearTimeout(_lblLiveTimer); _lblLiveTimer = setTimeout(function () { try { applyLabelLayers(lnU); } catch (err2) {} }, 400); }
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
    (function walk(arr) { (arr || []).forEach(function (n) { if (n.source_type === 'geojson-supabase') { var did = slugToLayerDbId[n.id]; if (did) { /* paint's literal colour wins: an imported hollow fill (rgba(0,0,0,0)) must not fall back to the sidebar icon colour */ var pc0 = (n.paint && typeof n.paint[colorKeyFor(n.type)] === 'string') ? n.paint[colorKeyFor(n.type)] : null; dbColor[did] = pc0 || n.iconColor || '#3bb2d0'; var op = paintOpacity(n.paint); if (op != null) dbOpacity[did] = op; var ol = paintOutline(n.paint); if (ol != null) dbOutline[did] = ol; if (n.paint && n.paint['line-opacity'] != null) dbStrokeOp[did] = n.paint['line-opacity']; var wd = paintWidth(n.paint); if (wd != null) dbStrokeWidth[did] = wd; if (n.paint && n.paint['circle-radius'] != null) dbRadius[did] = n.paint['circle-radius']; if (n.outlineSplit) dbStrokeOp[did] = 0; gjList.push({ slug: n.id, did: did }); } } if (n.children) walk(n.children); }); })(layers);

    // Classify by size: small layers edit in MapboxDraw; large ones (imported 10k+ datasets) render
    // via the engine like a tileset — MapboxDraw can't hold tens of thousands of features (it freezes).
    _drawLayerSlugs = {};
    var smallIds = [];
    // one COUNT per layer, but in PARALLEL — awaiting them one-by-one stalled boot ~N×roundtrip (20+
    // drawn layers = several seconds before any feature data even started downloading)
    var counts = await Promise.all(gjList.map(function (gj2) {
      return db.from('features').select('feature_id', { count: 'exact', head: true }).eq('layer_id', gj2.did).then(function (cq) { return (cq && cq.count) || 0; }, function () { return 0; });
    }));
    counts.forEach(function (cn, gi) { if (cn > 0 && cn <= MAX_DRAW) { smallIds.push(gjList[gi].did); _drawLayerSlugs[gjList[gi].slug] = true; } });
    // the map contains a big-table layer → warm the columnar engine at idle, so the first table
    // open never pays the engine load (user-proposed prefetch rule, 7/18)
    try { if (window.MSBigTable && counts.some(function (cn) { return cn > MSBigTable.BIG_ROWS; })) MSBigTable.prefetch(); } catch (e) {}
    hideDrawnEngineLayers();   // hides only small (MapboxDraw) layers' engine copies; large ones stay engine-rendered
    // the engine adds its layers on style.load, which can land AFTER the hide above ran (getLayer misses →
    // nothing hidden → drawn features double-render and the engine's click/panel systems stay live) — re-hide once settled
    try { if (beforeMap) beforeMap.once('idle', hideDrawnEngineLayers); } catch (e) {}
    try { if (typeof afterMap !== 'undefined' && afterMap) afterMap.once('idle', hideDrawnEngineLayers); } catch (e) {}
    if (smallIds.length) { try { if (window._msDismissDrawHint) window._msDismissDrawHint(); if (window._msDismissSearchHint) window._msDismissSearchHint(); } catch (e) {} }   // map already has drawn features — retire the onboarding nudges
    wireEngineEditClicks(); try { if (beforeMap) beforeMap.once('idle', wireEngineEditClicks); } catch (e) {}   // BEFORE the early-return below, so tileset-only / large-layer-only projects still get click→edit
    if (!smallIds.length) { try { draw.set({ type: 'FeatureCollection', features: [] }); } catch (e) {} return; }
    // ON-by-default layers load first (the visible map); OFF-by-default layers' rows are fetched in the
    // background afterwards, straight into featureCache — nothing hidden ever renders, and first paint
    // isn't blocked by data nobody sees.
    // visibility = the CURRENT sidebar checkbox when it exists (session state), falling back to the saved
    // default — otherwise every loadFeatures() rebuild (style changes etc.) would reset session toggles.
    function layerOnNow(n) {
      if (!n) return true;
      var cb2 = document.getElementById(n.id);
      return cb2 ? !!cb2.checked : n.checked !== false;
    }
    var onIds = smallIds.filter(function (lid2) { return layerOnNow(nodeByLayerDbId(lid2)); });
    var offIds = smallIds.filter(function (lid2) { return !layerOnNow(nodeByLayerDbId(lid2)); });
    var FEAT_SEL = 'feature_id, layer_id, geom, label, description, start_date, end_date, content_id, custom_fields, image_url';
    function mapRow(row) {
      if (!row.geom) return null;
      var did = 'db-' + row.feature_id;
      featureToDb[did] = row.feature_id;
      featureMeta[did] = { label: row.label || '', notes: row.description || '', start: row.start_date ? String(row.start_date).slice(0, 10) : '', end: row.end_date ? String(row.end_date).slice(0, 10) : '', pageid: row.content_id != null ? String(row.content_id) : '', image_url: row.image_url || '', custom: row.custom_fields || null };
      featureLayer[did] = row.layer_id;
      var props = { color: dbColor[row.layer_id] || '#3bb2d0' };
      // color-by-attribute: the feature's own column value decides its color in the draw copies too
      var cbNode = nodeByLayerDbId(row.layer_id);
      if (cbNode && cbNode.colorBy && row.custom_fields) {
        var cbv = row.custom_fields[cbNode.colorBy.prop];
        var cbc = cbv != null ? cbNode.colorBy.mapping[String(cbv)] : null;
        if (cbc) props.color = cbc;
      }
      if (dbOpacity[row.layer_id] != null) props.opacity = dbOpacity[row.layer_id];
      if (dbOutline[row.layer_id] != null) props.outline = dbOutline[row.layer_id];
      if (dbStrokeOp[row.layer_id] != null) props.strokeopacity = dbStrokeOp[row.layer_id];
      if (dbStrokeWidth[row.layer_id] != null) props.strokewidth = dbStrokeWidth[row.layer_id];
      if (dbRadius[row.layer_id] != null) props.radius = dbRadius[row.layer_id];
      // opacity/thickness-by-column: the feature's own column value drives it in the draw copies too
      if (cbNode && row.custom_fields) {
        if (cbNode.opacityBy) { var oby = parseFloat(row.custom_fields[cbNode.opacityBy.prop]); if (!isNaN(oby)) props.opacity = oby; }
        if (cbNode.thicknessBy) { var tby = parseFloat(row.custom_fields[cbNode.thicknessBy.prop]); if (!isNaN(tby)) { props.strokewidth = tby; props.radius = tby; } }
      }
      // UNIVERSAL STYLE COLUMNS: every feature carries ms_color / ms_linecolor / ms_opacity / ms_thickness —
      // when set they style THAT feature (trumping the layer style AND colour-by). Editable in the attribute table.
      if (row.custom_fields) {
        var scv = row.custom_fields.ms_color;
        if (scv != null && String(scv).trim() !== '' && String(scv).trim().toLowerCase() !== 'none') props.color = looksHex(scv) ? normHex(scv) : String(scv).trim();   // "none" = explicit no-override → layer colour
        var slv = row.custom_fields.ms_linecolor;   // polygon outline / point stroke colour (lines take ms_color)
        if (slv != null && String(slv).trim() !== '' && String(slv).trim().toLowerCase() !== 'none') props.outline = looksHex(slv) ? normHex(slv) : String(slv).trim();
        var sov = parseFloat(row.custom_fields.ms_opacity);
        if (row.custom_fields.ms_opacity != null && String(row.custom_fields.ms_opacity) !== '' && !isNaN(sov)) props.opacity = sov;
        var stv = parseFloat(row.custom_fields.ms_thickness);
        if (row.custom_fields.ms_thickness != null && String(row.custom_fields.ms_thickness) !== '' && !isNaN(stv)) { props.strokewidth = stv; props.radius = stv; }
      }
      var fo = { type: 'Feature', id: did, geometry: { type: row.geom.type, coordinates: row.geom.coordinates }, properties: props };
      _geomSnap[did] = { type: row.geom.type, coordinates: row.geom.coordinates };
      return { did: did, fo: fo, hidden: !layerOnNow(cbNode) };
    }
    // toggling ON a layer whose rows haven't arrived yet fetches THEM first (priority) — assigned BEFORE
    // the awaited fetches below so a toggle seconds after page load is already covered. quiet = background
    // sweep (skips the "Loading features…" status churn of many parallel hydrations).
    var _hydrating = {};
    _hydrateOne = async function (lid6, quiet) {
      var n6 = nodeByLayerDbId(lid6);
      if (n6 && !_drawLayerSlugs[n6.id]) return;   // large layers render via the ENGINE — never pull their rows into MapboxDraw
      if (_hydratedLayers[lid6]) { addCachedLayerToDraw(lid6); rebuildLabelsFor([lid6]); return; }
      if (_hydrating[lid6]) return;
      _hydrating[lid6] = true;
      if (!quiet) setStatus('Loading features…');
      try {
        var ok6 = true;
        for (var f6 = 0; f6 < 200000; f6 += 1000) {
          var r6 = await db.from('features').select(FEAT_SEL).eq('layer_id', lid6).order('feature_id').range(f6, f6 + 999);
          if (r6.error) { ok6 = false; break; }   // a failed page (transient 500) must NOT mark the layer hydrated-but-empty — the sweep retry / next toggle refetches
          if (!r6.data || !r6.data.length) break;
          r6.data.forEach(function (row) { var m6 = mapRow(row); if (m6) featureCache[m6.did] = m6.fo; });
          if (r6.data.length < 1000) break;
        }
        if (ok6) { _hydratedLayers[lid6] = true; addCachedLayerToDraw(lid6); rebuildLabelsFor([lid6]); }
        if (!quiet) setStatus(ok6 ? '' : 'Load failed');
      } catch (e) { console.warn('editing: layer hydrate failed', e); if (!quiet) setStatus('Load failed'); }
      _hydrating[lid6] = false;
    };
    try {
      var feats = [];
      if (onIds.length) {
        for (var from = 0; from < 200000; from += 1000) {
          var res = await db.from('features').select(FEAT_SEL).in('layer_id', onIds).order('feature_id').range(from, from + 999);
          if (res.error) { console.warn('editing: load features failed', res.error); break; }
          (res.data || []).forEach(function (row) { var m = mapRow(row); if (!m) return; if (m.hidden) featureCache[m.did] = m.fo; else feats.push(m.fo); });
          if (!res.data || res.data.length < 1000) break;
        }
      }
      draw.set({ type: 'FeatureCollection', features: feats });
      syncMirrorRight();   // show the loaded drawn features on the right swipe side too
      // labels ride ABOVE everything — MapboxDraw's fills and the right mirror are added after the
      // engine's label layers, so put labels back on top after every rebuild
      if (typeof msRaiseLabelLayers === 'function') { msRaiseLabelLayers(beforeMap, layers); msRaiseLabelLayers(typeof afterMap !== 'undefined' ? afterMap : null, layers); }
      onIds.forEach(function (lid3) { _hydratedLayers[lid3] = true; });
      // the engine's boot label layers were built from the CONFIG feature snapshot, which only contains
      // ON-by-default layers' features — rebuild labels for loaded labeled layers from the LIVE data
      rebuildLabelsFor(onIds);
    } catch (e) { console.warn('editing: load features failed', e); }
    // ── late feature arrival (the "toggle a layer on and nothing appears" fixes) ──
    function addCachedLayerToDraw(lid4) {   // put a hydrated layer's cached features into draw (if its checkbox is on now)
      var node4 = nodeByLayerDbId(lid4);
      if (!node4 || !layerOnNow(node4) || !draw) return;
      Object.keys(featureLayer).forEach(function (did4) {
        if (featureLayer[did4] !== lid4) return;
        try { if (!draw.get(did4) && featureCache[did4]) draw.add(featureCache[did4]); } catch (e) {}
      });
      syncMirrorRight();
    }
    function rebuildLabelsFor(lids5) {
      (lids5 || []).forEach(function (lid5) {
        var n5 = nodeByLayerDbId(lid5);
        if (!(n5 && n5.labels && n5.labels.field)) return;   // large engine-rendered layers rebuild too — labelFeaturesFor reads the live engine source for them
        try { applyLabelLayers(n5); } catch (e) {}
        var vis5 = layerOnNow(n5) ? 'visible' : 'none';   // applyLabelLayers adds 'visible' — re-apply the checkbox state
        [[beforeMap, 'left'], [typeof afterMap !== 'undefined' ? afterMap : null, 'right']].forEach(function (pr5) {
          var m5 = pr5[0]; if (!m5) return;
          try { if (m5.getLayer(n5.id + '-label-' + pr5[1])) m5.setLayoutProperty(n5.id + '-label-' + pr5[1], 'visibility', vis5); } catch (e) {}
        });
      });
    }
    // hidden layers hydrate right after the visible ones — smallest first, a FEW at a time (20+ concurrent
    // queries drew Supabase 500s), each landing in draw/labels the moment it arrives. The old single bulk
    // query (all off layers, sequential 1000-row pages, applied only when 100% done, on a 1.2s timer) held
    // a 7-point layer hostage to megabytes of zoning polygons — toggling it looked like nothing happened.
    if (offIds.length) (function () {
      var cntById = {}; gjList.forEach(function (g3, i3) { cntById[g3.did] = counts[i3] || 0; });
      var order = offIds.slice().sort(function (a, b) { return (cntById[a] || 0) - (cntById[b] || 0); });
      async function pool7(list) {
        var q7 = list.slice();
        async function w7() { for (var lid7 = q7.shift(); lid7; lid7 = q7.shift()) await _hydrateOne(lid7, true); }
        var ws7 = []; for (var i7 = 0; i7 < Math.min(3, q7.length); i7++) ws7.push(w7());
        await Promise.all(ws7);
      }
      pool7(order).then(function () {
        var missed = order.filter(function (lid8) { return !_hydratedLayers[lid8]; });
        if (missed.length) return pool7(missed);   // failures stayed un-hydrated — one retry pass
      });
    })();
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
      var SW = ['coalesce', ['get', 'strokewidth'], 2];                        // STROKE_WIDTH (lines)
      var PSW = ['coalesce', ['get', 'strokewidth'], 0.5];                     // POLY_STROKE_WIDTH (polygon outlines — 0.5 default)
      afterMap.addSource(MIRROR_SRC, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      afterMap.addLayer({ id: MIRROR_SRC + '-fill', type: 'fill', source: MIRROR_SRC, filter: ['==', '$type', 'Polygon'],
        paint: { 'fill-color': C, 'fill-outline-color': OF, 'fill-opacity': ['coalesce', ['get', 'opacity'], 0.35] } });
      afterMap.addLayer({ id: MIRROR_SRC + '-poly-stroke', type: 'line', source: MIRROR_SRC, filter: ['==', '$type', 'Polygon'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': OF, 'line-width': PSW, 'line-opacity': ['coalesce', ['get', 'strokeopacity'], 1] } });
      afterMap.addLayer({ id: MIRROR_SRC + '-line', type: 'line', source: MIRROR_SRC, filter: ['==', '$type', 'LineString'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': C, 'line-width': SW, 'line-opacity': OP } });
      afterMap.addLayer({ id: MIRROR_SRC + '-point', type: 'circle', source: MIRROR_SRC, filter: ['==', '$type', 'Point'],
        paint: (function () { var R = ['coalesce', ['get', 'radius'], 6]; return { 'circle-color': C, 'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, ['max', 2, ['*', 0.35, R]], 11, ['*', 0.65, R], 16, R], 'circle-stroke-width': ['coalesce', ['get', 'strokewidth'], 1.5], 'circle-stroke-color': ['coalesce', ['get', 'outline'], '#ffffff'], 'circle-opacity': OP }; })() });
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
  // TWO-STAGE clicks (2026-07-08 spec): stage 1 = ONE click opens everything you READ (highlight, bubble,
  // info panel, feature editor) but the geometry stays locked; stage 2 = a second click on the same feature
  // unlocks geometry editing. The armed set doubles as the stage-1 marker and the shift/ctrl multi-select set.
  // _skipArmOnce = only for a JUST-DRAWN feature (its create-selection goes straight to stage 2).
  var _armedSet = [], _editingDraw = null, _skipArmOnce = false;
  function ensureArmedHl() {
    [beforeMap, typeof afterMap !== 'undefined' ? afterMap : null].forEach(function (m) {
      if (!m) return;
      try {
        if (m.getSource('editor-armed-hl')) return;
        m.addSource('editor-armed-hl', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
        m.addLayer({ id: 'editor-armed-hl-fill', type: 'fill', source: 'editor-armed-hl', filter: ['==', '$type', 'Polygon'], paint: { 'fill-color': '#ffd54d', 'fill-opacity': 0.45 } });
        m.addLayer({ id: 'editor-armed-hl-line', type: 'line', source: 'editor-armed-hl', paint: { 'line-color': '#ce5c00', 'line-width': 2.5 } });
        m.addLayer({ id: 'editor-armed-hl-pt', type: 'circle', source: 'editor-armed-hl', filter: ['==', '$type', 'Point'], paint: { 'circle-radius': 9, 'circle-color': '#ffd54d', 'circle-opacity': 0.7, 'circle-stroke-color': '#ce5c00', 'circle-stroke-width': 2 } });
      } catch (e) {}
    });
  }
  function setArmedHl(feats) {   // feats: array of GeoJSON features (or null/[] to clear)
    ensureArmedHl();
    var list = (feats || []).filter(Boolean).map(function (f2) { return { type: 'Feature', geometry: f2.geometry, properties: {} }; });
    var data = { type: 'FeatureCollection', features: list };
    [beforeMap, typeof afterMap !== 'undefined' ? afterMap : null].forEach(function (m) {
      if (!m) return; try { var s2 = m.getSource('editor-armed-hl'); if (s2) s2.setData(data); } catch (e) {}
    });
  }
  function updateArmedHl() { setArmedHl(_armedSet.map(function (id2) { try { return draw.get(id2); } catch (e) { return null; } })); }
  // ═══ GROUP-AS-ONE — universal filter-twin design (7/18) ═══════════════════
  // Membership is DECLARED, never copied: each grouped layer gets a twin
  // highlight layer bound to the SAME source, and hover/click merely set its
  // FILTER to the family's value list. The renderer evaluates membership per
  // frame on exactly the tiles it draws — the glow can never be stale, partial,
  // viewport-limited, or desynced, at any zoom, during any tile transition.
  // (The old overlay SAMPLED tiles into a copy and suffered every timing state:
  // mid-load emptiness, parent-tile pyramids, loaded-tiles-only membership.)
  var GROUP_GLOW = {
    line: { type: 'line', paint: { 'line-color': '#ff9d2e', 'line-width': 4.5, 'line-opacity': 0.55 } },
    fill: { type: 'fill', paint: { 'fill-color': '#ffd54d', 'fill-opacity': 0.3 } },
    circle: { type: 'circle', paint: { 'circle-color': '#ffd54d', 'circle-opacity': 0.4, 'circle-radius': 8, 'circle-stroke-color': '#ff9d2e', 'circle-stroke-width': 1.5 } }
  };
  var FILTER_NONE = ['in', '__ms_none__', 'x'];   // legacy-syntax "match nothing"
  var _groupFam = {};       // layerDbId → { loaded, byFamily: {family → {variants:[raw…], count}} }
  var _groupActive = null;  // { node, raw } currently glowing (hover or pinned)
  function ensureGroupTwin(node) {
    var spec = GROUP_GLOW[node.type] || GROUP_GLOW.line;
    [['left', beforeMap], ['right', (typeof afterMap !== 'undefined' ? afterMap : null)]].forEach(function (pr) {
      var m = pr[1]; if (!m) return;
      var gid = node.id + '-group-hl-' + pr[0];
      try {
        if (m.getLayer(gid) || !m.getSource(node.id + '-' + pr[0])) return;
        var cfg = { id: gid, type: spec.type, source: node.id + '-' + pr[0], paint: spec.paint, filter: FILTER_NONE };
        if (node['source-layer']) cfg['source-layer'] = node['source-layer'];
        m.addLayer(cfg);
        if (typeof msRaiseLabelLayers === 'function') msRaiseLabelLayers(m, layers);   // glow under labels
      } catch (e) {}
    });
  }
  // family variant lists come from the SERVER's distinct-value counts (whole layer, not a tile
  // sample) — loaded once per layer; until they land, the filter matches the exact raw value
  // and silently upgrades to the full family when counts arrive.
  function loadGroupFamilies(node) {
    var lid = slugToLayerDbId[node.id];
    if (!lid || _groupFam[lid]) return;
    _groupFam[lid] = { loaded: false, byFamily: {} };
    try {
      db.rpc('ms_layer_key_counts', { p_layer: lid, p_key: node.groupBy }).then(function (r) {
        var st = _groupFam[lid]; st.loaded = true;
        ((r && r.data) || []).forEach(function (c) {
          var fam = gnorm(c.k); if (!fam) return;
          var f = st.byFamily[fam] || (st.byFamily[fam] = { variants: [], count: 0 });
          f.variants.push(c.k); f.count += c.n;
        });
        if (_groupActive && slugToLayerDbId[_groupActive.node.id] === lid) applyGroupFilter();
      });
    } catch (e) { _groupFam[lid].loaded = true; }
  }
  function familyFor(node, raw) {
    var lid = slugToLayerDbId[node.id];
    var st = lid && _groupFam[lid];
    var fam = st && st.byFamily[gnorm(raw)];
    return fam || { variants: [String(raw)], count: null };
  }
  function applyGroupFilter() {
    var a = _groupActive;
    [['left', beforeMap], ['right', (typeof afterMap !== 'undefined' ? afterMap : null)]].forEach(function (pr) {
      var m = pr[1]; if (!m) return;
      (function walk(arr) { (arr || []).forEach(function (n) {
        if (n.groupBy) {
          var gid = n.id + '-group-hl-' + pr[0];
          if (m.getLayer(gid)) {
            var filt = FILTER_NONE;
            if (a && a.node.id === n.id) {
              // legacy 'in' composes with the engine's legacy date filter (mixing legacy +
              // expression syntax throws — the historic AHM filter bug)
              var inClause = ['in', n.groupBy === 'label' ? 'label' : n.groupBy].concat(familyFor(n, a.raw).variants);
              var base = null; try { base = m.getFilter(n.id + '-' + pr[0]) || null; } catch (e) {}
              // strip engine-edit ['!in','$id',…] exclusions: a CLICKED piece is pulled into draw and
              // excluded from the main layer, but it must still glow with its family
              if (base && base[0] === 'all') base = ['all'].concat(base.slice(1).filter(function (c) { return !(Array.isArray(c) && c[0] === '!in' && c[1] === '$id'); }));
              else if (base && base[0] === '!in' && base[1] === '$id') base = null;
              filt = !base ? inClause : (base[0] === 'all' ? base.concat([inClause]) : ['all', base, inClause]);
            }
            try { m.setFilter(gid, filt); } catch (e2) {}
          }
        }
        if (n.children) walk(n.children);
      }); })(typeof layers !== 'undefined' ? layers : []);
    });
  }
  function setGroupActive(node, raw) {   // raw = null clears the glow everywhere
    _groupActive = (node && raw != null && gnorm(raw)) ? { node: node, raw: raw } : null;
    if (_groupActive) { ensureGroupTwin(node); loadGroupFamilies(node); }
    applyGroupFilter();
    wireGroupFilterSync();
  }
  // the twin embeds the MAIN layer's current (date) filter — recompose when the renderer settles
  // so timeline scrubs keep the glow date-correct. One cheap setFilter; no data copying, ever.
  var _groupSyncWired = false;
  function wireGroupFilterSync() {
    if (_groupSyncWired || typeof beforeMap === 'undefined' || !beforeMap) return;
    _groupSyncWired = true;
    beforeMap.on('idle', function () { if (_groupActive) applyGroupFilter(); });
  }
  // normalized matching: "Baltimore & Ohio" and "Baltimore and Ohio" are ONE company (data has
  // 30 such variant families) — labels.js owns the normalizer; fallback = trim only
  function gnorm(v) { return (window.msGroupNorm || function (x) { return String(x == null ? '' : x).trim().toLowerCase(); })(v); }
  var _groupLock = false;   // a CLICKED group pins the glow — hover-grouping won't repaint over it
  function updateGroupHl(did) {
    var note = document.getElementById('efp-group-note');
    function off() { _groupLock = false; _groupHoverVal = null; setGroupActive(null, null); if (note) note.style.display = 'none'; }
    if (!did) { off(); return; }
    var lid = featureLayer[did];
    var node = lid ? nodeByLayerDbId(lid) : null;
    if (!node && _engineEditNode[did]) node = _engineEditNode[did];
    var key = node && node.groupBy;
    if (!key) { off(); return; }
    var m = featureMeta[did] || {};
    var raw = (key === 'label') ? (m.label || '') : (m.custom ? m.custom[key] : null);
    if (!gnorm(raw)) { off(); return; }   // blank/junk values NEVER group
    setGroupActive(node, raw);
    setArmedHl(null);   // uniform glow: no piece looks more selected than the rest (user 7/17)
    _groupLock = true;
    if (note) {
      var fam = familyFor(node, raw);
      note.textContent = 'Part of “' + String(raw).trim() + '”' + (fam.count ? ' — ' + nfmt(fam.count) + ' pieces as one' : '');
      note.style.display = 'block';
    }
  }
  // ── group HOVER: hovering any piece glows the whole company (same overlay; a clicked group pins it) ──
  var _groupHoverVal = null;
  function groupEnabledEngineIds() {
    var ids = [];
    (function walk(arr) { (arr || []).forEach(function (n) { if (n.groupBy && beforeMap.getLayer(n.id + '-left')) ids.push(n.id + '-left'); if (n.children) walk(n.children); }); })(typeof layers !== 'undefined' ? layers : []);
    return ids;
  }
  function groupValueAt(pt) {   // {node, key, val, geom} under the (buffered) point, or null
    var bx = 8;
    // draw features first (they render on top)
    var did = drawFeatureAt(pt);
    if (did && featureLayer[did]) {
      var node1 = nodeByLayerDbId(featureLayer[did]) || _engineEditNode[did];
      var key1 = node1 && node1.groupBy;
      if (key1) {
        var m1 = featureMeta[did] || {};
        var v1 = (key1 === 'label') ? (m1.label || '') : (m1.custom ? m1.custom[key1] : null);
        if (gnorm(v1)) return { node: node1, key: key1, val: gnorm(v1), raw: v1 };
      }
    }
    // engine-rendered group-enabled layers — NEAREST candidate wins (render order lies at crossings)
    try {
      var lids = groupEnabledEngineIds();
      if (lids.length) {
        var fs = beforeMap.queryRenderedFeatures([[pt.x - bx, pt.y - bx], [pt.x + bx, pt.y + bx]], { layers: lids }) || [];
        fs = fs.filter(function (f) {
          var n2 = findNodeById(layers, String(f.layer.id).replace(/-(left|right)$/, ''));
          if (!n2 || !n2.groupBy) return false;
          var vv = (n2.groupBy === 'label') ? (f.properties || {}).label : (f.properties || {})[n2.groupBy];
          f._msNode = n2; f._msVal = vv;
          return !!gnorm(vv);
        });
        var hit = nearestFeature(fs, pt);
        if (hit) return { node: hit._msNode, key: hit._msNode.groupBy, val: gnorm(hit._msVal), raw: hit._msVal };
      }
    } catch (e) {}
    return null;
  }
  // ── NEAREST-feature hit-testing: a bbox query returns candidates in RENDER order (topmost
  //    first), so crossing/parallel lines made the corridor pick the WRONG line — you hovered A
  //    and B glowed. Pick by true screen distance to the cursor instead. ──
  function distToSegPx(p, a, b) {
    var dx = b.x - a.x, dy = b.y - a.y;
    var l2 = dx * dx + dy * dy;
    if (!l2) { var ex = p.x - a.x, ey = p.y - a.y; return Math.sqrt(ex * ex + ey * ey); }
    var t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
    var qx = a.x + t * dx - p.x, qy = a.y + t * dy - p.y;
    return Math.sqrt(qx * qx + qy * qy);
  }
  function distToFeaturePx(f, pt) {
    try {
      var g = f.geometry; if (!g) return 1e9;
      var lines;
      if (g.type === 'LineString') lines = [g.coordinates];
      else if (g.type === 'MultiLineString') lines = g.coordinates;
      else if (g.type === 'Polygon') lines = g.coordinates;
      else if (g.type === 'MultiPolygon') { lines = []; g.coordinates.forEach(function (pg) { lines = lines.concat(pg); }); }
      else if (g.type === 'Point') { var P0 = beforeMap.project({ lng: g.coordinates[0], lat: g.coordinates[1] }); var ex = pt.x - P0.x, ey = pt.y - P0.y; return Math.sqrt(ex * ex + ey * ey); }
      else return 1e9;
      var bd = 1e9;
      for (var li = 0; li < lines.length; li++) {
        var c = lines[li], prev = null;
        for (var i = 0; i < c.length; i++) {
          var P = beforeMap.project({ lng: c[i][0], lat: c[i][1] });
          if (prev) { var d = distToSegPx(pt, prev, P); if (d < bd) bd = d; }
          prev = P;
        }
      }
      return bd;
    } catch (e) { return 1e9; }
  }
  function nearestFeature(fs, pt) {
    var best = null, bd = 1e9;
    for (var i = 0; i < (fs || []).length; i++) {
      var d = distToFeaturePx(fs[i], pt);
      if (d < bd) { bd = d; best = fs[i]; }
    }
    return best;
  }
  function setGroupCursor(on) {   // finger whenever a groupable piece is under the cursor. Enforced
    // EVERY mousemove (no caching) — other handlers (engine panel enter/leave, right-map draw cursor)
    // also write the canvas cursor, and a cached skip let their stale hand icon win.
    if (typeof isDrawArmed === 'function' && isDrawArmed()) return;
    [typeof beforeMap !== 'undefined' ? beforeMap : null, typeof afterMap !== 'undefined' ? afterMap : null].forEach(function (m) {
      if (!m) return;
      try {
        var c = m.getCanvas();
        if (on) { if (c.style.cursor !== 'pointer') c.style.cursor = 'pointer'; }
        else if (c.style.cursor === 'pointer') c.style.cursor = '';
      } catch (e) {}
    });
  }
  var _lastGroupGv = null;   // last corridor hit — the hover bubble rides it
  function groupHoverAt(pt) {   // called from the shared mousemove — declarative: one setFilter per company change
    var gv = groupValueAt(pt);
    _lastGroupGv = gv;
    setGroupCursor(!!gv);
    if (_groupLock) return;   // a clicked group is pinned — hover only drives the cursor
    if (!gv) { if (_groupHoverVal != null) { _groupHoverVal = null; setGroupActive(null, null); } return; }
    if (gv.val === _groupHoverVal) return;   // same family — the filter is already live; the renderer keeps it correct
    _groupHoverVal = gv.val;
    setGroupActive(gv.node, gv.raw);
  }
  function syncAttrRowsFromMap(feats) {   // clicking feature(s) on the MAP selects their row(s) in the open attribute table
    if (!_attrSlug) return;
    if (!feats || !feats.length) { _attrSel = []; applyAttrSelClasses(); updateAttrHighlight(); updateAttrZoomBtn(); updateAttrDelBtn(); return; }
    var fids = feats.map(function (f2) {
      var did = String(f2.id);
      var n = featureToDb[did] != null ? featureToDb[did] : (did.indexOf('db-') === 0 ? did.slice(3) : null);
      return n != null ? String(n) : null;
    }).filter(function (x) { return x && _attrById[x]; });
    if (!fids.length) return;   // table open for a different layer
    _attrSel = fids;
    applyAttrSelClasses(); updateAttrHighlight(); updateAttrZoomBtn(); updateAttrDelBtn();
    // windowed body: the row may not be in the DOM at all — scroll the WINDOW to its index,
    // which renders it, then the usual into-view nudge applies
    var lastFid = fids[fids.length - 1];
    var row = document.querySelector('#editor-attr-tbody tr[data-fid="' + lastFid + '"]');
    if (!row && _attrWin) {
      for (var ri = 0; ri < _attrRows.length; ri++) { if (String(_attrRows[ri].feature_id) === lastFid) { _attrWin.scrollToIndex(ri); break; } }
      row = document.querySelector('#editor-attr-tbody tr[data-fid="' + lastFid + '"]');
    }
    if (row && !_attrWin) row.scrollIntoView({ block: 'nearest' });   // fixed-viewport mode: scrollToIndex above already placed it; native scrollIntoView would scroll the page
    fillAttrPreview(fids[fids.length - 1]);
  }
  // ── click model on the map (two-stage; modifier = GIS-style multi-select): ──
  //   plain click            → stage 1: HIGHLIGHT + bubble stays open + info panel + feature editor (geometry locked)
  //   plain click on the highlighted feature → stage 2: geometry becomes editable (panel/bubble stay)
  //   shift/ctrl click       → ADD to / REMOVE from the highlight set (multi-select; nothing editable, no panel)
  //   click empty ground     → clear everything
  // The deselects/selects are DEFERRED one tick: mapbox-draw's click pipeline finishes after this
  // handler and re-applies its own selection — synchronous changes here get clobbered.
  function deferDrawSel(list) { setTimeout(function () { try { draw.changeMode('simple_select', { featureIds: list }); } catch (e2) {} }, 0); }
  function clearArmedSet() { _armedSet = []; setArmedHl(null); updateGroupHl(null); }
  function armedIdsToRows() { syncAttrRowsFromMap(_armedSet.map(function (i3) { return { id: i3 }; })); }
  function onSelectionChange(e) {
    if (!e.features || !e.features.length) { _skipArmOnce = false; _editingDraw = null; _armedSet = []; setArmedHl(null); updateGroupHl(null); hideFeaturePanel(); syncAttrRowsFromMap([]); return; }
    if (_skipArmOnce) {   // a JUST-DRAWN feature: skip stage 1 — it stays selected (stage 2) with the panel open
      var f0 = e.features[0];
      _skipArmOnce = false; _editingDraw = String(f0.id); _armedSet = []; setArmedHl(null);
      showFeaturePanel(f0.id); syncAttrRowsFromMap(e.features);
      return;
    }
    // the CLICKED feature: with something in edit the event may carry [editing, clicked] — take the other one
    var fc = e.features[0];
    for (var i = 0; i < e.features.length; i++) { if (String(e.features[i].id) !== _editingDraw) { fc = e.features[i]; break; } }
    var id = String(fc.id);
    if (id === _editingDraw && e.features.length === 1) return;   // events from the feature being edited (drag etc.)
    var mod = !!window._msModClick;
    if (_armedSet.indexOf(id) > -1) {
      if (mod) {   // modifier-click a highlighted feature → remove it from the set
        _armedSet = _armedSet.filter(function (x) { return x !== id; });
        deferDrawSel([]);
        updateArmedHl(); armedIdsToRows();
        return;
      }
      // stage 2: plain click on the already-highlighted feature → geometry becomes editable
      _editingDraw = id; _armedSet = [];
      setArmedHl(null);
      deferDrawSel([id]);
      showFeaturePanel(id);   // idempotent — also restores the panel when entering from a multi-select set
      updateGroupHl(id);      // the company stays lit while one piece is being edited
      syncAttrRowsFromMap([{ id: id }]);
      return;
    }
    // clicked an un-highlighted feature
    if (mod) {   // modifier-click GATHERS highlights (multi-select set, nothing editable)
      if (_editingDraw) _armedSet.push(_editingDraw);   // leaving edit mode via modifier keeps that feature highlighted
      _armedSet.push(id);
      _editingDraw = null;
      deferDrawSel([]);
      updateArmedHl(); updateGroupHl(null); armedIdsToRows();   // multi-select is manual — group glow off
      hideFeaturePanel();
      return;
    }
    // stage 1: plain click → highlight + panel + editor open; geometry stays LOCKED (the deferred
    // deselect undoes draw's own selection after its click pipeline finishes, so nothing is draggable)
    _editingDraw = null; _armedSet = [id];
    deferDrawSel([]);
    updateArmedHl();
    showFeaturePanel(id);
    updateGroupHl(id);
    syncAttrRowsFromMap([{ id: id }]);
  }
  function injectFeaturePanel() {
    if (document.getElementById('editor-feature-panel')) return;
    var p = document.createElement('div');
    p.id = 'editor-feature-panel';
    p.style.cssText = 'position:fixed;top:120px;right:12px;width:240px;max-height:calc(100vh - 230px);overflow-y:auto;overflow-x:hidden;background:#fff;border:1px solid #bbbbbb;border-radius:6px;box-shadow:0 2px 10px rgba(0,0,0,0.18);padding:10px;font-size:13px;z-index:1000;display:none;font-family:Source Sans Pro,Arial,sans-serif;';  // scroll + stay above the timeline
    p.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;"><b>Feature</b><span id="efp-close" style="cursor:pointer;color:#888888;font-size:16px;">&times;</span></div>' +
      '<div id="efp-group-note" style="display:none;font-size:11px;color:#7a5cc9;background:#f4f1fb;border-radius:4px;padding:4px 6px;margin-bottom:6px;"></div>' +
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
      '<button id="efp-done" style="margin-top:10px;width:100%;padding:7px;border:1px solid #a3c293;border-radius:4px;background:#eafaea;color:#2d7a2d;font-weight:600;cursor:pointer;font-size:12px;display:none;">✓ Done editing</button>';
      // #10: "Delete feature" button removed — delete via the draw trash button or the keyboard (Delete/Backspace).
    document.body.appendChild(p);
    document.getElementById('efp-close').addEventListener('click', function () {   // ✕ = full deselect: also reset the click-stage bookkeeping, or the NEXT click on this feature would skip stage 1
      if (draw) try { draw.changeMode('simple_select', { featureIds: [] }); } catch (e) {}
      _editingDraw = null; _armedSet = []; setArmedHl(null); updateGroupHl(null);
      hideFeaturePanel();
    });
    document.getElementById('efp-pageid').addEventListener('input', function () { onFeatureField('pageid', this.value); });
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
    if (!lnode && activeLayerId) lnode = findNodeById(layers, activeLayerId);   // a JUST-DRAWN feature: its DB insert hasn't resolved featureLayer yet — the active layer is where it's going
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
    undockEditor();   // #11: pull the editor box back out of the info panel + restore its fixed styles (also hides it)
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
    if (_attrSlug) { delete _attrById[String(fid)]; _attrRows = _attrRows.filter(function (r) { return String(r.feature_id) !== String(fid); }); _attrSel = _attrSel.filter(function (s) { return s !== String(fid); }); if (document.getElementById('editor-attr-modal') && document.getElementById('editor-attr-modal').style.display !== 'none') { buildAttrHead(); renderAttrBody(true); } }   // keep an open table in sync (hold scroll position)
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
  // #11: dock the editor box INSIDE the info panel (preview on top, editor form below), instead of a
  // separate box shifted to the left of it. Save the fixed-position styles so we can restore on undock.
  var _efpDocked = false, _efpSavedCss = null;
  function dockEditorIntoInfoPanel(previewDivId) {
    var box = document.getElementById('editor-feature-panel'), bar = document.getElementById('rightInfoBar'), pv = document.getElementById(previewDivId);
    if (!box || !bar || !pv) return;
    if (!_efpDocked) { _efpSavedCss = box.style.cssText; _efpDocked = true; }
    // flow inside the info panel column (drop fixed positioning / shadow / border — the info panel is the chrome now).
    // #rightInfoBar has NO fixed width (shrink-wraps its content), so the docked box must be a FIXED width matching
    // the .infoLayerElem panel (270px, box-sizing:border-box) — otherwise long field text widens the whole info panel.
    box.style.cssText = 'display:block;position:static;width:270px;box-sizing:border-box;padding:0 5px;max-height:none;overflow-x:hidden;overflow-y:visible;word-break:break-word;overflow-wrap:anywhere;background:transparent;border:none;box-shadow:none;margin-top:10px;font-size:13px;font-family:Source Sans Pro,Arial,sans-serif;';
    if (pv.nextSibling !== box) pv.parentNode.insertBefore(box, pv.nextSibling);   // editor form right BELOW the preview
  }
  function undockEditor() {
    if (!_efpDocked) return;
    var box = document.getElementById('editor-feature-panel');
    if (box) { box.style.cssText = _efpSavedCss != null ? _efpSavedCss : box.style.cssText; box.style.display = 'none'; document.body.appendChild(box); }
    _efpDocked = false; _efpSavedCss = null;
  }
  function showNotesPreview(node, props) {
    var $ = window.$, divId = ensureEncPanelDiv(node); if (!divId || !$) return;
    var $el = $('#' + divId);
    Array.prototype.forEach.call(document.querySelectorAll('#rightInfoBar .infoLayerElem'), function (el) { if (el.id !== divId) el.style.display = 'none'; });   // one panel at a time
    var renderFn = (window.renderRegistry && window.renderRegistry._notes) || (node.panel && node.panel.render);   // always _notes (panel.render is the Drupal one in "both" mode)
    var hasInfo = (props.label || '') || (props.notes || '') || (props.image_url || '');
    if (!hasInfo) { $el.html('<h3 style="opacity:.55;font-style:italic;font-weight:400;">(enter details)</h3>'); }   // edit-only placeholder — the viewer shows nothing for empty features
    else { try { $el.html(renderFn ? renderFn(props, function () { return ''; }) : ('<h3>' + attrEsc(props.label || '') + '</h3>')); } catch (e) { $el.html('<h3>' + attrEsc(props.label || '') + '</h3>'); } }
    if (typeof floatPanelToTop === 'function') { try { floatPanelToTop(divId); } catch (e) {} }
    $el.show();
    dockEditorIntoInfoPanel(divId);   // editor form now lives INSIDE the info panel, below the preview
  }
  function onFeatureField(field, value) {
    if (!selectedDrawId) return;
    var meta = featureMeta[selectedDrawId] = featureMeta[selectedDrawId] || { label: '', notes: '' };
    meta[field] = value;
    var _ln = featureLayer[selectedDrawId] ? nodeByLayerDbId(featureLayer[selectedDrawId]) : null;   // live-refresh the notes preview as you type label/notes
    if (_ln && _ln.panel && _ln.panel.mode === 'notes' && document.getElementById('infoPanel-' + _ln.id)) showNotesPreview(_ln, { label: meta.label, notes: meta.notes, image_url: meta.image_url });
    if (_refreshOpenPill) _refreshOpenPill(selectedDrawId);   // the open click-bubble tracks the label in realtime
    if (field === 'label' && _ln && _ln.labels && (_ln.labels.field || 'label') === 'label') {   // map text labels track it too (debounced label-layer rebuild — no refresh needed)
      clearTimeout(_lblLiveTimer); _lblLiveTimer = setTimeout(function () { try { applyLabelLayers(_ln); } catch (e) {} }, 400);
    }
    clearTimeout(_featTimer);
    _featTimer = setTimeout(function () { saveFeatureMeta(selectedDrawId); }, 600);
  }
  async function saveFeatureMeta(drawId) {
    var fid = featureToDb[drawId]; if (!fid) return;
    var meta = featureMeta[drawId] || {};
    setStatus('Saving…');
    try { var r = await db.from('features').update({ label: meta.label || null, description: meta.notes || null, start_date: meta.start || null, end_date: meta.end || null, content_id: meta.pageid || null, image_url: meta.image_url || null }).eq('feature_id', fid); if (r.error) throw new Error(r.error.message); setStatus('Saved'); }
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
      // OFF-by-default layers hydrate in the background — if this layer's rows haven't arrived yet, fetch
      // them NOW (and rebuild its labels from live data); otherwise features/labels only showed after a
      // second off/on toggle once the background fetch happened to finish. Small layers only: a LARGE
      // layer's checkbox is the engine's business (refreshLayers) — hydrating it would dump 10k+ rows into draw.
      if (dbId && _drawLayerSlugs[slug] && typeof _hydrateOne === 'function') _hydrateOne(dbId);
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
    // fills default their border width to 0.5 (thinner than mapbox's native 1px fill-outline —
    // the stroke companion renders it; exactly 1 = native, anything else = companion)
    if (type === 'fill') return { 'fill-color': color, 'fill-outline-color': outline || color, 'fill-opacity': op != null ? op : 0.35, 'line-opacity': outlineVis != null ? outlineVis : 1, 'line-width': width != null ? width : 0.5 };
    if (type === 'line') return { 'line-color': color, 'line-width': w, 'line-opacity': op != null ? op : 1 };
    return { 'circle-color': color, 'circle-radius': radius != null ? radius : 6, 'circle-stroke-width': width != null ? width : 1.5, 'circle-stroke-color': outline || '#ffffff', 'circle-opacity': op != null ? op : 1 };
  }
  // ── Color by attribute: a hex-color column (with or without '#') is used directly; any other column gets
  //    a palette color per distinct value (categories / names). Persisted as a mapbox `match` expression in
  //    layers.paint — the public viewer renders it natively — plus meta in layers.raw_config.colorBy (which
  //    configLoader spreads back onto the node) so the editor UI + MapboxDraw per-feature colors follow.
  //    Number RANGES (step expressions) are the planned follow-up.
  var COLORBY_PALETTE = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#46f0f0', '#f032e6', '#bcf60c', '#fabebe', '#008080', '#e6beff', '#9a6324', '#fffac8', '#800000', '#aaffc3', '#808000', '#ffd8b1', '#000075', '#808080', '#ffe119'];
  function colorKeyFor(type) { return type === 'fill' ? 'fill-color' : type === 'line' ? 'line-color' : 'circle-color'; }
  function looksHex(v) { return /^#?[0-9a-fA-F]{6}$/.test(String(v == null ? '' : v).trim()); }
  function normHex(v) { v = String(v).trim(); return (v[0] === '#' ? v : '#' + v).toLowerCase(); }
  function syncColorInputForColorBy(node) {   // colour-by on → swap the single swatch for the multicolor strip
    var rowC = document.getElementById('elp-color-row'), strip = document.getElementById('elp-multicolor-strip');
    if (!rowC || !strip) return;
    var multi = !!(node && node.colorBy);
    rowC.style.display = multi ? 'none' : 'block';
    strip.style.display = multi ? 'flex' : 'none';
  }
  // The bubble "Label field" (and the map-labels column pick, where supported) share one column list.
  function fillLabelFieldSelect(node, sortedKeys) {
    var lf = document.getElementById('elp-labelfield');
    if (!lf) return;
    var want = (node._uiLabel != null) ? node._uiLabel : (node.prop || 'label');
    lf.innerHTML = '<option value="label">label (the feature\'s own Label)</option>';
    sortedKeys.forEach(function (k) { if (k === 'label') return; var o2 = document.createElement('option'); o2.value = k; o2.textContent = k; lf.appendChild(o2); });
    if (want !== 'label' && sortedKeys.indexOf(want) < 0) { var oc = document.createElement('option'); oc.value = want; oc.textContent = want; lf.appendChild(oc); }   // keep a saved value that isn't a known column
    lf.value = want;
  }
  async function populateColorBy(node) {
    var row = document.getElementById('elp-colorby-row'), sel = document.getElementById('elp-colorby'), info = document.getElementById('elp-colorby-info');
    if (!row || !sel) return;
    syncColorInputForColorBy(node);
    var isDrawn = node && node.source_type === 'geojson-supabase';
    // color-by works on TILESET LINE layers too (values come from server counts; the paint match
    // expression evaluates against tile properties) — polygons/points stay drawn-only for now
    var tsColorable = node && isTilesetNode(node) && node.type === 'line' && slugToLayerDbId[node.id];
    row.style.display = (isDrawn || tsColorable) ? 'block' : 'none';
    var gbRow = document.getElementById('elp-groupby-row'); if (gbRow) gbRow.style.display = 'none';   // (re)shown by fillGroupBySelect on drawn layers only
    ['elp-opacityby-row', 'elp-thickby-row'].forEach(function (rid) { var r2 = document.getElementById(rid); if (r2) r2.style.display = isDrawn ? 'block' : 'none'; });   // the by-column selects live NEXT TO their sliders now (paired groups)
    if (!isDrawn) {
      // TILESETS: the columns live in the tiles — union the property keys of the loaded features so
      // the bubble "Label field" dropdown offers them (it used to stay empty for tilesets).
      if (node && isTilesetNode(node)) {
        var tkeys = {};
        [['left', (typeof beforeMap !== 'undefined' ? beforeMap : null)], ['right', (typeof afterMap !== 'undefined' ? afterMap : null)]].forEach(function (pair) {
          var m = pair[1]; if (!m) return;
          try {
            var fs2 = m.querySourceFeatures(node.id + '-' + pair[0], node['source-layer'] ? { sourceLayer: node['source-layer'] } : undefined) || [];
            for (var i = 0; i < fs2.length && i < 400; i++) Object.keys(fs2[i].properties || {}).forEach(function (k) { tkeys[k] = 1; });
          } catch (e) {}
        });
        var tcols = Object.keys(tkeys).sort();
        fillLabelFieldSelect(node, tcols);
        // map labels now work on TILESET LINE layers too (labels.js rides the vector source, 7/16).
        // Skinny tiles carry `label` + the configured column (baked at Publish) — offer whatever
        // the tiles actually contain, minus the timeline plumbing. Points/polygons: still hidden.
        if (node.type === 'line') {
          fillMapLabelControls(node, tcols.filter(function (k) { return k !== 'DayStart' && k !== 'DayEnd'; }));
        } else {
          var mlRow2 = document.getElementById('elp-maplabels-row'); if (mlRow2) mlRow2.style.display = 'none';   // also clears a stale 'block' from a previously-selected drawn layer
          var mlHelp2 = document.getElementById('elp-lbl-help'); if (mlHelp2) mlHelp2.style.display = 'none';
        }
        // "Treat as one" works on tilesets too: members come from the loaded tiles (which carry the baked columns)
        fillGroupBySelect(node, tcols.filter(function (k) { return k !== 'DayStart' && k !== 'DayEnd'; }));
        // color-by for tileset LINES: same control, values later fetched from server counts
        if (tsColorable) {
          sel.innerHTML = '<option value="">Single color</option>';
          tcols.filter(function (k) { return k !== 'DayStart' && k !== 'DayEnd'; }).forEach(function (k) { var oc2 = document.createElement('option'); oc2.value = k; oc2.textContent = k; sel.appendChild(oc2); });
          var cbt = node.colorBy;
          if (cbt && cbt.prop) { if (![].slice.call(sel.options).some(function (o) { return o.value === cbt.prop; })) { var oc3 = document.createElement('option'); oc3.value = cbt.prop; oc3.textContent = cbt.prop; sel.appendChild(oc3); } sel.value = cbt.prop; info.textContent = cbt.mode === 'hex' ? "Using the column's own hex colors." : (Object.keys(cbt.mapping || {}).length + ' categories, one color each.'); }
          else { sel.value = ''; info.textContent = ''; }
        }
      }
      return;
    }
    var lid = slugToLayerDbId[node.id];
    sel.innerHTML = '<option value="">Single color</option>';
    info.textContent = '';
    if (!lid) return;
    try {
      var r = await db.from('features').select('custom_fields').eq('layer_id', lid).not('custom_fields', 'is', null).limit(100);
      var keys = {};
      (r.data || []).forEach(function (f) { Object.keys(f.custom_fields || {}).forEach(function (k) { keys[k] = 1; }); });
      // dropdowns lead with the UNIVERSAL style columns (the default styling home), then everything else
      var allKeys = Object.keys(keys).sort();
      var msFirst = ['ms_color', 'ms_linecolor', 'ms_opacity', 'ms_thickness', 'ms_labelsize'].filter(function (k) { return allKeys.indexOf(k) > -1; });
      var sortedKeys = msFirst.concat(allKeys.filter(function (k) { return msFirst.indexOf(k) < 0; }));
      sortedKeys.forEach(function (k) { var o = document.createElement('option'); o.value = k; o.textContent = k; sel.appendChild(o); });
      var cb = node.colorBy;
      if (cb && cb.prop) { sel.value = cb.prop; info.textContent = cb.mode === 'hex' ? "Using the column's own hex colors." : (Object.keys(cb.mapping || {}).length + ' categories, one color each.'); }
      // opacity/thickness-by dropdowns get the same columns
      [['elp-opacityby', 'opacityBy', 'Single opacity (slider above)', 'opacity'], ['elp-thickby', 'thicknessBy', 'Single thickness (slider above)', 'thickness']].forEach(function (spec) {
        var s2 = document.getElementById(spec[0]); if (!s2) return;
        s2.innerHTML = '<option value="">' + spec[2] + '</option>';
        sortedKeys.forEach(function (k) { var o3 = document.createElement('option'); o3.value = k; o3.textContent = k; s2.appendChild(o3); });
        var savedProp = (node[spec[1]] && node[spec[1]].prop) || '';
        s2.value = savedProp;
        var inf2 = document.getElementById(spec[0] + '-info');
        if (inf2) inf2.textContent = savedProp ? ('Per-feature ' + spec[3] + ' from ' + savedProp + ' (slider = fallback).') : '';
      });
      fillMapLabelControls(node, sortedKeys);
      // the Label-field dropdown gets the same columns ("label" = the feature's own Label field)
      fillLabelFieldSelect(node, sortedKeys);
      fillGroupBySelect(node, sortedKeys);
    } catch (e) {}
  }
  // "Treat as one" — drawn layers only for now (tileset tiles may not carry the column; the
  // engine source / draw metas do). Same column list as labels/color-by, plus "label".
  function fillGroupBySelect(node, sortedKeys) {
    var row = document.getElementById('elp-groupby-row'), sel = document.getElementById('elp-groupby');
    if (!row || !sel) return;
    row.style.display = 'block';
    sel.innerHTML = '<option value="">— off (each feature on its own) —</option><option value="label">label (the feature\'s own Label)</option>';
    sortedKeys.forEach(function (k) { if (k === 'label') return; var o = document.createElement('option'); o.value = k; o.textContent = k; sel.appendChild(o); });
    var g = node.groupBy || '';
    if (g && g !== 'label' && sortedKeys.indexOf(g) < 0) { var o2 = document.createElement('option'); o2.value = g; o2.textContent = g; sel.appendChild(o2); }
    sel.value = g;
  }
  async function onGroupBy(value) {
    if (!activeLayerId) return;
    var node = findNodeById(layers, activeLayerId); if (!node) return;
    var lid = slugToLayerDbId[activeLayerId]; if (!lid) return;
    node.groupBy = (value || '').trim() || null;
    setStatus('Saving…');
    try {
      var cur = await db.from('layers').select('raw_config').eq('id', lid).single();
      var rc = (cur.data && cur.data.raw_config) || {};
      if (node.groupBy) rc.groupBy = node.groupBy; else delete rc.groupBy;
      var r = await db.from('layers').update({ raw_config: rc }).eq('id', lid);
      if (r.error) throw new Error(r.error.message);
      setStatus('Saved');
    } catch (e) { setStatus('Save failed'); }
    if (selectedDrawId) updateGroupHl(selectedDrawId);   // live: re-light (or clear) the current selection
  }
  // map-labels controls: checkbox + column pick (same columns, "label" first) — shared by the
  // geojson path AND tileset LINE layers (labels on tileset lines, 7/16)
  function fillMapLabelControls(node, sortedKeys) {
    var mlRow = document.getElementById('elp-maplabels-row'), mlOn = document.getElementById('elp-maplabels-on'),
        mlSel = document.getElementById('elp-maplabels-field'), mlFieldRow = document.getElementById('elp-maplabels-field-row');
    if (!(mlRow && mlOn && mlSel)) return;
    mlRow.style.display = 'block';
    var mlHelp = document.getElementById('elp-lbl-help'); if (mlHelp) mlHelp.style.display = 'block';
    mlSel.innerHTML = '<option value="label">label (the feature\'s own Label)</option>';
    sortedKeys.forEach(function (k) { var o4 = document.createElement('option'); o4.value = k; o4.textContent = k; mlSel.appendChild(o4); });
    var lb = node.labels;
    mlOn.checked = !!(lb && lb.field);
    if (lb && lb.field) { if (sortedKeys.indexOf(lb.field) < 0 && lb.field !== 'label') { var o5 = document.createElement('option'); o5.value = lb.field; o5.textContent = lb.field; mlSel.appendChild(o5); } mlSel.value = lb.field; }
    else mlSel.value = 'label';
    if (mlFieldRow) mlFieldRow.style.display = mlOn.checked ? 'block' : 'none';
    // styling controls reflect the saved config (or the defaults)
    var lbc = lb || {};
    function setv(id6, val) { var el6 = document.getElementById(id6); if (el6) el6.value = val; }
    setv('elp-lbl-color', lbc.color || '#000000');
    setv('elp-lbl-halo', lbc.halo || '#ffffff');
    setv('elp-lbl-halow', lbc.haloWidth != null ? lbc.haloWidth : 2);
    var hv = document.getElementById('elp-lbl-halow-val'); if (hv) hv.textContent = lbc.haloWidth != null ? lbc.haloWidth : 2;
    var bd = document.getElementById('elp-lbl-bold'); if (bd) bd.checked = lbc.bold !== false;
    setv('elp-lbl-density', 60 - (lbc.density != null ? lbc.density : 10));
    // size is ALWAYS the zoom ramp now (uniform mode + its checkbox removed 7/15): saved
    // sizeStops → legacy size triple (fixed z6/11/16) → a legacy uniform size as a flat one-stop → defaults
    renderLblStops((lbc.sizeStops && lbc.sizeStops.length) ? lbc.sizeStops
      : (lbc.size && lbc.size.length === 3) ? [[6, lbc.size[0]], [11, lbc.size[1]], [16, lbc.size[2]]]
      : (lbc.varyZoom === false && lbc.sizeUniform > 0) ? [[11, lbc.sizeUniform]]
      : [[6, 10], [11, 13], [16, 17]]);
  }
  async function onColorBy(prop) {
    if (!activeLayerId) return;
    var node = findNodeById(layers, activeLayerId); if (!node) return;
    var lid = slugToLayerDbId[activeLayerId]; if (!lid) return;
    var info = document.getElementById('elp-colorby-info');
    var key = colorKeyFor(node.type);
    var fallback = (node.iconColor && /^#[0-9a-fA-F]{6}$/.test(node.iconColor)) ? node.iconColor : '#3bb2d0';
    setStatus('Saving…');
    try {
      var paint = JSON.parse(JSON.stringify(node.paint || {}));
      if (!prop) {   // back to single color
        node.colorBy = null;
        paint[key] = fallback;
        if (info) info.textContent = '';
      } else {
        var seen = {}, order = [];
        if (isTilesetNode(node)) {
          // tileset layers: distinct values from ONE server call (paging 78k rows would be heavy)
          var cr9 = await db.rpc('ms_layer_key_counts', { p_layer: lid, p_key: prop });
          if (cr9.error) throw new Error(cr9.error.message + (/function|does not exist/.test(cr9.error.message) ? ' — run sql/setup/query-ops-setup.sql first' : ''));
          ((cr9.data) || []).slice().sort(function (a, b) { return b.n - a.n; }).forEach(function (c9) { var s9 = String(c9.k); if (!(s9 in seen)) { seen[s9] = 1; order.push(s9); } });
        } else {
          var rows = [];
          for (var off = 0; ; off += 1000) {   // all values (paged)
            var fr = await db.from('features').select('custom_fields').eq('layer_id', lid).order('feature_id').range(off, off + 999);
            if (fr.error || !fr.data || !fr.data.length) break;
            rows = rows.concat(fr.data);
            if (fr.data.length < 1000) break;
          }
          rows.forEach(function (f) { var v = f.custom_fields ? f.custom_fields[prop] : null; if (v == null) return; var s = String(v); if (!(s in seen)) { seen[s] = 1; order.push(s); } });
        }
        if (!order.length) { setStatus('No values in that column'); showToast('That column has no values'); return; }
        // literal-colour columns: hex (with/without #), rgb()/rgba(), or the explicit "none" (→ un-filled: the
        // source left these uncolored — ESRI renders them invisible; we keep the outline so the feature stays findable)
        var isColorVal = function (v) { var s2 = String(v == null ? '' : v).trim(); return looksHex(s2) || /^rgba?\([^)]+\)$/i.test(s2) || s2.toLowerCase() === 'none'; };
        var allHex = order.every(isColorVal);
        var catCap = isTilesetNode(node) ? 600 : 60;   // tileset lines (e.g. 491 railroad companies) legitimately cycle the palette
        if (!allHex && order.length > catCap) { setStatus('Too many categories'); showToast('Too many distinct values to color by (' + order.length + ')'); return; }
        var mapping = {};
        order.forEach(function (v, i) {
          if (!allHex) { mapping[v] = COLORBY_PALETTE[i % COLORBY_PALETTE.length]; return; }
          var s3 = String(v).trim();
          mapping[v] = s3.toLowerCase() === 'none' ? 'rgba(0,0,0,0)' : (looksHex(s3) ? normHex(s3) : s3);   // as-is: rgb() stays rgb()
        });
        node.colorBy = { prop: prop, mode: allHex ? 'hex' : 'category', mapping: mapping };
        var expr = ['match', ['to-string', ['get', prop]]];
        order.forEach(function (v) { expr.push(v, mapping[v]); });
        expr.push(fallback);
        paint[key] = expr;
        if (info) info.textContent = allHex ? ("Using the column's own hex colors (" + order.length + " values)." + (mapping['none'] ? " 'none' renders un-filled (outline only)." : '')) : (order.length + ' categories, one color each.');
      }
      node.paint = paint;
      // persist: paint renders everywhere (incl. the public viewer); colorBy meta drives this UI + draw colors
      var cur = await db.from('layers').select('raw_config').eq('id', lid).single();
      var rc = (cur.data && cur.data.raw_config) || {};
      if (node.colorBy) rc.colorBy = node.colorBy; else delete rc.colorBy;
      var r2 = await db.from('layers').update({ paint: paint, raw_config: rc }).eq('id', lid);
      if (r2.error) throw new Error(r2.error.message);
      // live: engine copies on both swipe sides + the MapboxDraw copies (loadFeatures re-colors per feature)
      [[beforeMap, '-left'], [typeof afterMap !== 'undefined' ? afterMap : null, '-right']].forEach(function (ms) {
        var m = ms[0]; if (!m) return;
        try { if (m.getLayer(node.id + ms[1])) m.setPaintProperty(node.id + ms[1], key, paint[key]); } catch (e) {}
      });
      if (!isTilesetNode(node)) await loadFeatures();   // draw copies re-color; tilesets recolor via paint alone
      rerender();   // sidebar icon flips to/from the multicolor gradient (generateLayers reads node.colorBy)
      syncColorInputForColorBy(node);   // panel swatch ↔ multicolor strip
      setStatus('Saved');
    } catch (e) { console.warn('colorBy failed', e); setStatus('Save failed'); }
  }
  // ── Map labels: raw_config.labels = {field}. The engine adds the symbol layers on load (addLayers.js
  //    via labels.js); here we persist + rebuild them live on BOTH maps. Anchors come from the freshest
  //    in-memory geometry (draw copies), falling back to the engine source for large layers.
  function labelFeaturesFor(node) {
    var lid = slugToLayerDbId[node.id], out = [];
    Object.keys(featureLayer).forEach(function (did) {
      if (featureLayer[did] !== lid) return;
      var g = _geomSnap[did]; if (!g) return;
      var m = featureMeta[did] || {};
      var props = { label: m.label || null };
      if (m.custom) Object.keys(m.custom).forEach(function (k) { if (!(k in props)) props[k] = m.custom[k]; });
      out.push({ type: 'Feature', geometry: g, properties: props });
    });
    if (!out.length) { try { out = (node.source && node.source.data && node.source.data.features) || []; } catch (e) {} }
    // last resort: the engine's LIVE source (large engine-rendered layers never enter _geomSnap, and
    // node.source.data is empty until deferred hydration lands) — whatever the map is drawing, label it
    if (!out.length) { try { var es = beforeMap.getSource(node.id + '-left'); var ed = es && es.serialize && es.serialize().data; out = (ed && ed.features) || []; } catch (e) {} }
    return out;
  }
  function applyLabelLayers(node) {
    if (typeof msLabelLayerFor !== 'function') return;
    [[beforeMap, 'left'], [typeof afterMap !== 'undefined' ? afterMap : null, 'right']].forEach(function (pair) {
      var m = pair[0], side = pair[1]; if (!m) return;
      var lyrId = node.id + '-label-' + side, srcId = node.id + '-labels-' + side;
      try { if (m.getLayer(lyrId)) m.removeLayer(lyrId); } catch (e) {}
      try { if (m.getSource(srcId)) m.removeSource(srcId); } catch (e) {}
      if (!node.labels || !node.labels.field) return;
      // TILESET lines: labels ride the vector source (labels.js needs the REAL node's source/source-layer);
      // the geojson-anchor proxy is only for drawn/imported layers
      var isVecLine = node.type === 'line' && node.source && node.source.type === 'vector';
      var proxy = isVecLine ? node : { id: node.id, type: node.type, labels: node.labels,
        source: { type: 'geojson', data: { type: 'FeatureCollection', features: labelFeaturesFor(node) } } };
      var ll = msLabelLayerFor(proxy, side, 'visible', m);   // m → fonts the style's glyph server actually has
      if (!ll) return;
      try {
        if (ll.sourceId && !m.getSource(ll.sourceId)) m.addSource(ll.sourceId, ll.source);
        if (!m.getLayer(ll.layer.id)) m.addLayer(ll.layer);   // line labels reuse the engine source (slug-side), which exists even when its layer is hidden
      } catch (e) { console.warn('label apply failed', e); }
    });
  }
  // ── zoom-size stops UI: one row per stop (zoom → px). ⌖ zooms the map TO that level so you can
  //    SEE the size you're tuning; "+ Add zoom level" captures the CURRENT zoom (go where it looks
  //    wrong, add a stop, fix it there). Stops persist as labels.sizeStops (labels.js) ──
  function readLblStops() {
    var out = [], box = document.getElementById('elp-lbl-zoomsizes'); if (!box) return out;
    box.querySelectorAll('.elp-stop-row').forEach(function (r) {
      var z = parseFloat(r.querySelector('.elp-stop-z').value), s = parseFloat(r.querySelector('.elp-stop-s').value);
      if (!isNaN(z) && !isNaN(s) && s > 0) out.push([Math.max(0, Math.min(24, z)), s]);
    });
    out.sort(function (a, b) { return a[0] - b[0]; });
    return out;
  }
  function lblSizeAt(stops, z) {   // linear read of the ramp — a new stop lands ON the curve, not off it
    if (!stops.length) return 13;
    if (z <= stops[0][0]) return stops[0][1];
    for (var i = 1; i < stops.length; i++) if (z <= stops[i][0]) {
      var a = stops[i - 1], b = stops[i];
      return Math.round(a[1] + (b[1] - a[1]) * ((z - a[0]) / (b[0] - a[0] || 1)));
    }
    return stops[stops.length - 1][1];
  }
  function renderLblStops(stops) {
    var box = document.getElementById('elp-lbl-zoomsizes'); if (!box) return;
    box.innerHTML = '';
    var head = document.createElement('div');
    head.style.cssText = 'display:flex;gap:6px;font-size:9px;color:#888888;';
    head.innerHTML = '<span style="width:26px;"></span><span style="flex:1;text-align:center;">zoom</span><span style="flex:1;text-align:center;">size (px)</span><span style="width:18px;"></span>';
    box.appendChild(head);
    (stops || []).forEach(function (st) {
      var row = document.createElement('div');
      row.className = 'elp-stop-row';
      row.style.cssText = 'display:flex;gap:6px;align-items:center;margin-top:3px;';
      row.innerHTML =
        '<button type="button" class="elp-stop-go" title="Zoom the map to this level" style="width:26px;height:26px;border:none;border-radius:4px;background:#2b7de0;color:#ffffff;cursor:pointer;font-size:17px;font-weight:700;padding:0;line-height:24px;">⌖</button>' +
        '<input type="number" class="elp-stop-z ms-in" min="0" max="24" step="0.5" style="flex:1;padding:4px;" />' +
        '<input type="number" class="elp-stop-s ms-in" min="1" max="60" style="flex:1;padding:4px;" />' +
        '<button type="button" class="elp-stop-del" title="Remove this zoom level" style="width:18px;height:24px;border:none;background:none;color:#aa4444;cursor:pointer;font-size:13px;padding:0;">×</button>';
      row.querySelector('.elp-stop-z').value = st[0];
      row.querySelector('.elp-stop-s').value = st[1];
      row.querySelector('.elp-stop-go').addEventListener('click', function () {
        var z = parseFloat(row.querySelector('.elp-stop-z').value);
        if (!isNaN(z)) try { beforeMap.easeTo({ zoom: z, duration: 500 }); } catch (e) {}   // compare plugin keeps the right side in sync
      });
      row.querySelector('.elp-stop-del').addEventListener('click', function () {
        if (box.querySelectorAll('.elp-stop-row').length <= 1) return;   // keep at least one stop (single stop = constant size)
        row.remove(); onMapLabelsChange();
      });
      box.appendChild(row);
    });
    var add = document.createElement('button');
    add.type = 'button'; add.id = 'elp-stop-add';
    add.textContent = '+ Add zoom level (at current zoom)';
    add.title = 'Adds a stop at the zoom you are looking at, pre-sized to match the current ramp';
    add.style.cssText = 'margin-top:4px;width:100%;padding:4px 0;border:1px solid #bbbbbb;border-radius:4px;background:#f2f2f2;cursor:pointer;font-size:11px;';
    add.addEventListener('click', function () {
      var st2 = readLblStops(), z2 = 12;
      try { z2 = Math.round(beforeMap.getZoom() * 2) / 2; } catch (e) {}
      st2.push([z2, lblSizeAt(st2, z2)]);
      st2.sort(function (a, b) { return a[0] - b[0]; });
      renderLblStops(st2); onMapLabelsChange();
    });
    box.appendChild(add);
  }
  // ── "Labels are hard" how-to modal (same chrome family as the Guide panel) ──
  function openLabelsHelp() {
    var ov = document.getElementById('elp-lblhelp-overlay');
    if (!ov) {
      var css = document.createElement('style');
      css.textContent =
        '#elp-lblhelp-overlay{position:fixed;inset:0;background:rgba(20,18,30,0.5);z-index:4000;display:none;}' +
        '#elp-lblhelp-panel{position:absolute;top:8vh;left:50%;transform:translateX(-50%);width:520px;max-width:93vw;max-height:80vh;display:flex;flex-direction:column;background:#fff;border-radius:12px;box-shadow:0 18px 60px rgba(0,0,0,0.4);font-family:Source Sans Pro,Arial,sans-serif;color:#2a2a33;overflow:hidden;}' +
        '#elp-lblhelp-head{display:flex;justify-content:space-between;align-items:center;padding:14px 22px 11px;border-bottom:1px solid #ece9f4;background:linear-gradient(180deg,#faf9fd,#fff);}' +
        '#elp-lblhelp-head b{font-size:16px;color:#1e1b2e;}' +
        '#elp-lblhelp-head small{display:block;font-weight:400;font-size:12px;color:#8a86a0;margin-top:1px;}' +
        '#elp-lblhelp-close{cursor:pointer;color:#a09cb5;font-size:22px;line-height:1;padding:2px 6px;border-radius:6px;}' +
        '#elp-lblhelp-close:hover{background:#f1eef9;color:#544f6e;}' +
        '#elp-lblhelp-body{overflow-y:auto;padding:4px 22px 22px;font-size:13px;line-height:1.55;}' +
        '#elp-lblhelp-body h4{margin:16px 0 4px;font-size:13.5px;color:#1e1b2e;}' +
        '#elp-lblhelp-body p{margin:5px 0;}' +
        '#elp-lblhelp-body b{color:#1e1b2e;}';
      document.head.appendChild(css);
      ov = document.createElement('div');
      ov.id = 'elp-lblhelp-overlay';
      ov.innerHTML =
        '<div id="elp-lblhelp-panel">' +
          '<div id="elp-lblhelp-head"><div><b>🎓 Labels are hard</b><small>The most difficult thing in web mapping — here\'s how to win</small></div><span id="elp-lblhelp-close">&times;</span></div>' +
          '<div id="elp-lblhelp-body">' +
            '<p>Labels live in a world of <b>collisions</b>: every label competes for space with every other label at every zoom. The map only draws the ones that fit — so labels appearing and disappearing as you zoom is <i>normal</i>, and the controls below are how you steer it.</p>' +
            '<h4>Where the text comes from</h4>' +
            '<p><b>Labels show this column</b> picks the field. Features with an <b>empty</b> value never get a label (and never show "null"). A per-feature <b>ms_labelsize</b> column (set it in the attribute table) overrides the size for just that feature.</p>' +
            '<h4>Size — a zoom ramp</h4>' +
            '<p>Each row under <b>Size by zoom</b> is a <b>zoom level → size</b> stop and the map blends smoothly between them. Want one fixed size everywhere? Delete down to a single stop.</p>' +
            '<p>Click <b>⌖</b> on a row to fly the map to exactly that zoom — see it, then change it. <b>+ Add zoom level</b> inserts a stop at the zoom you\'re currently looking at, pre-sized to match the ramp (so adding never jolts the sizes — it just gives you a handle to tune that zoom).</p>' +
            '<h4>Readability</h4>' +
            '<p><b>Halo</b> is the outline that keeps text legible over busy imagery — white halo on dark text works almost everywhere. <b>Bold</b> helps small sizes survive satellite backgrounds.</p>' +
            '<h4>Too many / too few labels</h4>' +
            '<p><b>Label density</b> is collision breathing-room: slide toward <i>more</i> and labels pack tighter; toward <i>fewer</i> and only the ones with room draw. If a label you need is missing, zoom in a touch or raise density.</p>' +
            '<h4>Placement (automatic)</h4>' +
            '<p>Polygons label at their <b>visual center</b> (guaranteed inside, even donut shapes), lines run <b>along the path</b>, points sit just <b>below the marker</b>. Fonts are picked per basemap automatically, so labels render on free basemaps and Mapbox styles alike.</p>' +
          '</div>' +
        '</div>';
      document.body.appendChild(ov);
      ov.querySelector('#elp-lblhelp-close').addEventListener('click', function () { ov.style.display = 'none'; });
      ov.addEventListener('click', function (e) { if (e.target === ov) ov.style.display = 'none'; });
      document.addEventListener('keydown', function (e) { if (e.key === 'Escape') ov.style.display = 'none'; });
    }
    ov.style.display = 'block';
  }
  async function onMapLabelsChange() {
    if (!activeLayerId) return;
    var node = findNodeById(layers, activeLayerId); if (!node) return;
    var lid = slugToLayerDbId[activeLayerId]; if (!lid) return;
    var on = document.getElementById('elp-maplabels-on'), fs = document.getElementById('elp-maplabels-field');
    var fieldRow = document.getElementById('elp-maplabels-field-row');
    if (fieldRow) fieldRow.style.display = on && on.checked ? 'block' : 'none';
    function v2(id2, dflt) { var el = document.getElementById(id2); return el && el.value !== '' ? el.value : dflt; }
    var boldEl = document.getElementById('elp-lbl-bold');
    node.labels = (on && on.checked) ? {
      field: (fs && fs.value) || 'label',
      color: v2('elp-lbl-color', '#000000'),
      halo: v2('elp-lbl-halo', '#ffffff'),
      haloWidth: parseFloat(v2('elp-lbl-halow', 2)),
      bold: boldEl ? !!boldEl.checked : true,
      varyZoom: true,   // uniform mode removed 7/15 — size is always the stops ramp (a single stop = constant)
      density: 60 - parseFloat(v2('elp-lbl-density', 50)),   // slider right = "more" = tiny collision margin
      sizeStops: (function (st) { return st.length ? st : [[6, 10], [11, 13], [16, 17]]; })(readLblStops())   // editable zoom→size stops (legacy size:[3] still read by labels.js)
    } : null;
    setStatus('Saving…');
    try {
      var cur = await db.from('layers').select('raw_config').eq('id', lid).single();
      var rc = (cur.data && cur.data.raw_config) || {};
      if (node.labels) rc.labels = node.labels; else delete rc.labels;
      var r2 = await db.from('layers').update({ raw_config: rc }).eq('id', lid);
      if (r2.error) throw new Error(r2.error.message);
      applyLabelLayers(node);
      // checkbox ticked BEFORE any feature data arrived (deferred/unhydrated layer) → the label layer
      // just built over ZERO anchors and looks dead. Priority-fetch this layer now and re-anchor when
      // it lands — the old behavior forced the user to toggle off/on or reload the page.
      if (node.labels && !labelFeaturesFor(node).length) {
        if (_drawLayerSlugs[node.id] && typeof _hydrateOne === 'function') _hydrateOne(lid);   // small layer: hydration completion already calls rebuildLabelsFor
        else if (node._deferred && typeof ConfigLoader !== 'undefined' && ConfigLoader.hydrateDeferredLayer)
          ConfigLoader.hydrateDeferredLayer(db, node, [beforeMap, typeof afterMap !== 'undefined' ? afterMap : null]).then(function () { try { applyLabelLayers(node); } catch (e2) {} });
      }
      setStatus('Saved');
    } catch (e) { console.warn('map labels failed', e); setStatus('Save failed'); }
  }
  // ── Timeline dates (7/15): column → Start/End mapping. See the elp-dates-sec template block. ──
  function parseLooseDate(v, isEnd) {   // "1877" → 1877-01-01 / 1877-12-31; ISO passes; anything Date can read → ISO; junk/0 → null
    if (v == null) return null;
    v = String(v).trim();
    if (!v || v === '0' || /^(none|null|n\/a)$/i.test(v)) return null;
    if (/^\d{3,4}$/.test(v)) { var y = ('0000' + v).slice(-4); return isEnd ? y + '-12-31' : y + '-01-01'; }
    if (/^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
    var d = new Date(v);
    return isNaN(d) ? null : d.toISOString().slice(0, 10);
  }
  var _dateSecGen = 0;
  async function fillDateSection(node) {   // populate the column picks from a 60-row sample; reveal only for layers with DB rows
    var sec = document.getElementById('elp-dates-sec'); if (!sec) return;
    sec.style.display = 'none';
    var gen = ++_dateSecGen;
    var lid = node && slugToLayerDbId[node.id];
    if (!lid && idsReady) { try { await idsReady; } catch (e) {} lid = node && slugToLayerDbId[node.id]; }   // early click during a heavy boot — ids may still be resolving
    if (!lid || gen !== _dateSecGen) return;
    try {
      var r = await db.from('features').select('custom_fields').eq('layer_id', lid).limit(60);
      if (gen !== _dateSecGen || r.error || !r.data || !r.data.length) return;   // stale pick / no rows → stay hidden
      var keys = [];
      r.data.forEach(function (row) { var cf = row.custom_fields; if (cf && typeof cf === 'object') Object.keys(cf).forEach(function (k) { if (keys.indexOf(k) < 0) keys.push(k); }); });
      keys = orderAttrKeys(keys, 40);
      ['elp-date-start-col', 'elp-date-end-col'].forEach(function (id2) {
        var sel = document.getElementById(id2); if (!sel) return;
        sel.innerHTML = '<option value="">— don\'t change —</option><option value="__fixed">⏱ One fixed date for all…</option>' +
          keys.map(function (k) { return '<option value="c:' + attrEsc(k) + '">' + attrEsc(k) + '</option>'; }).join('');
      });
      ['elp-date-start-fixed', 'elp-date-end-fixed'].forEach(function (id2) { var el2 = document.getElementById(id2); if (el2) el2.style.display = 'none'; });
      sec.style.display = '';
    } catch (e) {}
  }
  async function onApplyDates() {
    if (!activeLayerId) return;
    var node = findNodeById(layers, activeLayerId); if (!node) return;
    var lid = slugToLayerDbId[activeLayerId]; if (!lid) return;
    function pick(colId, fixId) {
      var sel = document.getElementById(colId), v = sel ? sel.value : '';
      if (v === '__fixed') { var f = document.getElementById(fixId); return (f && f.value) ? { fixed: f.value } : null; }
      if (v && v.slice(0, 2) === 'c:') return { col: v.slice(2) };
      return null;
    }
    var start = pick('elp-date-start-col', 'elp-date-start-fixed'), end = pick('elp-date-end-col', 'elp-date-end-fixed');
    if (!start && !end) { setStatus('Pick a column (or fixed date) first'); return; }
    var btn = document.getElementById('elp-dates-apply'); if (btn) btn.disabled = true;
    try {
      // pull every row's ids + current dates + fields (paged), with visible progress
      var rows = [], from9 = 0;
      for (;;) {
        msProgress('Reading features… ' + nfmt(rows.length));
        var r9 = await db.from('features').select('feature_id, start_date, end_date, custom_fields').eq('layer_id', lid).order('feature_id').range(from9, from9 + 999);
        if (r9.error) throw new Error(r9.error.message);
        Array.prototype.push.apply(rows, r9.data || []);
        if (!r9.data || r9.data.length < 1000) break;
        from9 += 1000;
      }
      if (!rows.length) { msProgress(''); setStatus('No features'); return; }
      // "there is data in the column — replace?" (kept simple: one confirm covering the fields being written)
      var clobber = [];
      if (start) { var ns = rows.filter(function (r) { return r.start_date != null; }).length; if (ns) clobber.push(nfmt(ns) + ' features already have a Start date'); }
      if (end) { var ne = rows.filter(function (r) { return r.end_date != null; }).length; if (ne) clobber.push(nfmt(ne) + ' features already have an End date'); }
      if (clobber.length && !window.confirm('There is data in the date column' + (clobber.length > 1 ? 's' : '') + ' (' + clobber.join('; ') + '). Are you sure you want to replace it?')) { msProgress(''); setStatus('Cancelled'); return; }
      // compute, then GROUP rows by their computed (start,end) pair — `features` is a VIEW, so
      // upsert/ON CONFLICT can't work through it ("no unique or exclusion constraint", 7/15).
      // Year data repeats heavily (~dozens of distinct values for 78k rows), so grouped UPDATEs
      // with .in(feature_id, …) need only a handful of requests.
      var upserts = [], parsed = 0, blank = 0, groups9 = {};
      rows.forEach(function (r) {
        var sv, ev, touched = false;
        if (start) { sv = start.fixed != null ? start.fixed : parseLooseDate(r.custom_fields && r.custom_fields[start.col], false); touched = true; if (sv) parsed++; else blank++; }
        if (end) { ev = end.fixed != null ? end.fixed : parseLooseDate(r.custom_fields && r.custom_fields[end.col], true); touched = true; if (ev) parsed++; else blank++; }
        if (!touched) return;
        var key9 = (start ? String(sv) : '·') + '|' + (end ? String(ev) : '·');
        (groups9[key9] = groups9[key9] || { s: sv, e: ev, ids: [] }).ids.push(r.feature_id);
        upserts.push(1);
      });
      var doneN = 0, keys9 = Object.keys(groups9);
      for (var g9 = 0; g9 < keys9.length; g9++) {
        var grp = groups9[keys9[g9]];
        var patch9 = {};
        if (start) patch9.start_date = grp.s != null ? grp.s : null;
        if (end) patch9.end_date = grp.e != null ? grp.e : null;
        for (var c9 = 0; c9 < grp.ids.length; c9 += 400) {
          var w9 = await db.from('features').update(patch9).in('feature_id', grp.ids.slice(c9, c9 + 400));
          if (w9.error) throw new Error(w9.error.message);
          doneN += Math.min(400, grp.ids.length - c9);
          msProgress('Setting dates… ' + nfmt(doneN) + '/' + nfmt(upserts.length) + ' (' + nfmt(keys9.length) + ' distinct values)');
        }
      }
      // rebuild `upserts` shape for the sync-below (feature_id → values)
      upserts = [];
      keys9.forEach(function (k9) { var grp2 = groups9[k9]; grp2.ids.forEach(function (fid2) { var u2 = { feature_id: fid2 }; if (start) u2.start_date = grp2.s != null ? grp2.s : null; if (end) u2.end_date = grp2.e != null ? grp2.e : null; upserts.push(u2); }); });
      // keep open copies in sync: the attribute table (if on this layer) + draw-side meta
      if (_attrSlug === activeLayerId && _attrRows.length) {
        var byId9 = {}; upserts.forEach(function (u) { byId9[String(u.feature_id)] = u; });
        _attrRows.forEach(function (r) { var u = byId9[String(r.feature_id)]; if (!u) return; if ('start_date' in u) r.start_date = u.start_date; if ('end_date' in u) r.end_date = u.end_date; });
        try { renderAttrBody(); } catch (e2) {}
      }
      msProgress('Dates set on ' + nfmt(upserts.length) + ' features' + (blank ? ' (' + nfmt(blank) + ' had no readable date — left empty)' : '') + '.');
      setStatus('Dates applied');
      if (node.source_type === 'vector-tiles-url' || (node.source && node.source.type !== 'geojson')) setTimeout(function () { msProgress('Tiled layer: hit Publish to bake the new dates into its tiles.'); }, 2500);
    } catch (e) { console.warn('apply dates failed', e); msProgress(''); setStatus('Dates failed: ' + e.message); }
    finally { if (btn) btn.disabled = false; }
  }
  // ── Opacity / Thickness by data column: the column's numeric value drives that feature's opacity or
  //    width/radius directly (like hex color columns for colour-by). Guarded expressions — to-number(null)
  //    is 0 and would zero every feature without a value.
  function numColExpr(prop, fallback) {
    var g = ['get', prop];
    return ['case',
      ['==', ['typeof', g], 'number'], g,
      ['all', ['==', ['typeof', g], 'string'], ['!=', g, '']], ['to-number', g, fallback],
      fallback];
  }
  function numByKeys(node, kind) {
    if (kind === 'opacity') return [node.type === 'fill' ? 'fill-opacity' : node.type === 'line' ? 'line-opacity' : 'circle-opacity'];
    return node.type === 'circle' ? ['circle-radius'] : ['line-width'];   // thickness: line width / point radius / fill outline width
  }
  function clearStyleMetaRC(lid2, key) {
    if (!lid2) return;
    db.from('layers').select('raw_config').eq('id', lid2).single().then(function (cur) {
      var rc = (cur.data && cur.data.raw_config) || {}; delete rc[key];
      return db.from('layers').update({ raw_config: rc }).eq('id', lid2);
    }).then(function () {}, function () {});
  }
  async function onStyleNumBy(kind, prop) {
    if (!activeLayerId) return;
    var node = findNodeById(layers, activeLayerId); if (!node) return;
    var lid = slugToLayerDbId[activeLayerId]; if (!lid) return;
    var metaKey = kind === 'opacity' ? 'opacityBy' : 'thicknessBy';
    var info = document.getElementById(kind === 'opacity' ? 'elp-opacityby-info' : 'elp-thickby-info');
    var pkeys = numByKeys(node, kind);
    var paint = JSON.parse(JSON.stringify(node.paint || {}));
    var fallback = kind === 'opacity'
      ? (paintOpacity(node.paint) != null ? paintOpacity(node.paint) : 1)
      : (node.type === 'circle'
        ? ((node.paint && typeof node.paint['circle-radius'] === 'number') ? node.paint['circle-radius'] : 5)
        : ((node.paint && typeof node.paint['line-width'] === 'number') ? node.paint['line-width'] : 2));
    setStatus('Saving…');
    try {
      if (!prop) { node[metaKey] = null; pkeys.forEach(function (k) { paint[k] = fallback; }); if (info) info.textContent = ''; }
      else {
        node[metaKey] = { prop: prop }; var ex = numColExpr(prop, fallback); pkeys.forEach(function (k) { paint[k] = ex; });
        // feedback like the multicolor strip: say what engaged and how many features actually carry a value
        var withVal = 0, total = 0;
        for (var off = 0; ; off += 1000) {
          var fr = await db.from('features').select('custom_fields').eq('layer_id', lid).order('feature_id').range(off, off + 999);
          if (fr.error || !fr.data || !fr.data.length) break;
          fr.data.forEach(function (f) { total++; var v = f.custom_fields ? f.custom_fields[prop] : null; if (v != null && String(v) !== '' && !isNaN(parseFloat(v))) withVal++; });
          if (fr.data.length < 1000) break;
        }
        if (info) info.textContent = withVal
          ? ('Per-feature ' + kind + ' from ' + prop + ' (' + withVal + ' of ' + total + ' features have a value; the slider is the fallback for the rest).')
          : ('No numeric values in ' + prop + ' yet — everything uses the slider until features get values.');
      }
      node.paint = paint;
      var cur = await db.from('layers').select('raw_config').eq('id', lid).single();
      var rc = (cur.data && cur.data.raw_config) || {};
      if (node[metaKey]) rc[metaKey] = node[metaKey]; else delete rc[metaKey];
      var r2 = await db.from('layers').update({ paint: paint, raw_config: rc }).eq('id', lid);
      if (r2.error) throw new Error(r2.error.message);
      [[beforeMap, '-left'], [typeof afterMap !== 'undefined' ? afterMap : null, '-right']].forEach(function (ms) {
        var m = ms[0]; if (!m) return;
        pkeys.forEach(function (k) {
          try { if (m.getLayer(node.id + ms[1])) m.setPaintProperty(node.id + ms[1], k, paint[k]); } catch (e) {}
          // a fill's line-* keys live on its stroke COMPANION layer — update it live too
          if (node.type === 'fill' && k.indexOf('line-') === 0) {
            try { var sid = node.id + '-stroke' + ms[1]; if (m.getLayer(sid)) m.setPaintProperty(sid, k, paint[k]); } catch (e) {}
          }
        });
      });
      await loadFeatures();
      setStatus('Saved');
    } catch (e) { console.warn('styleNumBy failed', e); setStatus('Save failed'); }
  }
  // ── Defaults: how the map OPENS (distinct from the session-only sidebar toggles). Layers →
  //    layers.enabled_by_default; groups → layer_groups.checked + every descendant layer's default;
  //    sections → raw_config.checked + descendants. Expanded → layer_groups.collapsed / sections raw_config.
  function descendantLayerIds(node, on) {
    var ids = [];
    (function walk(n) {
      (n.children || []).forEach(function (c) {
        if (c.type === 'group' || c.type === 'section') { walk(c); return; }
        if (on != null) c.checked = on;
        if (slugToLayerDbId[c.id]) ids.push(slugToLayerDbId[c.id]);
      });
    })(node);
    return ids;
  }
  async function onDefaultVisible(on) {
    if (!activeLayerId) return;
    var node = findNodeById(layers, activeLayerId); if (!node) return;
    node.checked = on;
    setStatus('Saving…');
    try {
      if (node.type === 'group') {
        if (node._dbId) await db.from('layer_groups').update({ checked: on }).eq('id', node._dbId);
        var gids = descendantLayerIds(node, on);
        if (gids.length) await db.from('layers').update({ enabled_by_default: on }).in('id', gids);
      } else if (node.type === 'section') {
        if (node._dbId) { var cur = await db.from('layer_sections').select('raw_config').eq('id', node._dbId).single(); var rc = (cur.data && cur.data.raw_config) || {}; rc.checked = on; await db.from('layer_sections').update({ raw_config: rc }).eq('id', node._dbId); }
        var sids = descendantLayerIds(node, on);
        if (sids.length) await db.from('layers').update({ enabled_by_default: on }).in('id', sids);
      } else {
        var lid = slugToLayerDbId[node.id];
        if (lid) await db.from('layers').update({ enabled_by_default: on }).eq('id', lid);
      }
      setStatus('Saved');
    } catch (e) { console.warn('default-visible save failed', e); setStatus('Save failed'); }
  }
  async function onDefaultExpanded(expanded) {
    if (!activeLayerId) return;
    var node = findNodeById(layers, activeLayerId); if (!node) return;
    node.collapsed = !expanded;
    setStatus('Saving…');
    try {
      if (node.type === 'group' && node._dbId) { var r = await db.from('layer_groups').update({ collapsed: !expanded }).eq('id', node._dbId); if (r.error) throw new Error(r.error.message); }
      else if (node.type === 'section' && node._dbId) { var cur2 = await db.from('layer_sections').select('raw_config').eq('id', node._dbId).single(); var rc2 = (cur2.data && cur2.data.raw_config) || {}; rc2.collapsed = !expanded; var r2 = await db.from('layer_sections').update({ raw_config: rc2 }).eq('id', node._dbId); if (r2.error) throw new Error(r2.error.message); }
      setStatus('Saved');
    } catch (e) { console.warn('default-expanded save failed', e); setStatus('Save failed'); }
  }
  function populateDefaults(node) {
    var row = document.getElementById('elp-defaults-row'); if (!row) return;
    row.style.display = 'block';
    var isContainer = node.type === 'group' || node.type === 'section';
    document.getElementById('elp-default-vis').checked = node.checked !== false;
    document.getElementById('elp-default-exp-label').style.display = isContainer ? 'block' : 'none';
    if (isContainer) document.getElementById('elp-default-exp').checked = !node.collapsed;
  }
  // ── Editor UI design system (7/8): ONE place to restyle the panels. Every recurring "type" of control
  //    (section heading, field label, checkbox, input/select, slider, button, note, divider…) is a class
  //    here instead of a repeated inline style — change a rule once and every instance updates together
  //    (which is exactly what dev-tools inline styles could NOT do). Values below MIRROR the old inline
  //    styles 1:1, so this is a pure refactor — appearance is byte-identical. To restyle: edit a rule here.
  //    Namespaced .ms-* so these apply to any editor panel that opts in (layer panel done first). ──
  function ensureEditorUiCss() {
    if (document.getElementById('ms-editor-ui-css')) return;
    var s = document.createElement('style');
    s.id = 'ms-editor-ui-css';
    s.textContent =
      '.ms-sec{font-size:25px;font-weight:800;letter-spacing:.07em;color:#7c5cbf;margin:0 0 8px;text-transform:uppercase;border-bottom:2px solid #ede9f7;padding-bottom:4px;text-align:center;}' +   // section heading
      '.ms-sectop{margin-top:16px;padding:10px 12px 12px;border:3px solid #e5e0f3;border-radius:10px;background:#fbfaff;box-shadow:0px 0px 3px 4px rgba(124,92,191,0.09);}' +   // each section = a delineated card (border + soft shadow + faint tint)
      '.ms-grp{margin-top:10px;padding-top:16px;padding-bottom:7px;border-top:2px solid #090909bf;}' +          // paired-control group divider
      '.ms-lbl{display:block;font-size:11px;color:#555555;margin-bottom:2px;}' +           // small field label above a control
      '.ms-check{display:block;cursor:pointer;font-size:12px;color:#555555;}' +            // checkbox + text row
      '.ms-in{width:100%;box-sizing:border-box;padding:5px 6px;border:1px solid #bbbbbb;border-radius:4px;font-size:12px;}' +  // text input / number / select
      'select.ms-in{padding-right:20px;text-overflow:ellipsis;white-space:nowrap;overflow:hidden;}' +  // long option text must STOP at the dropdown arrow, not run under it
      '.ms-range{width:100%;box-sizing:border-box;}' +                                     // slider
      '.ms-color{width:100%;box-sizing:border-box;padding:1px;border:1px solid #bbbbbb;border-radius:4px;cursor:pointer;}' +   // color swatch (height set inline — it varies)
      '.ms-btn{width:100%;padding:6px;border:1px solid #bbbbbb;border-radius:4px;background:#f2f2f2;color:#222222;cursor:pointer;font-size:12px;}' +   // secondary/action button
      '.ms-btn:hover{background:#e8e8e8;}' +
      '.ms-btn-danger{width:100%;padding:6px;border:1px solid #e0b4b4;border-radius:4px;background:#fdeaea;color:#b4453a;cursor:pointer;font-size:12px;}' +   // destructive button
      '.ms-note{font-size:10px;color:#888888;margin-top:3px;}' +                           // gray hint text
      '.ms-note-accent{font-size:10px;color:#7a5cc2;margin-top:2px;}' +                     // purple hint text
      // layer names STOP at the row buttons — no wrap, no running under the icons (full name = hover tooltip)
      '#layers-panel-content .layer-list-row{white-space:nowrap;}' +
      '#layers-panel-content .layer-list-row label{display:inline-block;max-width:calc(100% - 92px);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:middle;}' +
      '#elp-close:hover{background:#e9e5f5;border-color:#c9c2e2;color:#3d3857;}';           // sticky-header Close button hover';
    document.head.appendChild(s);
  }
  function injectLayerPanel() {
    if (document.getElementById('editor-layer-panel')) return;
    ensureEditorUiCss();
    var p = document.createElement('div');
    p.id = 'editor-layer-panel';
    p.style.cssText = 'position:fixed;top:120px;left:362px;width:236px;max-height:calc(100vh - 230px);overflow-y:auto;overflow-x:hidden;background: #f8f8f8;border:1px solid #bbbbbb;border-radius:8px;box-shadow:0 3px 14px rgba(0,0,0,0.2);padding:0;font-size:13px;z-index:1000;display:none;font-family:Source Sans Pro,Arial,sans-serif;';  // padding moved to the sticky header + scrolling body; scroll + stay above the timeline (#footer is 67px)
    var SEC = function (t) { return '<div class="ms-sec">' + t + '</div>'; };   // section heading (was inline; now .ms-sec)
    var SECTOP = 'ms-sectop';   // section-top spacing — now a CLASS name, used as class="…"
    var GRP = 'ms-grp';         // paired-control group divider — now a CLASS name
    p.innerHTML =
      // sticky header: the layer name + a clear Close button stay pinned at the top while the body scrolls.
      '<div id="elp-header" style="position:sticky;top:0;z-index:5;padding:10px 12px;background:#ffffff;border-bottom:1px solid #e2e0ea;border-radius:8px 8px 0 0;">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;"><b id="elp-title" style="font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">Layer style</b>' +
        '<button id="elp-close" title="Close this panel" style="flex:0 0 auto;display:inline-flex;align-items:center;gap:4px;padding:3px 9px 3px 7px;border:1px solid #d7d3e4;border-radius:6px;background:#f4f2fa;color:#544f6e;font:600 12px Source Sans Pro,Arial,sans-serif;cursor:pointer;line-height:1;"><span style="font-size:15px;line-height:1;">&times;</span> Close</button></div>' +
      '</div>' +
      '<div id="elp-body" style="padding:12px;">' +
      // name field at the very top — the same rename as double-clicking the row (works for layers, groups and sections)
      '<input id="elp-name" type="text" placeholder="Name" title="Rename this item" style="width:100%;box-sizing:border-box;margin-bottom:4px;padding:6px 8px;border:1px solid #bbbbbb;border-radius:4px;font-size:15px;font-weight:600;" />' +
      '<div id="elp-kind" class="ms-note-accent" style="display:none;margin:0 0 8px;font-size:11px;"></div>' +   // what IS this layer — tileset vs drawn/imported
      // ── on-by-default + delete live AT THE TOP (below the title), no section heading — 7/8 layout pass ──
      '<div id="elp-defaults-row">' +
        '<label id="elp-default-vis-label" class="ms-check" style="margin-bottom:3px;"><input id="elp-default-vis" type="checkbox" style="vertical-align:middle;margin:0 5px 0 0;" />On by default</label>' +
        '<label id="elp-default-exp-label" class="ms-check" style="display:none;"><input id="elp-default-exp" type="checkbox" style="vertical-align:middle;margin:0 5px 0 0;" />Expanded by default</label>' +
      '</div>' +
      '<div id="elp-delete-wrap" style="margin:6px 0 2px;">' +
        '<button id="elp-delete" class="ms-btn-danger">Delete</button>' +
        '<div id="elp-delete-confirm" style="display:none;padding:8px;border:1px solid #e0b4b4;border-radius:4px;background:#fdf3f3;">' +
          '<div style="font-size:12px;color:#7a2e27;font-weight:600;">Are you sure you want to delete this?</div>' +
          '<div id="elp-delete-note" class="ms-note" style="margin-top:2px;color:#a05b54;"></div>' +
          '<div style="display:flex;gap:6px;margin-top:7px;">' +
            '<button id="elp-del-yes" style="flex:1;padding:5px;border:none;border-radius:4px;background:#b4453a;color:#fff;font-weight:700;cursor:pointer;font-size:12px;">Yes</button>' +
            '<button id="elp-del-no" style="flex:1;padding:5px;border:1px solid #bbbbbb;border-radius:4px;background:#fff;color:#333;font-weight:600;cursor:pointer;font-size:12px;">No</button>' +
          '</div>' +
        '</div>' +
      '</div>' +
      // ══ ORDER (7/8 layout pass 2): Labels → Popups → Style(Color/Fill/Outline) → Zoom → Source → Layer info ══
      // Inline styles replaced by .ms-* classes (see ensureEditorUiCss) — one rule restyles every instance.
      // ── LABELS (drawn/imported layers only) — the label toggle + all its styling live together ──
      '<div id="elp-labels-sec" class="' + SECTOP + '">' +
      SEC('Labels') +
      '<label id="elp-maplabels-row" class="ms-check" style="display:none;"><input id="elp-maplabels-on" type="checkbox" style="vertical-align:middle;margin:0 5px 0 0;" />Map labels</label>' +
      '<a id="elp-lbl-help" href="#" style="display:none;font-size:10.5px;color:#7c5cbf;text-decoration:none;margin:10px 0;">🎓 Labels are hard — how they work</a>' +
      '<div id="elp-maplabels-field-row" style="display:none;margin-top:4px;">' +
        '<label class="ms-lbl">Labels show this column</label>' +
        '<select id="elp-maplabels-field" class="ms-in"></select>' +
        '<div style="display:flex;gap:8px;margin-top:6px;">' +
          '<div style="flex:1;"><label class="ms-lbl">Text color</label>' +
          '<input id="elp-lbl-color" type="color" value="#000000" class="ms-color" style="height:24px;padding:0;" /></div>' +
          '<div style="flex:1;"><label class="ms-lbl">Halo color</label>' +
          '<input id="elp-lbl-halo" type="color" value="#ffffff" class="ms-color" style="height:24px;padding:0;" /></div>' +
        '</div>' +
        '<label class="ms-check" style="margin:6px 0 0;"><input id="elp-lbl-bold" type="checkbox" checked style="vertical-align:middle;margin:0 5px 0 0;" />Bold</label>' +
        // zoom-size stops render dynamically (renderLblStops): a row per stop with a ⌖ jump-to-zoom
        // button, plus "+ Add zoom level". ALWAYS the ramp — the uniform-size input and the
        // vary-by-zoom checkbox were removed 7/15 (a single stop covers the constant case)
        '<label class="ms-lbl" style="margin-top:8px;">Size by zoom</label>' +
        '<div id="elp-lbl-zoomsizes" style="margin-top:2px;"></div>' +
        '<label class="ms-lbl" style="margin-top:6px;">Halo width <span id="elp-lbl-halow-val">2</span></label>' +
        '<input id="elp-lbl-halow" type="range" min="0" max="4" step="0.5" value="2" class="ms-range" />' +
        '<label class="ms-lbl" style="margin-top:6px;">Label density</label>' +
        '<input id="elp-lbl-density" type="range" min="0" max="60" step="2" value="50" class="ms-range" />' +
        '<div style="display:flex;justify-content:space-between;font-size:9px;color:#888888;"><span>fewer</span><span>more</span></div>' +
        '<div class="ms-note">Polygons label at their visual center; lines along the path. Density = breathing room per label — fewer means only labels with room draw.</div>' +
      '</div>' +
      '</div>' +
      // ── TIMELINE DATES (7/15): map a data column (or one fixed date) into every feature's
      //    Start/End — the fields the bottom timeline slider filters on. Shown when the layer has
      //    DB rows (drawn/imported AND converted-tileset layers); columns come from a row sample.
      '<div id="elp-dates-sec" class="' + SECTOP + '" style="display:none;">' +
      SEC('Timeline dates') +
      '<label class="ms-lbl">Start date from</label>' +
      '<select id="elp-date-start-col" class="ms-in"><option value="">— don\'t change —</option><option value="__fixed">⏱ One fixed date for all…</option></select>' +
      '<input id="elp-date-start-fixed" type="date" class="ms-in" style="display:none;margin-top:3px;" />' +
      '<label class="ms-lbl" style="margin-top:6px;">End date from</label>' +
      '<select id="elp-date-end-col" class="ms-in"><option value="">— don\'t change —</option><option value="__fixed">⏱ One fixed date for all…</option></select>' +
      '<input id="elp-date-end-fixed" type="date" class="ms-in" style="display:none;margin-top:3px;" />' +
      '<button id="elp-dates-apply" class="ms-btn" style="margin-top:8px;">Apply to all features</button>' +
      '<div class="ms-note">Fills each feature\'s <b>Start/End</b> (what the timeline slider filters on) from a data column — or one fixed date for every feature. Years like "1877" become 1877-01-01 for starts and 1877-12-31 for ends.</div>' +
      '</div>' +
      // ── POPUPS & INFO ──
      '<div id="elp-interact-row" class="' + SECTOP + '">' +
        SEC('Popups &amp; info') +
        '<label class="ms-check" style="margin-bottom:3px;"><input id="elp-hover" type="checkbox" style="vertical-align:middle;margin:0 5px 0 0;" />Popup on hover</label>' +
        '<label class="ms-check" style="margin-bottom:6px;"><input id="elp-click" type="checkbox" style="vertical-align:middle;margin:0 5px 0 0;" />Popup on click</label>' +
        '<label id="elp-hl-label" class="ms-check" style="display:none;margin-bottom:6px;"><input id="elp-hl" type="checkbox" style="vertical-align:middle;margin:0 5px 0 0;" />Highlight on hover</label>' +
        '<label class="ms-lbl">Label field (what the popup shows)</label>' +
        '<select id="elp-labelfield" class="ms-in"><option value="label">label (the feature\'s own Label)</option></select>' +
      '<div id="elp-groupby-row" style="display:none;margin-top:8px;"><label class="ms-lbl">Treat as one (highlight group)</label>' +
      '<select id="elp-groupby" class="ms-in"><option value="">— off (each feature on its own) —</option></select>' +
      '<div class="ms-note">Click any piece → <b>everything sharing this column\'s value lights up together</b> — e.g. a railroad stored as many segments highlights as ONE line. The data stays in pieces; only the experience is unified.</div></div>' +
      // panel-row + enc-row live INSIDE the Popups & info card (they're the info-panel + encyclopedia settings)
      '<div id="elp-panel-row" style="margin-top:8px;"><label class="ms-lbl">Info panel (on feature click)</label>' +
      '<select id="elp-panel-mode" class="ms-in"><option value="notes">Title + notes</option><option value="drupal">Drupal / encyclopedia</option><option value="both">Both</option></select></div>' +
      '<div id="elp-enc-row" style="margin-top:8px;"><label class="ms-lbl">Encyclopedia base URL</label>' +
      '<input id="elp-encurl" type="text" placeholder="https://…/encyclopedia" class="ms-in" />' +
      '<div id="elp-nidprop-row" style="display:none;margin-top:6px;"><label class="ms-lbl">Page-ID property</label>' +
      '<input id="elp-nidprop" type="text" placeholder="e.g. nid" class="ms-in" />' +
      '<div class="ms-note">For tilesets: which feature property holds the page id (drawn layers always use &ldquo;content_id&rdquo;).</div></div>' +
      '<div class="ms-note">Set this, then give each feature a Page ID — clicking a feature opens its page.</div></div>' +
      '</div>' +   // close elp-interact-row (the Popups & info card now wraps popups + info-panel + encyclopedia)
      // ── STYLE: Color, then Fill, then Outline (paired groups) ──
      '<div id="elp-style-section" class="' + SECTOP + '">' +
      SEC('Style') +
      '<div id="elp-color-row"><label class="ms-lbl">Color</label>' +
      '<input id="elp-color" type="color" class="ms-color" style="height:30px;margin-bottom:8px;" /></div>' +
      // colour-by active → the single swatch is replaced by this strip (a solid swatch would lie)
      '<div id="elp-multicolor-strip" style="display:none;height:30px;box-sizing:border-box;margin-bottom:8px;border:1px solid #bbbbbb;border-radius:4px;background:linear-gradient(90deg,#e6194b,#f58231,#ffe119,#3cb44b,#4363d8,#911eb4);align-items:center;justify-content:center;">' +
        '<span style="font-size:11px;font-weight:700;color:#fff;text-shadow:0 1px 2px rgba(0,0,0,0.6);">Multiple colors — by column</span>' +
      '</div>' +
      '<div id="elp-colorby-row" style="margin:0 0 8px;display:none;">' +
        '<label class="ms-lbl">Color by data column</label>' +
        '<select id="elp-colorby" class="ms-in"><option value="">Single color</option></select>' +
        '<div id="elp-colorby-info" class="ms-note"></div>' +
      '</div>' +
      // ── FILL group: everything about the face of the feature, paired (7/8 layout pass) ──
      '<div class="' + GRP + '">' +
      '<label id="elp-fill-vis-row" class="ms-check" style="display:none;margin-bottom:4px;"><input id="elp-fill-vis" type="checkbox" style="vertical-align:middle;margin:0 3px 0 0;" />Show fill</label>' +
      '<label class="ms-lbl">Opacity <span id="elp-opacity-val"></span></label>' +
      '<input id="elp-opacity" type="range" min="0" max="1" step="0.05" class="ms-range" />' +
      '<div id="elp-opacityby-row" style="margin-top:4px;display:none;">' +
        '<label class="ms-lbl" style="margin-top:2px;">Opacity by data column</label>' +
        '<select id="elp-opacityby" class="ms-in"><option value="">Single opacity (slider above)</option></select>' +
        '<div id="elp-opacityby-info" class="ms-note-accent"></div>' +
      '</div>' +
      '<div id="elp-radius-row" style="margin-top:8px;"><label class="ms-lbl">Radius <span id="elp-radius-val"></span></label>' +
      '<input id="elp-radius" type="range" min="1" max="30" step="1" class="ms-range" /></div>' +
      '</div>' +
      // ── OUTLINE group: the stroke's toggle, color, width and per-column thickness together ──
      '<div class="' + GRP + '">' +
      '<label id="elp-outline-vis-row" class="ms-check" style="display:none;margin-bottom:4px;"><input id="elp-outline-vis" type="checkbox" style="vertical-align:middle;margin:0 3px 0 0;" />Show outline</label>' +
      '<div id="elp-outline-row"><label class="ms-lbl">Outline color</label>' +
      '<input id="elp-outline" type="color" class="ms-color" style="height:28px;" /></div>' +
      '<div id="elp-width-row" style="margin-top:6px;"><label class="ms-lbl"><span id="elp-width-label">Width</span> <span id="elp-width-val"></span></label>' +
      '<input id="elp-width" type="range" min="0.5" max="12" step="0.5" class="ms-range" /></div>' +
      '<div id="elp-thickby-row" style="margin-top:4px;display:none;">' +
        '<label class="ms-lbl" style="margin-top:2px;">Thickness by data column</label>' +
        '<select id="elp-thickby" class="ms-in"><option value="">Single thickness (slider above)</option></select>' +
        '<div id="elp-thickby-info" class="ms-note-accent"></div>' +
      '</div>' +
      '<button id="elp-split" class="ms-btn" style="margin-top:8px;">Split outline into its own layer</button>' +
      '</div>' +
      '</div>' +
      // ── ZOOM ──
      '<div id="elp-zoom-sec" class="' + SECTOP + '">' +
      SEC('Zoom') +
      '<button id="elp-setzoom" class="ms-btn">◎ Set zoom to current view</button>' +
      '<button id="elp-zoomextent" class="ms-btn" style="margin-top:6px;">⤢ Zoom to features’ extent</button>' +
      '<div id="elp-zoom-info" class="ms-note" style="font-size:11px;margin-top:4px;text-align:center;">Zoom target: not set</div>' +
      '<label class="ms-check" style="display:block;margin-top:8px;"><input id="elp-zoombtn" type="checkbox" style="vertical-align:middle;margin:0 5px 0 0;" />Zoom button (&#8982;) on the layer row</label>' +
      '</div>' +
      // ── SOURCE (tilesets only) ──
      '<div id="elp-src-row" class="' + SECTOP + '" style="display:none;">' +
        SEC('Source') +
        '<input id="elp-src-url" type="text" placeholder="mapbox://user.id  or  https://…/{z}/{x}/{y}.pbf" class="ms-in" style="margin-bottom:5px;" />' +
        '<input id="elp-src-sl" type="text" placeholder="source layer (e.g. buildings)" class="ms-in" style="margin-bottom:5px;" />' +
        '<div id="elp-src-zooms" style="display:none;margin-bottom:5px;"><input id="elp-src-minz" type="number" placeholder="min zoom" class="ms-in" style="width:48%;" /> <input id="elp-src-maxz" type="number" placeholder="max zoom" class="ms-in" style="width:48%;" /></div>' +
        '<div id="elp-src-info" class="ms-note" style="margin-top:0;margin-bottom:5px;"></div>' +
        '<button id="elp-src-apply" class="ms-btn" style="background:#e8e8e8;">Apply source</button>' +
      '</div>' +
      // ── LAYER INFO: edit the ℹ popup's content here; own section at the BOTTOM (7/9) ──
      '<div class="' + SECTOP + '">' +
        SEC('Layer info') +
        '<button id="elp-info" class="ms-btn" style="padding:7px;font-weight:600;">&#9432; Edit&hellip; <span style="font-weight:400;color:#888;">(adds the &#9432; button when filled)</span></button>' +
      '</div>' +
      '</div>';   // close #elp-body (the scrolling region under the sticky header)
    document.body.appendChild(p);
    document.getElementById('elp-close').addEventListener('click', hideLayerPanel);
    document.getElementById('elp-name').addEventListener('change', function () { if (activeLayerId) commitRename(activeLayerId, this.value); });
    // Delete → in-panel Yes/No confirm (never a browser dialog)
    function elpDelReset() { var c = document.getElementById('elp-delete-confirm'), b = document.getElementById('elp-delete'); if (c) c.style.display = 'none'; if (b) b.style.display = 'block'; }
    window._elpDelReset = elpDelReset;   // showLayerPanel resets the confirm when switching items
    document.getElementById('elp-delete').addEventListener('click', function () {
      if (!activeLayerId) return;
      var n = findNodeById(layers, activeLayerId);
      var kids = n && (n.type === 'group' || n.type === 'section') && n.children && n.children.length;
      var note = document.getElementById('elp-delete-note'); if (note) note.textContent = kids ? 'Its contents move out — they are NOT deleted.' : '';
      this.style.display = 'none';
      var c = document.getElementById('elp-delete-confirm'); if (c) c.style.display = 'block';
    });
    document.getElementById('elp-del-no').addEventListener('click', elpDelReset);
    document.getElementById('elp-del-yes').addEventListener('click', function () { elpDelReset(); if (activeLayerId) onDelete(activeLayerId, true); });
    document.getElementById('elp-default-vis').addEventListener('change', function () { onDefaultVisible(this.checked); });
    document.getElementById('elp-default-exp').addEventListener('change', function () { onDefaultExpanded(this.checked); });
    document.getElementById('elp-color').addEventListener('input', function () { onLayerStyle('color', this.value); });
    document.getElementById('elp-colorby').addEventListener('change', function () { onColorBy(this.value); });
    document.getElementById('elp-opacityby').addEventListener('change', function () { onStyleNumBy('opacity', this.value); });
    document.getElementById('elp-thickby').addEventListener('change', function () { onStyleNumBy('thickness', this.value); });
    document.getElementById('elp-maplabels-on').addEventListener('change', onMapLabelsChange);
    document.getElementById('elp-maplabels-field').addEventListener('change', onMapLabelsChange);
    ['elp-lbl-color', 'elp-lbl-halo', 'elp-lbl-bold', 'elp-lbl-density'].forEach(function (id2) { document.getElementById(id2).addEventListener('change', onMapLabelsChange); });
    document.getElementById('elp-lbl-zoomsizes').addEventListener('change', onMapLabelsChange);   // delegated: stop rows are dynamic (renderLblStops)
    document.getElementById('elp-lbl-help').addEventListener('click', function (e) { e.preventDefault(); openLabelsHelp(); });
    // timeline dates: "Fixed date…" picks reveal their date input; Apply runs the bulk mapping
    [['elp-date-start-col', 'elp-date-start-fixed'], ['elp-date-end-col', 'elp-date-end-fixed']].forEach(function (pr9) {
      document.getElementById(pr9[0]).addEventListener('change', function () { var f9 = document.getElementById(pr9[1]); if (f9) f9.style.display = this.value === '__fixed' ? '' : 'none'; });
    });
    document.getElementById('elp-dates-apply').addEventListener('click', onApplyDates);
    document.getElementById('elp-lbl-halow').addEventListener('input', function () { var v = document.getElementById('elp-lbl-halow-val'); if (v) v.textContent = this.value; });
    document.getElementById('elp-lbl-halow').addEventListener('change', onMapLabelsChange);
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
    document.getElementById('elp-info').addEventListener('click', onLayerInfoEdit);
    document.getElementById('elp-setzoom').addEventListener('click', function () { if (activeLayerId) onSetZoom(activeLayerId); });   // set-zoom moved here from the layer row
    document.getElementById('elp-zoomextent').addEventListener('click', onZoomExtent);
    document.getElementById('elp-zoombtn').addEventListener('change', function () { onZoomBtnToggle(this.checked); });
    document.getElementById('elp-encurl').addEventListener('change', function () { onEncUrl(this.value); });
    document.getElementById('elp-nidprop').addEventListener('change', function () { onNidProp(this.value); });
    document.getElementById('elp-panel-mode').addEventListener('change', function () { onPanelMode(this.value); });
    document.getElementById('elp-src-apply').addEventListener('click', onApplySource);
    document.getElementById('elp-src-url').addEventListener('input', function () { document.getElementById('elp-src-zooms').style.display = (this.value.trim().indexOf('mapbox://') === 0) ? 'none' : 'block'; });
    document.getElementById('elp-hover').addEventListener('change', onInteraction);
    document.getElementById('elp-click').addEventListener('change', onInteraction);
    document.getElementById('elp-hl').addEventListener('change', onInteraction);
    document.getElementById('elp-labelfield').addEventListener('change', onInteraction);
    document.getElementById('elp-groupby').addEventListener('change', function () { onGroupBy(this.value); });
  }
  // Per-layer hover/click popup toggles + which property the popup shows. The engine wires hover/click
  // only for layers that have a popupStyle (the CSS bubble class), so "Popup on hover" maps to setting it.
  async function onInteraction() {
    if (!activeLayerId) return;
    var node = findNodeById(layers, activeLayerId); if (!node) return;
    var lid = slugToLayerDbId[activeLayerId]; if (!lid) return;
    var hover = document.getElementById('elp-hover').checked;
    var click = document.getElementById('elp-click').checked;
    var hl = document.getElementById('elp-hl').checked;
    var labelField = (document.getElementById('elp-labelfield').value || '').trim() || 'label';
    var popupStyle = hover ? (node._popupStyle || node.popupStyle || 'infoLayerGreenPopUp') : null;
    // #12: LIVE — the engine handlers read config at event time now (eventsHandle.js), so mutating the node
    // applies immediately; wireLayerInteraction hooks up layers that had no interaction at page load.
    node._uiHover = hover; node._uiClick = click; node._uiLabel = labelField; if (popupStyle) node._popupStyle = popupStyle;
    node.popupStyle = popupStyle;
    node.click = click;
    node.prop = labelField;
    node.hoverHighlight = hl;
    if ((hover || click || hl) && typeof window.wireLayerInteraction === 'function') { try { window.wireLayerInteraction(node); } catch (e) {} }
    setStatus('Saving…');
    try { var r = await db.from('layers').update({ popup_style: popupStyle, popup_prop: labelField, click: click, hover: hl }).eq('id', lid); if (r.error) throw new Error(r.error.message); setStatus('Saved'); }
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
    try { if (window._elpDelReset) window._elpDelReset(); } catch (e) {}   // switching items collapses a half-open delete confirm
    var elpName = document.getElementById('elp-name'); if (elpName) elpName.value = node.label || '';   // top name field — all node types
    if (node.type === 'section') {   // #4: sections get a minimal panel — title + defaults + Delete (no style/zoom)
      document.getElementById('elp-title').textContent = node.label || 'Section';
      document.getElementById('elp-style-section').style.display = 'none';
      ['elp-labels-sec', 'elp-interact-row', 'elp-enc-row', 'elp-src-row', 'elp-panel-row', 'elp-zoom-sec'].forEach(function (eid) { var el = document.getElementById(eid); if (el) el.style.display = 'none'; });
      populateDefaults(node);
      p.style.display = 'block';
      return;
    }
    var isGroup = node.type === 'group';
    if (isGroup) {   // groups have no style — show only the zoom controls + readout
      document.getElementById('elp-title').textContent = node.label || 'Group';
      document.getElementById('elp-style-section').style.display = 'none';
      ['elp-labels-sec', 'elp-interact-row', 'elp-enc-row', 'elp-src-row'].forEach(function (eid) { var el = document.getElementById(eid); if (el) el.style.display = 'none'; });
      document.getElementById('elp-zoom-sec').style.display = 'block';
      document.getElementById('elp-setzoom').style.display = 'block';
      document.getElementById('elp-zoom-info').style.display = 'block';
      document.getElementById('elp-zoom-info').textContent = fmtNodeZoom(node);
      populateDefaults(node);
      p.style.display = 'block';
      return;
    }
    var isStyleableLayer = isGeojson || (isTilesetNode(node) && ['fill', 'line', 'circle'].indexOf(node.type) > -1);
    document.getElementById('elp-style-section').style.display = isStyleableLayer ? '' : 'none';   // typeless/basemap tilesets: hide style, keep attr + source + zoom
    document.getElementById('elp-interact-row').style.display = isStyleableLayer ? '' : 'none';
    var labelsCapable = isGeojson || (isTilesetNode(node) && node.type === 'line');   // tileset LINE labels ride the vector source (labels.js 7/16); points/polygons still need geojson anchors
    document.getElementById('elp-labels-sec').style.display = labelsCapable ? '' : 'none';
    fillDateSection(node);   // Timeline dates: async sample reveals the section for any layer with DB rows (incl. converted tilesets)
    document.getElementById('elp-zoom-info').textContent = fmtNodeZoom(node);
    var color = (node.iconColor && /^#[0-9a-fA-F]{6}$/.test(node.iconColor)) ? node.iconColor : '#3bb2d0';
    var op = paintOpacity(node.paint); if (op == null) op = (node.type === 'fill') ? 0.35 : 1;
    var outline = paintOutline(node.paint) || (node.type === 'fill' ? color : '#000000');
    document.getElementById('elp-title').textContent = node.label || 'Layer style';
    // what IS this layer? (user 7/15: the panel must say tileset vs drawn/GIS)
    var kindEl = document.getElementById('elp-kind');
    if (kindEl) {
      var kt = '';
      var tiles0 = (node.source && node.source.tiles && node.source.tiles[0]) || node.source_url || '';
      if (node.source_type === 'geojson-supabase') kt = '✏️ Drawn / imported layer — editable features';
      else if (node.pmtiles || tiles0.indexOf('/pmt/') > -1 || /^pmt\//.test(tiles0)) kt = '🧩 Tileset — auto-generated from your data (re-bakes on Publish)';
      else if (isTilesetNode(node)) kt = '🧩 Vector tileset — external source';
      kindEl.textContent = kt; kindEl.style.display = kt ? 'block' : 'none';
    }
    document.getElementById('elp-color').value = color;
    populateColorBy(node);   // "Color by data column" — drawn layers only (hidden otherwise)
    populateDefaults(node);  // "On by default" (expanded-by-default is container-only)
    document.getElementById('elp-opacity').value = op;
    document.getElementById('elp-opacity-val').textContent = op;
    document.getElementById('elp-outline').value = /^#[0-9a-fA-F]{6}$/.test(outline) ? outline : '#000000';
    document.getElementById('elp-outline-row').style.display = (node.type === 'line' || node.outlineSplit) ? 'none' : 'block';  // lines + split polygons have no separate outline here
    var strokeVis = (node.paint && node.paint['line-opacity'] != null) ? node.paint['line-opacity'] : 1;
    document.getElementById('elp-fill-vis').checked = op > 0;
    document.getElementById('elp-outline-vis').checked = strokeVis !== 0;
    var visOn = (fillStroke && !node.outlineSplit) ? 'block' : 'none';   // fill + outline toggles ride the real stroke line layer — each lives with its own group now
    document.getElementById('elp-fill-vis-row').style.display = visOn;
    document.getElementById('elp-outline-vis-row').style.display = visOn;
    var splitBtn = document.getElementById('elp-split');   // doubles as split / merge (un-split)
    if (node.outlineOf) { splitBtn.textContent = 'Merge into polygon'; splitBtn.style.display = 'block'; }
    else if (fillStroke) { splitBtn.textContent = node.outlineSplit ? 'Merge outline back in' : 'Split outline into its own layer'; splitBtn.style.display = 'block'; }
    else { splitBtn.style.display = 'none'; }
    var width = paintWidth(node.paint); if (width == null) width = (node.type === 'circle') ? 1.5 : (node.type === 'fill' ? 0.5 : 2);   // fills: 0.5 border default
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
    document.getElementById('elp-info').style.display = 'block';
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
    document.getElementById('elp-hl').checked = node.hoverHighlight !== false;
    document.getElementById('elp-zoombtn').checked = node.zoomBtn !== false;   // per-row ⌖ toggle — default on
    document.getElementById('elp-hl-label').style.display = node.highlight ? 'block' : 'none';   // hover-highlight toggle only where a highlight exists
    (function () {   // label-field is a SELECT now — make sure the saved value exists as an option before setting it
      var lf = document.getElementById('elp-labelfield');
      var want = (node._uiLabel != null) ? node._uiLabel : (node.prop || 'label');
      if (!Array.prototype.some.call(lf.options, function (o) { return o.value === want; })) { var o = document.createElement('option'); o.value = want; o.textContent = want; lf.appendChild(o); }
      lf.value = want;
    })();
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
      '#editor-attr-panel{pointer-events:auto;position:absolute;left:540px;top:134px;width:min(820px,70vw);height:60vh;min-width:340px;min-height:180px;max-width:96vw;max-height:84vh;background:#fff;border:2px solid #666666;border-radius:2px;box-shadow:0px 0px 5px 3px rgb(0 0 0);display:flex;flex-direction:column;overflow:hidden;}' +   // top:134 clears the map-tools bar (top 92–127) so undo/redo stay reachable
      // custom resize: right edge, bottom edge, and a PROMINENT bottom-right grip
      '#attr-rz-r{position:absolute;top:0;right:0;width:7px;height:100%;cursor:ew-resize;z-index:6;}' +
      '#attr-rz-b{position:absolute;left:0;bottom:0;height:7px;width:100%;cursor:ns-resize;z-index:6;}' +
      '#attr-rz-r:hover,#attr-rz-b:hover{background:rgba(206,92,0,0.35);}' +
      '#attr-rz-c{position:absolute;right:0;bottom:0;width:20px;height:20px;cursor:nwse-resize;z-index:7;background:linear-gradient(135deg,transparent 50%,#9a9a9a 50%,#9a9a9a 57%,transparent 57%,transparent 64%,#9a9a9a 64%,#9a9a9a 71%,transparent 71%,transparent 78%,#9a9a9a 78%,#9a9a9a 85%,transparent 85%);}' +
      '#attr-rz-c:hover{background:linear-gradient(135deg,transparent 50%,#ce5c00 50%,#ce5c00 57%,transparent 57%,transparent 64%,#ce5c00 64%,#ce5c00 71%,transparent 71%,transparent 78%,#ce5c00 78%,#ce5c00 85%,transparent 85%);}' +
      '#editor-attr-head{display:flex;justify-content:space-between;align-items:center;padding:10px 14px;border-bottom:1px solid #cccccc;font-size:15px;color:#2b3a4a;cursor:move;}' +   // header doubles as the drag handle (move the panel off the map)
      '#editor-attr-head .attr-head-l{display:flex;align-items:center;gap:10px;min-width:0;}' +
      '#editor-attr-title{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}' +
      '#editor-attr-zoom,#editor-attr-transfer{font-size:12px;padding:3px 9px;border:1px solid #bbbbbb;border-radius:4px;background:#f2f2f2;cursor:pointer;white-space:nowrap;}' +
      '#editor-attr-zoom:disabled{opacity:0.45;cursor:default;}' +
      '#editor-attr-del{font-size:12px;padding:3px 9px;border:1px solid #e0b4b4;border-radius:4px;background:#fdeaea;color:#b4453a;cursor:pointer;white-space:nowrap;}' +
      '#editor-attr-del:disabled{opacity:0.45;cursor:default;}' +
      '#editor-attr-close{cursor:pointer;color:#333333;font-size:20px;font-weight:700;line-height:1;padding:3px 10px;border:1px solid #bbbbbb;border-radius:3px;background:#f2f2f2;}' +
      '#editor-attr-close:hover{background:#fdeaea;color:#b4453a;border-color:#e0b4b4;}' +
      '#editor-attr-wrap{overflow:auto;flex:1;}' +
      '#editor-attr-table{border-collapse:separate;border-spacing:0;font-size:13px;table-layout:fixed;}' +   // separate: border-collapse breaks position:sticky LEFT on cells (pinned columns)   // fixed = column widths are honored exactly (so resize works); JS sets the table width = sum of columns
      '#editor-attr-table th{box-sizing:border-box;position:sticky;top:0;background:#f2f2f2;text-align:left;padding:8px 18px 8px 10px;border-bottom:1px solid #cccccc;color:#555555;font-weight:600;white-space:nowrap;cursor:pointer;user-select:none;overflow:hidden;}' +
      '#editor-attr-table th:hover{background:#eaf0f6;}' +
      '#editor-attr-table th .attr-arrow{margin-left:5px;font-size:10px;color:#ce5c00;}' +
      '#editor-attr-table th .attr-rsz{position:absolute;top:0;right:0;width:8px;height:100%;cursor:col-resize;}' +
      '#editor-attr-table th .attr-rsz:hover{background:#b9c6d4;}' +
      '#editor-attr-table td{padding:2px 6px;border-bottom:1px solid #f0f3f6;box-sizing:border-box;overflow:hidden;}' +
      '#editor-attr-table input{width:100%;box-sizing:border-box;border:1px solid transparent;border-radius:3px;padding:4px 6px;font-size:13px;background:transparent;color:#2b3a4a;}' +
      '#editor-attr-table input:hover{border-color:#d8d8d8;}' +
      '#editor-attr-table input:focus{border-color:#ce5c00;background:#fff;outline:none;}' +
      '#editor-attr-table tbody tr:not(.attr-row-sel) input{pointer-events:none;}' +   // 1st click: select/highlight the row; 2nd click (selected row) edits the cell
      '#editor-attr-table tbody tr:hover td{background:#f8fafc;}' +
      '#editor-attr-table tbody tr.attr-row-sel td{background:#fff5cc;}' +
      '#editor-attr-table tbody tr.attr-row-sel:hover td{background:#ffefb0;}' +
      '#editor-attr-table tbody tr.attr-row-hover td{background:#d6f3ff;}' +
      '#editor-attr-table td.attr-sel-cell{cursor:pointer;text-align:center;padding:2px 0;}' +
      '#editor-attr-table td.attr-pin-cell{position:sticky;background:#ffffff;z-index:2;box-shadow:2px 0 0 rgba(0,0,0,0.07);}' +
      '#editor-attr-table tbody tr:hover td.attr-pin-cell{background:#f8fafc;}' +
      '#editor-attr-table tbody tr.attr-row-sel td.attr-pin-cell{background:#fff5cc;}' +
      '#editor-attr-table tbody tr.attr-row-hover td.attr-pin-cell{background:#d6f3ff;}' +
      '#editor-attr-table tr#attr-preview-row td.attr-pin-cell{background:#fffbe6;}' +
      '#editor-attr-table th .attr-pin{position:absolute;top:1px;right:12px;font-size:15px;opacity:0;cursor:pointer;transition:opacity .12s;}' +
      '#editor-attr-table th:hover .attr-pin{opacity:0.55;}' +
      '#editor-attr-table th .attr-pin.on{opacity:1;filter:none;}' +
      '#editor-attr-table th .attr-pin:hover{opacity:1;}' +
      '#editor-attr-table th.attr-drop-before{box-shadow:inset 3px 0 0 #ce5c00;}' +
      '#editor-attr-table th.attr-drop-after{box-shadow:inset -3px 0 0 #ce5c00;}' +
      '#editor-attr-table th.attr-pin-th{z-index:7;}' +

      '#editor-attr-table td.attr-sel-cell::before{content:"\\2606";color:#bbbbbb;font-size:14px;}' +
      '#editor-attr-table td.attr-sel-cell:hover::before{color:#ce5c00;}' +
      '#editor-attr-table tbody tr.attr-row-sel td.attr-sel-cell::before{content:"\\2605";color:#ce5c00;}' +
      '#editor-attr-table tr#attr-preview-row td{position:sticky;z-index:4;background:#fffbe6;border-bottom:2px solid #e3dcae;box-sizing:border-box;padding:7px 10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12px;color:#333333;}' +
      '#editor-attr-table tr#attr-preview-row td.attr-preview-empty{color:#999999;font-style:italic;}' +
      '#editor-attr-table th{z-index:5;}' +   // brushed from the map (or direct hover) — matches the cyan map highlight
      // WHITE-SCROLL root cause (7/18, seen on real-GPU screencast): per-cell position:sticky LEFT
      // paints on a slow path — during fast vertical scrolling the pinned cells lag the compositor
      // and show WHITE while normal cells keep up. At scrollLeft 0 sticky adds nothing (cells sit at
      // their natural spot), so pin-stickiness is DISABLED (ms-nopin, tbody only — the thead preview
      // row must keep its top-sticky) until the table is actually h-scrolled.
      '#editor-attr-table.ms-nopin tbody td.attr-pin-cell{position:static;box-shadow:none;}' +
      '#editor-attr-foot{padding:8px 16px;border-top:1px solid #cccccc;font-size:12px;color:#888888;}';
    document.head.appendChild(st);
    var m = document.createElement('div'); m.id = 'editor-attr-modal';
    m.innerHTML =
      '<div id="editor-attr-panel">' +
        '<div id="editor-attr-head"><span class="attr-head-l"><b id="editor-attr-title">Attributes</b>' +
          '<button id="editor-attr-zoom" title="Zoom the map to the selected feature(s)" disabled>&#9673; Zoom to selected</button>' +
          '<button id="editor-attr-del" title="Delete the selected feature(s)" disabled>&#128465; Delete selected</button>' +
          '<button id="editor-attr-transfer" title="Copy one column\'s values into another">&#8646; Transfer column</button></span>' +
          '<span id="editor-attr-close" title="Close">&times;</span></div>' +
        '<div id="editor-attr-transfer-panel" style="display:none;padding:6px 12px;border-bottom:1px solid #e4e0ee;background:#faf9fd;font-size:12.5px;">' +
          'Copy <select id="attr-tr-from" style="font-size:12px;max-width:170px;"></select>' +
          ' into <select id="attr-tr-to" style="font-size:12px;max-width:170px;"></select>' +
          ' <label style="margin:0 8px;"><input type="checkbox" id="attr-tr-empty" checked style="vertical-align:middle;"> only where the target is empty</label>' +
          '<button id="attr-tr-go" style="font-size:12px;padding:2px 10px;border:1px solid #a3c293;border-radius:4px;background:#eafaea;color:#2d7a2d;cursor:pointer;">Apply</button>' +
          ' <span id="attr-tr-status" style="color:#8a86a0;"></span>' +
          '<div style="color:#8a86a0;margin-top:2px;">Rows whose source value is empty are left untouched. Tileset layers: the database updates now; tiles show it after the next Publish.</div>' +
        '</div>' +
        '<div id="editor-attr-wrap"><table id="editor-attr-table"><thead id="editor-attr-thead"></thead><tbody id="editor-attr-tbody"></tbody></table></div>' +
        '<div id="editor-attr-foot"></div>' +
        '<div id="attr-rz-r"></div><div id="attr-rz-b"></div><div id="attr-rz-c"></div>' +
      '</div>';
    document.body.appendChild(m);
    document.getElementById('editor-attr-close').addEventListener('click', hideAttrModal);
    document.getElementById('editor-attr-zoom').addEventListener('click', zoomToAttrSelected);
    document.getElementById('editor-attr-del').addEventListener('click', deleteAttrSelected);
    document.getElementById('editor-attr-transfer').addEventListener('click', toggleTransferPanel);
    document.getElementById('attr-tr-go').addEventListener('click', runColumnTransfer);
    document.getElementById('editor-attr-head').addEventListener('mousedown', startAttrPanelDrag);
    // custom resize (right edge / bottom edge / corner) — native resize:both only gave the corner
    [['attr-rz-r', true, false], ['attr-rz-b', false, true], ['attr-rz-c', true, true]].forEach(function (spec) {
      var h = document.getElementById(spec[0]);
      h.addEventListener('mousedown', function (e) {
        e.preventDefault(); e.stopPropagation();
        var panel = document.getElementById('editor-attr-panel');
        var r0 = panel.getBoundingClientRect(), x0 = e.pageX, y0 = e.pageY;
        window._msPanelDrag = true;   // resizing must not hover-highlight map features underneath
        function move(ev) {
          if (spec[1]) panel.style.width = Math.max(340, r0.width + (ev.pageX - x0)) + 'px';
          if (spec[2]) panel.style.height = Math.max(180, r0.height + (ev.pageY - y0)) + 'px';
        }
        function up() { window._msPanelDrag = false; document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); document.body.style.userSelect = ''; }
        document.body.style.userSelect = 'none';
        document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
      });
    });
  }
  // ── column view (pin + order): persisted per layer in raw_config.attrView = {order:[keys], pinned:[keys]} ──
  function attrColKey(c) { return c.kind === 'sel' ? '__sel' : (c.kind === 'custom' ? c.key : c.field); }
  function applyAttrView(node) {   // reorder _attrCols by the saved order + mark pinned (★ always first)
    var av = node && node.attrView; if (!av) return;
    if (av.order && av.order.length) {
      var byKey = {}; _attrCols.forEach(function (c) { byKey[attrColKey(c)] = c; });
      var out = [];
      if (byKey['__sel']) { out.push(byKey['__sel']); delete byKey['__sel']; }
      av.order.forEach(function (k) { if (byKey[k]) { out.push(byKey[k]); delete byKey[k]; } });
      _attrCols.forEach(function (c) { var k = attrColKey(c); if (byKey[k]) { out.push(c); delete byKey[k]; } });   // new columns keep their default spot at the end
      _attrCols = out;
    }
    (av.pinned || []).forEach(function (k) { _attrCols.forEach(function (c) { if (attrColKey(c) === k) c.pinned = true; }); });
  }
  function attrStickyOffsets() {   // ★ + pinned columns freeze at a computed left; everything else scrolls under
    var left = 0;
    _attrCols.forEach(function (c) {
      if (c.kind === 'sel' || c.pinned) { c._left = left; left += (c.w || 130); }
      else c._left = null;
    });
  }
  var _attrViewSaveT = null;
  function persistAttrView() {
    if (!_attrSlug) return;
    var node = findNodeById(layers, _attrSlug); var lid = slugToLayerDbId[_attrSlug];
    if (!node || !lid) return;
    var order = _attrCols.filter(function (c) { return c.kind !== 'sel'; }).map(attrColKey);
    var pinned = _attrCols.filter(function (c) { return c.pinned; }).map(attrColKey);
    node.attrView = { order: order, pinned: pinned };
    clearTimeout(_attrViewSaveT);
    _attrViewSaveT = setTimeout(async function () {
      try {
        var cur = await db.from('layers').select('raw_config').eq('id', lid).single();
        var rc = (cur.data && cur.data.raw_config) || {};
        rc.attrView = node.attrView;
        await db.from('layers').update({ raw_config: rc }).eq('id', lid);
      } catch (e) {}
    }, 400);
  }
  var _attrCustom = {};   // fid → its custom_fields object, so a single-cell edit rewrites the whole jsonb
  var _attrRows = [], _attrCols = [], _attrSort = null, _attrSel = [];   // loaded rows + column model + {idx,dir} + selected feature_ids (highlighted on the map)
  var _attrLoadGen = 0;        // bump = abort any in-flight attribute load (close/reopen mid-load of a huge layer)
  var ATTR_LOAD_CAP = 100000;  // tier-1 guardrail: rows STREAMED into memory — past this, a layer needs the big-data tier (Parquet sidecar) instead of a full fetch; rendering is windowed (MSAttrWindow) so DOM size never depends on row count
  var _attrWin = null;         // MSAttrWindow instance for the (single, for now) attribute panel
  var _attrVirtual = null;     // big-data tier: {prov, order, pending, N, gen, lid} when the open table pages from a >cap Parquet sidecar
  var _attrRebakeT = null;     // debounce for background sidecar rebakes after edits
  // FEATURES LIST (Rung 1, 7/20): the ▦ icon opens a lightweight docked LIST (icon + label per row,
  // count-only footer) instead of the full grid; an "Expand" button opens today's attribute table.
  // It SHARES the attr module state (_attrSel/_attrById/_attrRows/_attrSlug) so map highlight, hover
  // and zoom reuse the exact same helpers as the table. See openFeaturesList.
  var _flistWin = null, _flistSlug = null, _flistIcon = '';
  function orderAttrKeys(keys, cap) {   // msid FIRST, ms_* style columns LAST, everything else between (cap trims the middle, never msid/ms_*)
    var style = ['ms_color', 'ms_linecolor', 'ms_opacity', 'ms_thickness', 'ms_labelsize'].filter(function (k) { return keys.indexOf(k) > -1; });
    var msid = keys.indexOf('msid') > -1 ? ['msid'] : [];
    var mid = keys.filter(function (k) { return k !== 'msid' && style.indexOf(k) < 0; });
    if (cap) mid = mid.slice(0, Math.max(0, cap - msid.length - style.length));
    return msid.concat(mid).concat(style);
  }
  var _attrById = {}, _attrSlug = null, _attrHover = null, _attrHoverRAF = false, _attrLastPt = null, _attrHoverWired = false;   // hover brushing (map ↔ row): id→row lookup, open layer, hovered fid
  var _attrReadonly = false;   // true when the table is sourced from vector tiles (pure tileset) rather than the editable `features` table
  var _attrDelegated = false;  // event-delegation wired once on tbody (so 18k+ rows don't each get listeners)
  function attrCellVal(r, c) {
    if (c.kind === 'sel') return _attrSel.indexOf(String(r.feature_id)) > -1 ? 0 : 1;   // selected sort to the top
    return c.kind === 'custom' ? ((r.custom_fields || {})[c.key]) : r[c.field];
  }
  function attrDisp(r, c) { var v = attrCellVal(r, c); if (c.kind === 'date') return v ? String(v).slice(0, 10) : ''; return v == null ? '' : v; }
  function findAttrRow(fid) { return _attrById[String(fid)] || null; }
  // lazy geometry: the table streams WITHOUT geom (it never displays it); the map-facing bits
  // (hover glow, selection highlight, zoom-to-selected) pull geometries here on demand, batched,
  // and cache them onto the same row objects. Tile-sourced rows already carry geometry.
  async function ensureAttrGeoms(fids) {
    var need = (fids || []).map(String).filter(function (fid) { var r = _attrById[fid]; return r && !r.geom && !r._tile; });
    if (!need.length) return;
    var gen = _attrLoadGen;
    for (var i = 0; i < need.length; i += 200) {
      try {
        var res = await db.from('features').select('feature_id, geom').in('feature_id', need.slice(i, i + 200));
        if (gen !== _attrLoadGen) return;   // table closed / re-opened mid-fetch
        (res.data || []).forEach(function (r) { var row = _attrById[String(r.feature_id)]; if (row) row.geom = r.geom; });
      } catch (e) { return; }
    }
  }
  /* ── big-data tier plumbing (7/18) — see platform/bigtable.js ─────────── */
  function attrBakeStatus(m) { try { setStatus(m); } catch (e) {} }
  // after a full plain stream, big layers get their sidecar (re)baked in the background from the
  // rows ALREADY in memory — covers brand-new imports (first open bakes, every later open is fast)
  // and stale/dirty sidecars (the stream is the fresh truth)
  function maybeBakeAfterStream(lid, rows, total, gen) {
    if (!window.MSBigTable || _attrReadonly || !lid) return;
    if (total <= MSBigTable.BIG_ROWS || total > MSBigTable.BAKE_MAX) return;
    if (rows.length >= total) {
      MSBigTable.bakeFromRows(db, projectId, lid, rows, attrBakeStatus).catch(function (e) { console.warn('sidecar bake failed', e); });
      return;
    }
    // display cap hit but the layer is bakeable: keep streaming in the BACKGROUND into a bake-only
    // copy, then bake — the next open serves ALL rows through virtual mode over the sidecar
    (async function () {
      try {
        var all = rows.slice();
        for (var from = all.length; from < MSBigTable.BAKE_MAX; from += 1000) {
          var res = await db.from('features').select('feature_id, label, description, start_date, end_date, custom_fields, content_id').eq('layer_id', lid).order('feature_id').range(from, from + 999);
          if (res.error) return;
          Array.prototype.push.apply(all, res.data || []);
          if (!res.data || res.data.length < 1000) break;
        }
        await MSBigTable.bakeFromRows(db, projectId, lid, all, attrBakeStatus);
      } catch (e) { console.warn('sidecar backfill bake failed', e); }
    })();
  }
  // an edit/delete landed on a sidecar'd layer: stamp dirty NOW (cheap — catches close-before-rebake),
  // rebake from the in-memory rows once edits settle (for ≤cap tables the rows array IS the edited truth)
  function scheduleAttrRebake() {
    if (!window.MSBigTable || _attrReadonly || !_attrSlug) return;
    var lid = slugToLayerDbId[_attrSlug]; if (!lid) return;
    if (_attrVirtual) { MSBigTable.noteDirty(db, lid); return; }   // >cap: rebake is a next-stream job, not an in-memory one
    if (_attrRows.length <= MSBigTable.BIG_ROWS) return;           // small layer — no sidecar to maintain
    MSBigTable.noteDirty(db, lid);
    if (_attrRebakeT) clearTimeout(_attrRebakeT);
    var rowsRef = _attrRows;
    _attrRebakeT = setTimeout(function () {
      _attrRebakeT = null;
      MSBigTable.bakeFromRows(db, projectId, lid, rowsRef, function () {}).catch(function (e) { console.warn('sidecar rebake failed', e); });
    }, 15000);
  }
  // VIRTUAL mode (> display cap): _attrRows is a SPARSE array over the sidecar's full row count.
  // MSAttrWindow renders ghosts for missing rows and calls fetchAttrPage; sorts run as SQL.
  async function openVirtualAttr(node, slug, lid, rc, gen) {
    var foot = document.getElementById('editor-attr-foot');
    if (foot) foot.textContent = 'Opening big-data table…';
    var prov = await MSBigTable.openProvider(lid, rc.attrParquet, rc.attrParquetAt, rc.attrParquetRows);
    if (gen !== _attrLoadGen) return;
    var N = rc.attrParquetRows;
    var keysS = orderAttrKeys(prov.customKeys.slice(), 30);
    _attrRows = new Array(N);
    _attrSlug = slug; _attrById = {}; ensureAttrMapHover();
    _attrVirtual = { prov: prov, order: null, pending: {}, N: N, gen: gen, lid: lid };
    _attrCols = [
      { title: '★', kind: 'sel', type: '', w: 30, tip: 'Selected features — click the star to select/deselect; sort this column to bring selected to the top' },
      { title: 'Label', kind: 'std', field: 'label', type: 'text', w: keysS.length ? 180 : 240 },
      { title: 'Start', kind: 'date', field: 'start_date', type: 'date', w: 130 },
      { title: 'End', kind: 'date', field: 'end_date', type: 'date', w: 130 },
      { title: 'Notes', kind: 'std', field: 'description', type: 'text', w: 220 },
      { title: 'Page', kind: 'std', field: 'content_id', type: 'text', w: 90 }
    ].concat(keysS.map(function (k) { return { title: k, kind: 'custom', key: k, type: 'text', w: 130 }; }));
    applyAttrView(nodeByLayerDbId(lid) || findNodeById(layers, slug));
    buildAttrHead(); renderAttrBody(); updateAttrZoomBtn(); updateAttrDelBtn();
    if (_attrWin) _attrWin.onMissing = fetchAttrPage;
    if (foot) foot.textContent = nfmt(N) + ' features · big-data table — rows stream in as you scroll, sorts run in the columnar engine · click a row to highlight it on the map';
  }
  function fetchAttrPage(start, end) {
    var v = _attrVirtual; if (!v) return;
    var ps = Math.max(0, Math.floor(start / 200) * 200);
    var pe = Math.min(v.N, ps + 400);   // the visible page + one ahead
    for (var s = ps; s < pe; s += 200) {
      (function (s0) {
        if (v.pending[s0]) return;
        v.pending[s0] = 1;
        v.prov.range(s0, 200, v.order).then(function (rs) {
          if (_attrVirtual !== v || v.gen !== _attrLoadGen) return;
          for (var i = 0; i < rs.length; i++) { _attrRows[s0 + i] = rs[i]; _attrById[String(rs[i].feature_id)] = rs[i]; }
          if (_attrWin) _attrWin.update();
        }, function () { delete v.pending[s0]; });   // failed page → retryable on the next scroll
      })(s);
    }
  }
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
    _attrCustom = {}; _attrRows = []; _attrCols = []; _attrSort = null; _attrReadonly = false; _attrVirtual = null; clearAttrHighlight();
    if (_attrWin) _attrWin.onMissing = null;   // virtual-mode page fetcher — re-attached only by openVirtualAttr
    // STREAMED load (7/15, after 78k rows hung the page): the FIRST page renders immediately — the
    // table is usable (sort/edit/drag/close) while the rest loads behind it. Closing the modal bumps
    // _attrLoadGen, which quietly aborts this loop.
    var gen = ++_attrLoadGen;
    var rows = [], total = 0, loadErr = null, streamedFirst = false;
    var buildTable = function (final) {   // columns + head + body from the rows loaded SO FAR (idempotent)
      var keysS = [];
      rows.forEach(function (r) { var cf = r.custom_fields; if (cf && typeof cf === 'object') { _attrCustom[r.feature_id] = cf; Object.keys(cf).forEach(function (k) { if (keysS.indexOf(k) < 0) keysS.push(k); }); } });
      keysS = orderAttrKeys(keysS, 30);
      _attrRows = rows;
      _attrSlug = slug; _attrById = {}; rows.forEach(function (r) { _attrById[String(r.feature_id)] = r; }); ensureAttrMapHover();
      _attrCols = [
        { title: '★', kind: 'sel', type: '', w: 30, tip: 'Selected features — click the star to select/deselect; sort this column to bring selected to the top' },
        { title: 'Label', kind: 'std', field: 'label', type: 'text', w: keysS.length ? 180 : 240 },
        { title: 'Start', kind: 'date', field: 'start_date', type: 'date', w: 130 },
        { title: 'End', kind: 'date', field: 'end_date', type: 'date', w: 130 },
        { title: 'Notes', kind: 'std', field: 'description', type: 'text', w: 220 },
        { title: 'Page', kind: 'std', field: 'content_id', type: 'text', w: 90 }
      ].concat(keysS.map(function (k) { return { title: k, kind: 'custom', key: k, type: 'text', w: 130 }; }));
      applyAttrView(nodeByLayerDbId(lid) || findNodeById(layers, slug));
      buildAttrHead(); renderAttrBody(); updateAttrZoomBtn(); updateAttrDelBtn();
      var fEl2 = document.getElementById('editor-attr-foot');
      if (fEl2) fEl2.textContent = final
        ? ((rows.length < total ? 'First ' + nfmt(rows.length) + ' of ' + nfmt(total) + ' features (very large layer — the rest arrives with the big-data table tier)' : nfmt(total) + ' feature' + (total === 1 ? '' : 's')) + (keysS.length ? '  ·  ' + keysS.length + ' attribute' + (keysS.length === 1 ? '' : 's') : '') + '  ·  click a row to highlight it on the map · Ctrl-click to add')
        : ('Loading ' + nfmt(rows.length) + (total ? ' / ' + nfmt(total) : '') + '… — the table already works');
      return keysS;
    };
    // ── big-data tier (7/18): a baked Parquet sidecar opens big layers in ~a second instead of
    // re-streaming tens of MB from Postgres. Freshness = exact row-count match + not dirty; any
    // mismatch falls through to the plain stream, whose tail re-bakes the sidecar. ──
    if (window.MSBigTable) {
      try {
        var rcq = await db.from('layers').select('raw_config').eq('id', lid).single();
        if (gen !== _attrLoadGen) return;
        var arc = (rcq.data && rcq.data.raw_config) || {};
        if (arc.attrParquet) {
          var cq = await db.from('features').select('feature_id', { count: 'exact', head: true }).eq('layer_id', lid);
          if (gen !== _attrLoadGen) return;
          var live = (cq && cq.count) || 0;
          var fresh = live === arc.attrParquetRows && !arc.attrParquetDirty;
          if (fresh && arc.attrParquetRows <= ATTR_LOAD_CAP) {
            foot.textContent = 'Opening (fast columnar sidecar)…';
            try {
              var srows = await MSBigTable.loadAll(lid, arc.attrParquet, arc.attrParquetAt);
              if (gen !== _attrLoadGen) return;
              rows = srows; total = srows.length;
              buildTable(true);
              return;
            } catch (eSc) { console.warn('sidecar load failed — falling back to stream', eSc); }
          } else if (fresh) {   // > display cap: VIRTUAL mode — rows page in on demand, sorts run as SQL in the worker
            try { await openVirtualAttr(node, slug, lid, arc, gen); return; }
            catch (eV) { console.warn('virtual table failed — falling back to stream', eV); }
          }
        }
      } catch (eRc) {}
      if (gen !== _attrLoadGen) return;
    }
    try {
      for (var afrom = 0; afrom < 1000000; afrom += 1000) {
        // NO geom (7/18): geometry was ~half of a 72MB table download and the table never displays
        // it — hover/highlight/zoom fetch geometries per-row on demand (ensureAttrGeoms)
        var ares = await db.from('features').select('feature_id, label, description, start_date, end_date, custom_fields, content_id', afrom === 0 ? { count: 'exact' } : {}).eq('layer_id', lid).order('feature_id').range(afrom, afrom + 999);
        if (gen !== _attrLoadGen) return;   // modal closed / another layer opened — stop this load
        if (ares.error) { loadErr = ares.error; break; }
        if (afrom === 0 && ares.count != null) total = ares.count;
        var abatch = ares.data || []; Array.prototype.push.apply(rows, abatch);
        if (!streamedFirst && rows.length) { streamedFirst = true; if (rows.length < (total || Infinity)) buildTable(false); }
        else { var fEl = document.getElementById('editor-attr-foot'); if (fEl && rows.length < (total || 0)) fEl.textContent = 'Loading ' + nfmt(rows.length) + (total ? ' / ' + nfmt(total) : '') + '… — the table already works'; }
        if (abatch.length < 1000) break;
        if (rows.length >= ATTR_LOAD_CAP) break;   // guardrail: don't pull a million-row layer into browser memory — first 100k stay fully usable
      }
    } catch (e) { loadErr = e; }
    if (gen !== _attrLoadGen) return;
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
      var tkeys = []; tfeats.forEach(function (r) { Object.keys(r.custom_fields).forEach(function (k) { if (tkeys.indexOf(k) < 0) tkeys.push(k); }); }); tkeys = orderAttrKeys(tkeys, 40);
      _attrRows = tfeats; _attrReadonly = true; _attrSlug = slug; _attrById = {}; tfeats.forEach(function (r) { _attrById[String(r.feature_id)] = r; }); ensureAttrMapHover();
      _attrCols = [{ title: '\u2605', kind: 'sel', type: '', w: 30, tip: 'Selected features \u2014 click the star to select/deselect; sort this column to bring selected to the top' }].concat(tkeys.length ? tkeys.map(function (k) { return { title: k, kind: 'custom', key: k, type: 'text', w: 140 }; }) : [{ title: 'feature', kind: 'std', field: 'feature_id', type: 'text', w: 200 }]);
      applyAttrView(findNodeById(layers, slug));
      buildAttrHead(); renderAttrBody(); updateAttrZoomBtn(); updateAttrDelBtn();
      foot.textContent = tfeats.length + ' feature' + (tfeats.length === 1 ? '' : 's') + ' from loaded tiles · read-only · pan/zoom to load more · click a row to highlight';
      return;
    }
    if (!rows.length) { tbody.innerHTML = '<tr><td style="padding:14px;color:#888888;">No features in this layer yet.</td></tr>'; foot.textContent = '0 features'; return; }
    if (!total) total = rows.length;
    buildTable(true);   // final build \u2014 columns from ALL rows (later pages can add custom_fields keys)
    maybeBakeAfterStream(lid, rows, total, gen);   // big layers: bake/refresh the Parquet sidecar in the background \u2014 the NEXT open is fast
  }
  function buildAttrHead() {
    var thead = document.getElementById('editor-attr-thead');
    attrStickyOffsets();
    thead.innerHTML = '<tr>' + _attrCols.map(function (c, i) {
      var arrow = (_attrSort && _attrSort.idx === i) ? '<span class="attr-arrow">' + (_attrSort.dir === 'desc' ? '▼' : '▲') + '</span>' : '';
      var stick = c._left != null ? 'left:' + c._left + 'px;z-index:7;' : '';
      var pinCls = c.pinned ? ' on' : '';
      if (c.kind === 'sel') return '<th data-ci="' + i + '" class="attr-pin-th" style="width:' + c.w + 'px;padding:8px 2px;text-align:center;' + stick + '" title="' + attrEsc(c.tip || '') + '">' + c.title + arrow + '</th>';
      return '<th data-ci="' + i + '"' + (c._left != null ? ' class="attr-pin-th"' : '') + ' style="width:' + c.w + 'px;' + stick + '" title="' + attrEsc(c.title) + '">' + attrEsc(c.title) + arrow +
        '<span class="attr-pin' + pinCls + '" title="' + (c.pinned ? 'Unpin this column' : 'Pin — stays visible when scrolling') + '">&#128204;</span><span class="attr-rsz"></span></th>';
    }).join('') + '</tr>' +
      // pinned VIEW row: hovering a feature (map or table) shows its values here — no scrolling to find it
      '<tr id="attr-preview-row">' + _attrCols.map(function () { return '<td class="attr-preview-empty">&nbsp;</td>'; }).join('') + '</tr>';
    Array.prototype.forEach.call(thead.querySelectorAll('th'), function (th) {
      var ci = parseInt(th.getAttribute('data-ci'), 10);
      th.addEventListener('click', function (e) {
        if (e.target.classList.contains('attr-rsz') || e.target.classList.contains('attr-pin') || th.getAttribute('data-dragged')) return;
        sortAttrBy(ci);
      });
      var rz = th.querySelector('.attr-rsz'); if (rz) rz.addEventListener('mousedown', function (e) { startAttrResize(e, th, ci); });
      var pin = th.querySelector('.attr-pin');
      if (pin) pin.addEventListener('click', function (e) {
        e.stopPropagation();
        _attrCols[ci].pinned = !_attrCols[ci].pinned;
        buildAttrHead(); renderAttrBody(); persistAttrView();
      });
      if (_attrCols[ci].kind !== 'sel') th.addEventListener('mousedown', function (e) { startAttrColDrag(e, th, ci); });
    });
    var _th0 = thead.querySelector('th');
    var _thH = (_th0 && _th0.offsetHeight) || 34;   // the preview row sticks right under the (sticky) header row
    Array.prototype.forEach.call(thead.querySelectorAll('#attr-preview-row td'), function (td) { td.style.top = _thH + 'px'; });
    var _pfs = thead.querySelectorAll('#attr-preview-row td');
    Array.prototype.forEach.call(_pfs, function (td, i7) {
      var c7 = _attrCols[i7];
      if (c7 && c7._left != null) { td.style.left = c7._left + 'px'; td.classList.add('attr-pin-cell'); td.style.zIndex = '5'; }
    });
    var _pfIdx = _attrCols[0] && _attrCols[0].kind === 'sel' ? 1 : 0;
    if (_pfs[_pfIdx]) _pfs[_pfIdx].textContent = 'Hover a feature to view it here…';
    if (_pfIdx === 1 && _pfs[0]) { _pfs[0].classList.remove('attr-preview-empty'); _pfs[0].innerHTML = '&nbsp;'; }
    applyAttrTableWidth();
  }
  function applyAttrTableWidth() {   // table width = sum of column widths, so fixed layout honors each + the wrap scrolls horizontally
    var t = document.getElementById('editor-attr-table');
    if (t) t.style.width = _attrCols.reduce(function (s, c) { return s + (c.w || 130); }, 0) + 'px';
  }
  function startAttrColDrag(e, th, ci) {   // hold a header and drag it left/right to reorder the column
    if (e.target.classList.contains('attr-rsz') || e.target.classList.contains('attr-pin')) return;
    var sx = e.pageX, dragging = false;
    var thead = document.getElementById('editor-attr-thead');
    var wrap = document.getElementById('editor-attr-wrap');
    var lastX = e.clientX, scrollDir = 0, scrollTimer = null;
    function placeMarker(px) {
      Array.prototype.forEach.call(thead.querySelectorAll('th'), function (t2) { t2.classList.remove('attr-drop-before', 'attr-drop-after'); });
      var tgt = document.elementFromPoint(px, th.getBoundingClientRect().top + 10);
      tgt = tgt && tgt.closest ? tgt.closest('th[data-ci]') : null;
      if (!tgt || tgt === th) return;
      var r = tgt.getBoundingClientRect();
      var side = (px - r.left) / r.width > 0.5 ? 'after' : 'before';
      tgt.setAttribute('data-dropside', side);
      tgt.classList.add('attr-drop-' + side);
    }
    function edgeScroll() {   // fires on a timer so the table keeps sliding while the mouse holds still at an edge
      if (!scrollDir || !wrap) return;
      wrap.scrollLeft += scrollDir;
      placeMarker(lastX);   // columns moved under the pointer — refresh the drop marker
    }
    function move(ev) {
      if (!dragging && Math.abs(ev.pageX - sx) < 6) return;
      if (!dragging) { dragging = true; th.setAttribute('data-dragged', '1'); th.style.opacity = '0.5'; document.body.style.userSelect = 'none'; scrollTimer = setInterval(edgeScroll, 30); }
      lastX = ev.clientX;
      scrollDir = 0;
      if (wrap) {   // dragging near/past an edge auto-scrolls, faster the closer to the edge
        var wr = wrap.getBoundingClientRect(), zone = 48, leftEdge = wr.left;
        Array.prototype.forEach.call(thead.querySelectorAll('th.attr-pin-th'), function (pt) { var pr = pt.getBoundingClientRect().right; if (pr > leftEdge) leftEdge = pr; });
        if (ev.clientX < leftEdge + zone) scrollDir = -Math.ceil(Math.min(45, leftEdge + zone - ev.clientX) / 3);
        else if (ev.clientX > wr.right - zone) scrollDir = Math.ceil(Math.min(45, ev.clientX - (wr.right - zone)) / 3);
      }
      placeMarker(ev.clientX);
    }
    function up(ev) {
      document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up);
      if (scrollTimer) { clearInterval(scrollTimer); scrollTimer = null; }
      document.body.style.userSelect = ''; th.style.opacity = '';
      var marked = thead.querySelector('th.attr-drop-before, th.attr-drop-after');
      Array.prototype.forEach.call(thead.querySelectorAll('th'), function (t2) { t2.classList.remove('attr-drop-before', 'attr-drop-after'); });
      if (!dragging) return;
      setTimeout(function () { th.removeAttribute('data-dragged'); }, 0);   // swallow the click that follows the mouseup
      if (!marked) return;
      var ti = parseInt(marked.getAttribute('data-ci'), 10);
      if (isNaN(ti) || _attrCols[ti].kind === 'sel') return;
      var after = marked.getAttribute('data-dropside') === 'after';
      var col = _attrCols.splice(ci, 1)[0];
      var ni = ti > ci ? ti - 1 : ti;
      if (after) ni += 1;
      if (ni <= 0) ni = 1;   // never before the ★ column
      _attrCols.splice(ni, 0, col);
      _attrSort = null;
      buildAttrHead(); renderAttrBody(); persistAttrView();
    }
    document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
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
    if (_attrVirtual) {   // big-data table: the sort runs as SQL in the columnar engine (worker thread), pages refetch under the new order
      var v = _attrVirtual;
      v.order = c.kind === 'sel' ? { selFids: _attrSel.slice(), dir: dir }
        : c.kind === 'custom' ? { custom: c.key, dir: dir }
          : { col: c.field, dir: dir };
      v.pending = {};
      _attrRows = new Array(v.N); _attrById = {};
      buildAttrHead();
      if (_attrWin) _attrWin.setRows(_attrRows, false); else renderAttrBody();
      return;
    }
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
  // TEXT-FIRST rows (7/18, the white-scroll fix): a row full of live <input> form controls
  // costs ~10x a text row to build — 85 buffered rows × 22 inputs made every window rebuild
  // eat a whole frame (11–18ms measured), so fast scrolling outran the renderer and showed
  // blank. Rows now render as text; the SELECTED row(s) materialize real inputs — identical
  // UX to the existing two-click model (inputs were click-blocked until selected anyway).
  function attrRowHtml(r) {
    // virtual (big-data) mode: a not-yet-fetched row renders as a ghost of the same height —
    // no data-fid, so clicks/hover/measure all skip it; the page fetch replaces it in ~100ms
    if (!r) return '<tr class="attr-row-ghost" style="height:' + ((_attrWin && _attrWin.rowH) || 30) + 'px;"><td colspan="' + (_attrCols.length || 1) + '" style="padding:5px 7px;color:#a5a5a5;">…</td></tr>';
    var isSel = _attrSel.indexOf(String(r.feature_id)) > -1;
    return '<tr data-fid="' + attrEsc(r.feature_id) + '"' + (isSel ? ' class="attr-row-sel"' : '') + '>' + _attrCols.map(function (c) {
      var stick = c._left != null ? ' class="attr-pin-cell" style="left:' + c._left + 'px;"' : '';
      if (c.kind === 'sel') return '<td class="attr-sel-cell' + (c._left != null ? ' attr-pin-cell' : '') + '"' + (c._left != null ? ' style="left:' + c._left + 'px;"' : '') + ' title="Select / deselect this feature"></td>';
      var bind = c.kind === 'custom' ? 'data-fc="' + attrEsc(c.key) + '"' : 'data-f="' + attrEsc(c.field) + '"';
      var v = attrEsc(attrDisp(r, c));
      if (_attrReadonly || !isSel) return '<td' + stick + '><span ' + bind + ' style="display:block;padding:5px 7px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + v + '</span></td>';
      return '<td' + stick + '><input ' + bind + ' type="' + c.type + '" value="' + v + '" /></td>';
    }).join('') + '</tr>';
  }
  // selection changed → any DOM row whose input-vs-text state no longer matches gets rebuilt
  // in place (cheap: only the rows that flipped)
  function refreshAttrRowEditability() {
    if (_attrReadonly) return;
    var tbody = document.getElementById('editor-attr-tbody'); if (!tbody) return;
    Array.prototype.forEach.call(tbody.querySelectorAll('tr[data-fid]'), function (tr) {
      var fid = tr.getAttribute('data-fid');
      var should = _attrSel.indexOf(fid) > -1, has = !!tr.querySelector('input');
      if (should !== has) { var r = findAttrRow(fid); if (r) tr.outerHTML = attrRowHtml(r); }
    });
  }
  // WINDOWED body (7/18, replaces the 1,500-row render cap): MSAttrWindow keeps only the
  // visible slice (+overscan) in the DOM over the FULL row set — 78k rows scroll seamlessly
  // with ~40 <tr> alive. Events stay delegated on the tbody, so recycled rows keep working.
  // keepScroll=true holds the scroll position (deletes / in-place syncs); default jumps to top.
  function renderAttrBody(keepScroll) {
    var tbody = document.getElementById('editor-attr-tbody');
    if (!_attrWin && window.MSAttrWindow) {
      var wrapEl = document.getElementById('editor-attr-wrap');
      _attrWin = new MSAttrWindow({
        scrollEl: wrapEl,
        tbody: tbody,
        renderRow: attrRowHtml,
        colCount: function () { return _attrCols.length; }
      });
      // pin-stickiness only while actually h-scrolled (see ms-nopin CSS note)
      var tblEl = document.getElementById('editor-attr-table');
      var syncNopin = function () { tblEl.classList.toggle('ms-nopin', wrapEl.scrollLeft === 0); };
      wrapEl.addEventListener('scroll', syncNopin, { passive: true });
      syncNopin();
    }
    if (_attrWin) { _attrWin._measured = false; _attrWin.setRows(_attrRows, keepScroll); }
    else tbody.innerHTML = _attrRows.slice(0, 1500).map(attrRowHtml).join('');   // attrGrid.js missing — degraded but alive
    if (!_attrDelegated) { _attrDelegated = true; wireAttrDelegation(tbody); }   // delegate once (scales to all features without per-row listeners)
  }
  function wireAttrDelegation(tbody) {
    tbody.addEventListener('change', function (e) {   // edit a cell → persist
      var inp = e.target.closest('input'); if (!inp) return; var tr = inp.closest('tr[data-fid]'); if (!tr) return;
      var fid = tr.getAttribute('data-fid'), std = inp.getAttribute('data-f');
      if (std) saveAttrCell(fid, std, inp.value); else saveAttrCustomCell(fid, inp.getAttribute('data-fc'), inp.value);
    });
    tbody.addEventListener('click', function (e) {   // click a row → highlight its feature on the map (Ctrl/Cmd = add); editing a cell still works
      var tr = e.target.closest('tr[data-fid]'); if (!tr) return;
      if (e.target.closest('.attr-sel-cell')) { selectAttrRow(tr.getAttribute('data-fid'), true); return; }   // the ★ always TOGGLES (like starring an email)
      selectAttrRow(tr.getAttribute('data-fid'), e.ctrlKey || e.metaKey);
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
    refreshAttrRowEditability();   // text-first rows: selected rows swap to real inputs, deselected back to text
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
    if (_attrVirtual) { setStatus('Deleted ' + n + ' feature' + (n > 1 ? 's' : '')); openAttributeTable(_attrSlug); return; }   // sparse rows can't be filtered in place — reopen (count mismatch → fresh stream + rebake)
    fids.forEach(function (fid) { delete _attrById[String(fid)]; });
    _attrRows = _attrRows.filter(function (r) { return fids.indexOf(String(r.feature_id)) < 0; });
    _attrSel = [];
    buildAttrHead(); renderAttrBody(true); updateAttrZoomBtn(); updateAttrDelBtn(); updateAttrHighlight();
    scheduleAttrRebake();   // sidecar'd layer: row count changed — refresh the bake in the background
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
        if (typeof msRaiseLabelLayers === 'function') msRaiseLabelLayers(m, layers);   // highlights glow UNDER the labels
      } catch (e) {}
    });
  }
  function updateAttrHighlight() {
    ensureAttrHlLayers();
    var want = _attrSel.slice();
    ensureAttrGeoms(want).then(function () {
      if (want.join(',') !== _attrSel.join(',')) return;   // selection moved on while geoms were in flight
      var feats = _attrSel.map(function (fid) { var r = findAttrRow(fid); return (r && r.geom) ? { type: 'Feature', geometry: r.geom, properties: {} } : null; }).filter(Boolean);
      attrMaps().forEach(function (m) { try { var src = m.getSource('editor-attr-hl-src'); if (src) src.setData({ type: 'FeatureCollection', features: feats }); } catch (e) {} });
    });
  }
  function clearAttrHighlight() {
    _attrSel = [];
    attrMaps().forEach(function (m) { try { var src = m.getSource('editor-attr-hl-src'); if (src) src.setData({ type: 'FeatureCollection', features: [] }); } catch (e) {} });
  }
  // ---- hover brushing: row ↔ map feature light up together ----
  function fillAttrPreview(fid) {
    var tr = document.getElementById('attr-preview-row'); if (!tr) return;
    var r = fid && findAttrRow(fid); if (!r) return;   // hover-out keeps the last feature visible for reading
    var tds = tr.querySelectorAll('td');
    _attrCols.forEach(function (c, i) {
      var td = tds[i]; if (!td) return;
      if (c.kind === 'sel') { td.innerHTML = '&nbsp;'; td.classList.remove('attr-preview-empty'); return; }
      var v = attrCellVal(r, c);
      td.textContent = (v == null || v === '') ? '' : String(v);
      td.title = td.textContent;
      td.classList.remove('attr-preview-empty');
    });
  }
  function setAttrHover(fid, scroll) {
    fid = fid ? String(fid) : null;
    if (_attrHover === fid) return;
    _attrHover = fid;
    fillAttrPreview(fid);
    var tbody = document.getElementById('editor-attr-tbody');
    if (tbody) {
      Array.prototype.forEach.call(tbody.querySelectorAll('tr[data-fid]'), function (tr) { tr.classList.toggle('attr-row-hover', tr.getAttribute('data-fid') === _attrHover); });
      if (scroll && _attrHover) {
        var row = tbody.querySelector('tr[data-fid="' + _attrHover + '"]');
        if (!row && _attrWin) {   // fixed viewport: bring the row's WINDOW here, then it exists
          for (var hi = 0; hi < _attrRows.length; hi++) { if (String(_attrRows[hi].feature_id) === _attrHover) { _attrWin.scrollToIndex(hi); break; } }
          row = tbody.querySelector('tr[data-fid="' + _attrHover + '"]');
          Array.prototype.forEach.call(tbody.querySelectorAll('tr[data-fid]'), function (tr) { tr.classList.toggle('attr-row-hover', tr.getAttribute('data-fid') === _attrHover); });
        } else if (row && !_attrWin) row.scrollIntoView({ block: 'nearest' });
      }
    }
    ensureAttrHlLayers();
    var paintHover = function () {
      var r = _attrHover && findAttrRow(_attrHover);
      var hdata = (r && r.geom) ? { type: 'Feature', geometry: r.geom, properties: {} } : { type: 'FeatureCollection', features: [] };
      attrMaps().forEach(function (m) { try { var src = m.getSource('editor-attr-hover-src'); if (src) src.setData(hdata); } catch (e) {} });
    };
    var r0 = fid && findAttrRow(fid);
    if (r0 && !r0.geom && !r0._tile) {
      var hf = fid;
      ensureAttrGeoms([fid]).then(function () { if (_attrHover === hf) paintHover(); });   // apply only if still the hovered row
      paintHover();   // clear/keep current glow immediately — no stale feature lingering
    } else paintHover();
  }
  function ensureAttrMapHover() {   // wire the map → row direction once
    if (_attrHoverWired || typeof beforeMap === 'undefined' || !beforeMap) return;
    _attrHoverWired = true;
    beforeMap.on('mousemove', attrMapHover);
    beforeMap.on('mouseout', function () { setAttrHover(null, false); });
  }
  function attrMapHover(e) {   // throttle to one hit-test per frame
    if (!_attrSlug || window._msPanelDrag) return;
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
    setAttrHover(fid, false);   // the pinned preview row shows the feature now — don't yank the table's scroll around
  }
  function geomsBounds(geoms) {
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    (geoms || []).forEach(function (g) { collectImportCoords(g, function (lng, lat) { if (lng < x0) x0 = lng; if (lat < y0) y0 = lat; if (lng > x1) x1 = lng; if (lat > y1) y1 = lat; }); });
    return isFinite(x0) ? [[x0, y0], [x1, y1]] : null;
  }
  function onZoomExtent() {   // panel: always zoom to the layer's full feature extent (even when a custom zoom target is set)
    if (!activeLayerId) return;
    var node = findNodeById(layers, activeLayerId); if (!node) return;
    var geoms = [];
    var lid = slugToLayerDbId[node.id];
    if (lid) Object.keys(featureLayer).forEach(function (did) { if (featureLayer[did] === lid && _geomSnap[did]) geoms.push(_geomSnap[did]); });
    var b = geoms.length ? geomsBounds(geoms) : (typeof layerExtent === 'function' ? layerExtent(node) : null);
    if (!b) { showToast('No features to zoom to'); return; }
    try { beforeMap.fitBounds(b, { padding: 60, bearing: 0, maxZoom: 17 }); } catch (e) {}
    try { if (typeof afterMap !== 'undefined' && afterMap) afterMap.fitBounds(b, { padding: 60, bearing: 0, maxZoom: 17 }); } catch (e) {}
  }
  // Per-row ⌖ zoom button on/off (default ON) — a real setting: node.zoomBtn === false hides it
  // (generateLayers gates on it), persisted as raw_config.zoomBtn on the layer or group row.
  async function onZoomBtnToggle(on) {
    if (!activeLayerId) return;
    var node = findNodeById(layers, activeLayerId); if (!node || node.type === 'section') return;
    if (on) delete node.zoomBtn; else node.zoomBtn = false;
    rerender();
    setStatus('Saving…');
    try {
      if (node.type === 'group') {
        if (!node._dbId) throw new Error('no group id');
        var cg = await db.from('layer_groups').select('raw_config').eq('id', node._dbId).single();
        var rg = (cg.data && cg.data.raw_config) || {};
        if (on) delete rg.zoomBtn; else rg.zoomBtn = false;
        var r1 = await db.from('layer_groups').update({ raw_config: rg }).eq('id', node._dbId); if (r1.error) throw new Error(r1.error.message);
      } else {
        var lid2 = slugToLayerDbId[node.id]; if (!lid2) throw new Error('no layer id');
        var cl = await db.from('layers').select('raw_config').eq('id', lid2).single();
        var rl = (cl.data && cl.data.raw_config) || {};
        if (on) delete rl.zoomBtn; else rl.zoomBtn = false;
        var r2 = await db.from('layers').update({ raw_config: rl }).eq('id', lid2); if (r2.error) throw new Error(r2.error.message);
      }
      setStatus('Saved');
    } catch (e) { console.warn('editing: zoom-button toggle save failed', e); setStatus('Save failed'); }
  }
  async function zoomToAttrSelected() {
    if (!_attrSel.length || typeof beforeMap === 'undefined' || !beforeMap) return;
    await ensureAttrGeoms(_attrSel);
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
    window._msPanelDrag = true;
    function move(ev) {
      panel.style.left = Math.max(0, Math.min(window.innerWidth - 80, ox + (ev.clientX - sx))) + 'px';
      panel.style.top = Math.max(0, Math.min(window.innerHeight - 40, oy + (ev.clientY - sy))) + 'px';
    }
    function up() { window._msPanelDrag = false; document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); document.body.style.userSelect = ''; }
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
  }
  // ── "⇄ Transfer column": copy one column's values into another (e.g. RRname → Label), server-side
  //    in id-batches so 78k-row layers finish without timeouts. Source-empty rows are never touched.
  function toggleTransferPanel() {
    var p9 = document.getElementById('editor-attr-transfer-panel'); if (!p9) return;
    if (_attrReadonly || !_attrSlug || !slugToLayerDbId[_attrSlug]) { setStatus('Transfer works on database-backed layers only'); return; }
    var show = p9.style.display === 'none';
    if (show) {
      var opts = [];
      _attrCols.forEach(function (c) {
        if (c.kind === 'std' && c.field === 'label') opts.push({ v: 'label', t: 'Label' });
        else if (c.kind === 'custom' && c.key) opts.push({ v: c.key, t: c.key });
      });
      ['attr-tr-from', 'attr-tr-to'].forEach(function (id9) {
        var s9 = document.getElementById(id9);
        s9.innerHTML = opts.map(function (o) { return '<option value="' + attrEsc(o.v) + '">' + attrEsc(o.t) + '</option>'; }).join('');
      });
      document.getElementById('attr-tr-to').value = 'label';
      document.getElementById('attr-tr-status').textContent = '';
    }
    p9.style.display = show ? 'block' : 'none';
  }
  async function runColumnTransfer() {
    var from = document.getElementById('attr-tr-from').value, to = document.getElementById('attr-tr-to').value;
    var onlyEmpty = document.getElementById('attr-tr-empty').checked;
    var st9 = document.getElementById('attr-tr-status');
    var slug9 = _attrSlug, lid = slug9 && slugToLayerDbId[slug9];
    if (!lid) { st9.textContent = 'No database layer.'; return; }
    if (from === to) { st9.textContent = 'Pick two different columns.'; return; }
    if (!confirm('Copy "' + from + '" into "' + to + '"' + (onlyEmpty ? ' where "' + to + '" is empty' : ' — OVERWRITING existing values') + '?\n\nThis changes the layer everywhere it is used.')) return;
    try {
      st9.textContent = 'Listing rows…';
      var idr = await db.rpc('ms_layer_ids', { p_layer: lid, p_passthrough_key: null });
      if (idr.error) throw new Error(idr.error.message);
      var ids = idr.data || [], changed = 0;
      for (var i9 = 0; i9 < ids.length; i9 += 3000) {
        var r9 = await db.rpc('ms_transfer_column', { p_layer: lid, p_from: from, p_to: to, p_ids: ids.slice(i9, i9 + 3000), p_only_empty: onlyEmpty });
        if (r9.error) throw new Error(r9.error.message + (/function|does not exist/.test(r9.error.message) ? ' — run sql/setup/query-ops-setup.sql first (adds ms_transfer_column)' : ''));
        changed += (r9.data || 0);
        st9.textContent = 'Transferring… ' + nfmt(Math.min(i9 + 3000, ids.length)) + '/' + nfmt(ids.length);
      }
      st9.textContent = '✓ ' + nfmt(changed) + ' rows updated — reloading table…';
      openAttributeTable(slug9);
    } catch (e9) { st9.textContent = 'Failed: ' + e9.message; }
  }
  function hideAttrModal() { _attrLoadGen++; var m = document.getElementById('editor-attr-modal'); if (m) m.style.display = 'none'; _attrSlug = null; setAttrHover(null, false); clearAttrHighlight(); updateAttrZoomBtn(); updateAttrDelBtn(); }   // gen bump ABORTS an in-flight load — Close always works, even mid-load of a huge layer

  /* ── FEATURES LIST (Rung 1) ───────────────────────────────────────────────
     A docked, lightweight list of a layer's features (icon + label). Opens from the ▦ icon;
     "Expand" hands off to the full attribute table (openAttributeTable). Reuses the attr module
     state + map highlight/hover/zoom helpers, so selection and glow behave exactly like the table. */
  function injectFeaturesList() {
    if (document.getElementById('editor-flist')) return;
    var st = document.createElement('style');
    st.textContent =
      '#editor-flist{position:fixed;z-index:3990;width:300px;background:#fff;border:1px solid #c9bfe8;border-radius:6px;box-shadow:0 3px 16px rgba(0,0,0,0.18);display:none;flex-direction:column;overflow:hidden;font-family:"Source Sans Pro",Arial,sans-serif;}' +
      '#flist-head{display:flex;align-items:center;gap:6px;padding:9px 10px;border-bottom:1px solid #ececec;}' +
      '#flist-title{font-weight:700;color:#2b3a4a;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;min-width:0;}' +
      '.flist-hbtn{font-size:12px;padding:3px 9px;border:1px solid #bbbbbb;border-radius:4px;background:#f2f2f2;cursor:pointer;white-space:nowrap;}' +
      '.flist-hbtn:disabled{opacity:0.45;cursor:default;}' +
      '#flist-close{cursor:pointer;color:#333333;font-size:18px;font-weight:700;line-height:1;padding:2px 9px;border:1px solid #bbbbbb;border-radius:3px;background:#f2f2f2;}' +
      '#flist-close:hover{background:#fdeaea;color:#b4453a;border-color:#e0b4b4;}' +
      '#editor-flist-wrap{flex:1;overflow:auto;position:relative;}' +
      '#editor-flist-table{width:100%;border-collapse:separate;border-spacing:0;font-size:13.5px;table-layout:fixed;}' +
      '#editor-flist-table td{padding:7px 10px;border-bottom:1px solid #f0f0f3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer;box-sizing:border-box;}' +
      '#editor-flist-table tr:hover td{background:#d6f3ff;}' +
      '#editor-flist-table tr.flist-row-sel td{background:#fff5cc;}' +
      '.flist-ico{display:inline-block;width:16px;text-align:center;margin-right:9px;font-size:12px;vertical-align:middle;}' +
      '.flist-lbl{vertical-align:middle;}' +
      '.flist-untitled{color:#aaaaaa;font-style:italic;}' +
      '#editor-flist-foot{padding:7px 12px;border-top:1px solid #ececec;font-size:12px;color:#888888;}';
    document.head.appendChild(st);
    var el = document.createElement('div'); el.id = 'editor-flist';
    el.innerHTML =
      '<div id="flist-head">' +
        '<b id="flist-title">Features</b>' +
        '<button id="flist-zoom" class="flist-hbtn" title="Zoom the map to the selected feature" disabled>&#9673; Zoom</button>' +
        '<button id="flist-expand" class="flist-hbtn" title="Open the full attribute table">&#8599; Expand</button>' +
        '<span id="flist-close" title="Close">&times;</span>' +
      '</div>' +
      '<div id="editor-flist-wrap"><table id="editor-flist-table"><tbody id="editor-flist-tbody"></tbody></table></div>' +
      '<div id="editor-flist-foot"></div>';
    document.body.appendChild(el);
    document.getElementById('flist-close').addEventListener('click', hideFeaturesList);
    document.getElementById('flist-zoom').addEventListener('click', zoomToAttrSelected);
    document.getElementById('flist-expand').addEventListener('click', function () {
      var slug = _flistSlug;
      el.style.display = 'none';   // list yields to the full table (they share one selection)
      if (slug) openAttributeTable(slug);
    });
    var tb = document.getElementById('editor-flist-tbody');
    tb.addEventListener('click', function (e) {
      var tr = e.target.closest('tr[data-fid]'); if (!tr) return;
      selectAttrRow(tr.getAttribute('data-fid'), e.ctrlKey || e.metaKey);   // shared: updates _attrSel + map highlight
      syncFlistSel(); updateFlistZoom();
    });
    tb.addEventListener('mouseover', function (e) { var tr = e.target.closest('tr[data-fid]'); setAttrHover(tr ? tr.getAttribute('data-fid') : null, false); });
    tb.addEventListener('mouseleave', function () { setAttrHover(null, false); });
    window.addEventListener('resize', function () { if (el.style.display !== 'none') dockFeaturesList(); });   // keep it docked + full-height on resize
  }
  function flistRowHtml(r) {
    if (!r) return '<tr class="flist-ghost"><td style="color:#bbbbbb;">…</td></tr>';
    var sel = _attrSel.indexOf(String(r.feature_id)) > -1;
    var lbl = (r.label == null || r.label === '') ? '<span class="flist-untitled">(untitled)</span>' : attrEsc(r.label);
    return '<tr data-fid="' + attrEsc(r.feature_id) + '"' + (sel ? ' class="flist-row-sel"' : '') + '><td title="' + attrEsc(r.label || '') + '">' + _flistIcon + '<span class="flist-lbl">' + lbl + '</span></td></tr>';
  }
  function syncFlistSel() {
    var tb = document.getElementById('editor-flist-tbody'); if (!tb) return;
    Array.prototype.forEach.call(tb.querySelectorAll('tr[data-fid]'), function (tr) { tr.classList.toggle('flist-row-sel', _attrSel.indexOf(tr.getAttribute('data-fid')) > -1); });
  }
  function updateFlistZoom() { var b = document.getElementById('flist-zoom'); if (b) b.disabled = !_attrSel.length; }
  function flistLayerIcon(node) {
    var col = (node && node.iconColor) || (node && node.paint && typeof node.paint[colorKeyFor(node.type)] === 'string' && node.paint[colorKeyFor(node.type)]) || '#3bb2d0';
    var t = node && node.type;
    var glyph = t === 'line' ? '━' : (t === 'circle' ? '●' : '■');   // line / point / polygon
    return '<span class="flist-ico" style="color:' + col + ';">' + glyph + '</span>';
  }
  function dockFeaturesList() {
    var el = document.getElementById('editor-flist'); if (!el) return;
    var anchor = document.getElementById('layers-panel-content') || document.querySelector('.editor-sidebar') || document.querySelector('#sidebar');
    var r = anchor ? anchor.getBoundingClientRect() : { right: 470, top: 96 };
    var top = Math.round(Math.max(8, r.top));
    // fill down to just above the bottom timeline (or the viewport floor if there isn't one)
    var tl = document.querySelector('.timeline');
    var bottom = (tl && tl.offsetHeight) ? Math.round(tl.getBoundingClientRect().top - 8) : (window.innerHeight - 14);
    el.style.left = Math.round(r.right + 6) + 'px';
    el.style.top = top + 'px';
    el.style.height = Math.max(240, bottom - top) + 'px';
  }
  function hideFeaturesList() {
    _attrLoadGen++;   // aborts an in-flight list load
    var el = document.getElementById('editor-flist'); if (el) el.style.display = 'none';
    _flistSlug = null; _attrSlug = null;
    setAttrHover(null, false); clearAttrHighlight();
  }
  async function loadFlistRows(lid, gen) {
    // fast path: reuse the tier-2 Parquet sidecar if it's fresh (instant for big layers)
    if (window.MSBigTable) {
      try {
        var rcq = await db.from('layers').select('raw_config').eq('id', lid).single();
        if (gen !== _attrLoadGen) return null;
        var rc = (rcq.data && rcq.data.raw_config) || {};
        if (rc.attrParquet && !rc.attrParquetDirty && rc.attrParquetRows <= ATTR_LOAD_CAP) {
          var cq = await db.from('features').select('feature_id', { count: 'exact', head: true }).eq('layer_id', lid);
          if (gen !== _attrLoadGen) return null;
          if (((cq && cq.count) || 0) === rc.attrParquetRows) {
            var srows = await MSBigTable.loadAll(lid, rc.attrParquet, rc.attrParquetAt);
            if (gen !== _attrLoadGen) return null;
            return srows;
          }
        }
      } catch (e) {}
    }
    // fallback: stream just feature_id + label (light — no geometry, no custom fields)
    var out = [];
    for (var from = 0; from < 1000000; from += 1000) {
      var res = await db.from('features').select('feature_id, label').eq('layer_id', lid).order('feature_id').range(from, from + 999);
      if (gen !== _attrLoadGen) return null;
      if (res.error) throw new Error(res.error.message);
      Array.prototype.push.apply(out, res.data || []);
      if (from === 0 && out.length) { _attrRows = out.slice(); rebuildFlistIndex(); renderFlist(); document.getElementById('editor-flist-foot').textContent = 'Loading ' + nfmt(out.length) + '…'; }
      if (!res.data || res.data.length < 1000) break;
      if (out.length >= ATTR_LOAD_CAP) break;
    }
    return out;
  }
  function rebuildFlistIndex() { _attrById = {}; _attrRows.forEach(function (r) { _attrById[String(r.feature_id)] = r; }); }
  function renderFlist() {
    var tbody = document.getElementById('editor-flist-tbody'), wrap = document.getElementById('editor-flist-wrap');
    if (!_flistWin && window.MSAttrWindow) {
      _flistWin = new MSAttrWindow({ scrollEl: wrap, tbody: tbody, renderRow: flistRowHtml, colCount: function () { return 1; } });
    }
    if (_flistWin) { _flistWin._measured = false; _flistWin.setRows(_attrRows, true); }
    else tbody.innerHTML = _attrRows.slice(0, 500).map(flistRowHtml).join('');
  }
  async function openFeaturesList(slug) {
    var node = slug && findNodeById(layers, slug); if (!node) return;
    var lid = slugToLayerDbId[slug];
    if (!lid) { setStatus('No stored data for this layer'); return; }
    injectFeaturesList();
    var el = document.getElementById('editor-flist');
    document.getElementById('flist-title').textContent = node.label || 'Features';
    _flistSlug = slug; _attrSlug = slug; _attrReadonly = false;
    _flistIcon = flistLayerIcon(node);
    _attrSel = []; _attrById = {}; _attrRows = [];
    clearAttrHighlight(); ensureAttrHlLayers(); ensureAttrMapHover();
    el.style.display = 'flex'; dockFeaturesList();
    document.getElementById('editor-flist-tbody').innerHTML = '<tr><td style="padding:12px;color:#999999;">Loading…</td></tr>';
    document.getElementById('editor-flist-foot').textContent = '';
    updateFlistZoom();
    var gen = ++_attrLoadGen;
    var rows;
    try { rows = await loadFlistRows(lid, gen); } catch (e) { document.getElementById('editor-flist-tbody').innerHTML = '<tr><td style="padding:12px;color:#b4453a;">Failed to load features.</td></tr>'; return; }
    if (rows == null || gen !== _attrLoadGen) return;   // closed / superseded
    _attrRows = rows; rebuildFlistIndex();
    if (!rows.length) {
      document.getElementById('editor-flist-tbody').innerHTML = '<tr><td style="padding:12px;color:#999999;">No listed features for this layer.</td></tr>';
      document.getElementById('editor-flist-foot').textContent = '0 features';
      return;
    }
    renderFlist();
    document.getElementById('editor-flist-foot').textContent = nfmt(rows.length) + ' feature' + (rows.length === 1 ? '' : 's');
  }
  async function saveAttrCustomCell(fid, key, value) {
    var cf = _attrCustom[fid];
    if (!cf) { cf = _attrCustom[fid] = {}; var row0 = findAttrRow(fid); if (row0) row0.custom_fields = cf; }   // link a fresh object back to the row so re-sort shows the edit
    var v = value.trim();
    if (v === '') delete cf[key];
    else if (/^-?\d+(\.\d+)?$/.test(v)) cf[key] = Number(v);   // keep numbers numeric
    else cf[key] = value;
    setStatus('Saving…');
    try { var r = await db.from('features').update({ custom_fields: Object.keys(cf).length ? cf : null }).eq('feature_id', fid); if (r.error) throw new Error(r.error.message); setStatus('Saved'); scheduleAttrRebake(); }
    catch (e) { setStatus('Save failed'); }
  }
  async function saveAttrCell(fid, field, value) {
    var v = (value === '') ? null : value, upd = {}; upd[field] = v;
    setStatus('Saving…');
    try { var r = await db.from('features').update(upd).eq('feature_id', fid); if (r.error) throw new Error(r.error.message); setStatus('Saved'); scheduleAttrRebake(); }
    catch (e) { setStatus('Save failed'); return; }
    var row = findAttrRow(fid); if (row) row[field] = v;   // keep the in-memory model in sync so a re-sort reflects the edit
    var did = 'db-' + fid, m = featureMeta[did];   // mirror into MapboxDraw meta + the open feature panel
    if (m) {
      if (field === 'label') m.label = v || ''; else if (field === 'description') m.notes = v || '';
      else if (field === 'start_date') m.start = v || ''; else if (field === 'end_date') m.end = v || '';
      if (selectedDrawId === did) showFeaturePanel(did);
      if (field === 'label') {   // label edited from the table → open bubble + map labels track it live too
        if (_refreshOpenPill) _refreshOpenPill(did);
        var nd = _attrSlug ? findNodeById(layers, _attrSlug) : null;
        if (nd && nd.labels && (nd.labels.field || 'label') === 'label') try { applyLabelLayers(nd); } catch (e) {}
      }
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
    // by-column styling: buildLayerPaint writes plain values over the expressions — keep them when an
    // unrelated property changes; moving the MATCHING control explicitly EXITS that by-column mode.
    var _ck = colorKeyFor(node.type);
    var _colorExpr = (node.colorBy && node.paint && Array.isArray(node.paint[_ck])) ? node.paint[_ck] : null;
    var _ok2 = numByKeys(node, 'opacity')[0];
    var _opExpr = (node.opacityBy && node.paint && Array.isArray(node.paint[_ok2])) ? node.paint[_ok2] : null;
    var _tk2 = numByKeys(node, 'thickness')[0];
    var _thExpr = (node.thicknessBy && node.paint && Array.isArray(node.paint[_tk2])) ? node.paint[_tk2] : null;
    node.paint = buildLayerPaint(node.type, color, op, outline, outlineVis, width, radius);
    if ((field === 'opacity' || field === 'fillVisible') && node.opacityBy) {
      node.opacityBy = null;
      var _obSel = document.getElementById('elp-opacityby'); if (_obSel) _obSel.value = '';
      clearStyleMetaRC(slugToLayerDbId[node.id], 'opacityBy');
    } else if (_opExpr) { node.paint[_ok2] = _opExpr; }
    if ((field === 'width' || field === 'radius') && node.thicknessBy) {
      node.thicknessBy = null;
      var _tbSel = document.getElementById('elp-thickby'); if (_tbSel) _tbSel.value = '';
      clearStyleMetaRC(slugToLayerDbId[node.id], 'thicknessBy');
    } else if (_thExpr) { node.paint[_tk2] = _thExpr; }
    if (field === 'color' && node.colorBy) {
      node.colorBy = null;   // user chose one colour → back to single-color mode (persisted below via saveLayerStyle + meta cleanup)
      var _cbSel = document.getElementById('elp-colorby'); if (_cbSel) _cbSel.value = '';
      var _cbInfo = document.getElementById('elp-colorby-info'); if (_cbInfo) _cbInfo.textContent = '';
      var _mcIcon = document.querySelector('.layer-list-row[data-node-id="' + node.id + '"] label i'); if (_mcIcon) _mcIcon.classList.remove('multicolor-icon');   // gradient icon → single colour
      (function (lid) {
        if (!lid) return;
        db.from('layers').select('raw_config').eq('id', lid).single().then(function (cur) {
          var rc = (cur.data && cur.data.raw_config) || {}; delete rc.colorBy;
          return db.from('layers').update({ raw_config: rc }).eq('id', lid);
        }).then(function () {}, function () {});
      })(slugToLayerDbId[node.id]);
    } else if (_colorExpr) {
      node.paint[_ck] = _colorExpr;
    }
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
        if (ml.type === 'fill') {
          // outline lifecycle, LIVE: width ≤ 1 → native fill-outline only; width > 1 → a stroke line
          // layer owns the outline (native blanked) — created/removed here so the preview always
          // matches what the viewer renders from this same paint.
          var sid = node.id + '-stroke-' + pair[0];
          var wantStroke = fillStrokeWanted(tp);
          try { m.setPaintProperty(id, 'fill-outline-color', (wantStroke || tp['line-opacity'] === 0) ? 'rgba(0,0,0,0)' : (tp['fill-outline-color'] || node.iconColor || '#3bb2d0')); } catch (e) {}
          if (wantStroke && !m.getLayer(sid)) {
            var sc2 = { id: sid, type: 'line', source: node.id + '-' + pair[0], paint: {}, layout: { 'line-cap': 'round', 'line-join': 'round' } };
            if (node['source-layer']) sc2['source-layer'] = node['source-layer'];
            try { addMapLayer(m, sc2, editorCurrentDate()); } catch (e) {}
          }
          if (!wantStroke && m.getLayer(sid)) { try { m.removeLayer(sid); } catch (e) {} }
          // inline hover-dim survives live opacity edits: re-wrap the plain number the generic loop just set
          if (node.highlight === true && typeof tp['fill-opacity'] === 'number' && typeof hoverInlinePaint === 'function') {
            try { m.setPaintProperty(id, 'fill-opacity', hoverInlinePaint(node, { 'fill-opacity': tp['fill-opacity'] })['fill-opacity']); } catch (e) {}
          }
          if (m.getLayer(sid)) {
            if (tp['fill-outline-color'] != null) { try { m.setPaintProperty(sid, 'line-color', tp['fill-outline-color']); } catch (e) {} }
            try { m.setPaintProperty(sid, 'line-width', tp['line-width'] != null ? tp['line-width'] : FILL_BORDER_DEFAULT); } catch (e) {}
            if (tp['line-opacity'] != null) { try { m.setPaintProperty(sid, 'line-opacity', tp['line-opacity']); } catch (e) {} }
          }
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
            if (node.iconColor && !node.colorBy) f.properties.color = node.iconColor;   // colour-by: per-feature colors stay
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
