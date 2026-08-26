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

/* keymatch-ok: colorBy.present · keymatch-ok: colorBy.absent — presence-mode colour-by only,
   which 3 of 17 configs use; absent on the other 14 by design.
   keymatch-ok: colorBy.Features · keymatch-ok: colorBy.Checkboxes — NOT real reads. These come
   from find-key-mismatch's alias tracking, which is file-wide rather than scope-aware, so a short
   alias reused elsewhere in this file drags unrelated property reads in. Recorded rather than
   silenced so the next person knows it is a limit of the tool, not a config key. */

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
  var _touchTimer = null, _touchXY = null, _touchOver = null;   // touch reorder state (8/25)

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
      var bundle = await ConfigLoader.fetchProjectBundle(db, projectId, { shared: true });   // boot
      var maxSort = 0, sMap = {}, gMap = {};
      (bundle.sections || []).forEach(function (s) { if (s.slug != null) sMap[s.slug] = s.id; if (s.sort_order > maxSort) maxSort = s.sort_order; });
      (bundle.groups || []).forEach(function (g) { if (g.slug != null) gMap[g.slug] = g.id; if (g.sort_order > maxSort) maxSort = g.sort_order; });
      var stMap = {};
      (bundle.projectLayers || []).forEach(function (pl) { if (pl.layers && pl.layers.slug != null) { slugToLayerDbId[pl.layers.slug] = pl.layers.id; stMap[pl.layers.slug] = pl.layers.source_type; } if (pl.sort_order > maxSort) maxSort = pl.sort_order; });
      if (typeof layers !== 'undefined') attachIds(layers, sMap, gMap, stMap);
      nextSort = maxSort + 1;
      loaded = true;
      rerender();   // re-render so enhanceRows wires toggle/draw for now-typed drawn layers
      // THE FOLD (C3): a reload mid-fold would orphan the watch — resume polling any layer
      // still marked 'folding' so it appears live the moment the Action stamps it.
      // (C4): folded layers with delta rows re-show their edits (overlay + tile-hide) after reload.
      try {
        (function scanF(arr) {
          (arr || []).forEach(function (n) {
            if (n.fold_state === 'folding' && slugToLayerDbId[n.id]) pollFoldDone(n, slugToLayerDbId[n.id]);
            // A RE-BAKE never leaves fold_state 'folded', so the line above could not resume its
            // watch after a reload: the owner refreshed, the notification was gone, and there was
            // no way to tell a finished bake from a running one (8/16: "I get the 'folded in the
            // ___' notification. I'm forgetting, what does that mean?… Can you make that clear?").
            // rebakeStartedAt is stamped at dispatch and cleared when new tiles land, so a reload
            // can say "still re-baking, started 9:47 PM" and pick the watch back up.
            if (n.rebakeStartedAt && slugToLayerDbId[n.id] && (!n.tilesGeneratedAt || n.tilesGeneratedAt < n.rebakeStartedAt)) {
              pollFoldDone(n, slugToLayerDbId[n.id], n.tilesGeneratedAt || null, n.rebakeStartedAt);
            }
            if (n.fold_state === 'folded' && slugToLayerDbId[n.id]) restoreFoldDeltas(n);
            if (n.children) scanF(n.children);
          });
        })(typeof layers !== 'undefined' ? layers : []);
      } catch (eFw) {}
      try { healInvisibleOutlines(); } catch (eHo) {}
    } catch (e) { console.warn('editing: could not load project ids', e); }
  }
  // SELF-HEAL (8/14): split-off outline layers stored before the transparent-sentinel fix carry
  // line-color 'rgba(0,0,0,0)' — a line that paints nothing ("I just split off the lines and
  // there is no line"). A transparent line is never a choice (hiding one is line-opacity 0), so
  // any such layer takes its parent's colour — matched when the parent is coloured by column.
  function healInvisibleOutlines(tries) {
    var fix = [], seen = 0, total = 0;
    (function walk(a) { (a || []).forEach(function (n) { total++; if (n.outlineOf) { seen++; if (n.paint && isTransparentColor(n.paint['line-color'])) fix.push(n); } if (n.children) walk(n.children); }); })(typeof layers !== 'undefined' ? layers : []);
    // loadIds can win the race against the map page's own config build, so an early pass sees an
    // EMPTY tree and heals nothing (measured: outlines 0 on a project that has one). Wait for it.
    if (!total && (tries || 0) < 10) { setTimeout(function () { healInvisibleOutlines((tries || 0) + 1); }, 1200); return; }
    // Twelve seconds of an empty tree and it stops trying — on a slower machine, or a slow first
    // load, the outlines simply stay invisible and nothing anywhere says the heal never ran.
    if (!total && window.MSGuard) MSGuard.cliff('outline-heal-giveup', tries || 0, 9,
      'the layer tree never appeared, so transparent outlines were never repaired — outlines may be invisible until a reload');
    try { window.__msHeal = { nodes: total, outlines: seen, broken: fix.length, tries: tries || 0 }; } catch (eW) {}
    // nplus1-ok: one update per BROKEN outline layer, and `fix` is only the outlines whose colour
    // was found transparent — normally empty, occasionally one or two. Each write carries a
    // different paint object, so there is nothing to batch into.
    fix.forEach(function (O) {
      var P = findNodeById(layers, O.outlineOf); if (!P) return;
      var val = fillColorValue(P);
      O.paint = Object.assign({}, O.paint, { 'line-color': val });
      if (P.colorBy) { O.colorBy = JSON.parse(JSON.stringify(P.colorBy)); O.outlineMatchFill = true; }
      if (isTransparentColor(O.iconColor)) O.iconColor = (typeof val === 'string' && /^#[0-9a-fA-F]{6}$/.test(val)) ? val : ((P.iconColor && /^#[0-9a-fA-F]{6}$/.test(P.iconColor)) ? P.iconColor : '#3bb2d0');
      [['left', beforeMap], ['right', (typeof afterMap !== 'undefined' ? afterMap : null)]].forEach(function (pair) {
        var m = pair[1]; if (!m) return;
        try { if (m.getLayer(O.id + '-' + pair[0])) m.setPaintProperty(O.id + '-' + pair[0], 'line-color', val); } catch (e) {}
      });
      var oLid = slugToLayerDbId[O.id]; if (!oLid) return;
      (async function () {
        try {
          var cur = await db.from('layers').select('raw_config').eq('id', oLid).single();
          var orc = (cur.data && cur.data.raw_config) || {};
          if (O.colorBy) { orc.colorBy = O.colorBy; orc.outlineMatchFill = true; }
          var up = await db.from('layers').update({ paint: O.paint, color: O.iconColor, raw_config: orc }).eq('id', oLid);
          if (up.error) throw new Error(up.error.message);
          console.log('[heal] outline', O.id, 'repaired from', P.id);
          try { rerender(); } catch (e) {}
        } catch (e) { console.warn('editing: outline heal save failed', e && e.message); }
      })();
    });
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
  // fold_state is consumed-but-unmapped: the client READS it (configLoader puts it on the leaf)
  // but must never write it back — not as a column, and not echoed into raw_config. Only the
  // fold itself (harness/Action/SQL) writes fold_state/parquet_key/r2_bytes.
  var LEAF_CONSUMED = ["id","label","iconColor","checked","type","source","layout","source-layer","paint","highlight","popupStyle","prop","click","infoId","zoomCenter","zoomLevel","zoomLevelLeft","zoomLevelRight","panel","fold_state"];
  var GROUP_CONSUMED = ["type","id","label","children","zoomCenter","zoomLevel","infoId","collapsed","checked"];
  var SECTION_CONSUMED = ["type","id","label","children"];
  var PANEL_CONSUMED = ["encyclopediaBase","nidProp","color","render"];
  function rawFrom(node, consumed) { var raw = {}; Object.keys(node).forEach(function (k) { if (consumed.indexOf(k) === -1) raw[k] = node[k]; }); return raw; }

  // DERIVED IDENTITY IS NOT PERSISTED (8/20, bug-book fix #4). containerId and toggleElement that
  // equal their derivation ('cont-' + slug / the slug) say nothing the slug doesn't — configLoader
  // re-derives both at load — and the STORED copy is the one that drifted on every copy (the
  // June→August untick arc: missing in June, stored as the fix, drifted by August). One helper,
  // called at every place a layer's raw_config is written, so a fifth write path added later
  // inherits the rule by calling the same function all its siblings do. A value that DIFFERS from
  // the derivation is deliberate and still persists — this strips redundancy, never intent.
  /* ONE KEY, ATOMICALLY (8/22). Every settings save used to read `raw_config`, change one key and
     write the whole blob back. Two of those overlapping lose one of the keys, silently — measured,
     not assumed: `rawconfig-lost-update-gate` drives the real settings panel and the timeline range
     vanishes while the logo link survives, with no error anywhere.
     `ms_patch_project_config` does the read and the write in one statement, so nothing can slip
     between them. It takes a PATH rather than an object because jsonb `||` merges only at the top
     level — patching `{features:{header:true}}` that way would replace the whole `features` object,
     trading a lost key for a lost subtree.
     Returns the supabase-shaped `{ data, error }` the call sites already handle. */
  async function patchProjectConfig(patch) {
    /* The boot bundle carries this row, so a write makes it stale. Only two boot callers read it
       and neither runs again after this point — but a cache nobody invalidates is a cache waiting
       to be wrong when a third caller appears. */
    try { if (window.ConfigLoader && ConfigLoader.invalidateBundle) ConfigLoader.invalidateBundle(); } catch (e) {}
    return await db.rpc('ms_patch_project_config', { p_id: projectId, p_patch: patch });
  }
  async function patchLayerConfig(layerId, patch) {
    try { if (window.ConfigLoader && ConfigLoader.invalidateBundle) ConfigLoader.invalidateBundle(); } catch (e) {}
    return await db.rpc('ms_patch_layer_config', { p_id: layerId, p_patch: patch });
  }
  function stripDerivedIdentity(raw, slug) {
    if (!raw) return raw;
    if (raw.containerId === 'cont-' + slug) delete raw.containerId;
    if (raw.toggleElement === slug) delete raw.toggleElement;
    return raw;
  }

  function leafRow(node) {
    var raw = stripDerivedIdentity(rawFrom(node, LEAF_CONSUMED), node.id);
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
      // EVERY layer must name its owner. layers_insert is `with check (user_id = auth.uid())`,
      // so an ownerless row is refused outright — which is what broke every import (owner report
      // 8/7: "Import failed: new row violates row-level security policy for table layers").
      // It is also why older imports left invisible layers behind: before that policy tightened
      // they inserted fine with user_id NULL, then failed ms_layer_writable forever after — the
      // orphan debris cleaned up on 8/6 came from exactly this row.
      user_id: userId || null,
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
    // OWNERLESS-LAYER GUARD (8/14, "Import failed: … row-level security policy for table
    // layers"): userId is cached ONCE at boot — a tab that booted moments after a laptop woke
    // (no network yet) caches null forever, and every later layer insert ships user_id null:
    // the row passes the INSERT check but fails the read-back, surfacing as an RLS violation.
    // Re-resolve from the LIVE session at insert time; the cache is just a fast path.
    if (table === 'layers' && !row.user_id) {
      try {
        var sNow = await db.auth.getSession();
        if (sNow.data && sNow.data.session) { userId = sNow.data.session.user.id; row.user_id = userId; }
      } catch (eS) {}
    }
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
    if (typeof window.__msRenderLegend === 'function') window.__msRenderLegend();   // keep the legend in sync with the layer tree
    scheduleAudit('after a structural change');
  }

  /* ── THE INVARIANT SELF-AUDIT (bug book fix #1, 8/19) ────────────────────────────────
     Every structural operation in this file — addItem, import, merge, copy, delete, outline
     split/unsplit, re-parent, paste — ends by calling rerender(). That makes rerender the ONE
     seam where "a structural change just finished" is true, so the audit hooks there instead of
     at fifteen separate call sites that would drift apart the moment a sixteenth is added
     (hooking each site individually is the same duplicate-owner mistake the audit exists to find).

     Debounced, because rerender also fires for ordinary panel refreshes; deduped, because the
     same latent finding would otherwise print on every render. Nothing here can throw into the
     caller and nothing here writes: it reads the tree, reports, and returns. */
  var _auditT = null, _auditSeen = {};
  function scheduleAudit(why) {
    if (typeof MSAudit === 'undefined') return;          // audit.js not on this page — silently inert
    clearTimeout(_auditT);
    _auditT = setTimeout(function () { runAudit(why); }, 900);
  }
  // The tree carries every raw_config key spread onto each node (configLoader.leafFromRow), so a
  // node can stand in for its row for the rules that read raw_config. The rules that need real
  // COLUMNS the tree never carries (user_id, the project_layers links) are skipped explicitly —
  // the offline census over the database is where those are judged.
  function nodesAsRows() {
    var rows = [];
    (function walk(a) {
      (a || []).forEach(function (n) {
        if (!n) return;
        if (n.children) { walk(n.children); return; }
        var st = null;
        if (n.source && n.source.type === 'geojson') st = 'geojson-supabase';
        else if (n.source && n.source.type === 'vector') st = 'vector-tiles-url';
        rows.push({
          id: slugToLayerDbId[n.id] || n.id, slug: n.id, type: n.type, source_type: st,
          source_url: (n.source && ((n.source.tiles && n.source.tiles[0]) || n.source.url)) || null,
          paint: n.paint, user_id: '(not in tree)', raw_config: n
        });
      });
    })(typeof layers !== 'undefined' ? layers : []);
    return rows;
  }
  function runAudit(why, opts) {
    if (typeof MSAudit === 'undefined') return null;
    var o = opts || {};
    try {
      var tree = (typeof layers !== 'undefined') ? layers : [];
      var findings = []
        .concat(MSAudit.checkRows({ layers: nodesAsRows(), skip: ['layer-ownerless', 'link-parent-missing', 'stats-unstamped', 'sort-order-broken', 'derived-identity-stored'] }))   // these need the real ROW: the tree carries no feature_count/data_bytes/project_layers, and its nodes hold containerId/toggleElement because the loader DERIVED them — which is the opposite of the defect that rule looks for
        .concat(MSAudit.checkTree(tree, {}))
        .concat(MSAudit.checkLive({ layers: tree, map: (typeof beforeMap !== 'undefined') ? beforeMap : null }));
      if (!o.full) {
        findings = findings.filter(function (f) {
          var k = f.rule + '|' + f.subject;
          if (_auditSeen[k]) return false;
          _auditSeen[k] = 1;
          return true;
        });
      }
      return MSAudit.report(findings, why);
    } catch (e) { console.warn('audit run failed', e); return null; }
  }
  // console seam: MSAuditRun() re-reports EVERYTHING (not just what's new since the last render)
  try { window.MSAuditRun = function (opts) { return runAudit('manual', Object.assign({ full: true }, opts || {})); }; } catch (e) {}

  function uid() { return 'new-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5); }
  var LAYER_COLORS = ['#4a9eff', '#e8553e', '#3bb273', '#b56cd6', '#e8a33e', '#3ec0d0', '#d64576'];
  function nextColor() {
    // Counts ALL data leaves, not just un-baked geojson ones (8/7). The old count skipped
    // tiled layers, so on a map whose layers get baked the count was forever 0 and every new
    // import wore palette slot 0 — the owner: "every time I add CShapes, it's blue." The
    // colours were never random; the cycle just never advanced.
    var n = 0;
    (function count(arr) { (arr || []).forEach(function (x) { if (['fill', 'line', 'circle'].indexOf(x.type) > -1) n++; if (x.children) count(x.children); }); })(typeof layers !== 'undefined' ? layers : []);
    return LAYER_COLORS[n % LAYER_COLORS.length];
  }
  function makeNode(type, name) {
    var id = uid();
    // a divider IS a section row (same table, same drag/rename/delete plumbing) that renders as
    // plain text — msDivider rides in raw_config and round-trips through synthesize (user 8/12:
    // "simply text, that I can drag between items … to delineate Raw Layers")
    if (type === 'divider') return { type: 'section', msDivider: true, id: id, label: name, caretId: 'caret-' + id, containerId: 'cont-' + id, children: [] };
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
      if (n.msDivider) return;   // dividers hold nothing — never a parent option
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
        if (node._dbId) {
          // FK-CASCADE GUARD (7/22 — THE vanishing-groups root cause): deleting a SECTION row
          // CASCADE-DELETED every layer_groups row inside it (cascade proven by direct test),
          // even though the app had moved the children out in the tree — the session kept
          // showing groups that no longer existed in the DB, and the next load was flat.
          // Detach ALL DB dependents FIRST; only then delete the now-childless container row.
          if (node.type === 'section') {
            var dg1 = await db.from('layer_groups').update({ section_id: null }).eq('section_id', node._dbId); if (dg1.error) throw new Error(dg1.error.message);
            var dg2 = await db.from('project_layers').update({ section_id: null }).eq('section_id', node._dbId); if (dg2.error) throw new Error(dg2.error.message);
          } else {
            var dg3 = await db.from('project_layers').update({ group_id: null }).eq('group_id', node._dbId); if (dg3.error) throw new Error(dg3.error.message);
          }
          var dc = await db.from(node.type === 'group' ? 'layer_groups' : 'layer_sections').delete().eq('id', node._dbId); if (dc.error) throw new Error(dc.error.message);
        }
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
            } catch (e) { setStatus('Save failed'); showToast('Undo failed to save: ' + (e && e.message ? e.message : 'error')); }
            kids.forEach(function (k) { removeFromTree(layers, k); });   // pull them back out of wherever they landed
            cnode.children = kids;
            var a = arr || layers; a.splice(Math.min(idx, a.length), 0, cnode);
            rerender(); await persistOrder();
          }
          async function reremove() {
            // REDO of a container delete is DESTRUCTIVE and used to replay with no confirmation —
            // a stray Ctrl+Y could silently delete a group again (7/22). Ask, like the original did.
            if (!window.confirm('Redo: delete "' + (cnode.label || ctype) + '" again? Its contents move out (not deleted).')) throw new Error('cancelled');
            var l2 = locate(layers, cnode);
            if (l2) l2.arr.splice.apply(l2.arr, [l2.idx, 1].concat(cnode.children || []));
            else removeFromTree(layers, cnode);
            if (cnode._dbId) {
              try {
                // same FK-cascade guard as the primary delete path (see onDelete).
                // These detach-then-delete writes MUST report: if a detach silently changes nothing
                // the delete on the next line is exactly the FK cascade this guard exists to prevent.
                if (ctype === 'section') {
                  await saveSoft(db.from('layer_groups').update({ section_id: null }).eq('section_id', cnode._dbId), 'detaching groups from the section');
                  await saveSoft(db.from('project_layers').update({ section_id: null }).eq('section_id', cnode._dbId), 'detaching layers from the section');
                } else {
                  await saveSoft(db.from('project_layers').update({ group_id: null }).eq('group_id', cnode._dbId), 'detaching layers from the group');
                }
                await saveSoft(db.from(table).delete().eq('id', cnode._dbId), 'deleting the ' + ctype);
              } catch (e) {}
            }
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
          // 8/5 leak fix: if NO map still uses this layer it moves to Trash (layers.deleted_at) —
          // visible on the dashboard, billed until "Delete forever" there. Without this the
          // kept-for-undo row outlived the session as an invisible orphan billing its owner
          // forever. Tolerates the migration not being run yet (see layer-trash-setup.sql).
          try {
            var tr0 = await db.rpc('ms_trash_layer_if_orphaned', { p_layer: lid, p_project: projectId });
            msTrashRpcCheck(tr0);
          } catch (e) {}
        }
        removeMapLayers(node.id);     // the layer is going away — take every companion with it
        removeFromTree(layers, node);
        (function (n, llid, fields, arr, idx) {
          async function readd() {
            if (llid) await saveGuard(db.from('project_layers').insert({ project_id: projectId, layer_id: llid, section_id: fields ? fields.section_id : null, group_id: fields ? fields.group_id : null, sort_order: fields ? fields.sort_order : nextSort++ }), null, 'Undo failed to save').catch(function () {});
            if (llid) await saveSoft(db.from('layers').update({ deleted_at: null }).eq('id', llid), 'restoring the layer from Trash');   // un-trash — pairs with ms_trash_layer_if_orphaned on delete
            if (arr) arr.splice(Math.min(idx, arr.length), 0, n); else layers.push(n);
            rerender(); await loadFeatures();
            if (isTilesetNode(n)) renderTilesetOnMap(n);   // (large geojson layers re-render on reload)
          }
          async function reremove() {
            if (llid) await saveGuard(db.from('project_layers').delete().eq('project_id', projectId).eq('layer_id', llid), null, 'Undo failed to save').catch(function () {});
            if (llid) { try { msTrashRpcCheck(await db.rpc('ms_trash_layer_if_orphaned', { p_layer: llid, p_project: projectId })); } catch (e) {} }   // redo re-trashes, same as the primary path
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
    try {
      if (node.type === 'section')      await saveGuard(db.from('layer_sections').update({ name: name }).eq('id', node._dbId), null, 'Rename failed');
      else if (node.type === 'group')   await saveGuard(db.from('layer_groups').update({ name: name }).eq('id', node._dbId), null, 'Rename failed');
      else { var lid = slugToLayerDbId[node.id]; if (lid) await saveGuard(db.from('layers').update({ name: name }).eq('id', lid), null, 'Rename failed'); }
      node.label = name; rerender();   // persisted → adopt the new name
    } catch (e) { rerender(); }        // failed (saveGuard already surfaced it) → revert the panel to the stored name
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
  // ── divider size (8/13): Small (default, the original look) · Medium · Large (near end-to-end).
  //    Rides in raw_config.msDividerSize on the layer_sections row, like msDivider itself. ──
  function showDividerSizeRow(node) {
    var row = document.getElementById('elp-divsize');
    if (!row) {
      row = document.createElement('div');
      row.id = 'elp-divsize';
      row.style.cssText = 'display:none;margin:2px 0 8px;';
      row.innerHTML = '<div style="font-size:11px;color:#555;margin-bottom:3px;">Size</div>' +
        '<div style="display:flex;gap:5px;">' +
        ['small', 'medium', 'large'].map(function (s) {
          return '<button data-dsz="' + s + '" style="flex:1;padding:5px 0;border:1px solid #bbbbbb;border-radius:4px;background:#fff;color:#333;font:600 12px Source Sans Pro,Arial,sans-serif;cursor:pointer;text-transform:capitalize;">' + s + '</button>';
        }).join('') + '</div>';
      var nameEl = document.getElementById('elp-name');
      if (nameEl && nameEl.parentNode) nameEl.parentNode.insertBefore(row, nameEl.nextSibling);
      row.addEventListener('click', async function (e) {
        var b = e.target && e.target.closest && e.target.closest('button[data-dsz]'); if (!b) return;
        var n = _divSizeNode; if (!n || !n._dbId) return;
        n.msDividerSize = b.getAttribute('data-dsz');
        markDividerSize(n.msDividerSize);
        setStatus('Saving…');
        try {
          var r = await db.from('layer_sections').update({ raw_config: rawFrom(n, SECTION_CONSUMED) }).eq('id', n._dbId);
          if (r.error) throw new Error(r.error.message);
          setStatus('Saved');
        } catch (eS) { setStatus('Save failed: ' + eS.message); }
        rerender();
      });
    }
    _divSizeNode = node;
    markDividerSize(node.msDividerSize || 'small');
    row.style.display = 'block';
  }
  var _divSizeNode = null;
  function markDividerSize(size) {
    var row = document.getElementById('elp-divsize'); if (!row) return;
    row.querySelectorAll('button[data-dsz]').forEach(function (b) {
      var on = b.getAttribute('data-dsz') === size;
      b.style.background = on ? '#5b458f' : '#fff';
      b.style.color = on ? '#fff' : '#333';
      b.style.borderColor = on ? '#5b458f' : '#bbbbbb';
    });
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
      if (window.__msEditLocked) return;   // locked map: the features list (and its Expand → editable table) stays off
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
      // 7/21: editing-only badge + italic name — this layer is stripped from VIEW mode
      // (raw_config.editorOnly); the sidebar marks it so the owner can spot it at a glance.
      if (enNode && enNode.editorOnly) updateEditorOnlyRow(enNode, row);
      if (enNode) updateFoldingRow(enNode, row);   // amber cloud badge while a fold is processing
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

      // ── TOUCH reorder (8/25 — the checklist's last item). HTML5 drag events never fire from a
      // touchscreen, so on tablets the list only scrolled. LONG-PRESS (450 ms with a still finger)
      // arms the drag; from there the SAME dropPos/moveNode/persistOrder path runs that the mouse
      // uses — one reorder rule, two input methods. Scroll stays scroll: until armed, touchmove is
      // left alone, and >12 px of drift during the hold cancels the arm (that was a scroll).
      row.addEventListener('touchstart', function (e) {
        if (e.touches.length !== 1) return;
        var t0 = e.touches[0];
        _touchXY = [t0.clientX, t0.clientY];
        if (_touchTimer) clearTimeout(_touchTimer);
        _touchTimer = setTimeout(function () { _touchTimer = null; _dragId = id; row.classList.add('editor-dragging'); }, 450);
      }, { passive: true });
      row.addEventListener('touchmove', function (e) {
        var t1 = e.touches && e.touches[0]; if (!t1) return;
        if (!_dragId) {
          if (_touchTimer && _touchXY && (Math.abs(t1.clientX - _touchXY[0]) > 12 || Math.abs(t1.clientY - _touchXY[1]) > 12)) { clearTimeout(_touchTimer); _touchTimer = null; }
          return;
        }
        e.preventDefault();   // armed: this finger is carrying a row, not scrolling
        var el = document.elementFromPoint(t1.clientX, t1.clientY);
        var over = el && el.closest ? el.closest('.layer-list-row') : null;
        clearDropMarks();
        _touchOver = null;
        if (!over) return;
        var oid = over.getAttribute('data-node-id');
        if (!oid || oid === _dragId) return;
        var tn = findNodeById(layers, oid); if (!tn) return;
        var pos = dropPos(over, tn, t1.clientY);
        over.classList.add(pos === 'into' ? 'editor-drop-into' : (pos === 'before' ? 'editor-drop-before' : 'editor-drop-after'));
        _touchOver = { row: over, id: oid, y: t1.clientY };
      }, { passive: false });
      function msTouchFinish(commit) {
        if (_touchTimer) { clearTimeout(_touchTimer); _touchTimer = null; }
        var dragId = _dragId; _dragId = null;
        row.classList.remove('editor-dragging');
        clearDropMarks();
        var ov = _touchOver; _touchOver = null;
        if (!commit || !dragId || !ov || ov.id === dragId) return;
        var dragNode = findNodeById(layers, dragId), targetNode = findNodeById(layers, ov.id);
        if (!dragNode || !targetNode) return;
        if (moveNode(dragNode, targetNode, dropPos(ov.row, targetNode, ov.y))) { rerender(); persistOrder(); }
      }
      row.addEventListener('touchend', function () { msTouchFinish(true); });
      row.addEventListener('touchcancel', function () { msTouchFinish(false); });
    });
    try { injectStyleRows(); } catch (e) {}   // nested style-category sub-rows (opt-in per layer)
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
    if (dragNode.type === 'section') {                                             // sections + dividers stay top-level
      if (pos === 'into') return false;
      // HOIST (8/13): layer_sections rows have no parent columns, so a section/divider dropped
      // before/after a NESTED row would show nested now and snap top-level on reload. Re-target
      // the drop to the target's top-level ancestor so what you see is what persists.
      var anc = targetNode, ap = findParent(layers, anc);
      while (ap) { anc = ap; ap = findParent(layers, anc); }
      if (anc && anc !== targetNode) { targetNode = anc; if (isAncestor(dragNode, targetNode)) return false; }
    }
    if (pos === 'into' && targetNode.msDivider) pos = 'after';                     // a divider holds nothing
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
    catch (e) {
      console.warn('editing: reorder save failed', e);
      setStatus('Reorder save failed: ' + e.message);
      // LOUD (7/22): a failed persistOrder means the arrangement you SEE (incl. which layers sit in
      // which groups) is NOT saved — a page reload would flatten it. The tiny status line was easy
      // to miss; this must never be silent.
      showToast('⚠ Layer order/grouping did NOT save (' + e.message + '). Your arrangement will be lost on reload — try the move again.', 10000);
    }
  }
  // Where would a drop land on this row? top 30% = before, bottom 30% = after,
  // middle of a container = into it.
  function dropPos(row, targetNode, clientY) {
    var rect = row.getBoundingClientRect();
    var frac = rect.height ? (clientY - rect.top) / rect.height : 0.5;
    var isC = (targetNode.type === 'section' || targetNode.type === 'group') && !targetNode.msDivider;
    return frac < 0.3 ? 'before' : (frac > 0.7 ? 'after' : (isC ? 'into' : 'after'));
  }
  function clearDropMarks() {
    var panel = document.getElementById('layers-panel-content'); if (!panel) return;
    panel.querySelectorAll('.editor-drop-before,.editor-drop-after,.editor-drop-into').forEach(function (el) {
      el.classList.remove('editor-drop-before', 'editor-drop-after', 'editor-drop-into');
    });
  }

  // ── add (insert-on-add) ─────────────────────────────────────────────────────
  /* MERGE (8/18) — the write half of platform/merge.js. It lives in this file because the merge
     needs addItem(), insertOne(), the db handle and projectId, all of which are private here.

     What it does, and deliberately does NOT do:
       • creates ONE new layer via the ordinary add path, so the merged layer is a normal layer in
         every downstream sense (tiles, sidecar, attribute table, styling)
       • copies each source row's geom and custom_fields VERBATIM — msid included, never rewritten
       • writes `source` into custom_fields so identity is (source, msid) and un-merging is a filter
       • never touches the parents
     feature_id is a fresh primary key per row; that is the table's key, not the user's id, and is
     not the thing the owner means by "msids never change". */
  async function runMerge(spec, onStatus, onDone) {
    var say = function (m) { try { onStatus(m); } catch (e) {} };
    var node = null, wroteSoFar = 0;   // hoisted: the failure path has to be able to name what it left behind
    /* RESUME (8/25, checklist item 1). A failed big merge used to start over from zero. The copy
       loop is already keyset-paginated, so resume is a CURSOR, not a redesign: on failure the
       destination layer's own config records { srcKey, si, fid, wrote }, and the next run of the
       SAME merge (same source layers, matched by srcKey) picks that layer up and continues from
       the cursor instead of creating a fresh one. The cursor is the last COMMITTED fid, not the
       read-page fid — an insert that dies mid-page has committed only its earlier slices, and
       resuming from the page end would silently skip the rest of that page. */
    var srcKey = spec.descs.map(function (d) { return d.dataLid; }).sort().join('|');
    var resume = null;
    try {
      /* leafFromRow SPREADS raw_config keys onto the leaf — node.raw_config does not exist at
         runtime (the tilesLabelField note further down learned this the hard way), so the cursor
         is read directly off the node. */
      var flatAll = (typeof flatLayers === 'function' && typeof layers !== 'undefined') ? flatLayers(layers) : [];
      for (var fi = 0; fi < flatAll.length; fi++) {
        var curR = flatAll[fi] && flatAll[fi]._msMergeResume;
        if (curR && curR.srcKey === srcKey) { resume = { node: flatAll[fi], cur: curR }; break; }
      }
    } catch (eRs) {}
    var committedSi = resume ? (resume.cur.si || 0) : 0;
    var committedFid = resume ? (resume.cur.fid == null ? null : resume.cur.fid) : null;
    try {
      var destLid;
      if (resume) {
        node = resume.node;
        destLid = slugToLayerDbId[node.id];
        if (!destLid) throw new Error('the incomplete layer has no database id');
        say('Resuming the earlier merge — ' + (resume.cur.wrote || 0).toLocaleString() + ' rows already copied…');
      } else {
        say('Creating the merged layer…');
        node = await addItem('layer', spec.name || 'Merged layer', null);
        if (!node) throw new Error('could not create the layer');
        destLid = slugToLayerDbId[node.id];
        if (!destLid) throw new Error('the new layer has no database id');
      }

      var totalIn = spec.descs.reduce(function (t, d) { return t + d.count; }, 0), done = 0, wrote = resume ? (resume.cur.wrote || 0) : 0;
      var geomKind = null;   // 'fill' | 'line' | 'circle', from the first geometry copied
      for (var si = committedSi; si < spec.descs.length; si++) {
        var d = spec.descs[si], core = spec.plan.core[d.id];
        var lastFid = (si === committedSi) ? committedFid : null, pageSz = 500;
        for (;;) {
          var q = db.from('features').select('feature_id, geom, label, start_date, end_date, custom_fields')
                    .eq('layer_id', d.dataLid).order('feature_id').limit(pageSz);
          if (lastFid != null) q = q.gt('feature_id', lastFid);
          var r = await q;
          if (r.error) {
            if (pageSz > 25) { pageSz = Math.max(25, Math.floor(pageSz / 4)); say('Heavy rows — retrying in pages of ' + pageSz + '…'); continue; }
            throw new Error('read failed on "' + d.label + '" after ' + wrote + ' rows: ' + r.error.message);
          }
          if (!r.data || !r.data.length) break;
          lastFid = r.data[r.data.length - 1].feature_id;
          var rows = r.data.map(function (f) {
            if (!geomKind && f.geom && f.geom.type) geomKind = GEOM_TO_TYPE[String(f.geom.type).replace(/^Multi/, '')] || null;
            var cf = f.custom_fields || {};
            function pick(sel) {
              if (!sel) return null;
              if (sel === 'label') return f.label;
              if (sel === 'start_date') return f.start_date;
              if (sel === 'end_date') return f.end_date;
              return sel.indexOf('cf:') === 0 ? cf[sel.slice(3)] : null;
            }
            var out = { msid: cf.msid, source: d.label };   // msid VERBATIM; source is the disambiguator
            spec.plan.cols.forEach(function (c) {
              var from = c.from[d.id];
              if (from != null && from !== '') out[c.out] = cf[from];
            });
            var sd = pick(core.__start), ed = pick(core.__end);
            return {
              layer_id: destLid, geom: f.geom,
              label: pick(core.__label) == null ? null : String(pick(core.__label)),
              start_date: normDate(sd), end_date: normDate(ed),
              custom_fields: out
            };
          });
          for (var i = 0; i < rows.length; i += 250) {
            var ins = await db.from('features').insert(rows.slice(i, i + 250));
            if (ins.error) throw new Error('write failed after ' + wrote + ' rows: ' + ins.error.message);
            wrote += Math.min(250, rows.length - i);
            wroteSoFar = wrote;   // the failure path reports how far it got
            /* the resume cursor: the SOURCE fid of the last row this slice committed — r.data and
               rows align 1:1, so the slice ending at i+249 committed source rows up to that index */
            committedFid = r.data[Math.min(i + 249, r.data.length - 1)].feature_id;
            committedSi = si;
          }
          done += r.data.length;
          say('Merging… ' + wrote.toLocaleString() + ' of ' + totalIn.toLocaleString() + ' rows');
          if (r.data.length < pageSz) break;
        }
      }
      // THE MERGED LAYER MUST KNOW ITS SHAPE (owner 8/19: "No shapes or lines, just vertices").
      // Every other write path stamps `type` from the geometry (draw, paste, import) — merge did
      // not, so the layer saved type NULL and configLoader's blank-layer default ('circle')
      // rendered 1,033 merged polygons as a dot at every vertex on the next load.
      if (geomKind && !node.type) {
        node.type = geomKind;
        node.iconType = TILESET_ICON[geomKind] || 'square';
        await saveSoft(db.from('layers').update({ type: geomKind }).eq('id', destLid), 'stamping the merged layer geometry type');   // silently losing this stamp is what drew a merged layer as vertex dots (8/19)
      }
      if (resume) {
        /* the resumed merge finished: drop the cursor and take back the honest-but-alarming
           "— incomplete (N rows)" name the failure path gave it */
        try { await db.rpc('ms_patch_layer_config', { p_id: destLid, p_patch: { _msMergeResume: null } }); delete node._msMergeResume; } catch (eClr) {}
        try {
          var finalName = spec.name || 'Merged layer';
          node.label = finalName;
          await saveSoft(db.from('layers').update({ name: finalName }).eq('id', destLid), 'restoring the merged layer name');
        } catch (eNm) {}
      }
      say('Merged ' + wrote.toLocaleString() + ' rows. Loading…');
      try { await loadFeatures(); } catch (eLF) {}
      rerender();
      try { if (window.MSLayerOrder) MSLayerOrder.putOnTop(node.id); } catch (eLO) {}
      setStatus('Merged ' + wrote.toLocaleString() + ' rows into "' + (spec.name || 'Merged layer') + '"');
      onDone(null);
      // AUTO-TILE BIG MERGES (8/19). Merge is a write path like import and inherits its size rule
      // (#5 in the bug book): past the tile thresholds a merged layer boots as raw geojson — the
      // merged Borders layer was 47.9MB and cost a 45s editor boot. Same thresholds as import's
      // auto-convert; runs AFTER onDone so the user sees the merged layer immediately (seen first,
      // tiled second), and in its own try so a tiling failure can never re-signal the merge.
      if (wrote > (geomKind === 'circle' ? 2000 : 500)) {
        try {
          msProgress('"' + (spec.name || 'Merged layer') + '" is large — baking it to tiles for fast loading…');
          var didT = await rebakeLayerTiles(destLid, 'Auto-converting', true);
          if (didT) msProgress('"' + (spec.name || 'Merged layer') + '" baked to tiles — it loads instantly from the next reload.');
        } catch (eT2) {
          console.warn('merge auto-tile skipped', eT2);
          msProgress('Merged — tile conversion skipped (' + ((eT2 && eT2.message) || eT2) + '). Use the layer panel’s Re-bake button.');
        }
      }
    } catch (e) {
      console.warn('merge failed', e);
      // A merge that dies partway has ALREADY created the destination layer and may have copied
      // thousands of rows into it. Left alone it sits in the sidebar under the name the person
      // chose, looking exactly like a finished merge — so the next thing they do is trust it.
      // Nothing is deleted here (the rows are real, and an error path is the worst place to
      // destroy data); the layer is simply made to say what it is.
      try {
        if (node && node.id) {
          var partialName = (spec.name || 'Merged layer') + ' — incomplete (' + wroteSoFar.toLocaleString() + ' rows)';
          node.label = partialName;
          var plid = slugToLayerDbId[node.id];
          if (plid) await saveSoft(db.from('layers').update({ name: partialName }).eq('id', plid), 'marking the incomplete merge');
          rerender();
        }
      } catch (eMark) { console.warn('could not mark the incomplete merge', eMark); }
      // the RESUME CURSOR — running the same merge again continues from here instead of row zero.
      // Written through the atomic config patch so a concurrent save cannot lose it.
      try {
        var plid2 = node && node.id ? slugToLayerDbId[node.id] : null;
        if (plid2 && wroteSoFar > 0) {
          await db.rpc('ms_patch_layer_config', { p_id: plid2, p_patch: {
            _msMergeResume: { srcKey: srcKey, si: committedSi, fid: committedFid, wrote: wroteSoFar }
          } });
          node._msMergeResume = { srcKey: srcKey, si: committedSi, fid: committedFid, wrote: wroteSoFar };   // spread-onto-leaf shape, so a same-session retry finds it without a reload
        }
      } catch (eCur) { console.warn('could not write the merge resume cursor', eCur); }
      if (window.MSGuard) MSGuard.warn('merge-incomplete',
        'the merge stopped partway — its layer holds only part of the data and is marked "incomplete" in the sidebar; running the same merge again will RESUME it',
        wroteSoFar + ' rows copied before: ' + ((e && e.message) || e));
      setStatus('Merge stopped — the partial layer is marked "incomplete"; run the same merge again to resume it');
      onDone(String(e && e.message || e));
    }
  }
  // a date column can arrive as 1815, "1815", "1815-06-09" or junk — anything unreadable becomes
  // null rather than a wrong date, and shows up in the preview's "no dates mapped" warning
  function normDate(v) {
    if (v == null || v === '') return null;
    var s = String(v).trim();
    if (/^-?\d{1,4}$/.test(s)) { var y = parseInt(s, 10); return (y < 0 ? '-' : '') + String(Math.abs(y)).padStart(4, '0') + '-01-01'; }
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    var d = new Date(s);
    return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }

  async function addItem(type, name, parent) {
    if (typeof layers === 'undefined') return;
    if (idsReady) { try { await idsReady; } catch (e) {} }
    if (!loaded) { setStatus('Still loading — try again'); return; }
    var node = makeNode(type, name);
    var sort = nextSort++;
    setStatus('Saving…');
    try {
      if (type === 'section' || type === 'divider') {   // a divider persists as a layer_sections row (raw_config.msDivider)
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
        // a NEW drawn layer is MapboxDraw-resident from feature #1 — the registry is otherwise only
        // built by loadFeatures' boot pass, so without this a mid-session layer is treated as
        // engine-rendered until reload (style preview no-ops, per-feature delete hides, labels skip)
        if (node.source_type === 'geojson-supabase') _drawLayerSlugs[node.id] = true;
        await insertOne('project_layers', { project_id: projectId, layer_id: layerId, sort_order: sort, section_id: sId, group_id: gId });
      }
      // persisted OK → show it in the tree
      if (parent) { parent.children = parent.children || []; parent.children.push(node); parent.collapsed = false; parent.open = true; if (parent.type === 'group') node.topLayerClass = parent.id; }   // group children need the group's _item class for the ± caret
      else layers.push(node);
      rerender();
      // a new layer belongs on TOP, and written down rather than inferred, so it survives a
      // reload without anyone opening the order panel first (8/18)
      if (type === 'layer' && window.MSLayerOrder) MSLayerOrder.putOnTop(node.id);
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
      if (window.MSLayerOrder) MSLayerOrder.putOnTop(node.id);
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
  // THE editor's current timeline date, as YYYYMMDD — for addMapLayer's filter and every caller
  // that needs "what day is the map showing". One author; `currentMapDate` delegates here.
  //
  // KNOWN DEBT, family E: this reads the date back out of the LABEL'S RENDERED TEXT. The label is
  // a render target, and the moment it is also the source, a formatting change becomes a state
  // change — which is how a NaN boot shipped twice. The real fix is a `currentDate` owned by the
  // slider module with the label as an output only; consolidating the copies is the step before it.
  function editorCurrentDate() {
    // Same order as the engine's getDate: the VALUE the slider owns first, the rendered label only
    // as a fallback. window.__msDate is a plain unix number written by every path that moves the
    // timeline (8/21).
    try {
      if (typeof window.__msDate === 'number' && !isNaN(window.__msDate) && window.moment)
        return parseInt(moment.unix(window.__msDate).format('YYYYMMDD'), 10);
    } catch (e0) {}
    // boot-ok: FALLBACK only — the value above is asked first. Kept so a path that forgets to set
    // it degrades to the old behaviour instead of returning nothing at all.
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
  var _engineWasMulti = {};     // drawId → true if the DB geom was a MultiPolygon
  var _engineOrigMulti = {};    // drawId → the original MultiPolygon, so extra parts survive a save
  var _engineMultiPartIx = {};  // drawId → which part is in draw during a stage-2 shape edit
  var _lastMapClickPt = null;   // lngLat of the latest mousedown — picks the CLICKED part at stage-2 entry
  // STAGE 1 keeps the FULL MultiPolygon in draw — gl-draw renders every part (verified 8/8; the
  // day-one "draw needs a Polygon" conversion showed only part 0 while the !in filter hid ALL
  // parts from the tiles, so clicking a whole-Multi country VANISHED everything but one piece).
  // Vertex editing still needs a Polygon: stage-2 entry swaps in the CLICKED part (multiPartForEdit),
  // and toDbGeom folds the edit back into its slot.
  function multiPartForEdit(drawId, lngLat) {
    var f = null; try { f = draw.get(drawId); } catch (e) {}
    if (!f || !f.geometry || f.geometry.type !== 'MultiPolygon') return;
    var coords = f.geometry.coordinates || [];
    var ix = 0;
    try {
      if (lngLat && window.turf) {
        var pt = turf.point([lngLat.lng, lngLat.lat]);
        for (var i = 0; i < coords.length; i++) if (turf.booleanPointInPolygon(pt, turf.polygon(coords[i]))) { ix = i; break; }
      }
    } catch (e) {}
    _engineMultiPartIx[drawId] = ix;
    var part = { type: 'Polygon', coordinates: coords[ix] || [] };
    try { draw.add({ type: 'Feature', id: drawId, geometry: part, properties: f.properties || {} }); } catch (e) {}
    _geomSnap[drawId] = JSON.parse(JSON.stringify(part));   // fresh baseline — nothing user-edited yet
  }
  function toDbGeom(drawId, geom) {
    if (!_engineWasMulti[drawId] || !geom || geom.type !== 'Polygon') return geom;   // an unconverted Multi passes through whole
    var orig = ((_engineOrigMulti[drawId] || {}).coordinates || []).slice();
    if (!orig.length) return { type: 'MultiPolygon', coordinates: [geom.coordinates] };
    var ix = _engineMultiPartIx[drawId] || 0; if (ix >= orig.length) ix = 0;
    orig[ix] = geom.coordinates;   // the edited part lands back in its own slot; the rest untouched
    return { type: 'MultiPolygon', coordinates: orig };
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
      // boot-ok: this makes a monkey-patch of a GLOBAL function idempotent. Clearing it on
    // style.load would re-wrap the already-wrapped function and run the patch twice per click.
    // The latch is the fix, not the bug — the danger shape is a latch guarding something the
    // style REBUILDS, and window.handlePanelClick is not that.
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
      // boot-ok: same shape — wrapping a global once. Re-running would double-wrap.
    _changeDatePatched = true; var _origCD = window.changeDate;
      window.changeDate = function () {
        var r = _origCD.apply(this, arguments);
        try { disarmEngineEditsOutsideDate(arguments[0]); } catch (eDa) {}   // armed features follow the timeline (8/7)
        try { if (window.moment) applyEditedOverlayDayFilter(parseInt(moment.unix(arguments[0]).format('YYYYMMDD'), 10)); } catch (eOv) {}   // the Done-editing overlay follows it too (8/8)
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
    // Mid-DRAG too (8/8): disarm ran only on release, but a drag can sit on an out-of-range date
    // for seconds with the button down — armed copies and the edited overlay must follow the
    // paint path's date exactly like every engine layer does. (rasterScrub swaps paintDate for a
    // no-op during raster drags; it saves and restores whatever is installed, so this composes.)
    if (!_paintDatePatched && typeof window.paintDate === 'function') {
      // boot-ok: same shape — wrapping a global once. Re-running would double-wrap.
    _paintDatePatched = true; var _origPD = window.paintDate;
      window.paintDate = function () {
        var r2 = _origPD.apply(this, arguments);
        try { disarmEngineEditsOutsideDate(arguments[0]); } catch (eDp) {}
        try { if (window.moment) applyEditedOverlayDayFilter(parseInt(moment.unix(arguments[0]).format('YYYYMMDD'), 10)); } catch (eOp) {}
        return r2;
      };
    }
    // headless-diagnosable arm state (8/8): the editor's arm/disarm internals live in this IIFE,
    // so when "a clicked feature ignores the timeline" the harness could only see pixels, not WHY.
    // Read-only snapshot; costs nothing.
    window.__msArmDebug = function () {
      var metas = {}; Object.keys(_engineEditNode).forEach(function (k) { var m = featureMeta[k] || {}; metas[k] = { start: m.start, end: m.end }; });
      return { patchedCD: _changeDatePatched, patchedPD: _paintDatePatched, editNode: Object.keys(_engineEditNode), metas: metas,
               editing: _editingDraw, edited: Object.keys(_engineEdited), days: _engineEditedDays, editIds: _engineEditIds };
    };
    // ONE map-level click handler per side that queries the editable layers at CLICK time — robust, unlike
    // per-layer handlers that depend on the layer already existing when wiring runs (the flaky "bolting" race).
    // boot-ok: MAP-level handler, not layer-scoped. map.on('click', fn) lives on the Map, so it
    // survives a style rebuild — clearing this on style.load would register a SECOND handler on
    // every basemap switch, which is the doubling this latch exists to prevent.
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
          if (node) onEngineFeatureClick(node, { features: [hit].concat(found.filter(function (f) { return f !== hit; })), lngLat: e.lngLat, ctrl: !!(e.originalEvent && (e.originalEvent.ctrlKey || e.originalEvent.metaKey)) });
        });
      });
    }
  }
  var _selClickLock = false;   // one DOM click can reach BOTH the map-level (745) and per-layer (875) handlers
  function engineFeatureAt(pt) {   // any ENGINE data feature within the grab corridor? (empty-ground test — basemap roads/labels don't count)
    var bx = 10, hit = false;
    [['left', beforeMap], ['right', (typeof afterMap !== 'undefined' ? afterMap : null)]].forEach(function (pr) {
      if (hit) return; var mm = pr[1], sd = pr[0]; if (!mm) return;
      var lids = [];
      (function walk(arr) { (arr || []).forEach(function (n) { try { if (mm.getLayer(n.id + '-' + sd)) lids.push(n.id + '-' + sd); if (mm.getLayer(n.id + '-edited-' + sd)) lids.push(n.id + '-edited-' + sd); } catch (e) {} if (n.children) walk(n.children); }); })(layers);
      if (!lids.length) return;
      try { var fs = mm.queryRenderedFeatures([[pt.x - bx, pt.y - bx], [pt.x + bx, pt.y + bx]], { layers: lids }); if (fs && fs.length) hit = true; } catch (e) {}
    });
    return hit;
  }
  function onEngineFeatureClick(node, e) {
    if (!e.features || !e.features.length) return;
    // 9e (final model, 7/28): CTRL/⌘-click = pure select/deselect toggle — no editing, works with or
    // without a ▦ open. PLAIN click = the edit flow (arm + panel) AND the feature JOINS the selection
    // (attrStarFromMap below — "clicking things selects them", table open or not). Read the modifier
    // from EITHER handler path; the lock stops the same DOM click toggling twice (both handlers fire).
    var ctrl = e.ctrl || !!(e.originalEvent && (e.originalEvent.ctrlKey || e.originalEvent.metaKey));
    if (ctrl) {
      if (_selClickLock) return;
      _selClickLock = true; setTimeout(function () { _selClickLock = false; }, 0);   // clears after both synchronous handlers have run
      // With a ▦ open, ONLY its layer joins the set — prefer that layer's candidate inside the grab
      // corridor (a nearer rail line must not hijack a depot click); none there → ignore the ctrl-click
      // entirely (never edit-arm a foreign feature on ctrl). Bare map: nearest candidate wins.
      var targetSlug = _attrSlug || null, cf = null;
      for (var ci = 0; ci < e.features.length; ci++) {
        var f0 = e.features[ci]; if (f0.id == null) continue;
        var s0 = f0.layer && f0.layer.id ? f0.layer.id.replace(/(-edited)?-(left|right)$/, '') : null;   // -edited overlay (folded engine edits) belongs to its layer
        if (!targetSlug || s0 === targetSlug) { cf = f0; break; }
      }
      if (!cf) {
        // Nothing togglable on the TILES — the clicked feature may be DRAW-resident (pulled for edit:
        // its tile copy is filter-hidden, it renders via gl-draw on top). Toggle it HERE; same
        // open-table layer scoping as everywhere else (7/28 — the "ctrl does nothing on an
        // edit-pulled feature" hole).
        var dHit = null; try { dHit = drawFeatureAt(e.point); } catch (eD) {}
        if (dHit) {
          var dfid = featureToDb[dHit] != null ? String(featureToDb[dHit]) : (String(dHit).indexOf('db-') === 0 ? String(dHit).slice(3) : null);
          var dLyr = featureLayer[dHit], tLyr = _attrSlug ? slugToLayerDbId[_attrSlug] : null;
          if (dfid != null && (!tLyr || dLyr == null || dLyr === tLyr)) {
            if (!MSSel.has(dfid)) { try { var df0 = draw && draw.get ? draw.get(dHit) : null; if (df0 && df0.geometry) { _selGeom[dfid] = df0.geometry; _selGeom[dfid].msWhole = true; } } catch (eG2) {} }
            MSSel.toggle(dfid); setStatus(MSSel.count() + ' selected — ctrl-click to add/remove');
            return;
          }
        }
        _selClickLock = false;   // nothing consumed — release so the draw-side/right-side handlers can act on this same click
        return;
      }
      var cfid = String(cf.id);
      // cache the CLICKED geometry → the highlight paints INSTANTLY (no waiting on the row stream/geom fetch)
      if (cf.geometry) { _selGeom[cfid] = cf.geometry; if (cf.msWholeGeom) _selGeom[cfid].msWhole = true; }
      MSSel.toggle(cfid); setStatus(MSSel.count() + ' selected — ctrl-click to add/remove');
      return;
    }
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

  // ── map-select ⇄ attribute-table sync (7/23): selecting a feature on the MAP stars its row in
  //    an open table for that layer, so a working set can be collected by clicking the map and
  //    sorted to the top with the ★ column. Adds only — never un-stars (no surprise removals). ──
  function attrStarFromMap(node, fid) {
    try {
      if (fid == null || !node) return;
      if (_attrSlug && node.id !== _attrSlug) return;   // a ▦ is open on a DIFFERENT layer → not part of that working set
      var f = String(fid);
      MSSel.add(f);   // add-if-absent — a plain click never UN-selects (MSSel.add is a no-op on members)
      if (!_attrSlug) return;   // bare map (7/28): the feature still joins the selection — there's just no table row to star/scroll
      window.__msAttrStar = { fid: f, len: MSSel.count() };   // observability (tests + debugging)
      var tr = document.querySelector('#editor-attr-tbody tr[data-fid="' + f.replace(/"/g, '') + '"]');
      if (tr && tr.scrollIntoView) tr.scrollIntoView({ block: 'nearest' });
    } catch (e) {}
  }
  // ── THE FOLD · C4: click-to-edit on a FOLDED layer ────────────────────────
  // No live rows — the clicked feature is pulled from the raw R2 artifact (the export FC the
  // fold wrote) and materialized as a DELTA row in `features`, marked custom_fields.ms_foldsrc
  // = its artifact feature id. From there the NORMAL pulled-edit machinery runs against that
  // row (geometry saves, meta saves, undo). Publish's re-fold (C5) merges deltas back into the
  // artifacts and clears them. Re-clicks find the existing delta by ms_foldsrc — one delta per
  // artifact feature, ever.
  var _foldRawCache = {};   // layerDbId → {ver, byId} — the artifact FC indexed by feature id
  // C7: a pointer copy's artifacts live at the SOURCE layer's keys — parquet_key is authoritative
  // for WHERE the fold's files are; a normally-folded layer's parquet_key is simply its own key.
  function foldArtifactUrl(node, lid) {
    var base = (node && node.parquet_key && /\.parquet$/.test(node.parquet_key))
      ? node.parquet_key.replace(/\.parquet$/, '')
      : 'tiles/' + projectId + '/' + lid;
    return 'https://tiles.mapstructor.com/' + base + '.geojson';
  }
  async function foldRawIndex(node, lid) {
    var ver = String(node.tilesGeneratedAt || node.attrParquetAt || '0');
    var c = _foldRawCache[lid];
    if (c && c.ver === ver) return c.byId;
    var r = await fetch(foldArtifactUrl(node, lid) + '?v=' + encodeURIComponent(ver), { cache: 'no-store' });
    if (!r.ok) throw new Error('layer archive HTTP ' + r.status);
    var fc = await r.json(), byId = {};
    (fc.features || []).forEach(function (f) { var k = f.id != null ? f.id : (f.properties || {}).feature_id; if (k != null) byId[String(k)] = f; });
    _foldRawCache[lid] = { ver: ver, byId: byId };
    return byId;
  }
  async function foldDeltaFor(node, lid, tileFid) {
    // an existing delta wins (it is the newer truth than the artifact)
    var ex = await db.from('features').select('feature_id, layer_id, geom, label, description, start_date, end_date, content_id, custom_fields, image_url').eq('layer_id', lid).eq('custom_fields->>ms_foldsrc', String(tileFid)).limit(1);
    if (!ex.error && ex.data && ex.data.length) return ex.data[0];
    var byId = await foldRawIndex(node, lid);
    var af = byId[String(tileFid)];
    if (!af || !af.geometry) return null;
    var p = af.properties || {}, cf = {}, STDK = { feature_id: 1, label: 1, description: 1, start_date: 1, end_date: 1, content_id: 1, image_url: 1 };
    Object.keys(p).forEach(function (k) { if (!STDK[k]) cf[k] = p[k]; });
    cf.ms_foldsrc = String(tileFid);
    var ins = await db.from('features').insert({
      layer_id: lid, geom: af.geometry,
      label: p.label != null ? String(p.label) : null,
      description: p.description != null ? String(p.description) : null,
      start_date: p.start_date || null, end_date: p.end_date || null,
      content_id: p.content_id != null ? p.content_id : null,
      image_url: p.image_url || null, custom_fields: cf,
    }).select('feature_id, layer_id, geom, label, description, start_date, end_date, content_id, custom_fields, image_url').single();
    if (ins.error) throw new Error(ins.error.message);
    return ins.data;
  }
  // boot restore: a folded layer's deltas re-hide their artifact renders + re-show as the
  // edited overlay, so pre-Publish edits stay visible across reloads (editor only — the viewer
  // stays artifact-pure until Publish re-folds, per the model).
  async function restoreFoldDeltas(node) {
    var lid = slugToLayerDbId[node.id]; if (!lid) return;
    try {
      await foldSleep(4000);   // let the maps finish booting
      // FILTER DELTAS SERVER-SIDE (8/15). This asked for 500 rows WITH GEOMETRY and only then
      // checked ms_foldsrc in the browser — so on a folded layer whose rows are heavy it pulled
      // the WHOLE layer on every load: measured 71 seconds and a Cloudflare 520 against the
      // owner's AtlasHCB (350 MB of geometry), 4 seconds into every boot, which is what "taking
      // a while to load, seems stuck" was. Only delta rows carry ms_foldsrc, so ask for those:
      // same result, 1.1s and 0 rows on that layer.
      var r = await db.from('features').select('feature_id, geom, custom_fields, start_date, end_date')
        .eq('layer_id', lid).not('custom_fields->>ms_foldsrc', 'is', null).limit(500);
      if (r.error || !r.data || !r.data.length) return;
      // Past this cap the OLDER edits to a folded layer simply are not restored, and the next
      // save writes the un-restored state back — edits disappearing on reload with nothing said.
      if (window.MSGuard) MSGuard.cliff('fold-delta-restore', r.data.length, 499,
        'this layer has more edited features than one load restores, so the oldest edits are not showing');
      var eo = (_engineEdited[node.id] = _engineEdited[node.id] || {});
      var eod = (_engineEditedDays[node.id] = _engineEditedDays[node.id] || {});
      var hid = (_engineEditIds[node.id] = _engineEditIds[node.id] || []);
      var found = 0;
      r.data.forEach(function (d) {
        var src = d.custom_fields && d.custom_fields.ms_foldsrc;
        if (src == null) return;
        if (hid.indexOf(Number(src)) < 0) hid.push(Number(src));
        if (d.geom) {
          eo[d.feature_id] = d.geom; found++;
          eod[d.feature_id] = [
            d.start_date ? +String(d.start_date).slice(0, 10).replace(/-/g, '') : 0,
            d.end_date ? +String(d.end_date).slice(0, 10).replace(/-/g, '') : 99999999
          ];
        }
      });
      if (!found) return;
      applyEngineEditFilter(node);
      ensureEditedOverlay(node);
      refreshEditedOverlay(node);
    } catch (e) {}
  }
  // A clicked TILE feature is clipped to its tile, so `clickEvt.features[0].geometry` is one
  // fragment — highlighting from it lit a state up as a tile-shaped sliver that then "switches to
  // the whole thing" when the real geometry lands (owner 8/16: "Not ideal"). Every OTHER fragment
  // of the same feature is already on screen, so gather them all: within the viewport that IS the
  // whole shape, it costs one query, and the swap to the stored geometry becomes invisible.
  function renderedGeomFor(node, fid) {
    var want = String(fid), polys = [], lines = [], pt = null;
    var pairs = [[beforeMap, '-left'], [(typeof afterMap !== 'undefined' ? afterMap : null), '-right']];
    for (var mi = 0; mi < pairs.length; mi++) {
      var m = pairs[mi][0]; if (!m || !m.getLayer) continue;
      var lid = node.id + pairs[mi][1];
      if (!m.getLayer(lid)) continue;
      var fs = [];
      try { fs = m.queryRenderedFeatures({ layers: [lid] }) || []; } catch (e) { continue; }
      for (var i = 0; i < fs.length; i++) {
        var f = fs[i]; if (String(f.id) !== want || !f.geometry) continue;
        var g = f.geometry;
        if (g.type === 'Polygon') polys.push(g.coordinates);
        else if (g.type === 'MultiPolygon') polys = polys.concat(g.coordinates);
        else if (g.type === 'LineString') lines.push(g.coordinates);
        else if (g.type === 'MultiLineString') lines = lines.concat(g.coordinates);
        else if (!pt) pt = g;
      }
      if (polys.length || lines.length || pt) break;   // whichever map rendered it is enough
    }
    if (polys.length) return { type: 'MultiPolygon', coordinates: polys };
    if (lines.length) return { type: 'MultiLineString', coordinates: lines };
    return pt;
  }
  async function enterEngineEdit(node, fid, clickEvt) {
    // cache the clicked geometry FIRST so the selection highlight the star-add triggers paints instantly
    try { var g0 = renderedGeomFor(node, fid) || (clickEvt && clickEvt.features && clickEvt.features[0] && clickEvt.features[0].geometry); if (g0) _selGeom[String(fid)] = g0; } catch (eG) {}
    // …and its days (skinny tiles + live sources both carry them), so the marker can follow the timeline
    try { var cp = clickEvt && clickEvt.features && clickEvt.features[0] && clickEvt.features[0].properties; if (cp && (cp.DayStart != null || cp.DayEnd != null)) _selDays[String(fid)] = [cp.DayStart != null ? +cp.DayStart : 0, cp.DayEnd != null ? +cp.DayEnd : 99999999]; } catch (eD) {}
    attrStarFromMap(node, fid);
    var drawId = 'db-' + fid;
    if (draw && draw.get(drawId)) {   // already pulled into draw (re-click via the edited overlay) → stage 1 unless mid-geometry-edit
      if (_editingDraw !== drawId) { _editingDraw = null; _armedSet = [drawId]; try { draw.changeMode('simple_select', { featureIds: [] }); } catch (e) {} updateArmedHl(); }
      showFeaturePanel(drawId); updateGroupHl(drawId); return;
    }
    var lyrId = (typeof slugToLayerDbId !== 'undefined') ? slugToLayerDbId[node.id] : null;
    if (!lyrId) { engineViewerPanel(node, clickEvt); return; }   // this layer's data isn't in our `features` table → not editable, but still show the panel
    var foldedEdit = node.fold_state === 'folded';
    var row = null, rowGeom = null;
    if (foldedEdit) {
      // The Fold (C4): pull from the raw artifact → delta row; the rest is the normal machinery.
      setStatus('Pulling feature from the layer archive…');
      try { row = await foldDeltaFor(node, lyrId, fid); } catch (eFp) { console.warn('fold delta pull failed', eFp); row = null; }
      if (!row || !row.geom) { engineViewerPanel(node, clickEvt); setStatus('This folded layer\'s archive is unavailable — try again.'); return; }
      drawId = 'db-' + row.feature_id;   // the DRAW copy tracks the DELTA row; the tile still hides by its own (artifact) id below
      if (draw && draw.get(drawId)) {   // delta already pulled this session — stage 1, same as the live re-click path
        if (_editingDraw !== drawId) { _editingDraw = null; _armedSet = [drawId]; try { draw.changeMode('simple_select', { featureIds: [] }); } catch (e) {} updateArmedHl(); }
        showFeaturePanel(drawId); updateGroupHl(drawId); return;
      }
      rowGeom = row.geom;
    } else {
      // Scope to THIS layer's id. feature_id alone is GLOBAL, so a tile id can collide with an unrelated
      // migrated feature on another layer and "edit" (and hide) the wrong thing — the vanishing-feature bug.
      var EB = getEditBackend(node);   // Phase 2a: read from this layer's edit backend (platform `features` unless the tileset declared its own)
      var wantCustom = EB.table === 'features';   // custom_fields is a platform column — foreign edit backends may not have it
      var res; try { res = await EB.db.from(EB.table).select(EB.idCol + ', ' + EB.layerCol + ', ' + EB.geomCol + ', label, description, start_date, end_date, content_id' + (wantCustom ? ', custom_fields, image_url' : '')).eq(EB.idCol, fid).eq(EB.layerCol, lyrId).single(); } catch (e) { res = { error: e }; }
      if (res.error || !res.data || !res.data[EB.geomCol]) { engineViewerPanel(node, clickEvt); return; }   // display-only feature (not in the edit backend) → no edit, but the viewer's panel still opens
      row = res.data; rowGeom = row[EB.geomCol];
    }
    var origGeom = { type: rowGeom.type, coordinates: rowGeom.coordinates };
    if (origGeom.type === 'MultiPolygon') { _engineWasMulti[drawId] = true; _engineOrigMulti[drawId] = origGeom; }
    var geom = origGeom;   // the FULL geometry — every part of a Multi renders while armed (stage 2 swaps in the clicked part)
    var rowFid = foldedEdit ? row.feature_id : fid;   // folded: the DELTA row's id (all writers target it)
    featureToDb[drawId] = rowFid; featureLayer[drawId] = foldedEdit ? row.layer_id : row[EB.layerCol]; _engineEditNode[drawId] = node;
    featureMeta[drawId] = { label: row.label || '', notes: row.description || '', start: row.start_date ? String(row.start_date).slice(0, 10) : '', end: row.end_date ? String(row.end_date).slice(0, 10) : '', pageid: row.content_id != null ? String(row.content_id) : '', image_url: row.image_url || '', custom: row.custom_fields || null };
    _geomSnap[drawId] = JSON.parse(JSON.stringify(geom));
    var epProps = featureProps(node) || {};
    // colorBy layers: the editable copy keeps the FEATURE's own category color (not the layer default)
    try { if (node.colorBy && node.colorBy.mapping) { var cbv2 = cbValueOf(row, node.colorBy.prop); var mc2 = cbv2 != null ? node.colorBy.mapping[String(cbv2)] : null; if (mc2) epProps.color = mc2; } } catch (e) {}
    try { draw.add({ type: 'Feature', id: drawId, geometry: geom, properties: epProps }); } catch (e) { setStatus('Edit failed'); return; }
    (_engineEditIds[node.id] = _engineEditIds[node.id] || []); if (_engineEditIds[node.id].indexOf(fid) < 0) _engineEditIds[node.id].push(fid);   // hide the TILE copy by its own id (folded: the artifact id)
    if (_engineEdited[node.id] && _engineEdited[node.id][rowFid] != null) { delete _engineEdited[node.id][rowFid]; refreshEditedOverlay(node); }   // pull it back off the overlay while editing (keyed by the row id finishEngineEdit uses)
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
  // ── ARMED FEATURES FOLLOW THE TIMELINE (8/7) ─────────────────────────────────────────────
  // A feature pulled into draw for editing renders as a DRAW copy, and draw knows nothing about
  // the timeline — so an armed feature stayed on screen at dates where it does not exist (owner:
  // Santa Fe, started 1692, sitting on the map at 1223 while armed, immune to the slider). When
  // the date changes, an armed feature that is merely SELECTED (stage 1 — geometry untouched)
  // and whose own dates exclude the new date is returned to the tiles, which then hide it like
  // everything else. A feature whose SHAPE is mid-edit is left alone: yanking half-finished
  // geometry to satisfy a filter would cost real work, showing one extra dot does not.
  function _geomEq(a, b) {   // geometry equality by type + numeric coordinates (1e-9), immune to key order
    if (!a || !b || a.type !== b.type) return false;
    var eq = function (x, y) {
      if (Array.isArray(x) || Array.isArray(y)) {
        if (!Array.isArray(x) || !Array.isArray(y) || x.length !== y.length) return false;
        for (var i = 0; i < x.length; i++) if (!eq(x[i], y[i])) return false;
        return true;
      }
      return Math.abs((+x) - (+y)) < 1e-9;
    };
    return eq(a.coordinates, b.coordinates);
  }
  function disarmEngineEditsOutsideDate(unixDate) {
    if (!window.moment) return;
    var day = parseInt(moment.unix(unixDate).format('YYYYMMDD'), 10);
    if (!isFinite(day)) return;
    Object.keys(_engineEditNode).forEach(function (drawId) {
      var node = _engineEditNode[drawId]; if (!node) return;
      // Being in shape-edit mode is NOT immunity by itself (8/8): a second click puts a feature
      // in stage 2 with its geometry untouched, and the old blanket skip here made it ignore the
      // timeline forever ("it just stays permanently all of a sudden"). The only thing worth
      // protecting is unsaved WORK — and the geometry-snapshot guard below already does exactly
      // that, for stage 1 and stage 2 alike.
      var meta = featureMeta[drawId] || {};
      var ds = meta.start ? +String(meta.start).replace(/-/g, '') : 0;
      var de = meta.end ? +String(meta.end).replace(/-/g, '') : 99999999;
      if (day >= ds && day <= de) return;                                   // still alive at this date
      var cur = null; try { cur = draw && draw.get ? draw.get(drawId) : null; } catch (e0) {}
      // ORDER-TOLERANT equality, not JSON.stringify (8/8): draw rebuilds geometry with its own
      // key order ({coordinates,type} vs the snapshot's {type,coordinates}), so the string
      // compare called EVERY untouched feature an "unsaved shape change" — which made every
      // pulled feature permanently immune to the timeline. This check exists to protect real
      // unsaved work only.
      try { if (cur && _geomSnap[drawId] && !_geomEq(cur.geometry, _geomSnap[drawId])) return; } catch (e1) {}
      var fid = featureToDb[drawId];
      // deleting the feature draw is actively pointed at → leave edit mode first, or draw's
      // current mode keeps referencing a feature that no longer exists
      if (_editingDraw === drawId) { try { draw.changeMode('simple_select', { featureIds: [] }); } catch (eM) {} _editingDraw = null; }
      try { if (cur) draw.delete(drawId); } catch (e2) {}
      var list = _engineEditIds[node.id] || [];
      var ix = list.indexOf(fid); if (ix < 0) ix = list.indexOf(Number(fid)); if (ix < 0) ix = list.indexOf(String(fid));
      if (ix > -1) list.splice(ix, 1);
      delete _engineEditNode[drawId]; delete featureToDb[drawId]; delete featureLayer[drawId];
      delete featureMeta[drawId]; delete _geomSnap[drawId]; delete _engineWasMulti[drawId]; delete _engineOrigMulti[drawId]; delete _engineMultiPartIx[drawId];
      try { _armedSet = (_armedSet || []).filter(function (x) { return x !== drawId; }); updateArmedHl(); } catch (e3) {}
      // the edit-hover chrome tracks mouseleave, but a feature deleted OUT FROM UNDER the
      // pointer never emits one — its hover halo would float at every date (8/8)
      [beforeMap, (typeof afterMap !== 'undefined' ? afterMap : null)].forEach(function (mH) {
        if (!mH) return; try { var sH = mH.getSource('edit-hover-hl'); if (sH) sH.setData({ type: 'FeatureCollection', features: [] }); } catch (eH) {}
      });
      [['left', beforeMap], ['right', (typeof afterMap !== 'undefined' ? afterMap : null)]].forEach(function (pr) {
        var m = pr[1]; if (!m) return;
        [node.id + '-' + pr[0], node.id + '-stroke-' + pr[0], node.id + '-highlighted-' + pr[0]].forEach(function (lid) { delete _engineBaseFilter[lid]; });
      });
      try { if (typeof selectedDrawId !== 'undefined' && selectedDrawId === drawId) hideFeaturePanel(); } catch (e4) {}
      try { applyEngineEditFilter(node); } catch (e5) {}
    });
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
  var _engineEditedDays = {}; // node.id → { feature_id: [DayStart, DayEnd] } — overlay features render rowless, so their dates must be remembered at fold time or the overlay can never follow the timeline (8/8)
  var _engineEditNode = {};   // drawId → node (so the feature panel knows it's an engine edit → show "Done editing")
  var _panelClickPatched = false;
  var _changeDatePatched = false;
  var _paintDatePatched = false;
  var _engineMapClickWired = false;
  function ensureEditedOverlay(node) {
    [['left', beforeMap], ['right', (typeof afterMap !== 'undefined' ? afterMap : null)]].forEach(function (pair) {
      var map = pair[1]; if (!map) return; var sid = node.id + '-edited-' + pair[0];
      if (map.getSource(sid)) return;
      try {
        map.addSource(sid, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
        var orig = (map.getStyle().layers || []).filter(function (l) { return l.id === node.id + '-' + pair[0]; })[0];
        // match the LAYER's own type — the old hardcoded 'fill' made line/circle overlays invisible
        // (line geometries render nothing in a fill layer), which surfaced with folded line layers (C4)
        // enum-ok: defaults to 'fill', which is the right default for a geometry-named or null type
    // — the same choice msPaintKeyFor makes. Only the ones that defaulted to CIRCLE were bugs.
    var oType = (node.type === 'line' || node.type === 'circle') ? node.type : 'fill';
        var oDefault = oType === 'line' ? { 'line-color': '#ffb255', 'line-width': 2 }
          : oType === 'circle' ? { 'circle-color': '#ffb255', 'circle-radius': 6 }
          : { 'fill-color': '#ffb255', 'fill-outline-color': '#ff0000' };
        var paint = (orig && orig.paint) || node.paint || oDefault;
        map.addLayer({ id: sid, type: oType, source: sid, paint: paint });   // styled like the layer, above the tile copy
        map.on('click', sid, (function (n) { return function (e) { onEngineFeatureClick(n, e); }; })(node));   // re-click → re-edit
      } catch (e) { console.warn('editing: edited overlay', e); }
    });
  }
  function refreshEditedOverlay(node) {
    var store = _engineEdited[node.id] || {};
    var days = _engineEditedDays[node.id] || {};
    var feats = Object.keys(store).map(function (fid) {
      var d = days[fid] || [];
      return { type: 'Feature', id: Number(fid), geometry: store[fid], properties: { DayStart: d[0] != null ? d[0] : 0, DayEnd: d[1] != null ? d[1] : 99999999 } };
    });
    [['left', beforeMap], ['right', (typeof afterMap !== 'undefined' ? afterMap : null)]].forEach(function (pair) {
      var map = pair[1]; if (!map) return; var src = map.getSource(node.id + '-edited-' + pair[0]);
      if (src) try { src.setData({ type: 'FeatureCollection', features: feats }); } catch (e) {}
    });
    try { if (typeof editorCurrentDate === 'function') applyEditedOverlayDayFilter(editorCurrentDate()); } catch (e) {}
  }
  // Editor chrome that renders features OUTSIDE the engine's changeDate walk — the "Done
  // editing" overlay and the yellow selection markers — must be date-filtered HERE, or a
  // feature the timeline excludes leaves its ghost on screen at every date (owner 8/8: "it
  // just stays permanently"). Same coalesce shape as the engine's label filter: features whose
  // days were never learned default to always-visible rather than silently vanishing.
  // EXPRESSION syntax throughout — mixing legacy '$type' with expressions makes setFilter
  // throw (the AHM filter bug), so the hl layers' geometry gate is rebuilt as ['geometry-type'].
  // The ONE owner of the -edited- overlay's date visibility. Other sweeps must call this rather
  // than enumerate '-edited-' themselves — a fifth copy of the suffix list is the disease.
  // day === null means "no date rule at all" (the timeline-ignore toggle); it used to be rejected
  // by the isFinite guard, so turning that toggle ON left the edited features still date-filtered
  // while every other companion showed everything.
  // companions-ok: this IS the -edited- owner.
  function applyEditedOverlayDayFilter(day) {
    var clearing = (day === null);
    if (!clearing && !isFinite(day)) return;
    var dOk = clearing ? null : msDateFilter('label', day, false);
    Object.keys(_engineEdited).forEach(function (slug) {
      var node = findNodeById(layers, slug); if (!node) return;
      // companions-ok: this function IS the -edited- owner.
      var lf = node.timelineIgnore ? null : dOk;
      [['left', beforeMap], ['right', (typeof afterMap !== 'undefined' ? afterMap : null)]].forEach(function (pr) {
        var m = pr[1]; if (!m) return; var lid = slug + '-edited-' + pr[0];
        try { if (m.getLayer(lid)) m.setFilter(lid, lf); } catch (e) {}
      });
    });
    var gt = function (kinds) { return ['match', ['geometry-type'], kinds, true, false]; };
    var HL = [
      ['editor-attr-hl-fill', ['all', gt(['Polygon', 'MultiPolygon']), dOk]],
      // tile-fragment geometries (msFrag=1) never reach the LINE layers — their rings include tile
      // seams and stroke a grid through the shape; the fill alone reads as one whole feature (8/16)
      ['editor-attr-hl-line-casing', ['all', ['!=', 'msFrag', 1], dOk]],
      ['editor-attr-hl-line', ['all', ['!=', 'msFrag', 1], dOk]],
      ['editor-attr-hl-pt', ['all', gt(['Point', 'MultiPoint']), dOk]]
    ];
    [beforeMap, (typeof afterMap !== 'undefined' ? afterMap : null)].forEach(function (m) {
      if (!m) return;
      // When clearing, the attribute highlights drop their date clause but KEEP their geometry and
      // fragment clauses — dropping those would stroke tile seams through every shape (8/16).
      // dOk is the LAST element of every entry above, so dropping it is exact. A bare `true` in its
      // place would not do: these are legacy-syntax filters and mixing the two forms is invalid.
      HL.forEach(function (pair) {
        var f = clearing ? pair[1].slice(0, -1) : pair[1];
        try { if (m.getLayer(pair[0])) m.setFilter(pair[0], f); } catch (e) {}
      });
    });
  }
  function finishEngineEdit(node, fid) {
    if (!node || fid == null) return;
    var drawId = 'db-' + fid, geom = null;
    try { var f = draw && draw.get(drawId); if (f) geom = f.geometry; } catch (e) {}
    if (!geom) geom = _geomSnap[drawId];
    if (geom) {
      (_engineEdited[node.id] = _engineEdited[node.id] || {})[fid] = geom;
      // carry the feature's days onto the overlay BEFORE featureMeta is dropped below — the
      // overlay is how this feature renders from now on, and it must keep filtering with time
      var dMeta = featureMeta[drawId] || {};
      (_engineEditedDays[node.id] = _engineEditedDays[node.id] || {})[fid] = [
        dMeta.start ? +String(dMeta.start).replace(/-/g, '') : 0,
        dMeta.end ? +String(dMeta.end).replace(/-/g, '') : 99999999
      ];
      ensureEditedOverlay(node); refreshEditedOverlay(node);
    }
    try { if (draw && draw.get(drawId)) draw.delete(drawId); } catch (e) {}
    // fid stays in _engineEditIds → the tile copy remains hidden; the overlay shows the saved geometry instead
    delete _engineEditNode[drawId]; delete featureToDb[drawId]; delete featureLayer[drawId]; delete featureMeta[drawId]; delete _geomSnap[drawId]; delete _engineWasMulti[drawId]; delete _engineOrigMulti[drawId]; delete _engineMultiPartIx[drawId];
    // the feature is no longer armed — clear its ring, or a stale _armedSet entry makes
    // updateArmedHl feed draw.get() nulls and the ring freezes on screen at every date (8/8)
    try { _armedSet = (_armedSet || []).filter(function (x) { return x !== drawId; }); updateArmedHl(); } catch (eAh) {}
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
  async function saveLayerOrder(ids, opts) {
    try {
      var patch = { layerOrder: ids };
      if (opts && typeof opts.labelsOnTop === 'boolean') patch.labelsOnTop = opts.labelsOnTop;
      var r = await patchProjectConfig(patch);
      setStatus(r.error ? 'Layer order save failed' : 'Layer order saved');
    } catch (e) { setStatus('Layer order save failed'); }
  }

  function showButtons() {
    // Wire the modules that hang off this file's private scope. Done HERE, not in the layer
    // panel: the panel is built lazily on first layer click, but the toolbar exists from boot.
    if (window.MSMerge) MSMerge.host = { db: db, projectId: projectId, slugToLayerDbId: slugToLayerDbId, runMerge: runMerge };
    if (window.MSLayerOrder && !MSLayerOrder.onSave) MSLayerOrder.onSave = saveLayerOrder;
    var bar = document.getElementById('editor-add-bar');
    bar.innerHTML = '<div id="editor-add-buttons"><div class="erow" style="margin-bottom:6px;">' +
      '<button data-type="layer">Layer</button>' +
      '<button data-type="tileset">Tileset</button>' +
      '<button data-type="import">Import</button>' +
      '<button data-type="export">Export</button></div>' +
      '<div class="erow">' +
      '<button data-type="group">+ Group</button>' +
      '<button data-type="section">+ Section</button>' +
      '<button data-type="divider" title="A plain text line you can drag between items (e.g. to delineate Raw Layers)">+ Divider</button></div>' +
      // the Portal lives with the other add-things buttons (user 8/5) — it ADDS a whole map
      '<div class="erow" style="margin-top:6px;"><button data-type="portal" title="Add a bookmarked map into this one (All / Linked / Instance per layer)">⊞ Portal</button>' +
      '<button data-type="merge" title="Combine two or more layers into one dataset. Nothing is overwritten — the originals stay as they are">⛙ Merge</button></div>' +
      // admin-only: Mapbox needs a token, so it's gated to the owner on the hosted site (the multi-library
      // / no-charge principle). Regular users only get the tokenless + Tileset above.
      (_isAdmin ? '<div class="erow" id="editor-admin-add" style="margin-top:6px;border-top:1px dashed #ccc;padding-top:6px;">' +
        '<button data-type="mbtoken" title="Enter your Mapbox access token (admin only, stored in this browser)">🔑 Mapbox token</button>' +
        '<button data-type="mbtileset" title="Add a Mapbox tileset (admin only — uses your token)">+ Mapbox tileset</button></div>' : '') +
      '</div>' +
      '<div id="editor-add-form"></div>' +
      // map data footprint — exact stored bytes, filled in the background after boot (user 7/23)
      '<div id="ms-map-size" title="Exact stored size of this map’s data — click to refresh" style="margin-top:6px;padding-top:5px;border-top:1px dashed #ddd;font-size:11px;color:#6b6580;cursor:pointer;">' + (_mapSizeText || 'Map data: measuring…') + '</div>';
    bar.querySelectorAll('#editor-add-buttons button').forEach(function (b) { b.addEventListener('click', function () { var t = b.getAttribute('data-type'); if (t === 'portal') { if (window.MSPortalAdd) MSPortalAdd.open(); return; }
      if (t === 'merge') { if (window.MSMerge) MSMerge.open(); return; } markAddActive(t); if (t === 'tileset') showTilesetForm(); else if (t === 'import') showImportForm(); else if (t === 'export') showExportForm(); else if (t === 'mbtoken') showMapboxTokenForm(); else if (t === 'mbtileset') showMapboxTilesetForm(); else showForm(t); }); });
    var msEl = document.getElementById('ms-map-size');
    if (msEl) msEl.addEventListener('click', function () { refreshMapSize(true); });
    /* AFTER FIRST IDLE. It is a readout — nothing on the map waits for it — and at boot it was
       competing with the data that IS waited for. Same treatment as the DuckDB warm and the
       hidden-layer hydration. */
    if (!_mapSizeRun) {
      var mS = (typeof beforeMap !== 'undefined') ? beforeMap : null;
      if (mS && mS.once) mS.once('idle', function () { setTimeout(function () { refreshMapSize(false); }, 1200); });   // cliff-ok: a breath after idle; the readout blocks nothing
      else setTimeout(function () { refreshMapSize(false); }, 5000);   // cliff-ok: no map to wait on
    }
  }
  // ── SIZE READOUTS (7/23): exact per-layer bytes via mapstructor_layer_stat, cached; the sidebar
  //    total fills progressively (one paced RPC per layer), the layer panel reads the same cache. ──
  var _layerSizeCache = {}, _mapSizeText = '', _mapSizeRun = 0, _elpSizeGen = 0;
  function fmtSz(b) { return (window.P && P.fmtBytes) ? P.fmtBytes(b) : (Math.round(b / 104857.6) / 10 + ' MB'); }
  async function refreshMapSize(force) {
    var run = ++_mapSizeRun;
    var el = function () { return document.getElementById('ms-map-size'); };
    try {
      if (idsReady) { try { await idsReady; } catch (e0) {} }
      var ids = [], seen = {};
      Object.keys(slugToLayerDbId).forEach(function (k) { var v = slugToLayerDbId[k]; if (v && !seen[v]) { seen[v] = 1; ids.push(v); } });
      if (force) ids.forEach(function (id) { delete _layerSizeCache[id]; });
      var total = 0, feats = 0, unmeasured = 0;
      /* ONE call for every uncached layer, not one per layer. This loop used to issue a separate
         `mapstructor_layer_stat` per layer WITH a deliberate 120ms pause between them, because
         "Supabase throttles bursts" — 14 of the 22 RPC calls in a boot on a 13-layer map, roughly
         14 round trips plus 1.5s of self-imposed pacing, for a number that is pure display.
         The pacing existed because of the burst; removing the burst removes the need for it.
         `mapstructor_layer_stats(uuid[])` returns the same per-row expression (sql/setup/
         layer-stats-batch.sql, verified row-for-row against the singular version). If it is not
         installed the per-layer path still runs — the same tolerance every other RPC here has. */
      var need = ids.filter(function (id) { return !_layerSizeCache[id]; });
      if (need.length) {
        var batched = false;
        try {
          var rb = await db.rpc('mapstructor_layer_stats', { p_layers: need });
          if (!rb.error && Array.isArray(rb.data)) {
            rb.data.forEach(function (row) {
              if (row && row.layer_id) _layerSizeCache[row.layer_id] = { count: Number(row.feature_count) || 0, bytes: Number(row.bytes) || 0 };
            });
            batched = true;
          }
        } catch (eB) {}
        if (!batched) {
          // nplus1-ok: the fallback for a database without mapstructor_layer_stats. The batch
          // path above is the normal one; this exists so an un-migrated database still works.
          for (var j = 0; j < need.length; j++) {
            if (run !== _mapSizeRun) return;
            try { var r1 = await db.rpc('mapstructor_layer_stat', { p_layer: need[j] }); if (!r1.error && r1.data) _layerSizeCache[need[j]] = r1.data; } catch (e1) {}
            await new Promise(function (rs) { setTimeout(rs, 120); });   // pace — Supabase throttles bursts
          }
        }
      }
      if (run !== _mapSizeRun) return;
      for (var i = 0; i < ids.length; i++) {
        var st = _layerSizeCache[ids[i]];
        if (st) { total += (st.bytes || 0); feats += (st.count || 0); }
        else unmeasured++;   // stat RPC timed out (big layers on a busy DB) — an under-count must SAY so
      }
      if (el()) el().textContent = 'Map data: ' + fmtSz(total);
      if (run !== _mapSizeRun) return;
      // baked tile archives count too (Publish writes them to the tiles bucket under this project)
      var tileBytes = 0;
      try {
        var tl = await db.storage.from('tiles').list(projectId, { limit: 200 });
        (tl.data || []).forEach(function (ob) { tileBytes += ((ob.metadata || {}).size || 0); });
      } catch (e2) {}
      _mapSizeText = feats
        ? ('Map data: ' + fmtSz(total) + ' · ' + feats.toLocaleString() + ' features' + (tileBytes ? ' · +' + fmtSz(tileBytes) + ' vector tiles & scrub rasters' : ''))
        : (tileBytes ? ('Map data: ' + fmtSz(tileBytes) + ' vector tiles & scrub rasters · 0 rows stored here') : 'Map data: 0 B stored here — renders from external tilesets/archives');
      if (unmeasured) _mapSizeText += ' · ⚠ ' + unmeasured + ' layer' + (unmeasured === 1 ? '' : 's') + ' unmeasured (click to retry)';
      if (el()) el().textContent = _mapSizeText;
    } catch (e) {}
  }
  async function fillLayerSize(node) {
    var elS = document.getElementById('elp-size'); if (!elS) return;
    elS.style.display = 'none';
    var gen = ++_elpSizeGen;
    // Linked AND Instance both carry instanceOf; only Instance is styleLocked. Calling every
    // mirror an "Instance" was simply wrong, and it was the only place to look (owner 8/18).
    if (node && (node.instanceOf || (node.editable === false && node._msFromLayer))) {
      elS.style.display = '';
      elS.textContent = node.styleLocked
        ? 'Instance — its data AND its styling come from the source layer (adds 0 B of its own)'
        : 'Linked — reads the source layer’s data live; style it freely (adds 0 B of its own)';
      return;
    }
    var lid = node && slugToLayerDbId[node.id];
    if (!lid && idsReady) { try { await idsReady; } catch (e0) {} lid = node && slugToLayerDbId[node.id]; }
    if (!lid || gen !== _elpSizeGen) return;
    function show(st) { if (gen !== _elpSizeGen) return; elS.style.display = ''; elS.textContent = (st.count ? (fmtSz(st.bytes || 0) + ' stored · ' + st.count.toLocaleString() + ' features') : 'No rows stored here (tileset / external data)'); }
    var st = _layerSizeCache[lid];
    if (st) { show(st); return; }
    try { var r = await db.rpc('mapstructor_layer_stat', { p_layer: lid }); if (!r.error && r.data) { _layerSizeCache[lid] = r.data; show(r.data); } } catch (e) {}
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
    var node = findNodeById(layers, slug);
    // Mirrors export their SOURCE's rows (instanceOf) — a backup of what the layer shows.
    var lid = (node && node.instanceOf) || slugToLayerDbId[slug]; if (!lid) { setStatus('That layer has no database id'); return; }
    var status = document.getElementById('editor-export-status'), btn = document.getElementById('editor-export-ok');
    if (btn) btn.disabled = true;
    try {
      var feats = null;
      if (node && node.fold_state === 'folded') {
        // The Fold (C1): rows are gone — fetch the export-ready GeoJSON written to R2 at fold
        // time (the same FeatureCollection this function builds from rows, so every format matches).
        if (status) status.textContent = 'Fetching the layer\'s data file…';
        var rver = node.tilesGeneratedAt || node.attrParquetAt || '0';
        var rres = await fetch(foldArtifactUrl(node, lid) + '?v=' + encodeURIComponent(rver), { cache: 'no-store' });
        if (!rres.ok) throw new Error('the layer\'s data file is unavailable (HTTP ' + rres.status + ')');
        var rfc = await rres.json();
        feats = (rfc && rfc.features) || [];
        if (status) status.textContent = 'Fetched ' + feats.length + ' features…';
      }
      var rows = [];
      if (!feats) {   // keyset + adaptive pages (8/13) — fixed offset pages time out on heavy layers
        var exres = await window.MSFetchRows(db, 'feature_id, geom, label, description, start_date, end_date, content_id, custom_fields, image_url',
          function (q) { return q.eq('layer_id', lid); },
          { onPage: function (n) { if (status) status.textContent = 'Fetched ' + n + ' features…'; } });
        if (exres.error) throw new Error(exres.error.message);
        rows = exres.rows;
      }
      // property order = the layer's attribute-table column order when one is saved (raw_config.attrView),
      // else the default display order (msid first, ms_* last). GeoJSON/KML/DBF all honor insertion order.
      var _custKeys = [];
      rows.forEach(function (r) { if (r.custom_fields) Object.keys(r.custom_fields).forEach(function (k) { if (_custKeys.indexOf(k) < 0) _custKeys.push(k); }); });
      var _ordKeys = (node && node.attrView && node.attrView.order && node.attrView.order.length)
        ? node.attrView.order
        : ['label', 'start_date', 'end_date', 'description', 'content_id'].concat(orderAttrKeys(_custKeys));
      if (!feats) feats = rows.filter(function (r) { return r.geom; }).map(function (r) {
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
      setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 1500);   // cliff-ok: cosmetic cleanup of a blob URL
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
    if (!isMapboxUrl(url)) { warn('This button is for mapbox:// tilesets. For PMTiles / XYZ use <b>Tileset</b>.'); return; }
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
  var LIB = { togeojson: 'https://cdn.jsdelivr.net/npm/@tmcw/togeojson@5.8.1/dist/togeojson.umd.js', shp: 'https://unpkg.com/shpjs@4.0.4/dist/shp.js', turf: 'https://cdn.jsdelivr.net/npm/@turf/turf@6.5.0/turf.min.js', fflate: 'https://cdn.jsdelivr.net/npm/fflate@0.8.2/umd/index.js', proj4: 'https://cdn.jsdelivr.net/npm/proj4@2.12.1/dist/proj4.js' };
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
  // 9c: import progress as a persistent STEP CHECKLIST (not a mutating one-liner). Every stage flows
  // through here, so we diff the message: a new stage (different leading phrase) checks off (✓) the
  // previous one and appends an active row (◐); the SAME stage updates its text in place (live counts);
  // failures mark the active row ✗. Zero call-site changes — honors the 7/15 "make the existing line
  // better, nothing separate" note. Renders into the same #editor-import-status element.
  var _impRows = [];
  function importStatus(m) {
    var s = document.getElementById('editor-import-status');
    if (!s) { setStatus(m); return; }
    m = String(m == null ? '' : m);
    if (!m) { _impRows = []; s.textContent = ''; return; }
    var isErr = /\b(fail|error|cancel|couldn|could not|limit is)\b/i.test(m);
    var isDone = /^(Imported|Done)\b/i.test(m);
    var key = isErr ? '__err' : (m.toLowerCase().split(/[\d:…]/)[0].trim() || m.toLowerCase());   // leading phrase, minus counts
    var last = _impRows[_impRows.length - 1];
    if (last && (last.state === 'done' || last.state === 'error') && !isErr && !isDone) { _impRows = []; last = null; }   // new run after a finished one → fresh checklist
    if (isErr) { if (last && last.state === 'active') last.state = 'error'; _impRows.push({ key: '__err', text: m, state: 'error' }); }
    else if (last && last.key === key) { last.text = m; }                                   // same stage → update count/text in place
    else { if (last && last.state === 'active') last.state = 'done'; _impRows.push({ key: key, text: m, state: 'active' }); }
    if (isDone) _impRows.forEach(function (r) { if (r.state === 'active') r.state = 'done'; });
    s.innerHTML = _impRows.map(function (r) {
      var icon = r.state === 'done' ? '✓' : r.state === 'error' ? '✗' : '◐';
      var col = r.state === 'done' ? '#3d9a72' : r.state === 'error' ? '#b4453a' : '#5b458f';
      var safe = String(r.text).replace(/[<>&"]/g, function (c) { return { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]; });
      return '<div style="display:flex;gap:6px;align-items:baseline;color:' + col + ';font-weight:' + (r.state === 'active' ? 700 : 500) + ';line-height:1.5;"><span style="flex:0 0 auto;width:12px;text-align:center;">' + icon + '</span><span style="word-break:break-word;">' + safe + '</span></div>';
    }).join('');
  }
  // KML/KMZ → parsed XML DOM (KMZ = a ZIP wrapping a .kml + optional assets).
  async function kmlDomFromFile(file, ext) {
    await loadScript(LIB.togeojson);
    var text;
    if (ext === 'kmz') {
      await loadScript(LIB.fflate);
      var files = window.fflate.unzipSync(new Uint8Array(await file.arrayBuffer()));
      var kmlName = Object.keys(files).filter(function (n) { return /\.kml$/i.test(n); }).sort()[0];   // doc.kml / any .kml
      if (!kmlName) throw new Error('no .kml inside the .kmz');
      text = new TextDecoder().decode(files[kmlName]);
    } else text = await file.text();
    var dom = new DOMParser().parseFromString(text, 'text/xml');
    if (dom.querySelector('parsererror')) throw new Error(ext === 'kmz' ? 'the KML inside the KMZ is invalid' : 'not valid KML/XML');
    return dom;
  }
  // Split a KML by its FOLDERS. A KML of separate folders is authored to open as SEPARATE things, so we
  // import each folder as its own layer — never merged/flattened (user 7/20: "a really bad idea to
  // merge and flatten it"). Each Placemark is grouped by its nearest <Folder> ancestor's name; each
  // group is re-serialized to a standalone KML and run through togeojson (so styles/geometry parse
  // exactly as togeojson expects). Returns [{name,fc}] when there are ≥2 groupings, else null (the
  // file is effectively one layer and the caller uses the whole-file FeatureCollection as before).
  function kmlFolderParts(dom) {
    var root = dom.querySelector('Document') || dom.documentElement; if (!root) return null;
    var pms = Array.prototype.slice.call(root.getElementsByTagName('Placemark'));
    if (pms.length < 2) return null;
    function folderNameOf(node) {
      var n = node.parentNode;
      while (n && n.nodeType === 1) {
        if ((n.localName || n.tagName) === 'Folder') {
          var ne = Array.prototype.filter.call(n.childNodes, function (c) { return c.nodeType === 1 && (c.localName || c.tagName) === 'name'; })[0];
          return (ne && (ne.textContent || '').trim()) || 'Folder';
        }
        n = n.parentNode;
      }
      return null;   // not inside any folder → "loose"
    }
    var groups = {}, order = [];
    pms.forEach(function (pm) {
      var fn = folderNameOf(pm) || 'Ungrouped';
      if (!(fn in groups)) { groups[fn] = []; order.push(fn); }
      groups[fn].push(pm);
    });
    if (order.length < 2) return null;   // one grouping (or all loose) → single layer, current behavior
    var ser = new XMLSerializer(), parts = [];
    order.forEach(function (fn) {
      var inner = groups[fn].map(function (pm) { return ser.serializeToString(pm); }).join('');
      var kmlStr = '<kml xmlns="http://www.opengis.net/kml/2.2"><Document>' + inner + '</Document></kml>';
      var d = new DOMParser().parseFromString(kmlStr, 'text/xml');
      var fc = null; try { fc = window.toGeoJSON.kml(d); } catch (e) {}
      if (fc && fc.features && fc.features.length) parts.push({ name: fn, fc: fc });
    });
    return parts.length >= 2 ? parts : null;
  }
  // Multi-folder KML → one layer per folder, grouped under the file name. NEVER merged.
  async function importKmlFolders(parts, fileName, parent) {
    var container = (parent && parent.type === 'group') ? parent   // already in a batch group → add layers here (no nested group)
      : await addItem('group', fileName || 'Imported KML', (parent && parent.type === 'section') ? parent : null);
    if (!container) throw new Error('could not create a group for the KML folders');
    var ok = 0, failed = [];
    for (var i = 0; i < parts.length; i++) {
      importStatus('Importing folder ' + (i + 1) + '/' + parts.length + ': ' + parts[i].name + '…');
      try { await importFeatureCollection(parts[i].fc, parts[i].name, container); ok++; }
      catch (e) { console.warn('kml folder import failed', parts[i].name, e); failed.push(parts[i].name); }
    }
    rerender();
    setStatus('Imported ' + ok + ' of ' + parts.length + ' KML folders as separate layers' + (failed.length ? ' · failed: ' + failed.join(', ') : ''));
    return container;
  }
  // Parse ONE file by extension → FeatureCollection → import as layer(s). Throws on failure.
  async function importOneFile(file, parent) {
    var ext = (file.name.split('.').pop() || '').toLowerCase();
    importStatus('Reading ' + file.name + '…');
    var fc = null;
    if (ext === 'geojson' || ext === 'json') fc = JSON.parse(await file.text());
    else if (ext === 'kml' || ext === 'kmz') {
      var kdom = await kmlDomFromFile(file, ext);
      var parts = kmlFolderParts(kdom);   // multi-folder KML → import each folder as its OWN layer (never merged)
      if (parts) return await importKmlFolders(parts, stripExt(file.name), parent);
      fc = window.toGeoJSON.kml(kdom);
    }
    else if (ext === 'zip') {
      var zbuf = await file.arrayBuffer();
      // Unzip FIRST so the .shp's real size is known: past SHP_STREAM_MIN_BYTES the file is read
      // record by record (shpjs would materialise the whole thing and kill the tab — 8/15).
      var zfAll = null;
      try { await loadScript(LIB.fflate); zfAll = window.fflate.unzipSync(new Uint8Array(zbuf)); } catch (eUz) { zfAll = null; }
      if (zfAll) {
        var keep = Object.keys(zfAll).filter(function (k) { return !/(^|\/)__MACOSX\//.test(k); });
        var shps = keep.filter(function (k) { return /\.shp$/i.test(k); });
        var heavy = shps.filter(function (k) { return zfAll[k].byteLength > SHP_STREAM_MIN_BYTES; });
        if (heavy.length) {
          zbuf = null;   // the streaming reader works off the unzipped members — drop the archive copy
          var madeAll = [];
          for (var si = 0; si < shps.length; si++) {
            var stem = shps[si].replace(/\.shp$/i, '');
            var pick = function (ext2) { var hit = keep.filter(function (k) { return k.toLowerCase() === (stem + ext2).toLowerCase(); })[0]; return hit ? zfAll[hit] : null; };
            var partName = shps.length > 1 ? stripExt(file.name) + ' — ' + stem.split('/').pop() : stripExt(file.name);
            importStatus('Reading ' + partName + ' (' + (zfAll[shps[si]].byteLength / 1048576).toFixed(0) + ' MB) without loading it all at once…');
            var mp = await importShapefileStreaming({ shp: zfAll[shps[si]], dbf: pick('.dbf'), prj: pick('.prj'), cpg: pick('.cpg') }, partName, parent);
            (mp || []).forEach(function (n) { madeAll.push(n); });
          }
          rerender();
          return madeAll;
        }
      }
      await loadScript(LIB.shp);
      var r = await window.shp(zbuf);
      fc = Array.isArray(r) ? { type: 'FeatureCollection', features: r.reduce(function (a, c) { return a.concat(c.features || []); }, []) } : r;
      // Read the .prj OURSELVES. shpjs only reprojects when it recognises the projection, and
      // when it does not it hands back the raw projected numbers with no warning — which is how
      // a shapefile ends up at null island. The .prj is the file telling us its CRS; proj4 reads
      // that WKT directly, so ANY grid (UTM, Lambert, state plane, national) can be placed
      // correctly instead of only the ones shpjs happens to know. This is what QGIS is doing.
      try {
        var zf = zfAll || (await loadScript(LIB.fflate), window.fflate.unzipSync(new Uint8Array(zbuf)));
        var prjName = Object.keys(zf).filter(function (k) { return /\.prj$/i.test(k) && !/(^|\/)__MACOSX\//.test(k); })[0];
        if (prjName) fc.__msPrj = new TextDecoder().decode(zf[prjName]).trim();
      } catch (ePrj) { console.warn('could not read .prj', ePrj); }
    }
    else if (ext === 'tif' || ext === 'tiff') throw new Error('GeoTIFF (raster) import is coming soon');
    else throw new Error('unsupported format .' + ext);
    if (!fc || !fc.features || !fc.features.length) throw new Error('no features found');
    return await importFeatureCollection(fc, stripExt(file.name), parent);
  }
  // ── STREAMING SHAPEFILE IMPORT (8/15) ───────────────────────────────────────────────────
  //    Owner: US_AtlasHCB_StateTerr.zip — 220 features, 149 MB — "Aw, Snap! Out of Memory",
  //    twice. Nothing about the DATA is big: it is 220 polygons. The size is vertex DENSITY
  //    (AtlasHCB traces coastlines at survey resolution), and shpjs materialises the WHOLE
  //    file as GeoJSON before the importer is even reached. A coordinate pair costs 16 bytes
  //    on disk and roughly 96 as a JS [x, y] array, so that file wants ~1 GB of objects in
  //    one go and Chrome kills the tab.
  //    So read the records ourselves and hand the existing pipeline SMALL chunks: peak memory
  //    becomes the file's bytes plus one chunk, and file size stops being a ceiling. Chunks go
  //    through normalizeImportFC exactly like any other import, so the .prj reprojection, the
  //    pole snap and the Multi* rules are the same code, not a second copy of them.
  var SHP_STREAM_MIN_BYTES = 24 * 1024 * 1024;   // .shp over this streams; smaller files keep the proven shpjs path
  var SHP_CHUNK_VERTICES = 120000;               // vertices per chunk handed to the pipeline
  var SHP_RENDER_VERTEX_BUDGET = 500000;         // stop feeding the LIVE map past this — the same memory wall, one step later
  function dbfEncLabel(cpg) {
    var c = String(cpg || '').trim().toLowerCase();
    if (!c) return 'windows-1252';
    if (/utf-?8/.test(c)) return 'utf-8';
    var m = c.match(/(\d{3,5})/);
    if (m) { var n = m[1]; if (n === '65001') return 'utf-8'; return (n === '1252' || n === '1250' || n === '1251') ? 'windows-' + n : 'windows-1252'; }
    return 'windows-1252';
  }
  // .dbf = fixed-length records behind a field table. Read one record at a time — the whole
  // point is that nothing holds every row at once.
  function dbfReader(buf, encLabel) {
    if (!buf || buf.byteLength < 32) return null;
    var dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    var count = dv.getUint32(4, true), headerLen = dv.getUint16(8, true), recLen = dv.getUint16(10, true);
    var dec; try { dec = new TextDecoder(encLabel); } catch (e) { dec = new TextDecoder('windows-1252'); }
    var fields = [], off = 32;
    while (off + 32 <= headerLen && buf[off] !== 0x0d) {
      var ne = off; while (ne < off + 11 && buf[ne] !== 0) ne++;
      fields.push({ name: dec.decode(buf.subarray(off, ne)).trim(), type: String.fromCharCode(buf[off + 11]), len: buf[off + 16] });
      off += 32;
    }
    if (!fields.length || !recLen) return null;
    return {
      count: count,
      read: function (i) {
        var at = headerLen + i * recLen;
        if (i >= count || at + recLen > buf.byteLength) return null;
        if (buf[at] === 0x2a) return null;   // deletion flag
        var o = at + 1, out = {};
        for (var fi = 0; fi < fields.length; fi++) {
          var f = fields[fi], raw = dec.decode(buf.subarray(o, o + f.len)).trim();
          o += f.len;
          if (raw === '') continue;
          if (f.type === 'N' || f.type === 'F') { var n = parseFloat(raw); if (!isNaN(n)) out[f.name] = n; }
          else if (f.type === 'L') { if (/^[TtYy]$/.test(raw)) out[f.name] = true; else if (/^[FfNn]$/.test(raw)) out[f.name] = false; }
          else if (f.type === 'D') {
            // A DATE column becomes a Date built from LOCAL parts — the shape importCustomFields
            // already knows how to write (shpjs did the same, and a UTC render moves the day
            // backwards east of Greenwich).
            var dm = raw.match(/^(\d{4})(\d{2})(\d{2})$/);
            if (dm) { var d = new Date(+dm[1], +dm[2] - 1, +dm[3]); if (!isNaN(d.getTime())) out[f.name] = d; }
            else out[f.name] = raw;
          } else out[f.name] = raw;
        }
        return out;
      }
    };
  }
  function shpRingArea(r) {   // signed area — sign IS the winding
    var a = 0;
    for (var i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] * r[i][1]) - (r[i][0] * r[j][1]);
    return a / 2;
  }
  // A shapefile polygon record is a FLAT ring list; which rings are holes is re-derived from
  // signed area — the same classification vector tiles do, and the same trap (see the ring-winding
  // reference): a ring that would be a hole while enclosing MORE area than its outer is a
  // mis-wound outer, so it starts a new polygon instead of punching a hole through everything.
  function shpRingsToPolygons(rings) {
    var polys = [], cur = null, outerSign = 0, curArea = 0;
    for (var i = 0; i < rings.length; i++) {
      var r = rings[i], a = shpRingArea(r), abs = Math.abs(a);
      if (!a) { if (cur) cur.push(r); else { cur = [r]; polys.push(cur); } continue; }
      var sgn = a < 0 ? -1 : 1;
      if (!outerSign) outerSign = sgn;
      if (sgn === outerSign || !cur || abs > curArea) { cur = [r]; polys.push(cur); curArea = abs; }
      else cur.push(r);
    }
    if (!polys.length) return null;
    return polys.length === 1 ? { type: 'Polygon', coordinates: polys[0] } : { type: 'MultiPolygon', coordinates: polys };
  }
  // Walks .shp record headers without decoding anything it isn't asked for.
  function shpCursor(buf) {
    var dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    var pos = 100, end = buf.byteLength;
    var pts = function (at, n) {
      var out = [];
      for (var i = 0; i < n; i++) out.push([dv.getFloat64(at + i * 16, true), dv.getFloat64(at + i * 16 + 8, true)]);
      return out;
    };
    return { next: function () {
      if (pos + 8 > end) return null;
      var words = dv.getInt32(pos + 4, false), cAt = pos + 8, cLen = words * 2;
      pos = cAt + cLen;
      if (cLen < 4 || cAt + cLen > end) return { geometry: null, verts: 0 };
      var t = dv.getInt32(cAt, true), kind = t % 10;   // 11/21 are Point too, 13/23 PolyLine, 15/25 Polygon, 18/28 MultiPoint
      try {
        if (kind === 1) return { geometry: { type: 'Point', coordinates: [dv.getFloat64(cAt + 4, true), dv.getFloat64(cAt + 12, true)] }, verts: 1 };
        if (kind === 8) {
          var np8 = dv.getInt32(cAt + 36, true), cs = pts(cAt + 40, np8);
          return { geometry: cs.length ? { type: 'MultiPoint', coordinates: cs } : null, verts: cs.length };
        }
        if (kind === 3 || kind === 5) {
          var nParts = dv.getInt32(cAt + 36, true), nPts = dv.getInt32(cAt + 40, true);
          var partsAt = cAt + 44, ptsAt = partsAt + 4 * nParts, parts = [];
          for (var p = 0; p < nParts; p++) parts.push(dv.getInt32(partsAt + p * 4, true));
          var rings = [];
          for (var q = 0; q < nParts; q++) {
            var from = parts[q], to = (q + 1 < nParts) ? parts[q + 1] : nPts;
            if (to > from) rings.push(pts(ptsAt + from * 16, to - from));
          }
          if (!rings.length) return { geometry: null, verts: 0 };
          if (kind === 3) return { geometry: rings.length === 1 ? { type: 'LineString', coordinates: rings[0] } : { type: 'MultiLineString', coordinates: rings }, verts: nPts };
          return { geometry: shpRingsToPolygons(rings), verts: nPts };
        }
      } catch (e) { return { geometry: null, verts: 0 }; }
      return { geometry: null, verts: 0 };   // null shape / unsupported (Z-only MultiPatch)
    } };
  }
  // Insert one more chunk into the layers the FIRST chunk created.
  async function appendImportChunk(made, fc, state) {
    var norm = await normalizeImportFC(fc);
    for (var i = 0; i < norm.kinds.length; i++) {
      var kind = norm.kinds[i], node = null;
      made.forEach(function (n) { if (n.type === kind) node = n; });
      if (!node) { state.skipped += norm.groups[kind].length; continue; }   // a geometry kind absent from chunk 1
      var lid = slugToLayerDbId[node.id]; if (!lid) continue;
      var feats = norm.groups[kind];
      var ids = await batchInsertFeatures(lid, feats);
      // Keep feeding the LIVE map until the render budget is spent. Past it the rows are still
      // saved — the layer just renders from its tiles instead, which is what tiles are for.
      if (state.verts < SHP_RENDER_VERTEX_BUDGET && node.source && node.source.data && node.source.data.features) {
        var arr = node.source.data.features;
        for (var f2 = 0; f2 < feats.length; f2++) {
          // same property shape the boot path builds (featureToGeo): label + custom fields ride
          // along, so colour-by-column and labels work on streamed features in THIS session too
          var pr2 = Object.assign({ DayStart: 0, DayEnd: 99999999, label: importLabel(feats[f2].properties) }, importCustomFields(feats[f2].properties) || {});
          arr.push({ type: 'Feature', id: ids[f2], geometry: feats[f2].geometry, properties: pr2 });
        }
        [['left', typeof beforeMap !== 'undefined' ? beforeMap : null], ['right', typeof afterMap !== 'undefined' ? afterMap : null]].forEach(function (pr) {
          var m = pr[1]; if (!m) return;
          try { var s = m.getSource(node.id + '-' + pr[0]); if (s && s.setData) s.setData(node.source.data); } catch (e) {}
        });
      }
    }
  }
  // Stream ONE shapefile (already unzipped) into a layer, chunk by chunk.
  async function importShapefileStreaming(part, baseName, parent) {
    var dbf = part.dbf ? dbfReader(part.dbf, dbfEncLabel(part.cpg && new TextDecoder().decode(part.cpg))) : null;
    var prj = part.prj ? new TextDecoder().decode(part.prj).trim() : null;
    var cur = shpCursor(part.shp);
    var expect = dbf ? dbf.count : 0;
    var made = null, idx = 0, chunk = [], chunkVerts = 0;
    var state = { verts: 0, feats: 0, skipped: 0, bounds: null };
    var grow = function (b) {
      if (!b) return;
      if (!state.bounds) { state.bounds = [[b[0][0], b[0][1]], [b[1][0], b[1][1]]]; return; }
      var s = state.bounds;
      if (b[0][0] < s[0][0]) s[0][0] = b[0][0]; if (b[0][1] < s[0][1]) s[0][1] = b[0][1];
      if (b[1][0] > s[1][0]) s[1][0] = b[1][0]; if (b[1][1] > s[1][1]) s[1][1] = b[1][1];
    };
    var flush = async function () {
      if (!chunk.length) return;
      var fcC = { type: 'FeatureCollection', features: chunk };
      if (prj) fcC.__msPrj = prj;
      if (!made) {
        made = (await importFeatureCollection(fcC, baseName, parent)) || [];
        if (!made.length) throw new Error('could not create the layer');
      } else await appendImportChunk(made, fcC, state);
      grow(computeImportBounds(fcC));   // coords are lng/lat by now (normalizeImportFC ran inside)
      chunk = []; chunkVerts = 0;
    };
    // A streaming import that dies partway has ALREADY created the layer and written thousands of
    // rows into it, under the name the person chose, looking finished in the sidebar. That is the
    // exact bug the MERGE path fixed on 8/21 — and this is the path where it matters more: merge
    // runs against rows already in the database, while this one runs for MINUTES over a 24 MB+ file
    // and is far likelier to be interrupted. The checklist did not travel from one write path to
    // its sibling, which is ranked fix #6 in its purest form. Found 8/22 by surveying import as a
    // surface, not from a report.
    //
    // Nothing is deleted: the rows are real, and an error path is the worst place to destroy data.
    // The layer is simply made to say what it is, in the tree AND in the database, so a reload
    // still tells the truth.
    async function markIncomplete(err) {
      try {
        if (!made || !made.length) return;   // died before the layer existed: nothing to mislabel
        var label = baseName + ' — incomplete (' + state.feats.toLocaleString() + ' features)';
        for (var q = 0; q < made.length; q++) {
          var n = made[q]; if (!n) continue;
          n.label = label;
          var qlid = slugToLayerDbId[n.id];
          if (qlid) await saveSoft(db.from('layers').update({ name: label }).eq('id', qlid), 'marking the incomplete import');
        }
        rerender();
      } catch (eMark) { console.warn('could not mark the incomplete import', eMark); }
      if (window.MSGuard) MSGuard.warn('import-incomplete',
        'the import stopped partway — its layer holds only part of the file and is marked "incomplete" in the sidebar',
        state.feats + ' features written before: ' + ((err && err.message) || err));
      setStatus('Import stopped — the partial layer is marked "incomplete"');
    }

    window.__msStreamingImport = true;
    try {
      for (;;) {
        var rec = cur.next(); if (!rec) break;
        var props = dbf ? dbf.read(idx) : null;
        idx++;
        if (!rec.geometry) continue;
        chunk.push({ type: 'Feature', geometry: rec.geometry, properties: props || {} });
        chunkVerts += rec.verts; state.verts += rec.verts; state.feats++;
        if (chunkVerts >= SHP_CHUNK_VERTICES) {
          importStatus('Reading "' + baseName + '" — ' + nfmt(state.feats) + (expect ? ' of ' + nfmt(expect) : '') + ' features, ' + nfmt(Math.round(state.verts / 1000)) + 'k points…');
          await flush();
          await new Promise(function (r) { setTimeout(r, 0); });   // let the tab breathe (and paint) between chunks
        }
      }
      await flush();
    } catch (eStream) {
      await markIncomplete(eStream);
      throw eStream;   // the caller still reports the failure; this only stops it looking finished
    } finally { window.__msStreamingImport = false; }
    if (!made || !made.length) throw new Error('no features found');
    // Fit to everything that arrived, not just the first chunk.
    if (state.bounds && typeof beforeMap !== 'undefined' && beforeMap) { try { beforeMap.fitBounds(state.bounds, { padding: 60, maxZoom: 16 }); } catch (e) {} }
    // TILES. Reading a heavy layer's rows back into this tab to tile them would rebuild exactly
    // the object graph streaming just avoided, so past the render budget the bake goes to the
    // cloud Action (fold-rows reads the rows we just wrote — no upload, ids already match).
    for (var mi = 0; mi < made.length; mi++) {
      var node = made[mi], lid = slugToLayerDbId[node.id];
      if (!lid) continue;
      if (state.verts > SHP_RENDER_VERTEX_BUDGET) {
        // Stamp it BEFORE dispatching: a layer holding more geometry than a tab can rebuild must
        // never be hydrated from rows at boot again (configLoader honours this), whether or not
        // the bake below succeeds. Without it, one failed dispatch leaves a map that kills the
        // tab on every future load.
        try {
          await patchLayerConfig(lid, { heavyGeom: true, heavyVertices: state.verts });
          node.heavyGeom = true;
        } catch (eH) { console.warn('import: could not stamp heavyGeom', eH); }
        var dispatched = false;
        try { dispatched = await foldImportDispatch(lid, node, { length: state.feats }); } catch (eF) {}
        if (dispatched) { node.fold_state = 'folding'; pollFoldDone(node, lid); }
        else importStatus('Imported ' + nfmt(state.feats) + ' features. Tiles could not be built in the cloud — use the layer panel’s Bake button when you are ready.');
      } else {
        try { await rebakeLayerTiles(lid, 'Building tiles', true); } catch (eB) {}   // allowConvert: a fresh geojson layer has no tiles yet
      }
    }
    setStatus('Imported ' + nfmt(state.feats) + ' feature' + (state.feats !== 1 ? 's' : '') +
      (state.skipped ? ' · ' + state.skipped + ' skipped (mixed geometry types)' : ''));
    return made;
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
  // ── THE FOLD · import reroute (C3, 7/29) ──────────────────────────────────
  // Imports past the tile thresholds stop bulk-inserting rows: the FeatureCollection goes to
  // R2 (Worker /upload, ownership-checked), the Worker's POST /fold dispatches the GitHub
  // Action (fold-raw), and Postgres keeps ONLY the layer row (fold_state='folding' → 'folded'
  // when the Action stamps tiles + sidecar + parquet + export FC). EVERY failure on this path
  // falls back to today's row import — deploy-safe even before the Worker secret exists.
  var FOLD_WORKER_BASE = 'https://mapstructor-worker.mapstructor.workers.dev';
  var CLOUD_FOLD_IMPORTS = true;             // kill-switch (also: window.__msForceRowImport for tests)
  // How big before an import goes to the cloud INSTEAD of inserting rows. This used to be 500
  // polygons / 2,000 points, which sent nearly every real dataset down the fold-raw path — and
  // fold-raw writes ZERO feature rows, so the layer renders NOTHING until the Action finishes:
  // many minutes on a cold runner that compiles tippecanoe first. An 18 MB, 8,695-polygon
  // shapefile sat invisible behind that (owner 8/7: "In the past I've seen a layer appear very
  // quickly. It is essential that it does."). Now only imports where inserting the rows would
  // ITSELF be the slow part go to the cloud; everything below imports rows and is visible and
  // editable immediately, with the browser tiler baking its tiles right after (auto-convert).
  var FOLD_RAW_MIN = 50000;
  var FOLD_BYTES_MIN = 48 * 1024 * 1024;     // …or this much geometry, however few features carry it (8/15)
  // Cheap size estimate: sample coordinates rather than stringify (stringifying to measure would
  // cost the memory the measurement exists to protect).
  function importGeomBytes(feats) {
    if (!feats || !feats.length) return 0;
    var step = Math.max(1, Math.floor(feats.length / 40)), seen = 0, pts = 0;
    for (var i = 0; i < feats.length; i += step) {
      seen++;
      collectImportCoords(feats[i] && feats[i].geometry, function () { pts++; });
    }
    if (!seen) return 0;
    return Math.round((pts / seen) * feats.length * 40);   // ~40 bytes per pair as transported JSON
  }
  var _foldWatch = [];                       // {node, layerId} queued by the import loop, drained into polls
  function foldSleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  // projectLoader registers pmt-sw ONLY when the boot config already has a /pmt/ layer — a map
  // whose FIRST tiled layer arrives via a cloud fold has no service worker, so the new source's
  // pmt/ requests would fall through to the static host and 404 (blank layer until reload).
  // Register on demand; pmt-sw skipWaiting+claim lets it control this page mid-life.
  async function ensurePmtSw() {
    try {
      if (!('serviceWorker' in navigator)) return;
      await navigator.serviceWorker.register('pmt-sw.js').then(function () { return navigator.serviceWorker.ready; });
      await foldSleep(300);   // claim settle beat (same trick as projectLoader's boot wait)
    } catch (e) {}
  }
  // upload the per-layer FC + dispatch the Action. true = cloud fold is underway; false = fall back.
  // 'fold-rows', NOT 'fold-raw' (8/7). fold-raw reads a client-uploaded FeatureCollection and
  // MINTS ITS OWN feature ids — fine when Postgres holds no rows, but the import now always
  // inserts rows first so the layer is visible immediately, and those rows carry ids of their
  // own. Two independent id spaces for the same data would strand every later edit (the C4
  // delta restore matches rows to tile features by id). fold-rows bakes from the rows we just
  // wrote, so the ids match by construction — and it needs no upload at all.
  // mode (8/16): defaults to fold-rows for an IMPORT, but a re-bake of a layer that already has
  // pulled-in edit copies must pass 'fold-merge' — fold-rows bakes every row, so a delta row and
  // the feature it was copied from BOTH land in the tiles as separate features (that is the whole
  // of 220 → 222 after two clicks). fold-merge applies each delta ONTO its source id and deletes
  // the delta afterwards, which is the behaviour a re-bake wants.
  async function foldImportDispatch(layerId, node, feats, mode) {
    try {
      var tok = (await db.auth.getSession()).data.session.access_token;
      var dR = await fetch(FOLD_WORKER_BASE + '/fold', {
        method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: projectId, layerId: layerId, mode: mode || 'fold-rows' })
      });
      if (!dR.ok) throw new Error('fold dispatch HTTP ' + dR.status);
      ensurePmtSw();   // fire-and-forget — the worker is claimed long before the tiles are needed
      importStatus('"' + (node.label || 'layer') + '" is on the map (' + nfmt(feats.length) + ' features). Building faster tiles for it in the cloud…');
      return true;
    } catch (e) {
      // the layer is already imported and drawing — this only means it keeps its browser-made
      // tiles instead of tippecanoe's, which is a speed difference, not a broken import
      console.warn('cloud fold unavailable — keeping the local tiles', e);
      importStatus('"' + (node.label || 'layer') + '" imported — cloud tiling unavailable, using local tiles.');
      return false;
    }
  }
  // watch the layer row until the Action stamps it (or leaves raw_config.foldError)
  // sinceStamp (8/16): for a RE-bake the layer is ALREADY fold_state 'folded' and stays that way,
  // so "folded" cannot mean "finished" — the first poll declared victory 8 seconds in and printed
  // «"US_AtlasHCB_StateTerr" is ready — 220 features» while tippecanoe was still compiling (owner:
  // "Does this mean it's done? I refreshed, and it didn't bake"). Pass the tilesGeneratedAt that was
  // on the row at dispatch time and completion becomes "the stamp CHANGED", which is the real event.
  async function pollFoldDone(node, layerId, sinceStamp, startedAt) {
    var POLL_MS = 8000, MAX = 90;   // ~12 min ceiling — a cold Action run compiles tippecanoe (~3-4 min)
    var t0 = Date.now();
    for (var i = 0; i < MAX; i++) {
      // say so where progress is always said (owner 8/7) — the import step-checklist, which is
      // where every other stage of the upload reported itself. A reload resumes this watch
      // (loadIds scans for fold_state 'folding'), so the line comes back rather than going quiet.
      // …but NOT while the import is still saving: the checklist starts a new row whenever the
      // leading phrase changes, so alternating with "Saving features… n/N" printed a fresh
      // "Building tiles…" line every few seconds and buried the actual progress (owner 8/7).
      // Saving is the useful number while it is running; this line takes over once it is done.
      if (!window.__msImportSaving) {
        // Say STILL RUNNING in words that cannot be mistaken for finished, and say since when —
        // a reload resumes this watch, so the elapsed clock restarts while the real start time
        // does not (8/16: the old line read "folded to cloud storage", which sounds like a result).
        var startTxt = '';
        try { if (startedAt) startTxt = ', started ' + new Date(startedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch (eT) {}
        var mins = Math.floor(((startedAt ? Date.now() - new Date(startedAt).getTime() : Date.now() - t0)) / 60000);
        importStatus('⏳ STILL RE-BAKING "' + (node.label || 'layer') + '" in the cloud'
          + (mins ? ' — ' + mins + ' min so far' : '') + startTxt
          + '. NOT finished yet. The current map stays live meanwhile, this tab can be closed, and the map updates itself when the new tiles land.');
      }
      await foldSleep(POLL_MS);
      var r = null;
      try { r = await db.from('layers').select('*').eq('id', layerId).single(); } catch (e) { continue; }
      if (!r || r.error || !r.data) continue;
      var rc = r.data.raw_config || {};
      if (rc.foldError) { importStatus('Cloud fold failed for "' + (node.label || 'layer') + '": ' + rc.foldError + ' — delete the layer row or re-import.'); return; }
      if (r.data.fold_state === 'folded' && (!sinceStamp || (rc.tilesGeneratedAt && rc.tilesGeneratedAt !== sinceStamp))) { applyFoldedRow(node, r.data); return; }
    }
    importStatus('Cloud fold is taking unusually long for "' + (node.label || 'layer') + '" — it finishes in the background; reload later to see it.');
  }
  // the Action stamped the layer: rebuild the tree node from the row and add it to the maps LIVE
  // through the platform's own in-session tileset path (same recipe as onApplySource).
  async function applyFoldedRow(node, row) {
    try {
      // the bake is over — clear the in-flight marker so a later reload does not claim it is still running
      try {
        var rcC = row.raw_config || {};
        if (rcC.rebakeStartedAt) {
          delete rcC.rebakeStartedAt; delete node.rebakeStartedAt;
          await saveSoft(db.from('layers').update({ raw_config: rcC }).eq('id', row.id), 'recording the finished bake');
        }
      } catch (eClr) {}
      await ensurePmtSw();   // resume-on-load pages never registered it either (no tiled layer at boot)
      var fresh = (typeof ConfigLoader !== 'undefined' && ConfigLoader.leafFromRow) ? ConfigLoader.leafFromRow(row) : null;
      if (fresh) {
        var keepId = node.id, keepTop = node.topLayerClass;
        Object.keys(node).forEach(function (k) { delete node[k]; });
        Object.assign(node, fresh);
        node.id = keepId; if (keepTop) node.topLayerClass = keepTop;
        node.source_type = row.source_type;   // the COLUMN, not raw_config's stale import-time copy (attachIds does the same at boot)
      } else { node.fold_state = 'folded'; }
      // drop any placeholder layers (incl. the -highlighted companion removeMapLayers skips),
      // then render through the platform's own in-session tileset path — the SAME recipe
      // onApplySource uses to repoint a source live: render + re-wire clicks + refreshLayers.
      ['-left', '-right'].forEach(function (sfx) {
        [typeof beforeMap !== 'undefined' ? beforeMap : null, typeof afterMap !== 'undefined' ? afterMap : null].forEach(function (m) {
          if (!m) return; try { var hid = node.id + '-highlighted' + sfx; if (m.getLayer(hid)) m.removeLayer(hid); } catch (e) {}
        });
      });
      try { removeMapLayers(node.id); } catch (e) {}
      // companions closed 8/25: removal is WIDE now, and the re-add is complete — render rebuilds
      // base+stroke+highlight, applyLabelLayers rebuilds the labels, the edited overlay re-ensures
      try { renderTilesetOnMap(node); } catch (eAdd) { console.warn('fold live-add failed — the layer appears on next load', eAdd); }
      try { applyLabelLayers(node); } catch (eLb) {}
      try { refreshEditedOverlay(node); } catch (eOv) {}
      try { _engineEditWired[node.id] = false; wireEngineEditClicks(); } catch (e) {}
      try { if (typeof refreshLayers === 'function') refreshLayers(); } catch (e) {}
      // the scrub raster too — the browser bake calls this from tilegen when a bake lands, but the
      // CLOUD bake landed here without it, so the session scrubbed stale (or missing) rasters
      // until a page reload ("baked rasters are not appearing", 8/16)
      try { if (window.MSRasterScrub && window.MSRasterScrub.reload) window.MSRasterScrub.reload(); } catch (eRS) {}
      rerender();
      // "folded to cloud storage" described an internal state, not an outcome, and the owner could
      // not tell from it whether anything had finished. Say DONE, say what is now true, and say
      // that nothing further is required of them.
      var doneAt = '';
      try { doneAt = new Date((row.raw_config || {}).tilesGeneratedAt || Date.now()).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch (eD) {}
      importStatus('✅ DONE — "' + (node.label || 'layer') + '" finished re-baking at ' + doneAt + '. Its new tiles are live ('
        + nfmt((row.raw_config || {}).tilesFeatureCount || 0) + ' features) and this map is already showing them. Nothing else to do.');
    } catch (e) { console.warn('applyFoldedRow failed', e); importStatus('"' + (node.label || 'layer') + '" folded — reload to see it.'); }
  }
  // Split a FeatureCollection by geometry type (one type per layer) → persist layers + features.
  // ── ONE definition of the import edge cases (8/15) ─────────────────────────────────────
  //    Extracted from importFeatureCollection so the STREAMING importer runs the identical
  //    rules chunk by chunk: pole snapping, the .prj/CRS reprojection with its probe, the
  //    refusal to guess a projection from magnitudes, and Multi* explosion. Two importers
  //    with two copies of these would drift, and every one of them was paid for in a bug.
  async function normalizeImportFC(fc) {
    // Multi-line/point geometries explode into single pieces; MultiPolygons stay whole (see explodeMulti).
    var groups = { circle: [], line: [], fill: [] };
    (fc.features || []).forEach(function (f) {
      explodeMulti(f).forEach(function (sf) {
        var t = sf.geometry && sf.geometry.type;
        var bt = t === 'Point' ? 'circle' : t === 'LineString' ? 'line' : (t === 'Polygon' || t === 'MultiPolygon') ? 'fill' : null;
        if (bt) groups[bt].push(sf);
      });
    });
    var kinds = Object.keys(groups).filter(function (k) { return groups[k].length; });
    if (!kinds.length) throw new Error('no point/line/polygon geometries');
    // ── PROJECTED SOURCES: REPROJECT RATHER THAN REFUSE (8/7) ────────────────────────────
    // Shapefiles and ArcGIS/Hub exports very often arrive in Web Mercator. The owner hit this
    // twice in one sitting — a .zip and a downloaded Gazetteer GeoJSON — and "re-export as
    // WGS84" is not something you can always do to someone else's published data. Refusing is
    // also against the rule that we widen the source matrix rather than narrow it.
    // Web Mercator has an exact closed-form inverse, so when every coordinate sits inside its
    // bounds we convert and carry on. Anything OUTSIDE that still gets the clear old error:
    // guessing a UTM zone or a state plane from magnitudes alone would silently drop the data
    // in the wrong part of the world, which is worse than declining it.
    // One pass over every coordinate pair in the import, visiting each pair EXACTLY once.
    // explodeMulti returns the original feature for single geometries and, for Multi*, pieces
    // that still SHARE the inner arrays — so walking fc.features and groups[] naively would
    // touch some pairs twice. Remembering the arrays already seen makes the sharing harmless
    // however the two lists overlap.
    var eachImportCoord = function (fn) {
      var seen = new Set();
      var walk = function (c) {
        if (!Array.isArray(c)) return;
        if (typeof c[0] === 'number' && typeof c[1] === 'number') {
          if (seen.has(c)) return;
          seen.add(c); fn(c); return;
        }
        c.forEach(walk);
      };
      var geom = function (g) {
        if (!g) return;
        if (g.type === 'GeometryCollection') { (g.geometries || []).forEach(geom); return; }
        walk(g.coordinates);
      };
      (fc.features || []).forEach(function (f) { if (f) geom(f.geometry); });
      kinds.forEach(function (k) { groups[k].forEach(function (f) { if (f) geom(f.geometry); }); });
    };
    // Snap coordinates that overshoot the edge of the world by a rounding error (8/7). The
    // owner's 2,000-point shapefile carried ONE point at latitude 90.0000000000001 — the pole,
    // missed by 1e-13 of a degree — in a file whose .prj plainly says GCS_WGS_1984. An exact
    // `> 90` test on the bounding box called the whole file projected on the strength of that
    // one point, and everything below then treated 2,000 lng/lat features as something else.
    // A pair 1e-13 past the pole and a pair at 500000 are not the same kind of thing, and one
    // exact test cannot tell them apart; absorbing the slop first means it never has to.
    var snapCoord = function (c) {
      var hit = false;
      if (c[0] > 180) { c[0] = 180; hit = true; } else if (c[0] < -180) { c[0] = -180; hit = true; }
      if (c[1] > 90) { c[1] = 90; hit = true; } else if (c[1] < -90) { c[1] = -90; hit = true; }
      return hit;
    };
    var LL_EPS = 1e-6;
    var inLngLat = function (b) {
      return b && Math.abs(b[0][0]) <= 180 + LL_EPS && Math.abs(b[1][0]) <= 180 + LL_EPS &&
                  Math.abs(b[0][1]) <= 90 + LL_EPS && Math.abs(b[1][1]) <= 90 + LL_EPS;
    };
    var bnds = computeImportBounds(fc);
    if (inLngLat(bnds)) {
      var snapped = 0;
      eachImportCoord(function (c) { if (snapCoord(c)) snapped++; });
      if (snapped) { bnds = computeImportBounds(fc); importStatus('Snapped ' + snapped + ' point' + (snapped === 1 ? '' : 's') + ' sitting just past the edge of the map…'); }
    }
    var offLngLat = !inLngLat(bnds);
    if (offLngLat) {
      var MX = 20037508.342789244, MY = 20048966.104;   // Web Mercator's extent
      var inMerc = Math.abs(bnds[0][0]) <= MX && Math.abs(bnds[1][0]) <= MX &&
                   Math.abs(bnds[0][1]) <= MY && Math.abs(bnds[1][1]) <= MY;
      // An EXPLICIT declaration beats any guess (older GeoJSON carries a crs member; RFC 7946
      // files are always lng/lat and never reach here).
      var crsName = '';
      try { crsName = String(((fc.crs || {}).properties || {}).name || '').toLowerCase(); } catch (eC) {}
      var saysMerc = /3857|900913|102100|pseudo.?mercator/.test(crsName);
      var saysOther = crsName && !saysMerc && !/4326|crs84/.test(crsName);
      // NEVER guess from magnitude. An earlier cut here accepted anything with an x beyond
      // 1,000,000 as Web Mercator, reasoning that UTM eastings stop at 900k. That is false for
      // plenty of grids (Lambert conformal conics carry huge false eastings), and the failure
      // was silent: dividing such an x by Mercator's extent yields ~13° lng and a small lat, so
      // the owner's shapefile landed in the Gulf of Guinea — "around null island" (8/7).
      // Wrong-but-quiet is the worst thing an importer can do. So we only ever reproject from a
      // CRS the FILE told us: a shapefile's .prj, or a GeoJSON crs member.
      var toLngLat = null;
      // A .prj that declares a GEOGRAPHIC system (GEOGCS with no PROJCS wrapper) is telling us
      // the numbers are already degrees, so there is nothing to reproject and proj4 would only
      // hand back an identity. Reaching here with one means the coordinates really are out of
      // range — say that, rather than blaming a projection the file does not claim to have.
      if (fc.__msPrj && !/PROJCS/i.test(fc.__msPrj)) {
        throw new Error('the .prj says this file is already in degrees (' +
          (String(fc.__msPrj).match(/GEOGCS\s*\[\s*"([^"]+)"/i) || [])[1] + '), but its coordinates run to ' +
          '[' + bnds[1][0].toFixed(3) + ', ' + bnds[1][1].toFixed(3) + '] — that is off the map, so the file itself looks wrong.');
      }
      if (fc.__msPrj) {
        // proj4 reads the .prj's WKT directly, so any grid places correctly — the same thing
        // QGIS does when it opens these without complaint.
        importStatus('Reprojecting from the file’s own CRS (.prj)…');
        try { await loadScript(LIB.proj4); } catch (eL) { throw new Error('could not load the projection library — check your connection'); }
        var p4 = window.proj4;
        if (!p4) throw new Error('projection library unavailable');
        var fromPrj;
        try { fromPrj = p4(fc.__msPrj, 'EPSG:4326'); }
        catch (eD) { fromPrj = null; }
        // proj4 does NOT reliably throw on WKT it cannot understand — it can hand back a
        // pass-through, which then "reprojects" the data to exactly where it already was and the
        // import dies on the generic bounds check with nothing to act on (owner 8/7). So TEST the
        // transform on a real corner first, and if it does not produce lng/lat, say what the file
        // declared and what came back — enough to fix the projection instead of guessing at it.
        var probe = null;
        if (fromPrj) { try { probe = fromPrj.forward([bnds[0][0], bnds[0][1]]); } catch (eF) { probe = null; } }
        var probeOk = probe && isFinite(probe[0]) && isFinite(probe[1]) &&
                      Math.abs(probe[0]) <= 180 && Math.abs(probe[1]) <= 90;
        if (!probeOk) {
          var firstLine = String(fc.__msPrj || '').replace(/\s+/g, ' ').slice(0, 110);
          throw new Error('the .prj was read but its projection could not be applied — ' +
            'sample point [' + Math.round(bnds[0][0]) + ', ' + Math.round(bnds[0][1]) + '] came back as ' +
            (probe ? '[' + probe[0] + ', ' + probe[1] + ']' : 'nothing') +
            '. The .prj says: ' + firstLine + ' — send me that line and I can add support for it.');
        }
        toLngLat = function (x, y) { var o = fromPrj.forward([x, y]); return [o[0], o[1]]; };
      } else if (saysMerc && inMerc) {
        importStatus('Reprojecting from Web Mercator to lng/lat…');
        toLngLat = function (x, y) {
          return [x / MX * 180, 180 / Math.PI * (2 * Math.atan(Math.exp((y / MX * 180) * Math.PI / 180)) - Math.PI / 2)];
        };
      } else {
        throw new Error('coordinates are projected (' + (crsName || 'the file does not say which system') +
          ') — without a .prj or a declared CRS they cannot be placed. Re-export as WGS84 / EPSG:4326.');
      }
      // Converts each coordinate pair exactly once — see eachImportCoord above for why that
      // matters when Multi* pieces share their inner arrays.
      eachImportCoord(function (c) { var p = toLngLat(c[0], c[1]); c[0] = p[0]; c[1] = p[1]; });
      bnds = computeImportBounds(fc);
      // The transform can land a pole-adjacent point a hair outside too, so snap before judging.
      if (inLngLat(bnds)) { eachImportCoord(snapCoord); bnds = computeImportBounds(fc); }
      if (!inLngLat(bnds)) throw new Error('coordinates look projected, not lng/lat — re-export as WGS84 / EPSG:4326');
    }
    return { groups: groups, kinds: kinds, bounds: bnds };
  }
  async function importFeatureCollection(fc, baseName, parent) {
    if (typeof layers === 'undefined') return;
    if (idsReady) { try { await idsReady; } catch (e) {} }
    if (!loaded) { importStatus('Still loading — try again'); return; }
    var _norm = await normalizeImportFC(fc);
    var groups = _norm.groups, kinds = _norm.kinds;
    var total = kinds.reduce(function (n, k) { return n + groups[k].length; }, 0);
    if (total > 3000 && !window.__msStreamingImport && !window.confirm('Import ' + total + ' features? Large layers auto-convert to tiles for fast viewing; editing that many features may still be slow.')) { importStatus('Cancelled'); return; }   // cliff-ok: the confirm() dialog IS the announcement, and a better one than a log line
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
        // THE FOLD (C3): past FOLD_RAW_MIN the data goes to R2 + the cloud Action and Postgres
        // gets the layer row only. foldImportDispatch flips wantsFold off on ANY failure and the
        // classic row import below runs instead.
        // The cloud reroute measured FEATURE COUNT only, so a 149 MB / 220-feature file
        // qualified for nothing at all (owner 8/15). Weigh the bytes too: what makes a layer
        // heavy is geometry, and a handful of survey-resolution coastlines outweighs 40,000 pins.
        var wantsFold = CLOUD_FOLD_IMPORTS && !window.__msForceRowImport &&
          (groups[type].length > FOLD_RAW_MIN || importGeomBytes(groups[type]) > FOLD_BYTES_MIN);
        var lrow = leafRow(node); if (wantsFold) lrow.fold_state = 'folding';
        var layerId = await insertOne('layers', lrow);
        slugToLayerDbId[node.id] = layerId;
        await insertOne('project_layers', { project_id: projectId, layer_id: layerId, sort_order: nextSort++, section_id: sId, group_id: gId });
        // ── SEEN FIRST, SAVED SECOND ────────────────────────────────────────────────────────
        // Owner 8/7: "It doesn't matter how large a file is, it should be seen asap … it's a
        // major benefit of using a GIS program that you can see a layer immediately. It's a
        // drawback to have to wait." Rendering used to read the features back OUT of Postgres,
        // so nothing appeared until every row was written — and past 500 polygons the import was
        // rerouted to the cloud, which writes no rows at all and so showed nothing for minutes.
        // The features are already parsed in this browser: draw them from memory NOW, through
        // the very same leaf-building the normal load uses (so the styling is identical), and
        // let saving happen behind a layer that is already on screen. No size threshold — a
        // bigger file just means the saving underneath it runs longer.
        try {
          var pvRows = groups[type].map(function (f) {
            return { layer_id: layerId, geom: f.geometry, label: importLabel(f.properties), custom_fields: importCustomFields(f.properties) };
          });
          var pv = (typeof ConfigLoader !== 'undefined' && ConfigLoader.leafFromRow)
            ? ConfigLoader.leafFromRow(Object.assign({}, lrow, { id: layerId }), null, pvRows) : null;
          if (pv && pv.source) {
            node.source = pv.source;
            if (node.paint == null) node.paint = pv.paint;
            if (node.type == null) node.type = pv.type;
            renderTilesetOnMap(node);   // loadFeatures() below hands small layers over to MapboxDraw
          }
        } catch (ePv) { console.warn('instant render failed — the layer appears once saved', ePv); }
        // …now persist. A cloud fold afterwards is an optimisation running behind an
        // already-visible layer, never a precondition for seeing it; the fold soak expects the
        // rows to still be there anyway.
        var newIds = await batchInsertFeatures(layerId, groups[type]);
        // Stamp the returned ids onto the instant-render features (both lists were built from
        // groups[type] in order, so index i is the same feature everywhere). Without this the
        // on-screen source stays id-less until a reload — matching the boot shape (featureToGeo:
        // top-level id = feature_id) is what lets apply-dates' live refresh and click-to-edit
        // find these features in THIS session.
        try {
          var srcFeats = node.source && node.source.data && node.source.data.features;
          if (newIds.length && srcFeats && srcFeats.length) {
            for (var fi = 0; fi < srcFeats.length && fi < newIds.length; fi++) srcFeats[fi].id = newIds[fi];
            [['left', typeof beforeMap !== 'undefined' ? beforeMap : null], ['right', typeof afterMap !== 'undefined' ? afterMap : null]].forEach(function (prI) {
              var mI = prI[1]; if (!mI) return;
              try { var sI = mI.getSource(node.id + '-' + prI[0]); if (sI && sI.setData) sI.setData(node.source.data); } catch (eI) {}
            });
          }
        } catch (eIds) { console.warn('import: could not stamp feature ids onto the live source', eIds); }
        if (wantsFold) wantsFold = await foldImportDispatch(layerId, node, groups[type]);
        if (wantsFold) { node.fold_state = 'folding'; _foldWatch.push({ node: node, layerId: layerId }); }
        else if (lrow.fold_state === 'folding') {
          node.fold_state = null;
          await saveSoft(db.from('layers').update({ fold_state: 'live' }).eq('id', layerId), 'marking the layer live');   // a silently-skipped flip is exactly the half-folded hybrid found on 8/20
        }
        if (parent) { parent.children = parent.children || []; parent.children.push(node); parent.collapsed = false; parent.open = true; if (parent.type === 'group') node.topLayerClass = parent.id; }
        else layers.push(node);
        made.push(node);
      }
      rerender();
      if (window.MSLayerOrder) made.forEach(function (mn) { MSLayerOrder.putOnTop(mn.id); });
      await loadFeatures();   // pull the imported features into MapboxDraw so they render + are editable
      var b = computeImportBounds(fc); if (b && typeof beforeMap !== 'undefined' && beforeMap) { try { beforeMap.fitBounds(b, { padding: 60, maxZoom: 16 }); } catch (e) {} }
      if (made.length) setActiveLayer(made[0].id);
      showButtons();
      setStatus('Imported ' + total + ' feature' + (total !== 1 ? 's' : ''));
      // cloud folds run remotely — watch each layer row until the Action stamps it (fire-and-forget)
      _foldWatch.splice(0).forEach(function (w) { pollFoldDone(w.node, w.layerId); });
      // auto-convert: layers past the tile thresholds become PMTiles now (no-lag viewing from the
      // NEXT load + for every visitor; this session keeps its live geojson). Fire-and-await so the
      // status line reflects real progress; a failure leaves the layer working as plain geojson.
      try {
        var bigOnes = window.__msStreamingImport ? [] : made.filter(function (n) {
          // a STREAMING import is one chunk of many — tiling here would bake a fraction of the
          // file and then be thrown away; importShapefileStreaming bakes once, at the end
          if (n.fold_state === 'folding' || n.fold_state === 'folded') return false;   // cloud fold — the Action bakes these tiles
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
            // read the rows back so tile feature ids = features.feature_id (the editor's tile↔DB key).
            // ADAPTIVE pages (8/13): heavy geometry blew the fixed 1000-row page (statement timeout)
            // and this loop silently skipped the bake — the whole reason the fresh CShapes upload
            // stayed live and rendered nothing.
            var feats2 = [];
            var fr2 = await window.MSFetchRows(db, 'feature_id, geom, start_date, end_date, label', (function (lidX) { return function (q) { return q.eq('layer_id', lidX); }; })(lid2));
            (fr2.rows || []).forEach(function (f) {
              // SKINNY TILES (7/16): id + timeline days (+ label, for map labels on tileset
              // lines) — other attributes are fetched by id on click; the days must stay baked
              // (the slider filter reads them inside the tile)
              var props = {
                DayStart: f.start_date ? +String(f.start_date).slice(0, 10).replace(/-/g, '') || 0 : 0,
                DayEnd: f.end_date ? +String(f.end_date).slice(0, 10).replace(/-/g, '') || 99999999 : 99999999
              };
              // .trim(): a label of only spaces is not a label. Same value that put three empty
              // popups under every click on the public viewer (fixed 8/21) also paints a blank
              // glyph on the map here, because `!== ''` lets " " through as a real label.
              if (f.label != null && String(f.label).trim() !== '') props.label = f.label;
              feats2.push({ type: 'Feature', id: f.feature_id, properties: props, geometry: f.geom });
            });
            if (fr2.error) importStatus('Could not read "' + (bn.label || 'layer') + '" back for tiling — use the layer panel’s Bake button.');
            if (!feats2.length) continue;
            await MSTileGen.convertLayer(db, projectId, lid2, feats2, { name: bn.label, geomKind: bn.type, status: importStatus });
            // DATES-DURING-CONVERT (8/8): this convert read its rows back BEFORE baking, and the
            // natural first minute with a new layer is "import, then set the date columns" — which
            // lands the dates WHILE the bake runs, shipping tiles whose DayStart is 0 (visible at
            // every slider date; CShapes full-file gate caught it by pixels). Time stamps can't
            // detect it (a stale bake FINISHES after the apply), so compare CONTENT: if the dated-
            // row count changed while we baked, re-read and re-bake. Twice at most; then be loud.
            for (var rb8 = 0; rb8 < 2; rb8++) {
              var datedRead8 = 0;
              feats2.forEach(function (f8) { if (f8.properties && f8.properties.DayStart) datedRead8++; });
              var cq8 = await db.from('features').select('feature_id', { count: 'exact', head: true }).eq('layer_id', lid2).not('start_date', 'is', null);
              if (((cq8 && cq8.count) || 0) === datedRead8) break;
              importStatus('Dates arrived while the tiles baked — re-baking "' + (bn.label || 'layer') + '" with them…');
              var did8 = false;
              try { did8 = !!(await rebakeLayerTiles(lid2, 'Re-baking')); } catch (e8) {}
              if (!did8) { importStatus('Could not re-bake automatically — use the layer panel’s Re-bake button to bake the new dates in.'); break; }
              feats2 = [];   // refresh the read-back so the next comparison reflects this bake
              var fr8 = await window.MSFetchRows(db, 'feature_id, start_date', function (q) { return q.eq('layer_id', lid2); });
              (fr8.rows || []).forEach(function (f8) { feats2.push({ properties: { DayStart: f8.start_date ? 1 : 0 } }); });
            }
            importStatus('"' + (bn.label || 'layer') + '" now renders from tiles (from the next load).');
          }
        }
      } catch (eConv) { console.warn('auto-convert skipped', eConv); importStatus('Imported — tile conversion skipped (' + (eConv && eConv.message) + ')'); }
      // big-data table sidecar: layers past the big-table threshold get their Parquet baked NOW,
      // in the background — the fast attribute table works immediately after import, no Publish needed
      try {
        if (window.MSBigTable && !window.__msStreamingImport) made.forEach(function (nB) {
          if (nB.fold_state === 'folding' || nB.fold_state === 'folded') return;   // the Action bakes the fold sidecar
          var featsB = groups[nB.type] || [], lidB = slugToLayerDbId[nB.id];
          if (lidB && featsB.length > MSBigTable.BIG_ROWS) MSBigTable.bakeFromDb(db, projectId, lidB, importStatus).catch(function (eB2) { console.warn('sidecar bake skipped', eB2); });
        });
      } catch (eBk) {}
      return made;
    } catch (e) { console.warn('editing: import persist failed', e); importStatus('Import failed: ' + e.message); return []; }
  }
  window._msImportFC = importFeatureCollection;   // programmatic import seam (harness + future API)
  async function batchInsertFeatures(layerId, feats) {
    // 500 polygon rows in one statement outran Postgres's statement timeout — the import died at
    // "feature insert: canceling statement due to statement timeout" (found by the 8/7 import
    // gate at 700 polygons). Polygon geometry is far heavier per row than a point, so the batch
    // starts smaller and HALVES on a timeout rather than failing the whole import: a slow row
    // shape costs extra round trips, not the user's data.
    // Writes go to features_data, the TABLE, not the `features` VIEW. Measured 8/7, 100 polygon
    // rows, network subtracted, identical rows and identical RLS:
    //     features VIEW  as owner   1951 ms   19.51 ms/row
    //     features_data  as owner     98 ms    0.98 ms/row   ← 20x
    // The view carries INSTEAD OF triggers (they exist to translate geom <-> base columns), and
    // those run per row, so every row pays a PL/pgSQL call plus its own policy evaluation.
    // Verified equivalent before switching: a row written to the table and a row written through
    // the view, read back THROUGH the view, differ in nothing but msid — geometry, dates,
    // custom_fields and the ms_* style defaults all match, because those defaults live on the
    // table. It is also the stricter path security-wise: features_data's policies are the
    // boundary features-write-lockdown.sql established, with no definer trigger in between.
    var BATCH = 500;
    // Measured 8/7: ONE polygon row costs ~670 ms as the owner and ten cost ~732 ms, while the
    // same inserts as the service role run ~14 ms/row. Nearly all of it is fixed per-STATEMENT
    // cost in the write policy (see mapstructor_docs/sql/setup/rls-write-perf.sql), so the way
    // to spend less wall-clock from here is to have several statements in flight rather than
    // bigger ones — bigger ones just hit the 8 s statement timeout.
    // Sending several statements AT ONCE was tried and measured on 8/7, and it made things
    // strictly worse: the cost is CPU inside the policy, so four in flight simply contend, and
    // even 25-row batches then hit the timeout — the gate died at 500/700 instead of finishing.
    // Sequential it stays. The real lever is the policy itself, not the client.
    // Publishing while an import is still SAVING bakes a partial tile archive (NTAD 7/23:
    // baked at 194k of 302,771 → "so many lines missing"). Flag the window so onPublish waits.
    window.__msImportSaving = (window.__msImportSaving || 0) + 1;
    // The generated feature_ids come back with the insert (RETURNING keeps input order for a
    // plain INSERT), because the instant-render source drawn BEFORE this save is otherwise
    // id-less — and everything that later matches screen features to rows by id (apply-dates'
    // live refresh, click-to-edit) silently no-ops until a reload rebuilds the source from the
    // DB. That was the 8/8 bug: "Dates applied" said done, the map ignored the timeline until
    // refresh. ~10 KB per 500-row chunk — noise even on 50k imports.
    var insertedIds = [];
    // Batches are capped by BYTES as well as rows — 500 country-sized MultiPolygons is ~13 MB of
    // JSON in one statement while 500 points is ~50 KB, and the statement budget only sees bytes
    // (8/8, CShapes whole-record import: measured 1.36 MB ≈ 1.2 s as the owner). Geometry size is
    // estimated once per feature, up front.
    var BYTE_CAP = 1200000;
    var szOf = feats.map(function (f) { try { return JSON.stringify(f.geometry).length + 300; } catch (e) { return 5000; } });
    // A timeout no longer kills the import: halve to a FLOOR OF ONE row (25 stranded a CShapes
    // import at 125/710 — the failing window inserted in 337 ms minutes later; the timeouts were
    // a transient server-sick patch, not the data), and at one row retry with a pause a few times
    // before giving up LOUDLY, naming the feature that would not save.
    var soloRetries = 0, okStreak = 0;
    try {
      var i = 0;
      while (i < feats.length) {
        var take = 0, bsum = 0;
        while (take < Math.min(feats.length - i, BATCH) && (take === 0 || bsum + szOf[i + take] <= BYTE_CAP)) { bsum += szOf[i + take]; take++; }
        var rows = feats.slice(i, i + take).map(function (f) { return { layer_id: layerId, geom: f.geometry, label: importLabel(f.properties), start_date: null, end_date: null, custom_fields: importCustomFields(f.properties) }; });
        var r = await db.from('features_data').insert(rows).select('feature_id');
        if (r.error) {
          okStreak = 0;
          if (/timeout|canceling statement/i.test(r.error.message || '')) {
            if (take > 1) { BATCH = Math.max(1, Math.floor(take / 2)); continue; }   // smaller bite, SAME rows
            if (++soloRetries <= 3) { importStatus('Database is slow — retrying…'); await new Promise(function (res) { setTimeout(res, 2500 * soloRetries); }); continue; }
          }
          throw new Error('feature insert: ' + r.error.message + ' — stopped at "' + (rows[0].label || 'feature ' + (i + 1)) + '" (' + nfmt(i) + ' of ' + nfmt(feats.length) + ' saved)');
        }
        soloRetries = 0;
        i += rows.length;
        (r.data || []).forEach(function (row) { insertedIds.push(row.feature_id); });
        // recover the batch size after a transient dip so a 100k-row import doesn't crawl home
        if (++okStreak >= 3 && BATCH < 500) { BATCH = Math.min(500, BATCH * 2); okStreak = 0; }
        if (feats.length > take) importStatus('Saving features… ' + nfmt(i) + '/' + nfmt(feats.length));   // uncapped imports can be 100k+ rows — show progress, not silence
      }
    } finally { window.__msImportSaving--; }
    return insertedIds;
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
      // A cell holding only whitespace is empty. Storing " " is how a label that LOOKS absent ends
      // up counting as present everywhere downstream — it is what put three content-free bubbles
      // under every click on the Global Railways viewer (8/21). The legend already knew: it maps
      // `k === ' '` to "(blank)". This is the import side of the same fact.
      if (v == null || (typeof v === 'string' && v.trim() === '')) return;
      // A shapefile's DBF date columns (type D) arrive from shpjs as Date OBJECTS, and
      // JSON.stringify turns a Date into a QUOTED string — the column landed in the database as
      // "\"1886-01-01T04:56:16.000Z\"", quote characters and all. Nothing downstream could read
      // that: the timeline's date parser tests for a leading digit, so the precise columns
      // silently produced no dates and the only usable option was the coarse YEAR columns — which
      // round every period out to Jan 1 / Dec 31 and make neighbouring eras overlap (owner 8/7,
      // CShapes: three United States polygons all visible through 1959). Write the plain date.
      // Its LOCAL parts, not toISOString(): shpjs builds these with new Date(y, m, d) in the
      // viewer's zone, so a UTC render moves the day backwards for anyone east of Greenwich.
      if (v instanceof Date) {
        if (isNaN(v.getTime())) return;
        var p2c = function (x) { return ('0' + x).slice(-2); };
        v = v.getFullYear() + '-' + p2c(v.getMonth() + 1) + '-' + p2c(v.getDate());
      } else if (typeof v === 'object') { try { v = JSON.stringify(v); } catch (e) { return; } }   // flatten nested values to a string
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
  // EXCEPT MultiPolygon (8/8): one source record stays ONE feature. Splitting turned CShapes' 710
  // country-eras into 8,695 island rows — 12× the rows/storage/apply-dates, a label on every island,
  // and "click Russia, select one island". The whole chain handles MultiPolygon whole now: the
  // engine renders it, arm-to-edit keeps the whole Multi (stage 2 edits one part via multiPartForEdit), labels anchor the
  // biggest part, and the raster/vector tilers walk it natively. MultiLineString/MultiPoint still
  // split — their arm path has no such converter.
  function explodeMulti(f) {
    var g = f && f.geometry; if (!g) return [];
    function feat(geom) { return { type: 'Feature', properties: f.properties, geometry: geom }; }
    if (g.type === 'MultiLineString') return (g.coordinates || []).map(function (c) { return feat({ type: 'LineString', coordinates: c }); });
    if (g.type === 'MultiPoint') return (g.coordinates || []).map(function (c) { return feat({ type: 'Point', coordinates: c }); });
    if (g.type === 'GeometryCollection') return (g.geometries || []).reduce(function (a, sub) { return a.concat(explodeMulti(feat(sub))); }, []);
    return [f];
  }

  function showForm(type) {
    var bar = addFormEl();   // #2: fill the form area under the buttons — the buttons stay visible
    var picker = '';
    if (type !== 'section' && type !== 'divider') {   // both live at top level — no parent to pick
      var opts = '<option value="">Top level</option>';
      containers(layers, 0, []).forEach(function (c) {
        if (type === 'group' && c.type !== 'section') return; // groups only nest in sections
        opts += '<option value="' + c.node.id + '">' + (c.depth ? '— ' : '') + (c.node.label || c.node.id) + '</option>';
      });
      picker = '<select id="editor-parent">' + opts + '</select>';
    }
    bar.innerHTML =
      '<input id="editor-name" type="text" placeholder="' + (type === 'divider' ? 'divider text…' : type + ' name…') + '" />' + picker +
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
  // Unpublished-changes badge (7/22, the "grouped in edit, flat in view" confusion): the public
  // view shows the last PUBLISHED snapshot, so any save after a publish means live ≠ public —
  // show it on the button ("Publish •") instead of leaving the user to discover the drift.
  // v1 is session-scoped: we can't cheaply know cross-session dirtiness at boot.
  var _msUnpublished = false;
  function msMarkUnpublished() {
    if (_msUnpublished) return; _msUnpublished = true;
    var hb = document.getElementById('editor-publish-btn');
    if (hb && hb.textContent === 'Publish') { hb.textContent = 'Publish •'; hb.title = 'You have changes the public view does not show yet — publish to update it'; }
  }
  function msClearUnpublished() {
    _msUnpublished = false;
    var hb = document.getElementById('editor-publish-btn');
    if (hb) { hb.title = 'Publish the current state to the public view'; if (hb.textContent === 'Publish •') hb.textContent = 'Publish'; }
  }
  function setStatus(msg) {
    var s = String(msg == null ? '' : msg);
    if (s.indexOf('Saving') === 0) { _msPendingSave = true; _msAnonEdited = true; }
    else if (s.toLowerCase().indexOf('failed') === -1) { _msPendingSave = false; }   // "… failed" keeps the flag — that data is NOT persisted
    if (s.indexOf('Saved') === 0 || s.indexOf('Deleted') === 0) msMarkUnpublished();   // every successful save = drift from the published snapshot
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
  // #9f: a DB write must never fail silently. Supabase RESOLVES with {error} rather than throwing, so
  // an un-checked write drops the error and the UI still reads "Saved". saveGuard awaits the write,
  // treats {error} OR a throw as failure → prominent toast + the "Save failed" status (which arms the
  // unsaved-changes guard, since the data is NOT persisted) → re-throws so callers can revert/react.
  // The DETECTION of "did this write happen" lives in MSGuard (platform/guards.js) so the browser
  // and the headless gates judge a write the same way, and so every failure lands in one log.
  // saveGuard keeps owning the UI POLICY: toast + "Save failed" status + re-throw.
  // opts.rows === 'some' additionally fails a write that succeeded and changed NOTHING (an RLS
  // no-op) — the call site must add .select('id') for there to be anything to count.
  /* The trash-orphan RPC is fire-and-forget by design, but it was ALSO silent, and supabase-js
     resolves with `{error}` rather than throwing — so `try { await db.rpc(...) } catch {}` never
     fired and a failure did nothing at all. The comment at its call site says what that costs: the
     kept-for-undo row "outlived the session as an invisible orphan billing its owner forever",
     which is exactly the shape of the 910 MB found on 8/21.
     A MISSING function stays tolerated — layer-trash-setup.sql may not have been run, and that is
     a documented state, not a failure. Everything else is now said out loud, once. */
  /* When a snapshot was baked, under EITHER name. See the note on audit.js `bakeAt`: 30 of 34
     live bakes carry only `bakedAt`, and every freshness check here read `at` alone — so the
     "re-bake needed" line and staleRasterLayers() were both blind to 88% of raster bakes. */
  function msRasterBakeAt(ry) { return (ry && (ry.at || ry.bakedAt)) || null; }
  function msTrashRpcCheck(res) {
    var err = res && res.error;
    if (!err || !window.MSGuard) return;
    if (/does not exist|could not find|schema cache/i.test(err.message || '')) return;
    MSGuard.warnOnce('trash-orphan-failed',
      'a deleted layer could not be moved to Trash, so it stays live and keeps using storage',
      err.message || String(err));
  }
  async function saveGuard(op, okMsg, failLabel, opts) {
    var label = failLabel || 'Save failed';
    var G = (typeof window !== 'undefined' && window.MSGuard) || null;
    if (G) {
      var res = await G.save(label, (typeof op === 'function' ? op() : op), { rows: opts && opts.rows });
      if (!res.ok) { setStatus('Save failed'); showToast(label + ': ' + ((res.error && res.error.message) || 'error')); throw new Error((res.error && res.error.message) || 'write failed'); }
      if (okMsg) setStatus(okMsg);
      return { data: res.data, error: null };
    }
    var r;
    try { r = await (typeof op === 'function' ? op() : op); }
    catch (e) { setStatus('Save failed'); showToast(label + ': ' + (e && e.message ? e.message : 'error')); throw e; }
    if (r && r.error) { setStatus('Save failed'); showToast(label + ': ' + (r.error.message || 'error')); throw new Error(r.error.message || 'write failed'); }
    if (okMsg) setStatus(okMsg);
    return r;
  }
  // Same detector, softer policy: report the failure, do NOT throw. This is for the write paths
  // that historically swallowed their errors (`catch (e) {}`) — routing them through a THROWING
  // guard would change control flow in undo/redo and import paths, which is a different and
  // riskier change than making the failure visible. Absence stops being silent; nothing else moves.
  async function saveSoft(op, label, opts) {
    var G = (typeof window !== 'undefined' && window.MSGuard) || null;
    if (!G) {
      try { var r0 = await (typeof op === 'function' ? op() : op); if (r0 && r0.error) console.error('[MapStructor] save failed: ' + label + ' — ' + (r0.error.message || 'error')); return r0; }
      catch (e0) { console.error('[MapStructor] save failed: ' + label + ' — ' + ((e0 && e0.message) || e0)); return { data: null, error: e0 }; }
    }
    var res = await G.save(label, (typeof op === 'function' ? op() : op), { rows: opts && opts.rows });
    if (!res.ok) showToast('Not saved — ' + label + ': ' + ((res.error && res.error.message) || 'error'), 5000);
    return { data: res.data, error: res.ok ? null : res.error };
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
        // mousedown preventDefault is LOAD-BEARING: without it the button steals focus, the text
        // SELECTION collapses, and execCommand('bold' etc.) has nothing to apply to (the "bold
        // button does not work" bug, 7/22)
        b.addEventListener('mousedown', function (e) { e.preventDefault(); });
        b.addEventListener('click', function (e) {
          e.preventDefault();
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
        _editPopupId = null; window.__msModalLock = false;   // edit session ended → backdrop can close again
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
    window.__msModalLock = true;   // while editing, the engine's backdrop-click won't close the modal — only the ✕ (see engine/index.js)
  }
  async function savePopupEdit() {
    // SNAPSHOT the target + html now — the close handler nulls _editPopupId and this function
    // awaits mid-flight, so reading the global later could save under the wrong (or no) key
    var content = document.querySelector('div.modal-content'); var pid = _editPopupId;
    if (!content || !pid) return;
    var html = content.innerHTML; setStatus('Saving…');
    try {
      // One atomic patch instead of read-mutate-write. The popups branch patches
      // { popups: { <pid>: … } } and merge-patch keeps every OTHER popup, which is exactly what the
      // read existed to preserve.
      var patch = {};
      if (pid === 'about') { patch.about = html; setModalAbout(html); }
      else {
        var nodeId = pid.replace(/-info$/, ''); var node = findNodeById(layers, nodeId);
        // a layer/group popup is titled by its ROW LABEL — the modal header can be stale (it once
        // trapped "About" here permanently), so it's only the fallback when no node matches
        var title = (node && node.label) || '';
        if (!title) { try { title = (document.querySelector('div.modal-header h1').textContent || '').trim(); } catch (x) {} }
        patch.popups = {}; patch.popups[pid] = { title: title, html: html };
        try { window.modal_content_html = window.modal_content_html || {}; window.modal_header_text = window.modal_header_text || {}; window.modal_content_html[pid] = html; window.modal_header_text[pid] = title || 'Info'; if (_editPopupId === pid) window.$('div.modal-header h1').text(title || 'Info'); } catch (x2) {}
        // persist info_id on the layer/group row so the rendered info button carries this id (viewer + on reload)
        if (node) {
          // without this id the row's ℹ button never appears for readers, even though the text saved
          if (node.type === 'group' && node._dbId) { await saveSoft(db.from('layer_groups').update({ info_id: pid }).eq('id', node._dbId), 'linking the info button to this group'); }
          else if (node.type !== 'group' && node.type !== 'section' && slugToLayerDbId[nodeId]) { await saveSoft(db.from('layers').update({ info_id: pid }).eq('id', slugToLayerDbId[nodeId]), 'linking the info button to this layer'); }
        }
      }
      var r = await patchProjectConfig(patch); if (r.error) throw new Error(r.error.message);
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
      // 📸 portal thumbnail (8/13, owner picked option 1: capture the CURRENT view on demand —
      // no auto-capture at publish). Stored in tiles/thumbs/<project>.jpg; the portal card
      // shows it through portal_entries.thumb.
      '<button id="esp-thumb" class="mss-btn">📸 Set current view as portal thumbnail</button>' +
      '<div id="esp-thumb-note" class="mss-note"></div>' +
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
      // ── LOCK — deliberately LAST, its own section at the bottom (protection, not everyday chrome) ──
      '<div class="mss-sectop">' +
        MSEC('Protection') +
        '<label class="mss-check"><input id="esp-lock" type="checkbox" style="vertical-align:middle;margin:0 5px 0 0;" />🔒 Lock this map — view &amp; copy only (editing off until unlocked here)</label>' +
        '<div class="mss-note">Locked maps and their datasets can\'t be edited, deleted, or cleaned up anywhere — dashboard and dataset-manager deletes are refused too.</div>' +
      '</div>' +
      '</div>';
    document.body.appendChild(p);
    document.getElementById('esp-close').addEventListener('click', function () { p.style.display = 'none'; });
    document.getElementById('esp-name').addEventListener('change', onSettingsName);
    document.getElementById('esp-setview').addEventListener('click', onSetDefaultView);
    document.getElementById('esp-thumb').addEventListener('click', onSetThumbnail);
    document.getElementById('esp-tl-start').addEventListener('change', onTimelineSave);
    document.getElementById('esp-tl-end').addEventListener('change', onTimelineSave);
    document.getElementById('esp-tl-today').addEventListener('change', function () { document.getElementById('esp-tl-end').disabled = this.checked; onTimelineSave(); });
    document.getElementById('esp-feat-header').addEventListener('change', onFeatureHeader);
    document.getElementById('esp-lock').addEventListener('change', onEditLockToggle);
    document.getElementById('esp-logo-file').addEventListener('change', onLogoFile);
    document.getElementById('esp-logo-link').addEventListener('change', onLogoLink);
    // Sharing (who can see the map) moved to its own 🔗 Share panel in the top bar — see platform/share.js.
  }
  // ── The per-layer copy engine (extracted 8/5 — Map Portal plan step 3). Copies ONE bundle
  //    projectLayer — its layers row (fresh slug), its project link, and its features — into a
  //    target project. `maps` carries the caller's shared remap tables ({secMap, grpMap,
  //    layerIdMap, slugMap}); the cross-layer reference fix-up (instanceOf/outlineOf) is the
  //    CALLER's job once every layer exists. Returns the feature-row count copied. Used by
  //    ⧉ Copy-map and the Portal's "All" add mode — one engine, no drift. ──
  async function copyLayerInto(pl, targetProjectId, maps, ownerId) {
    var L = pl.layers; if (!L) return 0;
    function strip(row, extra) { var o = {}; Object.keys(row).forEach(function (k) { if (k === 'id' || k === 'created_at' || k === 'updated_at' || (extra && extra.indexOf(k) > -1)) return; o[k] = row[k]; }); return o; }
    var featCount = 0;
    var nl = strip(L); if (nl.slug) nl.slug = L.slug + '-c' + Math.random().toString(36).slice(2, 7);
    // the COPIER owns the copy (8/5): strip() used to carry the SOURCE's user_id, so a cross-user
    // copy billed its storage to the person being copied FROM, forever. Same-owner copies unchanged.
    if (ownerId) nl.user_id = ownerId;
    // strip() keeps the source's user_id, so with no ownerId an ownerless source made an ownerless
    // COPY — the same cascade as the instance path. A copy with no owner is worse than no copy.
    if (!nl.user_id) throw new Error('cannot copy a layer with no owner — sign in and try again');
    // fresh bake identity: drop the dirty-check stamps so the copy's FIRST Publish bakes its
    // OWN tiles/rasters into its own storage path (until then it renders from the source
    // map's archives — same pixels, shared files, fully independent after one publish)
    if (nl.raw_config) {
      nl.raw_config = JSON.parse(JSON.stringify(nl.raw_config));
      if (L.fold_state !== 'folded') { delete nl.raw_config.tilesGeneratedAt; delete nl.raw_config.tilesFeatureCount; delete nl.raw_config.tilesMaxFid; }
    }
    // lineage stamp (8/12): every copy remembers which layer it came from. ms_dataset_usage
    // reads this so a POINTER copy (folded — owns no rows) still counts as using the source's
    // dataset. Row-copying layers carry dataset_id on the rows too; this covers the rest.
    nl.raw_config = nl.raw_config || {};
    nl.raw_config._msCopyOf = L.id;
    // THE DRIFT FACTORY, CLOSED (8/20): this clone used to carry the SOURCE's containerId and
    // toggleElement under the copy's new slug — the exact mechanism of the 8/18 untick bug (a
    // checkbox lookup aimed at a slug this project doesn't render). Whatever they said, they said
    // it about the source's identity, so on a copy they are never right: delete both and let the
    // loader derive them from the copy's own slug.
    delete nl.raw_config.containerId; delete nl.raw_config.toggleElement;
    if (L.fold_state === 'folded') {
      // C7 pointer copy: stamps stay (they carry the source-keyed artifact URLs the copy
      // renders from) and the copy bills nothing until it materializes at first fold-merge.
      nl.r2_bytes = 0;
      delete nl.raw_config.foldError;
    }
    var rl = await db.from('layers').insert(nl).select('id').single(); if (rl.error) throw new Error(rl.error.message);
    var newLid = rl.data.id;
    maps.layerIdMap[L.id] = newLid; maps.slugMap[L.slug] = nl.slug;
    var npl = strip(pl, ['layers']);
    npl.project_id = targetProjectId; npl.layer_id = newLid;
    npl.section_id = pl.section_id ? (maps.secMap[pl.section_id] || null) : null;
    npl.group_id = pl.group_id ? (maps.grpMap[pl.group_id] || null) : null;
    var rpl = await db.from('project_layers').insert(npl); if (rpl.error) throw new Error(rpl.error.message);
    // Duplicate the features (paged; select * so custom fields survive). Converted tilesets
    // (raw_config.pmtiles) keep their features in the DB as the editable source of truth —
    // skipping them left copies with EMPTY attribute tables/feature lists, and a re-bake on
    // the copy would have baked zero-feature tiles (user 7/22, copy be897684).
    if (L.fold_state === 'folded') {
      // C7: a folded layer's only meaningful rows are DELTAS (ms_foldsrc). Anything else is
      // soak-period dead weight (C6 keeps pre-fold rows until their hard-delete) — cloning
      // those would re-inflate the copy with rows nothing reads.
      // FAST PATH (8/11): `features` is a VIEW that rebuilds custom_fields per row, so the
      // client's "custom_fields->>ms_foldsrc is not null" filter could never use an index — it
      // had to materialize every row of the layer first. On the 302k-row Current Rail Network
      // that was 47s spent proving the layer has ZERO deltas, i.e. a guaranteed statement
      // timeout. The RPC asks the BASE TABLE, where the predicate is indexed (0.04ms).
      var dRpc = -1;
      try {
        var rpcD = await db.rpc('ms_copy_layer_deltas', { p_src: L.id, p_dst: newLid });
        if (!rpcD.error && typeof rpcD.data === 'number') dRpc = rpcD.data;
      } catch (eRpcD) {}
      if (dRpc >= 0) { featCount += dRpc; }
      else {
      var dLast = null;
      for (;;) {
        var dq = db.from('features').select('*').eq('layer_id', L.id).not('custom_fields->>ms_foldsrc', 'is', null).order('feature_id').limit(1000);
        if (dLast != null) dq = dq.gt('feature_id', dLast);
        var dr = await dq;
        if (dr.error) throw new Error('delta copy read: ' + dr.error.message);
        if (!dr.data || !dr.data.length) break;
        dLast = dr.data[dr.data.length - 1].feature_id;
        var dRows = dr.data.map(function (f) { var nf = strip(f, ['feature_id']); nf.layer_id = newLid; return nf; });
        var dIns = await db.from('features').insert(dRows); if (dIns.error) throw new Error(dIns.error.message);
        featCount += dRows.length;
        if (dr.data.length < 1000) break;
      }
      }
    } else if (L.source_type === 'geojson-supabase' || (L.raw_config && L.raw_config.pmtiles)) {
      // FAST PATH (7/22): one server-side INSERT…SELECT copies the whole layer in seconds with
      // zero client transfer — needs ms_copy_layer_features (query-ops-setup.sql v8). Falls
      // back to client-side keyset paging when the RPC isn't installed yet.
      var rpcCopied = -1;
      try {
        var rpcC = await db.rpc('ms_copy_layer_features', { p_src: L.id, p_dst: newLid });
        if (!rpcC.error && typeof rpcC.data === 'number') rpcCopied = rpcC.data;
      } catch (eRpcC) {}
      if (rpcCopied >= 0) { featCount += rpcCopied; }
      else {
      // KEYSET pagination (feature_id > last), not OFFSET — deep offsets on big layers hit the
      // DB statement timeout and silently truncated the copy (78k-layer repair, 7/22)
      var lastFid = null;
      for (;;) {
        var fq = db.from('features').select('*').eq('layer_id', L.id).order('feature_id').limit(1000);
        if (lastFid != null) fq = fq.gt('feature_id', lastFid);
        var fr = await fq;
        if (fr.error) throw new Error('feature copy read: ' + fr.error.message);
        if (!fr.data || !fr.data.length) break;
        lastFid = fr.data[fr.data.length - 1].feature_id;
        var rows = fr.data.map(function (f) { var nf = strip(f, ['feature_id']); nf.layer_id = newLid; return nf; });
        var ri = await db.from('features').insert(rows); if (ri.error) throw new Error(ri.error.message);
        featCount += rows.length;
        if (fr.data.length < 1000) break;
      }
      }
    }
    return featCount;
  }
  window.MSCopyEngine = { copyLayerInto: copyLayerInto };   // the Portal add flow (portalAdd.js) calls this
  // ── Copy map (Google-My-Maps-style): clone the WHOLE project — sections, groups, layers (new rows, so
  //    edits never touch the original), project_layers links, and every feature — into a new private map
  //    owned by the CURRENT account. Solves "started the map before logging in" too. ──
  // The confirm gate (8/13): the Copy button sits between Preview and Settings and was too easy
  // to hit by accident — a whole map would clone before the mistake registered. The copy now
  // needs a second, deliberate click inside a modal.
  function confirmCopyMap() {
    if (document.getElementById('ms-copy-confirm')) return;
    var back = document.createElement('div');
    back.id = 'ms-copy-confirm';
    back.style.cssText = 'position:fixed;inset:0;background:rgba(20,18,30,0.45);z-index:20000;display:flex;align-items:center;justify-content:center;padding:20px;';
    var box = document.createElement('div');
    box.style.cssText = 'background:#ffffff;border-radius:10px;box-shadow:0 10px 40px rgba(0,0,0,0.3);width:min(420px,94vw);padding:18px 20px;font:14px Source Sans Pro,Arial,sans-serif;color:#2c2836;';
    var h = document.createElement('b'); h.textContent = 'Copy this map?'; h.style.cssText = 'font-size:16px;display:block;margin-bottom:8px;';
    var p = document.createElement('div');
    p.textContent = 'This clones the whole map — layers, features, styling and info — as a new private map owned by you. The original is untouched.';
    p.style.cssText = 'color:#514c66;line-height:1.5;margin-bottom:14px;';
    var row = document.createElement('div'); row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;';
    var no = document.createElement('button'); no.textContent = 'Cancel';
    no.style.cssText = 'padding:7px 14px;border:1px solid #c9c4d8;border-radius:6px;background:#ffffff;font:600 13px inherit;cursor:pointer;color:#443f58;';
    var yes = document.createElement('button'); yes.textContent = '⧉ Copy the map';
    yes.style.cssText = 'padding:7px 14px;border:1px solid #5b4b9a;border-radius:6px;background:#5b4b9a;font:600 13px inherit;cursor:pointer;color:#ffffff;';
    row.appendChild(no); row.appendChild(yes);
    box.appendChild(h); box.appendChild(p); box.appendChild(row);
    back.appendChild(box);
    document.body.appendChild(back);
    function close() { try { back.remove(); } catch (e) {} }
    no.addEventListener('click', close);
    back.addEventListener('mousedown', function (e) { if (e.target === back) close(); });
    yes.addEventListener('click', function () { close(); copyMapToMyAccount(); });
  }
  async function copyMapToMyAccount() {
    var btn = document.getElementById('editor-copy-btn');
    var u = window.MapAuth ? await MapAuth.currentUser() : null;
    if (!u) { if (window.MapAuth) MapAuth.openAuthModal('login'); return; }
    if (btn) { btn.disabled = true; btn.textContent = 'Copying…'; }
    setStatus('Copying map…');
    function strip(row, extra) { var o = {}; Object.keys(row).forEach(function (k) { if (k === 'id' || k === 'created_at' || k === 'updated_at' || (extra && extra.indexOf(k) > -1)) return; o[k] = row[k]; }); return o; }
    try {
      var bundle = await ConfigLoader.fetchProjectBundle(db, projectId);   // NOT shared: a copy must copy the CURRENT state
      // The Fold (C7): folded layers copy as POINTERS — parquet_key keeps naming the SOURCE
      // layer's artifacts (tiles/sidecar/raw/export URLs all ride the carried stamps), zero
      // feature rows are cloned except deltas, and r2_bytes starts 0 (the copy owns no bytes).
      // Copy-on-write: the copy's first Publish-with-deltas fold-merges into ITS OWN keys and
      // re-points parquet_key at itself — the source's artifacts are never rewritten.
      var src = bundle.project;
      // 1 — the project row (private, owned by me)
      var np = strip(src); np.name = (src.name || 'Untitled Map') + ' (copy)'; np.user_id = u.id; np.is_public = false;
      // a copy starts PRIVATE and unshared regardless of the source's sharing — the owner re-shares deliberately
      np.raw_config = np.raw_config ? JSON.parse(JSON.stringify(np.raw_config)) : {};
      np.raw_config.visibility = 'private';
      delete np.raw_config.editAccess;
      var rp = await db.from('projects').insert(np).select('id').single(); if (rp.error) throw new Error(rp.error.message);
      var newId = rp.data.id;
      // 2 — sections, 3 — groups (remap ids)
      var secMap = {}, grpMap = {}, layerIdMap = {}, slugMap = {};
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
      // 4 — layers (new rows + fresh slugs), their project link, and their features — one call per
      //     layer into the shared engine (copyLayerInto, extracted 8/5; the Portal's "All" mode
      //     runs the exact same code)
      var featTotal = 0;
      var copyMaps = { secMap: secMap, grpMap: grpMap, layerIdMap: layerIdMap, slugMap: slugMap };
      var copyFails = [];
      for (var k = 0; k < (bundle.projectLayers || []).length; k++) {
        var plK = bundle.projectLayers[k];
        try {
          featTotal += await copyLayerInto(plK, newId, copyMaps, u.id);
        } catch (eLayer) {
          // ONE layer failing must not cost the other fifteen (8/11). This loop used to let the
          // throw escape, so a single timeout abandoned every layer after it and handed back a
          // map that LOOKED complete. Record it, keep going, and say so plainly at the end.
          console.warn('layer copy failed', (plK.layers || {}).name, eLayer);
          copyFails.push({ name: ((plK.layers || {}).name) || 'unnamed layer', why: (eLayer && eLayer.message) || String(eLayer) });
        }
        setStatus('Copying… ' + (k + 1) + '/' + bundle.projectLayers.length + ' layers');
      }
      // Remap cross-layer references the raw copy carried verbatim: instanceOf (a source layer's
      // DB id) and outlineOf (a parent layer's SLUG) must point INSIDE the copy — otherwise
      // instances/outlines stay tied to the source map and break if it's ever deleted (7/22).
      for (var m = 0; m < (bundle.projectLayers || []).length; m++) {
        var opl = bundle.projectLayers[m], oL = opl.layers; if (!oL || !oL.raw_config) continue;
        var oc = oL.raw_config, upd = null;
        if (oc.instanceOf && layerIdMap[oc.instanceOf]) { upd = upd || {}; upd.instanceOf = layerIdMap[oc.instanceOf]; }
        if (oc.outlineOf && slugMap[oc.outlineOf]) { upd = upd || {}; upd.outlineOf = slugMap[oc.outlineOf]; }
        if (upd && layerIdMap[oL.id]) {
          var curC = await db.from('layers').select('raw_config').eq('id', layerIdMap[oL.id]).single();
          var rcC = (curC.data && curC.data.raw_config) || {};
          Object.keys(upd).forEach(function (kk) { rcC[kk] = upd[kk]; });
          var ru = await db.from('layers').update({ raw_config: rcC }).eq('id', layerIdMap[oL.id]); if (ru.error) throw new Error(ru.error.message);
        }
      }
      if (copyFails.length) {
        setStatus('Copied, but ' + copyFails.length + ' layer(s) failed - see the message');
        var lines = copyFails.map(function (c) { return '  - ' + c.name + '  (' + c.why + ')'; }).join('\n');
        alert('The copy finished, but these layers could NOT be copied:'+'\n\n'+lines+'\n\n'+
              'Everything else came across. Delete this copy and try again, or add those layers separately.');
      } else setStatus('Copied ✓ (' + featTotal + ' features)');
      window.location.href = 'editor.html?id=' + newId;
    } catch (e) {
      console.warn('copy failed', e); setStatus('Copy failed: ' + (e && e.message));
      if (btn) { btn.disabled = false; btn.textContent = '⧉ Copy'; }
    }
  }
  // Which layers have a snapshot that no longer matches their data? Same test the layer panel's
  // freshness line uses (rasterYears.at vs tilesGeneratedAt) — one rule, two places to see it.
  function staleSnapshotLayers() {
    var out = [];
    (function walk(a) {
      (a || []).forEach(function (n) {
        if (!n) return;
        if (n.children) return walk(n.children);
        var ry = n.rasterYears;
        var ryAt = msRasterBakeAt(ry);
        if (!ry || !ryAt) return;
        // stale on newer DATA (tiles re-baked) or newer STYLING (colours/width are frozen in the raster — 8/19)
        /* Unreadable dates count as STALE here too. This collector and the panel's own check are
           two implementations of one question, and they disagreed: the panel already treats an
           unparseable timestamp as stale and says why (see msRasterPanel), while this one relied
           on `new Date("nonsense") > x`, which is false, so the same layer was "needs a re-bake"
           in the panel and "fine" in the list that drives the warning. Same rule, one place to
           read it. */
        try {
          var ms = function (v) { return v ? new Date(v).getTime() : NaN; };
          var bakedAt = ms(ryAt), dataAt = ms(n.tilesGeneratedAt), styleAt = ms(n.styleChangedAt);
          if (isNaN(bakedAt)) out.push(n);                                          // can't date the bake → assume old
          else if (n.tilesGeneratedAt && isNaN(dataAt)) out.push(n);
          else if (n.styleChangedAt && isNaN(styleAt)) out.push(n);
          else if (dataAt > bakedAt || styleAt > bakedAt) out.push(n);
        } catch (e) {}
      });
    })(typeof layers !== 'undefined' ? layers : []);
    return out;
  }
  // The ask. Three answers, and the DEFAULT is to publish without baking — the whole reason Publish
  // stopped baking is that it cost minutes nobody asked for. Returns 'skip' | 'bake' | 'cancel'.
  function askAboutStaleSnapshots(list) {
    return new Promise(function (resolve) {
      var ov = document.createElement('div');
      ov.id = 'ms-stale-overlay';
      ov.style.cssText = 'position:fixed;inset:0;background:rgba(20,18,30,0.5);z-index:100002;display:flex;align-items:center;justify-content:center;font-family:Source Sans Pro,Arial,sans-serif;';
      ov.innerHTML =
        '<div style="background:#fff;border-radius:12px;box-shadow:0 18px 60px rgba(0,0,0,0.4);width:520px;max-width:93vw;max-height:80vh;display:flex;flex-direction:column;overflow:hidden;">' +
          '<div style="padding:15px 22px 12px;border-bottom:1px solid #ece9f4;background:linear-gradient(180deg,#faf9fd,#fff);">' +
            '<b style="font-size:16px;color:#1e1b2e;">Some snapshots are out of date</b>' +
            '<div style="font-size:12px;color:#8a86a0;margin-top:2px;">Baking is manual now — nothing happens unless you ask</div>' +
          '</div>' +
          '<div style="overflow-y:auto;padding:14px 22px;font-size:13px;line-height:1.55;color:#2a2a33;">' +
            '<p style="margin:0 0 8px;">These layers changed since their <b>baked snapshot</b> was made. The map itself publishes correctly either way — only the picture shown <i>while the time slider is dragged</i> would be out of date:</p>' +
            '<ul style="margin:6px 0 10px;padding-left:18px;">' +
              list.map(function (n) { return '<li style="margin:2px 0;"><b>' + (n.label || n.id) + '</b></li>'; }).join('') +
            '</ul>' +
            '<p style="margin:8px 0 0;color:#6b6680;font-size:12.5px;"><b>Okay</b> publishes now and leaves the snapshots as they are. <b>Bake All</b> refreshes them first — several minutes per layer. You can also do it later from a layer&rsquo;s <b>Make Faster</b> section.</p>' +
          '</div>' +
          '<div style="display:flex;gap:8px;justify-content:flex-end;padding:12px 22px 16px;border-top:1px solid #f0ecf8;">' +
            // Owner's three (8/17): Okay · Cancel · Bake All. Cancel sits between the two ACTIONS
            // rather than beside the primary, so a misclick on the way to "Okay" cannot bake.
            '<button id="ms-stale-cancel" style="padding:7px 13px;border:1px solid #d7d3e4;border-radius:7px;background:#fff;color:#544f6e;font-weight:600;font-size:13px;cursor:pointer;">Cancel</button>' +
            '<button id="ms-stale-bake" style="padding:7px 13px;border:1px solid #cdbff0;border-radius:7px;background:#f2ecff;color:#5b4b9a;font-weight:700;font-size:13px;cursor:pointer;">Bake All</button>' +
            '<button id="ms-stale-skip" style="padding:7px 20px;border:none;border-radius:7px;background:#2d7a2d;color:#fff;font-weight:700;font-size:13px;cursor:pointer;">Okay</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(ov);
      var prevLock = window.__msModalLock;
      window.__msModalLock = true;   // the engine's backdrop-click must not close this one
      function done(v) { window.__msModalLock = prevLock || false; ov.remove(); resolve(v); }
      ov.querySelector('#ms-stale-skip').addEventListener('click', function () { done('skip'); });
      ov.querySelector('#ms-stale-bake').addEventListener('click', function () { done('bake'); });
      ov.querySelector('#ms-stale-cancel').addEventListener('click', function () { done('cancel'); });
    });
  }
  async function onPublish() {
    var hb = document.getElementById('editor-publish-btn');
    if (hb) { hb.disabled = true; hb.textContent = 'Publishing…'; }
    setStatus('Publishing…');
    try {
      // never bake while an import is mid-save — the archive would freeze a partial layer (7/23)
      while (window.__msImportSaving > 0) {
        setStatus('Waiting for the import to finish saving before publishing…');
        await new Promise(function (rs) { setTimeout(rs, 1500); });   // cliff-ok: polls until the import finishes, with a visible status — not a give-up
      }
      // STALE SNAPSHOTS — ASK, DON'T DECIDE (owner 8/17: "let's make it so there's a popup that
      // says that layers haven't been rebaked, and gives them the option to bake or not"). Publish
      // no longer re-bakes snapshots on its own, so a layer whose data moved since its snapshot was
      // made would silently ship a stale drag. Naming them here, before anything is written, is the
      // whole point: the cost is minutes and it is the owner's to spend.
      var stale = staleSnapshotLayers();
      if (stale.length) {
        var choice = await askAboutStaleSnapshots(stale);
        if (choice === 'cancel') { setStatus('Publish cancelled'); if (hb) { hb.disabled = false; hb.textContent = 'Publish'; } return; }
        if (choice === 'bake') {
          await loadScript('../platform/tilegen.js?v=' + Date.now());
          for (var sI = 0; sI < stale.length; sI++) {
            var sN = stale[sI], sLid = slugToLayerDbId[sN.id];
            if (!sLid) continue;
            setStatus('Baking snapshot ' + (sI + 1) + ' of ' + stale.length + ' — ' + (sN.label || 'layer') + '…');
            try {
              await MSTileGen.bakeScrubRaster(db, projectId, { id: sLid, name: sN.label, type: sN.type },
                function (m) { setStatus(m); msProgress(m); });
            } catch (eB) { msProgress('Snapshot failed for “' + (sN.label || 'layer') + '” — ' + ((eB && eB.message) || eB) + '. Publishing anyway.'); }
          }
        }
      }
      // "sew up" tiles first: converted layers regenerate from their CURRENT features, so the
      // published snapshot always ships fresh tiles (edits since the last generate are folded in)
      try {
        await loadScript('../platform/tilegen.js?v=' + Date.now());   // ALWAYS fresh — a cached old tiler re-runs the 891k-tile mistake
        if (window.MSTileGen) await MSTileGen.sewUpProject(db, projectId, function (m) { setStatus(m); msProgress(m); });   // publish regeneration shows in the prominent sidebar line too
      } catch (eTiles) { console.warn('tile sew-up skipped', eTiles); }
      // THE FOLD (C5): Publish = the fold. sewUpProject SKIPS folded layers (no rows to bake) —
      // any folded layer holding DELTA rows re-folds in the cloud instead: dispatch fold-merge
      // (artifact + deltas → new artifacts under the same ids → deltas cleared). Fire-and-forget:
      // the snapshot ships now with the current artifacts; viewers pick up the merged tiles when
      // the Action lands (the pmt service worker revalidates by ETag). Failures leave the deltas
      // in place — the next Publish simply retries the same merge.
      try {
        (function scanFold(arr) {
          (arr || []).forEach(function (n) {
            if (n.children) return scanFold(n.children);
            if (n.fold_state !== 'folded') return;
            var lidF = slugToLayerDbId[n.id]; if (!lidF) return;
            db.from('features').select('feature_id').eq('layer_id', lidF).limit(1).then(function (rF) {
              if (rF.error || !rF.data || !rF.data.length) return;   // no deltas — nothing to re-fold
              db.auth.getSession().then(function (sF) {
                var tokF = sF.data && sF.data.session && sF.data.session.access_token; if (!tokF) return;
                fetch(FOLD_WORKER_BASE + '/fold', {
                  method: 'POST', headers: { Authorization: 'Bearer ' + tokF, 'Content-Type': 'application/json' },
                  body: JSON.stringify({ projectId: projectId, layerId: lidF, mode: 'fold-merge' })
                }).then(function (dF) {
                  msProgress(dF.ok ? ('"' + (n.label || 'layer') + '" is re-folding its edits in the cloud — viewers see them shortly.')
                    : ('Cloud re-fold unavailable for "' + (n.label || 'layer') + '" — its edits stay pending until the next Publish.'));
                }).catch(function (eRf) {
                  // The .then above reports BOTH outcomes of a reply that arrives. This branch is
                  // the request never arriving at all — and it used to say nothing, so a re-fold
                  // that never started looked exactly like one quietly succeeding.
                  msProgress('Cloud re-fold could not be reached for "' + (n.label || 'layer') + '" (' +
                    ((eRf && eRf.message) || 'network error') + ') — its edits stay pending until the next Publish.');
                });
              });
            });
          });
        })(typeof layers !== 'undefined' ? layers : []);
      } catch (eFm) {}
      setStatus('Publishing…');
      var bundle = await ConfigLoader.fetchProjectBundle(db, projectId);   // snapshot the current live config
      // GHOST GUARD (7/22): a long-lived tab can display groups/sections that no longer exist in
      // the DB (be897684 — the tab showed two groups, layer_groups had zero rows; publish reads
      // the DB, so the published view stayed flat while the tab looked grouped). Publishing
      // proceeds, but say LOUDLY why the view won't match what this window shows.
      try {
        var sessContainers = 0;
        (function cntC(a) { (a || []).forEach(function (n) { if (n.type === 'group' || n.type === 'section') sessContainers++; if (n.children) cntC(n.children); }); })(typeof layers !== 'undefined' ? layers : []);
        var dbContainers = (bundle.groups || []).length + (bundle.sections || []).length;
        if (sessContainers > dbContainers) {
          showToast('⚠ ' + (sessContainers - dbContainers) + ' group/section(s) shown in this window are NOT in the saved map — the published view will not have them. Refresh this page and re-create them, then publish again.', 12000);
        }
      } catch (eGhost) {}
      // R2 SNAPSHOT MIRROR (7/27, R2 step ②·25) — viewers read the published bundle from
      // tiles.mapstructor.com first (free egress, no Postgres compute). Delete-first invariant,
      // same as tiles: clear the R2 copy BEFORE the Postgres write, re-PUT after — so R2 holds
      // the CURRENT publish or nothing, and a failed mirror leaves viewers on the Postgres
      // fallback instead of a stale publish. Private maps only get the DELETE (custom-domain
      // objects are world-readable; the live-row visibility gate stays authoritative).
      var snapUrl = 'https://mapstructor-worker.mapstructor.workers.dev/upload/snapshots/' + projectId + '.json';
      /* 8/25 — the third instance of the 8/23 R2-mirror family (bigtable + tilegen were the first
         two, and their fix comment even NAMED the snapshot mirror as a sibling). The correlated
         case: worker down for the whole publish → pre-delete fails, Postgres insert succeeds, PUT
         fails → R2 keeps the PREVIOUS publish, viewers read R2 first, and both warns claim a
         fallback that is not happening. Same repair: a failed mirror write DELETES the key so
         "viewers fall back to Postgres" is made true rather than hoped. */
      async function msSnapAbandon(u2, tok2, why) {
        try {
          var rk = await fetch(u2, { method: 'DELETE', headers: { Authorization: 'Bearer ' + tok2 } });
          if (rk.ok || rk.status === 404) { console.warn('snapshot R2 mirror failed (' + why + ') — key cleared, viewers fall back to Postgres'); return; }
          why += ', cleanup HTTP ' + rk.status;
        } catch (eK) { why += ', cleanup ' + String((eK && eK.message) || eK); }
        console.warn('snapshot R2 mirror failed (' + why + ') AND could not be cleared — viewers may see the PREVIOUS publish until the next successful one');
      }
      var snapTok = null;
      try { snapTok = (await db.auth.getSession()).data.session.access_token; } catch (eTok) {}
      if (snapTok) try {
        await fetch(snapUrl, { method: 'DELETE', headers: { Authorization: 'Bearer ' + snapTok } });
      } catch (eDel) { console.warn('snapshot R2 pre-delete failed (fallback still correct)', eDel); }
      // If this delete silently changes nothing and the insert then fails, the map keeps its OLD
      // published state while the screen says "Published ✓" — the worst kind of quiet.
      await saveSoft(db.from('project_snapshots').delete().eq('project_id', projectId).eq('label', 'published'), 'clearing the previous published snapshot');   // one published snapshot per project
      var r = await db.from('project_snapshots').insert({ project_id: projectId, label: 'published', state: bundle });
      if (r.error) throw new Error(r.error.message);
      if (snapTok) try {
        var snapVis = 'link';
        try {
          var vr = await db.from('projects').select('is_public, raw_config').eq('id', projectId).single();
          snapVis = (vr.data && vr.data.raw_config && vr.data.raw_config.visibility) || (vr.data && vr.data.is_public ? 'public' : 'link');
        } catch (eVis) {}
        if (snapVis !== 'private') {
          var sr = await fetch(snapUrl, { method: 'PUT', body: JSON.stringify(bundle),
            headers: { Authorization: 'Bearer ' + snapTok, 'Content-Type': 'application/json' } });
          if (!sr.ok) await msSnapAbandon(snapUrl, snapTok, 'HTTP ' + sr.status);
        }
      } catch (eSnap) { await msSnapAbandon(snapUrl, snapTok, String((eSnap && eSnap.message) || eSnap)); }
      setStatus('Published ✓');
      msClearUnpublished();   // live and public are in sync again
      if (hb) { hb.textContent = 'Published ✓'; setTimeout(function () { hb.textContent = 'Publish'; hb.disabled = false; }, 2500); }

      /* THE PUBLIC SITE (8/26). A map bound to a /maps/<slug>/ address gets that address refreshed
         here, as part of Publish, rather than behind a second button. Two buttons would mean a
         client could publish and still be looking at a stale public page with no indication which
         one they needed — the failure is silent and it lands on THEIR visitors.
         It runs AFTER Publish has already reported success, and its own failure is reported
         separately: the snapshot is genuinely published either way, and saying "Publish failed"
         because an upload hiccuped would be a lie that costs a re-publish. Most runs upload a
         handful of small files (see publishSite.js on delta uploads). */
      try {
        if (window.MSPublishSite) {
          var pres = await window.MSPublishSite.run(projectId, setStatus);
          if (pres && !pres.skipped && pres.uploaded) setStatus('Published ✓ · public site updated');
        }
      } catch (ePub) {
        console.warn('public site update failed', ePub);
        setStatus('Published ✓ — but the public site did not update: ' + ((ePub && ePub.message) || ePub));
      }
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
    try {
      // MSBoot (8/25): boot-window share of the row configLoader fetched
      var mbC = window.MSBoot;
      var r = (mbC && mbC.pid === projectId && Date.now() < mbC.until)
        ? await mbC.project
        : await db.from('projects').select('raw_config').eq('id', projectId).single();
      var rc = (r.data && r.data.raw_config) || {}; setModalAbout(rc.about || ''); applyHeaderChrome(rc); setTimeout(function () { applyHeaderChrome(rc); }, 600); setTimeout(function () { applyHeaderChrome(rc); }, 1500); if (rc.popups) { try { window.modal_content_html = window.modal_content_html || {}; window.modal_header_text = window.modal_header_text || {}; Object.keys(rc.popups).forEach(function (id) { var p = rc.popups[id]; var h = (p && typeof p === 'object') ? p.html : p; var ti = (p && typeof p === 'object') ? p.title : 'Info'; window.modal_content_html[id] = h || ''; window.modal_header_text[id] = ti || 'Info'; }); } catch (x) {} } var tl = rc.timeline; if (tl && tl.start && tl.end) { var tries = 0; var iv = setInterval(function () {
      if (applyTimelineRange(tl.start, tl.end)) { clearInterval(iv); return; }
      // The EDITOR's copy of the same give-up already wired in projectLoader.js for the viewer:
      // same rule, same 25×400ms budget, two files. Both now say so instead of leaving the map on
      // its default dates looking perfectly fine.
      if (++tries > 25) { clearInterval(iv); if (window.MSGuard) MSGuard.cliff('timeline-apply-giveup-editor', tries, 25,
        'the saved timeline range was never applied — the slider was not ready in 10s, so the editor is showing its default dates'); }
    }, 400); } } catch (e) {}
  }
  async function onTimelineSave() {
    var sd = document.getElementById('esp-tl-start').value, today = document.getElementById('esp-tl-today').checked, ed = today ? 'today' : document.getElementById('esp-tl-end').value;
    var eUnix = (ed === 'today') ? window.moment().unix() : window.moment(ed).unix();
    if (!sd || (!today && !ed) || eUnix <= window.moment(sd).unix()) { setStatus('Enter a valid start date before the end'); return; }
    setStatus('Saving…');
    try { var r = await patchProjectConfig({ timeline: { start: sd, end: ed } }); if (r.error) throw new Error(r.error.message); applyTimelineRange(sd, ed); setStatus('Timeline range saved'); } catch (e) { setStatus('Save failed'); }
  }
  function fmtView(lat, lng, z) { return (lat != null && lng != null) ? ('Default: ' + Number(lat).toFixed(4) + ', ' + Number(lng).toFixed(4) + ' · z' + (z != null ? Number(z).toFixed(1) : '?')) : 'Default view not set'; }
  async function openSettingsPanel() {
    injectSettingsPanel();
    var p = document.getElementById('editor-settings-panel');
    if (p.style.display === 'block') { p.style.display = 'none'; return; }   // ⚙ toggles
    try { var r = await db.from('projects').select('name, center_lng, center_lat, zoom, raw_config').eq('id', projectId).single(); if (r.data) { document.getElementById('esp-name').value = r.data.name || ''; document.getElementById('esp-viewinfo').textContent = fmtView(r.data.center_lat, r.data.center_lng, r.data.zoom); var tl = r.data.raw_config && r.data.raw_config.timeline; document.getElementById('esp-tl-start').value = (tl && tl.start) || ''; var todayEnd = !!(tl && tl.end === 'today'); document.getElementById('esp-tl-today').checked = todayEnd; document.getElementById('esp-tl-end').disabled = todayEnd; document.getElementById('esp-tl-end').value = todayEnd ? '' : ((tl && tl.end) || ''); document.getElementById('esp-logo-link').value = (r.data.raw_config && r.data.raw_config.headerLink) || ''; document.getElementById('esp-feat-header').checked = !!(r.data.raw_config && r.data.raw_config.features && r.data.raw_config.features.header === true); document.getElementById('esp-lock').checked = !!(r.data.raw_config && r.data.raw_config.editLock); } } catch (e) {}
    p.style.display = 'block';
  }
  async function saveMapName(name) {
    name = (name || '').trim(); if (!name) return;
    setStatus('Saving…');
    try { var r = await db.from('projects').update({ name: name }).eq('id', projectId); if (r.error) throw new Error(r.error.message); applyHeaderText(name); var ei = document.getElementById('esp-name'); if (ei && ei.value !== name) ei.value = name; setStatus('Map renamed'); } catch (e) { setStatus('Save failed'); }
  }
  // 🔒 editing lock (7/22): raw_config.editLock — ON reloads straight into the locked (view/copy)
  // page; OFF simply persists. Only this Settings checkbox and the lock panel's Unlock change it.
  async function onEditLockToggle() {
    var box = document.getElementById('esp-lock');
    var on = !!(box && box.checked);
    if (on && !window.confirm('Lock this map? Editing turns OFF for everyone (including you) until it is unlocked again. Viewing and copying stay available.')) { if (box) box.checked = false; return; }
    setStatus('Saving…');
    try {
      var u = await patchProjectConfig({ editLock: on ? true : null });   // null deletes the key
      if (u.error) throw new Error(u.error.message);
      setStatus('Saved');
      if (on) { showToast('🔒 Locked — reloading into view-only…', 4000); setTimeout(function () { location.reload(); }, 900); }
      else showToast('🔓 Unlocked.');
    } catch (e) { setStatus('Save failed'); showToast('Lock change failed: ' + (e && e.message)); if (box) box.checked = !on; }
  }
  async function onSettingsName() { return saveMapName(document.getElementById('esp-name').value); }
  // 📸 the portal thumbnail = the map exactly as framed right now. WebGL canvases read back
  // blank between frames (no preserveDrawingBuffer), so the pixels are grabbed inside a
  // 'render' tick forced by triggerRepaint — the same trick the download button uses.
  async function onSetThumbnail() {
    var note = document.getElementById('esp-thumb-note');
    try {
      if (typeof beforeMap === 'undefined' || !beforeMap) throw new Error('map not ready');
      if (note) note.textContent = 'Capturing…';
      var dataUrl = await new Promise(function (res, rej) {
        var to = setTimeout(function () { rej(new Error('capture timed out')); }, 8000);   // cliff-ok: rejects with a real error, which is the announcement
        try {
          beforeMap.once('render', function () {
            try {
              clearTimeout(to);
              var src = beforeMap.getCanvas();
              var cw = 640, ch = Math.max(1, Math.round(src.height / src.width * 640));
              var cv = document.createElement('canvas'); cv.width = cw; cv.height = ch;
              cv.getContext('2d').drawImage(src, 0, 0, cw, ch);
              res(cv.toDataURL('image/jpeg', 0.85));
            } catch (e) { rej(e); }
          });
          beforeMap.triggerRepaint();
        } catch (e) { clearTimeout(to); rej(e); }
      });
      var blob = await (await fetch(dataUrl)).blob();
      var key = 'thumbs/' + projectId + '.jpg';
      // never upsert:true — storage's upsert path needs SELECT on storage.objects and fails as
      // a bogus RLS error (tilegen-setup.sql trap). Insert; on conflict delete and retry.
      var up = await db.storage.from('tiles').upload(key, blob, { upsert: false, contentType: 'image/jpeg' });
      if (up.error && /exist|duplicate/i.test(up.error.message || '')) {
        await db.storage.from('tiles').remove([key]);
        up = await db.storage.from('tiles').upload(key, blob, { upsert: false, contentType: 'image/jpeg' });
      }
      if (up.error) throw new Error(up.error.message);
      var pub = db.storage.from('tiles').getPublicUrl(key);
      var url = ((pub && pub.data && pub.data.publicUrl) || '') + '?v=' + Date.now();   // bust the old card image
      var u = await patchProjectConfig({ thumbnail: url });
      if (u.error) throw new Error(u.error.message);
      // on the portal already? the card reads portal_entries.thumb — point it at the capture
      var pe = await db.from('portal_entries').update({ thumb: url }).eq('project_id', projectId).select('project_id');
      var onPortal = !pe.error && pe.data && pe.data.length > 0;
      if (note) note.textContent = onPortal
        ? 'Saved — the portal card now shows this view.'
        : 'Saved — used as the portal card when this map joins the portal.';
      setStatus('Thumbnail saved');
    } catch (e) {
      if (note) note.textContent = '';
      setStatus('Thumbnail failed: ' + (e && e.message));
    }
  }
  // Feature: header on/off — persists raw_config.features.header and applies live (msApplyHeaderFeature
  // moves the logo/title/About into the sidebar; a resize event re-seats the tool dock + save callout).
  async function onFeatureHeader() {
    var show = document.getElementById('esp-feat-header').checked;
    setStatus('Saving…');
    try {
      var r = await patchProjectConfig({ features: { header: show } });
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
      var r = await patchProjectConfig({ headerLogo: dataUrl }); if (r.error) throw new Error(r.error.message);
      setStatus('Logo saved');
    } catch (e) { setStatus('Logo save failed'); }
  }
  async function onLogoLink() {
    var url = (document.getElementById('esp-logo-link').value || '').trim();
    applyHeaderLink(url); setStatus('Saving…');
    try { var r = await patchProjectConfig({ headerLink: url }); if (r.error) throw new Error(r.error.message); setStatus('Logo link saved'); } catch (e) { setStatus('Save failed'); }
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
    try { var r = await patchProjectConfig({ baseMaps: bmaps(), mapSections: msecs(), zoomButtons: bzbtns() }); if (r.error) throw new Error(r.error.message); setStatus('Saved'); } catch (e) { setStatus('Save failed'); }
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
          '<li><b>Import</b> — upload GeoJSON, KML, or a zipped Shapefile. Features arrive as an editable layer; very large files automatically render the fast way.</li>' +
          '<li><b>Tileset</b> — connect a hosted vector tileset (URL + source layer) for city-scale data.</li>' +
          '<li><b>Layer</b> — a new empty layer to draw into.</li>' +
          '<li><b>Export</b> — download any layer back out as GeoJSON, KML, or Shapefile.</li>' +
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
            if (tr) {
              tr.title = 'Delete';
              trashBox.appendChild(tr); drawCluster.appendChild(trashBox);
              // The trash spoke MapboxDraw only — features selected on the MAP (ctrl-click on a
              // tileset/engine layer) live in MSSel, not draw, so the button silently did nothing
              // for them (owner 8/20: "I tried using the delete button in the map tools, it didn't
              // work. It's supposed to work both ways."). Capture phase: a real draw selection
              // keeps native behavior untouched; otherwise the MSSel selection routes into the
              // same confirmed delete the attribute table uses — one deletion path, both doors.
              tr.addEventListener('click', function (e) {
                var hasDraw = false;
                try { hasDraw = draw && draw.getSelectedIds && draw.getSelectedIds().length > 0; } catch (e2) {}
                if (hasDraw || !window.MSSel || !MSSel.count()) return;
                e.preventDefault(); e.stopImmediatePropagation();
                deleteAttrSelected();
              }, true);
            }
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
      var _hintIv = setInterval(placeHint, 500); setTimeout(function () { clearInterval(_hintIv); }, 8000);   // cliff-ok: a hint that fades
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
    // Copy asks first (8/13, owner: "It's too easy to hit that copy button by accident") —
    // a small confirm modal; the copy only runs on the second, deliberate click.
    var copyBtn = document.getElementById('editor-copy-btn'); if (copyBtn) copyBtn.addEventListener('click', confirmCopyMap);
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
        if (++tries > 50) clearInterval(iv);   // compare never showed (single-map deploys) — give up quietly  // cliff-ok: fires on every single-map deploy, so announcing it would be pure noise
      }, 200);
    })();
    setTimeout(checkStorage, 2500);   // storage-quota state (warn banner / hard-stop) once the session is ready   // cliff-ok: this path has its own retry
    makeHeaderTitleEditable();   // click the map title in the header to rename it
    try { window.infoPanelDefaultHandle = function () {}; } catch (e) {}   // suspend "click map → toggle sidebar" (use the sidebar button instead)
    document.addEventListener('keydown', function (e) {   // Esc cancels measure/split; Ctrl+Z/Y, Ctrl+C/V
      if (e.key === 'Escape' && _measuring) { e.preventDefault(); cancelMeasure(); return; }
      if (e.key === 'Escape' && _splitMode) { e.preventDefault(); cancelSplit(); return; }
      if (!(e.ctrlKey || e.metaKey)) return;
      // UNDO SCOPING (7/22, "very serious"): while the user is TYPING — inputs, textareas, and
      // any contenteditable (About/info editors, feature notes), or while a popup is in edit
      // mode — Ctrl+Z/Y must be the BROWSER'S TEXT undo, never the map's. Without the
      // isContentEditable exemption, undoing text in the About editor silently popped map
      // operations (renames, styles, group deletes) — "it was editing my map".
      var ae = document.activeElement || {};
      var tag = ae.tagName || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || ae.isContentEditable || window.__msModalLock) return;
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
    // mousedown precedes draw's mouseup-driven selectionchange, so the stage-2 promotion always
    // knows WHERE the click landed (multiPartForEdit picks the clicked part of a Multi by it)
    [beforeMap, (typeof afterMap !== 'undefined' ? afterMap : null)].forEach(function (mDn) {
      if (mDn) try { mDn.on('mousedown', function (eDn) { _lastMapClickPt = eDn.lngLat; }); } catch (eW) {}
    });
    beforeMap.addControl(draw, 'top-left');   // left side, clear of the right swipe map (offset past the sidebar in CSS)
    beforeMap.on('draw.render', measureRender);   // live distance while measuring
    beforeMap.on('draw.render', scheduleMirrorSync);   // mirror the MapboxDraw contents onto the right swipe side (both-sides display)
    try { if (typeof afterMap !== 'undefined' && afterMap) afterMap.once('idle', syncMirrorRight); } catch (e) {}   // initial paint once the right map is ready
    beforeMap.on('draw.create', onDrawCreate);
    beforeMap.on('draw.update', onDrawUpdate);
    beforeMap.on('draw.delete', onDrawDelete);
    beforeMap.on('draw.selectionchange', onSelectionChange);
    // modifier state at the moment of the click, for the multi-select bypass (selectionchange carries no
    // originalEvent). DOCUMENT-level capture (7/28): the old beforeMap-canvas listener never saw clicks
    // that land on the RIGHT swipe map, so _msModClick went stale and right-side ctrl-clicks ran the
    // plain-click model — with the swipe far left, that was EVERY click.
    try { document.addEventListener('mousedown', function (ev) { window._msModClick = !!(ev.shiftKey || ev.ctrlKey || ev.metaKey); }, true); } catch (e) {}
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
        // UNIVERSAL grab-radius cursor (7/23): ANY engine-editable feature inside the same 10px
        // corridor the CLICK uses shows the finger — feedback must never depend on a layer having
        // groups (NTAD had none → no cursor → "really hard to select"). Cheap: only queried when
        // draw + group hover both missed; only touches the cursor when it would actually change.
        try {
          if (!isDrawArmed()) {
            var hitU = !!did || !!_lastGroupGv;
            if (!hitU) {
              var sdU = (m === beforeMap) ? 'left' : 'right', eLids = [];
              (function walkU(arr) { (arr || []).forEach(function (n) { if (isEngineEditable(n) && m.getLayer(n.id + '-' + sdU)) eLids.push(n.id + '-' + sdU); if (n.children) walkU(n.children); }); })(layers);
              if (eLids.length) {
                var bxU = 10;
                var fsU = m.queryRenderedFeatures([[e.point.x - bxU, e.point.y - bxU], [e.point.x + bxU, e.point.y + bxU]], { layers: eLids });
                hitU = !!(fsU && fsU.length);
              }
            }
            var cU = m.getCanvas();
            if (hitU) { if (cU.style.cursor !== 'pointer') cU.style.cursor = 'pointer'; }
            else if (cU.style.cursor === 'pointer') cU.style.cursor = '';
          }
        } catch (eUc) {}
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
        }
        // 9e round 2 (7/28): clicking truly EMPTY ground — no draw feature, no engine data feature,
        // not mid-draw-mode — clears the whole working selection (map highlight + table stars together).
        if (!did && MSSel.count() && !engineFeatureAt(e.point)) {
          var dmode = ''; try { dmode = draw && draw.getMode ? draw.getMode() : ''; } catch (eM) {}
          if (!/^draw_/.test(dmode)) clearAttrHighlight();
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
            if (window._msModClick) {
              // ctrl = pure TOGGLE here too (7/28) — and one click mutates the selection ONCE: when an
              // engine feature overlaps the drawn one, the engine handler already consumed this click
              // (shared _selClickLock) → skip. No arm, no panel — selection only, like everywhere else.
              if (!_selClickLock) {
                _selClickLock = true; setTimeout(function () { _selClickLock = false; }, 0);
                var tfR = featureToDb[did] != null ? String(featureToDb[did]) : (did.indexOf('db-') === 0 ? did.slice(3) : null);
                syncAttrRowsFromMap([{ id: did }], { remove: tfR != null && MSSel.has(tfR) });
              }
            } else {
              if (_armedSet.indexOf(did) > -1) {   // stage 2: geometry editable (selection lives in draw on the left; the mirror shows it)
                _editingDraw = did; _armedSet = []; setArmedHl(null);
                multiPartForEdit(did, e.lngLat);   // a Multi swaps to just the CLICKED part for vertex editing
                try { draw.changeMode('simple_select', { featureIds: [did] }); } catch (err) {}
              } else {                              // stage 1: highlight + panel, geometry NOT editable
                _editingDraw = null; _armedSet = [did];
                try { draw.changeMode('simple_select', { featureIds: [] }); } catch (err) {}
                updateArmedHl();
              }
              showFeaturePanel(did);
              syncAttrRowsFromMap([{ id: did }]);
            }
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
    if (_undoStack.length > 100) {
      // the oldest step is gone for good — Ctrl+Z stops going back further, with no sign why
      if (window.MSGuard) MSGuard.cliff('undo-depth', _undoStack.length, 100,
        'undo history is full, so the oldest steps can no longer be undone');
      _undoStack.shift();
    }
    _redoStack = [];
    updateUndoButtons();
  }
  async function doUndo() {
    if (_undoing || !_undoStack.length) return;
    var op = _undoStack.pop(); _undoing = true; setStatus('Undoing…');
    try { await op.undo(); _redoStack.push(op); setStatus('Undone' + (op.label ? ' — ' + op.label : '')); showToast('↩ Undone: ' + (op.label || 'map change')); }
    catch (e) { console.warn('editing: undo failed', e); _undoStack.push(op); setStatus('Undo failed'); }
    _undoing = false; updateUndoButtons();
  }
  async function doRedo() {
    if (_undoing || !_redoStack.length) return;
    var op = _redoStack.pop(); _undoing = true; setStatus('Redoing…');
    try { await op.redo(); _undoStack.push(op); setStatus('Redone' + (op.label ? ' — ' + op.label : '')); showToast('↪ Redone: ' + (op.label || 'map change')); }
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
    if (fid) await saveSoft(db.from('features').delete().eq('feature_id', fid), 'removing the feature');
    delete featureToDb[drawId]; delete featureMeta[drawId]; delete featureLayer[drawId]; delete _geomSnap[drawId];
  }
  async function addDrawnFeature(drawId, geom, lyr, props) {
    // undo/paste path: if this insert is refused the shape is on the canvas with no database row
    // behind it, so every later edit to it silently targets nothing
    var insR = await saveSoft(db.from('features').insert({ layer_id: lyr, geom: geom }).select('feature_id'), 'restoring the feature');
    var ins = { error: insR.error, data: Array.isArray(insR.data) ? insR.data[0] : insR.data };
    if (!ins.error && ins.data) { featureToDb[drawId] = ins.data.feature_id; featureMeta[drawId] = { label: '', notes: '', start: '', end: '' }; featureLayer[drawId] = lyr; }
    try { if (draw && !draw.get(drawId)) draw.add({ type: 'Feature', id: drawId, geometry: geom, properties: props || {} }); } catch (e) {}
    _geomSnap[drawId] = JSON.parse(JSON.stringify(geom));
  }
  async function setDrawnGeom(drawId, geom) {
    var fid = featureToDb[drawId];
    var EBg = _engineEditNode[drawId] ? getEditBackend(_engineEditNode[drawId]) : PLATFORM_FEATURES;   // Phase 2a
    if (fid) { var gpatch = {}; gpatch[EBg.geomCol] = toDbGeom(drawId, geom); await saveSoft(EBg.db.from(EBg.table).update(gpatch).eq(EBg.idCol, fid), 'saving the moved shape'); }
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
    // supabase RESOLVES with {error}, so the catch alone never fired on a refused delete: the rows
    // vanished from the screen and came back on reload.
    var delR = await saveSoft(db.from('features').delete().in('feature_id', fids), 'deleting the selected features');
    if (delR.error) { setStatus('Delete failed'); return 0; }
    cap.forEach(function (c) { delete featureToDb[c.drawId]; delete featureMeta[c.drawId]; delete featureLayer[c.drawId]; delete _geomSnap[c.drawId]; });
    pushUndo(function () { return reinsertDrawn(cap); }, function () { return removeDrawnBatch(cap); }, label || ('delete ' + cap.length + ' feature' + (cap.length > 1 ? 's' : '')));
    return cap.length;
  }
  async function reinsertDrawn(cap) {   // undo: re-insert each captured row (new feature_id) + restore in MapboxDraw
    for (var i = 0; i < cap.length; i++) {
      var c = cap[i];
      try {
        var insU = await saveSoft(db.from('features').insert({ layer_id: c.lyr, geom: c.geom, label: c.label, description: c.description, start_date: c.start_date, end_date: c.end_date, custom_fields: c.custom_fields }).select('feature_id'), 'undoing the delete');
        var ins = { error: insU.error, data: Array.isArray(insU.data) ? insU.data[0] : insU.data };
        if (!ins.error && ins.data) {
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
    var ol = paintOutline(paint);
    // the runtime paint's outline is BLANKED to transparent whenever a -stroke- companion owns the
    // border (any width ≠ 1) — pass the companion's real colour through, or every pulled-in draw
    // copy renders borderless (the 8/8 click-vanish's "just the border disappears" half)
    if (ol != null && String(ol).replace(/\s+/g, '') === 'rgba(0,0,0,0)' && node && node.stroke && node.stroke['line-color']) ol = node.stroke['line-color'];
    if (ol != null) p.outline = ol;
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
    if (!node.type) { node.type = gtype; node.iconType = GEOM_TO_ICON[_clipboard.type] || node.iconType; await saveSoft(db.from('layers').update({ type: gtype }).eq('id', lid), 'stamping the pasted layer geometry type'); rerender(); }
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
      if (!uid) {
        if (_storageTries++ < 40) { setTimeout(checkStorage, 1500); return; }   // session not ready yet — retry (slow boots can take a while; the DB trigger is the hard backstop regardless)
        // 60 seconds without a session: the quota check never runs this session, so the
        // over-quota banner never appears and the first sign of being full is a refused save.
        if (window.MSGuard) MSGuard.cliff('storage-check-giveup', _storageTries, 40,
          'your storage usage could not be checked this session, so the space warning will not appear (saving is still protected by the server)');
        return;
      }
      // the ADMIN account is quota-exempt (for now) — no banner, no gate; the platform-wide
      // free-infra alert lives on admin.html instead (30% of the Supabase free plan).
      // The ?storagefull=1 test seam OVERRIDES the exemption (it exists to force the full
      // state for ANY logged-in account, and the harness logs in as admin).
      var force = location.search.indexOf('storagefull=1') > -1;
      var uEmail = u.data.user.email || '';
      if (!force && MS_ADMINS.indexOf(uEmail) > -1) { _storageOver = false; _storageInfo = null; _storageLast = Date.now(); updateStorageBanner(); return; }
      var tierKey = 'free';
      try { var mp = await db.rpc('ms_my_plan'); var m0 = mp && mp.data && (mp.data[0] || mp.data);
        if (!mp.error && m0 && m0.subscription_tier) tierKey = m0.subscription_tier; } catch (e) {}
      // profiles.subscription_tier has been ungranted to clients since the 7/30 lockdown — this
      // direct read only produced a 403 in the console. ms_my_plan() is the supported way.
      if (tierKey === 'free') { try { var pr = await db.rpc('ms_my_plan'); var pr0 = pr && pr.data && (pr.data[0] || pr.data); if (!pr.error && pr0 && pr0.subscription_tier) tierKey = pr0.subscription_tier; } catch (e) {} }
      var used = 0;
      try { var rpc = await db.rpc('mapstructor_user_storage'); if (!rpc.error && typeof rpc.data === 'number') used = rpc.data; } catch (e) {}
      var quota = P.stepFor(tierKey).quotaBytes;
      _storageInfo = { used: used, quota: quota, tierKey: tierKey, frac: quota ? used / quota : 0 };
      _storageOver = used >= quota;
      if (force) { _storageOver = true; _storageInfo = { used: quota, quota: quota, tierKey: tierKey, frac: 1 }; }   // test seam
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
    el.innerHTML = (_storageOver ? '<b>Storage full</b> — ' : 'Storage ' + Math.round(_storageInfo.frac * 100) + '% — ') + P.fmtBytes(_storageInfo.used) + ' / ' + P.fmtBytes(_storageInfo.quota) + '. '
      + (_storageOver ? '<a href="#" id="esb-upgrade" style="color:#fff;text-decoration:underline;font-weight:700;">Upgrade</a> · ' : '')
      + '<a href="../dashboard.html" target="_blank" style="color:#fff;text-decoration:underline;">Dashboard ↗</a>';
    var up = document.getElementById('esb-upgrade'); if (up) up.onclick = function (ev) { ev.preventDefault(); showStorageModal(); };
  }
  function storageGate() {   // returns true if a new feature should be BLOCKED (and tells the user)
    maybeRecheckStorage();   // fire-and-forget freshness: if this session never got a check (slow boot), the NEXT gate call sees the truth — the DB quota trigger is the hard backstop meanwhile
    if (!_storageOver) return false;
    showStorageModal();
    updateStorageBanner();
    return true;
  }
  // ── Storage-limit modal — the friendly wall at 100%: shows usage, every step above the
  // current one with its price (Stripe checkout inline, same Edge Function the dashboard
  // uses), a Dashboard door, and a "clear space" dismiss. NO overages, nothing auto-charges,
  // and existing data is never touched — the modal only blocks ADDING more. ──
  function closeStorageModal() {
    var ov = document.getElementById('ms-storage-modal'); if (!ov || ov.style.display === 'none') return;
    ov.style.display = 'none';
    window.__msModalLock = ov._prevLock || false;   // restore, don't clear — the feature-edit modal may also hold the lock
    if (ov._esc) { document.removeEventListener('keydown', ov._esc, true); ov._esc = null; }
  }
  function showStorageModal() {
    var P = window.MapStructorPricing; if (!P) return;
    var info = _storageInfo || { used: P.stepFor('free').quotaBytes, quota: P.stepFor('free').quotaBytes, tierKey: 'free', frac: 1 };
    var ov = document.getElementById('ms-storage-modal');
    if (!ov) {
      ov = document.createElement('div');
      ov.id = 'ms-storage-modal';
      // created display:NONE — the open block below flips it to flex. (Creating it already-flex
      // made the "am I opening?" check a no-op on first show → lock + Escape never attached.)
      ov.style.cssText = 'position:fixed;inset:0;z-index:7000;background:rgba(24,20,38,0.45);display:none;align-items:center;justify-content:center;font-family:Source Sans Pro,Arial,sans-serif;';
      document.body.appendChild(ov);
      // backdrop closes ONLY if the press also STARTED on the backdrop — a drag that merely
      // ENDS there (e.g. out of a button) must not dismiss (same guard as the feature-edit modal)
      ov.addEventListener('mousedown', function (e) { ov._downOnBackdrop = e.target === ov; });
      ov.addEventListener('click', function (e) { if (e.target === ov && ov._downOnBackdrop) closeStorageModal(); });
    }
    var upgrades = P.upgradesFrom(info.tierKey);
    var rec = upgrades.filter(function (s) { return s.quotaBytes > info.used; })[0] || upgrades[0];   // smallest step that HOLDS current usage
    var rows = upgrades.map(function (s) {
      var main = rec && s.key === rec.key;
      return '<button class="ms-sm-step" data-step="' + s.key + '" style="display:flex;justify-content:space-between;align-items:center;width:100%;box-sizing:border-box;margin:0 0 6px;padding:9px 12px;border-radius:8px;cursor:pointer;font-size:14px;'
        + (main ? 'border:1px solid #7c5cbf;background:#7c5cbf;color:#fff;font-weight:700;' : 'border:1px solid #d7d3e4;background:#fff;color:#333;') + '">'
        + '<span>' + s.label + (main ? ' <span style="font-weight:400;opacity:0.85;">(fits your data)</span>' : '') + '</span><span>$' + s.priceMonthly + '/mo</span></button>';
    }).join('');
    ov.innerHTML =
      '<div style="width:min(400px,calc(100vw - 40px));max-height:calc(100vh - 60px);overflow-y:auto;background:#fff;border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,0.35);padding:18px 20px;">'
      + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:2px;"><b style="font-size:18px;color:#2b2540;">Storage full</b>'
      + '<button id="ms-sm-close" title="Close" style="border:none;background:none;font-size:22px;color:#8a84a0;cursor:pointer;line-height:1;padding:2px 4px;">&times;</button></div>'
      + '<div style="font-size:13px;color:#555;">' + P.fmtBytes(info.used) + ' of ' + P.fmtBytes(info.quota) + ' used</div>'
      + '<div style="height:8px;border-radius:4px;background:#eee9f6;margin:7px 0 12px;overflow:hidden;"><div style="height:100%;width:' + Math.min(100, Math.round((info.frac || 0) * 100)) + '%;background:#b4453a;"></div></div>'
      + '<div style="font-size:13px;color:#444;margin-bottom:12px;">Your maps and data are safe — nothing is removed, nothing auto-charges. To keep adding, pick more storage or clear some space.</div>'
      + (upgrades.length ? rows : '<div style="font-size:13px;color:#444;margin-bottom:10px;">You&rsquo;re at the top step — email <a href="mailto:' + P.contactEmail + '" style="color:#7c5cbf;">' + P.contactEmail + '</a> and we&rsquo;ll set you up with more.</div>')
      + '<div id="ms-sm-status" style="display:none;font-size:12px;color:#b4453a;margin:2px 0 6px;"></div>'
      + '<div style="display:flex;justify-content:space-between;align-items:center;margin-top:8px;font-size:13px;">'
      + '<a href="../dashboard.html" target="_blank" style="color:#7c5cbf;text-decoration:underline;">Open Dashboard ↗</a>'
      + '<button id="ms-sm-later" style="border:none;background:none;color:#8a84a0;cursor:pointer;font-size:13px;text-decoration:underline;padding:0;">Not now — I&rsquo;ll clear space</button>'
      + '</div></div>';
    Array.prototype.forEach.call(ov.querySelectorAll('.ms-sm-step'), function (btn) {
      btn.onclick = function () { startStorageCheckout(btn.getAttribute('data-step'), btn); };
    });
    document.getElementById('ms-sm-close').onclick = closeStorageModal;
    document.getElementById('ms-sm-later').onclick = closeStorageModal;
    if (ov.style.display !== 'flex') {   // opening (not a re-render while already open)
      ov._prevLock = window.__msModalLock || false;
      window.__msModalLock = true;   // editor hotkeys + engine backdrop stand down while this is up
      ov._esc = function (e) { if (e.key === 'Escape') { e.stopPropagation(); closeStorageModal(); } };
      document.addEventListener('keydown', ov._esc, true);
      ov.style.display = 'flex';
    }
  }
  async function startStorageCheckout(stepKey, btn) {
    var P = window.MapStructorPricing, step = P.stepFor(stepKey);
    var st = document.getElementById('ms-sm-status');
    function fail(msg) { if (st) { st.style.display = 'block'; st.textContent = msg; } }
    if (!step.stripePriceId) { fail('Checkout for ' + step.label + ' isn’t set up yet — use the Dashboard.'); return; }
    var old = btn.innerHTML; btn.disabled = true; btn.innerHTML = 'Opening checkout…';
    try {   // same call the dashboard makes — Stripe-hosted page, back here on success/cancel
      var r = await db.functions.invoke('create-checkout-session', { body: { priceId: step.stripePriceId, tier: step.key, successUrl: location.href, cancelUrl: location.href } });
      if (r.data && r.data.url) { location.href = r.data.url; return; }
      fail('Could not start checkout: ' + ((r.error && r.error.message) || (r.data && r.data.error) || 'unknown'));
    } catch (e) { fail('Could not start checkout: ' + ((e && e.message) || e)); }
    btn.disabled = false; btn.innerHTML = old;
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
    // hard-stop at 100% storage. The discard is DEFERRED a tick: deleting inside the create
    // handler while the draw mode is still finishing doesn't stick (the mode re-adds it) —
    // the old blocking alert() masked this by freezing JS until the mode had settled.
    if (storageGate()) { var gid = f.id; setTimeout(function () { try { if (draw) { draw.changeMode('simple_select'); draw.delete(gid); } } catch (e) {} }, 0); return; }
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
      // This is the write that fixes a new layer's geometry type from its first drawn feature.
      // It was a bare try/console.warn: if it failed, the layer rendered correctly for the rest of
      // the session and came back TYPELESS after a reload, with only the console any the wiser —
      // family B feeding family E. saveSoft reports it (toast + assertable log) without throwing
      // into a drawing gesture, and `rows: 'some'` also catches the RLS shape where the request
      // succeeds and changes nothing.
      await saveSoft(db.from('layers').update({ type: mapType }).eq('id', lid), 'set layer type', { rows: 'some' });
      rerender();
    }

    setStatus('Saving…');
    featureLayer[f.id] = lid;   // OPTIMISTIC: a restyle during the save round-trip repaints this feature too (confirmed below, removed in catch)
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
    } catch (err) {
      if (featureToDb[f.id] == null) delete featureLayer[f.id];   // insert never landed — drop the optimistic mapping
      console.warn('editing: feature save failed', err); setStatus('Draw save failed: ' + err.message);
    }
  }
  async function onDrawUpdate(e) {
    for (var i = 0; i < (e.features || []).length; i++) {
      var f = e.features[i], fid = featureToDb[f.id]; if (!fid) continue;
      var oldGeom = _geomSnap[f.id], newGeom = JSON.parse(JSON.stringify(f.geometry));
      var saveGeom = toDbGeom(f.id, f.geometry); if (_engineWasMulti[f.id]) _engineOrigMulti[f.id] = saveGeom;
      var EBu = _engineEditNode[f.id] ? getEditBackend(_engineEditNode[f.id]) : PLATFORM_FEATURES;   // Phase 2a: tileset edits → the layer's backend; drawn → platform features
      var upatch = {}; upatch[EBu.geomCol] = saveGeom;
      // moving a shape is the most tactile edit there is; if the database refuses, the shape stays
      // where you dropped it on screen and snaps back on the next load
      await saveSoft(EBu.db.from(EBu.table).update(upatch).eq(EBu.idCol, fid), 'saving the moved shape');
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
      // pressing Delete removed the shape from the canvas either way; if the database refused,
      // it used to come back on the next reload with nothing having said a word
      var dr = await saveSoft(db.from('features').delete().eq('feature_id', fid), 'deleting the feature');
      if (dr.error) continue;
      delete featureToDb[f.id]; delete featureMeta[f.id]; delete featureLayer[f.id]; delete _geomSnap[f.id];
      (function (drawId, geom, lyr, props) {
        pushUndo(function () { return addDrawnFeature(drawId, geom, lyr, props); }, function () { return removeDrawnFeature(drawId); }, 'delete feature');
      })(drawId, geom, lyr, props);
    }
    setStatus('Saved');
  }
  var _lfGen = 0;   // loadFeatures generation — overlapping calls raced on draw.set (8/14): a
  // slow earlier call could land its rows AFTER a newer one (e.g. the recolour that follows a
  // colour-by pick), silently reverting the store to pre-pick colours. Newest call wins, always.
  async function loadFeatures() {
    var _gen = ++_lfGen;
    if (idsReady) { try { await idsReady; } catch (e) {} }
    if (!draw) return;

    // map each drawn layer's db id → its style, + collect the geojson layers
    var dbColor = {}, dbOpacity = {}, dbOutline = {}, dbStrokeOp = {}, dbStrokeWidth = {}, dbRadius = {}, gjList = [];
    (function walk(arr) { (arr || []).forEach(function (n) { if (n.source_type === 'geojson-supabase') { var did = slugToLayerDbId[n.id]; if (did) { /* paint's literal colour wins: an imported hollow fill (rgba(0,0,0,0)) must not fall back to the sidebar icon colour */ var pc0 = (n.paint && typeof n.paint[colorKeyFor(n.type)] === 'string') ? n.paint[colorKeyFor(n.type)] : null; dbColor[did] = pc0 || n.iconColor || '#3bb2d0'; var op = paintOpacity(n.paint); if (op != null) dbOpacity[did] = op; var ol = paintOutline(n.paint); if (ol != null) dbOutline[did] = ol; if (n.paint && n.paint['line-opacity'] != null) dbStrokeOp[did] = n.paint['line-opacity']; var wd = paintWidth(n.paint); if (wd != null) dbStrokeWidth[did] = wd; if (n.paint && n.paint['circle-radius'] != null) dbRadius[did] = n.paint['circle-radius']; if (n.outlineSplit) dbStrokeOp[did] = 0; gjList.push({ slug: n.id, did: did }); } } if (n.children) walk(n.children); }); })(layers);

    // Classify by size: small layers edit in MapboxDraw; large ones (imported 10k+ datasets) render
    // via the engine like a tileset — MapboxDraw can't hold tens of thousands of features (it freezes).
    // 7/21: DATED layers (any feature with start/end dates) also render via the ENGINE regardless of size —
    // MapboxDraw copies carry no dates and apply no timeline filter, so in-draw layers could never animate
    // (the Steamboat bug). Engine-rendered = animates like the viewer; editing = click a feature to pull it in.
    _drawLayerSlugs = {};
    // Published so projectLoader's deferred sweep can skip exactly what this function owns, instead
    // of skipping the whole editor page. Same object by reference, so it stays current as the
    // classification below fills it. Undefined until the first loadFeatures = "not classified yet".
    window.__msDrawOwned = _drawLayerSlugs;
    var smallIds = [];
    // one COUNT per layer, but in PARALLEL — awaiting them one-by-one stalled boot ~N×roundtrip (20+
    // drawn layers = several seconds before any feature data even started downloading)
    var counts = await Promise.all(gjList.map(function (gj2) {
      return db.from('features').select('feature_id', { count: 'exact', head: true }).eq('layer_id', gj2.did).then(function (cq) { return (cq && cq.count) || 0; }, function () { return 0; });
    }));
    var datedCounts = await Promise.all(gjList.map(function (gj2) {
      return db.from('features').select('feature_id', { count: 'exact', head: true }).eq('layer_id', gj2.did).or('start_date.not.is.null,end_date.not.is.null').then(function (cq) { return (cq && cq.count) || 0; }, function () { return 0; });
    }));
    counts.forEach(function (cn, gi) {
      if (cn > 0 && cn <= MAX_DRAW && !datedCounts[gi]) { smallIds.push(gjList[gi].did); _drawLayerSlugs[gjList[gi].slug] = true; return; }
      // The single most confusing silent limit in the editor: past MAX_DRAW (or the moment a layer
      // gains dates) the vertex handles stop appearing and clicking a shape no longer selects it.
      // The layer looks exactly the same, so it reads as "editing broke", not "this layer is big".
      if (cn > MAX_DRAW && window.MSGuard) MSGuard.cliff('draw-cap:' + gjList[gi].slug, cn, MAX_DRAW,
        'this layer is now drawn by the map engine instead of the shape editor, so its points cannot be dragged directly');
    });
    // the map contains a big-table layer → warm the columnar engine at idle, so the first table
    // open never pays the engine load (user-proposed prefetch rule, 7/18)
    // Warm the columnar engine AND the sidecars it will need. Gating this on geojson row counts
    // alone missed the layers that need it most: a tiled or folded layer has its rows in a parquet
    // sidecar and no big `counts` entry at all, so the map with the slowest table never prewarmed.
    try {
      if (window.MSBigTable) {
        var _warmCars = [];
        (function walkWarm(arr) {
          (arr || []).forEach(function (n) {
            if (!n) return;
            if (n.children) return walkWarm(n.children);
            if (n.attrParquet && !n.attrParquetDirty) _warmCars.push({ layerId: slugToLayerDbId[n.id] || n._layerDbId, url: n.attrParquet, ver: n.attrParquetAt });
          });
        })(layers);
        /* AFTER THE MAP IS UP, not during boot. This warm instantiates DuckDB, which means
           downloading a 33.4 MB WASM engine, and it was firing inside loadFeatures — competing
           with the map's own data for the connection on a cold cache. Measured 8/21 on "Railroads
           and the Making of Modern America": 42.9 MB of boot traffic, of which 39.6 MB was the
           app's own assets and only 1.7 MB the project's data, first pixels at ~18-20s.
           The warm is speculative by its own description ("must never be able to break an open"),
           so it has no business ahead of the thing the person is waiting for. Same treatment the
           deferred feature sweep got: wait for the first idle, then a breath. The belt-timer
           covers a map that never idles. (The engine is cached across visits — this is a
           first-visit cost — but a first visit is exactly when a slow map is judged.) */
        if (_warmCars.length || counts.some(function (cn) { return cn > MSBigTable.BIG_ROWS; })) {
          var warmNow = function () { try { MSBigTable.prefetch(_warmCars); } catch (eW) {} };
          var mW = (typeof beforeMap !== 'undefined') ? beforeMap : null;
          if (mW && mW.once) mW.once('idle', function () { setTimeout(warmNow, 1500); });   // cliff-ok: a breath after first idle, so the warm never races the map's own data
          setTimeout(warmNow, 15000);   // cliff-ok: belt for a map that never idles; prefetch() is idempotent
        }
      }
    } catch (e) {}
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
      if (cbNode && cbNode.colorBy && cbNode.colorBy.mapping) {
        var cbv = cbValueOf(row, cbNode.colorBy.prop);   // dedicated columns (label…) resolve too (8/14)
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
      // "Match fill colors" (8/14): the border is THIS feature's own fill colour — applied after
      // every override so a categorical or per-feature colour carries into the border too. An
      // explicit ms_linecolor still wins (it names the border colour outright).
      if (cbNode && cbNode.outlineMatchFill) {
        var msLC = row.custom_fields && row.custom_fields.ms_linecolor;
        var lcSet = msLC != null && String(msLC).trim() !== '' && String(msLC).trim().toLowerCase() !== 'none';
        if (!lcSet) props.outline = props.color;
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
        // adaptive pages (8/13): heavy geometry breaks fixed 1000-row pages (statement timeout)
        var r6 = await window.MSFetchRows(db, FEAT_SEL, function (q) { return q.eq('layer_id', lid6); });
        var ok6 = !r6.error;   // a failed fetch must NOT mark the layer hydrated-but-empty — the sweep retry / next toggle refetches
        (r6.rows || []).forEach(function (row) { var m6 = mapRow(row); if (m6) featureCache[m6.did] = m6.fo; });
        if (ok6) { _hydratedLayers[lid6] = true; addCachedLayerToDraw(lid6); rebuildLabelsFor([lid6]); }
        if (!quiet) setStatus(ok6 ? '' : 'Load failed');
      } catch (e) { console.warn('editing: layer hydrate failed', e); if (!quiet) setStatus('Load failed'); }
      _hydrating[lid6] = false;
    };
    try {
      var feats = [];
      if (onIds.length) {
        // adaptive pages (8/13): heavy geometry breaks fixed 1000-row pages (statement timeout)
        var res = await window.MSFetchRows(db, FEAT_SEL, function (q) { return q.in('layer_id', onIds); });
        if (res.error) console.warn('editing: load features failed', res.error);
        (res.rows || []).forEach(function (row) { var m = mapRow(row); if (!m) return; if (m.hidden) featureCache[m.did] = m.fo; else feats.push(m.fo); });
      }
      if (_gen !== _lfGen) return;   // a newer loadFeatures started while we fetched — it owns the store
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
          // companions-ok: only the label layer was just rebuilt, so only it needs re-hiding.
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
      /* AFTER FIRST IDLE, like the DuckDB warm and projectLoader's own sweep. These are layers
         whose checkbox is OFF: nobody is looking at them, and hydrating them was 47 REST calls and
         5.5s of a 16.4s boot, in a pool of three, competing with the data the person IS waiting
         for. Measured 8/21 by classifying every boot request.
         Safe and self-healing: ticking a hidden layer on before its turn goes through the
         on-toggle priority path (_hydrateOne for small layers, hydrateDeferredLayer for large),
         which is the same route a hydration FAILURE already relies on. */
      var startWarm = function () {
        pool7(order).then(function () {
          var missed = order.filter(function (lid8) { return !_hydratedLayers[lid8]; });
          if (missed.length) return pool7(missed);   // failures stayed un-hydrated — one retry pass
        });
      };
      var mH = (typeof beforeMap !== 'undefined') ? beforeMap : null;
      if (mH && mH.once) mH.once('idle', function () { setTimeout(startWarm, 800); });   // cliff-ok: a breath after first idle so hidden layers never race the visible ones
      else setTimeout(startWarm, 4000);   // cliff-ok: no map to wait on — fall back to a fixed delay
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
        // 0.45 buried a clicked COUNTRY under yellow (stacked with the 0.18 selection wash it read
        // as "the feature disappeared", 8/8) — the ORANGE RING is the armed signal; the wash is a hint
        m.addLayer({ id: 'editor-armed-hl-fill', type: 'fill', source: 'editor-armed-hl', filter: ['==', '$type', 'Polygon'], paint: { 'fill-color': '#ffd54d', 'fill-opacity': 0.12 } });
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
  function updateArmedHl() { setArmedHl(_armedSet.map(function (id2) { try { return draw.get(id2); } catch (e) { return null; } }).filter(Boolean)); }   // a stale id must yield [] — a null in setData throws and the source keeps its OLD ring (8/8)
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
    // boot-ok: map-level 'idle' handler, same reasoning as _engineMapClickWired above.
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
  function syncAttrRowsFromMap(feats, opts) {   // clicking feature(s) on the MAP selects their row(s) in the open attribute table
    // Empty NO LONGER means "wipe the selection" (7/28 carve-out) — draw deselects also fire on mode
    // changes and saves, and wholesale wipes from here were selection-bug cause #5. The only full clear
    // is the explicit empty-ground click (map click handler → clearAttrHighlight → MSSel.clear).
    if (!feats || !feats.length) return;
    // MERGE, never replace (7/28 final model: clicking features accumulates the working set). All
    // mutations go through MSSel — the subscriber repaints every surface. opts.remove → take fids OUT.
    // No table open (7/28): the selection still updates — there's just no row to scope against or scroll to.
    var lyr = _attrSlug ? slugToLayerDbId[_attrSlug] : null;
    var fids = feats.map(function (f2) {
      var did = String(f2.id);
      var n = featureToDb[did] != null ? featureToDb[did] : (did.indexOf('db-') === 0 ? did.slice(3) : null);
      if (n == null) return null;
      var fl = featureLayer[did];   // scope by the REAL layer when a table is open; unknown → require an indexed row
      if (fl != null && lyr != null && fl !== lyr) return null;
      if (fl == null && _attrSlug && !_attrById[String(n)]) return null;
      return String(n);
    }).filter(Boolean);
    if (!fids.length) return;   // clicked feature(s) belong to a different layer
    fids.forEach(function (fid) { if (opts && opts.remove) MSSel.remove(fid); else MSSel.add(fid); });
    if (window._msModClick) setStatus(MSSel.count() + ' selected — ctrl-click to add/remove');
    if (!_attrSlug || (opts && opts.remove)) return;   // no table → nothing to scroll; removals → nothing to scroll to
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
    if (!e.features || !e.features.length) { _skipArmOnce = false; _editingDraw = null; _armedSet = []; setArmedHl(null); updateGroupHl(null); hideFeaturePanel(); return; }   // draw deselect ≠ clear the selection (empty-ground clicks clear via the map click handler)
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
    if (mod && _selClickLock) { deferDrawSel([]); return; }   // an engine handler already consumed THIS ctrl-click (overlapping engine+drawn features) — one click, one mutation
    if (_armedSet.indexOf(id) > -1) {
      if (mod) {   // modifier-click a highlighted feature → remove it from the set (and the selection)
        _armedSet = _armedSet.filter(function (x) { return x !== id; });
        deferDrawSel([]);
        updateArmedHl(); syncAttrRowsFromMap([{ id: id }], { remove: true });
        return;
      }
      // stage 2: plain click on the already-highlighted feature → geometry becomes editable
      _editingDraw = id; _armedSet = [];
      setArmedHl(null);
      multiPartForEdit(id, _lastMapClickPt);   // a Multi swaps to just the CLICKED part for vertex editing
      deferDrawSel([id]);
      showFeaturePanel(id);   // idempotent — also restores the panel when entering from a multi-select set
      updateGroupHl(id);      // the company stays lit while one piece is being edited
      syncAttrRowsFromMap([{ id: id }]);
      return;
    }
    // clicked an un-highlighted feature
    if (mod) {   // modifier-click GATHERS highlights (multi-select set, nothing editable)
      // …but if this feature is ALREADY in the selection (e.g. engine-side ctrl-selected earlier),
      // ctrl = TOGGLE everywhere: remove it instead of re-gathering (7/28 unified model)
      var tfid = featureToDb[id] != null ? String(featureToDb[id]) : (id.indexOf('db-') === 0 ? id.slice(3) : null);
      if (tfid != null && MSSel.has(tfid)) {
        deferDrawSel([]);
        syncAttrRowsFromMap([{ id: id }], { remove: true });
        return;
      }
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
      // per-feature color (8/13, owner: "I should be able to select features and change their colors")
      // — writes the UNIVERSAL ms_color column, same as editing it in the attribute table
      '<label style="display:block;font-size:11px;color:#555555;margin-bottom:2px;">Color — this feature only</label>' +
      '<div style="display:flex;gap:6px;align-items:center;margin-bottom:8px;">' +
        '<input id="efp-color" type="color" style="flex:0 0 46px;width:46px;height:26px;padding:0;border:1px solid #bbbbbb;border-radius:4px;background:#fff;cursor:pointer;" />' +
        '<button id="efp-color-clear" type="button" title="Back to the layer\'s color" style="flex:0 0 auto;padding:4px 8px;border:1px solid #bbbbbb;border-radius:4px;background:#e8e8e8;color:#222222;cursor:pointer;font-size:11px;">Reset</button>' +
        '<span id="efp-color-note" style="font-size:10px;color:#888888;"></span>' +
      '</div>' +
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
      '<div style="display:flex;gap:6px;align-items:center;margin-bottom:6px;"><button id="efp-image-upload" type="button" style="flex:0 0 auto;padding:4px 8px;border:1px solid #bbbbbb;border-radius:4px;background:#e8e8e8;color:#222222;cursor:pointer;font-size:11px;">Upload…</button><button id="efp-image-remove" type="button" style="flex:0 0 auto;padding:4px 8px;border:1px solid #bbbbbb;border-radius:4px;background:#e8e8e8;color:#222222;cursor:pointer;font-size:11px;">Remove</button><span id="efp-image-status" style="font-size:10px;color:#888888;"></span></div>' +
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
    document.getElementById('efp-color').addEventListener('input', function () { onFeatureColor(this.value); });
    document.getElementById('efp-color-clear').addEventListener('click', function () { onFeatureColor(null); });
    var efpNotes = document.getElementById('efp-notes');
    efpNotes.addEventListener('input', function () { onFeatureField('notes', this.innerHTML); });   // contenteditable → store HTML (WYSIWYG)
    Array.prototype.forEach.call(document.querySelectorAll('#efp-notes-tools button[data-cmd]'), function (b) {
      b.addEventListener('mousedown', function (e) { e.preventDefault(); });   // keep the caret/selection inside efp-notes
      b.addEventListener('mousedown', function (e) { e.preventDefault(); });   // keep the text selection alive (see modal toolbar note)
      b.addEventListener('click', function (e) {
        e.preventDefault();
        var cmd = b.getAttribute('data-cmd'), val;
        if (cmd === 'createLink') { val = prompt('Link URL:'); if (!val) return; }
        try { document.execCommand(cmd, false, val || undefined); } catch (err) {}
        onFeatureField('notes', efpNotes.innerHTML);   // persist the formatting change
      });
    });
    document.getElementById('efp-image').addEventListener('input', function () { onFeatureField('image_url', this.value); updateImagePreview(this.value); });
    document.getElementById('efp-image-upload').addEventListener('click', function () { document.getElementById('efp-image-file').click(); });
    document.getElementById('efp-image-file').addEventListener('change', function () { if (this.files && this.files[0]) uploadFeatureImage(this.files[0]); this.value = ''; });
    document.getElementById('efp-image-remove').addEventListener('click', function () {   // clear the image → saves image_url=null; the stored object is harmless to leave
      var inp = document.getElementById('efp-image'); if (inp) inp.value = '';
      onFeatureField('image_url', ''); updateImagePreview('');
      var st = document.getElementById('efp-image-status'); if (st) st.textContent = 'Removed';
    });
    document.getElementById('efp-start').addEventListener('change', function () { onFeatureField('start', this.value); });
    document.getElementById('efp-end').addEventListener('change', function () { onFeatureField('end', this.value); });
  }
  // ── per-feature color (8/13): the panel's Color input writes the feature's ms_color — the same
  //    UNIVERSAL style column the attribute table edits, so ONE write path serves every layer kind.
  //    Draw-resident copies repaint instantly (delete+add — the only thing that repaints draw);
  //    tiled layers fold the override into their persisted by-id paint once the save lands.
  //    Reset stores "none" = explicit no-override, renders as the layer color. ──
  var _featColorT = null;
  function syncFeatColorUi(meta, node) {
    var inp = document.getElementById('efp-color'), note = document.getElementById('efp-color-note');
    if (!inp) return;
    var ov = (meta && meta.custom && meta.custom.ms_color != null) ? String(meta.custom.ms_color).trim() : '';
    if (ov.toLowerCase() === 'none') ov = '';
    // no override → show what the feature ACTUALLY renders as: its CATEGORY color under an
    // active color-by, else the layer color (owner 8/13: "Colors don't match in the feature popup")
    var catC = null;
    try { if (!ov && node && node.colorBy && node.colorBy.mapping && meta) { var cvS = metaCbValue(meta, node.colorBy.prop); if (cvS != null) catC = node.colorBy.mapping[String(cvS)] || null; } } catch (eS) {}
    var show = ov || catC || (node && node.iconColor) || '#3bb2d0';
    inp.value = looksHex(show) ? normHex(show) : '#888888';
    if (note) note.textContent = ov ? 'overriding the layer color' : (catC ? 'category color — pick to override' : 'layer color — pick to override');
  }
  function onFeatureColor(hex) {
    var did = selectedDrawId; if (!did) return;
    var fid = featureToDb[did];
    var lidC = featureLayer[did] || (activeLayerId ? slugToLayerDbId[activeLayerId] : null);
    var nodeC = lidC ? nodeByLayerDbId(lidC) : null;
    var m = featureMeta[did] = featureMeta[did] || { label: '', notes: '' };
    m.custom = m.custom || {};
    m.custom.ms_color = hex || 'none';
    syncFeatColorUi(m, nodeC);
    try {
      var f = draw && draw.get && draw.get(did);
      if (f) {
        var backC = (nodeC && nodeC.iconColor) || '#3bb2d0';
        // Reset under an active color-by goes back to the feature's CATEGORY color, not the
        // layer fallback (same rule the engine-edit pull-in applies when it builds the copy)
        try { if (!hex && nodeC && nodeC.colorBy && nodeC.colorBy.mapping) { var cbv3 = metaCbValue(m, nodeC.colorBy.prop); var mc3 = cbv3 != null ? nodeC.colorBy.mapping[String(cbv3)] : null; if (mc3) backC = mc3; } } catch (e3) {}
        f.properties.color = hex || backC;
        _suppressFeatureDelete = true;
        draw.delete(did); draw.add(f);
        setTimeout(function () { _suppressFeatureDelete = false; }, 0);
      }
    } catch (e) {}
    if (_featColorT) clearTimeout(_featColorT);
    _featColorT = setTimeout(async function () {
      if (fid == null) { setStatus('Color saves once the feature itself is saved'); return; }
      setStatus('Saving…');
      try {
        // read-modify-write THROUGH the features view — its triggers split ms_* into
        // feature_styles and strip identity keys, so echoing the whole object back loses nothing
        var r0 = await db.from('features').select('custom_fields').eq('feature_id', fid).single();
        if (r0.error) throw new Error(r0.error.message);
        var cf = (r0.data && r0.data.custom_fields) ? r0.data.custom_fields : {};
        cf.ms_color = hex || 'none';
        var r1 = await db.from('features').update({ custom_fields: cf }).eq('feature_id', fid);
        if (r1.error) throw new Error(r1.error.message);
        setStatus('Saved');
        if (_attrCustom[fid]) _attrCustom[fid].ms_color = hex || 'none';   // an open table stays in sync
        if (nodeC && isTilesetNode(nodeC)) scheduleTiledOverrideRefresh(nodeC.id);
      } catch (e) { setStatus('Save failed: ' + ((e && e.message) || e)); }
    }, 450);
  }
  function showFeaturePanel(drawId) {
    if (drawId !== selectedDrawId) flushFeatureMeta();   // switching features → persist the outgoing one's pending edit first
    selectedDrawId = drawId;
    attrStarFromMap(drawNodeFor(drawId), featureToDb[drawId]);   // map-select ⇄ table: star the row (user 7/23)
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
    syncFeatColorUi(meta, lnode);   // per-feature Color swatch: current override, else the layer color
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
    flushFeatureMeta();   // closing the panel → persist any pending edit before we lose the selection
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
    MSSel.remove(String(fid));   // a deleted feature leaves the selection, table open or not
    if (_attrSlug) { delete _attrById[String(fid)]; _attrRows = _attrRows.filter(function (r) { return String(r.feature_id) !== String(fid); }); if (document.getElementById('editor-attr-modal') && document.getElementById('editor-attr-modal').style.display !== 'none') { buildAttrHead(); renderAttrBody(true); } }   // keep an open table in sync (hold scroll position)
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
    var _saveId = selectedDrawId;   // capture the EDITED feature's id — NOT the live global (which may
    _featTimer = setTimeout(function () { _featTimer = null; saveFeatureMeta(_saveId); }, 600);   // point at another feature 600ms later → this edit would save to the wrong row / be lost)
  }
  // persist any pending debounced feature-meta edit NOW — called before the selection changes or the
  // panel closes, so a fast feature-switch (or a reload) inside the 600ms window can't drop the last edit
  function flushFeatureMeta() {
    if (!_featTimer) return;
    clearTimeout(_featTimer); _featTimer = null;
    if (selectedDrawId) saveFeatureMeta(selectedDrawId);
  }
  async function saveFeatureMeta(drawId) {
    var fid = featureToDb[drawId]; if (!fid) return;
    var meta = featureMeta[drawId] || {};
    setStatus('Saving…');
    try { var r = await db.from('features').update({ label: meta.label || null, description: meta.notes || null, start_date: meta.start || null, end_date: meta.end || null, content_id: meta.pageid || null, image_url: meta.image_url || null }).eq('feature_id', fid); if (r.error) throw new Error(r.error.message); setStatus('Saved'); }
    catch (e) { console.warn('editing: feature meta save failed', e); setStatus('Save failed'); try { showToast('Save failed: ' + (e && e.message ? e.message : 'error')); } catch (x) {} }
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
      // …and a LARGE one needs its ENGINE source filled, which _hydrateOne refuses to do by design
      // (it would dump 10k+ rows into MapboxDraw). "The engine's business" is only true if something
      // fetches the rows, and on this page nothing did: measured 8/21 by late-layer-click-gate, a
      // 1,600-feature layer that starts OFF goes `visibility: visible` with an EMPTY source and stays
      // empty — no features, no click targets, until a reload. Priority-hydrate it here.
      else if (dbId) {
        var nBig = nodeByLayerDbId(dbId);
        if (nBig && nBig._deferred && typeof ConfigLoader !== 'undefined' && ConfigLoader.hydrateDeferredLayer)
          ConfigLoader.hydrateDeferredLayer(db, nBig, [beforeMap, typeof afterMap !== 'undefined' ? afterMap : null])
            .then(function () { try { applyLabelLayers(nBig); } catch (e2) {} }, function () {});
      }
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
  // 'rgba(0,0,0,0)' is a SENTINEL we write ("something else owns this border"), never a chosen colour
  function isTransparentColor(v) { return v != null && String(v).replace(/\s+/g, '') === 'rgba(0,0,0,0)'; }
  // "Match fill colors": the border's colour IS the fill's — a hex when the layer is one colour,
  // the whole colour-by match expression when it isn't, so each polygon's border is its own colour.
  function fillColorValue(node) {
    var v = node && node.paint && node.paint[colorKeyFor(node.type)];
    if (Array.isArray(v)) return JSON.parse(JSON.stringify(v));
    if (typeof v === 'string' && !isTransparentColor(v)) return v;
    return (node && node.iconColor && /^#[0-9a-fA-F]{6}$/.test(node.iconColor)) ? node.iconColor : '#3bb2d0';
  }
  function looksHex(v) { return /^#?[0-9a-fA-F]{6}$/.test(String(v == null ? '' : v).trim()); }
  function normHex(v) { v = String(v).trim(); return (v[0] === '#' ? v : '#' + v).toLowerCase(); }
  function syncColorInputForColorBy(node) {   // colour-by on → swap the single swatch for the multicolor strip (or the 2-swatch binary strip)
    var rowC = document.getElementById('elp-color-row'), strip = document.getElementById('elp-multicolor-strip'), bin = document.getElementById('elp-binary-strip');
    if (!rowC || !strip) return;
    var cb = node && node.colorBy;
    var presence = !!(cb && cb.mode === 'presence');
    rowC.style.display = cb ? 'none' : 'block';
    strip.style.display = (cb && !presence) ? 'flex' : 'none';
    if (bin) bin.style.display = presence ? 'block' : 'none';
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
  // DEDICATED COLUMNS are style-by-able too (8/14, "not seeing label as an option haha"): the
  // importer maps name-like source columns (cntry_name…) INTO features.label, so the one column
  // a user most wants to colour by lives OUTSIDE custom_fields. These two resolvers make
  // label/description/dates/image_url first-class wherever a colour-by value is read.
  var CB_DEDICATED = ['label', 'description', 'start_date', 'end_date', 'image_url'];
  function cbValueOf(row, prop) {   // row = a features row (dedicated cols + custom_fields)
    if (!row) return null;
    var cf = row.custom_fields;
    if (cf && cf[prop] != null) return cf[prop];
    if (prop === 'label') return (row.label != null && String(row.label).trim() !== '') ? row.label : null;   // whitespace is not a label
    if (prop === 'description') return row.description || null;
    if (prop === 'start_date') return row.start_date ? String(row.start_date).slice(0, 10) : null;
    if (prop === 'end_date') return row.end_date ? String(row.end_date).slice(0, 10) : null;
    if (prop === 'image_url') return row.image_url || null;
    return null;
  }
  function metaCbValue(meta, prop) {   // meta = featureMeta shape {label, notes, start, end, image_url, custom}
    if (!meta) return null;
    if (meta.custom && meta.custom[prop] != null) return meta.custom[prop];
    if (prop === 'label') return meta.label || null;
    if (prop === 'description') return meta.notes || null;
    if (prop === 'start_date') return meta.start || null;
    if (prop === 'end_date') return meta.end || null;
    if (prop === 'image_url') return meta.image_url || null;
    return null;
  }
  async function populateColorBy(node) {
    var row = document.getElementById('elp-colorby-row'), sel = document.getElementById('elp-colorby'), info = document.getElementById('elp-colorby-info');
    if (!row || !sel) return;
    syncColorInputForColorBy(node);
    var isDrawn = node && node.source_type === 'geojson-supabase';
    // a split outline COLOURS LIKE ITS PARENT (8/14b, "can't seem to do the same thing with
    // CShapes-Europe"): a drawn split's node carries an adapter source and NO source_type, so it
    // classified as a tileset here and sampled its own EMPTY row set — empty dropdown. Take the
    // PARENT's branch; the drawn sampler below already routes rows through outlineOf.
    if (node && node.outlineOf) {
      var _oPar = findNodeById(layers, node.outlineOf);
      if (_oPar && _oPar.source_type === 'geojson-supabase') isDrawn = true;
      // (a TILESET parent — e.g. a baked layer, source_type vector-tiles-url — keeps the
      // tileset branch below; its DB sample routes through outlineOf there)
    }
    // color-by works on EVERY tileset geometry (8/13, owner on CShapes: "I don't see a style by
    // data column option here… I need to be able to see countries separately") — the match
    // expression is geometry-agnostic; the old line-only gate was the whole restriction
    var tsColorable = node && isTilesetNode(node) && ['line', 'fill', 'circle'].indexOf(node.type) > -1 && slugToLayerDbId[node.id];
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
        // Label pickers also offer the DB's custom_fields columns (60-row sample, like the dates
        // section) — skinny tiles only carry what a past bake wrote, so a source column like
        // CShapes' cntry_name was UNPICKABLE right when picking it is what triggers the re-bake
        // that bakes it in (8/8). The popup label reads the DB by id, so DB columns are always
        // valid there; groupBy stays tile-columns-only (group anchors key on tile properties).
        var lblCols = tcols.slice();
        try {
          // split outlines sample their PARENT's rows (8/14b, "can't seem to do the same thing
          // with CShapes-Europe" — a baked parent routes the outline down THIS branch, and the
          // outline's own layer has no rows by design)
          var node5 = node.outlineOf ? (findNodeById(layers, node.outlineOf) || node) : node;
          var lid5 = node5._dataLayerId || slugToLayerDbId[node5.id] || slugToLayerDbId[node.id];
          if (lid5) {
            var r5 = await db.from('features').select('custom_fields, label, description, start_date, end_date, image_url').eq('layer_id', lid5).limit(60);
            (r5.data || []).forEach(function (row5) {
              var cf5 = row5.custom_fields;
              if (cf5 && typeof cf5 === 'object') Object.keys(cf5).forEach(function (k5) { if (lblCols.indexOf(k5) < 0) lblCols.push(k5); });
              CB_DEDICATED.forEach(function (k5) { if (cbValueOf(row5, k5) != null && lblCols.indexOf(k5) < 0) lblCols.push(k5); });   // dedicated columns are options too (8/14)
            });
            lblCols = orderAttrKeys(lblCols, 40);
          }
        } catch (e5) {}
        fillLabelFieldSelect(node, lblCols);
        // Map labels on TILESETS: every geometry (8/8 — the old line-only gate was never intended;
        // owner: "labels disabled for everything but lines?? Definitely NOT intended"). The whole
        // chain below this gate has been geometry-agnostic since 8/7: labels.js puts a symbol layer
        // over the vector source (lines via group anchors, points/polygons per feature), addLayers
        // adds it in the viewer, changeDate date-filters `-label-`, and onMapLabelsChange re-bakes
        // when the picked column isn't in the tiles. Only this UI gate still hid the controls.
        fillMapLabelControls(node, lblCols.filter(function (k) { return k !== 'DayStart' && k !== 'DayEnd'; }));
        // "Treat as one" works on tilesets too: members come from the loaded tiles (which carry the baked columns)
        fillGroupBySelect(node, tcols.filter(function (k) { return k !== 'DayStart' && k !== 'DayEnd'; }));
        // color-by on tilesets: ALL columns, not just what a past bake happened to write into the
        // tiles (owner 8/13: "I should be able to choose the column … not a special entry") — same
        // tile∪DB union the label picker gets; picking an unbaked column auto-rebakes it in.
        if (tsColorable) {
          sel.innerHTML = '<option value="">Single color</option>';
          lblCols.filter(function (k) { return k !== 'DayStart' && k !== 'DayEnd'; }).forEach(function (k) { var oc2 = document.createElement('option'); oc2.value = k; oc2.textContent = k; sel.appendChild(oc2); });
          var cbt = node.colorBy;
          if (cbt && cbt.prop) { if (![].slice.call(sel.options).some(function (o) { return o.value === cbt.prop; })) { var oc3 = document.createElement('option'); oc3.value = cbt.prop; oc3.textContent = cbt.prop; sel.appendChild(oc3); } sel.value = cbt.prop; info.textContent = cbt.mode === 'hex' ? "Using the column's own hex colors." : (Object.keys(cbt.mapping || {}).length + ' categories, one color each.'); }
          else { sel.value = ''; info.textContent = ''; }
          addPresenceOption(sel, node);   // + "Labeled vs unlabeled" (reflects saved presence mode)
        }
      }
      return;
    }
    var lid = slugToLayerDbId[node.id];
    sel.innerHTML = '<option value="">Single color</option>';
    info.textContent = '';
    if (!lid) return;
    try {
      // Linked/instance mirrors have no rows of their own — sample the SOURCE layer's columns
      // (instanceOf), and always offer the mirror's OWN added columns (overlayCols, Portal 5b).
      // DRAWN outline splits too (8/14b, "can't seem to do the same thing with CShapes-Europe"):
      // the split borrows the FILL's features, so its dropdown must sample the fill's rows —
      // the save path (onColorBy) already routed through outlineOf; this fills the dropdown.
      var sampleNode = node.outlineOf ? (findNodeById(layers, node.outlineOf) || node) : node;
      var sampleLid = sampleNode.instanceOf || (sampleNode === node ? lid : (slugToLayerDbId[sampleNode.id] || lid));
      // dedicated columns ride along (8/14): the old sample read custom_fields ONLY — and
      // filtered out rows whose only values were dedicated ones, hiding e.g. label entirely
      var r = await db.from('features').select('custom_fields, label, description, start_date, end_date, image_url').eq('layer_id', sampleLid).limit(100);
      // The column list is discovered from a SAMPLE, so a column that only appears on later rows
      // is simply not offered — the person looks for it in the dropdown and it is not there.
      if (window.MSGuard) MSGuard.cliff('colorby-column-sample', ((r.data || []).length >= 100) ? 101 : 0, 100,
        'the colour and label pickers read the first 100 features to find columns, so a column that only appears further down the layer will not be listed');
      var keys = {};
      (r.data || []).forEach(function (f) {
        Object.keys(f.custom_fields || {}).forEach(function (k) { keys[k] = 1; });
        CB_DEDICATED.forEach(function (k) { if (cbValueOf(f, k) != null) keys[k] = 1; });
      });
      (node.overlayCols || []).forEach(function (k) { keys[k] = 1; });
      // dropdowns lead with the UNIVERSAL style columns (the default styling home), then everything else
      var allKeys = Object.keys(keys).sort();
      var msFirst = ['ms_color', 'ms_linecolor', 'ms_opacity', 'ms_thickness', 'ms_labelsize'].filter(function (k) { return allKeys.indexOf(k) > -1; });
      var sortedKeys = msFirst.concat(allKeys.filter(function (k) { return msFirst.indexOf(k) < 0; }));
      sortedKeys.forEach(function (k) { var o = document.createElement('option'); o.value = k; o.textContent = k; sel.appendChild(o); });
      var cb = node.colorBy;
      if (cb && cb.prop) { sel.value = cb.prop; info.textContent = cb.mode === 'hex' ? "Using the column's own hex colors." : (Object.keys(cb.mapping || {}).length + ' categories, one color each.'); }
      addPresenceOption(sel, node);   // + "Labeled vs unlabeled" (reflects saved presence mode)
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
      var r = await patchLayerConfig(lid, { groupBy: (node.groupBy) ? node.groupBy : null });
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
  // ── "Labeled vs unlabeled" (binary category, Rung 2a) ──────────────────────
  // A two-bucket rule keyed on whether a field has a value: fixes the auto-generated per-name
  // coloring (blank name → jarring red). The field is the layer's label field (or the column the
  // old auto-colorBy used). Needs NO tile regen when that field is already baked (RRname/label are).
  function presenceField(node) { return (node.labels && node.labels.field) || (node.colorBy && node.colorBy.prop) || 'label'; }
  function presenceExpr(field, presentColor, absentColor) {
    var f = ['to-string', ['get', field]];   // missing/null → "" ; the data uses " " for blank too
    return ['case', ['any', ['==', f, ''], ['==', f, ' ']], absentColor, presentColor];
  }
  function addPresenceOption(sel, node) {   // inject the "Labeled vs unlabeled" choice + reflect saved state
    if (!sel || [].slice.call(sel.options).some(function (o) { return o.value === '__present__'; })) { /* already there */ }
    else { var opt = document.createElement('option'); opt.value = '__present__'; opt.textContent = 'Labeled vs unlabeled (2 colors)'; sel.insertBefore(opt, sel.options[1] || null); }
    var cb = node && node.colorBy;
    if (cb && cb.mode === 'presence') {
      sel.value = '__present__';
      var bp = document.getElementById('elp-bin-present'), ba = document.getElementById('elp-bin-absent');
      if (bp) bp.value = looksHex(cb.present) ? normHex(cb.present) : '#3bb2d0';
      if (ba) ba.value = looksHex(cb.absent) ? normHex(cb.absent) : '#cccccc';
      var info = document.getElementById('elp-colorby-info');
      if (info) info.textContent = 'Labeled = has a value in ' + (cb.prop || 'label') + '.';
    }
  }
  function buildPresencePaint(node) {   // {paint, present, absent, field} from the two swatches
    var key = colorKeyFor(node.type);
    var present = (document.getElementById('elp-bin-present') || {}).value || '#3bb2d0';
    var absent = (document.getElementById('elp-bin-absent') || {}).value || '#cccccc';
    var field = (node.colorBy && node.colorBy.mode === 'presence' && node.colorBy.prop) || presenceField(node);
    var paint = JSON.parse(JSON.stringify(node.paint || {}));
    paint[key] = presenceExpr(field, present, absent);
    return { paint: paint, present: present, absent: absent, field: field, key: key };
  }
  function livePresenceColors() {   // realtime preview on both swipe sides, no DB write (feedback: style previews live)
    if (!activeLayerId) return;
    var node = findNodeById(layers, activeLayerId); if (!node) return;
    var b = buildPresencePaint(node);
    [[beforeMap, '-left'], [typeof afterMap !== 'undefined' ? afterMap : null, '-right']].forEach(function (ms) {
      var m = ms[0]; if (!m) return; try { if (m.getLayer(node.id + ms[1])) m.setPaintProperty(node.id + ms[1], b.key, b.paint[b.key]); } catch (e) {}
    });
  }
  async function savePresenceColors() {
    if (!activeLayerId) return;
    var node = findNodeById(layers, activeLayerId); if (!node) return;
    var lid = slugToLayerDbId[activeLayerId]; if (!lid) return;
    var b = buildPresencePaint(node);
    node.paint = b.paint;
    node.colorBy = { mode: 'presence', prop: b.field, present: b.present, absent: b.absent, mapping: { labeled: b.present, unlabeled: b.absent } };   // mapping keeps the sidebar multicolor icon happy
    setStatus('Saving…');
    try {
      var cur = await db.from('layers').select('raw_config').eq('id', lid).single();
      var rc = (cur.data && cur.data.raw_config) || {};
      rc.colorBy = node.colorBy;
      rc.styleChangedAt = new Date().toISOString(); node.styleChangedAt = rc.styleChangedAt;   // snapshot freshness includes style (8/19)
      var r = await db.from('layers').update({ paint: b.paint, raw_config: rc }).eq('id', lid);
      if (r.error) throw new Error(r.error.message);
      livePresenceColors();
      if (!isTilesetNode(node)) await loadFeatures();
      rerender(); syncColorInputForColorBy(node); renderLegend();
      var info = document.getElementById('elp-colorby-info'); if (info) info.textContent = 'Labeled = has a value in ' + b.field + '.';
      setStatus('Saved');
    } catch (e) { console.warn('presence colorBy failed', e); setStatus('Save failed'); }
  }
  // ── Legend (experiment, 7/20) — a small on-map box listing each legend-enabled layer's colors ──
  function legendItemsFor(node) {
    var cb = node.colorBy;
    if (cb && cb.mode === 'presence') return [{ label: 'Labeled', color: cb.present || '#3bb2d0' }, { label: 'Unlabeled', color: cb.absent || '#cccccc' }];
    if (cb && cb.mapping) {
      var ks = Object.keys(cb.mapping);
      var items = ks.slice(0, 12).map(function (k) { return { label: (k === ' ' || k === '') ? '(blank)' : k, color: cb.mapping[k] }; });   // cliff-ok: the legend appends "… +N more" right below, which announces it in the UI
      if (ks.length > 12) items.push({ label: '… +' + (ks.length - 12) + ' more', color: 'transparent' });
      return items;
    }
    var key = colorKeyFor(node.type);
    var col = (node.paint && typeof node.paint[key] === 'string' && node.paint[key]) || node.iconColor || '#3bb2d0';
    return [{ label: node.label || 'Layer', color: col }];
  }
  function renderLegend() {
    var box = document.getElementById('ms-legend');
    if (!box) {
      box = document.createElement('div'); box.id = 'ms-legend';
      box.style.cssText = 'position:fixed;z-index:3980;bottom:80px;max-width:240px;max-height:42vh;overflow:auto;background:rgba(255,255,255,0.95);border:1px solid #c9bfe8;border-radius:6px;box-shadow:0 2px 10px rgba(0,0,0,0.15);padding:8px 11px;font-family:"Source Sans Pro",Arial,sans-serif;font-size:12px;color:#2b3a4a;';
      document.body.appendChild(box);
    }
    var on = [];
    (function walk(arr) { (arr || []).forEach(function (n) { if (n.legend && n.checked !== false) on.push(n); if (n.children) walk(n.children); }); })(layers);
    if (!on.length) { box.style.display = 'none'; return; }
    var anchor = document.getElementById('layers-panel-content');   // dock to the sidebar's right edge, like the features list
    box.style.left = Math.round((anchor ? anchor.getBoundingClientRect().right : 470) + 6) + 'px';
    box.style.display = 'block';
    box.innerHTML = '<div style="font-weight:700;margin-bottom:5px;">Legend</div>' + on.map(function (n) {
      return '<div style="margin-bottom:7px;"><div style="font-weight:600;margin-bottom:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + attrEsc(n.label || 'Layer') + '</div>' +
        legendItemsFor(n).map(function (it) { return '<div style="display:flex;align-items:center;gap:6px;margin:1px 0;"><span style="display:inline-block;width:13px;height:13px;flex:0 0 auto;border:1px solid #999999;border-radius:2px;background:' + attrEsc(it.color) + ';"></span><span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + attrEsc(it.label) + '</span></div>'; }).join('') +
      '</div>';
    }).join('');
  }
  window.__msRenderLegend = renderLegend;   // let visibility toggles refresh the legend
  async function onToggleLegend(on) {
    if (!activeLayerId) return;
    var node = findNodeById(layers, activeLayerId); if (!node) return;
    node.legend = !!on;
    renderLegend();
    var lid = slugToLayerDbId[activeLayerId]; if (!lid) return;   // still shows this session even if not persistable
    try {
      await saveSoft(patchLayerConfig(lid, { legend: node.legend ? true : null }), 'saving the legend setting');
    } catch (e) {}
  }
  // ── Style categories under the layer (7/20) — nested sub-rows in the sidebar, each with a
  // checkbox that shows/hides that category's features on the map (via a slider-safe opacity
  // expression). Opt-in per layer (node.styleRows); only meaningful for color-by layers. ──
  /* twin-ok: intentionally mirrored in viewerTable.js opKeyFor, like its two neighbours. CHANGE BOTH.
     These two had already DRIFTED when find-twins learned to measure similarity (8/21): the editor
     sent anything that was not fill/line to `circle-opacity`, the viewer sent anything that was not
     line/circle to `fill-opacity`. Nine layers carry a type outside {fill,line,circle} — 6 null,
     plus "Polygon", "Point" and "LineString" — so the same layer's category dimming wrote a
     DIFFERENT paint property in the editor than in the viewer, and writing the wrong one does
     nothing at all, silently. Both were wrong for "LineString".
     The map knows what it actually painted, so ask it first; `layers.type` is a stored copy that
     may be null or a geometry name. */
  function opKeyFor(node) {
    try {
      var m0 = (typeof beforeMap !== 'undefined') ? beforeMap : null;
      var L0 = (m0 && node && m0.getLayer) ? m0.getLayer(node.id + '-left') : null;
      if (L0 && (L0.type === 'fill' || L0.type === 'line' || L0.type === 'circle')) return L0.type + '-opacity';
    } catch (e) {}
    // Fallback delegates to the engine's sole author rather than repeating the mapping a fifth
    // time — that repetition is what let the editor and viewer drift apart in the first place.
    if (typeof msPaintKeyFor === 'function') return msPaintKeyFor(node && node.type, 'opacity');
    var t = String((node && node.type) || '').toLowerCase();
    if (t === 'line' || t === 'linestring' || t === 'multilinestring') return 'line-opacity';
    if (t === 'circle' || t === 'point' || t === 'multipoint') return 'circle-opacity';
    return 'fill-opacity';   // fill, Polygon, MultiPolygon, and unknown: most layers are fills
  }
  /* twin-ok: styleCatsFor is intentionally mirrored in viewerTable.js so the viewer can draw the
     same legend rows without loading the editor. CHANGE BOTH. */
  var STYLE_CATS_MAX = 20;        // mirrored in viewerTable.js styleCatsFor — change both
  function styleCatsFor(node) {   // [{key,label,color}] — the rows to show; [] for single-color layers
    var cb = node.colorBy;
    if (cb && cb.mode === 'presence') return [{ key: '__present__', label: 'Labeled', color: cb.present || '#3bb2d0' }, { key: '__absent__', label: 'Unlabeled', color: cb.absent || '#cccccc' }];
    if (cb && cb.mapping) {
      var ks = Object.keys(cb.mapping);
      // Unlike the LEGEND above, which appends "… +N more", these rows are interactive style
      // controls — so a category past the cap is painted on the map with no row to change it.
      if (window.MSGuard) MSGuard.cliff('style-cats-cap', ks.length, STYLE_CATS_MAX,
        'categories past the first ' + STYLE_CATS_MAX + ' are drawn on the map but have no style row you can click');
      return ks.slice(0, STYLE_CATS_MAX).map(function (k) { return { key: k, label: (k === ' ' || k === '') ? '(blank)' : k, color: cb.mapping[k] }; });
    }
    return [];
  }
  /* twin-ok: intentionally mirrored in viewerTable.js styleOpacityExpr. CHANGE BOTH. */
  function styleOpacityExpr(node) {
    var key = opKeyFor(node), cur = node.paint && node.paint[key];
    if (typeof cur === 'number') node.styleBaseOp = cur;   // remember the flat base before we replace it with an expression
    var base = (typeof node.styleBaseOp === 'number') ? node.styleBaseOp : 1;
    var hidden = node.styleHidden || [];
    if (!hidden.length) return base;
    var cb = node.colorBy;
    if (cb && cb.mode === 'presence') {
      var f = ['to-string', ['get', cb.prop || 'label']], blank = ['any', ['==', f, ''], ['==', f, ' ']];
      return ['case', blank, (hidden.indexOf('__absent__') > -1 ? 0 : base), (hidden.indexOf('__present__') > -1 ? 0 : base)];
    }
    if (cb && cb.mapping) { var expr = ['match', ['to-string', ['get', cb.prop]]]; hidden.forEach(function (v) { expr.push(v, 0); }); expr.push(base); return expr; }
    return base;
  }
  function applyStyleVisibility(node) {
    var key = opKeyFor(node), expr = styleOpacityExpr(node);
    node.paint = node.paint || {}; node.paint[key] = expr;
    [[beforeMap, '-left'], [typeof afterMap !== 'undefined' ? afterMap : null, '-right']].forEach(function (ms) {
      var m = ms[0]; if (!m) return; try { if (m.getLayer(node.id + ms[1])) m.setPaintProperty(node.id + ms[1], key, expr); } catch (e) {}
    });
  }
  async function persistStyleRows(node) {
    var lid = slugToLayerDbId[node.id]; if (!lid) return;
    try {
      var cur = await db.from('layers').select('raw_config').eq('id', lid).single();
      var rc = (cur.data && cur.data.raw_config) || {};
      if (node.styleRows) rc.styleRows = true; else delete rc.styleRows;
      if (node.styleHidden && node.styleHidden.length) rc.styleHidden = node.styleHidden; else delete rc.styleHidden;
      if (typeof node.styleBaseOp === 'number') rc.styleBaseOp = node.styleBaseOp; else delete rc.styleBaseOp;
      await saveSoft(db.from('layers').update({ paint: node.paint, raw_config: rc }).eq('id', lid), 'saving the style rows');
    } catch (e) {}
  }
  function toggleStyleCat(id, key, visible) {
    var node = findNodeById(layers, id); if (!node) return;
    node.styleHidden = node.styleHidden || [];
    var i = node.styleHidden.indexOf(key);
    if (visible) { if (i > -1) node.styleHidden.splice(i, 1); } else { if (i < 0) node.styleHidden.push(key); }
    applyStyleVisibility(node); persistStyleRows(node); renderLegend(); syncLayerMaster(node);
  }
  // ── Group-like layer checkbox (7/20): the layer's own checkbox reflects its style categories,
  //    exactly like a group reflects its children. NOTE refreshLayers() keys the WHOLE layer's
  //    map-visibility off this checkbox's .checked and re-runs every render — so partial state
  //    can't be a plain unchecked box (that would blank the categories still switched on). Partial
  //    → indeterminate (a dash) while staying .checked; all-off → unchecked; all-on → clear dash.
  function syncLayerMaster(node) {
    if (!node) return;
    var cats = node.styleRows ? styleCatsFor(node) : []; if (!cats.length) return;
    var cb = document.getElementById(node.toggleElement || node.id); if (!cb) return;
    var hidden = node.styleHidden || [];
    var off = cats.filter(function (c) { return hidden.indexOf(c.key) > -1; }).length;
    if (off === 0) { cb.indeterminate = false; cb.checked = true; }             // all on → box checked (turning the layer
                                                                                //   off routes through onLayerMasterToggle, which sets styleHidden=all, so empty ⟺ on)
    else if (off >= cats.length) { cb.indeterminate = false; cb.checked = false; }   // all off → whole layer off
    else { cb.indeterminate = true; cb.checked = true; }                        // partial → dash, keep layer visible
  }
  function onLayerMasterToggle(cb) {   // a real click on a style-category layer's own checkbox
    var node = findNodeById(layers, cb.id); if (!node || !node.styleRows) return;
    var cats = styleCatsFor(node); if (!cats.length) return;
    node.styleHidden = cb.checked ? [] : cats.map(function (c) { return c.key; });   // on → all categories on; off → all off
    cb.indeterminate = false;
    applyStyleVisibility(node); persistStyleRows(node);
    if (window.__msInjectStyleRows) window.__msInjectStyleRows();   // repaint the sub-row checkboxes to match
    try { renderLegend(); } catch (e) {}
  }
  if (typeof window !== 'undefined' && !window.__msMasterWired) {
    window.__msMasterWired = true;   // one delegated listener — layer rows re-render constantly, so per-row binding would leak
    document.addEventListener('change', function (e) {
      var t = e.target; if (!t || t.type !== 'checkbox' || !t.closest) return;
      if (!t.closest('.layer-list-row')) return;   // sub-rows live OUTSIDE .layer-list-row → never match
      var node = findNodeById(layers, t.id); if (!node || !node.styleRows) return;
      onLayerMasterToggle(t);
    }, true);
  }
  function injectStyleRows() {   // runs after every sidebar render (end of enhanceRows)
    var panel = document.getElementById('layers-panel-content'); if (!panel) return;
    if (!document.getElementById('ms-stylerow-css')) {
      var st = document.createElement('style'); st.id = 'ms-stylerow-css';
      st.textContent = '.ms-stylerow{display:flex;align-items:center;gap:7px;padding:3px 8px 3px 46px;font-size:12.5px;color:#4a4a4a;}' +
        '.ms-stylerow input{margin:0;flex:0 0 auto;cursor:pointer;}' +
        '.ms-stylerow-sw{display:inline-block;width:12px;height:12px;flex:0 0 auto;border:1px solid #999999;border-radius:2px;}' +
        '.ms-stylerow-lbl{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}';
      document.head.appendChild(st);
    }
    Array.prototype.forEach.call(panel.querySelectorAll('.ms-stylerow'), function (r) { r.remove(); });
    Array.prototype.forEach.call(panel.querySelectorAll('.layer-list-row'), function (row) {
      var id = row.getAttribute('data-node-id') || rowNodeId(row); if (!id) return;
      var node = findNodeById(layers, id); if (!node || !node.styleRows) return;
      var cats = styleCatsFor(node); if (!cats.length) return;
      var hidden = node.styleHidden || [];
      cats.slice().reverse().forEach(function (c) {   // reversed inserts keep natural top-to-bottom order right under the row
        var d = document.createElement('div'); d.className = 'ms-stylerow';
        var on = hidden.indexOf(c.key) < 0;
        d.innerHTML = '<input type="checkbox" ' + (on ? 'checked' : '') + ' /><span class="ms-stylerow-sw" style="background:' + attrEsc(c.color) + ';"></span><span class="ms-stylerow-lbl" title="' + attrEsc(c.label) + '">' + attrEsc(c.label) + '</span>';
        d.querySelector('input').addEventListener('change', function () { toggleStyleCat(id, c.key, this.checked); });
        row.parentNode.insertBefore(d, row.nextSibling);
      });
      syncLayerMaster(node);   // reflect partial/all-off on the layer's own checkbox (the dash)
    });
  }
  window.__msInjectStyleRows = injectStyleRows;
  async function onToggleStyleRows(on) {
    if (!activeLayerId) return;
    var node = findNodeById(layers, activeLayerId); if (!node) return;
    node.styleRows = !!on;
    injectStyleRows(); persistStyleRows(node);
  }
  async function onColorBy(prop) {
    if (prop === '__present__') {   // Rung 2a: binary labeled/unlabeled — seed defaults then persist
      var node0 = activeLayerId && findNodeById(layers, activeLayerId); if (!node0) return;
      var bp = document.getElementById('elp-bin-present'), ba = document.getElementById('elp-bin-absent');
      var seededPresent = (node0.colorBy && node0.colorBy.mode === 'presence' && looksHex(node0.colorBy.present)) ? normHex(node0.colorBy.present)
        : (node0.iconColor && looksHex(node0.iconColor)) ? normHex(node0.iconColor) : '#3bb2d0';
      var seededAbsent = (node0.colorBy && node0.colorBy.mode === 'presence' && looksHex(node0.colorBy.absent)) ? normHex(node0.colorBy.absent) : '#cccccc';
      if (bp) bp.value = seededPresent; if (ba) ba.value = seededAbsent;
      syncColorInputForColorBy({ colorBy: { mode: 'presence' } });   // reveal the two swatches immediately
      await savePresenceColors();
      return;
    }
    if (!activeLayerId) return;
    var node = findNodeById(layers, activeLayerId); if (!node) return;
    var lid = slugToLayerDbId[activeLayerId]; if (!lid) return;
    // OUTLINE SPLITS colour by their PARENT's rows (owner 8/14, "that column has no values"):
    // the split owns no features by design — it draws the fill's edges — so value sampling and
    // the by-id categorical expression both read the FILL's data layer. The colour-by meta and
    // paint still persist on the OUTLINE's own row (it is the layer being styled).
    var dataNode = node.outlineOf ? (findNodeById(layers, node.outlineOf) || node) : node;
    var dataLid = dataNode === node ? lid : (slugToLayerDbId[dataNode.id] || lid);
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
        /* SAY IT AT THE MOMENT OF THE CHOICE. A vector-tile layer paints from its TILES, and the
           tiles only carry the columns that were baked. Colour by a column that was not baked and
           every feature silently takes the fallback colour — the picker works, the legend fills in,
           and the map is one flat colour. Five layers across three maps were sitting in exactly
           that state on 8/21, found by an audit nobody runs rather than at the moment it happened.
           The bake picks up colorBy.prop, so a re-bake fixes it; what was missing is anyone being
           told. Warn, do not block: the choice is legitimate and the fix is one button away. */
        if (isTilesetNode(node)) {
          /* tilesLabelField lives DIRECTLY on the node: leafFromRow spreads every raw_config key
             onto the leaf, so `node.raw_config` does not exist at runtime. Reading it there would
             have left bakedCols as {label} always, and this warning would have fired on every
             tileset colour-by — a false-positive generator shipped in the name of catching one.
             The audit's own version of this rule reads DB rows, where raw_config IS the shape;
             same rule, two worlds, two accessors. */
          var tlf = node.tilesLabelField != null ? node.tilesLabelField
                  : (dataNode.tilesLabelField != null ? dataNode.tilesLabelField
                  : ((dataNode.raw_config || node.raw_config || {}).tilesLabelField));
          var bakedCols = { label: 1 };
          if (tlf) bakedCols[tlf] = 1;
          if (node.labels && node.labels.field) bakedCols[node.labels.field] = 1;
          if (!bakedCols[prop]) {
            var msgTb = '"' + prop + '" is not baked into this layer’s tiles (they carry ' +
                        Object.keys(bakedCols).join(', ') + '), so every feature will take the fallback colour until you re-bake.';
            if (info) info.textContent = msgTb;
            showToast(msgTb, 8000);
            if (window.MSGuard) MSGuard.warnOnce('colorby-not-baked:' + node.id, 'colour-by column is not in the tiles', prop);
          }
        }
        var seen = {}, order = [];
        if (isTilesetNode(node)) {
          // tileset layers: distinct values from ONE server call (paging 78k rows would be heavy)
          var cr9 = await db.rpc('ms_layer_key_counts', { p_layer: dataLid, p_key: prop });
          if (cr9.error) throw new Error(cr9.error.message + (/function|does not exist/.test(cr9.error.message) ? ' — run sql/setup/query-ops-setup.sql first' : ''));
          ((cr9.data) || []).slice().sort(function (a, b) { return b.n - a.n; }).forEach(function (c9) { var s9 = String(c9.k); if (!(s9 in seen)) { seen[s9] = 1; order.push(s9); } });
        } else {
          var dataLid2 = dataNode.instanceOf || dataLid;   // mirrors sample their SOURCE's rows (Portal 5b)
          var fr = await window.MSFetchRows(db, 'custom_fields, label, description, start_date, end_date, image_url', function (q) { return q.eq('layer_id', dataLid2); });
          (fr.rows || []).forEach(function (f) { var v = cbValueOf(f, prop); if (v == null) return; var s = String(v); if (!(s in seen)) { seen[s] = 1; order.push(s); } });
          // the mirror's own added columns (Portal 5b): values live in layer_overlay, not features
          if (window.MSOverlay && (node.overlayCols || []).indexOf(prop) > -1) {
            var ovv = await MSOverlay.load(lid);
            Object.keys(ovv).forEach(function (fid) { var v9 = ovv[fid] ? ovv[fid][prop] : null; if (v9 == null) return; var s9b = String(v9); if (!(s9b in seen)) { seen[s9b] = 1; order.push(s9b); } });
          }
        }
        if (!order.length) { setStatus('No values in that column'); showToast('That column has no values'); return; }
        // literal-colour columns: hex (with/without #), rgb()/rgba(), or the explicit "none" (→ un-filled: the
        // source left these uncolored — ESRI renders them invisible; we keep the outline so the feature stays findable)
        var isColorVal = function (v) { var s2 = String(v == null ? '' : v).trim(); return looksHex(s2) || /^rgba?\([^)]+\)$/i.test(s2) || s2.toLowerCase() === 'none'; };
        var allHex = order.every(isColorVal);
        // NO CATEGORY CAP (owner 8/14: "Can we just not have a cap?? … there could be thousands
        // of things that match" — same philosophy as imports: no caps). The palette cycles;
        // telling adjacent things APART is the point, not unique hues. The only remaining bound
        // is TILECAT_BYID_CAP on unbaked tilesets (a paint-size guard with a Re-bake path out).
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
        // TILED layers colour INSTANTLY, bake or no bake (owner 8/13: "it should be immediate
        // for vectors — I should just click rebake if I change the styling"): when the column
        // isn't in the tiles the categories ride a by-id match built from the DB instead.
        var unbakedNote = '';
        if (isTilesetNode(node)) {
          var built = await buildTiledColorByExpr(node, dataLid, fallback);
          if (built === 'toobig') unbakedNote = ' “' + prop + '” isn’t in the tiles and the layer is too large to color by id — click Re-bake to bake the column in.';
          else if (built) expr = built;
        }
        // per-FEATURE overrides survive categorical colors (owner 8/13: "I should be able to
        // select features and change their colors after choosing colors"): overridden features
        // wrap the category match in a by-id match, so the persisted paint renders the override
        // EVERYWHERE (editor, viewer, downloads) with no runtime state.
        if (isTilesetNode(node) && !node.outlineOf) {
          // (8/14) overrides stay off outline splits: ms_color is the FILL's per-feature colour —
          // leaking it into the border's line-color would tint borders nobody recoloured
          try { expr = wrapTiledColorOverrides(await fetchTiledColorOverrides(lid), expr); } catch (eOv) {}
        }
        paint[key] = expr;
        if (info) info.textContent = (allHex ? ("Using the column's own hex colors (" + order.length + " values)." + (mapping['none'] ? " 'none' renders un-filled (outline only)." : '')) : (order.length + ' categories, one color each.')) + unbakedNote;
      }
      // a border set to MATCH the fill takes the new colours with it (8/14) — same expression,
      // stored on the same row, so the viewer renders matched borders with no runtime state
      if (node.outlineMatchFill && node.type === 'fill' && paint[key] != null) paint['fill-outline-color'] = JSON.parse(JSON.stringify(paint[key]));
      node.paint = paint;
      // persist: paint renders everywhere (incl. the public viewer); colorBy meta drives this UI + draw colors
      var cur = await db.from('layers').select('raw_config').eq('id', lid).single();
      var rc = (cur.data && cur.data.raw_config) || {};
      if (node.colorBy) rc.colorBy = node.colorBy; else delete rc.colorBy;
      // SNAPSHOT FRESHNESS INCLUDES STYLE (8/19, "the bake didn't do colors again"): the raster
      // freezes colours at bake time, so a restyle must move a stamp the panel can compare with
      // rasterYears.at — otherwise the stale-raster warning only fires on DATA changes and a
      // recolored layer scrubs in its old colours with no hint why.
      rc.styleChangedAt = new Date().toISOString(); node.styleChangedAt = rc.styleChangedAt;
      var r2 = await db.from('layers').update({ paint: paint, raw_config: rc }).eq('id', lid);
      if (r2.error) throw new Error(r2.error.message);
      // live: engine copies on both swipe sides + the MapboxDraw copies (loadFeatures re-colors per feature)
      [[beforeMap, '-left'], [typeof afterMap !== 'undefined' ? afterMap : null, '-right']].forEach(function (ms) {
        var m = ms[0]; if (!m) return;
        try { if (m.getLayer(node.id + ms[1])) m.setPaintProperty(node.id + ms[1], key, paint[key]); } catch (e) {}
        if (node.outlineMatchFill && node.type === 'fill') {
          try { if (m.getLayer(node.id + '-stroke' + ms[1])) m.setPaintProperty(node.id + '-stroke' + ms[1], 'line-color', paint['fill-outline-color']); } catch (e) {}
        }
      });
      await syncMatchedOutline(node);   // a split-off border that MATCHES follows the new colours
      if (!isTilesetNode(node)) await loadFeatures();   // draw copies re-color; tilesets recolor via paint alone
      rerender();   // sidebar icon flips to/from the multicolor gradient (generateLayers reads node.colorBy)
      syncColorInputForColorBy(node);   // panel swatch ↔ multicolor strip
      renderLegend();   // legend swatches follow the new colors
      setStatus('Saved');
      // NOTHING auto-bakes here (owner 8/13: "I'll rebake it myself, when I want") — unbaked
      // columns colour instantly via the by-id match above; a MANUAL Re-bake later compacts it.
    } catch (e) { console.warn('colorBy failed', e); setStatus('Save failed'); }
  }
  // A split-off outline layer set to "Match fill colors" re-takes its parent's colour value
  // whenever the parent's colours change (8/14) — paint + colorBy meta persisted on the OUTLINE's
  // own row, so the viewer needs no runtime state and a refresh keeps the match.
  async function syncMatchedOutline(P) {
    if (!P || P.type !== 'fill') return;
    var O = null;
    (function walk(a) { (a || []).forEach(function (n) { if (n.outlineOf === P.id) O = n; if (n.children) walk(n.children); }); })(layers);
    if (!O || !O.outlineMatchFill) return;
    var val = fillColorValue(P);
    O.paint = Object.assign({}, O.paint || {}, { 'line-color': val });
    if (P.colorBy) O.colorBy = JSON.parse(JSON.stringify(P.colorBy)); else delete O.colorBy;
    var oLid = slugToLayerDbId[O.id];
    if (oLid) {
      try {
        var cur = await db.from('layers').select('raw_config').eq('id', oLid).single();
        var orc = (cur.data && cur.data.raw_config) || {};
        if (O.colorBy) orc.colorBy = O.colorBy; else delete orc.colorBy;
        orc.outlineMatchFill = true;
        // the outline follows the fill's colour; a silent refusal here leaves the border on the OLD
        // colour after reload while the fill wears the new one
        await saveSoft(db.from('layers').update({ paint: O.paint, raw_config: orc }).eq('id', oLid), 'saving the matching border colour');
      } catch (e) { console.warn('editing: matched outline sync failed', e); }
    }
    [['left', beforeMap], ['right', (typeof afterMap !== 'undefined' ? afterMap : null)]].forEach(function (pair) {
      var m = pair[1]; if (!m) return;
      try { if (m.getLayer(O.id + '-' + pair[0])) m.setPaintProperty(O.id + '-' + pair[0], 'line-color', val); } catch (e) {}
    });
  }
  // ── colour-by on TILED layers WITHOUT baking (owner 8/13: "Is there a way to not have it
  //    have to bake just to color it?"). Tiles always carry the feature id, so when the column
  //    isn't baked in, the categories ride a by-ID match built from the DB — instant, persisted,
  //    viewer-safe. A get-based match is used only when the tiles verifiably carry the column
  //    (compact — the win a MANUAL Re-bake buys on very large layers; nothing ever auto-bakes).
  var TILECAT_BYID_CAP = 30000;
  function tiledColorByGetExpr(cb, fallback) {
    var eg = ['match', ['to-string', ['get', cb.prop]]];
    Object.keys(cb.mapping).forEach(function (v) { eg.push(v, cb.mapping[v]); });
    eg.push(fallback);
    return eg;
  }
  async function buildTiledColorByExpr(node, lid, fallback) {
    var cb = node.colorBy; if (!cb || !cb.prop || !cb.mapping) return null;
    var inTiles = false;
    try {
      var fs9 = beforeMap.querySourceFeatures(node.id + '-left', node['source-layer'] ? { sourceLayer: node['source-layer'] } : undefined) || [];
      for (var i9 = 0; i9 < fs9.length && i9 < 200; i9++) if (fs9[i9].properties && (cb.prop in fs9[i9].properties)) { inTiles = true; break; }
    } catch (e9) {}
    if (inTiles) return tiledColorByGetExpr(cb, fallback);
    // dedicated columns select as themselves; everything else lives in custom_fields (8/14)
    var vSel = CB_DEDICATED.indexOf(cb.prop) > -1 ? ('v:' + cb.prop) : ('v:custom_fields->>' + cb.prop);
    var pairs = [], lastFid = null, size = 1000;
    for (;;) {   // light select (no geom) — keyset pages so deep pages stay cheap (8/13)
      var qb = db.from('features').select('feature_id, ' + vSel).eq('layer_id', lid);
      if (lastFid !== null) qb = qb.gt('feature_id', lastFid);
      var q = await qb.order('feature_id').limit(size);
      if (q.error) break;
      (q.data || []).forEach(function (x) {
        var vv = x.v;
        if (vv != null && (cb.prop === 'start_date' || cb.prop === 'end_date')) vv = String(vv).slice(0, 10);   // mapping keys are date-only
        var c = vv != null ? cb.mapping[String(vv)] : null;
        if (c) { pairs.push(Number(x.feature_id)); pairs.push(c); }
      });
      if (!q.data || q.data.length < size) break;
      lastFid = q.data[q.data.length - 1].feature_id;
      if (pairs.length / 2 > TILECAT_BYID_CAP) return 'toobig';
    }
    if (!pairs.length) return null;
    return ['match', ['id']].concat(pairs, [fallback]);
  }
  // ── per-feature colour overrides on TILESET layers (8/13) ───────────────────
  // ms_color set on a feature (attr table / style pipeline) must WIN over the layer's single
  // or categorical colour. Tiles carry the feature id (= msid), so overrides fold into the
  // persisted paint as a by-id match — durable, viewer-safe, no runtime feature-state.
  async function fetchTiledColorOverrides(lid) {
    var out = [];
    var r = await db.from('features').select('feature_id, c:custom_fields->>ms_color').eq('layer_id', lid)
      .neq('custom_fields->>ms_color', 'none').limit(2000);
    ((r && !r.error && r.data) || []).forEach(function (x) {
      var c = String(x.c || '').trim();
      if (/^#[0-9a-fA-F]{6}$/.test(c) || /^rgba?\([^)]+\)$/i.test(c)) out.push([Number(x.feature_id), c]);
    });
    // Past the cap the extra recoloured features render in the base colour while the table still
    // shows the colour that was chosen — the map and the table disagree, silently.
    if (window.MSGuard) MSGuard.cliff('tiled-color-overrides', ((r && r.data) || []).length, 1999,
      'more features are individually recoloured than a tiled layer can carry, so the extras are drawing in the layer colour');
    return out;
  }
  function wrapTiledColorOverrides(ovr, base) {
    if (!ovr || !ovr.length) return base;
    var e = ['match', ['id']];
    ovr.forEach(function (o) { e.push(o[0], o[1]); });
    e.push(base);
    return e;
  }
  // rebuild the tiled layer's colour paint from scratch: overrides → colorBy match → single colour
  var _tiledStyleT = null;
  function scheduleTiledOverrideRefresh(slug) {
    if (_tiledStyleT) clearTimeout(_tiledStyleT);
    _tiledStyleT = setTimeout(function () { _tiledStyleT = null; refreshTiledOverridePaint(slug); }, 600);
  }
  async function refreshTiledOverridePaint(slug) {
    var node = findNodeById(layers, slug); if (!node || !isTilesetNode(node)) return;
    var lid = slugToLayerDbId[slug]; if (!lid) return;
    var key = colorKeyFor(node.type);
    var fallback = (node.iconColor && /^#[0-9a-fA-F]{6}$/.test(node.iconColor)) ? node.iconColor : '#3bb2d0';
    try {
      var base = fallback;
      if (node.colorBy && node.colorBy.prop && node.colorBy.mapping) {
        // same instant rule as onColorBy: unbaked columns ride a by-id match, never a bake
        var bb = null;
        try { bb = await buildTiledColorByExpr(node, lid, fallback); } catch (eBB) {}
        base = (bb && bb !== 'toobig') ? bb : tiledColorByGetExpr(node.colorBy, fallback);
      } else if (node.paint && typeof node.paint[key] === 'string') base = node.paint[key];
      var expr = wrapTiledColorOverrides(await fetchTiledColorOverrides(lid), base);
      var paint = JSON.parse(JSON.stringify(node.paint || {}));
      paint[key] = expr;
      node.paint = paint;
      var r2 = await db.from('layers').update({ paint: paint }).eq('id', lid);
      if (r2.error) throw new Error(r2.error.message);
      [[beforeMap, '-left'], [typeof afterMap !== 'undefined' ? afterMap : null, '-right']].forEach(function (ms) {
        var m = ms[0]; if (!m) return;
        try { if (m.getLayer(node.id + ms[1])) m.setPaintProperty(node.id + ms[1], key, expr); } catch (e) {}
      });
    } catch (e) { console.warn('tiled override paint failed', e); }
  }
  // ── Map labels: raw_config.labels = {field}. The engine adds the symbol layers on load (addLayers.js
  //    via labels.js); here we persist + rebuild them live on BOTH maps. Anchors come from the freshest
  //    in-memory geometry (draw copies), falling back to the engine source for large layers.
  function labelFeaturesFor(node) {
    var lid = slugToLayerDbId[node.id];
    // the freshest in-memory edits for THIS layer (drawn/edited features), keyed by feature_id;
    // brand-new unsaved features (no id yet) are collected separately
    var editByFid = {}, fresh = [];
    Object.keys(featureLayer).forEach(function (did) {
      if (featureLayer[did] !== lid) return;
      var g = _geomSnap[did]; if (!g) return;
      var m = featureMeta[did] || {};
      var props = { label: m.label || null };
      if (m.custom) Object.keys(m.custom).forEach(function (k) { if (!(k in props)) props[k] = m.custom[k]; });
      var fid = featureToDb[did];
      if (fid != null) { props.feature_id = fid; editByFid[String(fid)] = { type: 'Feature', geometry: g, properties: props }; }
      else fresh.push({ type: 'Feature', geometry: g, properties: props });
    });
    // the FULL feature set — geojson data, else the engine's LIVE source (large layers hydrate lazily,
    // so node.source.data can be empty). We label the WHOLE set and OVERLAY edits on top; the old code
    // returned only the touched subset, so editing one feature blanked every other label (bug 7/28).
    var base = [];
    try { base = (node.source && node.source.data && node.source.data.features) || []; } catch (e1) {}
    if (!base.length) { try { var es = beforeMap.getSource(node.id + '-left'); var ed = es && es.serialize && es.serialize().data; base = (ed && ed.features) || []; } catch (e2) {} }
    if (!base.length) return Object.keys(editByFid).map(function (k) { return editByFid[k]; }).concat(fresh);   // pure drawn layer not yet in a source → the in-memory features ARE the full set
    // source features carry the feature_id as the TOP-LEVEL id (editing.js:1661), some paths as
    // properties.feature_id — try both. No id anywhere → can't overlay safely; show the full set
    // unchanged (all labels stay; the edit lands on the next full rebuild) rather than risk doubles.
    function _bfid(bf) { return bf.id != null ? String(bf.id) : (bf.properties && bf.properties.feature_id != null ? String(bf.properties.feature_id) : null); }
    if (_bfid(base[0]) == null) return base.concat(fresh);
    var merged = base.map(function (bf) {
      var key = _bfid(bf);
      if (key != null && editByFid[key]) { var e = editByFid[key]; delete editByFid[key]; return e; }   // replace with the fresh edit → live preview
      return bf;
    });
    Object.keys(editByFid).forEach(function (k) { merged.push(editByFid[k]); });   // edits not present in base (rare) still show
    return merged.concat(fresh);
  }
  // companions-ok: builds and tears down the label layer only, by construction.
  function applyLabelLayers(node) {
    if (typeof msLabelLayerFor !== 'function') return;
    [[beforeMap, 'left'], [typeof afterMap !== 'undefined' ? afterMap : null, 'right']].forEach(function (pair) {
      var m = pair[0], side = pair[1]; if (!m) return;
      var lyrId = node.id + '-label-' + side, srcId = node.id + '-labels-' + side;
      function teardown() { try { if (m.getLayer(lyrId)) m.removeLayer(lyrId); } catch (e) {} try { if (m.getSource(srcId)) m.removeSource(srcId); } catch (e) {} }
      if (!node.labels || !node.labels.field) { teardown(); return; }
      // TILESETS of every type label off the vector source (labels.js needs the REAL node's
      // source/source-layer); the geojson-anchor proxy is only for drawn/imported layers
      var isVecLine = node.source && node.source.type === 'vector';
      var proxy = isVecLine ? node : { id: node.id, type: node.type, labels: node.labels,
        source: { type: 'geojson', data: { type: 'FeatureCollection', features: labelFeaturesFor(node) } } };
      var ll = msLabelLayerFor(proxy, side, 'visible', m);   // m → fonts the style's glyph server actually has
      if (!ll) { teardown(); return; }
      try {
        // if WE already own a geojson label source, update it IN PLACE (setData + re-apply style) —
        // remove/re-add made every OTHER label flash off/on on each edit (7/28)
        var own = (ll.source && ll.source.type === 'geojson' && ll.sourceId === srcId) ? m.getSource(srcId) : null;
        if (own && own.setData && m.getLayer(lyrId)) {
          own.setData(ll.source.data);
          var L = ll.layer;
          if (L.layout) Object.keys(L.layout).forEach(function (k) { try { m.setLayoutProperty(lyrId, k, L.layout[k]); } catch (e) {} });
          if (L.paint) Object.keys(L.paint).forEach(function (k) { try { m.setPaintProperty(lyrId, k, L.paint[k]); } catch (e) {} });
        } else {
          teardown();
          if (ll.sourceId && !m.getSource(ll.sourceId)) m.addSource(ll.sourceId, ll.source);
          if (!m.getLayer(ll.layer.id)) m.addLayer(ll.layer);   // line labels reuse the engine source (slug-side), which exists even when its layer is hidden
        }
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
  // ══ MAKE FASTER (8/17) ═══════════════════════════════════════════════════════════════════════
  // Speed became opt-in, per layer. The record is raw_config.fast = { raster, deck }, which spreads
  // onto the rendered node as node.fast and is read by rasterScrub.js + deckScrub.js.
  // ABSENT means "never chosen", and for a layer that already carries a rasterYears bake that reads
  // as raster ON — so every map baked before today keeps its instant scrub with no migration, while
  // nothing new bakes by itself. Both renderers apply this same rule; it is stated once, here.
  function fastOf(node) {
    var f = (node && node.fast) || null;
    return { raster: f ? !!f.raster : !!(node && node.rasterYears), deck: f ? !!f.deck : false };
  }
  // The whole disclosure, in one place. This is the popup the owner asked for: "a button that says
  // 'Explain' that gives a popup, with details about options, with baking vs deck, and their
  // drawbacks and limitations." Written for someone deciding, not for someone debugging.
  function openFastHelp() {
    var ov = document.getElementById('elp-fasthelp-overlay');
    if (!ov) {
      var css = document.createElement('style');
      css.textContent =
        '#elp-fasthelp-overlay{position:fixed;inset:0;background:rgba(20,18,30,0.5);z-index:4000;display:none;}' +
        '#elp-fasthelp-panel{position:absolute;top:7vh;left:50%;transform:translateX(-50%);width:560px;max-width:93vw;max-height:82vh;display:flex;flex-direction:column;background:#fff;border-radius:12px;box-shadow:0 18px 60px rgba(0,0,0,0.4);font-family:Source Sans Pro,Arial,sans-serif;color:#2a2a33;overflow:hidden;}' +
        '#elp-fasthelp-head{display:flex;justify-content:space-between;align-items:center;padding:14px 22px 11px;border-bottom:1px solid #ece9f4;background:linear-gradient(180deg,#faf9fd,#fff);}' +
        '#elp-fasthelp-head b{font-size:16px;color:#1e1b2e;}' +
        '#elp-fasthelp-head small{display:block;font-weight:400;font-size:12px;color:#8a86a0;margin-top:1px;}' +
        '#elp-fasthelp-close{cursor:pointer;color:#a09cb5;font-size:22px;line-height:1;padding:2px 6px;border-radius:6px;}' +
        '#elp-fasthelp-close:hover{background:#f1eef9;color:#544f6e;}' +
        '#elp-fasthelp-body{overflow-y:auto;padding:4px 22px 22px;font-size:13px;line-height:1.55;}' +
        '#elp-fasthelp-body h4{margin:17px 0 3px;font-size:13.5px;color:#1e1b2e;}' +
        '#elp-fasthelp-body p{margin:5px 0;}' +
        '#elp-fasthelp-body b{color:#1e1b2e;}' +
        '#elp-fasthelp-body ul{margin:5px 0 5px 2px;padding-left:17px;}' +
        '#elp-fasthelp-body li{margin:3px 0;}' +
        '#elp-fasthelp-body .fh-kick{display:inline-block;min-width:74px;font-weight:700;color:#5b4b9a;}' +
        '#elp-fasthelp-body .fh-card{margin:7px 0 0;padding:9px 12px;border:1px solid #ece9f4;border-radius:8px;background:#fbfaff;}';
      document.head.appendChild(css);
      ov = document.createElement('div');
      ov.id = 'elp-fasthelp-overlay';
      ov.innerHTML =
        '<div id="elp-fasthelp-panel">' +
          '<div id="elp-fasthelp-head"><div><b>⚡ Make Faster</b><small>Two ways to speed up the time slider — and what each one costs</small></div><span id="elp-fasthelp-close">&times;</span></div>' +
          '<div id="elp-fasthelp-body">' +
            '<p>These settings change <b>one thing only</b>: how this layer draws <i>during</i> the drag, while your finger is down. The instant you let go, the map always redraws itself exactly right. So nothing here can affect your finished map, a screenshot, or what a visitor sees when they stop dragging.</p>' +
            '<p>They exist because the normal way of drawing has to re-decide every feature on every frame. With a few thousand features that is invisible. With a hundred thousand it is a lag you can feel.</p>' +

            '<h4>Leaving both off (the default)</h4>' +
            '<p>The map draws normally. <b>Everything is exact</b> — every colour, dash, outline, hover and label, at every zoom. Nothing to bake, nothing to keep up to date, nothing to go stale.</p>' +
            '<p>The only cost is speed on big layers. If dragging feels smooth, you are done — you do not need anything on this panel.</p>' +

            '<h4>Baked snapshot</h4>' +
            '<p>MapStructor pre-renders a picture of this layer at every year and stores it. Dragging then flips through pictures, which is the <b>fastest option there is</b> and costs the same on a ten-year-old laptop as on a new one.</p>' +
            '<div class="fh-card">' +
              '<div><span class="fh-kick">Best for</span> huge layers you drag often, and audiences on weak or unpredictable machines.</div>' +
              '<div style="margin-top:4px;"><span class="fh-kick">Costs you</span> <b>time, more than once.</b> Baking a large layer can take minutes, and <b>it has to be redone</b> whenever you change the data or restyle the layer — otherwise the drag shows the old picture.</div>' +
            '</div>' +
            '<p style="margin-top:8px;">Its limits while dragging:</p>' +
            '<ul>' +
              '<li>It is a picture, so it is <b>slightly soft</b> when you are zoomed in close. Past a certain zoom it steps aside on its own and normal drawing takes over.</li>' +
              '<li><b>Hover highlighting doesn\'t work</b> on a picture — but you are dragging the slider, not pointing at features.</li>' +
              '<li>Only works where a snapshot can be honest: <b>not point layers</b>, and not layers whose start dates span more than 255 years.</li>' +
            '</ul>' +

            '<h4>Graphics-card preview</h4>' +
            '<p>Draws this layer\'s <b>real shapes</b> on your graphics card during the drag, filtering by date in hardware. <b>Nothing to bake and nothing to keep fresh</b> — it always reads your current data, so it can never go stale.</p>' +
            '<div class="fh-card">' +
              '<div><span class="fh-kick">Best for</span> layers you are actively editing, and anything you would rather not wait on.</div>' +
              '<div style="margin-top:4px;"><span class="fh-kick">Costs you</span> <b>exactness, not time.</b> It re-draws your styling rather than sharing it, so some of it is approximated while you drag.</div>' +
            '</div>' +
            '<p style="margin-top:8px;">What it approximates while dragging:</p>' +
            '<ul>' +
              '<li><b>Dash patterns</b> draw solid, and <b>line offsets</b> sit on the shared edge.</li>' +
              '<li><b>Labels and icons</b> aren\'t drawn by it — the map\'s own labels keep working alongside.</li>' +
              '<li>Colour, outline, width, opacity and colour-by-column <b>are</b> carried over.</li>' +
              '<li>It needs a working graphics card. On a machine without one the option is switched off, and that layer simply drags normally.</li>' +
            '</ul>' +
            '<p style="margin-top:9px;">Turning one on does not commit you to anything — untick it and the next drag goes straight back to normal drawing. A snapshot you already baked is <b>kept, not deleted</b>, so you can switch it back on later without waiting again.</p>' +
          '</div>' +
        '</div>';
      document.body.appendChild(ov);
      ov.querySelector('#elp-fasthelp-close').addEventListener('click', function () { ov.style.display = 'none'; });
      ov.addEventListener('click', function (e) { if (e.target === ov) ov.style.display = 'none'; });
      document.addEventListener('keydown', function (e) { if (e.key === 'Escape') ov.style.display = 'none'; });
    }
    ov.style.display = 'block';
  }
  // Reveal + fill the section for the active layer. Freshness comes from stamps the bake writes
  // (rasterYears.at / .fc) compared with the tile bake's own stamp — no extra query, and it answers
  // the question optional baking creates: "is what I baked still what my data says?"
  function fillFastSection(node) {
    var sec = document.getElementById('elp-fast-sec'); if (!sec) return;
    sec.style.display = 'none';
    if (!node || node.type === 'section' || node.type === 'group' || node.type === 'divider') return;
    if (node.timelineIgnore) return;   // this layer never listens to the slider — nothing to speed up
    sec.style.display = 'block';
    var f = fastOf(node), ry = node.rasterYears || null;
    var cbR = document.getElementById('elp-fast-raster'), cbD = document.getElementById('elp-fast-deck');
    cbR.checked = f.raster; cbD.checked = f.deck;
    var rn = document.getElementById('elp-fast-raster-note'), btn = document.getElementById('elp-fast-bake');
    if (!ry) {
      rn.innerHTML = 'Nothing baked yet — click <b>Bake snapshot</b> below.';
      btn.innerHTML = '🔥 Bake snapshot';
      cbR.disabled = true;             // ticking a snapshot that doesn't exist would be a lie
    } else {
      cbR.disabled = false;
      var kb = Math.round((ry.bytes || 0) / 1024);
      var ryAt2 = msRasterBakeAt(ry);
      var when = null; try { when = ryAt2 ? new Date(ryAt2).toLocaleDateString() : null; } catch (eD) {}
      /* `new Date("nonsense")` does not throw — it returns Invalid Date, and EVERY comparison with
         it is false. So an unparseable timestamp did not fail loudly here; it quietly meant
         "not stale", and the owner was told their snapshot was current while looking at old tiles.
         Absence treated as the benign default, in the one direction that misleads.
         Unknown now counts as STALE and says so: re-baking unnecessarily costs a few minutes,
         while trusting an old bake costs a wrong map you have no reason to doubt. */
      var ms = function (v) { var t = v ? new Date(v).getTime() : NaN; return t; };
      var bakedAt = ms(ryAt2), stale = false, staleWhy = 'data';
      if (ryAt2 && isNaN(bakedAt)) { stale = true; staleWhy = 'bake date unreadable'; }
      else if (!isNaN(bakedAt)) {
        var dataAt = ms(node.tilesGeneratedAt), styleAt = ms(node.styleChangedAt);
        if (node.tilesGeneratedAt && isNaN(dataAt)) { stale = true; staleWhy = 'edit date unreadable'; }
        else if (dataAt > bakedAt) { stale = true; staleWhy = 'data'; }
        // styling is baked into the raster too (colours, stroke width) — a restyle stales it the
        // same as a data edit (8/19, "the bake didn't do colors again")
        else if (node.styleChangedAt && isNaN(styleAt)) { stale = true; staleWhy = 'style date unreadable'; }
        else if (styleAt > bakedAt) { stale = true; staleWhy = 'styling'; }
      }
      if (stale && /unreadable/.test(staleWhy) && window.MSGuard)
        MSGuard.warnOnce('bake-date-unreadable', 'a bake or edit timestamp could not be read, so the snapshot is being reported as needing a re-bake');
      // `fc || shapes` — the second spelling of the same count, found by find-key-mismatch right
      // after the `at`/`bakedAt` one: the indexed baker writes `shapes` (19/34) and only the older
      // path writes `fc` (4/34), so this line silently omitted the feature count on 88% of bakes.
      var ryFc = ry.fc || ry.shapes;
      rn.innerHTML = 'Baked' + (when ? ' ' + when : '') + (kb ? ' · ' + kb + ' KB' : '') + (ryFc ? ' · ' + Number(ryFc).toLocaleString() + ' features' : '') +
        (stale ? '<br><b style="color:#b4453a;">The ' + staleWhy + ' changed since — re-bake.</b>' : '');
      btn.innerHTML = '🔥 Re-bake snapshot';
    }
    var dn = document.getElementById('elp-fast-deck-note');
    var deckOk = false; try { deckOk = !!(window.MSDeckScrub && MSDeckScrub.available()); } catch (eK) {}
    cbD.disabled = !deckOk;
    dn.innerHTML = deckOk
      ? 'Instant, nothing to bake. Some styling is approximated mid-drag.'
      : 'Not available — no usable graphics card on this device.';
  }
  async function onFastToggle(kind, on) {
    if (!activeLayerId) return;
    var node = findNodeById(layers, activeLayerId); if (!node) return;
    var lid = slugToLayerDbId[activeLayerId]; if (!lid) { setStatus('That layer has no database id'); return; }
    var f = fastOf(node);   // resolve the IMPLICIT state first — writing {deck:true} alone would
    f[kind] = !!on;         // otherwise clear a pre-8/17 layer's inherited "raster on"
    node.fast = { raster: f.raster, deck: f.deck };
    var st = document.getElementById('elp-fast-status');
    if (st) {
      st.style.display = 'block';
      st.textContent = (f.raster || f.deck)
        ? 'Dragging this layer now uses: ' + [f.raster ? 'baked snapshot' : null, f.deck ? 'graphics-card preview' : null].filter(Boolean).join(' + ') + '.'
        : 'Dragging this layer now draws normally — exact, nothing baked.';
    }
    setStatus('Saving…');
    try {
      var r = await patchLayerConfig(lid, { fast: { raster: f.raster, deck: f.deck } });
      if (r.error) throw new Error(r.error.message);
      setStatus('Saved');
    } catch (e) { console.warn('Make Faster save failed', e); setStatus('Save failed'); }
    // the running scrub rebuilds its item list from the nodes, so the very next drag obeys this
    try { if (window.MSRasterScrub && MSRasterScrub.reload) MSRasterScrub.reload(); } catch (e2) {}
  }
  async function onBakeSnapshot() {
    // EVERY exit path has to speak IN THE PANEL. The first version returned silently when the layer
    // had no db id, so pressing Bake looked like a dead button — nothing moved, nothing said why
    // (8/17 gate: status stayed empty for six seconds and the run read as "the bake did nothing").
    var st = document.getElementById('elp-fast-status');
    var say = function (t) { if (st) { st.style.display = 'block'; st.textContent = t; } };
    if (!activeLayerId) { say('Select a layer first.'); return; }
    var node = findNodeById(layers, activeLayerId); if (!node) { say('That layer is no longer on the map.'); return; }
    var lid = slugToLayerDbId[activeLayerId];
    if (!lid) { say('This layer has no database id yet — save the map, then try again.'); setStatus('That layer has no database id'); return; }
    var keepDeck = fastOf(node).deck;
    var btn = document.getElementById('elp-fast-bake'), lbl = btn ? btn.innerHTML : '';
    say('Reading this layer’s features…');
    if (btn) { btn.disabled = true; btn.textContent = '🔥 Baking…'; }
    try {
      await loadScript('../platform/tilegen.js?v=' + Date.now());   // MSTileGen isn't on the page until loaded
      if (!(window.MSTileGen && MSTileGen.bakeScrubRaster)) throw new Error('tiler unavailable');
      var out = await MSTileGen.bakeScrubRaster(db, projectId, { id: lid, name: node.label, type: node.type },
        function (m) { say(m); msProgress(m); });
      if (out === -1) setStatus('This layer can’t take a snapshot');
      else if (!out) { say('Nothing to bake — this layer has no features of its own.'); setStatus('Nothing to bake'); }
      else {
        node.rasterYears = out;
        node.fast = { raster: true, deck: keepDeck };
        setStatus('Snapshot baked');
        msProgress('Snapshot baked — “' + (node.label || 'layer') + '” now scrubs instantly.');
      }
    } catch (e) {
      console.warn('snapshot bake failed', e);
      say('Bake failed: ' + ((e && e.message) || e));
      setStatus('Bake failed');
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = lbl || '🔥 Bake snapshot'; }
      fillFastSection(node);
    }
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
      var r2 = await patchLayerConfig(lid, { labels: (node.labels) ? node.labels : null });
      if (r2.error) throw new Error(r2.error.message);
      applyLabelLayers(node);
      // TILESET LABELS ONLY SAY WHAT THE TILER WROTE (8/7). A symbol layer over a vector source
      // reads the tile's own properties, and skinny tiles carry the timeline days, `label`, and
      // whichever column labels.field named AT BAKE TIME — nothing else. So picking a column the
      // archive predates renders blank labels with no explanation. Compare against the stamp
      // convertLayer records and re-bake when they disagree; `label` itself always rides, so it
      // never needs one. Owner 8/7: CShapes-2.0's names live in cntry_name, which was in no tile.
      if (isTilesetNode(node)) {
        var want = node.labels ? ((node.labels.field || 'label') === 'label' ? null : node.labels.field) : null;
        var have = ('tilesLabelField' in rc) ? (rc.tilesLabelField || null) : undefined;
        if (want && have !== want) {
          try {
            var bakedOk = await rebakeLayerTiles(lid, 'Baking “' + want + '” into');
            if (bakedOk) { msProgress('Labels ready — “' + want + '” is baked into the tiles.'); setStatus('Labels baked'); }
            else msProgress('Labels saved, but this layer’s tiles could not be re-baked — its labels stay blank until they are.');
          } catch (eLb) {
            console.warn('label re-bake failed', eLb);
            msProgress('Labels saved, but the tile re-bake failed (' + (eLb && eLb.message || eLb) + ') — hit Publish to bake “' + want + '” in.');
          }
        }
      }
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
  function parseLooseDate(v, isEnd) {   // "1877"→1877-01-01/12-31; "18700101"→1870-01-01; ISO passes; Date-readable→ISO; junk/0/9999…→null
    if (v == null) return null;
    if (v instanceof Date) return isNaN(v.getTime()) ? null : (v.getFullYear() + '-' + ('0' + (v.getMonth() + 1)).slice(-2) + '-' + ('0' + v.getDate()).slice(-2));
    v = String(v).trim();
    // Unwrap a value that was JSON-encoded on the way in. Imports before 8/7 stored DBF date
    // columns as '"1886-01-01T04:56:16.000Z"' — quotes included — and every test below starts
    // at a digit, so those rows read as "no date". Reading them costs one replace and spares
    // anyone who already imported a shapefile from having to import it again.
    if (v.length > 1 && v.charAt(0) === '"' && v.charAt(v.length - 1) === '"') v = v.slice(1, -1).trim();
    if (!v || v === '0' || /^(none|null|n\/a)$/i.test(v)) return null;
    if (/^\d{3,4}$/.test(v)) { var y = ('0000' + v).slice(-4); return isEnd ? y + '-12-31' : y + '-01-01'; }
    // Compact integer dates (the railway "DayStart"/"DayEnd" convention, e.g. 18700101): YYYYMMDD or
    // YYYYMM. A 00 month/day means "unknown" → widen to the period's start (Jan 1 / day 1) or end
    // (Dec 31 / month-end). Year ≥ 9999 is the "no end" sentinel (99990101) → leave it open (null).
    var mc = /^(\d{4})(\d{2})(\d{2})$/.exec(v) || /^(\d{4})(\d{2})$/.exec(v);
    if (mc) {
      var Y = +mc[1]; if (Y >= 9999) return null;
      var Mo = +(mc[2] || 0), Da = +(mc[3] || 0), p2 = function (n) { return ('0' + n).slice(-2); };
      if (Mo < 1 || Mo > 12) Mo = isEnd ? 12 : 1;
      if (Da < 1 || Da > 31) Da = isEnd ? new Date(Y, Mo, 0).getDate() : 1;   // day 0 of next month = last day of this one
      return mc[1] + '-' + p2(Mo) + '-' + p2(Da);
    }
    if (/^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
    // EPOCH NUMBERS (8/7). A shapefile has no date type wide enough for history, so GIS tools put
    // dates in a NUMERIC field as an offset from 1970 — negative for anything earlier. The owner's
    // gazetteer stores 1652 as -10035100800000. Nothing above could read that (it has a sign, it is
    // not 4 digits, not YYYYMMDD, and `new Date(string)` refuses a bare number that long), so the
    // column silently produced no dates at all. Milliseconds is what QGIS/GDAL write; seconds is
    // the other common convention, so both are tried. These values are absolute instants the tool
    // wrote at UTC midnight — read them in UTC, unlike a Date OBJECT from the .dbf, which shpjs
    // builds in the viewer's own zone.
    if (/^-?\d{9,}$/.test(v)) {
      var n = Number(v);
      if (!isFinite(n)) return null;
      var tries = [n, n * 1000];
      for (var ti = 0; ti < tries.length; ti++) {
        var de = new Date(tries[ti]);
        if (isNaN(de.getTime())) continue;
        var yr = de.getUTCFullYear();
        if (yr < 1 || yr >= 9999) continue;   // year 9999 = the "no end" sentinel, same as 99990101 above
        // a big number that reads as a date right next to 1970 is almost certainly SECONDS
        // (1600000000 is September 2020 in seconds, but the 19th of January 1970 in milliseconds)
        if (ti === 0 && yr >= 1968 && yr <= 1972 && Math.abs(n) > 1e8) continue;
        return de.toISOString().slice(0, 10);
      }
      return null;
    }
    var d = new Date(v);
    return isNaN(d) ? null : d.toISOString().slice(0, 10);
  }
  // 7/21: per-layer timeline opt-out — node.timelineIgnore → raw_config; the engine (changeDate/
  // paintDate/addMapLayer) skips filtering these layers, so they always show every feature.
  async function onTlIgnore(on) {
    if (!activeLayerId) return;
    var node = findNodeById(layers, activeLayerId); if (!node) return;
    var lid = slugToLayerDbId[activeLayerId]; if (!lid) { setStatus('That layer has no database id'); return; }
    if (on) node.timelineIgnore = true; else delete node.timelineIgnore;
    // live: clear (on) or re-apply (off) the date filter on both maps, companions included
    var d = (typeof editorCurrentDate === 'function') ? editorCurrentDate() : null;
    [['left', beforeMap], ['right', (typeof afterMap !== 'undefined' ? afterMap : null)]].forEach(function (pair) {
      var m = pair[1]; if (!m) return;
      // LABELS were missing here, so switching "show everything" on left every shape visible with
      // its label still date-filtered. They follow the same rule with a different expression —
      // msDateFilter is the sole author of both. (-edited- is owned by applyEditedOverlayDayFilter.)
      [node.id + '-' + pair[0], node.id + '-stroke-' + pair[0], node.id + '-highlighted-' + pair[0],
       node.id + '-label-' + pair[0]].forEach(function (id) {
        try { if (m.getLayer(id)) m.setFilter(id, msDateFilter(msDateKindFor(id), on ? null : d, false)); } catch (e) {}
      });
    });
    // companions-ok: -edited- is not enumerated here on purpose. It has ONE owner, and the fix for
    // a missing companion is to call that owner, not to add a fifth copy of the suffix list.
    try { applyEditedOverlayDayFilter(on ? null : d); } catch (eEd) {}
    setStatus('Saving…');
    try {
      var r = await patchLayerConfig(lid, { timelineIgnore: (on) ? true : null });
      if (r.error) throw new Error(r.error.message);
      setStatus('Saved');
    } catch (e) { console.warn('timelineIgnore save failed', e); setStatus('Save failed'); }
  }
  var _dateSecGen = 0;
  async function fillDateSection(node) {   // populate the column picks from a 60-row sample; reveal only for layers with DB rows
    var sec = document.getElementById('elp-dates-sec'); if (!sec) return;
    sec.style.display = 'none';
    var tlCb = document.getElementById('elp-tlignore'); if (tlCb) tlCb.checked = !!(node && node.timelineIgnore);
    var gen = ++_dateSecGen;
    var lid = node && slugToLayerDbId[node.id];
    if (!lid && idsReady) { try { await idsReady; } catch (e) {} lid = node && slugToLayerDbId[node.id]; }   // early click during a heavy boot — ids may still be resolving
    if (!lid || gen !== _dateSecGen) return;
    // 7/21 instances: reveal the section (the ignore-timeline checkbox is their main use) but hide the
    // column-mapping tools — dates live on the ORIGINAL layer's data, which this instance only mirrors.
    var tools = document.getElementById('elp-dates-tools');
    if (node && node.instanceOf) { if (tools) tools.style.display = 'none'; sec.style.display = ''; return; }
    if (tools) tools.style.display = '';
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
  // Core date-writer — shared by the style-panel "Timeline dates" tool AND the attr-table
  // "Transfer column → Start/End". start/end each = {col:'<custom key>'} | {fixed:'YYYY-MM-DD'} | null.
  // Reads custom_fields[col], parses via parseLooseDate (years, ISO, railway YYYYMMDD ints like
  // 18700101), groups rows by the computed value, and writes in batched .in() UPDATEs (features is a
  // VIEW — no upsert/ON CONFLICT; repeated year values collapse to a handful of requests).
  async function applyDatesToLayer(lid, slug, node, start, end) {
    // keyset + adaptive pages (8/13) — fixed offset pages time out on heavy layers
    var r9 = await window.MSFetchRows(db, 'feature_id, start_date, end_date, custom_fields',
      function (q) { return q.eq('layer_id', lid); },
      { onPage: function (n) { msProgress('Reading features… ' + nfmt(n)); } });
    if (r9.error) throw new Error(r9.error.message);
    var rows = r9.rows;
    if (!rows.length) { msProgress(''); setStatus('No features'); return 0; }
    var clobber = [];
    if (start) { var ns = rows.filter(function (r) { return r.start_date != null; }).length; if (ns) clobber.push(nfmt(ns) + ' features already have a Start date'); }
    if (end) { var ne = rows.filter(function (r) { return r.end_date != null; }).length; if (ne) clobber.push(nfmt(ne) + ' features already have an End date'); }
    if (clobber.length && !window.confirm('There is data in the date column' + (clobber.length > 1 ? 's' : '') + ' (' + clobber.join('; ') + '). Are you sure you want to replace it?')) { msProgress(''); setStatus('Cancelled'); return 0; }
    // ── A YEAR IS A SPAN, NOT AN INSTANT (8/7) ────────────────────────────────────────────
    // A column can carry a year written three ways: "1767", 17670101, or an epoch instant for
    // 1767-01-01 (what QGIS/GDAL write into a numeric shapefile field). Only the first was being
    // widened, so an End column of epoch instants ended every period on 1 JANUARY — a mission that
    // ran through 1767 vanished on the 2nd of January 1767, and the map showed it for one day of
    // the year it was actually there. That is a historical error, not a rounding one.
    // A source with day precision spreads its values across the calendar. One that lands EVERY
    // value on 1 January is not claiming 2,000 New Year's Days — it is a year in disguise, and its
    // End dates belong on 31 December, exactly as "1767" already does.
    function colValues(col) { return rows.map(function (r) { return r.custom_fields && r.custom_fields[col]; }); }
    function yearOnlyColumn(col) {
      var vals = colValues(col), seen = 0;
      for (var i = 0; i < vals.length; i++) {
        var p = parseLooseDate(vals[i], false);
        if (!p) continue;
        seen++;
        if (p.slice(4) !== '-01-01') return false;
      }
      return seen > 0;
    }
    var endYearOnly = !!(end && !end.fixed && end.col && yearOnlyColumn(end.col));
    function widenEnd(v) { return (endYearOnly && v && v.slice(4) === '-01-01') ? (v.slice(0, 4) + '-12-31') : v; }

    // "No end" is not a failure. 99990101, or an epoch instant landing in year 9999, is the
    // standard marker for "still open" — the owner's gazetteer uses it on 1,578 of 2,000 rows.
    // It parses to null exactly as junk does, and an empty cell is simply missing rather than
    // unreadable; reporting either as a problem would bury the values that really are one.
    function deliberatelyOpen(v) {
      if (v == null || v === '') return true;
      var s = String(v).trim().replace(/^"|"$/g, '');
      if (!s || s === '0' || /^(none|null|n\/a)$/i.test(s)) return true;
      if (/^-?\d{9,}$/.test(s)) {
        var n0 = Number(s);
        return [n0, n0 * 1000].some(function (ms) { var d = new Date(ms); return !isNaN(d.getTime()) && d.getUTCFullYear() >= 9999; });
      }
      var m0 = /^(\d{4})\d{0,4}$/.exec(s);
      return !!m0 && +m0[1] >= 9999;
    }
    var payload = [], blank = 0, badVals = {}, badCount = 0;
    function noteBad(col, raw) {
      if (deliberatelyOpen(raw)) return;
      badCount++;
      var k = col + ' = ' + String(raw).slice(0, 40);
      badVals[k] = (badVals[k] || 0) + 1;
    }
    rows.forEach(function (r) {
      var cf = r.custom_fields || {}, u = { feature_id: r.feature_id, layer_id: lid }, touched = false;
      if (start) {
        var sv = start.fixed != null ? start.fixed : parseLooseDate(cf[start.col], false);
        if (!sv) { blank++; if (start.fixed == null) noteBad(start.col, cf[start.col]); }
        u.start_date = sv || null; touched = true;
      }
      if (end) {
        var ev = end.fixed != null ? end.fixed : widenEnd(parseLooseDate(cf[end.col], true));
        if (!ev) { blank++; if (end.fixed == null) noteBad(end.col, cf[end.col]); }
        u.end_date = ev || null; touched = true;
      }
      // A date we cannot read leaves the column NULL, which the timeline reads as "always
      // visible" — the feature stays on the map until someone fills it in by hand, rather than
      // silently disappearing because its source used a format we do not speak.
      if (touched) payload.push(u);
    });

    // ── ONE REQUEST PER 1,000 FEATURES, NOT ONE PER DISTINCT DATE (8/7) ───────────────────
    // The old loop grouped rows by their (start,end) value and sent one UPDATE per group. That is
    // fine for a handful of eras and terrible for a real gazetteer: the owner's 2,000-point layer
    // has 380 distinct pairs, so it made 380 network round-trips to write 2,000 rows and took
    // minutes. The work was never the database — it was the waiting. A bulk upsert keyed on the
    // primary key writes any number of DIFFERENT values in one statement; feature_id is the only
    // NOT NULL column, so a payload of ids plus dates is complete, and every id here came from
    // this layer's own rows, so every one conflicts and updates rather than inserting.
    var upserts = payload;
    // ── LIVE LAYERS SEE THEIR DATES IMMEDIATELY (8/7) ─────────────────────────────────────
    // An engine-rendered geojson layer draws from the source built at page load; until now the
    // new dates existed only in the database, so the slider kept filtering yesterday's
    // properties until a refresh. Worst on a layer dated for the FIRST time: its source had no
    // DayStart at all, so dragging (coalesce → always visible) animated nothing and releasing
    // (legacy filter → missing property = hidden) blanked the layer — the exact "animates
    // wrong, then things change on release" chaos reported. Patch the live features and
    // re-apply the current date's filter on the spot, both maps, companions included.
    try {
      if (node && node.source && node.source.type === 'geojson' && node.source.data && node.source.data.features) {
        var byFid2 = {}; payload.forEach(function (u) { byFid2[String(u.feature_id)] = u; });
        var ymd2 = function (d, dflt) { return d ? +(String(d).slice(0, 10).replace(/-/g, '')) || dflt : dflt; };
        var liveMatched = 0;
        node.source.data.features.forEach(function (f) {
          var k2 = f.id != null ? String(f.id) : (f.properties && f.properties.feature_id != null ? String(f.properties.feature_id) : null);
          var u2 = k2 && byFid2[k2]; if (!u2) return;
          liveMatched++;
          f.properties = f.properties || {};
          if ('start_date' in u2) f.properties.DayStart = ymd2(u2.start_date, 0);
          if ('end_date' in u2) f.properties.DayEnd = ymd2(u2.end_date, 99999999);
        });
        // Tripwire (8/8): this refresh matching NOTHING is exactly how "Dates applied" once meant
        // "nothing on screen changed until reload" — an id-less live source fails here SILENTLY,
        // so say it loudly instead of letting the status line claim success.
        if (payload.length && !liveMatched) console.warn('live date refresh matched 0 of ' + payload.length + ' features by id — the timeline will not reflect these dates until the page is reloaded');
        var dNow = (typeof editorCurrentDate === 'function') ? editorCurrentDate() : undefined;
        [['left', beforeMap], ['right', (typeof afterMap !== 'undefined' ? afterMap : null)]].forEach(function (pr2) {
          var m2 = pr2[1]; if (!m2) return;
          try { var s2 = m2.getSource(node.id + '-' + pr2[0]); if (s2 && s2.setData) s2.setData(node.source.data); } catch (e2) {}
          // -label- added 8/21: re-sourcing left the label layer on the PREVIOUS date filter.
          [node.id + '-' + pr2[0], node.id + '-stroke-' + pr2[0], node.id + '-highlighted-' + pr2[0],
           node.id + '-label-' + pr2[0]].forEach(function (lid2) {
            try { if (m2.getLayer(lid2)) m2.setFilter(lid2, msDateFilter(msDateKindFor(lid2), dNow, node.timelineIgnore)); } catch (e3) {}
          });
        });
        // companions-ok: -edited- has one owner; call it instead of adding the suffix here again.
        try { applyEditedOverlayDayFilter(dNow); } catch (eEd2) {}
      }
    } catch (eLive) { console.warn('live date refresh failed', eLive); }
    if (_attrSlug === slug && _attrRows.length) {   // keep an open attribute table on this layer in sync
      var byId9 = {}; upserts.forEach(function (u) { byId9[String(u.feature_id)] = u; });
      _attrRows.forEach(function (r) { var u = byId9[String(r.feature_id)]; if (!u) return; if ('start_date' in u) r.start_date = u.start_date; if ('end_date' in u) r.end_date = u.end_date; });
      try { renderAttrBody(); } catch (e2) {}
    }
    // WHY THE TIMELINE MIGHT LOOK DEAD (8/7). Historical sources very often use a placeholder for
    // "before our records start" the same way they use 9999 for "no end" — the owner's gazetteer
    // puts 1,486 of 2,000 places at 1111-01-01, every one of them flagged `start_ex = "start"` in
    // its own certainty column. Those points are on the map from the first frame and never move,
    // so scrubbing six centuries changes the picture by a few percent and reads as "animation is
    // broken". It is not, and nothing here should GUESS that a date is a placeholder — but saying
    // which value dominates turns an invisible data property into something the owner can act on.
    var domNote = '';
    if (start && upserts.length) {
      var tally = {}, top = null;
      upserts.forEach(function (u) { if (u.start_date) { tally[u.start_date] = (tally[u.start_date] || 0) + 1; } });
      Object.keys(tally).forEach(function (k) { if (!top || tally[k] > tally[top]) top = k; });
      if (top && tally[top] >= Math.max(20, upserts.length * 0.4)) {
        domNote = ' · heads-up: ' + nfmt(tally[top]) + ' of ' + nfmt(upserts.length) + ' share the start date ' + top
          + ', so they all appear at once and the timeline will look nearly still — that is usually a "no earlier record" placeholder in the source.';
      }
    }
    msProgress('Dates applied to ' + nfmt(upserts.length) + ' features'
      + (endYearOnly ? ' · the End column holds only years, so each one runs to 31 December' : '')
      + (blank ? ' · ' + nfmt(blank) + ' left blank (always visible)' : '') + '.' + domNote);
    setStatus('Dates applied — saving…');
    // SAY WHAT WE COULD NOT READ (8/7). A value we cannot parse leaves the column blank, which the
    // timeline treats as "always visible" — nothing disappears — but silence would leave the owner
    // to discover the gap by noticing a feature that never moves. Name the column and the actual
    // values, since that is what tells them whether it is a format worth supporting or genuinely
    // missing data. Grouped and counted: a gazetteer with 1,578 blanks has a handful of causes.
    if (badCount) {
      var kinds9 = Object.keys(badVals).sort(function (a, b) { return badVals[b] - badVals[a]; });
      var head9 = nfmt(badCount) + ' date value' + (badCount === 1 ? '' : 's') + ' could not be read, across '
        + nfmt(kinds9.length) + ' distinct value' + (kinds9.length === 1 ? '' : 's') + '.\n\n'
        + 'Those features were left blank, so they stay visible at every date until you set them by hand.\n\n'
        + 'Show the values?';
      try {
        if (window.confirm(head9)) {
          var list9 = kinds9.slice(0, 40).map(function (k) { return '  ' + nfmt(badVals[k]) + ' x   ' + k; }).join('\n');   // cliff-ok: a diagnostic message listing example bad values, not the data itself
          window.alert('Values that could not be read as dates:\n\n' + list9
            + (kinds9.length > 40 ? '\n\n  …and ' + nfmt(kinds9.length - 40) + ' more' : '')
            + '\n\nOpen Table to see them in the column itself.');
        }
      } catch (eRep) {}
    }
    // ── THE SAVE RUNS AFTER THE SCREEN IS ALREADY RIGHT (8/7: "it should be instantaneous") ──
    // Everything above — map, table, summary, the unreadable-values dialog — came from data this
    // browser already held, so it all happens the moment Apply is clicked; the network is pure
    // durability. One bulk upsert keyed on the primary key carries any number of DIFFERENT
    // values, so 5,000 rows per request is one request for nearly every layer (the old
    // per-distinct-value loop sent 380 requests for this same 2,000-row gazetteer and took
    // minutes). Failure is loud and honest: the screen keeps the applied dates, the message says
    // plainly they are NOT saved, and clicking Apply again retries.
    var doneN = 0, DATE_CHUNK = 5000;
    try {
      for (var i9 = 0; i9 < payload.length; ) {
        var take9 = Math.min(payload.length - i9, DATE_CHUNK);
        var w9 = await db.from('features_data').upsert(payload.slice(i9, i9 + take9), { onConflict: 'feature_id' });
        if (w9.error) {
          if (/timeout|canceling statement/i.test(w9.error.message || '') && take9 > 50) { DATE_CHUNK = Math.max(50, Math.floor(DATE_CHUNK / 2)); continue; }
          throw new Error(w9.error.message);
        }
        i9 += take9; doneN += take9;
        if (payload.length > DATE_CHUNK) msProgress('Saving… ' + nfmt(doneN) + '/' + nfmt(payload.length));
      }
    } catch (eSave) {
      msProgress('⚠ The dates are SHOWING but did NOT save (' + (eSave && eSave.message || eSave) + '). Click Apply again to retry the save.');
      setStatus('Dates NOT saved');
      return 0;
    }
    setStatus('Dates applied');
    // DRAW → ENGINE RECLASSIFY (8/8). loadFeatures classifies small UNDATED layers into MapboxDraw,
    // and draw copies apply no timeline filter — so a layer imported small-and-undated that gets its
    // dates HERE stayed slider-immune for the rest of the session (CShapes 710 ≤ MAX_DRAW: fills at
    // every date, nothing animating until a reload — the mini gate caught it by pixels). The 7/21
    // rule is "dated layers render via the ENGINE"; re-running the classifier enforces it now that
    // the dates exist, and refreshLayers restores the engine copies' visibility from the checkbox.
    if (node && _drawLayerSlugs[node.id]) {
      try {
        await loadFeatures();
        // Un-hide the engine copies hideDrawnEngineLayers turned off while the layer lived in
        // draw — directly, because refreshLayers keys off a checkbox element that import-made
        // rows don't always carry. Respect the sidebar box when it does exist.
        var vis8 = 'visible';
        try { var cb8 = document.getElementById(node.toggleElement || node.id); if (cb8 && !cb8.checked) vis8 = 'none'; } catch (eCb) {}
        [['left', beforeMap], ['right', (typeof afterMap !== 'undefined' ? afterMap : null)]].forEach(function (pr8) {
          var m8 = pr8[1]; if (!m8) return;
          // -label- added 8/21: this sweep is what an unticked sidebar box runs, and without the
          // label layer in it the LABELS KEPT DRAWING over a layer that had been switched off.
          [node.id + '-' + pr8[0], node.id + '-stroke-' + pr8[0], node.id + '-highlighted-' + pr8[0],
          // companions-ok: a draw-rendered layer has no -edited- overlay to hide.
           node.id + '-label-' + pr8[0]].forEach(function (id8) {
            try { if (m8.getLayer(id8)) m8.setLayoutProperty(id8, 'visibility', vis8); } catch (eV) {}
          });
        });
        var d8 = (typeof editorCurrentDate === 'function') ? editorCurrentDate() : null;
        if (d8 && typeof changeDate === 'function') changeDate(d8);   // apply the current slider date to the freshly-shown engine copies
        window.__msDrawReclass = { slug: node.id, stillDraw: !!_drawLayerSlugs[node.id], vis: vis8, day: d8 };   // read-only breadcrumb (harness + console diagnosis)
      } catch (eRc) { console.warn('draw→engine reclassify after dates failed', eRc); window.__msDrawReclass = { slug: node.id, err: String(eRc).slice(0, 120) }; }
    } else if (node) window.__msDrawReclass = { slug: node.id, skipped: 'not in draw' };
    // AUTO-REBAKE (7/20): a vector-TILE layer renders from its tiles, and the slider filters the tiles'
    // BAKED days — so new dates don't take effect until the tiles re-bake. Do that automatically for
    // THIS layer (background), so the user never has to Publish just to make the timeline filter. Drawn
    // (geojson) layers need no bake — their config rebuilds DayStart/DayEnd from the DB on next load.
    try {
      var didBake = await rebakeLayerTiles(lid, 'Baking the dates into');
      // 8/16: a folded layer no longer refuses — rebakeLayerTiles dispatches the cloud itself and
      // returns 'cloud'. That is NOT "done", so don't tell the user to refresh for tiles that are
      // still baking; the dispatch already started the fold poll that updates the map when it lands.
      if (didBake === 'cloud') { setStatus('Dates saved — tiles rebuilding in the cloud'); }
      else if (didBake) { msProgress('Done — dates baked into the tiles. Refresh the map to see the timeline filter this layer.'); setStatus('Dates baked into tiles'); }
      // A FOLDED layer refuses a local re-bake — artifacts are truth there. But its rows are still
      // present and they now carry the dates, so those artifacts are merely STALE, and the user is
      // left with a timeline that cannot filter AND a table whose date columns are empty, with the
      // only feedback being "re-baking from rows is disabled" (owner 8/15, AtlasHCB). Rebuild them
      // in the cloud from the very rows we just wrote — the same path the importer uses.
      else if (node && (node.fold_state === 'folded' || isTilesetNode(node))) {
        var sentFold = false;
        try { sentFold = await foldImportDispatch(lid, node, { length: upserts.length }); } catch (eFd) { console.warn('cloud re-bake dispatch failed', eFd); }
        if (sentFold) {
          node.fold_state = 'folding'; pollFoldDone(node, lid, node.fold_state === 'folded' ? (node.tilesGeneratedAt || null) : null);
          msProgress('Dates saved. This layer renders from tiles baked BEFORE them, so its tiles and table are rebuilding in the cloud — they update automatically when it finishes (usually a few minutes).');
          setStatus('Dates saved — tiles rebuilding');
        } else {
          msProgress('⚠ Dates ARE saved on every feature, but this layer renders from tiles baked BEFORE them — so the timeline cannot filter it and the table shows the older snapshot until they are rebuilt. The cloud re-bake could not be started; try Publish, or ask for a re-bake.');
          setStatus('Dates saved — tiles stale');
        }
      }
      // 7/21: a small layer that WAS in MapboxDraw is now dated → on next load it re-classifies to
      // engine-rendered (draw copies can't animate). Tell the user the one step that makes it live.
      else if (_drawLayerSlugs[slug]) { msProgress('Dates set on ' + nfmt(upserts.length) + ' features. Refresh the page — dated layers render like the viewer and animate with the timeline.'); }
    } catch (eBake) { console.warn('auto-rebake failed', eBake); msProgress('Dates saved, but the tile re-bake failed (' + (eBake && eBake.message || eBake) + ') — hit Publish to bake them in.'); }
    return upserts.length;
  }
  // Regenerate ONE layer's tiles from its current features (the tiler is lazy-loaded, like import/publish).
  // Shared by the Timeline-dates auto-rebake AND the panel's bake button — far lighter than Publish
  // (sewUpProject), which walks every tiled layer. Returns 'rebaked' | 'converted' | false.
  // 7/21: allowConvert lets the BUTTON first-time bake a live geojson layer to tiles (same proven path);
  // the Timeline-dates auto-rebake passes false — live layers animate without any bake, never convert them.
  async function rebakeLayerTiles(lid, verb, allowConvert) {
    var lrow = await db.from('layers').select('*').eq('id', lid).single();   // * so fold_state rides along pre/post C0
    var L = lrow.data;
    if (!L) return false;
    if (L.fold_state === 'folded') {
      // A REAL folded layer owns no rows anywhere — artifacts are truth, re-bake stays disabled.
      // A folded POINTER COPY (portal-add of a folded source, 8/13: "the 1826-1911 layer is not
      // baked there") has a data root that still owns live rows — bake from those instead.
      var rootOk = false;
      try {
        var rt = await db.rpc('ms_layer_data_root', { p_layer: lid });
        rootOk = !!(rt && !rt.error && rt.data && rt.data !== lid);
      } catch (eRt) {}
      // 8/16 — "I want to rebake now that I added coloring, and it's not letting me." Refusing was
      // right when the BROWSER was the only tiler: a folded layer's rows are too heavy to re-bake
      // in a tab. But the cloud tiler bakes folded layers from rows every day (mode fold-rows),
      // and it now carries the colour-by column and the instant-scrub raster too — so the honest
      // answer is not "disabled", it is "not here, over there". Dispatch it.
      if (!rootOk) {
        var nodeF = null;
        try {
          nodeF = (function find(arr) {
            for (var i = 0; i < (arr || []).length; i++) {
              var n = arr[i];
              if (n.children) { var hit = find(n.children); if (hit) return hit; }
              else if (slugToLayerDbId[n.id] === lid) return n;
            }
            return null;
          })(typeof layers !== 'undefined' ? layers : []);
        } catch (eN) {}
        // WHICH MODE — and this is a SCALING decision, not a correctness one (owner 8/16: "There
        // would be way more people than myself doing this, so I'd think this just won't work").
        //   fold-rows  re-reads EVERY row with its geometry out of Postgres — ~370MB for AtlasHCB.
        //              That is the single most expensive thing this platform can ask of the
        //              database, and N users doing it at once is the real multi-user failure mode.
        //   fold-merge takes the bulk from the R2 artifact and asks Postgres only for delta rows
        //              (92 bytes here). Same output, near-zero database cost.
        // A folded layer ALWAYS has an artifact, so merge is the right path whether or not any
        // edits are pending — with no deltas it simply re-bakes the artifact. fold-rows stays for
        // the first fold, where no artifact exists yet.
        var nDelta = 0;
        try {
          var dq = await db.from('features').select('feature_id', { count: 'exact', head: true })
            .eq('layer_id', lid).not('custom_fields->>ms_foldsrc', 'is', null);
          nDelta = (dq && dq.count) || 0;
        } catch (eDq) {}
        var hasArtifact = !!(L.parquet_key || (L.raw_config && L.raw_config.pmtiles));
        var mode = hasArtifact ? 'fold-merge' : 'fold-rows';
        var sentR = false;
        // reuse the importer's dispatch rather than a second copy of the same POST
        try { sentR = await foldImportDispatch(lid, nodeF || { label: L.name }, { length: (L.raw_config && L.raw_config.tilesFeatureCount) || 0 }, mode); } catch (eD) {}
        if (!sentR) { msProgress('Cloud re-bake could not be started for “' + (L.name || 'layer') + '” — nothing changed, and the current tiles stay live.'); return false; }
        // Persist "a re-bake is in flight" so a RELOAD can still tell the owner it is running.
        // fold_state cannot carry this: a re-bake starts and ends 'folded'.
        var startedAt = new Date().toISOString();
        try {
          var rcMark = L.raw_config || {}; rcMark.rebakeStartedAt = startedAt;
          // If this write is lost, the re-bake still runs but a RELOAD cannot tell the owner it is
          // running — which is the whole point of persisting the marker. Report it.
          await saveSoft(db.from('layers').update({ raw_config: rcMark }).eq('id', lid), 'recording that a re-bake started', { rows: 'some' });
          if (nodeF) nodeF.rebakeStartedAt = startedAt;
        } catch (eMk) { console.warn('could not stamp rebakeStartedAt', eMk); }
        if (nodeF) pollFoldDone(nodeF, lid, (L.raw_config || {}).tilesGeneratedAt || null, startedAt);
        msProgress('“' + (L.name || 'layer') + '” is re-baking in the cloud — tiles, the colour column and the instant-scrub raster'
          + (nDelta ? ', folding in ' + nDelta + ' edited feature' + (nDelta === 1 ? '' : 's') : '')
          + '. It takes several minutes, and the current tiles stay live until the new ones land — the map swaps itself over when they do, with no reload.');
        return 'cloud';
      }
    }
    var isTiled = !!(L.raw_config && L.raw_config.pmtiles);
    if (!isTiled && !(allowConvert && L.source_type === 'geojson-supabase')) return false;
    await loadScript('../platform/tilegen.js?v=' + Date.now());   // MSTileGen isn't on the page until loaded
    if (!(window.MSTileGen && MSTileGen.sewUpLayer)) throw new Error('tiler unavailable');
    msProgress((verb || 'Baking') + ' ' + (L.name || 'the layer') + '’s tiles…');
    var n = await MSTileGen.sewUpLayer(db, projectId, L, function (m) { msProgress(m); }, !isTiled);
    if (!n) return false;   // e.g. zero features — nothing baked
    return isTiled ? 'rebaked' : 'converted';
  }
  async function onRebakeLayer() {
    if (!activeLayerId) return;
    var lid = slugToLayerDbId[activeLayerId]; if (!lid) { setStatus('That layer has no database id'); return; }
    var node = findNodeById(layers, activeLayerId);
    var btn = document.getElementById('elp-rebake'), lbl = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.textContent = '🧩 Baking…'; }
    try {
      var did = await rebakeLayerTiles(lid, 'Baking', true);   // allowConvert: live layers first-time bake here
      if (did === 'cloud') { setStatus('Re-baking in the cloud'); }   // rebakeLayerTiles already said what is happening and why it takes minutes
      else if (did === 'converted') { msProgress('Done — “' + ((node && node.label) || 'layer') + '” baked to tiles. Refresh the page to load the tiled layer.'); setStatus('Baked to tiles'); }
      else if (did) { msProgress('Done — “' + ((node && node.label) || 'layer') + '” re-baked. Refresh the map to see the updated tiles.'); setStatus('Tiles re-baked'); }
      else { setStatus('Nothing to bake for this layer'); }
    } catch (e) { console.warn('rebake failed', e); msProgress('Bake failed: ' + ((e && e.message) || e)); setStatus('Bake failed'); }
    finally { if (btn) { btn.disabled = false; btn.innerHTML = lbl || '🧩 Re-bake this layer&rsquo;s tiles'; } }
  }
  // ── Linked instances (7/21): a second layers row over the SAME data — raw_config.instanceOf points at
  //    the source; geojson instances resolve features through it (configLoader indirection), tiled
  //    instances share the source's tile URL. NO data copies anywhere. Display-only (editable:false):
  //    features and dates are edited on the original; style, visibility, editing-only and
  //    ignore-timeline are all independent per instance.
  async function onCreateInstance() {
    if (!activeLayerId) return;
    var node = findNodeById(layers, activeLayerId); if (!node) return;
    var srcLid = slugToLayerDbId[activeLayerId]; if (!srcLid) { setStatus('That layer has no database id'); return; }
    var btn = document.getElementById('elp-instance'); if (btn) btn.disabled = true;
    setStatus('Creating instance…');
    try {
      var cur = await db.from('layers').select('*').eq('id', srcLid).single();
      if (cur.error || !cur.data) throw new Error(cur.error ? cur.error.message : 'source layer not found');
      var src = cur.data;
      var slug = uid();
      var rc = JSON.parse(JSON.stringify(src.raw_config || {}));
      rc.instanceOf = srcLid;
      rc.editable = false;                        // display-only — the original owns feature editing
      // containerId/toggleElement are DERIVED from the slug at load now — deleting beats
      // re-stamping, because a stored copy is the thing that drifts on the NEXT copy
      delete rc.containerId; delete rc.toggleElement;
      rc.className = slug; rc.topLayerClass = slug;
      delete rc.rasterYears;                      // the source already draws the scrub raster — don't double it
      delete rc.labels;                           // labels can be turned on for the instance explicitly
      delete rc.editorOnly;                       // fresh instance starts fully visible
      var row = {
        slug: slug,
        name: (src.name || 'Layer') + ' (view)',
        type: src.type, color: src.color,
        source_type: src.source_type, source_url: src.source_url, source_layer: src.source_layer,
        source_minzoom: src.source_minzoom, source_maxzoom: src.source_maxzoom,
        paint: src.paint, layout: src.layout,
        hover: src.hover, hover_paint: src.hover_paint, click: src.click,
        popup_style: src.popup_style, popup_prop: src.popup_prop,
        enabled_by_default: true,
        // the CREATOR owns the instance — same rule as copyLayerInto. Carrying the SOURCE's
        // user_id made instancing someone else's layer insert a row you don't own, which
        // layers_insert refuses (and would have billed its storage to them).
        // …and never `|| null`. That fallback is how an ownerless SOURCE produced an ownerless
        // INSTANCE: measured 8/21, the one ownerless layer created in the last 30 days came
        // through here, inheriting null from a source that was itself ownerless in June.
        // Absence is not an owner — refuse rather than write a row nobody owns.
        user_id: userId || src.user_id,
        raw_config: rc
      };
      if (!row.user_id) throw new Error('cannot create an instance with no owner — sign in and try again');
      var ins = await db.from('layers').insert(row).select('id').single();
      if (ins.error) throw new Error(ins.error.message);
      var pl = await db.from('project_layers').select('sort_order, section_id, group_id').eq('project_id', projectId).eq('layer_id', srcLid).limit(1);
      var p0 = (pl.data && pl.data[0]) || {};
      var lk = await db.from('project_layers').insert({ project_id: projectId, layer_id: ins.data.id, sort_order: (p0.sort_order || 0) + 1, section_id: p0.section_id || null, group_id: p0.group_id || null });
      if (lk.error) throw new Error(lk.error.message);
      msProgress('Instance created — reloading to wire it up…');
      setTimeout(function () { location.reload(); }, 600);
    } catch (e) {
      console.warn('instance failed', e); setStatus('Instance failed: ' + ((e && e.message) || e));
      if (btn) btn.disabled = false;
    }
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
    try { await applyDatesToLayer(lid, activeLayerId, node, start, end); }
    catch (e) { console.warn('apply dates failed', e); msProgress(''); setStatus('Dates failed: ' + e.message); }
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
    // Same fill/line/else-circle chain that had drifted in opKeyFor, in a second place: anything
    // whose `type` is not fill or line got circle-opacity, and nine live layers carry a type
    // outside {fill,line,circle} — 6 null, plus "Polygon", "Point", "LineString". Writing the
    // wrong opacity property does nothing at all, silently. Route both through the one function
    // that already asks the map what it actually painted.
    if (kind === 'opacity') return [opKeyFor(node)];
    var t = String((node && node.type) || '').toLowerCase();
    return (t === 'circle' || t === 'point' || t === 'multipoint') ? ['circle-radius'] : ['line-width'];   // thickness: line width / point radius / fill outline width
  }
  function setStyleMetaRC(lid2, key, value) {   // style meta lives in raw_config; saveLayerStyle only carries color+paint
    if (!lid2) return;
    if (value == null) return clearStyleMetaRC(lid2, key);
    var patch = {}; patch[key] = value;
    saveSoft(patchLayerConfig(lid2, patch), 'saving the style setting').then(function () {}, function () {});
  }
  function clearStyleMetaRC(lid2, key) {
    if (!lid2) return;
    var patch = {}; patch[key] = null;   // null deletes the key
    saveSoft(patchLayerConfig(lid2, patch), 'clearing the style setting').then(function () {}, function () {});
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
        var fr = await window.MSFetchRows(db, 'custom_fields', function (q) { return q.eq('layer_id', lid); });
        (fr.rows || []).forEach(function (f) { total++; var v = f.custom_fields ? f.custom_fields[prop] : null; if (v != null && String(v) !== '' && !isNaN(parseFloat(v))) withVal++; });
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
        if (node._dbId) await saveSoft(db.from('layer_groups').update({ checked: on }).eq('id', node._dbId), 'saving the group default');
        var gids = descendantLayerIds(node, on);
        if (gids.length) await saveSoft(db.from('layers').update({ enabled_by_default: on }).in('id', gids), 'saving which layers start switched on');
      } else if (node.type === 'section') {
        if (node._dbId) { var cur = await db.from('layer_sections').select('raw_config').eq('id', node._dbId).single(); var rc = (cur.data && cur.data.raw_config) || {}; rc.checked = on; await saveSoft(db.from('layer_sections').update({ raw_config: rc }).eq('id', node._dbId), 'saving the section default'); }
        var sids = descendantLayerIds(node, on);
        if (sids.length) await saveSoft(db.from('layers').update({ enabled_by_default: on }).in('id', sids), 'saving which layers start switched on');
      } else {
        var lid = slugToLayerDbId[node.id];
        if (lid) await saveSoft(db.from('layers').update({ enabled_by_default: on }).eq('id', lid), 'saving whether this layer starts switched on');
      }
      setStatus('Saved');
    } catch (e) { console.warn('default-visible save failed', e); setStatus('Save failed'); }
  }
  async function onDefaultExpanded(expanded) {
    if (!activeLayerId) return;
    var node = findNodeById(layers, activeLayerId); if (!node) return;
    node.collapsed = !expanded;
    // APPLY IT NOW, not on the next load (8/17). The setting was saving correctly all along — the
    // section renderer ignored it — so the box moved and the panel didn't, which reads as "it's not
    // letting me". Mirrors what the caret's own click does, so the class and the visibility stay in
    // step with sectionCompressExpand / itemsCompressExpand (both branch on the CLASS).
    try {
      var caret = node.caretId ? document.getElementById(node.caretId) : null;
      if (caret) {
        caret.classList.remove(expanded ? 'fa-plus-square' : 'fa-minus-square');
        caret.classList.add(expanded ? 'fa-minus-square' : 'fa-plus-square');
      }
      if (node.type === 'section' && node.containerId) {
        var box = document.getElementById(node.containerId);
        if (box) box.style.display = expanded ? '' : 'none';
      } else if (node.type === 'group' && node.itemSelector) {
        jQuery(node.itemSelector)[expanded ? 'show' : 'hide']();
      }
    } catch (eLive) { console.warn('expand toggle preview failed', eLive); }
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
    // editing-only visibility — leaves carry the flag; a container's checkbox reflects (and cascades
    // to) its descendants: checked when EVERY descendant layer is editing-only (7/21 group support)
    var eoLbl = document.getElementById('elp-editoronly-label');
    if (eoLbl) {
      eoLbl.style.display = 'block';
      var eoOn;
      if (isContainer) {
        var leaves = [];
        (function walk(nn) { (nn.children || []).forEach(function (c) { if (c.type === 'group' || c.type === 'section') walk(c); else leaves.push(c); }); })(node);
        eoOn = leaves.length > 0 && leaves.every(function (c) { return !!c.editorOnly; });
        node.editorOnly = eoOn || undefined;
      } else eoOn = !!node.editorOnly;
      document.getElementById('elp-editoronly').checked = !!eoOn;
    }
  }
  // 7/21: "Only visible while editing" — raw_config.editorOnly; projectLoader strips these from VIEW
  // mode (viewer/preview/downloads all boot through it), the editor shows them + a sidebar badge.
  // SURGICAL row update — a full rerender() collapsed the open group the row lives in (user 7/21).
  function updateEditorOnlyRow(node, rowEl) {
    var row = rowEl || document.querySelector('.layer-list-row[data-node-id="' + node.id + '"]'); if (!row) return;
    var lbl = row.querySelector('label');
    var badge = row.querySelector('.ms-eo-badge');
    if (node.editorOnly) {
      if (lbl) lbl.style.fontStyle = 'italic';   // extra-clear at a glance (user 7/21)
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'ms-eo-badge';
        badge.title = 'Only visible while editing — hidden in view mode';
        badge.innerHTML = '<i class="fas fa-eye-slash"></i>';
        badge.setAttribute('style', 'display:inline-block;margin-left:5px;font-size:10px;color:#b98317;vertical-align:middle;cursor:default;');
        if (lbl) lbl.appendChild(badge); else row.appendChild(badge);
      }
    } else {
      if (lbl) lbl.style.fontStyle = '';
      if (badge) badge.remove();
    }
  }
  // THE FOLD (C3): amber cloud badge while a layer is processing remotely (fold_state='folding').
  // Same surgical pattern as the editing-only badge — never a full rerender from here.
  function updateFoldingRow(node, rowEl) {
    var row = rowEl || document.querySelector('.layer-list-row[data-node-id="' + node.id + '"]'); if (!row) return;
    var lbl = row.querySelector('label');
    var badge = row.querySelector('.ms-folding-badge');
    if (node.fold_state === 'folding') {
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'ms-folding-badge';
        badge.title = 'Processing in the cloud — this layer is being folded to cloud storage';
        badge.innerHTML = '<i class="fas fa-cloud-arrow-up"></i>';
        badge.setAttribute('style', 'display:inline-block;margin-left:5px;font-size:10px;color:#b98317;vertical-align:middle;cursor:default;');
        if (lbl) lbl.appendChild(badge); else row.appendChild(badge);
      }
    } else if (badge) badge.remove();
  }
  async function onEditorOnly(on) {
    if (!activeLayerId) return;
    var node = findNodeById(layers, activeLayerId); if (!node) return;
    var isContainer = node.type === 'group' || node.type === 'section';
    setStatus('Saving…');
    try {
      if (isContainer) {
        // GROUP/SECTION (user 7/21): the whole container is editing-only — cascade the flag onto every
        // descendant LAYER row (the viewer strip works on leaves; a container emptied by the strip is
        // removed too). The container node carries the flag for the UI checkbox state.
        if (on) node.editorOnly = true; else delete node.editorOnly;
        var kids = [];
        (function walk(nn) { (nn.children || []).forEach(function (c) { if (c.type === 'group' || c.type === 'section') { if (on) c.editorOnly = true; else delete c.editorOnly; walk(c); } else { kids.push(c); } }); })(node);
        // nplus1-ok: read-modify-write of each child's raw_config when a group is marked
        // editor-only. Each row's JSON is modified independently, so a batch would have to
        // read them all, merge in JS and write them all back — more moving parts for a
        // user-triggered action on a handful of children. Not a boot path.
        for (var k = 0; k < kids.length; k++) {
          var kn = kids[k], klid = slugToLayerDbId[kn.id]; if (!klid) continue;
          if (on) kn.editorOnly = true; else delete kn.editorOnly;
          await patchLayerConfig(klid, { editorOnly: (on) ? true : null });
          updateEditorOnlyRow(kn);
        }
        updateEditorOnlyRow(node);
        setStatus('Saved');
        return;
      }
      var lid = slugToLayerDbId[activeLayerId]; if (!lid) { setStatus('That layer has no database id'); return; }
      if (on) node.editorOnly = true; else delete node.editorOnly;
      var r = await patchLayerConfig(lid, { editorOnly: (on) ? true : null });
      if (r.error) throw new Error(r.error.message);
      setStatus('Saved');
      updateEditorOnlyRow(node);   // badge + italic in place — group stays open
    } catch (e) { console.warn('editorOnly save failed', e); setStatus('Save failed'); }
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
      '<div id="elp-size" title="Exact stored size of this layer’s data" style="display:none;margin:-1px 0 6px;font-size:11px;color:#6b6580;"></div>' +
      '<div id="elp-kind" class="ms-note-accent" style="display:none;margin:0 0 8px;font-size:11px;"></div>' +   // what IS this layer — tileset vs drawn/imported
      // Re-bake JUST this layer\'s tiles (converted tilesets only) — far lighter than Publish, which re-bakes every layer.
      '<button id="elp-rebake" style="display:none;width:100%;box-sizing:border-box;margin:0 0 8px;padding:6px 10px;border:1px solid #cdbff0;border-radius:6px;background:#f2ecff;color:#5b4b9a;font:600 12px Source Sans Pro,Arial,sans-serif;cursor:pointer;" title="Regenerate ONLY this layer\'s tiles from its current data — much lighter than Publish, which re-bakes every layer">🧩 Re-bake this layer&rsquo;s tiles</button>' +
      // 7/21: live layers get the same button as a first-time "Bake to tiles" (optional — they need no bake)
      '<div id="elp-rebake-note" class="ms-note" style="display:none;margin:-4px 0 8px;">Live layer — it updates and animates instantly, no baking needed. Bake only if it&rsquo;s very large and slow.</div>' +
      // 7/21: linked instances — a second layer over the SAME data, styled independently (no data copy)
      '<div id="elp-instance-note" class="ms-note-accent" style="display:none;margin:0 0 8px;">⧉ Linked instance — shares another layer&rsquo;s data. Style it independently here; edit features and dates on the original layer.</div>' +
      '<button id="elp-instance" style="display:none;width:100%;box-sizing:border-box;margin:0 0 8px;padding:6px 10px;border:1px solid #bfd8f0;border-radius:6px;background:#ecf4ff;color:#2b5b8a;font:600 12px Source Sans Pro,Arial,sans-serif;cursor:pointer;" title="Create a linked copy of this layer that shares its data (no duplication) but can be styled independently — e.g. an always-on \'all data\' view next to the timeline-filtered one">⧉ Create linked instance</button>' +
      // ── on-by-default + delete live AT THE TOP (below the title), no section heading — 7/8 layout pass ──
      '<button id="elp-order" style="width:100%;box-sizing:border-box;margin:0 0 8px;padding:6px 10px;border:1px solid #d7d3e4;border-radius:6px;background:#f4f2fa;color:#544f6e;font:600 12px Source Sans Pro,Arial,sans-serif;cursor:pointer;" title="Change which layers draw on top of which — a flat list of every layer, independent of the sections and groups in the sidebar">☰ Layer order…</button>' +
      '<div id="elp-defaults-row">' +
        '<label id="elp-default-vis-label" class="ms-check" style="margin-bottom:3px;"><input id="elp-default-vis" type="checkbox" style="vertical-align:middle;margin:0 5px 0 0;" />On by default</label>' +
        '<label id="elp-default-exp-label" class="ms-check" style="display:none;"><input id="elp-default-exp" type="checkbox" style="vertical-align:middle;margin:0 5px 0 0;" />Expanded by default</label>' +
        // 7/21: editing-only layers — shown here in the editor, stripped from VIEW mode (viewer/preview/downloads)
        '<label id="elp-editoronly-label" class="ms-check" style="margin-bottom:3px;" title="Show this layer only in editing mode — viewers never see it"><input id="elp-editoronly" type="checkbox" style="vertical-align:middle;margin:0 5px 0 0;" />Only visible while editing</label>' +
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
      // "Labeled vs unlabeled" (binary category): two swatches, live preview (see onColorBy → __present__)
      '<div id="elp-binary-strip" style="display:none;margin-bottom:8px;">' +
        '<div style="display:flex;gap:9px;align-items:center;margin-bottom:5px;"><input id="elp-bin-present" type="color" class="ms-color" style="height:28px;width:46px;padding:0;" /><span class="ms-note" style="margin:0;">Labeled (has a value)</span></div>' +
        '<div style="display:flex;gap:9px;align-items:center;"><input id="elp-bin-absent" type="color" class="ms-color" style="height:28px;width:46px;padding:0;" /><span class="ms-note" style="margin:0;">Unlabeled (blank)</span></div>' +
      '</div>' +
      '<div id="elp-colorby-row" style="margin:0 0 8px;display:none;">' +
        '<label class="ms-lbl">Color by data column</label>' +
        '<select id="elp-colorby" class="ms-in"><option value="">Single color</option></select>' +
        '<div id="elp-colorby-info" class="ms-note"></div>' +
      '</div>' +
      // legend (experiment): show this layer's colors in an on-map box
      '<label id="elp-legend-row" class="ms-check" style="margin:2px 0 8px;display:block;"><input id="elp-legend-on" type="checkbox" style="vertical-align:middle;margin:0 5px 0 0;" />Show legend on the map</label>' +
      // style categories nested under the layer in the sidebar, each toggleable like a layer
      '<label id="elp-stylerows-row" class="ms-check" style="margin:2px 0 8px;display:block;"><input id="elp-stylerows-on" type="checkbox" style="vertical-align:middle;margin:0 5px 0 0;" />Show style categories under the layer</label>' +
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
      // (8/14) borders that follow the fill's colours — the ask was for coloured divisions without
      // hand-matching every category. Lives with the fill, so it works BEFORE any outline split,
      // and a later split inherits it.
      '<label id="elp-outline-match-row" class="ms-check" style="display:none;margin:4px 0 0;"><input id="elp-outline-match" type="checkbox" style="vertical-align:middle;margin:0 3px 0 0;" />Match fill colors</label>' +
      '<div id="elp-width-row" style="margin-top:6px;"><label class="ms-lbl"><span id="elp-width-label">Width</span> <span id="elp-width-val"></span></label>' +
      '<input id="elp-width" type="range" min="0.5" max="12" step="0.5" class="ms-range" /></div>' +
      // (8/14) sideways offset — "colored offset borders tend to be a great way to show divisions":
      // shifts the line off the shared edge so two bordering features' colours both stay readable.
      // Engine-rendered lines only (MapboxDraw's fixed styles can't offset).
      '<div id="elp-offset-row" style="margin-top:6px;display:none;"><label class="ms-lbl" title="Shift the line sideways from the edge it traces — 0 sits on the edge">Offset <span id="elp-offset-val"></span></label>' +
      '<input id="elp-offset" type="range" min="-10" max="10" step="0.5" class="ms-range" /></div>' +
      // 7/21: zoom-varied line width — checkbox expands 3 zoom→px stops (interpolate); unchecked = the uniform slider above
      '<div id="elp-wzoom-row" style="margin-top:4px;display:none;">' +
        '<label class="ms-check" title="Line width follows the zoom level (thin when zoomed out, thick when zoomed in)"><input id="elp-wzoom-on" type="checkbox" style="vertical-align:middle;margin:0 5px 0 0;" />Vary width by zoom</label>' +
        '<div id="elp-wzoom-box" style="display:none;margin:4px 0 2px;padding:6px 8px;border:1px solid #e2e2e2;border-radius:5px;background:#fafafa;">' +
          [0, 1, 2].map(function (wi) {
            return '<div style="display:flex;gap:6px;align-items:center;margin:2px 0;"><span class="ms-note" style="margin:0;">at zoom</span>' +
              '<input id="elp-wz-z' + wi + '" type="number" min="0" max="22" step="1" class="ms-in" style="width:56px;" />' +
              '<span class="ms-note" style="margin:0;">&rarr;</span>' +
              '<input id="elp-wz-w' + wi + '" type="number" min="0" max="40" step="0.5" class="ms-in" style="width:64px;" />' +
              '<span class="ms-note" style="margin:0;">px</span></div>';
          }).join('') +
        '</div>' +
      '</div>' +
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
      '<label class="ms-check" id="elp-tablebtn-row" style="display:block;margin-top:4px;"><input id="elp-tablebtn" type="checkbox" style="vertical-align:middle;margin:0 5px 0 0;" />Table button (&#9638;) shown in view mode</label>' +
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
      // ── MAKE FASTER (8/17) — speed is OPT-IN now. Owner: "let's make baking optional, not
      //    automatic … baking takes a lot of time often, and it has to be redone." So the default is
      //    the engine's own scrub: always exact, always animated, no waiting. These two are
      //    accelerators the owner switches on per LAYER once they decide the trade is worth it —
      //    per layer, not per map, so one huge layer can't drag the small ones into deck's limits.
      //    Deliberately NOT gated on capability: the owner ruled that partial rendering is their
      //    call ("It's okay if it only partially renders … speed sometimes matters more than not
      //    seeing some things right while doing the slider"), so the Explain popup discloses and
      //    the checkbox still offers.
      '<div id="elp-fast-sec" class="' + SECTOP + '" style="display:none;">' +
      SEC('Make Faster') +
      '<div class="ms-note" style="margin:0 0 7px;">Only affects how this layer draws <b>while you drag the time slider</b>. Both off = normal drawing, always exact.</div>' +
      '<button id="elp-fast-explain" class="ms-btn" style="margin-bottom:9px;">💡 Explain&hellip; <span style="font-weight:400;color:#888;">(options &amp; limits)</span></button>' +
      '<label class="ms-check" style="margin-bottom:1px;" title="Scrub a pre-rendered picture of every year — the fastest option, and it costs the same on every device"><input id="elp-fast-raster" type="checkbox" style="vertical-align:middle;margin:0 5px 0 0;" />Baked snapshot</label>' +
      '<div id="elp-fast-raster-note" class="ms-note" style="margin:0 0 7px;"></div>' +
      '<button id="elp-fast-bake" class="ms-btn" style="margin-bottom:9px;">🔥 Bake snapshot</button>' +
      '<label class="ms-check" style="margin-bottom:1px;" title="Draw this layer\'s real shapes on the graphics card while dragging — nothing to bake, but some styling is approximated"><input id="elp-fast-deck" type="checkbox" style="vertical-align:middle;margin:0 5px 0 0;" />Graphics-card preview</label>' +
      '<div id="elp-fast-deck-note" class="ms-note" style="margin:0 0 4px;"></div>' +
      '<div id="elp-fast-status" class="ms-note-accent" style="display:none;margin-top:6px;"></div>' +
      '</div>' +
      // ── TIMELINE DATES — moved to the BOTTOM of the panel (user 7/20). Maps a data column (or one
      //    fixed date) into every feature's Start/End (what the timeline slider filters on); shown by
      //    fillDateSection for any layer with DB rows. Applying auto-rebakes tiled layers.
      '<div id="elp-dates-sec" class="' + SECTOP + '" style="display:none;">' +
      SEC('Timeline dates') +
      // 7/21: opt this layer out of the slider entirely — e.g. an instance used as the "all data at once" view
      '<label class="ms-check" style="margin-bottom:6px;" title="This layer always shows every feature — the timeline slider never filters it"><input id="elp-tlignore" type="checkbox" style="vertical-align:middle;margin:0 5px 0 0;" />Ignore the timeline (always show everything)</label>' +
      '<div id="elp-dates-tools">' +   // 7/21: instances hide the column-mapping tools (dates live on the original) but keep the ignore checkbox above
      '<label class="ms-lbl">Start date from</label>' +
      '<select id="elp-date-start-col" class="ms-in"><option value="">— don\'t change —</option><option value="__fixed">⏱ One fixed date for all…</option></select>' +
      '<input id="elp-date-start-fixed" type="date" class="ms-in" style="display:none;margin-top:3px;" />' +
      '<label class="ms-lbl" style="margin-top:6px;">End date from</label>' +
      '<select id="elp-date-end-col" class="ms-in"><option value="">— don\'t change —</option><option value="__fixed">⏱ One fixed date for all…</option></select>' +
      '<input id="elp-date-end-fixed" type="date" class="ms-in" style="display:none;margin-top:3px;" />' +
      '<button id="elp-dates-apply" class="ms-btn" style="margin-top:8px;">Apply to all features</button>' +
      '<div class="ms-note">Fills each feature\'s <b>Start/End</b> (what the timeline slider filters on) from a data column — or one fixed date for every feature. Years like "1877" become 1877-01-01 for starts and 1877-12-31 for ends.</div>' +
      '</div>' +
      '</div>' +
      '</div>';   // close #elp-body (the scrolling region under the sticky header)
    document.body.appendChild(p);
    document.getElementById('elp-close').addEventListener('click', hideLayerPanel);
    document.getElementById('elp-order').addEventListener('click', function () {
      // highlighted so you can see where the layer you were editing currently sits (owner 8/18)
      if (window.MSLayerOrder) MSLayerOrder.open(activeLayerId || activeGroupId || null);
    });
    document.getElementById('elp-rebake').addEventListener('click', onRebakeLayer);
    document.getElementById('elp-instance').addEventListener('click', onCreateInstance);
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
    document.getElementById('elp-editoronly').addEventListener('change', function () { onEditorOnly(this.checked); });
    document.getElementById('elp-color').addEventListener('input', function () { onLayerStyle('color', this.value); });
    document.getElementById('elp-colorby').addEventListener('change', function () { onColorBy(this.value); });
    document.getElementById('elp-bin-present').addEventListener('input', livePresenceColors);   // live preview while dragging the picker
    document.getElementById('elp-bin-absent').addEventListener('input', livePresenceColors);
    document.getElementById('elp-bin-present').addEventListener('change', savePresenceColors);   // commit on release
    document.getElementById('elp-bin-absent').addEventListener('change', savePresenceColors);
    document.getElementById('elp-legend-on').addEventListener('change', function () { onToggleLegend(this.checked); });
    document.getElementById('elp-stylerows-on').addEventListener('change', function () { onToggleStyleRows(this.checked); });
    document.getElementById('elp-opacityby').addEventListener('change', function () { onStyleNumBy('opacity', this.value); });
    document.getElementById('elp-thickby').addEventListener('change', function () { onStyleNumBy('thickness', this.value); });
    document.getElementById('elp-maplabels-on').addEventListener('change', onMapLabelsChange);
    document.getElementById('elp-maplabels-field').addEventListener('change', onMapLabelsChange);
    ['elp-lbl-color', 'elp-lbl-halo', 'elp-lbl-bold', 'elp-lbl-density'].forEach(function (id2) { document.getElementById(id2).addEventListener('change', onMapLabelsChange); });
    document.getElementById('elp-lbl-zoomsizes').addEventListener('change', onMapLabelsChange);   // delegated: stop rows are dynamic (renderLblStops)
    document.getElementById('elp-lbl-help').addEventListener('click', function (e) { e.preventDefault(); openLabelsHelp(); });
    document.getElementById('elp-fast-explain').addEventListener('click', function (e) { e.preventDefault(); openFastHelp(); });
    document.getElementById('elp-fast-raster').addEventListener('change', function () { onFastToggle('raster', this.checked); });
    document.getElementById('elp-fast-deck').addEventListener('change', function () { onFastToggle('deck', this.checked); });
    document.getElementById('elp-fast-bake').addEventListener('click', onBakeSnapshot);
    // timeline dates: "Fixed date…" picks reveal their date input; Apply runs the bulk mapping
    [['elp-date-start-col', 'elp-date-start-fixed'], ['elp-date-end-col', 'elp-date-end-fixed']].forEach(function (pr9) {
      document.getElementById(pr9[0]).addEventListener('change', function () { var f9 = document.getElementById(pr9[1]); if (f9) f9.style.display = this.value === '__fixed' ? '' : 'none'; });
    });
    document.getElementById('elp-dates-apply').addEventListener('click', onApplyDates);
    document.getElementById('elp-tlignore').addEventListener('change', function () { onTlIgnore(this.checked); });
    document.getElementById('elp-lbl-halow').addEventListener('input', function () { var v = document.getElementById('elp-lbl-halow-val'); if (v) v.textContent = this.value; });
    document.getElementById('elp-lbl-halow').addEventListener('change', onMapLabelsChange);
    document.getElementById('elp-opacity').addEventListener('input', function () { document.getElementById('elp-opacity-val').textContent = this.value; onLayerStyle('opacity', parseFloat(this.value)); });
    document.getElementById('elp-outline').addEventListener('input', function () { onLayerStyle('outline', this.value); });
    document.getElementById('elp-outline-match').addEventListener('change', function () { onLayerStyle('outlineMatch', this.checked); });
    document.getElementById('elp-width').addEventListener('input', function () { document.getElementById('elp-width-val').textContent = this.value; onLayerStyle('width', parseFloat(this.value)); });
    document.getElementById('elp-offset').addEventListener('input', function () { document.getElementById('elp-offset-val').textContent = this.value; onLayerStyle('offset', parseFloat(this.value)); });
    document.getElementById('elp-wzoom-on').addEventListener('change', onWzoom);
    [0, 1, 2].forEach(function (wi) { ['elp-wz-z' + wi, 'elp-wz-w' + wi].forEach(function (wid) { document.getElementById(wid).addEventListener('input', function () { if (document.getElementById('elp-wzoom-on').checked) onWzoom(); }); }); });
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
    document.getElementById('elp-tablebtn').addEventListener('change', function () { onTableBtnToggle(this.checked); });
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
      var r = await patchLayerConfig(lid, { panel: { mode: mode } });   // merge-patch keeps panel's other keys
      if (r.error) throw new Error(r.error.message);
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
    removeMapLayers(node.id); renderTilesetOnMap(node);   // re-render with the new source (wide removal; re-add complete 8/25)
    try { applyLabelLayers(node); } catch (eLb2) {}
    try { refreshEditedOverlay(node); } catch (eOv2) {}
    _engineEditWired[node.id] = false; wireEngineEditClicks();   // re-attach click→edit (removeLayer dropped the old handler)
    if (typeof refreshLayers === 'function') refreshLayers();
    showLayerPanel(activeLayerId);
  }
  // ── Your columns (Map Portal 5b) — helpers for the panel section ──────────
  function ovRenderChips(node) {
    var box = document.getElementById('elp-ov-chips'); if (!box) return;
    var cols = node.overlayCols || [];
    box.innerHTML = cols.length
      ? cols.map(function (c) { return '<span style="display:inline-block;margin:0 4px 4px 0;padding:2px 9px;background:#efeaf8;border:1px solid #d9cff1;border-radius:12px;font-size:11px;color:#4a3670;">' + String(c).replace(/[<>&]/g, '') + '</span>'; }).join('')
      : '<span style="color:#9a94ad;font-size:11px;">none yet</span>';
    var editBtn = document.getElementById('elp-ov-edit');
    if (editBtn) editBtn.style.display = cols.length ? 'inline-block' : 'none';
  }
  async function ovAddColumn() {
    var node = activeLayerId && findNodeById(layers, activeLayerId); if (!node) return;
    var lid = slugToLayerDbId[node.id]; if (!lid) return;
    var inp = document.getElementById('elp-ov-newcol');
    var name = ((inp && inp.value) || '').trim().replace(/[^\w -]/g, '').slice(0, 40);
    if (!name) return;
    var cols = (node.overlayCols || []).slice();
    if (cols.indexOf(name) > -1) { setStatus('Column exists'); return; }
    cols.push(name);
    setStatus('Saving…');
    var r = await patchLayerConfig(lid, { overlayCols: cols });
    if (r.error) { setStatus('Save failed: ' + r.error.message); return; }
    node.overlayCols = cols;
    if (inp) inp.value = '';
    ovRenderChips(node);
    populateColorBy(node);   // the new column appears in every styling dropdown immediately
    setStatus('Saved');
  }
  async function ovToggleTable() {
    var node = activeLayerId && findNodeById(layers, activeLayerId); if (!node) return;
    var lid = slugToLayerDbId[node.id]; if (!lid) return;
    var box = document.getElementById('elp-ov-table'); if (!box) return;
    if (box.style.display !== 'none') { box.style.display = 'none'; return; }
    var cols = node.overlayCols || []; if (!cols.length) return;
    // rows = the LIVE source data (a mirror renders its source's features; ids are the source's)
    var feats = [];
    try { var src = (typeof beforeMap !== 'undefined' && beforeMap) ? beforeMap.getSource(node.id + '-left') : null; if (src && src._data) feats = src._data.features || []; } catch (e) {}
    if (!feats.length) { box.style.display = 'block'; box.innerHTML = '<div style="padding:8px;color:#9a94ad;">No features loaded yet — toggle the layer on first.</div>'; return; }
    var values = window.MSOverlay ? await MSOverlay.load(lid) : {};
    var cap = 200;
    // The rows past the cap are not rendered, so their values cannot be entered — and the table
    // gives no sign that it is showing a slice.
    if (window.MSGuard) MSGuard.cliff('overlay-column-editor', feats.length, cap,
      'this editor is showing only the first ' + cap + ' features, so values cannot be entered for the rest here');
    var html = '<table style="width:100%;border-collapse:collapse;font-size:11.5px;">'
      + '<tr><th style="text-align:left;padding:4px 6px;color:#9083ad;">feature</th>'
      + cols.map(function (c) { return '<th style="text-align:left;padding:4px 6px;color:#9083ad;">' + String(c).replace(/[<>&]/g, '') + '</th>'; }).join('') + '</tr>';
    feats.slice(0, cap).forEach(function (f) {
      var fid = f.id != null ? f.id : (f.properties || {}).feature_id; if (fid == null) return;
      var v = values[String(fid)] || {};
      html += '<tr><td style="padding:3px 6px;border-top:1px solid #f1eef8;max-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + String((f.properties || {}).label || fid).replace(/[<>&]/g, '') + '</td>'
        + cols.map(function (c) { return '<td style="padding:2px 4px;border-top:1px solid #f1eef8;"><input data-ovfid="' + fid + '" data-ovcol="' + String(c).replace(/"/g, '') + '" value="' + String(v[c] != null ? v[c] : '').replace(/"/g, '&quot;') + '" style="width:70px;font-size:11px;padding:2px 4px;border:1px solid #ddd;border-radius:3px;box-sizing:border-box;"></td>'; }).join('')
        + '</tr>';
    });
    html += '</table>' + (feats.length > cap ? '<div style="padding:5px 6px;color:#9a94ad;">first ' + cap + ' of ' + feats.length + ' features shown</div>' : '');
    box.innerHTML = html; box.style.display = 'block';
    box.querySelectorAll('input[data-ovfid]').forEach(function (cell) {
      cell.addEventListener('change', async function () {
        var val = cell.value.trim();
        var num = (val !== '' && !isNaN(Number(val))) ? Number(val) : val;   // numbers stay numbers (styling ramps)
        setStatus('Saving…');
        var r2 = await MSOverlay.set(lid, Number(cell.getAttribute('data-ovfid')), cell.getAttribute('data-ovcol'), val === '' ? null : num);
        if (r2 && r2.error) { setStatus('Save failed: ' + r2.error.message); return; }
        setStatus('Saved');
        MSOverlay.refreshAll();   // live: popups + color-by read the value immediately
      });
    });
  }
  function showLayerPanel(slug) {
    var node = findNodeById(layers, slug); if (!node) return;
    var isGeojson = node.source_type === 'geojson-supabase';   // split is drawn-layer only
    var fillStroke = (isGeojson || isTilesetNode(node)) && node.type === 'fill';  // drawn AND tileset fills get the real line outline + its width/show toggles
    injectLayerPanel();
    var p = document.getElementById('editor-layer-panel'); if (!p) return;
    // sections/dividers have no layer config — layerJson.js hides its "{ } JSON" chip off this stamp
    p.setAttribute('data-ms-kind', (node.type === 'section' || node.type === 'group') ? 'container' : 'layer');
    try { if (window._msLayerJsonSync) window._msLayerJsonSync(); } catch (e) {}
    try { if (window._elpDelReset) window._elpDelReset(); } catch (e) {}   // switching items collapses a half-open delete confirm
    var elpName = document.getElementById('elp-name'); if (elpName) elpName.value = node.label || '';   // top name field — all node types
    var elpSz = document.getElementById('elp-size'); if (elpSz) elpSz.style.display = 'none';   // shown per-leaf by fillLayerSize
    var elpDsz = document.getElementById('elp-divsize'); if (elpDsz) elpDsz.style.display = 'none';   // divider-only size row
    if (node.type !== 'section' && node.type !== 'group') fillLayerSize(node);
    // ── containers must RESET the per-layer dynamic chrome (8/13, "when I click a divider,
    //    it shows stuff from the previous layer") — these are toggled per-LAYER further down,
    //    so the section/group/divider early-returns left whatever the last layer showed:
    //    kind note, re-bake, dataset chip, instance button/notes, dates section, size picker.
    if (node.type === 'section' || node.type === 'group') {
      ['elp-kind', 'elp-rebake', 'elp-rebake-note', 'elp-instance', 'elp-instance-note', 'elp-dataset', 'elp-dataset-fork', 'elp-dates-sec', 'elp-fast-sec', 'elp-divsize']
        .forEach(function (eid) { var el = document.getElementById(eid); if (el) el.style.display = 'none'; });
    }
    if (node.type === 'section') {   // #4: sections get a minimal panel — title + defaults + Delete (no style/zoom)
      document.getElementById('elp-title').textContent = node.label || (node.msDivider ? 'Divider' : 'Section');
      document.getElementById('elp-style-section').style.display = 'none';
      ['elp-labels-sec', 'elp-interact-row', 'elp-enc-row', 'elp-src-row', 'elp-panel-row', 'elp-zoom-sec'].forEach(function (eid) { var el = document.getElementById(eid); if (el) el.style.display = 'none'; });
      // sections/dividers have no ℹ popup — hide the whole Layer info section (re-shown per layer)
      var infS = document.getElementById('elp-info'); if (infS && infS.closest) { var iw = infS.closest('.ms-sectop'); if (iw) iw.style.display = 'none'; }
      if (!node.msDivider) populateDefaults(node);   // a divider has no checkbox — visibility defaults don't apply
      else {
        var ddr = document.getElementById('elp-defaults-row'); if (ddr) ddr.style.display = 'none';   // and hide the previous item's defaults row
        showDividerSizeRow(node);   // the divider's ONLY controls: text (above) + size + Delete
      }
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
    var labelsCapable = isGeojson || (isTilesetNode(node) && ['line', 'fill', 'circle'].indexOf(node.type) > -1);   // 8/7: every tileset type labels off its own vector source (labels.js)
    document.getElementById('elp-labels-sec').style.display = labelsCapable ? '' : 'none';
    // Instance mode (Map Portal, 8/5): a LOCKED mirror presents the source exactly as the source
    // styles it — the style/label/interaction controls are hidden, with one line saying why.
    // (Linked mode keeps them all: their data, your styling.)
    var lockNote = document.getElementById('elp-stylelock-note');
    if (!lockNote) {
      lockNote = document.createElement('div');
      lockNote.id = 'elp-stylelock-note';
      lockNote.style.cssText = 'display:none;margin:6px 0;padding:7px 9px;background:#f3eefc;border:1px solid #d9cff1;border-radius:6px;font-size:12px;color:#4a3670;';
      lockNote.textContent = '🔒 Locked mirror — this layer follows its source\'s styling, so it changes whenever the source does. To style it yourself instead, delete it and re-add it from the Portal in Linked mode.';
      var ss0 = document.getElementById('elp-style-section');
      if (ss0 && ss0.parentNode) ss0.parentNode.insertBefore(lockNote, ss0);
    }
    if (node.styleLocked) {
      lockNote.style.display = 'block';
      document.getElementById('elp-style-section').style.display = 'none';
      document.getElementById('elp-interact-row').style.display = 'none';
      document.getElementById('elp-labels-sec').style.display = 'none';
    } else lockNote.style.display = 'none';
    // Tombstone (Map Portal step 6): a mirror whose SOURCE layer is gone renders empty — say so
    // instead of silence. Only instanceOf mirrors can die this way; tiled/folded pointers keep
    // rendering from R2 (the sweeper's refcount protects those files). "Gone" and "made private"
    // are indistinguishable from here, so the note says "unavailable".
    var dsNote = document.getElementById('elp-deadsource-note');
    if (!dsNote) {
      dsNote = document.createElement('div');
      dsNote.id = 'elp-deadsource-note';
      dsNote.style.cssText = 'display:none;margin:6px 0;padding:7px 9px;background:#fdeaea;border:1px solid #f2c4c0;border-radius:6px;font-size:12px;color:#8f3a31;';
      dsNote.textContent = '⚠ Source unavailable — the layer this mirror follows was removed or made private, so it renders empty. You can delete this layer, or ask the source\'s owner.';
      var ss1 = document.getElementById('elp-style-section');
      if (ss1 && ss1.parentNode) ss1.parentNode.insertBefore(dsNote, ss1);
    }
    dsNote.style.display = 'none';
    if (node.instanceOf) {
      (function (noteEl, srcLid, forSlug) {
        db.from('layers').select('id').eq('id', srcLid).maybeSingle().then(function (r) {
          // still the same panel? (user may have clicked another layer while we checked)
          if (activeLayerId === forSlug && !r.error && !r.data) noteEl.style.display = 'block';
        }).catch(function () {});
      })(dsNote, node.instanceOf, node.id);
    }
    // ── Your columns (Map Portal 5b): a Linked mirror follows its source's geometry + columns
    //    read-only — but the placement owner can ADD columns of their own. The list lives on this
    //    row (raw_config.overlayCols); values in layer_overlay via MSOverlay; the styling
    //    dropdowns above include them, so "color by my column" just works. ──
    var ovSec = document.getElementById('elp-overlay-sec');
    if (!ovSec) {
      ovSec = document.createElement('div');
      ovSec.id = 'elp-overlay-sec';
      ovSec.style.cssText = 'display:none;margin:8px 0;padding:8px 9px;background:#f7f5fc;border:1px solid #e2dbf3;border-radius:6px;font-size:12px;';
      ovSec.innerHTML = '<b style="font-size:12px;color:#4a3670;">Your columns</b>'
        + '<div style="font-size:11px;color:#8a83a0;margin:2px 0 6px;">The source\'s data stays theirs — these columns are yours, saved on your map, stylable like any other.</div>'
        + '<div id="elp-ov-chips" style="margin-bottom:6px;"></div>'
        + '<div style="display:flex;gap:6px;"><input id="elp-ov-newcol" class="ms-in" placeholder="new column name" style="flex:1;min-width:0;">'
        + '<button id="elp-ov-add" class="ms-btn" style="white-space:nowrap;">+ Add</button></div>'
        + '<button id="elp-ov-edit" class="ms-btn" style="margin-top:6px;display:none;">✎ Edit values</button>'
        + '<div id="elp-ov-table" style="display:none;max-height:220px;overflow:auto;margin-top:6px;border:1px solid #e2dbf3;border-radius:5px;background:#fff;"></div>';
      var ss2 = document.getElementById('elp-style-section');
      if (ss2 && ss2.parentNode) ss2.parentNode.insertBefore(ovSec, ss2);
      document.getElementById('elp-ov-add').addEventListener('click', function () { ovAddColumn(); });
      document.getElementById('elp-ov-edit').addEventListener('click', function () { ovToggleTable(); });
    }
    var isLinkedMirror = !!(node.instanceOf && !node.styleLocked);
    ovSec.style.display = isLinkedMirror ? 'block' : 'none';
    document.getElementById('elp-ov-table').style.display = 'none';
    if (isLinkedMirror) ovRenderChips(node);
    fillFastSection(node);   // Make Faster: the two per-layer scrub accelerators + their freshness
    fillDateSection(node);   // Timeline dates: async sample reveals the section for any layer with DB rows (incl. converted tilesets)
    document.getElementById('elp-zoom-info').textContent = fmtNodeZoom(node);
    var color = (node.iconColor && /^#[0-9a-fA-F]{6}$/.test(node.iconColor)) ? node.iconColor : '#3bb2d0';
    var op = paintOpacity(node.paint); if (op == null) op = (node.type === 'fill') ? 0.35 : 1;
    var outline = paintOutline(node.paint) || (node.type === 'fill' ? color : '#000000');
    document.getElementById('elp-title').textContent = node.label || 'Layer style';
    // what IS this layer? (user 7/15: the panel must say tileset vs drawn/GIS)
    var kindEl = document.getElementById('elp-kind');
    var tiles0 = (node.source && node.source.tiles && node.source.tiles[0]) || node.source_url || '';
    var isConvertedTs = !!(node.pmtiles || tiles0.indexOf('/pmt/') > -1 || /^pmt\//.test(tiles0));   // OUR generated tiles → re-bakeable
    if (kindEl) {
      // WHAT IS THIS LAYER — every provenance, not just the original three (owner 8/20: "Should
      // also mention in the panel what type it is — we've only done portal added stuff for this").
      // The folded state rides along explicitly, because it is the one that silently changes what
      // the user can DO (tables read the archive snapshot; per-feature editing is off).
      var kt = '';
      if (node.instanceOf) kt = '🔗 Linked instance — mirrors its source layer’s features (edit the original)';
      else if (node.outlineOf) { var _op = findNodeById(layers, node.outlineOf); kt = '〰 Outline layer — draws the borders of “' + ((_op && _op.label) || node.outlineOf) + '”'; }
      else if (node.source_type === 'geojson-supabase') kt = '✏️ Drawn / imported layer — editable features';
      else if (isConvertedTs) kt = '🧩 Tileset — auto-generated from your data (features editable in the table)';
      else if (isTilesetNode(node)) kt = '🧩 Vector tileset — external source (features live in the remote tiles)';
      if (node._msCopyOf && kt) kt += ' · copy';
      if (node.fold_state === 'folded') kt += (kt ? ' · ' : '') + '📦 FOLDED — feature rows are archived (tables read the archive snapshot; per-feature editing is off)';
      kindEl.textContent = kt; kindEl.style.display = kt ? 'block' : 'none';
    }
    // 7/21 universal bake: tiled layers RE-bake; live geojson layers can FIRST-TIME bake (optional —
    // they animate/update instantly without tiles, the note says so). Outline companions excluded.
    var isLiveGj = node.source_type === 'geojson-supabase' && !node.outlineOf && !node.instanceOf;
    var rebakeBtn = document.getElementById('elp-rebake'), rebakeNote = document.getElementById('elp-rebake-note');
    if (rebakeBtn) {
      // instances NEVER bake — a bake reads features by the instance's own id (none) and would write empty tiles
      rebakeBtn.style.display = ((isConvertedTs && !node.instanceOf) || isLiveGj) ? 'block' : 'none';
      rebakeBtn.innerHTML = isConvertedTs ? '🧩 Re-bake this layer&rsquo;s tiles' : '🧩 Bake this layer to tiles';
      rebakeBtn.title = isConvertedTs
        ? 'Regenerate ONLY this layer\'s tiles from its current data — much lighter than Publish, which walks every layer'
        : 'Convert this live layer to tiles (speed for very large data). Live layers update & animate instantly without baking.';
    }
    if (rebakeNote) rebakeNote.style.display = (isLiveGj && !isConvertedTs) ? 'block' : 'none';
    // 7/21 linked instances: create-button on real data layers; explainer note on instances themselves
    var instBtn = document.getElementById('elp-instance'), instNote = document.getElementById('elp-instance-note');
    if (instBtn) instBtn.style.display = ((isConvertedTs || node.source_type === 'geojson-supabase') && !node.instanceOf && !node.outlineOf) ? 'block' : 'none';
    // "Style it independently here" is true of a LINKED mirror only — on a locked one it sat
    // directly above the lock note saying the opposite (owner 8/7, both visible at once)
    if (instNote) instNote.style.display = (node.instanceOf && !node.styleLocked) ? 'block' : 'none';
    // Datasets (8/10): the "Register as dataset" button lives in platform/datasets.js, which owns
    // its own show/hide (admins only, real data layers only — companions inherit their parent's id).
    // Injected rather than templated because injectLayerPanel() runs once and never rebuilds.
    try { if (window.MSDatasets) MSDatasets.onLayerPanel(node); } catch (eDs) {}
    document.getElementById('elp-color').value = color;
    var legOn = document.getElementById('elp-legend-on'); if (legOn) legOn.checked = !!node.legend;
    var srOn = document.getElementById('elp-stylerows-on'); if (srOn) srOn.checked = !!node.styleRows;
    populateColorBy(node);   // "Color by data column" — drawn layers only (hidden otherwise)
    populateDefaults(node);  // "On by default" (expanded-by-default is container-only)
    document.getElementById('elp-opacity').value = op;
    document.getElementById('elp-opacity-val').textContent = op;
    document.getElementById('elp-outline').value = /^#[0-9a-fA-F]{6}$/.test(outline) ? outline : '#000000';
    document.getElementById('elp-outline-row').style.display = (node.type === 'line' || node.outlineSplit) ? 'none' : 'block';  // lines + split polygons have no separate outline here
    // "Match fill colors" (8/14): offered on the polygon itself (border follows the fill) AND on a
    // split-off outline layer (border follows its parent's fill) — both are the same wish.
    (function () {
      var mRow = document.getElementById('elp-outline-match-row'), mCb = document.getElementById('elp-outline-match');
      if (!mRow || !mCb) return;
      var eligible = (node.type === 'fill' && !node.outlineSplit) || !!node.outlineOf;
      mRow.style.display = eligible ? 'block' : 'none';
      mCb.checked = !!node.outlineMatchFill;
    })();
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
    /* Normalise the type ONCE. Raw `node.type` is not a clean enum: nine live layers carry null,
       "Polygon", "Point" or "LineString", and each bare comparison below treated those as "some
       other thing". A Polygon-typed fill got border width 2 instead of the 0.5 default, and a
       LineString-typed layer was shown no width control at all. Found by find-enum-gaps. */
    var nType = (typeof msPaintKeyFor === 'function')
      ? msPaintKeyFor(node.type, 'color').replace(/-color$/, '')
      // enum-ok: the no-engine-helper fallback; defaults to 'fill' exactly as msPaintKeyFor does.
      : (node.type === 'line' ? 'line' : node.type === 'circle' ? 'circle' : 'fill');
    var width = paintWidth(node.paint); if (width == null) width = (nType === 'circle') ? 1.5 : (nType === 'fill' ? 0.5 : 2);   // fills: 0.5 border default
    document.getElementById('elp-width').value = width;
    document.getElementById('elp-width-val').textContent = width;
    document.getElementById('elp-width-label').textContent = (nType === 'line') ? 'Width' : 'Outline width';
    fillWzoomUI(node);   // 7/21: "Vary width by zoom" checkbox + stops (lines only; parses the stored expression)
    // width = line/outline thickness: lines, un-split polygons (auto-outline), and circles (circle-stroke-width — uncapped, no split needed)
    document.getElementById('elp-width-row').style.display = ((nType === 'line') || (fillStroke && !node.outlineSplit) || nType === 'circle') ? 'block' : 'none';
    // offset (8/14): engine-rendered lines only — MapboxDraw's fixed styles can't shift a line sideways
    (function () {
      var offRow = document.getElementById('elp-offset-row'); if (!offRow) return;
      var showOff = node.type === 'line' && (isTilesetNode(node) || node.outlineOf || !_drawLayerSlugs[node.id]);
      offRow.style.display = showOff ? 'block' : 'none';
      var offv = (node.paint && typeof node.paint['line-offset'] === 'number') ? node.paint['line-offset'] : 0;
      document.getElementById('elp-offset').value = offv;
      document.getElementById('elp-offset-val').textContent = offv;
    })();
    var radius = (node.paint && node.paint['circle-radius'] != null) ? node.paint['circle-radius'] : 5;
    document.getElementById('elp-radius').value = radius;
    document.getElementById('elp-radius-val').textContent = radius;
    document.getElementById('elp-radius-row').style.display = (node.type === 'circle') ? 'block' : 'none';
    // attribute table: drawn + ALL tilesets (stored features → editable; pure tilesets → read-only from loaded tiles)
    document.getElementById('elp-info').style.display = 'block';
    // the section/divider branch hides the whole Layer-info section — re-show it for layers
    (function () { var ib = document.getElementById('elp-info'); if (ib && ib.closest) { var iw = ib.closest('.ms-sectop'); if (iw) iw.style.display = ''; } })();
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
    // 7/21 — Source repoint HIDDEN for now: an accidental "Apply source" click could re-point a layer and wipe its
    // generated tiles/work. Users add a new file instead; re-enable when we build "live layers". Code kept intact below.
    document.getElementById('elp-src-row').style.display = 'none';
    if (false && isTs) {
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
    document.getElementById('elp-tablebtn').checked = node.tableBtn !== false;   // per-row ▦-in-view toggle — default on
    document.getElementById('elp-tablebtn-row').style.display = (node.type === 'group' || node.type === 'section') ? 'none' : 'block';   // ▦ exists on leaves only
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
      // shimmer placeholder (7/29): a not-yet-fetched virtual row reads as LOADING, not broken.
      '@keyframes attrShimmer{0%{background-position:-160px 0;}100%{background-position:160px 0;}}' +
      '#editor-attr-table tr.attr-row-ghost td{padding:5px 7px;background-image:linear-gradient(90deg,#f0f0f0 25%,#e4e4e4 37%,#f0f0f0 63%);background-size:320px 100%;animation:attrShimmer 1.2s ease-in-out infinite;}' +
      '#editor-attr-foot{padding:8px 16px;border-top:1px solid #cccccc;font-size:12px;color:#888888;}';
    document.head.appendChild(st);
    var m = document.createElement('div'); m.id = 'editor-attr-modal';
    m.innerHTML =
      '<div id="editor-attr-panel">' +
        '<div id="editor-attr-head"><span class="attr-head-l"><b id="editor-attr-title">Attributes</b>' +
          '<span id="editor-attr-selcount" style="color:#8a86a0;font-size:12px;margin:0 4px;white-space:nowrap;"></span>' +
          '<button id="editor-attr-zoom" title="Zoom the map to the selected feature(s)" disabled>&#9673; Zoom to selected</button>' +
          '<button id="editor-attr-del" title="Delete the selected feature(s)" disabled>&#128465; Delete selected</button>' +
          '<button id="editor-attr-transfer" title="Copy one column\'s values into another">&#8646; Transfer column</button>' +
          '<button id="editor-attr-addcol" title="Add a new (empty) column to this layer">+ Column</button>' +
          '<button id="editor-attr-delcol" title="Delete a column from every feature of this layer">&#8722; Column</button>' +
          '<button id="editor-attr-dups" title="Find identical or overlapping features — mark them in a column, or delete the extras">&#10697; Duplicates</button></span>' +
          '<span id="editor-attr-close" title="Close">&times;</span></div>' +
        '<div id="editor-attr-addcol-panel" style="display:none;padding:6px 12px;border-bottom:1px solid #e4e0ee;background:#faf9fd;font-size:12.5px;">' +
          'New column <input id="attr-ac-name" placeholder="column name" style="font-size:12px;width:160px;">' +
          ' <button id="attr-ac-go" style="font-size:12px;padding:2px 10px;border:1px solid #a3c293;border-radius:4px;background:#eafaea;color:#2d7a2d;cursor:pointer;">Add</button>' +
          ' <span id="attr-ac-status" style="color:#8a86a0;"></span>' +
          '<div style="color:#8a86a0;margin-top:2px;">Adding a column is free — it appears here and in the feature panel, empty until you fill it. Nothing is written to your features.</div>' +
        '</div>' +
        '<div id="editor-attr-delcol-panel" style="display:none;padding:6px 12px;border-bottom:1px solid #e4e0ee;background:#fdf9f9;font-size:12.5px;">' +
          'Delete column <select id="attr-dc-sel" style="font-size:12px;max-width:220px;"></select>' +
          ' <button id="attr-dc-go" style="font-size:12px;padding:2px 10px;border:1px solid #d0a0a0;border-radius:4px;background:#fdeeee;color:#a33;cursor:pointer;">Delete&hellip;</button>' +
          ' <span id="attr-dc-status" style="color:#8a86a0;"></span>' +
          '<div style="color:#8a86a0;margin-top:2px;">Custom columns are removed from every feature; built-ins (Label, Notes, dates) are cleared to empty. Asks before doing anything. Cannot be undone.</div>' +
        '</div>' +
        '<div id="editor-attr-dups-panel" style="display:none;padding:6px 12px;border-bottom:1px solid #e4e0ee;background:#f9fbfd;font-size:12.5px;">' +
          '<label style="margin-right:10px;"><input type="radio" name="attr-dup-mode" value="identical" checked style="vertical-align:middle;"> Identical</label>' +
          '<label><input type="radio" name="attr-dup-mode" value="overlap" style="vertical-align:middle;"> Overlapping</label>' +
          '<span id="attr-dup-idbox" style="margin-left:14px;">count as identical: <span id="attr-dup-cols"></span></span>' +
          ' <button id="attr-dup-preview" style="font-size:12px;padding:2px 10px;border:1px solid #93a8c2;border-radius:4px;background:#eaf1fa;color:#2d5a7a;cursor:pointer;">Preview</button>' +
          ' <span id="attr-dup-status" style="color:#8a86a0;"></span>' +
          '<div id="attr-dup-actions" style="margin-top:4px;display:none;">' +
            'Mark in column <input id="attr-dup-col" value="dup_group" style="font-size:12px;width:110px;">' +
            ' <button id="attr-dup-mark" style="font-size:12px;padding:2px 10px;border:1px solid #a3c293;border-radius:4px;background:#eafaea;color:#2d7a2d;cursor:pointer;">Mark</button>' +
            ' <button id="attr-dup-delete" style="font-size:12px;padding:2px 10px;border:1px solid #d0a0a0;border-radius:4px;background:#fdeeee;color:#a33;cursor:pointer;">Delete duplicates&hellip;</button>' +
            ' <span id="attr-dup-note" style="color:#8a86a0;"></span>' +
          '</div>' +
        '</div>' +
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
    document.getElementById('editor-attr-addcol').addEventListener('click', function () { toggleAttrToolPanel('editor-attr-addcol-panel'); });
    document.getElementById('editor-attr-delcol').addEventListener('click', function () { toggleAttrToolPanel('editor-attr-delcol-panel', fillDelColSelect); });
    document.getElementById('editor-attr-dups').addEventListener('click', function () { toggleAttrToolPanel('editor-attr-dups-panel', fillDupIdentity); });
    document.getElementById('attr-ac-go').addEventListener('click', runAddColumn);
    document.getElementById('attr-dc-go').addEventListener('click', runDeleteColumn);
    document.getElementById('attr-dup-preview').addEventListener('click', runDupPreview);
    document.getElementById('attr-dup-mark').addEventListener('click', runDupMark);
    document.getElementById('attr-dup-delete').addEventListener('click', runDupDelete);
    Array.prototype.forEach.call(document.querySelectorAll('input[name=attr-dup-mode]'), function (r) {
      r.addEventListener('change', function () { fillDupIdentity(); document.getElementById('attr-dup-actions').style.display = 'none'; document.getElementById('attr-dup-status').textContent = ''; });
    });
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
        // `up` is also wired to window blur (8/22): _msPanelDrag suppresses map hover, and it was
        // cleared ONLY by mouseup. Release the button outside the window, or alt-tab mid-drag, and
        // that mouseup never arrives — the flag stays true and hover highlighting is dead until a
        // reload, with nothing on screen to explain it. Every mode-enter writes its inverse, on
        // every exit path including the abandoned one. Found 8/22 by find-unguarded-latch.
        // latch-ok: mouseup AND blur both clear it, so no exit path leaves it raised.
        function up() { window._msPanelDrag = false; document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); window.removeEventListener('blur', up); document.body.style.userSelect = ''; }
        document.body.style.userSelect = 'none';
        document.addEventListener('mousemove', move); document.addEventListener('mouseup', up); window.addEventListener('blur', up);
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
        await saveSoft(patchLayerConfig(lid, { attrView: node.attrView }), 'saving the table column layout');
      } catch (e) {}
    }, 400);
  }
  var _attrCustom = {};   // fid → its custom_fields object, so a single-cell edit rewrites the whole jsonb
  var _attrRows = [], _attrCols = [], _attrSort = null, _attrSel = [], _selGeom = {};   // loaded rows + column model + {idx,dir} + READ-ONLY MIRROR of MSSel (see below) + fid→geometry cache from map-clicks (instant highlight without a DB fetch)
  var _selDays = {};   // fid → [DayStart, DayEnd] captured at map-click (tile props) — the selection marker must know its feature's days to follow the timeline (8/8)
  // ── selection store (7/28 carve-out → platform/selection.js) ──────────────────────────────────
  // MSSel owns the selected-feature set; _attrSel is a read-only mirror kept fresh by the ONE
  // subscriber below, which also refreshes every selection surface (table row classes, map
  // highlight, zoom/delete buttons, features list). NEVER assign or splice _attrSel directly —
  // five stacked selection bugs came from exactly that (multiple writers, different semantics).
  if (!window.MSSel) (function () {   // selection.js failed to load → same-contract inline fallback
    var _ids = [], _subs = [];
    function emit(reason, changed) { for (var i = 0; i < _subs.length; i++) { try { _subs[i]({ ids: _ids.slice(), reason: reason, changed: changed }); } catch (e) {} } }
    window.MSSel = {
      ids: function () { return _ids.slice(); }, count: function () { return _ids.length; },
      has: function (fid) { return _ids.indexOf(String(fid)) > -1; },
      add: function (fid) { fid = String(fid); if (_ids.indexOf(fid) > -1) return false; _ids.push(fid); emit('add', [fid]); return true; },
      remove: function (fid) { fid = String(fid); var i = _ids.indexOf(fid); if (i < 0) return false; _ids.splice(i, 1); emit('remove', [fid]); return true; },
      toggle: function (fid) { return this.has(fid) ? (this.remove(fid), false) : (this.add(fid), true); },
      select: function (list) { var next = (list || []).map(String); if (next.length === _ids.length && next.every(function (f, i) { return f === _ids[i]; })) return false; var prev = _ids; _ids = next; emit('select', prev.concat(next)); return true; },
      clear: function () { if (!_ids.length) return false; var gone = _ids; _ids = []; emit('clear', gone); return true; },
      onChange: function (cb) { if (typeof cb === 'function') _subs.push(cb); }
    };
  })();
  MSSel.onChange(function (ev) {
    _attrSel = MSSel.ids();
    applyAttrSelClasses(); updateAttrHighlight(); updateAttrZoomBtn(); updateAttrDelBtn();
    syncFlistSel(); updateFlistZoom();
    if (ev && ev.reason === 'add' && ev.changed && ev.changed.length) scrollSelRowIntoView(ev.changed[ev.changed.length - 1]);   // a map-side add must be VISIBLE in an open windowed list/table
  });
  function scrollSelRowIntoView(fid) {   // windowed DOM: the selected row may not exist until its window scrolls into range
    fid = String(fid);
    try {
      var modal = document.getElementById('editor-attr-modal');
      if (modal && modal.style.display !== 'none') {
        var row = document.querySelector('#editor-attr-tbody tr[data-fid="' + fid.replace(/"/g, '') + '"]');
        if (!row && _attrWin) { for (var ri = 0; ri < _attrRows.length; ri++) { if (String(_attrRows[ri].feature_id) === fid) { _attrWin.scrollToIndex(ri); break; } } }
        else if (row && !_attrWin) row.scrollIntoView({ block: 'nearest' });
        return;
      }
      var fl = document.getElementById('editor-flist');
      if (fl && fl.style.display !== 'none' && _flistWin) {
        var frow = document.querySelector('#editor-flist-tbody tr[data-fid="' + fid.replace(/"/g, '') + '"]');
        if (!frow) { for (var fi = 0; fi < _attrRows.length; fi++) { if (String(_attrRows[fi].feature_id) === fid) { _flistWin.scrollToIndex(fi); break; } } }
      }
    } catch (e) {}
  }
  window.__msSelRows = function () { try { var ids = MSSel.ids(); return _attrRows.filter(function (r) { return ids.indexOf(String(r.feature_id)) > -1; }).length; } catch (e) { return -1; } };   // observability (tests): selection members that have rows in the open list/table
  var _attrLoadGen = 0;        // bump = abort any in-flight attribute load (close/reopen mid-load of a huge layer)
  /* Rows STREAMED into memory; past this a layer uses the big-data tier (the Parquet sidecar,
     paging on demand) instead. Overridable so the two modes can be compared on ONE layer —
     `attr-virtual-parity-gate` opens the same table both ways and checks the columns and the total
     match. Without a seam that comparison is impossible, and "virtual mode shows fewer columns" was
     carried on the checklist for a day as a trade nobody had measured. It is not in the code:
     the sidecar stores every custom field and openProvider reads the schema. */
  var ATTR_LOAD_CAP = (typeof window !== 'undefined' && window.__msAttrLoadCap != null)
    ? window.__msAttrLoadCap : 100000;   // …instead of a full fetch; rendering is windowed
                                         // (MSAttrWindow) so DOM size never depends on row count
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
    if (cap) {
      // ONE seam for every column cap in the editor (the table, the virtual table, the colour-by
      // and label pickers all pass through here). Past the cap the extra columns are simply not
      // there — no ellipsis, no note — so a layer with more columns than this looks like it lost
      // them. Announced once per cap size rather than once per call site.
      if (mid.length > Math.max(0, cap - msid.length - style.length) && window.MSGuard) {
        MSGuard.cliff('attr-column-cap:' + cap, keys.length, cap,
          'this layer has more columns than the table can show, so the ones past the first ' + cap + ' are not listed');
      }
      mid = mid.slice(0, Math.max(0, cap - msid.length - style.length));
    }
    return msid.concat(mid).concat(style);
  }
  var _attrById = {}, _attrSlug = null, _attrHover = null, _attrHoverRAF = false, _attrLastPt = null, _attrHoverWired = false;   // hover brushing (map ↔ row): id→row lookup, open layer, hovered fid
  var _attrReadonly = false, _attrReadonlyWhy = null;   // true when per-feature editing is off; WHY ('instance'|'folded'|'tiles') so every refusal states the real reason instead of a generic shrug
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
    // FOLDED layers have no rows — fill still-missing geometries from the loaded vector tiles
    // (best-effort: only features inside loaded tiles resolve; others just skip the zoom/glow).
    var nodeF = _attrSlug ? findNodeById(layers, _attrSlug) : null;
    if (nodeF && nodeF.fold_state === 'folded') {
      [['left', beforeMap], ['right', (typeof afterMap !== 'undefined' ? afterMap : null)]].forEach(function (pair) {
        var m = pair[1]; if (!m) return;
        try {
          var q = nodeF['source-layer'] ? { sourceLayer: nodeF['source-layer'] } : {};
          (m.querySourceFeatures(nodeF.id + '-' + pair[0], q) || []).forEach(function (f) {
            var row = f.id != null && _attrById[String(f.id)];
            if (row && !row.geom && f.geometry) row.geom = f.geometry;
          });
        } catch (eQ) {}
      });
    }
  }
  /* ── big-data tier plumbing (7/18) — see platform/bigtable.js ─────────── */
  function attrBakeStatus(m) { try { setStatus(m); } catch (e) {} }
  // after a full plain stream, big layers get their sidecar (re)baked in the background from the
  // rows ALREADY in memory — covers brand-new imports (first open bakes, every later open is fast)
  // and stale/dirty sidecars (the stream is the fresh truth)
  function maybeBakeAfterStream(lid, rows, total, gen) {
    if (!window.MSBigTable || _attrReadonly || !lid) return;
    // Above BAKE_MAX no sidecar is ever baked again, so a table that used to open instantly
    // streams for a minute on EVERY open, permanently, with nothing explaining the change.
    if (window.MSGuard && MSGuard.cliff('sidecar-bake-ceiling', total, MSBigTable.BAKE_MAX,
      'this layer is too large to keep a fast table snapshot, so its attribute table loads the slow way every time')) return;
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
        // keyset resume from the last streamed row (rows arrive feature_id ASC) — offset pages
        // deep into a big layer each re-walk everything before them (8/13)
        var lastFid9 = all.length ? all[all.length - 1].feature_id : null;
        while (all.length < MSBigTable.BAKE_MAX) {
          var qb9 = db.from('features').select('feature_id, label, description, start_date, end_date, custom_fields, content_id').eq('layer_id', lid);
          if (lastFid9 !== null) qb9 = qb9.gt('feature_id', lastFid9);
          var res = await qb9.order('feature_id').limit(1000);
          if (res.error) return;
          Array.prototype.push.apply(all, res.data || []);
          if (!res.data || res.data.length < 1000) break;
          lastFid9 = res.data[res.data.length - 1].feature_id;
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
    // 20s cap (7/23): a hung columnar engine used to leave "Opening…" forever ("table doesn't
    // even open") — timing out THROWS, and the caller falls back to the streaming loader instead
    var prov = await Promise.race([
      MSBigTable.openProvider(lid, rc.attrParquet, rc.attrParquetAt, rc.attrParquetRows),
      new Promise(function (ignore, rej) { setTimeout(function () { rej(new Error('big-table engine timed out (20s)')); }, 20000); })
    ]);
    if (gen !== _attrLoadGen) return;
    var N = rc.attrParquetRows;
    var keysS = orderAttrKeys(prov.customKeys.slice(), 30);
    (function () { var xn = nodeByLayerDbId(lid) || findNodeById(layers, slug); (((xn || {}).extraColumns) || []).forEach(function (k) { if (keysS.indexOf(k) < 0) keysS.push(k); }); })();   // registered empty columns render too (+ Column tool)
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
    _attrVirtual.footOk = nfmt(N) + ' features · big-data table — rows stream in as you scroll, sorts run in the columnar engine · click a row to highlight it on the map';
    if (foot) foot.textContent = _attrVirtual.footOk;
  }
  // swap the virtual-table footer between the normal message and a persistent-failure warning + Retry
  function updateAttrVirtualFoot() {
    var foot = document.getElementById('editor-attr-foot'); if (!foot) return;
    var v = _attrVirtual; if (!v) return;
    if (!v.failed) { foot.textContent = v.footOk || ''; return; }
    foot.innerHTML = '⚠ Some rows couldn’t load. <a href="#" id="attr-page-retry" style="color:#4ea1ff;">Retry</a>';
    var a = document.getElementById('attr-page-retry');
    if (a) a.onclick = function (e) {
      e.preventDefault();
      if (!_attrVirtual) return;
      _attrVirtual.fails = {}; _attrVirtual.failed = false;
      foot.textContent = 'Retrying…';
      if (_attrWin) _attrWin.update();   // re-render → onMissing re-fires fetchAttrPage for visible gaps
    };
  }
  // ── ms_dataset in EVERY table (8/13, owner: "I don't see the ms_dataset in attribute
  //    tables still"): live rows carry it from the features view, but SIDECAR-backed tables
  //    (big/virtual/folded) read a parquet baked before the view change. When the layer's
  //    stamps are uniform (one dataset covers every row — the normal case), fill the column
  //    client-side; mixed stamps wait for the next sidecar bake (per-row truth only). ──
  async function ensureMsDatasetColumn(lid, gen) {
    try {
      if (gen !== _attrLoadGen) return;
      var have = _attrCols.some(function (c) { return c.kind === 'custom' && c.key === 'ms_dataset'; });
      var sample = (_attrRows || []).find(function (r) { return r && r.custom_fields && r.custom_fields.ms_dataset != null && r.custom_fields.ms_dataset !== 'none'; });
      if (have && sample) return;   // rows already carry it (live view rows)
      // THE ROWS' ORIGIN, never the layer's registration (8/13b — the fundamental fix). After
      // a fork/MSD registration the two legitimately DIFFER: rows keep pointing at where the
      // data CAME FROM (immutable provenance) while the layer's own dataset entry is just its
      // registration — resolving via datasets.origin_layer_id here showed the registration id
      // on every row of the owner's fresh MSD. Sample the FIRST and LAST row's dataset_id
      // (two 1-row indexed queries — sidesteps the count-scan flake of 8/13): equal and
      // non-null → the stamps are uniform, fill with that. Pointer copies own no rows — their
      // table shows the DATA ROOT's rows, so the sample comes from the root.
      var dataLid = lid;
      var s1 = await db.from('features').select('dataset_id').eq('layer_id', dataLid).order('feature_id').limit(1);
      if (!s1.data || !s1.data.length) {
        var rt = await db.rpc('ms_layer_data_root', { p_layer: lid });
        if (!rt.error && rt.data && rt.data !== lid) {
          dataLid = rt.data;
          s1 = await db.from('features').select('dataset_id').eq('layer_id', dataLid).order('feature_id').limit(1);
        }
      }
      if (!s1.data || !s1.data.length || gen !== _attrLoadGen) return;   // no rows anywhere — nothing to show
      var s2 = await db.from('features').select('dataset_id').eq('layer_id', dataLid).order('feature_id', { ascending: false }).limit(1);
      var a0 = s1.data[0].dataset_id, b0 = s2.data && s2.data[0] && s2.data[0].dataset_id;
      // unstamped or mixed stamps → per-row truth only (the next sidecar bake carries it)
      if (!a0 || a0 !== b0 || gen !== _attrLoadGen) return;
      var dsid = a0;
      if (gen !== _attrLoadGen) return;
      (_attrRows || []).forEach(function (r) { if (r) { r.custom_fields = r.custom_fields || {}; if (r.custom_fields.ms_dataset == null) r.custom_fields.ms_dataset = dsid; } });
      if (_attrVirtual) _attrVirtual.msDatasetFill = dsid;             // pages that land later get it too
      if (!have) { _attrCols.push({ title: 'ms_dataset', kind: 'custom', key: 'ms_dataset', type: 'text', w: 130 }); buildAttrHead(); }
      renderAttrBody(true);
    } catch (e) { console.warn('ms_dataset column backfill failed:', e && e.message); }
  }
  function fetchAttrPage(start, end) {
    var v = _attrVirtual; if (!v) return;
    if (!v.fails) v.fails = {};
    var ps = Math.max(0, Math.floor(start / 200) * 200);
    var pe = Math.min(v.N, ps + 400);   // the visible page + one ahead
    for (var s = ps; s < pe; s += 200) {
      (function (s0) {
        if (v.pending[s0]) return;
        v.pending[s0] = 1;
        v.prov.range(s0, 200, v.order).then(function (rs) {
          if (_attrVirtual !== v || v.gen !== _attrLoadGen) return;
          delete v.pending[s0]; delete v.fails[s0];
          for (var i = 0; i < rs.length; i++) {
            if (v.msDatasetFill) { rs[i].custom_fields = rs[i].custom_fields || {}; if (rs[i].custom_fields.ms_dataset == null) rs[i].custom_fields.ms_dataset = v.msDatasetFill; }
            _attrRows[s0 + i] = rs[i]; _attrById[String(rs[i].feature_id)] = rs[i];
          }
          if (v.failed) { v.failed = false; updateAttrVirtualFoot(); }
          if (_attrWin) _attrWin.update();
        }, function (err) {   // failed page: auto-retry a few times with backoff, then surface it
          if (_attrVirtual !== v || v.gen !== _attrLoadGen) { delete v.pending[s0]; return; }
          delete v.pending[s0];
          var n = (v.fails[s0] = (v.fails[s0] || 0) + 1);
          if (n <= 3) { setTimeout(function () { if (_attrVirtual === v && v.gen === _attrLoadGen) fetchAttrPage(s0, s0 + 1); }, 600 * n); }
          else { v.failed = true; updateAttrVirtualFoot(); console.warn('attr page ' + s0 + ' failed', err); }
        });
      })(s);
    }
  }
  async function openAttributeTable(slug) {
    var node = slug && findNodeById(layers, slug); if (!node) return;
    // Mirrors read their SOURCE's rows (instanceOf) — read-only from this placement; the source owns edits.
    var lid = node.instanceOf || slugToLayerDbId[slug];
    if (!lid) { setStatus('No stored data for this layer'); return; }
    injectAttrModal();
    var modal = document.getElementById('editor-attr-modal');
    document.getElementById('editor-attr-title').textContent = (node.label || 'Layer') + ' — attributes';
    // (8/13b) the registered-dataset summary lives in the DATASET MODAL, not here — the owner:
    // "I wanted it in the registration modal, not in the attribute table."
    var thead = document.getElementById('editor-attr-thead'), tbody = document.getElementById('editor-attr-tbody'), foot = document.getElementById('editor-attr-foot');
    thead.innerHTML = ''; tbody.innerHTML = '<tr><td style="padding:14px;color:#888888;">Loading…</td></tr>'; foot.textContent = '';
    modal.style.display = 'block';
    _attrCustom = {}; _attrRows = []; _attrCols = []; _attrSort = null; _attrReadonly = !!node.instanceOf; _attrReadonlyWhy = node.instanceOf ? 'instance' : null; _attrVirtual = null;   // selection PERSISTS across open (map ⇄ table sync always) — rows render pre-starred; mirrors are read-only
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
      // registered-but-still-empty columns (the + Column tool): the layer says they exist, so
      // they render even though no row carries a value yet — otherwise an empty column would
      // vanish on every reload and "add column" would look broken until the first cell was filled
      (function () { var xn = nodeByLayerDbId(lid) || findNodeById(layers, slug); (((xn || {}).extraColumns) || []).forEach(function (k) { if (keysS.indexOf(k) < 0) keysS.push(k); }); })();
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
        var rcq = await db.from('layers').select('*').eq('id', lid).single();   // * so fold_state rides along pre/post C0
        if (gen !== _attrLoadGen) return;
        var arc = (rcq.data && rcq.data.raw_config) || {};
        var foldedA = (rcq.data && rcq.data.fold_state === 'folded') || (node && node.fold_state === 'folded');
        if (arc.attrParquet) {
          // freshness (7/23 rules): the exact count TIMES OUT on the very layers that need the
          // sidecar — a failed count must TRUST the sidecar (attrParquetDirty catches real edits).
          // And a cap-sized sidecar (BAKE_MAX rows) can never equal a bigger live count — accept it
          // and let the footer say "first N of…". FOLDED layers skip the count: their rows are
          // gone by design (0 would read as stale) — the sidecar IS the table until a re-fold.
          var cq = null; if (!foldedA) { try { cq = await db.from('features').select('feature_id', { count: 'exact', head: true }).eq('layer_id', lid); } catch (eCq) {} }
          if (gen !== _attrLoadGen) return;
          var live = (cq && !cq.error && cq.count != null) ? cq.count : null;
          var capMax = (window.MSBigTable && MSBigTable.BAKE_MAX) || 300000;
          var capped = arc.attrParquetRows >= capMax;
          var fresh = !arc.attrParquetDirty && (foldedA || live == null || live === arc.attrParquetRows || (capped && live >= arc.attrParquetRows));
          if (fresh && arc.attrParquetRows <= ATTR_LOAD_CAP) {
            foot.textContent = 'Opening (fast columnar sidecar)…';
            try {
              var srows = await MSBigTable.loadAll(lid, arc.attrParquet, arc.attrParquetAt);
              if (gen !== _attrLoadGen) return;
              rows = srows; total = srows.length;
              if (foldedA) { _attrReadonly = true; _attrReadonlyWhy = 'folded'; }   // folded: cell edits would UPDATE missing rows (silent no-op) — read-only until the delta editor (C4)
              buildTable(true);
              ensureMsDatasetColumn(lid, gen);   // sidecars baked pre-8/13 lack ms_dataset — backfill uniform stamps
              return;
            } catch (eSc) { console.warn('sidecar load failed — falling back to stream', eSc); }
          } else if (fresh) {   // > display cap: VIRTUAL mode — rows page in on demand, sorts run as SQL in the worker
            try { await openVirtualAttr(node, slug, lid, arc, gen); ensureMsDatasetColumn(lid, gen); return; }
            catch (eV) { console.warn('virtual table failed — falling back to stream', eV); }
          }
        }
      } catch (eRc) {}
      if (gen !== _attrLoadGen) return;
    }
    try {
      // KEYSET stream (7/23): offset paging hit the statement timeout at depth on big layers and
      // killed the whole table ("Failed to load features"); no count:'exact' either — computing it
      // on a 300k layer 500s the very first page. Total = rows streamed (footer live-counts).
      var aLast = null, aRetried = false;
      for (;;) {
        // NO geom (7/18): geometry was ~half of a 72MB table download and the table never displays
        // it — hover/highlight/zoom fetch geometries per-row on demand (ensureAttrGeoms)
        var aq = db.from('features').select('feature_id, label, description, start_date, end_date, custom_fields, content_id').eq('layer_id', lid).order('feature_id').limit(1000);
        if (aLast != null) aq = aq.gt('feature_id', aLast);
        var ares = await aq;
        if (gen !== _attrLoadGen) return;   // modal closed / another layer opened — stop this load
        if (ares.error) {
          if (!aRetried) { aRetried = true; await new Promise(function (rs) { setTimeout(rs, 1500); }); continue; }   // cliff-ok: one retry, then it throws
          loadErr = ares.error; break;
        }
        aRetried = false;
        var abatch = ares.data || [];
        if (!abatch.length) break;
        aLast = abatch[abatch.length - 1].feature_id;
        Array.prototype.push.apply(rows, abatch);
        if (!streamedFirst && rows.length) { streamedFirst = true; buildTable(false); }
        else { var fEl = document.getElementById('editor-attr-foot'); if (fEl) fEl.textContent = 'Loading ' + nfmt(rows.length) + '… — the table already works'; }
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
      _attrRows = tfeats; _attrReadonly = true; _attrReadonlyWhy = 'tiles'; _attrSlug = slug; _attrById = {}; tfeats.forEach(function (r) { _attrById[String(r.feature_id)] = r; }); ensureAttrMapHover();
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
    // virtual (big-data) mode: a not-yet-fetched row renders as a shimmering ghost of the same
    // height — no data-fid, so clicks/hover/measure all skip it; the debounced page fetch
    // (attrGrid.js) replaces it once the scroll position settles. The shimmer (CSS, injectAttrModal)
    // reads as "loading", not "broken" — a static "…" looked like a stuck/failed row.
    if (!r) return '<tr class="attr-row-ghost" style="height:' + ((_attrWin && _attrWin.rowH) || 30) + 'px;"><td colspan="' + (_attrCols.length || 1) + '"></td></tr>';
    var isSel = _attrSel.indexOf(String(r.feature_id)) > -1;
    return '<tr data-fid="' + attrEsc(r.feature_id) + '"' + (isSel ? ' class="attr-row-sel"' : '') + '>' + _attrCols.map(function (c) {
      var stick = c._left != null ? ' class="attr-pin-cell" style="left:' + c._left + 'px;"' : '';
      if (c.kind === 'sel') return '<td class="attr-sel-cell' + (c._left != null ? ' attr-pin-cell' : '') + '"' + (c._left != null ? ' style="left:' + c._left + 'px;"' : '') + ' title="Select / deselect this feature"></td>';
      var bind = c.kind === 'custom' ? 'data-fc="' + attrEsc(c.key) + '"' : 'data-f="' + attrEsc(c.field) + '"';
      var v = attrEsc(attrDisp(r, c));
      // msid + ms_dataset are IDENTITY, never editable (owner 8/13: "extremely important") —
      // the server strips them from writes anyway; the UI must not pretend otherwise
      var lockedCol = c.kind === 'custom' && (c.key === 'msid' || c.key === 'ms_dataset');
      if (_attrReadonly || !isSel || lockedCol) return '<td' + stick + '><span ' + bind + ' style="display:block;padding:5px 7px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' + (lockedCol ? 'color:#8a8499;' : '') + '"' + (lockedCol ? ' title="Identity column — read-only"' : '') + '>' + v + '</span></td>';
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
    else {
      // attrGrid.js missing — degraded but alive. "Alive" previously meant showing the first 1,500
      // rows of a 78,000-row layer with no indication that the rest exist.
      var DEGRADED_MAX = 1500;
      if (window.MSGuard) MSGuard.cliff('attr-degraded-rows', _attrRows.length, DEGRADED_MAX,
        'the windowed table renderer did not load, so only the first ' + DEGRADED_MAX + ' rows are shown — reload to get the full table');
      tbody.innerHTML = _attrRows.slice(0, DEGRADED_MAX).map(attrRowHtml).join('');
    }
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
  function selectAttrRow(fid, additive) {   // row/★ click → the ONE store; every surface repaints via the MSSel subscriber
    fid = String(fid);
    if (additive) MSSel.toggle(fid);
    else MSSel.select([fid]);
  }
  function applyAttrSelClasses() {
    var tbody = document.getElementById('editor-attr-tbody'); if (!tbody) return;
    Array.prototype.forEach.call(tbody.querySelectorAll('tr[data-fid]'), function (tr) { tr.classList.toggle('attr-row-sel', _attrSel.indexOf(tr.getAttribute('data-fid')) > -1); });
    refreshAttrRowEditability();   // text-first rows: selected rows swap to real inputs, deselected back to text
  }
  function updateAttrZoomBtn() { var b = document.getElementById('editor-attr-zoom'); if (b) b.disabled = !_attrSel.length; }
  function updateAttrDelBtn() {
    var b = document.getElementById('editor-attr-del'); if (!b) return;
    // EVERY database-backed layer deletes rows now (8/20, owner: "I should be able to delete
    // selected features from the table"). The old draw-only gate predated the dedupe tools
    // proving DB-row deletes are fine on tilesets — a tiled layer's rows are as much its
    // features as a drawn layer's. Hidden only where the rows aren't this layer's to delete
    // (instances are read-only mirrors of someone else's rows).
    b.style.display = (_attrSlug && !_attrReadonly && slugToLayerDbId[_attrSlug]) ? '' : 'none';
    b.disabled = !_attrSel.length;
    b.innerHTML = '&#128465; Delete' + (_attrSel.length ? ' (' + _attrSel.length + ')' : ' selected');
    // the count lives next to the title too — visible even on read-only layers, and it answers
    // "how many do I have selected" without hunting for a button state (owner 8/20). A read-only
    // table says WHAT it is up front (folded archive / instance / pure tiles) instead of letting
    // each tool refuse one by one with the reason hidden until clicked.
    var sc = document.getElementById('editor-attr-selcount');
    if (sc) {
      var bits = [];
      if (_attrReadonlyWhy === 'folded') bits.push('📦 folded archive — read-only');
      else if (_attrReadonlyWhy === 'instance') bits.push('🔗 instance — edit the source layer');
      else if (_attrReadonlyWhy === 'tiles') bits.push('🧩 external tiles — read-only');
      if (_attrSel.length) bits.push(_attrSel.length + ' selected');
      sc.textContent = bits.join(' · ');
    }
  }
  async function deleteAttrSelected() {
    if (!MSSel.count()) return;
    var fids = MSSel.ids(), n = fids.length;
    // TWO deletion paths, one per feature kind (8/20, "It's supposed to work both ways"):
    // MapboxDraw-resident (drawn) features keep the existing path with its undo; everything else
    // — tileset rows, engine-rendered features, a map-side selection with no table open — deletes
    // straight from the database (feature_id is globally unique, RLS decides what's yours), which
    // is exactly what the dedupe tools already proved safe.
    var isDrawn = _attrSlug && _drawLayerSlugs[_attrSlug];
    if (!isDrawn) { await deleteDbFeatures(fids); return; }
    if (!window.confirm('Delete ' + n + ' feature' + (n > 1 ? 's' : '') + ' from this layer? You can undo this.')) return;
    await deleteDrawnByFids(fids, 'delete ' + n + ' feature' + (n > 1 ? 's' : ''));
    if (_attrVirtual) { setStatus('Deleted ' + n + ' feature' + (n > 1 ? 's' : '')); openAttributeTable(_attrSlug); return; }   // sparse rows can't be filtered in place — reopen (count mismatch → fresh stream + rebake)
    fids.forEach(function (fid) { delete _attrById[String(fid)]; });
    _attrRows = _attrRows.filter(function (r) { return fids.indexOf(String(r.feature_id)) < 0; });
    MSSel.clear();
    buildAttrHead(); renderAttrBody(true);
    scheduleAttrRebake();   // sidecar'd layer: row count changed — refresh the bake in the background
    setStatus('Deleted ' + n + ' feature' + (n > 1 ? 's' : ''));
  }
  // Database-row deletion for everything MapboxDraw doesn't hold: tileset rows, engine-rendered
  // features, and map-side selections made with no table open. Works across layers in one go —
  // feature_id is the features table's PK, and RLS refuses rows that aren't yours, so a partial
  // count is REPORTED, never papered over (a 0-row delete that says "deleted" is family B).
  async function deleteDbFeatures(fids) {
    var n = fids.length;
    // which layers do these belong to? (needed for the re-bake note + drawn-layer re-render;
    // also lets the confirm name the layer when there is exactly one)
    var byLayer = {};
    for (var i = 0; i < fids.length; i += 400) {
      var q = await db.from('features').select('feature_id, layer_id').in('feature_id', fids.slice(i, i + 400));
      if (q.error) { setStatus('Delete failed: ' + q.error.message); return; }
      (q.data || []).forEach(function (r) { (byLayer[r.layer_id] = byLayer[r.layer_id] || []).push(r.feature_id); });
    }
    var lids = Object.keys(byLayer);
    if (!lids.length) { setStatus('Nothing to delete'); return; }
    var lidToNode = {};
    Object.keys(slugToLayerDbId).forEach(function (s) { lidToNode[slugToLayerDbId[s]] = findNodeById(layers, s); });
    var oneName = lids.length === 1 && lidToNode[lids[0]] ? '“' + (lidToNode[lids[0]].label || 'this layer') + '”' : lids.length + ' layers';
    if (!window.confirm('Delete ' + n + ' selected feature' + (n > 1 ? 's' : '') + ' from ' + oneName + '?\n\nThis cannot be undone.')) return;
    var deleted = 0;
    for (var j = 0; j < fids.length; j += 400) {
      var r = await db.from('features').delete({ count: 'exact' }).in('feature_id', fids.slice(j, j + 400));
      if (r.error) { setStatus('Delete failed after ' + deleted + ': ' + r.error.message); return; }
      deleted += (r.count || 0);
    }
    if (!deleted) { setStatus('Nothing was deleted — those features aren’t yours to delete'); return; }
    // reconcile every surface that might be showing them
    fids.forEach(function (fid) { delete _attrById[String(fid)]; delete _attrCustom[String(fid)]; });
    if (_attrSlug) {
      if (_attrVirtual) { openAttributeTable(_attrSlug); }
      else { _attrRows = _attrRows.filter(function (r) { return !r || fids.indexOf(String(r.feature_id)) < 0; }); buildAttrHead(); renderAttrBody(true); scheduleAttrRebake(); }
    }
    MSSel.clear();
    var anyDrawn = false, tiledNames = [];
    lids.forEach(function (lid2) {
      var nd = lidToNode[lid2];
      if (nd && _drawLayerSlugs[nd.id]) anyDrawn = true;
      else if (nd && isTilesetNode(nd)) tiledNames.push(nd.label || nd.id);
      else if (nd) anyDrawn = true;   // engine-rendered geojson re-renders through loadFeatures too
    });
    if (anyDrawn) { try { await loadFeatures(); } catch (e) {} }
    setStatus('Deleted ' + deleted + ' feature' + (deleted > 1 ? 's' : ''));
    if (deleted < n) msProgress('Deleted ' + deleted + ' of ' + n + ' — the rest aren’t yours to delete.');
    if (tiledNames.length) msProgress('Deleted ' + deleted + ' — the map still renders the OLD tiles for ' + tiledNames.join(', ') + '; Re-bake to see the change.');
    runAudit('after feature delete');
  }
  function attrMaps() { var a = []; if (typeof beforeMap !== 'undefined' && beforeMap) a.push(beforeMap); if (typeof afterMap !== 'undefined' && afterMap) a.push(afterMap); return a; }
  function ensureAttrHlLayers() {   // selection + hover overlays on BOTH swipe sides (so highlight shows left AND right)
    attrMaps().forEach(function (m) {
      if (m.getSource('editor-attr-hl-src')) return;
      try {
        m.addSource('editor-attr-hl-src', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
        m.addLayer({ id: 'editor-attr-hl-fill', type: 'fill', source: 'editor-attr-hl-src', filter: ['==', '$type', 'Polygon'], paint: { 'fill-color': '#ffd400', 'fill-opacity': 0.18 } });   // light — the feature's own colour must stay recognisable (8/8)
        // selection lines: dark casing + bright yellow core — must be unmistakable over ANY layer color
        // (the old single orange 3px line was INVISIBLE on orange layers — the rail-lines "selection
        // doesn't stick" bug 7/28: the set was right, the paint was camouflaged; hover stays cyan)
        m.addLayer({ id: 'editor-attr-hl-line-casing', type: 'line', source: 'editor-attr-hl-src', filter: ['!=', 'msFrag', 1], paint: { 'line-color': '#1f1f1f', 'line-width': 9, 'line-opacity': 0.85 } });
        m.addLayer({ id: 'editor-attr-hl-line', type: 'line', source: 'editor-attr-hl-src', filter: ['!=', 'msFrag', 1], paint: { 'line-color': '#ffd400', 'line-width': 4 } });
        // selected points: yellow with a DARK ring (same language as the line casing) — the old orange
        // ring was identical to the single-feature ARMED ring, so selection and arming were indistinguishable
        m.addLayer({ id: 'editor-attr-hl-pt', type: 'circle', source: 'editor-attr-hl-src', filter: ['==', '$type', 'Point'], paint: { 'circle-radius': 10, 'circle-color': '#ffd400', 'circle-stroke-color': '#1f1f1f', 'circle-stroke-width': 3 } });
        // hover overlay (cyan) — rides ABOVE the yellow selection so the brushed feature reads clearly
        m.addSource('editor-attr-hover-src', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
        m.addLayer({ id: 'editor-attr-hover-fill', type: 'fill', source: 'editor-attr-hover-src', filter: ['==', '$type', 'Polygon'], paint: { 'fill-color': '#00e5ff', 'fill-opacity': 0.25 } });
        m.addLayer({ id: 'editor-attr-hover-line', type: 'line', source: 'editor-attr-hover-src', paint: { 'line-color': '#00b8d4', 'line-width': 3.5 } });
        m.addLayer({ id: 'editor-attr-hover-pt', type: 'circle', source: 'editor-attr-hover-src', filter: ['==', '$type', 'Point'], paint: { 'circle-radius': 10, 'circle-color': '#00e5ff', 'circle-opacity': 0.5, 'circle-stroke-color': '#00b8d4', 'circle-stroke-width': 3 } });
        if (typeof msRaiseLabelLayers === 'function') msRaiseLabelLayers(m, layers);   // highlights glow UNDER the labels
      } catch (e) {}
    });
  }
  // Paint the CURRENT selection from whatever geometry is on hand (fetched row geoms + clicked-tile
  // fragments). Reads live _attrSel, so a late repaint can never show a stale set.
  function paintAttrHighlight() {
    var ymdN = function (d, dflt) { return d ? +(String(d).slice(0, 10).replace(/-/g, '')) || dflt : dflt; };
    var feats = _attrSel.map(function (fid) {
      var r = findAttrRow(fid); var g = (r && r.geom) || _selGeom[String(fid)]; if (!g) return null;
      // the marker carries its feature's days (8/8): a selected feature that the timeline
      // excludes must not leave a floating star behind — same contract as every other costume.
      // Best source wins: the table row (fresh), then the click-time tile props, then the armed
      // meta; a feature whose days are unknowable stays always-visible rather than vanishing.
      var ds = 0, de = 99999999;
      if (r && (r.start_date || r.end_date)) { ds = ymdN(r.start_date, 0); de = ymdN(r.end_date, 99999999); }
      else if (_selDays[String(fid)]) { ds = _selDays[String(fid)][0]; de = _selDays[String(fid)][1]; }
      else { var m2 = featureMeta['db-' + fid]; if (m2 && (m2.start || m2.end)) { ds = ymdN(m2.start, 0); de = ymdN(m2.end, 99999999); } }
      // TILE FRAGMENTS GET NO OUTLINE (8/16, "it has lines… chopped up"): geometry gathered from
      // rendered tiles is the feature CLIPPED at every tile boundary — fills butt-join invisibly,
      // but a line layer strokes each fragment's ring and draws a grid through the middle of the
      // shape. So a fragment-sourced highlight paints FILL ONLY, and the outline appears when the
      // stored geometry replaces it (r.geom present → msFrag 0). Whole-shape immediately, edges
      // only where real edges are.
      var frag = !(r && r.geom) && !!_selGeom[String(fid)] && !(_selGeom[String(fid)].msWhole);
      return { type: 'Feature', geometry: g, properties: { DayStart: ds, DayEnd: de, msFrag: frag ? 1 : 0 } };
    }).filter(Boolean);
    attrMaps().forEach(function (m) { try { var src = m.getSource('editor-attr-hl-src'); if (src) src.setData({ type: 'FeatureCollection', features: feats }); } catch (e) {} });
    try { if (typeof editorCurrentDate === 'function') applyEditedOverlayDayFilter(editorCurrentDate()); } catch (e) {}
  }
  var _attrHlSeq = 0;
  function updateAttrHighlight() {
    ensureAttrHlLayers();
    // PAINT NOW — never wait on the network to show a selection. (The old code awaited a per-click
    // geom fetch and DISCARDED the paint if the selection changed meanwhile: once table rows had
    // streamed in (real usage pace), every click waited on a slow/failable DB roundtrip → the
    // highlight lagged clicks or never came → features "looked unselected" → re-clicks toggled them
    // OUT → the alternating-selection bug, 7/28. Headless tests clicked before rows streamed, so
    // the fetch was skipped and it "passed".)
    paintAttrHighlight();
    var missing = _attrSel.filter(function (fid) { var r = findAttrRow(fid); return !(r && r.geom); });
    if (!missing.length) return;
    var seq = ++_attrHlSeq;   // latest-wins: only the newest enrichment triggers a repaint
    ensureAttrGeoms(missing).then(
      function () { if (seq === _attrHlSeq) paintAttrHighlight(); },      // upgrade fragments → full geometries
      function () { if (seq === _attrHlSeq) paintAttrHighlight(); });     // even on fetch failure, repaint what we have
  }
  function clearAttrHighlight() {   // the ONE explicit wipe (empty-ground click) — subscriber repaints; direct setData covers pre-boot callers
    MSSel.clear();
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
        var r2 = await patchLayerConfig(lid2, { zoomBtn: on ? null : false });   // null deletes
        if (r2.error) throw new Error(r2.error.message);
      }
      setStatus('Saved');
    } catch (e) { console.warn('editing: zoom-button toggle save failed', e); setStatus('Save failed'); }
  }
  // Per-row ▦ table button in VIEW mode (default ON) — node.tableBtn === false persists as
  // raw_config.tableBtn (configLoader's raw spread carries it to the viewer; generateLayers gates).
  // The editor KEEPS its ▦ either way, restyled as an amber ✕-square so the owner sees the state.
  // Surgical icon swap only — rerender() would fold the open group (the editorOnly lesson, 7/21).
  async function onTableBtnToggle(on) {
    if (!activeLayerId) return;
    var node = findNodeById(layers, activeLayerId); if (!node || node.type === 'group' || node.type === 'section') return;
    if (on) delete node.tableBtn; else node.tableBtn = false;
    updateTableBtnRow(node);
    setStatus('Saving…');
    try {
      var lidT = slugToLayerDbId[node.id]; if (!lidT) throw new Error('no layer id');
      var uT = await patchLayerConfig(lidT, { tableBtn: on ? null : false });   // null deletes
      if (uT.error) throw new Error(uT.error.message);
      setStatus('Saved');
    } catch (e) { console.warn('editing: table-button toggle save failed', e); setStatus('Save failed'); }
  }
  function updateTableBtnRow(node) {
    var row = document.querySelector('.layer-list-row[data-node-id="' + node.id + '"]'); if (!row) return;
    var ic = row.querySelector('.attr-table-btn'); if (!ic) return;
    // keep the table glyph either way — the amber strike (.ms-tbl-off, engine.css) marks hidden-in-view
    ic.classList.toggle('ms-tbl-off', node.tableBtn === false);
    ic.title = node.tableBtn === false ? 'Attribute table — hidden in view mode (still opens for you)' : 'Attribute table';
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
    // also on blur — see the resize handler's note: a mouseup that never arrives left map hover
    // suppressed for the rest of the session.  latch-ok: cleared on every exit path now.
    function up() { window._msPanelDrag = false; document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); window.removeEventListener('blur', up); document.body.style.userSelect = ''; }
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', move); document.addEventListener('mouseup', up); window.addEventListener('blur', up);
  }
  // ── "⇄ Transfer column": copy one column's values into another (e.g. RRname → Label), server-side
  //    in id-batches so 78k-row layers finish without timeouts. Source-empty rows are never touched.
  function toggleTransferPanel() {
    var p9 = document.getElementById('editor-attr-transfer-panel'); if (!p9) return;
    if (_attrReadonly || !_attrSlug || !slugToLayerDbId[_attrSlug]) { setStatus(attrReadonlyMsg()); return; }
    var show = p9.style.display === 'none';
    if (show) {
      var opts = [];
      _attrCols.forEach(function (c) {
        if (c.kind === 'std' && c.field === 'label') opts.push({ v: 'label', t: 'Label' });
        else if (c.kind === 'custom' && c.key && c.key !== 'msid' && c.key !== 'ms_dataset') opts.push({ v: c.key, t: c.key });   // identity columns: never a transfer source/target
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
    if (to === 'msid' || to === 'ms_dataset') { st9.textContent = 'That is an identity column — read-only.'; return; }
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
  function hideAttrModal() { _attrLoadGen++; var m = document.getElementById('editor-attr-modal'); if (m) m.style.display = 'none'; _attrSlug = null; setAttrHover(null, false); }   // gen bump ABORTS an in-flight load — Close always works, even mid-load of a huge layer. Selection persists (close hides the VIEW, not the working set — empty-ground click clears)

  /* ── COLUMN TOOLS + DUPLICATES (8/20, owner: "I need to reduce the global borders map") ────
     Three inline panels in the attribute table, one visible at a time. All heavy work happens
     SERVER-SIDE in the ms_dup_* / ms_intersect_* / ms_drop_column RPCs (SECURITY INVOKER — RLS
     is the authority, these buttons add none), so the browser never downloads geometry to
     compare it. The table stays open and usable throughout — that was the ask. */
  var ATTR_BUILTIN_COLS = [['label', 'Label'], ['description', 'Notes'], ['start_date', 'Start'], ['end_date', 'End'], ['image_url', 'Image URL']];
  // A refusal must say WHY (owner 8/20, clicking Transfer on a FOLDED layer got "database-backed
  // layers only" — the layer IS database-backed; its rows are just archived). Same message
  // everywhere a readonly table declines a tool.
  function attrReadonlyMsg() {
    if (_attrReadonlyWhy === 'folded') return 'This layer is FOLDED — its feature rows are archived, and the table shows the archive snapshot. Editing tools come back when it’s unfolded.';
    if (_attrReadonlyWhy === 'instance') return 'This layer is a linked instance — it mirrors its source layer. Open the SOURCE layer’s table to edit.';
    if (_attrReadonlyWhy === 'tiles') return 'This layer’s features live inside external vector tiles, not the database — there are no rows to edit.';
    return 'This tool needs a database-backed layer you can edit';
  }
  function toggleAttrToolPanel(id, fillFn) {
    if (_attrReadonly || !_attrSlug || !slugToLayerDbId[_attrSlug]) { setStatus(attrReadonlyMsg()); return; }
    ['editor-attr-transfer-panel', 'editor-attr-addcol-panel', 'editor-attr-delcol-panel', 'editor-attr-dups-panel'].forEach(function (p) {
      var el = document.getElementById(p); if (!el) return;
      el.style.display = (p === id && el.style.display === 'none') ? 'block' : 'none';
    });
    if (fillFn && document.getElementById(id).style.display === 'block') fillFn();
  }
  function attrCustomColKeys() {
    var ks = [];
    _attrCols.forEach(function (c) { if (c.kind === 'custom' && c.key && c.key !== 'msid' && c.key !== 'ms_dataset') ks.push(c.key); });
    return ks;
  }
  // + Column: a REGISTRY entry (raw_config.extraColumns), zero feature writes. The column exists
  // because the layer says so, not because some row happens to carry a value — otherwise an
  // empty column would vanish on every reload (absence read as a benign default, family B).
  async function runAddColumn() {
    var st = document.getElementById('attr-ac-status');
    var name = (document.getElementById('attr-ac-name').value || '').trim();
    var lid = _attrSlug && slugToLayerDbId[_attrSlug]; if (!lid) return;
    if (!name) { st.textContent = 'Name the column first.'; return; }
    if (/^(feature_id|msid|label|description|start_date|end_date|image_url|content_id|ms_dataset)$/i.test(name)) { st.textContent = '“' + name + '” is a built-in name — pick another.'; return; }
    var have = attrCustomColKeys();
    if (have.indexOf(name) > -1) { st.textContent = 'That column already exists.'; return; }
    var node = findNodeById(layers, _attrSlug);
    node.extraColumns = (node.extraColumns || []).concat([name]);
    setStyleMetaRC(lid, 'extraColumns', node.extraColumns);
    _attrCols.push({ title: name, kind: 'custom', key: name, type: 'text', w: 130 });
    buildAttrHead(); renderAttrBody(true);
    st.textContent = 'Added — fill cells here, or use it as a Mark target.';
    document.getElementById('attr-ac-name').value = '';
  }
  function fillDelColSelect() {
    var s = document.getElementById('attr-dc-sel');
    var opts = attrCustomColKeys().map(function (k) { return '<option value="c:' + attrEsc(k) + '">' + attrEsc(k) + '</option>'; });
    ATTR_BUILTIN_COLS.forEach(function (b) { opts.push('<option value="b:' + b[0] + '">' + b[1] + ' (clear values)</option>'); });
    s.innerHTML = opts.join('');
    document.getElementById('attr-dc-status').textContent = '';
  }
  async function runDeleteColumn() {
    var st = document.getElementById('attr-dc-status');
    var sel = document.getElementById('attr-dc-sel').value || '';
    var isCustom = sel.slice(0, 2) === 'c:', col = sel.slice(2);
    var lid = _attrSlug && slugToLayerDbId[_attrSlug]; if (!lid || !col) return;
    var node = findNodeById(layers, _attrSlug);
    // a column that drives the layer's colours is not just data — deleting it beheads the styling
    var drives = node && node.colorBy && node.colorBy.prop === col;
    var msg = isCustom
      ? 'Delete the column “' + col + '” from every feature of “' + (node && node.label || 'this layer') + '”?'
      : 'Clear every “' + col + '” value on “' + (node && node.label || 'this layer') + '”?';
    if (drives) msg += '\n\n⚠ This column drives the layer’s colour-by styling — the colours will stop working.';
    msg += '\n\nThis cannot be undone.';
    if (!confirm(msg)) return;
    st.textContent = 'Deleting…';
    try {
      var r = await db.rpc('ms_drop_column', { p_layer: lid, p_col: col });
      if (r.error) throw new Error(r.error.message);
      // local mirrors follow the database: rows, the per-feature cache, the column model, the registry
      if (isCustom) {
        _attrRows.forEach(function (row) { if (row && row.custom_fields) delete row.custom_fields[col]; });
        Object.keys(_attrCustom).forEach(function (fid) { if (_attrCustom[fid]) delete _attrCustom[fid][col]; });
        _attrCols = _attrCols.filter(function (c) { return !(c.kind === 'custom' && c.key === col); });
        if (node && node.extraColumns) { node.extraColumns = node.extraColumns.filter(function (k) { return k !== col; }); setStyleMetaRC(lid, 'extraColumns', node.extraColumns.length ? node.extraColumns : null); }
      } else {
        _attrRows.forEach(function (row) { if (row) row[col] = null; });
      }
      buildAttrHead(); renderAttrBody(true); fillDelColSelect();
      st.textContent = 'Removed from ' + nfmt(r.data || 0) + ' feature' + ((r.data || 0) === 1 ? '' : 's') + '.' + (isTilesetNode(node) ? ' Tiles show it after a Re-bake.' : '');
      if (!isTilesetNode(node)) await loadFeatures();
    } catch (e) { st.textContent = 'Failed: ' + e.message; }
  }
  // ── Duplicates ──────────────────────────────────────────────────────────────────────────
  function dupMode() { var r = document.querySelector('input[name=attr-dup-mode]:checked'); return r ? r.value : 'identical'; }
  function fillDupIdentity() {
    var box = document.getElementById('attr-dup-cols');
    var idbox = document.getElementById('attr-dup-idbox');
    if (dupMode() === 'overlap') { idbox.style.display = 'none'; return; }
    idbox.style.display = '';
    var parts = ['<label style="margin-right:8px;"><input type="checkbox" id="attr-dup-geom" checked style="vertical-align:middle;"> Geometry</label>'];
    ATTR_BUILTIN_COLS.forEach(function (b) {
      parts.push('<label style="margin-right:8px;"><input type="checkbox" class="attr-dup-c" data-col="' + b[0] + '" style="vertical-align:middle;"> ' + b[1] + '</label>');
    });
    attrCustomColKeys().forEach(function (k) {
      parts.push('<label style="margin-right:8px;"><input type="checkbox" class="attr-dup-c" data-col="' + attrEsc(k) + '" style="vertical-align:middle;"> ' + attrEsc(k) + '</label>');
    });
    box.innerHTML = parts.join('');
  }
  function dupIdentity() {
    var cols = [];
    Array.prototype.forEach.call(document.querySelectorAll('.attr-dup-c:checked'), function (c) { cols.push(c.getAttribute('data-col')); });
    return { useGeom: !!(document.getElementById('attr-dup-geom') || {}).checked, cols: cols };
  }
  async function runDupPreview() {
    var st = document.getElementById('attr-dup-status');
    var lid = _attrSlug && slugToLayerDbId[_attrSlug]; if (!lid) return;
    var acts = document.getElementById('attr-dup-actions');
    acts.style.display = 'none';
    try {
      if (dupMode() === 'identical') {
        var idn = dupIdentity();
        if (!idn.useGeom && !idn.cols.length) { st.textContent = 'Pick geometry or at least one column.'; return; }
        st.textContent = 'Scanning…';
        var r = await db.rpc('ms_dup_preview', { p_layer: lid, p_use_geom: idn.useGeom, p_cols: idn.cols });
        if (r.error) throw new Error(r.error.message);
        var d = (r.data && r.data[0]) || {};
        st.textContent = nfmt(d.grp_count) + ' duplicate group' + (d.grp_count === 1 ? '' : 's') + ' · ' + nfmt(d.removable) + ' removable of ' + nfmt(d.total) + ' features.';
        acts.style.display = +d.grp_count ? 'block' : 'none';
        document.getElementById('attr-dup-delete').style.display = '';
        document.getElementById('attr-dup-note').textContent = 'Mark writes the group number on every member; Delete keeps one per group.';
      } else {
        st.textContent = 'Scanning overlaps (can take ~15s on a heavy layer)…';
        var r2 = await db.rpc('ms_intersect_preview', { p_layer: lid });
        if (r2.error) throw new Error(r2.error.message);
        var d2 = (r2.data && r2.data[0]) || {};
        st.textContent = nfmt(d2.feature_count) + ' features overlap another they coexist with in time (' + nfmt(d2.pair_count) + ' pairs).';
        acts.style.display = +d2.feature_count ? 'block' : 'none';
        // no delete for overlaps: WHICH of two half-overlapping features to keep is a judgment
        // call, and a wrong guess silently destroys legitimate geometry — mark, look, decide.
        document.getElementById('attr-dup-delete').style.display = 'none';
        document.getElementById('attr-dup-note').textContent = 'Mark writes each feature’s overlap count — sort by it, look, then delete by hand or ask for a rule.';
      }
    } catch (e) { st.textContent = e.message; }
  }
  async function runDupMark() {
    var st = document.getElementById('attr-dup-status');
    var lid = _attrSlug && slugToLayerDbId[_attrSlug]; if (!lid) return;
    var target = (document.getElementById('attr-dup-col').value || 'dup_group').trim();
    st.textContent = 'Marking…';
    try {
      var r = dupMode() === 'identical'
        ? await db.rpc('ms_dup_mark', { p_layer: lid, p_use_geom: dupIdentity().useGeom, p_cols: dupIdentity().cols, p_target: target })
        : await db.rpc('ms_intersect_mark', { p_layer: lid, p_target: target });
      if (r.error) throw new Error(r.error.message);
      st.textContent = 'Marked ' + nfmt(r.data || 0) + ' features in “' + target + '” — reopening the table…';
      var slugR = _attrSlug; hideAttrModal(); openAttributeTable(slugR);   // reload rows so the new values show
    } catch (e) { st.textContent = 'Failed: ' + e.message; }
  }
  async function runDupDelete() {
    var st = document.getElementById('attr-dup-status');
    var lid = _attrSlug && slugToLayerDbId[_attrSlug]; if (!lid) return;
    var node = findNodeById(layers, _attrSlug);
    var idn = dupIdentity();
    try {
      var pv = await db.rpc('ms_dup_preview', { p_layer: lid, p_use_geom: idn.useGeom, p_cols: idn.cols });
      if (pv.error) throw new Error(pv.error.message);
      var d = (pv.data && pv.data[0]) || {};
      if (!+d.removable) { st.textContent = 'Nothing to delete.'; return; }
      if (!confirm('Delete ' + nfmt(d.removable) + ' duplicate feature' + (+d.removable === 1 ? '' : 's') + ' from “' + (node && node.label || 'this layer') + '”?\n\nOne copy of each group is kept (the oldest). This cannot be undone.')) return;
      st.textContent = 'Deleting…';
      var r = await db.rpc('ms_dup_delete', { p_layer: lid, p_use_geom: idn.useGeom, p_cols: idn.cols });
      if (r.error) throw new Error(r.error.message);
      var gone = (r.data || []).map(String);
      _attrRows = _attrRows.filter(function (row) { return !row || gone.indexOf(String(row.feature_id)) < 0; });
      gone.forEach(function (fid) { delete _attrById[fid]; delete _attrCustom[fid]; try { MSSel.remove(fid); } catch (e) {} });
      if (_attrWin) _attrWin.setRows(_attrRows, true); else renderAttrBody(true);
      var foot = document.getElementById('editor-attr-foot');
      if (foot) foot.textContent = nfmt(_attrRows.length) + ' features (' + nfmt(gone.length) + ' duplicates deleted)';
      st.textContent = 'Deleted ' + nfmt(gone.length) + ' feature' + (gone.length === 1 ? '' : 's') + '.' +
        (isTilesetNode(node) ? ' The map still renders the OLD tiles — Re-bake the layer to see the reduction.' : '');
      if (!isTilesetNode(node)) await loadFeatures();
      runAudit('after duplicate delete');
    } catch (e) { st.textContent = 'Failed: ' + e.message; }
  }

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
      selectAttrRow(tr.getAttribute('data-fid'), e.ctrlKey || e.metaKey);   // shared: MSSel updates → the subscriber repaints list + map together
    });
    tb.addEventListener('mouseover', function (e) { var tr = e.target.closest('tr[data-fid]'); setAttrHover(tr ? tr.getAttribute('data-fid') : null, false); });
    tb.addEventListener('mouseleave', function () { setAttrHover(null, false); });
    window.addEventListener('resize', function () { if (el.style.display !== 'none') dockFeaturesList(); });   // keep it docked + full-height on resize
  }
  function flistRowHtml(r) {
    if (!r) return '<tr class="flist-ghost"><td style="color:#bbbbbb;">…</td></tr>';
    var sel = _attrSel.indexOf(String(r.feature_id)) > -1;
    // A whitespace-only label rendered as an EMPTY row here — not "(untitled)" — so the list
    // showed a blank line that looked like a rendering fault rather than an unnamed feature.
    var lbl = (r.label == null || String(r.label).trim() === '') ? '<span class="flist-untitled">(untitled)</span>' : attrEsc(r.label);
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
    setAttrHover(null, false);   // selection persists — closing the list only hides the view
  }
  // Rows past this count get an EARLY first page before the full load, because materializing
  // every row costs real time and the list can only show ~17 of them. Measured 8/21 on the
  // Railways layer (78,843 rows): the full materialize was 1,608 ms of a 1,922 ms wait, while a
  // 300-row page off the same sidecar was 76 ms. Same rule the streaming fallback already follows
  // — paint the first page, keep loading behind it. Visibility never waits on completeness.
  var FLIST_EARLY_MIN = 5000;
  async function loadFlistRows(lid, gen, onEarly) {
    // fast path: reuse the tier-2 Parquet sidecar if it's fresh (instant for big layers)
    if (window.MSBigTable) {
      try {
        var rcq = await db.from('layers').select('*').eq('id', lid).single();   // * so fold_state rides along pre/post C0
        if (gen !== _attrLoadGen) return null;
        var rc = (rcq.data && rcq.data.raw_config) || {};
        var foldedF = rcq.data && rcq.data.fold_state === 'folded';
        if (rc.attrParquet && !rc.attrParquetDirty && rc.attrParquetRows <= ATTR_LOAD_CAP) {
          var cq = foldedF ? null : await db.from('features').select('feature_id', { count: 'exact', head: true }).eq('layer_id', lid);
          if (gen !== _attrLoadGen) return null;
          if (foldedF || ((cq && cq.count) || 0) === rc.attrParquetRows) {   // folded: rows are gone by design — trust the sidecar
            if (typeof onEarly === 'function' && (rc.attrParquetRows || 0) > FLIST_EARLY_MIN) {
              // one page off the same sidecar, painted immediately; the full load continues below
              try {
                var prov = await MSBigTable.openProvider(lid, rc.attrParquet, rc.attrParquetAt, rc.attrParquetRows || 0);
                var page = await prov.range(0, 300, null);
                if (gen !== _attrLoadGen) return null;
                if (page && page.length) onEarly(page);
              } catch (eEarly) {}   // speculative: a failure here must never stop the real load
            }
            var srows = await MSBigTable.loadAll(lid, rc.attrParquet, rc.attrParquetAt);
            if (gen !== _attrLoadGen) return null;
            return srows;
          }
        }
        if (foldedF) return [];   // folded with no usable sidecar: a Postgres stream would just spin on zero rows
      } catch (e) {}
    }
    // fallback: stream just feature_id + label (light — no geometry, no custom fields)
    var out = [], lastFidF = null, firstPage = true;
    for (;;) {   // keyset pages — deep offsets re-walk every skipped row server-side (8/13)
      var qbF = db.from('features').select('feature_id, label').eq('layer_id', lid);
      if (lastFidF !== null) qbF = qbF.gt('feature_id', lastFidF);
      var res = await qbF.order('feature_id').limit(1000);
      if (gen !== _attrLoadGen) return null;
      if (res.error) throw new Error(res.error.message);
      Array.prototype.push.apply(out, res.data || []);
      if (firstPage && out.length) { _attrRows = out.slice(); rebuildFlistIndex(); renderFlist(); document.getElementById('editor-flist-foot').textContent = 'Loading ' + nfmt(out.length) + '…'; }
      firstPage = false;
      if (!res.data || res.data.length < 1000) break;
      lastFidF = res.data[res.data.length - 1].feature_id;
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
    // Mirrors list their SOURCE's rows (instanceOf) — read-only from this placement; the source owns edits.
    var lid = node.instanceOf || slugToLayerDbId[slug];
    if (!lid) { setStatus('No stored data for this layer'); return; }
    injectFeaturesList();
    var el = document.getElementById('editor-flist');
    document.getElementById('flist-title').textContent = node.label || 'Features';
    _flistSlug = slug; _attrSlug = slug; _attrReadonly = !!node.instanceOf; _attrReadonlyWhy = node.instanceOf ? 'instance' : null;
    _flistIcon = flistLayerIcon(node);
    _attrById = {}; _attrRows = [];   // selection PERSISTS across open (map ⇄ table sync always)
    ensureAttrHlLayers(); ensureAttrMapHover();
    el.style.display = 'flex'; dockFeaturesList();
    document.getElementById('editor-flist-tbody').innerHTML = '<tr><td style="padding:12px;color:#999999;">Loading…</td></tr>';
    document.getElementById('editor-flist-foot').textContent = '';
    updateFlistZoom();
    var gen = ++_attrLoadGen;
    var rows;
    try {
      rows = await loadFlistRows(lid, gen, function (page) {
        if (gen !== _attrLoadGen) return;
        _attrRows = page; rebuildFlistIndex(); renderFlist();
        var f0 = document.getElementById('editor-flist-foot');
        if (f0) f0.textContent = 'Loading the rest…';
      });
    } catch (e) { document.getElementById('editor-flist-tbody').innerHTML = '<tr><td style="padding:12px;color:#b4453a;">Failed to load features.</td></tr>'; return; }
    if (rows == null || gen !== _attrLoadGen) return;   // closed / superseded
    _attrRows = rows; rebuildFlistIndex();
    if (!rows.length) {
      document.getElementById('editor-flist-tbody').innerHTML = '<tr><td style="padding:12px;color:#999999;">No listed features for this layer.</td></tr>';
      document.getElementById('editor-flist-foot').textContent = '0 features';
      return;
    }
    renderFlist();
    if (MSSel.count()) { var selIds0 = MSSel.ids(); for (var si = 0; si < _attrRows.length; si++) { if (selIds0.indexOf(String(_attrRows[si].feature_id)) > -1) { if (_flistWin) _flistWin.scrollToIndex(si); break; } } }   // an existing map selection is visible the moment the list opens
    document.getElementById('editor-flist-foot').textContent = nfmt(rows.length) + ' feature' + (rows.length === 1 ? '' : 's');
  }
  async function saveAttrCustomCell(fid, key, value) {
    // identity columns are NEVER writable (owner 8/13) — belt to the render-side lock's braces
    if (key === 'msid' || key === 'ms_dataset') { setStatus(key + ' is an identity column — read-only'); return; }
    var cf = _attrCustom[fid];
    if (!cf) { cf = _attrCustom[fid] = {}; var row0 = findAttrRow(fid); if (row0) row0.custom_fields = cf; }   // link a fresh object back to the row so re-sort shows the edit
    var v = value.trim();
    if (v === '') delete cf[key];
    else if (/^-?\d+(\.\d+)?$/.test(v)) cf[key] = Number(v);   // keep numbers numeric
    else cf[key] = value;
    setStatus('Saving…');
    try {
      var r = await db.from('features').update({ custom_fields: Object.keys(cf).length ? cf : null }).eq('feature_id', fid); if (r.error) throw new Error(r.error.message); setStatus('Saved'); scheduleAttrRebake();
      // tiled layers render per-feature colours through the persisted paint (by-id match) — refresh it
      if (key === 'ms_color') { var n9 = _attrSlug && findNodeById(layers, _attrSlug); if (n9 && isTilesetNode(n9)) scheduleTiledOverrideRefresh(_attrSlug); }
    }
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
  // ── Zoom-varied line width (7/21): "Vary width by zoom" builds a top-level interpolate over 3
  //    zoom→px stops; each stop's output keeps the per-feature ms_thickness override (flat, all zooms).
  //    The truth lives IN node.paint['line-width'] itself — the UI re-derives its stops by parsing it,
  //    so nothing extra persists and the viewer renders the same expression untouched. ──
  function wzParse(node) {   // stored interpolate → [[zoom, px]…] (px = each output's case fallback)
    var lw = node && node.paint && node.paint['line-width'];
    if (!Array.isArray(lw) || lw[0] !== 'interpolate') return null;
    var out = [];
    for (var i = 3; i + 1 < lw.length; i += 2) {
      var o = lw[i + 1], w = Array.isArray(o) ? o[o.length - 1] : o;
      out.push([lw[i], typeof w === 'number' ? w : 2]);
    }
    return out.length >= 2 ? out : null;
  }
  function wzDefaults(node) {   // common default derived from the current uniform width
    var W = paintWidth(node.paint); if (W == null) W = 2;
    function r1(x) { return Math.max(0.5, Math.round(x * 2) / 2); }
    return [[5, r1(W * 0.5)], [10, W], [15, r1(W * 2.5)]];
  }
  function fillWzoomUI(node) {
    var row = document.getElementById('elp-wzoom-row'); if (!row) return;
    // lines only; not while thickness-by-column drives the width; not for MapboxDraw-resident layers
    // (their visible copies are draw styles, which can't take zoom expressions)
    var eligible = node && node.type === 'line' && !node.thicknessBy && !node.outlineOf &&
      !(node.source_type === 'geojson-supabase' && _drawLayerSlugs[node.id]);
    row.style.display = eligible ? 'block' : 'none';
    if (!eligible) return;
    var stops = wzParse(node), on = !!stops;
    if (!stops) stops = wzDefaults(node);
    document.getElementById('elp-wzoom-on').checked = on;
    document.getElementById('elp-wzoom-box').style.display = on ? 'block' : 'none';
    for (var i = 0; i < 3; i++) {
      var s = stops[i] || stops[stops.length - 1];
      document.getElementById('elp-wz-z' + i).value = s[0];
      document.getElementById('elp-wz-w' + i).value = s[1];
    }
  }
  function onWzoom() {
    if (!activeLayerId) return;
    var node = findNodeById(layers, activeLayerId); if (!node || node.type !== 'line') return;
    var on = document.getElementById('elp-wzoom-on').checked;
    document.getElementById('elp-wzoom-box').style.display = on ? 'block' : 'none';
    if (_styleSession !== node.id) { _styleSession = node.id; _styleBefore = { color: node.iconColor, paint: node.paint ? JSON.parse(JSON.stringify(node.paint)) : null }; }
    node.paint = node.paint || {};
    if (on) {
      var stops = [];
      for (var i = 0; i < 3; i++) {
        var z = parseFloat(document.getElementById('elp-wz-z' + i).value), w = parseFloat(document.getElementById('elp-wz-w' + i).value);
        if (!isNaN(z) && !isNaN(w)) stops.push([z, w]);
      }
      stops.sort(function (a, b) { return a[0] - b[0]; });
      for (var j = 1; j < stops.length; j++) if (stops[j][0] <= stops[j - 1][0]) stops[j][0] = stops[j - 1][0] + 0.5;   // interpolate demands strictly ascending zooms
      if (stops.length < 2) return;   // need at least two stops to interpolate — keep typing
      node.widthZoom = { stops: stops };
      // 7/21: PLAIN numeric outputs = a pure camera expression the GPU interpolates perfectly smoothly
      // while zooming. Embedding the per-feature ms_thickness case made it a composite (data+zoom)
      // expression, which re-evaluates per integer zoom and visibly STEPPED between levels (user
      // report). Only pay that cost when the layer's features actually use ms_thickness — and tiles
      // never do (skinny tiles carry no ms_* columns).
      var useMs = false;
      if (!isTilesetNode(node)) {
        try {
          var wfs = (node.source && node.source.data && node.source.data.features) || [];
          for (var wf = 0; wf < wfs.length; wf++) { var wv = (wfs[wf].properties || {}).ms_thickness; if (wv != null && String(wv) !== '' && !isNaN(parseFloat(wv))) { useMs = true; break; } }
        } catch (eMs) {}
      }
      var ex = ['interpolate', ['linear'], ['zoom']];
      stops.forEach(function (s) { ex.push(s[0], useMs ? numColExpr('ms_thickness', s[1]) : s[1]); });
      node.paint['line-width'] = ex;
    } else {
      delete node.widthZoom;
      var wSl = parseFloat((document.getElementById('elp-width') || {}).value);
      node.paint['line-width'] = !isNaN(wSl) ? wSl : 2;
    }
    [['left', beforeMap], ['right', (typeof afterMap !== 'undefined' ? afterMap : null)]].forEach(function (pair) {   // live on both maps
      var m = pair[1]; if (!m) return; var id = node.id + '-' + pair[0];
      try { if (m.getLayer(id)) m.setPaintProperty(id, 'line-width', node.paint['line-width']); } catch (e) {}
    });
    clearTimeout(_layerStyleTimer);
    _layerStyleTimer = setTimeout(function () { saveLayerStyle(node.id); }, 500);
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
    // zoom-varied width (7/21): survives unrelated edits; moving the uniform width slider EXITS it
    var _wzExpr = (node.type === 'line' && node.paint && Array.isArray(node.paint['line-width']) && node.paint['line-width'][0] === 'interpolate') ? node.paint['line-width'] : null;
    // (8/14) line-offset survives the rebuild — buildLayerPaint knows nothing about it
    var _loffPrev = (node.type === 'line' && node.paint && node.paint['line-offset'] != null) ? node.paint['line-offset'] : null;
    node.paint = buildLayerPaint(node.type, color, op, outline, outlineVis, width, radius);
    if (field === 'offset') { if (value) node.paint['line-offset'] = value; else delete node.paint['line-offset']; }
    else if (_loffPrev != null) node.paint['line-offset'] = _loffPrev;
    if (field === 'width' && node.widthZoom) {
      delete node.widthZoom; _wzExpr = null;
      var _wzCb = document.getElementById('elp-wzoom-on'); if (_wzCb) { _wzCb.checked = false; var _wzBox = document.getElementById('elp-wzoom-box'); if (_wzBox) _wzBox.style.display = 'none'; }
    } else if (_wzExpr) { node.paint['line-width'] = _wzExpr; }
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
        saveSoft(patchLayerConfig(lid, { colorBy: null }), 'saving the colour').then(function () {}, function () {});
      })(slugToLayerDbId[node.id]);
    } else if (_colorExpr) {
      node.paint[_ck] = _colorExpr;
    }
    // ── "Match fill colors" (8/14): the border's colour tracks the fill's, recomputed after every
    //    paint rebuild so it can't drift. The flag is META (raw_config) — saveLayerStyle carries
    //    only color + paint, so it's persisted here.
    if (field === 'outlineMatch') {
      node.outlineMatchFill = !!value;
      setStyleMetaRC(slugToLayerDbId[node.id], 'outlineMatchFill', node.outlineMatchFill || null);
      // a split-off outline borrows its parent's colorBy too, so its own panel opens on that
      // column and the legend/back-colour lookups resolve
      if (node.outlineOf && node.outlineMatchFill) {
        var _pC = findNodeById(layers, node.outlineOf);
        if (_pC && _pC.colorBy) {
          node.colorBy = JSON.parse(JSON.stringify(_pC.colorBy));
          setStyleMetaRC(slugToLayerDbId[node.id], 'colorBy', node.colorBy);
        }
      }
    } else if (field === 'outline' && node.outlineMatchFill) {
      node.outlineMatchFill = false;   // hand-picking a border colour exits matching
      var _mCb2 = document.getElementById('elp-outline-match'); if (_mCb2) _mCb2.checked = false;
      setStyleMetaRC(slugToLayerDbId[node.id], 'outlineMatchFill', null);
    }
    if (node.outlineMatchFill) {
      var _pMatch = node.outlineOf ? findNodeById(layers, node.outlineOf) : null;
      if (node.outlineOf) { if (_pMatch) node.paint['line-color'] = fillColorValue(_pMatch); }
      else if (node.type === 'fill') node.paint['fill-outline-color'] = fillColorValue(node);
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
          // (8/14) colour-by owns line-color when active — repainting iconColor over the
          // categorical expression flattened a coloured border on every unrelated slider move
          if (node.colorBy && Array.isArray(pp['line-color'])) {
            // a DRAWN parent's outline source carries resolved colours, not data columns (see
            // addOutlineMapLayer) — pushing the column match there would paint the fallback
            var drawnParent = node.outlineOf && _drawLayerSlugs[node.outlineOf];
            var fbL = (node.iconColor && /^#[0-9a-fA-F]{6}$/.test(node.iconColor)) ? node.iconColor : '#3bb2d0';
            m.setPaintProperty(id, 'line-color', drawnParent ? ['to-color', ['coalesce', ['get', 'color'], fbL], fbL] : pp['line-color']);
          }
          else if (node.iconColor) m.setPaintProperty(id, 'line-color', node.iconColor);
          if (pp['line-width'] != null) m.setPaintProperty(id, 'line-width', pp['line-width']);
          m.setPaintProperty(id, 'line-offset', pp['line-offset'] != null ? pp['line-offset'] : 0);
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
        if (ml.type === 'line') { try { m.setPaintProperty(id, 'line-offset', tp['line-offset'] != null ? tp['line-offset'] : 0); } catch (e) {} }   // offset back to 0 needs an explicit reset — the keys loop skips deleted keys
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
    } else if (node.source_type === 'geojson-supabase' && !_drawLayerSlugs[node.id]) {
      // 7/21: ENGINE-rendered geojson (large or dated layers) — no MapboxDraw copies to repaint;
      // repaint the engine layers directly, exactly like tilesets. (Before this, styling a large
      // layer silently previewed nothing.)
      var gp = node.paint || {};
      [['left', beforeMap], ['right', (typeof afterMap !== 'undefined' ? afterMap : null)]].forEach(function (pair) {
        var m = pair[1]; if (!m) return; var id = node.id + '-' + pair[0]; var ml = m.getLayer(id); if (!ml) return;
        Object.keys(gp).forEach(function (k) { if (k.indexOf(ml.type + '-') === 0) { try { m.setPaintProperty(id, k, gp[k]); } catch (e) {} } });
        if (ml.type === 'line') { try { m.setPaintProperty(id, 'line-offset', gp['line-offset'] != null ? gp['line-offset'] : 0); } catch (e) {} }
        if (node.iconColor && !node.colorBy) { try { m.setPaintProperty(id, ml.type + '-color', node.iconColor); } catch (e) {} }
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
            if (node.outlineMatchFill) f.properties.outline = f.properties.color;   // border = this feature's own fill colour (8/14)
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
    try {
      var r = await db.from('layers').update({ color: node.iconColor || '#3bb2d0', paint: node.paint }).eq('id', lid); if (r.error) throw new Error(r.error.message); setStatus('Saved');
      // snapshot freshness includes style (8/19): the raster froze these colours/widths at bake
      // time — move the stamp so the panel's stale warning fires on restyles, not just data edits
      node.styleChangedAt = new Date().toISOString(); setStyleMetaRC(lid, 'styleChangedAt', node.styleChangedAt);
    }
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
    var lid = slugToLayerDbId[slug]; if (lid) await saveSoft(db.from('layers').update({ color: node.iconColor, paint: node.paint }).eq('id', lid), 'applying the style change');
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
      // the runtime node's fill-outline-color is BLANKED to transparent whenever a -stroke-
      // companion owns the border (any width ≠ 1, incl. the 0.5 default) — reading it raw made
      // every split outline layer INVISIBLE (8/8, caught by border-split-probe). The real colour
      // lives on the stroke companion (node.stroke) when the native one is blank.
      var poc = P.paint && P.paint['fill-outline-color'];
      if (isTransparentColor(poc)) poc = null;
      // …and the companion's own colour can be that same sentinel, read back off a stored paint
      // (8/14: the split came out invisible — "there is no line"). Refuse it at every step.
      var pstroke = P.stroke && P.stroke['line-color'];
      if (isTransparentColor(pstroke)) pstroke = null;
      // A colour-by'd (or match-fill) polygon hands its WHOLE colour expression to the border, plus
      // the colorBy meta itself, so the standalone outline layer comes out matching the polygons
      // instead of flattening to one colour (owner 8/14: "same color as the fills… totally what I
      // wanted"). Anything else keeps the border's own colour.
      var matchFill = !!(P.outlineMatchFill || (P.colorBy && P.colorBy.mapping));
      var color = matchFill ? fillColorValue(P) : (poc || pstroke || P.iconColor || '#3bb2d0');
      // the sidebar icon needs a real hex even when line-color is an expression
      var iconCol = (typeof color === 'string' && /^#[0-9a-fA-F]{6}$/.test(color)) ? color
        : ((P.iconColor && /^#[0-9a-fA-F]{6}$/.test(P.iconColor)) ? P.iconColor : '#3bb2d0');
      var owidth = (P.paint && P.paint['line-width']) || (isTs ? 1 : 2);
      var oNode;
      if (isTs) {
        // a tileset outline is a standalone LINE layer over the SAME vector source + source-layer
        var oid = uid();
        oNode = { id: oid, label: (P.label || 'Polygon') + ' outline', type: 'line', source: P.source, 'source-layer': P['source-layer'],
          paint: { 'line-color': color, 'line-width': owidth, 'line-opacity': 1 }, outlineOf: P.id, toggleElement: oid,
          containerId: 'cont-' + oid, className: oid, topLayerClass: oid, iconType: 'slash', iconColor: iconCol, isSolid: true, checked: true };
      } else {
        oNode = makeNode('layer', (P.label || 'Polygon') + ' outline');
        oNode.type = 'line';
        oNode.iconType = 'slash';
        oNode.outlineOf = P.id;                 // borrows the polygon's features → adapter draws its edges
        oNode.toggleElement = oNode.id;         // so refreshLayers toggles the outline's engine layer
        oNode.iconColor = iconCol;
        oNode.paint = { 'line-color': color, 'line-width': owidth, 'line-opacity': 1 };
      }
      // carried so the outline's own panel opens on the same column, and a later re-colour of
      // EITHER layer rebuilds from the same mapping (leafRow persists it into raw_config)
      if (matchFill && P.colorBy) { oNode.colorBy = JSON.parse(JSON.stringify(P.colorBy)); oNode.outlineMatchFill = true; }
      // place the outline layer next to the polygon, under the same parent
      var pParent = findParent(layers, P);
      var sId = null, gId = null;
      if (pParent && pParent.type === 'group') { gId = pParent._dbId; var ps = findParent(layers, pParent); if (ps && ps.type === 'section') sId = ps._dbId; }
      else if (pParent && pParent.type === 'section') { sId = pParent._dbId; }
      var oRow = leafRow(oNode);
      if (isTs) {
        // A split outline over a BAKED fill renders from the PARENT's tiles, so it has to be
        // stored pointing at them properly. Two things went wrong here (owner 8/7 — border gone
        // after splitting, and "nothing to bake"):
        //   · oNode.source came from the RUNTIME node, whose tile URL configLoader had already
        //     made absolute — so the row saved "http://localhost:8000/map/pmt/…", which is
        //     nobody else's address. Take the parent's STORED (site-relative) route instead.
        //   · the pmtiles archive stamp was never copied, and without it the pmt service worker
        //     has no archive to answer that route from: every tile 404s and the layer draws
        //     nothing. Meanwhile the fill had already stopped drawing its own border (that is
        //     what outlineSplit means), so the border vanished entirely.
        // It owns no features of its own by design — it draws the parent's edges — which is also
        // why baking it reported "nothing to bake"; carrying the parent's stamps says "already
        // tiled" so it renders instead of asking to be baked.
        var pLid0 = slugToLayerDbId[P.id];
        if (pLid0) {
          var pr0 = await db.from('layers').select('source_url, source_layer, source_minzoom, source_maxzoom, raw_config').eq('id', pLid0).single();
          if (!pr0.error && pr0.data) {
            var prc0 = pr0.data.raw_config || {};
            oRow.source_type = 'vector-tiles-url';
            oRow.source_url = pr0.data.source_url;
            oRow.source_layer = pr0.data.source_layer;
            oRow.source_minzoom = pr0.data.source_minzoom;
            oRow.source_maxzoom = pr0.data.source_maxzoom;
            oRow.raw_config = Object.assign({}, oRow.raw_config || {}, {
              pmtiles: prc0.pmtiles,
              tilesGeneratedAt: prc0.tilesGeneratedAt,
              tilesFeatureCount: prc0.tilesFeatureCount
            });
          }
        }
      }
      var oLayerId = await insertOne('layers', oRow);
      slugToLayerDbId[oNode.id] = oLayerId;
      await insertOne('project_layers', { project_id: projectId, layer_id: oLayerId, sort_order: nextSort++, section_id: sId, group_id: gId });
      // mark the polygon split (its auto-stroke is now handed off) + persist (merge, don't clobber raw_config)
      P.outlineSplit = true;
      var pLid = slugToLayerDbId[P.id];
      if (pLid) {
        var r = await patchLayerConfig(pLid, { outlineSplit: true }); if (r.error) throw new Error(r.error.message);
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
  // companions-ok: removes the auto-outline stroke ONLY — the O line layer replaces it.
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
          // this removes EVERY feature of the outline layer — a silent refusal here leaves rows
          // behind whose layer is about to be deleted, i.e. orphans that bill forever
          await saveSoft(db.from('features').delete().eq('layer_id', oLid), 'removing the outline layer features');
          var dp = await db.from('project_layers').delete().eq('project_id', projectId).eq('layer_id', oLid); if (dp.error) throw new Error(dp.error.message);
          var dl = await db.from('layers').delete().eq('id', oLid); if (dl.error) throw new Error(dl.error.message);
        }
      }
      // clear P.outlineSplit + persist P's restored paint (so the adapter re-emits its auto-stroke)
      var pLid = slugToLayerDbId[P.id];
      if (pLid) {
        // Two writes, and both are safe: the patch removes ONE key atomically, and `paint` is a
        // plain column, so updating it cannot clobber the blob the way a whole-blob write does.
        // The old code set raw_config to NULL when the last key went; it now leaves {}. Every reader
        // is `(… .raw_config) || {}`, so the two are indistinguishable downstream.
        var r = await patchLayerConfig(pLid, { outlineSplit: null });
        if (r.error) throw new Error(r.error.message);
        var rp = await db.from('layers').update({ paint: P.paint }).eq('id', pLid);
        if (rp.error) throw new Error(rp.error.message);
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
  // COMPANIONS CLOSED (8/25). This is ALWAYS the wide sweep now: every id a layer owns
  // (msLayerVariants — base, stroke, highlighted, label, edited; both swipe sides) plus the label
  // and edited-overlay sources. The 8/21 note that lived here said widening blindly would trade
  // the leak for vanished labels, because fold and re-source re-added via renderTilesetOnMap,
  // which does not rebuild labels. The same-change rule is satisfied: both those call sites now
  // follow the render with applyLabelLayers(node) and refreshEditedOverlay(node), so the re-add
  // is complete and the narrow branch (and its `all` parameter) is retired.
  function removeMapLayers(id) {
    [['left', beforeMap], ['right', (typeof afterMap !== 'undefined' ? afterMap : null)]].forEach(function (pair) {
      var m = pair[1]; if (!m) return; var side = pair[0], main = id + '-' + side;
      var ids = typeof msLayerVariants === 'function'
        ? msLayerVariants(id).filter(function (x) { return x.slice(-side.length) === side; })
        : [id + '-stroke-' + side, id + '-highlighted-' + side, id + '-label-' + side, id + '-edited-' + side, main];
      ids.forEach(function (lid) { try { if (m.getLayer(lid)) m.removeLayer(lid); } catch (e) {} });
      try { if (m.getSource(main)) m.removeSource(main); } catch (e) {}
      // the label layer rides its own anchor source (-labels-, not -label-), and the edited
      // overlay has one too; leaving those behind is what "source in use" errors are made of
      [id + '-labels-' + side, id + '-edited-' + side].forEach(function (sid) {
        try { if (m.getSource(sid)) m.removeSource(sid); } catch (e) {}
      });
    });
  }
  // Was a byte-identical copy of editorCurrentDate, 10,000 lines away in this same file — two
  // names for one rule, which is harder to spot than two files because nobody suspects a duplicate
  // inside one module. Found 8/21 by the boot-truth detector, not by reading.
  function currentMapDate() { return editorCurrentDate(); }
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
    // A geojson layer too big for MapboxDraw renders through the ENGINE, so the draw store holds
    // NOTHING for it — building the border from `draw` gave an empty source and the split produced
    // a layer that drew nothing at all (8/14, measured: 0 rendered features). Ride the parent's own
    // source instead: same geometry, real feature properties, so a colour-by match works verbatim.
    var usedEngine = false;
    [['left', beforeMap], ['right', (typeof afterMap !== 'undefined' ? afterMap : null)]].forEach(function (pair) {
      var side = pair[0], m = pair[1]; if (!m) return;
      var psrc = P.id + '-' + side;
      try { if (!m.getSource(psrc)) return; } catch (e) { return; }
      var id = oNode.id + '-' + side;
      try {
        if (m.getLayer(id)) m.removeLayer(id);
        if (m.getSource(id)) m.removeSource(id);
        var lyr = { id: id, type: 'line', source: psrc, paint: Object.assign({}, oNode.paint), layout: { 'line-cap': 'round', 'line-join': 'round' } };
        if (P['source-layer']) lyr['source-layer'] = P['source-layer'];
        m.addLayer(lyr);
        usedEngine = true;
      } catch (e) { console.warn('editing: engine outline layer failed', e); }
    });
    if (usedEngine) return;
    if (!draw) return;
    var dbId = slugToLayerDbId[P.id];
    var pFeats = Object.keys(featureLayer).filter(function (d) { return featureLayer[d] === dbId; }).map(function (d) { return draw.get(d); }).filter(Boolean);
    // Each polygon's OWN colour rides along (8/14). MapboxDraw features carry resolved styling,
    // not data columns, so a match-on-column expression has nothing to read here — but every
    // feature already knows the colour colour-by gave it, so the border reads that directly and
    // a split-off outline comes out matching the fills instead of drawing one flat colour.
    var fc = { type: 'FeatureCollection', features: pFeats.map(function (f) {
      var fp = f.properties || {};
      return { type: 'Feature', geometry: f.geometry, properties: { DayStart: 0, DayEnd: 99999999, color: fp.color || null, outline: fp.outline || null } };
    }) };
    var oPaint = Object.assign({}, oNode.paint);
    if (Array.isArray(oPaint['line-color'])) {
      var fbC = (oNode.iconColor && /^#[0-9a-fA-F]{6}$/.test(oNode.iconColor)) ? oNode.iconColor : '#3bb2d0';
      oPaint['line-color'] = ['to-color', ['coalesce', ['get', 'color'], fbC], fbC];
    }
    [['left', beforeMap], ['right', (typeof afterMap !== 'undefined' ? afterMap : null)]].forEach(function (pair) {
      var side = pair[0], m = pair[1]; if (!m) return;
      var id = oNode.id + '-' + side;
      try {
        if (m.getLayer(id)) m.removeLayer(id);
        if (m.getSource(id)) m.removeSource(id);
        m.addLayer({ id: id, type: 'line', source: { type: 'geojson', data: fc }, paint: oPaint, layout: { 'line-cap': 'round', 'line-join': 'round' } });
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
    window.generateLayersPanel = function () { var r = _origGenPanel.apply(this, arguments); try { enhanceRows(); } catch (e) {} try { renderPortalNotes(); } catch (e2) {} return r; };
  }

  // ── PORTAL CAPTIONS (8/6, owner's design): when a map is added from the Portal, a plain line
  //    appears above the block it dropped in — "Added from Railways — 16 layers". It is NOT a
  //    node in the layer tree: it lives on projects.raw_config.portalNotes, so it cannot be
  //    dragged, cannot hold children, and never travels into the published view. Editing mode
  //    only. Clicking it offers to remove it, the way every other sidebar thing is removed. ──
  var _portalNotes = null;
  async function loadPortalNotes() {
    try {
      // MSBoot (8/25): the FIRST load rides the boot row configLoader already fetched. Any later
      // call (and every pre-write re-read below) stays a direct fetch — notes are edited in
      // session, and serving a stale raw_config to a writer is the lost-update family.
      var mb = window.MSBoot;
      var r = (_portalNotes === null && mb && mb.pid === projectId && Date.now() < mb.until)
        ? await mb.project
        : await db.from('projects').select('raw_config').eq('id', projectId).single();
      var rc = (r.data && r.data.raw_config) || {};
      _portalNotes = Array.isArray(rc.portalNotes) ? rc.portalNotes : [];
    } catch (e) { _portalNotes = []; }
    renderPortalNotes();
  }
  async function removePortalNote(noteId) {
    try {
      // rmw-ok: removing ONE item from an array genuinely needs the current array — merge-patch
      // replaces arrays wholesale, so there is nothing to patch with until we have read it.
      // Residual risk, stated rather than hidden: a note added by someone else between this read
      // and the write is dropped. Acceptable today (one editor per map); the real fix is a
      // server-side filter, and it is not worth an RPC for a path this rare.
      var r = await db.from('projects').select('raw_config').eq('id', projectId).single();
      var rc = (r.data && r.data.raw_config) || {};
      rc.portalNotes = (Array.isArray(rc.portalNotes) ? rc.portalNotes : []).filter(function (n) { return n.id !== noteId; });
      var up = await db.from('projects').update({ raw_config: rc }).eq('id', projectId);
      if (up.error) throw new Error(up.error.message);
      _portalNotes = rc.portalNotes;
      renderPortalNotes();
      setStatus('Label removed');
    } catch (e) { setStatus('Could not remove that label'); }
  }
  function renderPortalNotes() {
    var panel = document.getElementById('layers-panel-content');
    if (!panel || !_portalNotes) return;
    Array.prototype.forEach.call(panel.querySelectorAll('.ms-portal-note'), function (n) { n.remove(); });
    if (!document.getElementById('ms-portal-note-css')) {
      var st2 = document.createElement('style'); st2.id = 'ms-portal-note-css';
      st2.textContent = '.ms-portal-note{position:relative;margin:22px 0 10px;padding:10px 30px 10px 13px;' +
        'background:#f4f0fd;border:1px solid #d9cff1;border-left:5px solid #7c5cbf;border-radius:8px;' +
        'cursor:pointer;user-select:none;line-height:1.4;}' +
        '.ms-portal-note:first-child{margin-top:6px;}' +
        '.ms-portal-note:hover{background:#ece5fb;border-color:#c3b2e8;}' +
        '.ms-portal-note .kicker{display:block;font-size:10px;font-weight:800;letter-spacing:.09em;' +
        'text-transform:uppercase;color:#7c5cbf;margin-bottom:3px;}' +
        '.ms-portal-note .body{display:block;font-size:13.5px;font-weight:700;color:#2e2748;}' +
        '.ms-portal-note .x{position:absolute;top:8px;right:9px;font-size:13px;color:#9a8fc4;opacity:.65;}' +
        '.ms-portal-note:hover .x{opacity:1;color:#7c5cbf;}';
      document.head.appendChild(st2);
    }
    _portalNotes.forEach(function (n) {
      var el = document.createElement('div');
      el.className = 'ms-portal-note';
      el.title = 'Click to remove this label (the layers stay)';
      var k = document.createElement('span'); k.className = 'kicker'; k.textContent = 'From the Portal';
      var t = document.createElement('span'); t.className = 'body'; t.textContent = n.text || 'Added from another map';
      var x = document.createElement('span'); x.className = 'x'; x.textContent = '✕';
      el.appendChild(k); el.appendChild(t); el.appendChild(x);
      el.addEventListener('click', function (e) {
        e.stopPropagation();
        if (window.confirm('Remove this label?\n\n"' + (n.text || '') + '"\n\nThe layers it points at stay exactly where they are.')) removePortalNote(n.id);
      });
      // Sit above THIS block's own first item. The anchor is that item's node id (a section,
      // group or layer slug — all unique per add since 8/6). Three ways to find its element,
      // because sections, groups and layers render differently:
      //   1. the row enhanceRows tagged with data-node-id
      //   2. an element whose id IS the slug (layer checkboxes)
      //   3. a container element named after it (cont-<slug>)
      // Only when none of those exist (the anchor was deleted) does it fall back to the top —
      // that fallback is what put a caption above everything else (owner report 8/6).
      var anchor = null;
      if (n.anchorSlug) {
        var seed = panel.querySelector('[data-node-id="' + n.anchorSlug + '"]') ||
                   document.getElementById(n.anchorSlug) ||
                   document.getElementById('cont-' + n.anchorSlug);
        if (seed && !panel.contains(seed)) seed = null;
        anchor = seed;
        while (anchor && anchor.parentElement && anchor.parentElement !== panel) anchor = anchor.parentElement;
        if (anchor && anchor.parentElement !== panel) anchor = null;
      }
      if (anchor) panel.insertBefore(el, anchor);
      else if (n.anchorSlug) return;   // its block is gone — say nothing rather than float to the top
      else panel.insertBefore(el, panel.firstChild);
    });
  }

  // ── EDITING LOCK (7/22, user: "keep original maps totally intact — only edit copies").
  //    projects.raw_config.editLock — toggled ONLY in map Settings; the dashboard just shows it.
  //    A locked map's editor page wires NO edit machinery at all: the engine underneath keeps
  //    rendering (viewing works), and this panel offers view / copy / deliberate unlock.
  function showLockPanel() {
    if (document.getElementById('ms-lock-panel')) return;
    window.__msEditLocked = true;
    var d = document.createElement('div');
    d.id = 'ms-lock-panel';
    d.style.cssText = 'position:fixed;left:50%;top:64px;transform:translateX(-50%);z-index:6500;background:#fff;border:2px solid #b4453a;border-radius:12px;box-shadow:0 10px 34px rgba(0,0,0,.3);padding:14px 18px;font-family:"Source Sans Pro",Arial,sans-serif;font-size:14px;color:#1e1b2e;max-width:440px;text-align:center;';
    d.innerHTML = '<div style="font-weight:800;font-size:16px;margin-bottom:4px;">🔒 This map is locked</div>' +
      '<div style="color:#6b6680;margin-bottom:10px;">Viewing works; editing is off to protect the original. Make a copy to edit, or unlock deliberately.</div>' +
      '<div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap;">' +
      '<button id="ms-lock-copy" style="padding:7px 13px;border:none;border-radius:7px;background:#7c5cbf;color:#fff;font-weight:700;cursor:pointer;">&#10697; Make an editable copy</button>' +
      '<a id="ms-lock-view" href="index.html' + location.search + '" style="padding:7px 13px;border:1px solid #bbbbbb;border-radius:7px;background:#fff;color:#222;font-weight:600;text-decoration:none;">Open the viewer</a>' +
      '<button id="ms-lock-unlock" style="padding:7px 13px;border:1px solid #e0b4b4;border-radius:7px;background:#fdeaea;color:#b4453a;font-weight:700;cursor:pointer;">🔓 Unlock &amp; edit…</button></div>' +
      '<div id="editor-save-status" style="margin-top:8px;font-size:12px;color:#6b6680;"></div>';   // setStatus funnel → copy progress shows here
    document.body.appendChild(d);
    document.getElementById('ms-lock-copy').addEventListener('click', function () { copyMapToMyAccount(); });
    document.getElementById('ms-lock-unlock').addEventListener('click', async function () {
      if (!window.confirm('Unlock this map for editing? It stays unlocked until you lock it again in Settings.')) return;
      try {
        var u = await patchProjectConfig({ editLock: null });   // null deletes the key
        if (u.error) throw new Error(u.error.message);
        location.reload();
      } catch (e) { alert('Unlock failed: ' + (e && e.message)); }
    });
  }
  // ── A18 concurrency lock (ms_edit_locks): one live editor per map, DB-enforced. The client
  //    half is courtesy — acquire before wiring, heartbeat every 30s (TTL 90s), banner while
  //    someone else holds it, release on leave. FAIL-OPEN when the RPC isn't there yet (SQL
  //    not applied / rights refused): the editor must never brick on deploy order, and the
  //    write POLICIES are the real enforcement anyway. ──
  var MSEditLock = {
    // STABLE PER TAB, NOT PER PAGE LOAD (8/7). A fresh random id on every load meant a REFRESH
    // locked you out of your own map: the previous load's id still holds the lock for the 90-second
    // TTL, and the pagehide release is fire-and-forget — browsers routinely cancel it mid-unload.
    // So the owner saw "Your other window is editing — changes won't save" with a single window
    // open, on and off, for a minute and a half after every refresh, and I had been telling them to
    // refresh all session. sessionStorage is exactly the right lifetime: it survives a reload in
    // THIS tab and is never shared with another tab, so a genuine second window still gets its own
    // id and still reports honestly — which is the rule the lock was meant to express.
    sid: (function () {
      var K = 'ms_editlock_sid';
      try {
        var v = sessionStorage.getItem(K);
        if (!v) { v = Math.random().toString(36).slice(2, 10); sessionStorage.setItem(K, v); }
        return v;
      } catch (e) { return Math.random().toString(36).slice(2, 10); }   // private mode → previous behaviour
    })(),
    held: false, _iv: null,
    async boot(pid) {
      if (!pid || !db) return;
      var sess = null; try { sess = (await db.auth.getSession()).data.session; } catch (e0) {}
      if (!sess) return;                                   // no session → viewer posture, no lock
      var self = this;
      async function tick() {
        var r = null;
        try { r = await db.rpc('ms_acquire_edit_lock', { p_project: pid, p_sid: self.sid }); } catch (e1) { r = { error: e1 }; }
        if (r.error) { self.stop(); return; }              // fn missing or not an editor — fail open, stop nagging
        var d = r.data || {};
        self.held = !!d.ok;
        self.banner(d.ok ? null : d);
        if (d.ok && d.took_over) setStatus('Edit lock taken over (previous editor idle)');
      }
      await tick();
      if (this._iv == null) this._iv = setInterval(tick, 30000);
      window.addEventListener('pagehide', function () {
        try { db.rpc('ms_release_edit_lock', { p_project: pid, p_sid: self.sid }); } catch (e2) {}
      });   // fire-and-forget; the 90s TTL is the real cleanup for abandoned locks
    },
    stop() { if (this._iv != null) { clearInterval(this._iv); this._iv = null; } this.banner(null); },
    // A small chip in the bottom-left corner, above the timeline. It sat inside the sidebar for
    // one revision and rendered as a full-width header — reverted 8/6 at the owner's word.
    // pointer-events:none means it can never intercept a click; detail lives in the tooltip.
    banner(d) {
      var el = document.getElementById('ms-editlock-bar');
      if (!d) { if (el) el.remove(); return; }
      if (!el) {
        el = document.createElement('div');
        el.id = 'ms-editlock-bar';
        el.style.cssText = 'position:fixed;left:12px;bottom:96px;z-index:6400;background:#fff8ec;border:1px solid #e3c07a;' +
          'border-radius:16px;box-shadow:0 2px 8px rgba(0,0,0,0.12);padding:4px 11px;max-width:280px;pointer-events:none;' +
          'font-family:Source Sans Pro,Arial,sans-serif;font-size:11.5px;line-height:1.35;color:#7a6320;white-space:nowrap;' +
          'overflow:hidden;text-overflow:ellipsis;opacity:.92;';
        document.body.appendChild(el);
      }
      var who = d.same_user ? 'Your other window' : (d.username || 'Another editor');
      el.textContent = '🔒 ' + who + ' is editing — changes won\'t save';
      el.title = who + ' holds the edit lock on this map, so anything you change here will not be saved. ' +
        'It clears by itself once they finish or close the map (checked every 30 seconds).';
    }
  };

  (async function bootGate() {
    var locked = false;
    try {
      if (projectId && db) {
        // MSBoot (8/25): boot-window share of the row configLoader fetched
        var mbL = window.MSBoot;
        var lr = (mbL && mbL.pid === projectId && Date.now() < mbL.until)
          ? await mbL.project
          : await db.from('projects').select('raw_config').eq('id', projectId).single();
        locked = !!(lr.data && lr.data.raw_config && lr.data.raw_config.editLock);
      }
    } catch (eLk) {}
    if (locked) { showLockPanel(); return; }   // NOTHING below runs — no edit wiring, no draw, no writes
    // 80% STORAGE LOCKDOWN (7/23): when the platform database crosses 80% of the Pro plan, the
    // editor refuses to boot into editing for EVERYONE (admin included) — the map still renders
    // for viewing. auth.js computes the flag; we wait for its check before wiring anything.
    try { if (window.MSStorageGuard && MSStorageGuard.ready) await MSStorageGuard.ready; } catch (eSg) {}
    if (window.__msStorageLockdown) {
      var sl = window.__msStorageLockdown;
      var pnl = document.createElement('div');
      pnl.id = 'ms-storage-lock-panel';
      pnl.style.cssText = 'position:fixed;top:70px;left:50%;transform:translateX(-50%);z-index:6500;background:#fff;border:2px solid #b4453a;border-radius:12px;box-shadow:0 14px 50px rgba(0,0,0,0.35);padding:16px 22px;width:440px;max-width:92vw;font-family:Source Sans Pro,Arial,sans-serif;color:#2a2a33;';
      pnl.innerHTML = '<div style="font-size:17px;font-weight:800;color:#b4453a;">⛔ Editing paused — platform storage at ' + Math.round(sl.frac * 100) + '%</div>' +
        '<p style="margin:8px 0 0;font-size:13.5px;line-height:1.5;">The database is past the 80% safety line, so all editing is paused site-wide until space is cleared. Viewing still works. To clear space: delete unwanted maps/copies, sweep orphan datasets in <a href="../manage-datasets.html" style="color:#7c5cbf;">Manage datasets</a>, then run <code>VACUUM FULL;</code> in the Supabase SQL editor.</p>';
      document.body.appendChild(pnl);
      return;   // no edit wiring, no draw, no writes — same posture as the map lock
    }
    try { await MSEditLock.boot(projectId); } catch (eEl2) {}   // A18 — courtesy half; policies enforce
    start();
    (function whenReady() {
      if (document.getElementById('layers-panel-content')) { injectChrome(); enhanceRows(); loadPortalNotes(); loadProjectChrome(); setupInPlaceEditing(); var _mtries = 0; var _miv = setInterval(function () { patchMapsRender(); var sec = document.getElementById('base-maps-section'); var has = sec && sec.querySelector('.layer-list-row'); if (has) { injectMapsChrome(); enhanceMapRows(); } if ((window.__mapsRenderPatched && has) || ++_mtries > 30) clearInterval(_miv); }, 400); }
      else setTimeout(whenReady, 150);
    })();
    (function waitForMap() {
      if (typeof beforeMap !== 'undefined' && beforeMap && typeof MapboxDraw !== 'undefined') setupDraw();
      else setTimeout(waitForMap, 250);
    })();
  })();
})();
