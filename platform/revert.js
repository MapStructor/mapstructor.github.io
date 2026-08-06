/* revert.js — "Revert to the last published version" (owner request 8/6).
 *
 * THE NEED: unpublished edits pile up with no way back except undoing each one by hand (adding a
 * portal map drops in a whole tree; removing it meant deleting every piece individually).
 *
 * WHAT IT RESTORES — the map's STRUCTURE and SETTINGS exactly as the last Publish saw them:
 * sections, groups, which layers are in the map, their order/nesting, and every layer's own
 * settings (name, paint, popups, dates, zoom targets…), plus the project's own chrome (basemaps,
 * timeline, start view). That is precisely what a published snapshot contains
 * (ConfigLoader.fetchProjectBundle → project_snapshots.state).
 *
 * WHAT IT DOES NOT TOUCH, stated plainly in the dialog because a surprise here would be data loss:
 *   · FEATURES inside layers that existed at publish time. Snapshots don't carry the feature rows
 *     of every layer, so a point you moved or a label you fixed since publishing STAYS fixed.
 *   · WHO can see or edit the map (visibility, edit access, the 🔒 freeze) — sharing is not
 *     content, and silently re-opening a map you had made private would be its own bug.
 *
 * NOTHING IS DESTROYED. Layers added since the publish are removed from the map and land in
 * layer Trash (ms_trash_layer_if_orphaned), where "Restore" brings them back with their data.
 * Layers that were in the publish but have since been deleted are lifted back OUT of Trash.
 * The dialog also offers — checked by default — a full duplicate of the CURRENT state first, so
 * the pre-revert map survives as its own map even if the revert itself is the mistake.
 *
 * SAFETY: two hoops, deliberately. The dialog states the exact counts, and the button stays
 * disabled until the word "revert" is typed.
 */
