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
    '#ms-portal-panel .pp-row{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:7px 14px;border-bottom:1px solid #f4f2fa;}' +
    '#ms-portal-panel .pp-row .nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
    '#ms-portal-panel .pp-add{padding:4px 12px;border:1px solid #7c5cbf;border-radius:6px;background:#fff;color:#7c5cbf;font-weight:700;cursor:pointer;}' +
    '#ms-portal-panel .pp-add:hover{background:#7c5cbf;color:#fff;}' +
    '#ms-portal-panel .pp-empty{padding:8px 14px;color:#9a94ad;font-size:12.5px;}' +
    '#ms-portal-panel .pp-foot{padding:10px 14px;display:flex;gap:10px;align-items:center;justify-content:space-between;}' +
    '#ms-portal-panel .pp-go{padding:8px 16px;border:none;border-radius:7px;background:#7c5cbf;color:#fff;font-weight:700;cursor:pointer;}' +
    '#ms-portal-panel .pp-go[disabled]{opacity:.55;cursor:default;}' +
    '#ms-portal-panel table{width:100%;border-collapse:collapse;}' +
    '#ms-portal-panel th{font-size:10.5px;color:#9083ad;text-transform:uppercase;letter-spacing:.05em;padding:6px 6px;text-align:left;}' +
    '#ms-portal-panel td{padding:5px 6px;border-top:1px solid #f4f2fa;font-size:12.5px;}' +
    '#ms-portal-panel td.md{text-align:center;white-space:nowrap;}' +
    '#ms-portal-panel .setall button{margin-left:6px;padding:2px 8px;border:1px solid #cbc0e4;border-radius:5px;background:#faf8ff;cursor:pointer;font-size:11px;}';
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
    function rows(list, empty) {
      if (!list.length) return '<div class="pp-empty">' + empty + '</div>';
      return list.map(function (p) {
        return '<div class="pp-row"><span class="nm" title="' + esc(p.name) + '">' + esc(p.name || 'Untitled Map') + '</span><button class="pp-add" data-id="' + p.id + '" data-name="' + esc(p.name || 'Untitled Map') + '">Add</button></div>';
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
  async function openPicker(srcId, srcName) {
    var body = shell('Add “' + srcName + '”');
    body.innerHTML = '<div class="pp-empty">Loading its layers…</div>';
    var pls = await db.from('project_layers').select('layer_id, layers(id,name,r2_bytes,fold_state,source_type)').eq('project_id', srcId).order('sort_order');
    if (pls.error || !pls.data || !pls.data.length) { body.innerHTML = '<div class="pp-empty">Could not read that map’s layers' + (pls.error ? ' (' + esc(pls.error.message) + ')' : ' — it has none') + '.</div>'; return; }
    var rows = pls.data.filter(function (x) { return x.layers; });
    var html =
      '<div class="pp-empty" style="padding-top:10px;">Per layer: <b>All</b> = your own full copy (costs storage) · <b>Linked</b> = their data live, your styling &amp; columns, 0 bytes · <b>Instance</b> = locked mirror, 0 bytes.' +
      '<span class="setall" style="display:block;margin-top:6px;">Set all: <button data-m="all">All</button><button data-m="linked">Linked</button><button data-m="instance">Instance</button></span></div>' +
      '<table><tr><th>Layer</th><th style="text-align:center;">All</th><th style="text-align:center;">Linked</th><th style="text-align:center;">Instance</th></tr>' +
      rows.map(function (x, i) {
        var L = x.layers, mb = Math.round((L.r2_bytes || 0) / 1048576);
        return '<tr><td>' + esc(L.name || 'Layer') + (mb ? ' <span style="color:#9a94ad;">(' + mb + ' MB)</span>' : '') + '</td>' +
          ['all', 'linked', 'instance'].map(function (m) {
            return '<td class="md"><input type="radio" name="pm-' + i + '" value="' + m + '"' + (m === 'linked' ? ' checked' : '') + ' data-lid="' + L.id + '"></td>';
          }).join('') + '</tr>';
      }).join('') + '</table>' +
      '<div class="pp-foot"><span class="pp-empty" style="padding:0;" id="pp-note">Arrives as its own section(s) at the top of your list.</span><button class="pp-go" id="pp-go">Add to this map</button></div>';
    body.innerHTML = html;
    body.querySelectorAll('.setall button').forEach(function (b) {
      b.onclick = function () { var m = b.getAttribute('data-m'); body.querySelectorAll('input[type=radio][value="' + m + '"]').forEach(function (r) { r.checked = true; }); };
    });
    document.getElementById('pp-go').onclick = function () {
      var modes = {};
      rows.forEach(function (x, i) {
        var sel = body.querySelector('input[name=pm-' + i + ']:checked');
        modes[x.layers.id] = sel ? sel.value : 'linked';
      });
      run(srcId, srcName, modes, this);
    };
  }

  // ── the merge ─────────────────────────────────────────────────────────────
  function stripRow(row, extra) { var o = {}; Object.keys(row).forEach(function (k) { if (k === 'id' || k === 'created_at' || k === 'updated_at' || (extra && extra.indexOf(k) > -1)) return; o[k] = row[k]; }); return o; }
  function note(msg) { var n = document.getElementById('pp-note'); if (n) n.textContent = msg; }

  function mirrorRow(L, srcId, locked) {
    var slug = L.slug + (locked ? '-i' : '-l') + Math.random().toString(36).slice(2, 7);
    var rc = JSON.parse(JSON.stringify(L.raw_config || {}));
    rc._msFromMap = srcId;
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

  async function run(srcId, srcName, modes, goBtn) {
    goBtn.disabled = true; goBtn.textContent = 'Adding…';
    try {
      // full source pull (features are NOT prefetched — copyLayerInto pages them itself)
      var s = await db.from('layer_sections').select('*').eq('project_id', srcId).order('sort_order');
      var g = await db.from('layer_groups').select('*').eq('project_id', srcId).order('sort_order');
      var l = await db.from('project_layers').select('*, layers(*)').eq('project_id', srcId).order('sort_order');
      if (s.error || g.error || l.error) throw new Error((s.error || g.error || l.error).message);
      var pls = (l.data || []).filter(function (x) { return x.layers; });

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

      // sections: loose items (in no section) gather under one section named after the map
      var needLoose = pls.some(function (x) { return !x.section_id && !x.group_id; })
        || (g.data || []).some(function (x) { return !x.section_id; })
        || !(s.data || []).length;
      var maps = { secMap: {}, grpMap: {}, layerIdMap: {}, slugMap: {} };
      var sort = base;
      if (needLoose) {
        var ls = await db.from('layer_sections').insert({ project_id: projectId, name: srcName, sort_order: sort++ }).select('id').single();
        if (ls.error) throw new Error(ls.error.message);
        maps.secMap.__loose = ls.data.id;
      }
      for (var i = 0; i < (s.data || []).length; i++) {
        var ns = stripRow(s.data[i]); ns.project_id = projectId; ns.sort_order = sort++;
        var rs = await db.from('layer_sections').insert(ns).select('id').single();
        if (rs.error) throw new Error(rs.error.message);
        maps.secMap[s.data[i].id] = rs.data.id;
      }
      for (var j = 0; j < (g.data || []).length; j++) {
        var ng = stripRow(g.data[j]); ng.project_id = projectId;
        ng.section_id = g.data[j].section_id ? (maps.secMap[g.data[j].section_id] || null) : maps.secMap.__loose;
        var rg = await db.from('layer_groups').insert(ng).select('id').single();
        if (rg.error) throw new Error(rg.error.message);
        maps.grpMap[g.data[j].id] = rg.data.id;
      }

      // layers, each by its chosen mode
      var added = [], feats = 0;
      for (var k = 0; k < pls.length; k++) {
        var pl = pls[k], L = pl.layers, mode = modes[L.id] || 'linked';
        note('Adding ' + (k + 1) + '/' + pls.length + ' — ' + (L.name || 'layer'));
        if (!pl.section_id && !pl.group_id && maps.secMap.__loose) pl = Object.assign({}, pl, { section_id: '__loose' });
        if (mode === 'all') {
          feats += await MSCopyEngine.copyLayerInto(pl, projectId, maps, me.id);
          added.push({ lid: maps.layerIdMap[L.id], all: true });
        } else {
          var row = mirrorRow(L, srcId, mode === 'instance');
          var ins = await db.from('layers').insert(row).select('id').single();
          if (ins.error) throw new Error(ins.error.message);
          maps.layerIdMap[L.id] = ins.data.id; maps.slugMap[L.slug] = row.slug;
          var npl = stripRow(pl, ['layers']);
          npl.project_id = projectId; npl.layer_id = ins.data.id;
          npl.section_id = pl.section_id ? (maps.secMap[pl.section_id] || null) : null;
          npl.group_id = pl.group_id ? (maps.grpMap[pl.group_id] || null) : null;
          var rpl = await db.from('project_layers').insert(npl);
          if (rpl.error) throw new Error(rpl.error.message);
          added.push({ lid: ins.data.id, all: false });
        }
      }

      // provenance on All-mode copies + cross-layer reference remap (instanceOf/outlineOf must
      // point INSIDE the added block for full copies — same rule as ⧉ Copy-map, 7/22)
      for (var m = 0; m < pls.length; m++) {
        var oL = pls[m].layers, newLid = maps.layerIdMap[oL.id];
        if (!newLid || (modes[oL.id] || 'linked') !== 'all') continue;
        var cur = await db.from('layers').select('raw_config').eq('id', newLid).single();
        var rc2 = (cur.data && cur.data.raw_config) || {};
        rc2._msFromMap = srcId;
        if (rc2.instanceOf && maps.layerIdMap[rc2.instanceOf]) rc2.instanceOf = maps.layerIdMap[rc2.instanceOf];
        if (rc2.outlineOf && maps.slugMap[rc2.outlineOf]) rc2.outlineOf = maps.slugMap[rc2.outlineOf];
        await db.from('layers').update({ raw_config: rc2 }).eq('id', newLid);
      }

      note('Added ✓ (' + added.length + ' layers' + (feats ? ', ' + feats + ' features' : '') + ') — reloading…');
      setTimeout(function () { location.reload(); }, 700);
    } catch (e) {
      console.warn('portal add failed', e);
      note('Add failed: ' + ((e && e.message) || e));
      goBtn.disabled = false; goBtn.textContent = 'Add to this map';
    }
  }

  // ── no button of our own: the ⊞ Portal button lives in the editor's add-things bar
  //    (editing.js showButtons — user 8/5: "along with the other layer add-related buttons")
  //    and calls MSPortalAdd.open(). Toggle behaviour: open again = close.
  window.MSPortalAdd = { open: function () { if (panel) close(); else openList(); } };
})();
