// MapStructor — the Portal window (Map Portal component 1, plan step 4).
// A "Portal" button above the editor's layer panel opens a small window with three parts:
// Portal Bookmarks · My Maps · Open Portal. "Add" on any map shows its layers with a per-layer
// mode choice, then merges the whole map into the CURRENT one as a block of top-level sections
// at the very top of the list.
//
// The three modes (portal-plan.md §1 — settled 8/5):
//   All      — your own full copy: MSCopyEngine.copyLayerInto, the exact engine ⧉ Copy-map uses
//   Linked   — the source's geometry + columns, live and read-only; your styling/settings; 0 bytes
//   Instance — a locked mirror (styleLocked marks it; enforcement deepens in plan step 5)
// Both mirror modes keep the source's tile/parquet stamps (they RENDER from the source's
// artifacts), keep rasterYears (cross-map: the source isn't in this map to draw the raster),
// and stamp raw_config._msFromMap for provenance. After the merge the page reloads to wire the
// new layers up — the same accepted pattern as Create-instance (editing.js onCreateInstance).
(function () {
  'use strict';
  if (window.MSPortalAdd) return;
  if (location.pathname.indexOf('editor.html') === -1) return;
  var projectId = new URLSearchParams(location.search).get('id');
  if (!projectId) return;

  var css =
    '#ms-portal-panel{position:fixed;top:60px;left:50%;transform:translateX(-50%);width:440px;max-width:94vw;max-height:76vh;overflow:auto;background:#fff;border:1px solid #cbc0e4;border-radius:12px;box-shadow:0 10px 34px rgba(30,27,46,.25);z-index:3000;font:13px/1.45 "Source Sans Pro",Arial,sans-serif;color:#2a2440;}' +
    '#ms-portal-panel .pp-head{display:flex;justify-content:space-between;align-items:center;padding:12px 14px;border-bottom:1px solid #eee;font-weight:700;font-size:14px;}' +
    '#ms-portal-panel .pp-x{cursor:pointer;border:none;background:none;font-size:16px;color:#888;}' +
    '#ms-portal-panel .pp-sec{padding:10px 14px 2px;font-weight:700;font-size:11px;letter-spacing:.06em;color:#9083ad;text-transform:uppercase;}' +
    '#ms-portal-panel .pp-row{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid #f0edf8;}' +
    '#ms-portal-panel .pp-row:hover{background:#faf8ff;}' +
    '#ms-portal-panel .pp-row .nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
    '#ms-portal-panel .pp-add{padding:4px 12px;border:1px solid #7c5cbf;border-radius:6px;background:#fff;color:#7c5cbf;font-weight:700;cursor:pointer;}' +
    '#ms-portal-panel .pp-add:hover{background:#7c5cbf;color:#fff;}' +
    '#ms-portal-panel .pp-empty{padding:8px 14px;color:#9a94ad;font-size:12.5px;}' +
    '#ms-portal-panel .pp-foot{padding:10px 14px;display:flex;gap:10px;align-items:center;justify-content:space-between;}' +
    '#ms-portal-panel .pp-go{padding:8px 16px;border:none;border-radius:7px;background:#7c5cbf;color:#fff;font-weight:700;cursor:pointer;}' +
    '#ms-portal-panel .pp-go[disabled]{opacity:.55;cursor:default;}' +
    '#ms-portal-panel table{width:100%;border-collapse:collapse;}' +
    '#ms-portal-panel th{font-size:10.5px;color:#9083ad;text-transform:uppercase;letter-spacing:.05em;padding:6px 6px;text-align:left;}' +
    '#ms-portal-panel td{padding:9px 6px;border-top:1px solid #f0edf8;font-size:12.5px;line-height:1.4;}' +
    '#ms-portal-panel .pp-modes{margin:0;padding:0;list-style:none;}' +
    '#ms-portal-panel .pp-modes li{margin:5px 0;}' +
    '#ms-portal-panel .pp-lead{padding:12px 14px 4px;color:#6b6386;font-size:12.5px;line-height:1.55;}' +
    '#ms-portal-panel .pp-lead b{color:#3b3357;}' +
    '#ms-portal-panel .setall{display:block;margin-top:10px;padding-top:9px;border-top:1px solid #f0edf8;}' +
    '#ms-portal-panel .setall .grp{display:block;margin:5px 0;}' +
    '#ms-portal-panel td.md{text-align:center;white-space:nowrap;}' +
    '#ms-portal-panel .setall button{margin-left:6px;padding:2px 8px;border:1px solid #cbc0e4;border-radius:5px;background:#faf8ff;cursor:pointer;font-size:11px;}' +
    '#ms-portal-panel .pp-thumb{flex:0 0 52px;height:36px;border-radius:5px;background:linear-gradient(135deg,#efeaf8,#dfe8f6);background-size:cover;background-position:center;}' +
    '#ms-portal-panel .pp-view{padding:4px 10px;border:1px solid #cbc0e4;border-radius:6px;background:#faf8ff;color:#5c4a86;font-weight:700;text-decoration:none;font-size:12px;}' +
    '#ms-portal-panel .pp-view:hover{background:#efeaf8;}' +
    '#ms-portal-panel tr.off td{opacity:.45;}';
  var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  var db = null, me = null, panel = null;

  function esc(s) { return String(s == null ? '' : s).replace(/[<>&"]/g, function (c) { return ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]; }); }
  function close() { if (panel) { panel.remove(); panel = null; } }
  function shell(title) {
    close();
    panel = document.createElement('div'); panel.id = 'ms-portal-panel';
    panel.innerHTML = '<div class="pp-head"><span>' + esc(title) + '</span><button class="pp-x" title="Close">✕</button></div><div class="pp-body"></div>';
    panel.querySelector('.pp-x').onclick = close;
    document.body.appendChild(panel);
    return panel.querySelector('.pp-body');
  }

  // ── screen 1: STARRED maps only (user 8/5). Your own maps appear here too — once you've
  //    ★-ed them (from the map itself, the dashboard, a user page, or the portal). ──
  async function openList() {
    var body = shell('Map Portal');
    body.innerHTML = '<div class="pp-empty">Loading…</div>';
    db = db || (window.MapAuth && MapAuth.db);
    me = await MapAuth.currentUser();
    if (!me) { body.innerHTML = '<div class="pp-empty">Log in (or just start drawing — an anonymous session works too) to add maps.</div>'; return; }
    var bmIds = (await MSBookmarks.list()).filter(function (id) { return id !== projectId; });
    var bmRows = [];
    if (bmIds.length) {
      var r = await db.from('projects').select('id,name').in('id', bmIds);
      if (!r.error && r.data) bmRows = bmIds.map(function (id) { return r.data.find(function (p) { return p.id === id; }); }).filter(Boolean);
    }
    // thumbnails come from the portal listing (8/6) — a starred map that isn't in the portal
    // simply shows the neutral tile, same as the dashboard's Bookmarks strip
    var thumbs = {};
    if (bmIds.length) {
      try {
        var tr = await db.from('portal_entries').select('project_id,thumb').in('project_id', bmIds);
        ((tr && tr.data) || []).forEach(function (e) { thumbs[e.project_id] = e.thumb; });
      } catch (eT) {}
    }
    var THUMB_OK = /^(data:image\/|images\/|\.\.\/images\/|https?:\/\/)/;
    function rows(list, empty) {
      if (!list.length) return '<div class="pp-empty">' + empty + '</div>';
      return list.map(function (p) {
        var t = thumbs[p.id];
        // portal thumbs are stored site-relative ("images/…"); this window lives under /map/
        if (t && t.indexOf('images/') === 0) t = '../' + t;
        var thumbStyle = (t && THUMB_OK.test(t)) ? 'background-image:url(\'' + esc(t).replace(/'/g, '%27') + '\');' : '';
        return '<div class="pp-row">' +
          '<span class="pp-thumb" style="' + thumbStyle + '"></span>' +
          '<span class="nm" title="' + esc(p.name) + '">' + esc(p.name || 'Untitled Map') + '</span>' +
          '<a class="pp-view" href="index.html?id=' + esc(p.id) + '" target="_blank" rel="noopener" title="Open this map in a new tab">View</a>' +
          '<button class="pp-add" data-id="' + p.id + '" data-name="' + esc(p.name || 'Untitled Map') + '">Add</button>' +
          '</div>';
      }).join('');
    }
    body.innerHTML =
      '<div class="pp-sec">★ Bookmarked maps</div>' + rows(bmRows, 'Nothing starred yet — ★ any map (yours included: star them on your dashboard or user page), or browse the portal.') +
      '<div class="pp-foot"><a href="../portal.html" target="_blank" rel="noopener" style="color:#7c5cbf;font-weight:700;text-decoration:none;">Open Portal ↗</a></div>';
    body.querySelectorAll('.pp-add').forEach(function (b) {
      b.onclick = function () { openPicker(b.getAttribute('data-id'), b.getAttribute('data-name')); };
    });
  }

  // ── screen 2: per-layer mode picker ───────────────────────────────────────
  // DOUBLE-ADD GUARD (8/6): adding the same map twice is almost always a mis-click — the layers
  // arrive again, storage is spent again, and the list doubles. Two independent traces are
  // checked because either can be cleared by hand: the caption written at add time
  // (raw_config.portalNotes[].fromMap) and the provenance stamp on every added layer
  // (raw_config._msFromMap). Warn once, and let the deliberate case through.
  async function alreadyAdded(srcId) {
    try {
      var pr = await db.from('projects').select('raw_config').eq('id', projectId).single();
      var notes = (pr.data && pr.data.raw_config && pr.data.raw_config.portalNotes) || [];
      if (notes.some(function (n) { return n && n.fromMap === srcId; })) return true;
    } catch (e) {}
    try {
      var r = await db.from('project_layers').select('layers(raw_config)').eq('project_id', projectId);
      return ((r && r.data) || []).some(function (x) {
        return x.layers && x.layers.raw_config && x.layers.raw_config._msFromMap === srcId;
      });
    } catch (e) { return false; }
  }

  async function openPicker(srcId, srcName) {
    var body = shell('Add “' + srcName + '”');
    body.innerHTML = '<div class="pp-empty">Loading its layers…</div>';
    // Which of this source's layers are ALREADY here? (8/6 — the owner re-added a map to get MORE
    // layers and got duplicates plus a second copy of every section instead.) Matched on the
    // _msFromLayer stamp, falling back to the name for blocks added before that stamp existed.
    // No confirm dialog any more: the picker itself now shows the situation and pre-unticks them.
    var here = {}, hereNames = {};
    try {
      var ex = await db.from('project_layers').select('layers(name, raw_config)').eq('project_id', projectId);
      ((ex && ex.data) || []).forEach(function (x) {
        var rc0 = (x.layers && x.layers.raw_config) || {};
        if (rc0._msFromMap !== srcId) return;
        if (rc0._msFromLayer) here[rc0._msFromLayer] = 1;
        if (x.layers.name) hereNames[String(x.layers.name).replace(/\s*\(view\)\s*$/, '')] = 1;
      });
    } catch (eH) {}
    function isHere(L) { return !!here[L.id] || !!hereNames[String(L.name || '').replace(/\s*\(view\)\s*$/, '')]; }
    var pls = await db.from('project_layers').select('layer_id, layers(id,name,r2_bytes,fold_state,source_type)').eq('project_id', srcId).order('sort_order');
    if (pls.error || !pls.data || !pls.data.length) { body.innerHTML = '<div class="pp-empty">Could not read that map’s layers' + (pls.error ? ' (' + esc(pls.error.message) + ')' : ' — it has none') + '.</div>'; return; }
    var rows = pls.data.filter(function (x) { return x.layers; });
    // 8/6: PICK WHICH LAYERS COME OVER. The ✓ column decides what is added at all; the
    // mode radios only matter for the layers you keep ticked.
    var html =
      '<div class="pp-lead">' +
      '<div style="margin-bottom:8px;">Tick the layers you want, then choose how each one comes over:</div>' +
      '<div id="pp-already" style="display:none;margin-bottom:8px;color:#b0691d;"></div>' +
      '<ul class="pp-modes">' +
      '<li><b>All</b> — your own full copy. Costs storage.</li>' +
      '<li><b>Linked</b> — their data, live and read-only. Your styling and your own columns. 0 bytes.</li>' +
      '<li><b>Instance</b> — a locked mirror, exactly as they made it. 0 bytes.</li>' +
      '</ul>' +
      '<span class="setall">' +
      '<span class="grp">Select: <button data-pick="all">All</button><button data-pick="none">None</button></span>' +
      '<span class="grp">Set mode: <button data-m="all">All</button><button data-m="linked">Linked</button><button data-m="instance">Instance</button></span>' +
      '</span></div>' +
      '<table><tr><th style="text-align:center;">✓</th><th>Layer</th><th style="text-align:center;">All</th><th style="text-align:center;">Linked</th><th style="text-align:center;">Instance</th></tr>' +
      rows.map(function (x, i) {
        var L = x.layers, mb = Math.round((L.r2_bytes || 0) / 1048576);
        var have = isHere(L);
        return '<tr data-i="' + i + '"><td class="md"><input type="checkbox" class="pp-pick" data-i="' + i + '" checked></td>' +
          '<td>' + esc(L.name || 'Layer') + (mb ? ' <span style="color:#9a94ad;">(' + mb + ' MB)</span>' : '') +
          (have ? '<span style="display:block;font-size:11px;color:#b0691d;">already in this map</span>' : '') + '</td>' +
          ['all', 'linked', 'instance'].map(function (m) {
            return '<td class="md"><input type="radio" name="pm-' + i + '" value="' + m + '"' + (m === 'linked' ? ' checked' : '') + ' data-lid="' + L.id + '"></td>';
          }).join('') + '</tr>';
      }).join('') + '</table>' +
      '<div class="pp-foot" style="align-items:flex-end;gap:14px;padding-top:14px;">' +
      '<span class="pp-empty" style="padding:0;line-height:1.5;" id="pp-note">Arrives at the top of your list,<br>keeping the map\'s own sections.</span>' +
      '<button class="pp-go" id="pp-go">Add to this map</button></div>';
    body.innerHTML = html;
    function syncPicks() {
      var n = 0;
      body.querySelectorAll('.pp-pick').forEach(function (c) {
        var tr = c.closest('tr');
        if (tr) tr.classList.toggle('off', !c.checked);
        if (c.checked) n++;
      });
      var go = document.getElementById('pp-go');
      if (go) { go.disabled = n === 0; go.textContent = n === rows.length ? 'Add to this map' : ('Add ' + n + ' layer' + (n === 1 ? '' : 's')); }
      if (!n) note('Tick at least one layer to add.');
      return n;
    }
    var haveCount = rows.filter(function (x) { return isHere(x.layers); }).length;
    if (haveCount) {
      var al = document.getElementById('pp-already');
      al.style.display = '';
      al.textContent = haveCount + ' layer' + (haveCount === 1 ? ' is' : 's are') +
        ' already in this map from an earlier add. Adding again makes a separate copy — untick any you do not want twice.';
    }
    body.querySelectorAll('.pp-pick').forEach(function (c) { c.onchange = syncPicks; });
    body.querySelectorAll('.setall button').forEach(function (b) {
      b.onclick = function () {
        var pick = b.getAttribute('data-pick');
        if (pick) { body.querySelectorAll('.pp-pick').forEach(function (c) { c.checked = pick === 'all'; }); syncPicks(); return; }
        var m = b.getAttribute('data-m');
        body.querySelectorAll('input[type=radio][value="' + m + '"]').forEach(function (r) { r.checked = true; });
      };
    });
    syncPicks();
    document.getElementById('pp-go').onclick = function () {
      var modes = {}, picked = {};
      rows.forEach(function (x, i) {
        var box = body.querySelector('.pp-pick[data-i="' + i + '"]');
        if (!box || !box.checked) return;                       // left behind on purpose
        picked[x.layers.id] = true;
        var sel = body.querySelector('input[name=pm-' + i + ']:checked');
        modes[x.layers.id] = sel ? sel.value : 'linked';
      });
      if (!Object.keys(picked).length) { note('Tick at least one layer to add.'); return; }
      run(srcId, srcName, modes, this, picked);
    };
  }

  // ── the merge ─────────────────────────────────────────────────────────────
  function stripRow(row, extra) { var o = {}; Object.keys(row).forEach(function (k) { if (k === 'id' || k === 'created_at' || k === 'updated_at' || (extra && extra.indexOf(k) > -1)) return; o[k] = row[k]; }); return o; }
  function note(msg) { var n = document.getElementById('pp-note'); if (n) n.textContent = msg; }

  function mirrorRow(L, srcId, locked) {
    var slug = L.slug + (locked ? '-i' : '-l') + Math.random().toString(36).slice(2, 7);
    var rc = JSON.parse(JSON.stringify(L.raw_config || {}));
    rc._msFromMap = srcId;
    rc._msFromLayer = L.id;   // which source layer this mirrors — lets the picker spot re-adds
    rc.containerId = 'cont-' + slug; rc.className = slug; rc.topLayerClass = slug; rc.toggleElement = slug;
    delete rc.editorOnly; delete rc.foldError;
    // KEEP rasterYears (cross-map — no same-map source to draw the scrub raster) and KEEP the
    // tile/parquet stamps: a mirror RENDERS FROM the source's artifacts; that's the whole point.
    if (L.source_type === 'geojson-supabase' && L.fold_state !== 'folded' && !rc.pmtiles) {
      rc.instanceOf = L.id;            // live rows resolve through the source layer (configLoader)
    }
    rc.editable = false;               // feature/geometry editing off — the source owns the data
    if (locked) rc.styleLocked = true; // Instance = locked mirror (enforcement deepens in step 5)
    var row = stripRow(L);
    row.slug = slug; row.raw_config = rc;
    row.r2_bytes = 0;                  // mirrors own no bytes — the artifacts stay the source's
    row.user_id = me.id;               // the ADDER owns the placement row
    if (locked) row.name = (L.name || 'Layer') + ' (view)';
    return row;
  }

  // `picked` (8/6) = the set of source layer ids the user ticked; anything else is skipped,
  // and containers that end up empty are not created at all.
  async function run(srcId, srcName, modes, goBtn, picked) {
    goBtn.disabled = true; goBtn.textContent = 'Adding…';
    var made = null;
    try {
      // full source pull (features are NOT prefetched — copyLayerInto pages them itself)
      var s = await db.from('layer_sections').select('*').eq('project_id', srcId).order('sort_order');
      var g = await db.from('layer_groups').select('*').eq('project_id', srcId).order('sort_order');
      var l = await db.from('project_layers').select('*, layers(*)').eq('project_id', srcId).order('sort_order');
      if (s.error || g.error || l.error) throw new Error((s.error || g.error || l.error).message);
      var pls = (l.data || []).filter(function (x) { return x.layers && (!picked || picked[x.layers.id]); });
      if (!pls.length) throw new Error('no layers were selected');

      // ── step 6: quota pre-check BEFORE any writes — an All-heavy add refuses cleanly up
      //    front, never dies halfway. Only feature-copying All layers count NOW (live geojson /
      //    converted tiles); folded All layers arrive as 0-byte pointers and bill their full
      //    size at first Publish instead (the COW moment, which carries its own warning). ──
      var copyingIds = pls.filter(function (x) {
        var L0 = x.layers, m0 = modes[L0.id] || 'linked';
        return m0 === 'all' && L0.fold_state !== 'folded' && (L0.source_type === 'geojson-supabase' || (L0.raw_config && L0.raw_config.pmtiles));
      }).map(function (x) { return x.layers.id; });
      var P = window.MapStructorPricing || window.MSPricing;   // pricing.js exports MapStructorPricing
      if (copyingIds.length && P) {
        note('Checking storage room…');
        var est = 0;
        for (var q = 0; q < copyingIds.length; q++) {
          var cq = await db.from('features').select('feature_id', { count: 'exact', head: true }).eq('layer_id', copyingIds[q]);
          est += (cq.count || 0) * 600;   // rough bytes/row — a pre-check, not an invoice
        }
        if (est > 0) {
          var tier = 'free';
          try { var mp = await db.rpc('ms_my_plan'); var mp0 = mp && mp.data && (mp.data[0] || mp.data); if (!mp.error && mp0 && mp0.subscription_tier) tier = mp0.subscription_tier; } catch (e0) {}
          var used = 0;
          try { var ur = await db.rpc('mapstructor_user_storage'); if (!ur.error && typeof ur.data === 'number') used = ur.data; } catch (e1) {}
          var quota = P.stepFor(tier).quotaBytes;
          if (quota && used + est > quota) {
            note('Not enough storage: the "All" choices copy ~' + Math.max(1, Math.round(est / 1048576)) + ' MB now, but only ' + Math.max(0, Math.round((quota - used) / 1048576)) + ' MB is free on your plan. Switch heavy layers to Linked (0 bytes) or upgrade.');
            goBtn.disabled = false; goBtn.textContent = 'Add to this map';
            return;
          }
        }
      }

      // the incoming block lands ABOVE everything: base sort = target's minimum − 1000
      var mins = await Promise.all(['layer_sections', 'layer_groups', 'project_layers'].map(function (t) {
        return db.from(t).select('sort_order').eq('project_id', projectId).order('sort_order', { ascending: true }).limit(1);
      }));
      var minSort = 0;
      mins.forEach(function (r) { if (!r.error && r.data && r.data[0] && typeof r.data[0].sort_order === 'number') minSort = Math.min(minSort, r.data[0].sort_order); });
      var base = minSort - 1000;

      // only bring containers that still hold something after the tick-list (8/6) — an empty
      // section arriving from a partial add is confusing clutter
      var usedGrp = {}, usedSec = {};
      pls.forEach(function (x) { if (x.group_id) usedGrp[x.group_id] = 1; if (x.section_id) usedSec[x.section_id] = 1; });
      var srcGroups = (g.data || []).filter(function (x) { return usedGrp[x.id]; });
      srcGroups.forEach(function (x) { if (x.section_id) usedSec[x.section_id] = 1; });
      var srcSections = (s.data || []).filter(function (x) { return usedSec[x.id]; });
      g = { data: srcGroups }; s = { data: srcSections };

      // VERBATIM (8/6): the map arrives exactly as it is — its own sections and groups, and its
      // loose layers staying loose at the top level. No invented wrapper section; a plain caption
      // above the block says where it came from (editing mode only — see editing.js portalNotes).
      var maps = { secMap: {}, grpMap: {}, layerIdMap: {}, slugMap: {} };
      var sort = base;
      // Everything this add creates, so a failure halfway can be UNDONE. Before this, a write
      // that died mid-loop left sections with nothing in them and a half-imported map that
      // looked like the add had "replaced" things (owner report 8/6).
      made = { sections: [], groups: [], layers: [], links: [] };
      // EVERY ADD IS ITS OWN BLOCK (owner 8/6: "They should be new additions, entirely, nothing
      // should be combined"). Each section/group is created fresh — and with a FRESH SLUG,
      // because the engine keys its tree nodes by slug: reusing the source's slug made a second
      // add collide with the first one's sections, which is what looked like merging.
      var firstAnchor = null;   // the slug of this block's first top-level thing — the caption sits above it
      for (var i = 0; i < (s.data || []).length; i++) {
        var srcSec = s.data[i];
        var ns = stripRow(srcSec); ns.project_id = projectId; ns.sort_order = sort++;
        ns.slug = (srcSec.slug || 'sec') + '-p' + Math.random().toString(36).slice(2, 7);
        ns.raw_config = Object.assign({}, ns.raw_config || {}, { _msFromMap: srcId, _msFromSection: srcSec.id });
        var rs = await db.from('layer_sections').insert(ns).select('id').single();
        if (rs.error) throw new Error('section "' + (srcSec.name || '') + '": ' + rs.error.message);
        maps.secMap[srcSec.id] = rs.data.id; made.sections.push(rs.data.id);
        if (!firstAnchor) firstAnchor = ns.slug;
      }
      for (var j = 0; j < (g.data || []).length; j++) {
        var srcGrp = g.data[j];
        var ng = stripRow(srcGrp); ng.project_id = projectId;
        ng.section_id = srcGrp.section_id ? (maps.secMap[srcGrp.section_id] || null) : null;
        if (!ng.section_id) ng.sort_order = sort++;   // a top-level group keeps its place in the block
        ng.slug = (srcGrp.slug || 'grp') + '-p' + Math.random().toString(36).slice(2, 7);   // fresh: node ids are slugs
        ng.raw_config = Object.assign({}, ng.raw_config || {}, { _msFromMap: srcId, _msFromGroup: srcGrp.id });
        var rg = await db.from('layer_groups').insert(ng).select('id').single();
        if (rg.error) throw new Error('group "' + (srcGrp.name || '') + '": ' + rg.error.message);
        maps.grpMap[srcGrp.id] = rg.data.id; made.groups.push(rg.data.id);
        if (!firstAnchor && !ng.section_id) firstAnchor = ng.slug;
      }

      // layers, each by its chosen mode
      var added = [], feats = 0, firstSlug = null;
      for (var k = 0; k < pls.length; k++) {
        var pl = pls[k], L = pl.layers, mode = modes[L.id] || 'linked';
        note('Adding ' + (k + 1) + '/' + pls.length + ' — ' + (L.name || 'layer'));
        // a loose layer stays loose, but must land at the TOP of the target's list, not wherever
        // its source sort_order happens to point
        if (!pl.section_id && !pl.group_id) pl = Object.assign({}, pl, { sort_order: sort++ });
        if (mode === 'all') {
          feats += await MSCopyEngine.copyLayerInto(pl, projectId, maps, me.id);
          added.push({ lid: maps.layerIdMap[L.id], all: true });
          if (maps.layerIdMap[L.id]) made.layers.push(maps.layerIdMap[L.id]);
          if (!firstSlug && maps.slugMap[L.slug]) firstSlug = maps.slugMap[L.slug];
        } else {
          var row = mirrorRow(L, srcId, mode === 'instance');
          var ins = await db.from('layers').insert(row).select('id').single();
          if (ins.error) throw new Error('layer "' + (L.name || '') + '": ' + ins.error.message);
          maps.layerIdMap[L.id] = ins.data.id; maps.slugMap[L.slug] = row.slug; made.layers.push(ins.data.id);
          var npl = stripRow(pl, ['layers']);
          npl.project_id = projectId; npl.layer_id = ins.data.id;
          npl.section_id = pl.section_id ? (maps.secMap[pl.section_id] || null) : null;
          npl.group_id = pl.group_id ? (maps.grpMap[pl.group_id] || null) : null;
          var rpl = await db.from('project_layers').insert(npl);
          if (rpl.error) throw new Error('placing "' + (L.name || '') + '": ' + rpl.error.message);
          added.push({ lid: ins.data.id, all: false });
          if (!firstSlug) firstSlug = row.slug;
        }
      }

      // the caption (8/6): a plain line above the block saying where these layers came from.
      // It lives on the PROJECT (raw_config.portalNotes), not in the layer tree — nothing can be
      // dropped into it, it cannot be dragged, and clicking it offers to remove it. Editing mode
      // only, by the owner's call; read-merge-write so other project chrome is never clobbered.
      try {
        var pr = await db.from('projects').select('raw_config').eq('id', projectId).single();
        var prc = (pr.data && pr.data.raw_config) || {};
        var notes = Array.isArray(prc.portalNotes) ? prc.portalNotes.slice() : [];
        notes.push({
          id: 'pn' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
          text: 'Added from ' + (srcName || 'another map') + ' — ' + added.length + ' layer' + (added.length === 1 ? '' : 's'),
          anchorSlug: firstAnchor || firstSlug || null,
          fromMap: srcId
        });
        prc.portalNotes = notes;
        await db.from('projects').update({ raw_config: prc }).eq('id', projectId);
      } catch (eNote) { console.warn('portal caption not saved', eNote); }

      // provenance on All-mode copies + cross-layer reference remap (instanceOf/outlineOf must
      // point INSIDE the added block for full copies — same rule as ⧉ Copy-map, 7/22)
      for (var m = 0; m < pls.length; m++) {
        var oL = pls[m].layers, newLid = maps.layerIdMap[oL.id];
        if (!newLid || (modes[oL.id] || 'linked') !== 'all') continue;
        var cur = await db.from('layers').select('raw_config').eq('id', newLid).single();
        var rc2 = (cur.data && cur.data.raw_config) || {};
        rc2._msFromMap = srcId;
        rc2._msFromLayer = oL.id;   // same stamp the mirrors carry, so re-adds are spotted here too
        if (rc2.instanceOf && maps.layerIdMap[rc2.instanceOf]) rc2.instanceOf = maps.layerIdMap[rc2.instanceOf];
        if (rc2.outlineOf && maps.slugMap[rc2.outlineOf]) rc2.outlineOf = maps.slugMap[rc2.outlineOf];
        await db.from('layers').update({ raw_config: rc2 }).eq('id', newLid);
      }

      note('Added ✓ (' + added.length + ' layers' + (feats ? ', ' + feats + ' features' : '') + ') — reloading…');
      setTimeout(function () { location.reload(); }, 700);
    } catch (e) {
      console.warn('portal add failed', e);
      var msg = (e && e.message) || String(e);
      // ROLL BACK (8/6): an add that dies partway used to leave its sections behind with nothing
      // in them, which read as "it created empty sections and replaced my layers". Undo in
      // reverse order — links, then layers, then groups, then sections — so nothing of this
      // attempt survives. The map is left exactly as it was before the click.
      var undone = { links: 0, layers: 0, groups: 0, sections: 0 };
      if (made) {
        note('Add failed — putting the map back…');
        try {
          if (made.layers.length) {
            var lr = await db.from('project_layers').delete().eq('project_id', projectId).in('layer_id', made.layers).select('id');
            undone.links = (lr && lr.data && lr.data.length) || 0;
            await db.from('features').delete().in('layer_id', made.layers);
            var dl = await db.from('layers').delete().in('id', made.layers).select('id');
            undone.layers = (dl && dl.data && dl.data.length) || 0;
          }
          if (made.groups.length) { var dg = await db.from('layer_groups').delete().in('id', made.groups).select('id'); undone.groups = (dg && dg.data && dg.data.length) || 0; }
          if (made.sections.length) { var ds = await db.from('layer_sections').delete().in('id', made.sections).select('id'); undone.sections = (ds && ds.data && ds.data.length) || 0; }
        } catch (eU) { console.warn('rollback incomplete', eU); }
      }
      var clean = made && undone.layers === made.layers.length && undone.sections === made.sections.length;
      note((clean ? 'Add failed and was undone — your map is unchanged. ' : 'Add failed. ') + msg);
      // and say it where it cannot be missed: the panel is small and easy to look past
      try {
        if (typeof showToast === 'function') showToast('Portal add failed: ' + msg + (clean ? ' — nothing was left behind.' : ' — some pieces may remain; reload and check.'), 14000);
        else alert('Portal add failed:\n\n' + msg + (clean ? '\n\nNothing was left behind — your map is unchanged.' : '\n\nSome pieces may remain. Reload and check.'));
      } catch (eT) {}
      goBtn.disabled = false; goBtn.textContent = 'Add to this map';
    }
  }

  // ── no button of our own: the ⊞ Portal button lives in the editor's add-things bar
  //    (editing.js showButtons — user 8/5: "along with the other layer add-related buttons")
  //    and calls MSPortalAdd.open(). Toggle behaviour: open again = close.
  window.MSPortalAdd = { open: function () { if (panel) close(); else openList(); } };
})();