(function () {
  'use strict';
  if (window.MSRevert) return;

  var CSS_ID = 'msrevert-css';
  function ensureCss() {
    if (document.getElementById(CSS_ID)) return;
    var s = document.createElement('style'); s.id = CSS_ID;
    s.textContent =
      '#msrevert-ov{position:fixed;inset:0;background:rgba(20,16,32,0.55);z-index:7200;display:flex;align-items:center;justify-content:center;}' +
      '#msrevert-panel{background:#fff;border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,0.35);width:560px;max-width:94vw;max-height:88vh;overflow:auto;padding:20px 22px;font-family:Source Sans Pro,Arial,sans-serif;color:#2a2a33;}' +
      '#msrevert-panel h3{margin:0 0 4px;font-size:19px;color:#1e1b2e;}' +
      '#msrevert-panel .sub{font-size:12.5px;color:#6b6680;margin:0 0 14px;line-height:1.5;}' +
      '#msrevert-panel .box{border:1px solid #e6e1f0;border-radius:10px;padding:11px 13px;margin-bottom:10px;font-size:13px;line-height:1.6;}' +
      '#msrevert-panel .box b{color:#1e1b2e;}' +
      '#msrevert-panel .warn{border-color:#f0d9a8;background:#fffaf0;}' +
      '#msrevert-panel .keep{border-color:#cfe6cf;background:#f6fbf6;}' +
      '#msrevert-panel label.chk{display:flex;gap:9px;align-items:flex-start;font-size:13px;margin:12px 0;cursor:pointer;}' +
      '#msrevert-panel input[type=text]{width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #cdc6e0;border-radius:8px;font-size:13px;}' +
      '#msrevert-panel .row{display:flex;gap:8px;justify-content:flex-end;margin-top:14px;}' +
      '#msrevert-panel button{padding:8px 15px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;border:1px solid #d9cff1;background:#efeaf8;color:#4a3f66;}' +
      '#msrevert-go{background:#b4453a;border-color:#9c3a30;color:#fff;}' +
      '#msrevert-go:disabled{background:#e6d7d5;border-color:#e0cdca;color:#9d8f8d;cursor:not-allowed;}' +
      '#msrevert-status{font-size:12.5px;margin-top:10px;min-height:16px;color:#6b6680;}';
    document.head.appendChild(s);
  }

  function strip(row, extra) {
    var o = {};
    Object.keys(row || {}).forEach(function (k) {
      if (k === 'created_at' || k === 'updated_at' || (extra && extra.indexOf(k) > -1)) return;
      o[k] = row[k];
    });
    return o;
  }
  // sharing/lock keys are WHO-can-see state, never restored by a content revert
  var KEEP_RC = ['visibility', 'editAccess', 'editLock'];

  async function loadState(db, projectId) {
    var snap = await db.from('project_snapshots').select('state, created_at')
      .eq('project_id', projectId).eq('label', 'published')
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (snap.error) throw new Error(snap.error.message);
    return snap.data || null;
  }

  // what would change, in the user's words
  async function diff(db, projectId, state) {
    var cur = await ConfigLoader.fetchProjectBundle(db, projectId);
    var snapPL = state.projectLayers || [], curPL = cur.projectLayers || [];
    var snapIds = {}, curIds = {};
    snapPL.forEach(function (pl) { if (pl.layers) snapIds[pl.layers.id] = pl.layers; });
    curPL.forEach(function (pl) { if (pl.layers) curIds[pl.layers.id] = pl.layers; });

    var added = Object.keys(curIds).filter(function (id) { return !snapIds[id]; });
    var gone = Object.keys(snapIds).filter(function (id) { return !curIds[id]; });
    var restyled = Object.keys(snapIds).filter(function (id) {
      if (!curIds[id]) return false;
      return JSON.stringify(strip(snapIds[id])) !== JSON.stringify(strip(curIds[id]));
    });
    // layers this map shares with another map — restoring their settings reaches those maps too
    var shared = [];
    var both = Object.keys(snapIds).filter(function (id) { return !!curIds[id]; });
    if (both.length) {
      try {
        var r = await db.from('project_layers').select('layer_id, project_id').in('layer_id', both);
        (r.data || []).forEach(function (row) {
          if (row.project_id !== projectId && shared.indexOf(row.layer_id) < 0 && restyled.indexOf(row.layer_id) > -1) shared.push(row.layer_id);
        });
      } catch (e) {}
    }
    return {
      cur: cur,
      added: added, gone: gone, restyled: restyled, shared: shared,
      addedNames: added.map(function (id) { return curIds[id].name || 'unnamed layer'; }),
      goneNames: gone.map(function (id) { return snapIds[id].name || 'unnamed layer'; }),
      secDelta: (state.sections || []).length - (cur.sections || []).length,
      grpDelta: (state.groups || []).length - (cur.groups || []).length
    };
  }

  /* a silent duplicate of the CURRENT state — the pre-revert safety net. Reuses the same engine
     ⧉ Copy-map uses (MSCopyEngine.copyLayerInto), but never navigates away. */
  async function duplicateCurrent(db, projectId, bundle, userId, say) {
    if (!window.MSCopyEngine || !MSCopyEngine.copyLayerInto) throw new Error('copy engine unavailable');
    var src = bundle.project;
    var np = strip(src, ['id']);
    np.name = (src.name || 'Untitled Map') + ' (before revert)';
    np.user_id = userId; np.is_public = false;
    np.raw_config = np.raw_config ? JSON.parse(JSON.stringify(np.raw_config)) : {};
    np.raw_config.visibility = 'private';
    delete np.raw_config.editAccess;
    var rp = await db.from('projects').insert(np).select('id').single();
    if (rp.error) throw new Error(rp.error.message);
    var newId = rp.data.id, secMap = {}, grpMap = {}, layerIdMap = {}, slugMap = {};
    for (var i = 0; i < (bundle.sections || []).length; i++) {
      var ns = strip(bundle.sections[i], ['id']); ns.project_id = newId;
      var rs = await db.from('layer_sections').insert(ns).select('id').single();
      if (rs.error) throw new Error(rs.error.message);
      secMap[bundle.sections[i].id] = rs.data.id;
    }
    for (var j = 0; j < (bundle.groups || []).length; j++) {
      var ng = strip(bundle.groups[j], ['id']); ng.project_id = newId;
      if (ng.section_id) ng.section_id = secMap[ng.section_id] || null;
      var rg = await db.from('layer_groups').insert(ng).select('id').single();
      if (rg.error) throw new Error(rg.error.message);
      grpMap[bundle.groups[j].id] = rg.data.id;
    }
    var maps = { secMap: secMap, grpMap: grpMap, layerIdMap: layerIdMap, slugMap: slugMap };
    for (var k = 0; k < (bundle.projectLayers || []).length; k++) {
      await MSCopyEngine.copyLayerInto(bundle.projectLayers[k], newId, maps, userId);
      if (say) say('Duplicating… ' + (k + 1) + '/' + bundle.projectLayers.length + ' layers');
    }
    return newId;
  }

  /* the revert itself. Order matters: join rows first (they reference sections/groups), then the
     containers, then re-create containers with their ORIGINAL ids so the snapshot's join rows fit. */
  async function apply(db, projectId, state, d, say) {
    var report = { restored: 0, trashed: 0, unrecoverable: [] };

    // 1 · project chrome — content only, sharing preserved
    var curP = await db.from('projects').select('raw_config').eq('id', projectId).single();
    var liveRc = (curP.data && curP.data.raw_config) || {};
    var snapRc = (state.project && state.project.raw_config) ? JSON.parse(JSON.stringify(state.project.raw_config)) : {};
    KEEP_RC.forEach(function (k) { if (liveRc[k] === undefined) delete snapRc[k]; else snapRc[k] = liveRc[k]; });
    var sp = state.project || {};
    var pUpd = { raw_config: snapRc };
    ['name', 'center_lat', 'center_lng', 'zoom', 'bearing', 'basemap_style'].forEach(function (k) {
      if (k in sp) pUpd[k] = sp[k];
    });
    var rp = await db.from('projects').update(pUpd).eq('id', projectId);
    if (rp.error) throw new Error('project: ' + rp.error.message);

    // 2 · clear the current tree (join rows → groups → sections)
    say('Clearing the current layout…');
    var dPL = await db.from('project_layers').delete().eq('project_id', projectId);
    if (dPL.error) throw new Error('project_layers: ' + dPL.error.message);
    await db.from('layer_groups').delete().eq('project_id', projectId);
    await db.from('layer_sections').delete().eq('project_id', projectId);

    // 3 · rebuild containers with their original ids
    say('Restoring sections and groups…');
    for (var i = 0; i < (state.sections || []).length; i++) {
      var s = strip(state.sections[i]); s.project_id = projectId;
      var rs = await db.from('layer_sections').insert(s);
      if (rs.error) throw new Error('section: ' + rs.error.message);
    }
    for (var j = 0; j < (state.groups || []).length; j++) {
      var g = strip(state.groups[j]); g.project_id = projectId;
      var rg = await db.from('layer_groups').insert(g);
      if (rg.error) throw new Error('group: ' + rg.error.message);
    }

    // 4 · layers: settings back to the published values; lift any that were deleted out of Trash
    say('Restoring layer settings…');
    for (var k = 0; k < (state.projectLayers || []).length; k++) {
      var pl = state.projectLayers[k], L = pl.layers;
      if (!L) continue;
      var exists = await db.from('layers').select('id, deleted_at').eq('id', L.id).maybeSingle();
      if (!exists.data) { report.unrecoverable.push(L.name || 'unnamed layer'); continue; }
      var lUpd = strip(L, ['id', 'user_id', 'r2_bytes']);   // ownership + billed bytes are live facts, not snapshot content
      lUpd.deleted_at = null;                                // back out of layer Trash if it went there
      var ru = await db.from('layers').update(lUpd).eq('id', L.id);
      if (ru.error) throw new Error('layer "' + (L.name || L.id) + '": ' + ru.error.message);
      var np2 = strip(pl, ['layers']); np2.project_id = projectId;
      var rl = await db.from('project_layers').insert(np2);
      if (rl.error) throw new Error('link: ' + rl.error.message);
      report.restored++;
    }

    // 5 · layers added since the publish are now unreferenced → Trash (recoverable), never deleted
    say('Moving layers added since publishing to Trash…');
    for (var m = 0; m < d.added.length; m++) {
      try {
        var rt = await db.rpc('ms_trash_layer_if_orphaned', { p_layer: d.added[m], p_project: projectId });
        if (!rt.error) report.trashed++;
      } catch (eT) {}
    }
    return report;
  }

  async function open(opts) {
    ensureCss();
    var db = opts.db, projectId = opts.projectId;
    var old = document.getElementById('msrevert-ov'); if (old) old.remove();
    var ov = document.createElement('div'); ov.id = 'msrevert-ov';
    ov.innerHTML = '<div id="msrevert-panel"><h3>Revert to the last published version</h3>' +
      '<p class="sub">Checking what would change…</p><div id="msrevert-body"></div>' +
      '<div id="msrevert-status"></div></div>';
    document.body.appendChild(ov);
    var body = ov.querySelector('#msrevert-body'), status = ov.querySelector('#msrevert-status');
    function close() { ov.remove(); }
    ov.addEventListener('click', function (e) { if (e.target === ov) close(); });

    var snap = null, d = null;
    try {
      snap = await loadState(db, projectId);
      if (!snap) {
        ov.querySelector('.sub').textContent = 'This map has never been published.';
        body.innerHTML = '<div class="box">There is no published version to go back to yet. Publish once, and from then on you can always return to that version.</div>' +
          '<div class="row"><button id="msrevert-cancel">Close</button></div>';
        ov.querySelector('#msrevert-cancel').addEventListener('click', close);
        return;
      }
      d = await diff(db, projectId, snap.state || {});
    } catch (e) {
      ov.querySelector('.sub').textContent = 'Could not read the published version.';
      body.innerHTML = '<div class="box warn">' + ((e && e.message) || e) + '</div>' +
        '<div class="row"><button id="msrevert-cancel">Close</button></div>';
      ov.querySelector('#msrevert-cancel').addEventListener('click', close);
      return;
    }

    var when = snap.created_at ? new Date(snap.created_at).toLocaleString() : 'the last publish';
    var nothing = !d.added.length && !d.gone.length && !d.restyled.length && !d.secDelta && !d.grpDelta;
    function list(names) {
      if (!names.length) return '';
      var shown = names.slice(0, 6).join(', ');
      return shown + (names.length > 6 ? ' and ' + (names.length - 6) + ' more' : '');
    }
    ov.querySelector('.sub').innerHTML = 'Published ' + when + '. Everything below is measured against that version.';
    body.innerHTML =
      (nothing ? '<div class="box keep">This map already matches its published version — reverting would change nothing.</div>' : '') +
      '<div class="box"><b>What comes back</b><br>' +
      (d.restyled.length ? '· <b>' + d.restyled.length + '</b> layer' + (d.restyled.length === 1 ? ' gets its' : 's get their') + ' published settings back (styling, popups, dates, order).<br>' : '') +
      (d.gone.length ? '· <b>' + d.gone.length + '</b> layer' + (d.gone.length === 1 ? '' : 's') + ' removed since then return: ' + list(d.goneNames) + '.<br>' : '') +
      (d.secDelta || d.grpDelta ? '· sections and groups return to the published layout.<br>' : '') +
      (!d.restyled.length && !d.gone.length && !d.secDelta && !d.grpDelta ? '· nothing — no settings differ.<br>' : '') +
      '</div>' +
      (d.added.length ? '<div class="box warn"><b>What leaves this map</b><br>· <b>' + d.added.length + '</b> layer' + (d.added.length === 1 ? '' : 's') +
        ' added since publishing: ' + list(d.addedNames) + '.<br><span style="color:#6b6680;">They go to <b>layer Trash</b> with their data — "Restore" brings any of them back. Nothing is deleted.</span></div>' : '') +
      '<div class="box keep"><b>What is left alone</b><br>' +
      '· Edits to features <i>inside</i> layers that already existed — a point you moved or a label you fixed stays fixed.<br>' +
      '· Who can see or edit this map, and the 🔒 lock.</div>' +
      (d.shared.length ? '<div class="box warn"><b>Heads up:</b> ' + d.shared.length + ' of these layers are also used by another map. Restoring their settings changes them there too.</div>' : '') +
      '<label class="chk"><input type="checkbox" id="msrevert-dup" checked><span><b>Duplicate this map first</b> — keeps today\'s version as a separate private map called "…(before revert)". Recommended: it is the only way back if the revert itself is the mistake.</span></label>' +
      '<div style="font-size:12.5px;color:#6b6680;margin-bottom:5px;">Type <b>revert</b> to confirm:</div>' +
      '<input type="text" id="msrevert-word" autocomplete="off" placeholder="revert">' +
      '<div class="row"><button id="msrevert-cancel">Cancel</button><button id="msrevert-go" disabled>Revert this map</button></div>';

    var word = ov.querySelector('#msrevert-word'), go = ov.querySelector('#msrevert-go');
    word.addEventListener('input', function () { go.disabled = word.value.trim().toLowerCase() !== 'revert'; });
    ov.querySelector('#msrevert-cancel').addEventListener('click', close);
    word.focus();

    go.addEventListener('click', async function () {
      go.disabled = true; ov.querySelector('#msrevert-cancel').disabled = true;
      var say = function (m) { status.textContent = m; };
      try {
        if (ov.querySelector('#msrevert-dup').checked) {
          say('Duplicating the current map…');
          var u = window.MapAuth ? await MapAuth.currentUser() : null;
          if (!u) throw new Error('sign in first');
          var dupId = await duplicateCurrent(db, projectId, d.cur, u.id, say);
          say('Duplicate saved. Reverting…');
          try { window.__msRevertDuplicateId = dupId; } catch (e0) {}
        }
        var rep = await apply(db, projectId, snap.state || {}, d, say);
        var tail = rep.unrecoverable.length
          ? ' ' + rep.unrecoverable.length + ' layer(s) could not return (permanently deleted): ' + rep.unrecoverable.join(', ') + '.'
          : '';
        say('Reverted ✓ — ' + rep.restored + ' layers restored, ' + rep.trashed + ' moved to Trash.' + tail + ' Reloading…');
        setTimeout(function () { location.reload(); }, 1400);
      } catch (e) {
        status.style.color = '#b4453a';
        status.textContent = 'Revert failed: ' + ((e && e.message) || e) + ' — nothing further was changed. Reload and try again, or use the duplicate.';
        ov.querySelector('#msrevert-cancel').disabled = false;
      }
    });
  }

  window.MSRevert = { open: open };
})();
