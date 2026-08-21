// MapStructor — DATASETS & PROVENANCE. Layers are the atoms; maps are molecules built from them.
//
// Design + reasoning: mapstructor_docs/planning/dev-plan/datasets-plan.md
// Schema:            mapstructor_docs/sql/setup/datasets-setup.sql
//
// What this module owns, end to end:
//   · "Register as dataset" on a layer — the ONLY way data enters the catalogue for now (the
//     owner's point 5: registration happens from the layer panel, not at upload).
//   · The permanent dataset_id, stamped on every FEATURE server-side by ms_register_dataset, so
//     it survives features being copied into somebody else's map.
//   · The frozen read-only copy — a zip of the layer as it stands, stored under `datasets/<id>/`
//     which is deliberately OUTSIDE `tiles/<project>/…` so no project purge can ever reach it.
//   · The gate on contributing a MAP: every one of its layers must be registered first, with a
//     modal that lets several be filled in at once (the owner's point 6).
//
// ADMIN-ONLY FOR NOW, by the owner's decision ("one thing at a time"). The client gate here is
// cosmetic; ms_dataset_admin() in the database is the real one.
//
// This file is self-contained and self-injecting: deleting it and its two script tags removes the
// whole feature, and the only edits elsewhere are one call in editing.js and one in share.js.
(function () {
  'use strict';
  if (window.MSDatasets) return;

  var SUPABASE_URL = 'https://eqpxlwbjqiwfjlsuapvu.supabase.co';
  var SUPABASE_KEY = 'sb_publishable_ijLmSmMUeNBrgMGL8Aol4g_S5-xwUzD';
  var db = (window.MapAuth && MapAuth.db)
    || ((window.supabase && window.supabase.createClient) ? window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY) : null);
  var ADMINS = ['nittyjee@gmail.com'];
  var BUCKET = 'tiles';
  var JSZIP_URL = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
  var PAGE = 1000;

  // The permissions behind each licence, frozen onto the dataset row at registration so that
  // revising this list later never silently rewrites what was already recorded.
  //   r = may redistribute · m = may modify · c = commercial use ok · sa = share-alike · at = attribution required
  // null means "not known", which is deliberately different from false.
  var LICENCES = [
    { code: 'unknown',       label: 'Unknown — not recorded yet',                 r: null, m: null, c: null, sa: null, at: true },
    { code: 'CC0-1.0',       label: 'CC0 1.0 — public domain dedication',         r: true, m: true, c: true, sa: false, at: false },
    { code: 'PDDL-1.0',      label: 'PDDL 1.0 — open data, public domain',        r: true, m: true, c: true, sa: false, at: false },
    { code: 'public-domain', label: 'Public domain (age, or a government work)',  r: true, m: true, c: true, sa: false, at: false },
    { code: 'CC-BY-4.0',     label: 'CC BY 4.0 — credit required',                r: true, m: true, c: true, sa: false, at: true },
    { code: 'CC-BY-SA-4.0',  label: 'CC BY-SA 4.0 — credit + share alike',        r: true, m: true, c: true, sa: true,  at: true },
    { code: 'ODbL-1.0',      label: 'ODbL 1.0 — open database, share alike',      r: true, m: true, c: true, sa: true,  at: true },
    { code: 'OGL-3.0',       label: 'Open Government Licence 3.0',                r: true, m: true, c: true, sa: false, at: true },
    { code: 'CC-BY-NC-4.0',  label: 'CC BY-NC 4.0 — no commercial use',           r: true, m: true, c: false, sa: false, at: true },
    { code: 'custom',        label: 'Custom / other — set the permissions below', r: null, m: null, c: null, sa: null, at: true }
  ];
  function licenceOf(code) {
    for (var i = 0; i < LICENCES.length; i++) if (LICENCES[i].code === code) return LICENCES[i];
    return LICENCES[0];
  }

  // ── small helpers ─────────────────────────────────────────────────────────
  function el(tag, css, text) {
    var n = document.createElement(tag);
    if (css) n.style.cssText = css;
    if (text != null) n.textContent = text;   // never innerHTML for anything a user typed
    return n;
  }
  function isAdminEmail(e) { return !!e && ADMINS.indexOf(String(e).toLowerCase()) > -1; }
  function currentUser() {
    if (!window.MapAuth || !MapAuth.currentUser) return Promise.resolve(null);
    return Promise.resolve(MapAuth.currentUser()).catch(function () { return null; });
  }
  function isAdmin() { return currentUser().then(function (u) { return !!(u && isAdminEmail(u.email)); }); }
  function fmtBytes(n) {
    if (!n && n !== 0) return '';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }
  function loadJSZip() {
    if (window.JSZip) return Promise.resolve(window.JSZip);
    return new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = JSZIP_URL;
      s.onload = function () { window.JSZip ? res(window.JSZip) : rej(new Error('JSZip failed to initialize')); };
      s.onerror = function () { rej(new Error('could not load JSZip (needed to build the read-only copy)')); };
      document.head.appendChild(s);
    });
  }

  // ── styles (one injection, .msds-*) ───────────────────────────────────────
  function ensureCss() {
    if (document.getElementById('msds-css')) return;
    var s = document.createElement('style');
    s.id = 'msds-css';
    s.textContent = [
      '.msds-back{position:fixed;inset:0;background:rgba(20,18,30,.45);z-index:20000;display:flex;align-items:center;justify-content:center;padding:20px;}',
      '.msds-modal{background:#fff;border-radius:10px;box-shadow:0 10px 40px rgba(0,0,0,.3);width:min(560px,96vw);max-height:92vh;display:flex;flex-direction:column;font:14px Source Sans Pro,Arial,sans-serif;color:#2c2836;}',
      '.msds-head{padding:14px 16px;border-bottom:1px solid #e6e3ee;display:flex;justify-content:space-between;align-items:center;gap:10px;}',
      '.msds-head b{font-size:16px;}',
      '.msds-body{padding:14px 16px;overflow-y:auto;overflow-x:hidden;}',
      '.msds-foot{padding:12px 16px;border-top:1px solid #e6e3ee;display:flex;gap:8px;justify-content:flex-end;align-items:center;}',
      '.msds-lab{display:block;font-weight:600;font-size:12px;margin:10px 0 3px;color:#514c66;}',
      '.msds-lab:first-child{margin-top:0;}',
      '.msds-in{width:100%;max-width:100%;min-width:0;display:block;box-sizing:border-box;padding:7px 9px;border:1px solid #c9c4d8;border-radius:5px;font:14px inherit;}',
      'textarea.msds-in{resize:none;overflow:hidden;line-height:1.45;}',
      '.msds-in:focus{outline:2px solid #b9a9ee;border-color:#b9a9ee;}',
      '.msds-note{font-size:12px;color:#6b6580;margin:4px 0 0;line-height:1.45;}',
      '.msds-btn{padding:7px 14px;border:1px solid #c9c4d8;border-radius:6px;background:#fff;font:600 13px inherit;cursor:pointer;color:#443f58;}',
      '.msds-btn.pri{background:#5b4b9a;border-color:#5b4b9a;color:#fff;}',
      '.msds-btn[disabled]{opacity:.5;cursor:default;}',
      '.msds-perm{display:flex;flex-wrap:wrap;gap:10px;margin-top:5px;}',
      '.msds-perm label{font-size:12px;display:inline-flex;align-items:center;gap:4px;color:#514c66;}',
      '.msds-row{display:flex;align-items:center;gap:8px;padding:6px 8px;border:1px solid #e6e3ee;border-radius:6px;margin-bottom:5px;}',
      '.msds-row.done{background:#f2fbf3;border-color:#bfe3c4;}',
      '.msds-row small{color:#6b6580;}',
      '.msds-prog{font-size:12px;color:#5b4b9a;margin-right:auto;}',
      '.msds-err{color:#a8342a;font-size:12px;margin-right:auto;}'
    ].join('');
    document.head.appendChild(s);
  }

  function modal(title) {
    ensureCss();
    var back = document.createElement('div'); back.className = 'msds-back';
    var box = document.createElement('div'); box.className = 'msds-modal';
    var head = document.createElement('div'); head.className = 'msds-head';
    head.appendChild(el('b', '', title));
    var x = el('button', '', '×'); x.className = 'msds-btn'; x.title = 'Close';
    head.appendChild(x);
    var body = document.createElement('div'); body.className = 'msds-body';
    var foot = document.createElement('div'); foot.className = 'msds-foot';
    box.appendChild(head); box.appendChild(body); box.appendChild(foot);
    back.appendChild(box);
    document.body.appendChild(back);
    function close() { try { back.remove(); } catch (e) {} }
    x.addEventListener('click', close);
    back.addEventListener('mousedown', function (e) { if (e.target === back) close(); });
    return { back: back, body: body, foot: foot, close: close };
  }

  // ── the form ──────────────────────────────────────────────────────────────
  //    The owner's point 4 (Name, Source, Link, Licence, More info), revised 8/11 after the
  //    first real registration. The order now runs source-facts first, then licence, then free
  //    text, ending with the submitter's own words:
  //      Name · Source · Link · Citation · Licence · Attribution · How it was made ·
  //      More info on source · More info · Notes by person submitting
  function buildForm(prefill, opts) {
    prefill = prefill || {}; opts = opts || {};
    var wrap = document.createElement('div');
    var grows = [];
    // Textareas GROW WITH THE TEXT rather than carrying a drag handle. The handle is what let a
    // field be dragged wider than the modal, and that is where the horizontal scrollbar came
    // from (owner, 8/11). The +12px leaves a blank line under the last line, so typing never
    // sits pinned against the bottom edge.
    function autoGrow(t) {
      function fit() { t.style.height = 'auto'; t.style.height = (t.scrollHeight + 12) + 'px'; }
      t.addEventListener('input', fit);
      grows.push(fit);
      return t;
    }
    function field(label, key, placeholder, multiline, note) {
      wrap.appendChild(el('label', '', label)).className = 'msds-lab';
      var i = document.createElement(multiline ? 'textarea' : 'input');
      i.className = 'msds-in'; i.value = prefill[key] || '';
      if (placeholder) i.placeholder = placeholder;
      if (multiline) { i.rows = (multiline === true ? 3 : multiline); autoGrow(i); }
      wrap.appendChild(i);
      if (note) wrap.appendChild(el('div', '', note)).className = 'msds-note';
      return i;
    }
    // noName (8/12): the bulk "shared info" form has no name field — each dataset is named
    // after its layer automatically, so shared facts are typed exactly once.
    var fName   = opts.noName ? null : field('Dataset name', 'name', 'e.g. Natural Earth 10m Railroads');
    var fSource = field('Source', 'source', 'Who published it — e.g. Natural Earth');
    var fLink   = field('Link', 'link', 'https://…');
    var fCite   = field('Citation', 'citation', 'Author, title, year, version, DOI — however the publisher asks to be cited', 2,
      'The full formal citation. The short credit that shows on the map is the Attribution line below.');

    wrap.appendChild(el('label', '', 'Licence')).className = 'msds-lab';
    var sel = document.createElement('select'); sel.className = 'msds-in';
    LICENCES.forEach(function (L) {
      var o = document.createElement('option'); o.value = L.code; o.textContent = L.label; sel.appendChild(o);
    });
    sel.value = prefill.licence || 'unknown';
    wrap.appendChild(sel);
    wrap.appendChild(el('div', '', 'This is the only field that really matters — "Unknown" is a proper answer and never blocks you.')).className = 'msds-note';

    // the permissions behind the licence, editable for Custom / Unknown
    var perm = document.createElement('div'); perm.className = 'msds-perm';
    var boxes = {};
    [['r', 'may redistribute'], ['m', 'may modify'], ['c', 'commercial ok'], ['sa', 'share-alike'], ['at', 'attribution required']]
      .forEach(function (p) {
        var l = document.createElement('label');
        var c = document.createElement('input'); c.type = 'checkbox';
        boxes[p[0]] = c;
        l.appendChild(c); l.appendChild(document.createTextNode(p[1]));
        perm.appendChild(l);
      });
    wrap.appendChild(perm);
    function syncPerms() {
      var L = licenceOf(sel.value), locked = (sel.value !== 'custom' && sel.value !== 'unknown');
      ['r', 'm', 'c', 'sa', 'at'].forEach(function (k) {
        if (locked) boxes[k].checked = !!L[k];
        boxes[k].disabled = locked;
        boxes[k].indeterminate = (!locked && L[k] === null && !boxes[k].checked);
      });
    }
    sel.addEventListener('change', syncPerms); syncPerms();

    var fAttr = field('Attribution line (shown in credits)', 'attribution_text', 'e.g. © Natural Earth, public domain');

    // HOW IT WAS MADE. This was "Was this drawn by tracing?", shown only for drawn layers, and it
    // read as nonsense against an external source like CShapes (owner, 8/11). Asking how the data
    // was made covers every case and still collects the tracing answer that licensing depends on.
    wrap.appendChild(el('label', '', 'How was this made?')).className = 'msds-lab';
    var tSel = document.createElement('select'); tSel.className = 'msds-in';
    [['', 'Not answered'],
     ['published', 'Published by an outside source'],
     ['traced', 'Traced or digitised from a source I may trace'],
     ['traced-unsure', 'Traced from something I am not sure about'],
     ['own', 'Original survey, or drawn from scratch']]
      .forEach(function (o) { var x = document.createElement('option'); x.value = o[0]; x.textContent = o[1]; tSel.appendChild(x); });
    tSel.value = prefill.made_how ||
      (prefill.traced_only_open === true ? 'traced' : (prefill.traced_only_open === false ? 'traced-unsure' : ''));
    wrap.appendChild(tSel);
    wrap.appendChild(el('div', '', 'Tracing an out-of-copyright survey is fine; tracing Google Maps is not. Recording the answer now is the only way to answer the question later.')).className = 'msds-note';

    var fSrcMore = field('More info on source', 'source_more_info', 'Where it came from, how it was compiled, what fed into it', 2);
    var fMore    = field('More info', 'more_info', 'What the data IS — coverage, accuracy, quirks, what it is for', 3,
      'Write a real sentence here. Search reads this, and layer names in the wild are usually machine-generated.');
    var fNotes   = field('Notes by person submitting', 'submitter_notes', 'Your own remarks — why you added it, what you changed, anything a future reader should know', 2,
      'Kept apart from the facts about the source, and recorded against your name.');

    return {
      el: wrap,
      // call once the form is in the DOM — scrollHeight means nothing before layout
      grow: function () { grows.forEach(function (f) { try { f(); } catch (e) {} }); },
      focus: function () { try { (fName || fSource).focus(); } catch (e) {} },
      read: function () {
        var L = licenceOf(sel.value), custom = (sel.value === 'custom' || sel.value === 'unknown');
        var how = tSel.value, srcMore = fSrcMore.value.trim();
        return {
          name: fName ? fName.value.trim() : '', source: fSource.value.trim(), link: fLink.value.trim(),
          citation: fCite.value.trim(),
          more_info: fMore.value.trim(), licence: sel.value,
          attribution_text: fAttr.value.trim(),
          source_more_info: srcMore,
          submitter_notes: fNotes.value.trim(),
          made_how: how,
          // the older columns are kept in step, so nothing that already reads them starts lying
          traced_only_open: how === 'traced' ? true : (how === 'traced-unsure' ? false : null),
          traced_sources: srcMore,
          lic_redistribute: custom ? boxes.r.checked : L.r,
          lic_modify:       custom ? boxes.m.checked : L.m,
          lic_commercial:   custom ? boxes.c.checked : L.c,
          lic_share_alike:  custom ? boxes.sa.checked : L.sa,
          lic_attribution:  custom ? boxes.at.checked : L.at
        };
      }
    };
  }

  // ── data ──────────────────────────────────────────────────────────────────
  // Which of these layer ids already carry a dataset? One query, answered from the catalogue
  // rather than by scanning features.
  // Errors are NOT swallowed here. A failed lookup returning {} would read as "none of these are
  // registered", which is the same fail-open that would let an unregistered map look contributable.
  // Call sites that can tolerate not knowing (the panel button's label) catch it themselves.
  function datasetsForLayers(layerIds) {
    if (!db || !layerIds || !layerIds.length) return Promise.resolve({});
    // Lineage-aware (8/12): the server resolves pointer copies / mirrors to the dataset that
    // covers them, so a copy's panel button reads "🏷 Dataset: <name>" and opens PREFILLED.
    return db.rpc('ms_dataset_for_layers', { p_layers: layerIds }).then(function (r) {
      if (r.error) throw new Error(r.error.message);
      var out = {};
      (r.data || []).forEach(function (row) { if (row.layer_id) out[row.layer_id] = row.dataset; });
      return out;
    });
  }

  function register(layerDbId, meta, fork) {
    if (!db) return Promise.reject(new Error('not signed in'));
    // fork (8/13): an edited "All" copy registers as a NEW dataset — the server hydrates it
    // from its lineage root first (it becomes a real, independent copy), then registers it as
    // itself instead of re-targeting to the root's existing dataset.
    var fn = fork ? 'ms_register_dataset_fork' : 'ms_register_dataset';
    return db.rpc(fn, { p_layer: layerDbId, p_meta: meta }).then(function (r) {
      if (r.error) throw new Error(r.error.message);
      return r.data;   // dataset id
    });
  }

  // THE FROZEN READ-ONLY COPY. Everything the layer holds right now, as GeoJSON inside a zip,
  // beside a small readme naming the source and licence so the file explains itself if it is ever
  // separated from MapStructor. Stored under datasets/<id>/ — outside any project prefix, so a
  // project purge cannot reach it.
  async function snapshot(layerDbId, datasetId, meta, onProgress) {
    var say = onProgress || function () {};
    var feats = [], bbox = [Infinity, Infinity, -Infinity, -Infinity], types = {};
    // KEYSET + ADAPTIVE paging (8/13): the fixed 1000-row offset pager died with a statement
    // timeout on the Railroads freeze (78k rows) — offset pages re-walk every skipped row, and
    // heavy pages blow the limit outright. Cursor on feature_id; on failure the page size
    // divides by 4 (floor 25) and the same cursor retries. Self-contained on purpose — the
    // dashboard loads this module without configLoader's shared MSFetchRows.
    {
      var last = null, size = PAGE, minSize = 25;
      for (;;) {
        var q = db.from('features')
          .select('feature_id, geom, label, description, start_date, end_date, image_url, custom_fields')
          .eq('layer_id', layerDbId);
        if (last !== null) q = q.gt('feature_id', last);
        var r; try { r = await q.order('feature_id').limit(size); } catch (e) { r = { error: e }; }
        if (r.error) {
          if (size <= minSize) throw new Error('reading features: ' + r.error.message);
          size = Math.max(minSize, Math.floor(size / 4));
          say('Heavy rows — retrying in pages of ' + size + '…');
          continue;
        }
        var rows = r.data || [];
        if (rows.length) last = rows[rows.length - 1].feature_id;
        rows.forEach(function (f) {
        var g = typeof f.geom === 'string' ? JSON.parse(f.geom) : f.geom;
        if (!g) return;
        types[g.type] = 1;
        (function walk(c) {
          if (!c) return;
          if (typeof c[0] === 'number') {
            if (c[0] < bbox[0]) bbox[0] = c[0]; if (c[1] < bbox[1]) bbox[1] = c[1];
            if (c[0] > bbox[2]) bbox[2] = c[0]; if (c[1] > bbox[3]) bbox[3] = c[1];
            return;
          }
          for (var i = 0; i < c.length; i++) walk(c[i]);
        })(g.coordinates);
        var props = {};
        if (f.custom_fields && typeof f.custom_fields === 'object') Object.keys(f.custom_fields).forEach(function (k) { props[k] = f.custom_fields[k]; });
        if (f.label != null && String(f.label).trim() !== '') props.label = f.label;   // " " is not a label — see editing.js
        if (f.description) props.description = f.description;
        if (f.start_date) props.start_date = String(f.start_date).slice(0, 10);
        if (f.end_date) props.end_date = String(f.end_date).slice(0, 10);
        if (f.image_url) props.image_url = f.image_url;
        props.dataset_id = datasetId;   // the label travels with the file, per the plan's item 4b
        feats.push({ type: 'Feature', id: f.feature_id, geometry: g, properties: props });
        });
        say('Reading features… ' + feats.length.toLocaleString());
        if (rows.length < size) break;
      }
    }
    if (!isFinite(bbox[0])) bbox = null;

    say('Building the read-only copy…');
    var JSZipLib = await loadJSZip();
    var zip = new JSZipLib();
    var base = (meta.name || 'dataset').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'dataset';
    zip.file(base + '.geojson', JSON.stringify({ type: 'FeatureCollection', features: feats }));
    zip.file('README.txt', [
      'MapStructor read-only dataset copy',
      '',
      'Dataset:      ' + (meta.name || ''),
      'Dataset id:   ' + datasetId,
      'Source:       ' + (meta.source || '(not recorded)'),
      'Link:         ' + (meta.link || '(not recorded)'),
      'Licence:      ' + (meta.licence || 'unknown'),
      'Attribution:  ' + (meta.attribution_text || '(none recorded)'),
      'Features:     ' + feats.length,
      'Frozen at:    ' + new Date().toISOString(),
      '',
      (meta.more_info || ''),
      '',
      'Every feature carries a dataset_id property. That id is what ties this file back to its',
      'entry in the MapStructor catalogue, and to the terms above.'
    ].join('\n'));
    var blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });

    say('Storing it (' + fmtBytes(blob.size) + ')…');
    var path = 'datasets/' + datasetId + '/' + base + '.geojson.zip';
    // never upsert:true — storage's upsert path needs SELECT visibility on storage.objects and
    // fails as a bogus RLS error (the trap recorded in tilegen-setup.sql). Insert; on conflict
    // delete and retry.
    var up = await db.storage.from(BUCKET).upload(path, blob, { upsert: false, contentType: 'application/zip' });
    if (up.error && /exist|duplicate/i.test(up.error.message || '')) {
      await db.storage.from(BUCKET).remove([path]);
      up = await db.storage.from(BUCKET).upload(path, blob, { upsert: false, contentType: 'application/zip' });
    }
    if (up.error) throw new Error('storing the copy: ' + up.error.message);

    var rec = await db.rpc('ms_dataset_snapshot', {
      p_dataset: datasetId, p_key: path, p_bytes: blob.size,
      p_format: 'geojson.zip', p_bbox: bbox, p_geom_types: Object.keys(types)
    });
    if (rec.error) throw new Error('recording the copy: ' + rec.error.message);
    return { path: path, bytes: blob.size, features: feats.length };
  }

  function snapshotUrl(key) {
    return SUPABASE_URL + '/storage/v1/object/public/' + BUCKET + '/' + key;
  }

  // ── SERVER-SIDE FREEZE (8/14) ─────────────────────────────────────────────
  // The freeze used to run wholly in this tab; the owner closed a laptop mid-freeze and woke to
  // a registered dataset with no frozen copy. The edge function (supabase/functions/
  // freeze-dataset) is the click-and-forget version: POST {dataset_id} → job id immediately;
  // the tab may die, the job doesn't. Progress lives in freeze_jobs — polling it IS the
  // progress readout, and it survives refresh (reopen the modal, the poll resumes).
  var FN_URL = SUPABASE_URL + '/functions/v1/freeze-dataset';
  async function serverFreeze(datasetId, say) {
    say = say || function () {};
    var tok = null;
    try { var s = await db.auth.getSession(); tok = s && s.data && s.data.session && s.data.session.access_token; } catch (e) {}
    if (!tok) throw new Error('freeze function: no session');
    // remember the newest existing job so the discovery poll can tell a fresh row from history
    var preId = null;
    try {
      var pre = await db.from('freeze_jobs').select('id').eq('dataset_id', datasetId).order('created_at', { ascending: false }).limit(1);
      preId = pre.data && pre.data[0] && pre.data[0].id;
    } catch (e0) {}
    // FIRE, DON'T AWAIT (8/14): the function holds its response open until the freeze finishes —
    // an in-flight request is the one thing the edge runtime never culls early (waitUntil alone
    // let ~half the isolates die seconds after a 202). The JOB ROW is the source of truth; a
    // fast non-2xx response still short-circuits to the fallback.
    var httpFail = null;
    fetch(FN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok, apikey: SUPABASE_KEY },
      body: JSON.stringify({ dataset_id: datasetId })
    }).then(function (r) { if (r.status >= 400) httpFail = 'freeze function: ' + r.status; })
      .catch(function () { httpFail = 'freeze function: unreachable'; });
    var job = null;
    for (var d = 0; d < 20; d++) {
      await new Promise(function (res) { setTimeout(res, 1000); });
      if (httpFail) throw new Error(httpFail);
      var jq = await db.from('freeze_jobs').select('id, status').eq('dataset_id', datasetId).order('created_at', { ascending: false }).limit(1);
      var row = jq.data && jq.data[0];
      if (row && (row.id !== preId || row.status === 'queued' || row.status === 'running')) { job = row.id; break; }
    }
    if (!job) throw new Error('freeze function: no job appeared');
    var quiet = 0, lastState = '', stale = 0;
    for (var i = 0; i < 900; i++) {   // 1s cadence, 15 min ceiling — far above any real freeze   // cliff-ok: 15 min ceiling, far above any real freeze
      await new Promise(function (res) { setTimeout(res, 1000); });
      var j = await db.from('freeze_jobs').select('status, phase, error, updated_at').eq('id', job).single();
      if (j.error || !j.data) { if (++quiet > 10) throw new Error('freeze job lost: ' + (j.error && j.error.message)); continue; }
      quiet = 0;
      if (j.data.phase) say(j.data.phase);
      if (j.data.status === 'done') return { server: true };
      if (j.data.status === 'error') throw new Error(j.data.error || 'freeze failed');
      // STALL WATCHDOG (8/14): an edge isolate can die WITHOUT flipping the job to error (seen
      // once right after a redeploy — stuck at "Counting features…" forever). No update for 45s
      // = stalled → throw a fallback-eligible error so the in-tab freeze takes over.
      var state = j.data.updated_at + '|' + j.data.phase;
      if (state === lastState) { if (++stale >= 45) throw new Error('freeze function: job stalled'); }
      else { lastState = state; stale = 0; }
    }
    throw new Error('freeze still running server-side — reopen this dialog later to check');
  }
  // server first, ONE server retry on a stall (the edge runtime culls young workers — a fresh
  // POST lands on a warm survivor), then the in-tab snapshot() as the fallback. Auth refusals
  // (401/403) do NOT fall back — the tab would hit the same wall slower.
  function freezeVia(datasetId, ownerLayer, meta, say) {
    return serverFreeze(datasetId, say).catch(function (e1) {
      if (!/job stalled/.test(e1.message || '')) throw e1;
      say('Freeze worker stalled — retrying…');
      return serverFreeze(datasetId, say);
    }).catch(function (e) {
      if (/: 401|: 403/.test(e.message || '')) throw e;
      say('Server freeze unavailable — freezing in this tab…');
      return snapshot(ownerLayer, datasetId, meta, say);
    });
  }

  // register + freeze, with progress reported to a caller-supplied line
  function registerAndFreeze(layerDbId, meta, say, fork) {
    say = say || function () {};
    say(fork ? 'Making this copy independent + registering…' : 'Registering…');
    return register(layerDbId, meta, fork).then(function (id) {
      // The freeze reads the DATASET'S origin layer, not the clicked one: registering a pointer
      // copy re-targets server-side (register-through-lineage, 8/12) to the layer that owns the
      // rows — paging the clicked layer here is how NARN got a 724-byte zip of nothing.
      return db.from('datasets').select('origin_layer_id').eq('id', id).single().then(function (o) {
        return (o.data && o.data.origin_layer_id) || layerDbId;
      }).then(function (ownerLayer) {
      return freezeVia(id, ownerLayer, meta, say).then(function (s) {
        return { id: id, snapshot: s };
      }).catch(function (e) {
        // the registration itself succeeded — say so rather than implying nothing happened
        throw new Error('Registered (id ' + id + ') but the read-only copy failed: ' + e.message);
      });
      });
    });
  }

  // ── one layer: the panel button's modal ───────────────────────────────────
  function openRegister(node, existing, opts) {
    opts = opts || {};
    var lid = node && (node._layerDbId || node._dataLayerId);
    if (!lid) return;
    var drawn = node.source_type === 'geojson-supabase' || !!node.pmtiles;
    var m = modal(opts.fork ? 'Register this copy as a NEW dataset' : (existing ? 'Dataset' : 'Register this layer as a dataset'));
    if (opts.fork) {
      m.body.appendChild(el('div', '', 'This copy currently shows its source’s data. Registering makes it fully independent (its own rows) — your edits stay, the original dataset is untouched, and every feature keeps its origin dataset id.')).className = 'msds-note';
    }
    // The registration summary (8/13, owner: "at the top of the window... beneath the name"):
    // Registered · MSD or not · features · size · link to the dataset page.
    if (existing) {
      var sum = el('div', 'display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:0 0 12px;padding:8px 10px;background:#f6f2ff;border:1px solid #e0d8f2;border-radius:6px;font-size:12.5px;color:#443f58;');
      var reg = el('b', '', '✓ Registered');
      reg.style.color = '#2f6b3a';
      sum.appendChild(reg);
      var msdTag = el('span', '', existing.msd ? 'MSD' : 'Not an MSD');
      msdTag.title = 'MSD = MapStructor Dataset — the first-party designation';
      msdTag.style.cssText = existing.msd
        ? 'background:#2d7a2d;color:#ffffff;font-weight:700;padding:1px 8px;border-radius:9px;font-size:11px;'
        : 'color:#8a8598;font-size:11.5px;';
      sum.appendChild(msdTag);
      if (existing.feature_count) sum.appendChild(el('span', '', Number(existing.feature_count).toLocaleString() + ' features'));
      if (existing.snapshot_bytes) sum.appendChild(el('span', '', fmtBytes(existing.snapshot_bytes)));
      var pg = document.createElement('a');
      pg.href = (location.pathname.indexOf('/map/') > -1 ? '../' : '') + 'dataset.html?id=' + encodeURIComponent(existing.slug || existing.id);
      pg.target = '_blank'; pg.rel = 'noopener';
      pg.textContent = 'Open dataset page ↗';
      pg.style.cssText = 'color:#5b4b9a;font-weight:600;text-decoration:none;';
      sum.appendChild(pg);
      m.body.appendChild(sum);
    }
    var form = buildForm((opts.fork ? null : existing) || { name: node.label || '' }, { drawn: drawn });
    m.body.appendChild(form.el);
    form.grow();

    var prog = el('span', '', ''); prog.className = 'msds-prog';
    var save = el('button', '', existing ? 'Save changes' : 'Register + freeze a copy'); save.className = 'msds-btn pri';
    var cancel = el('button', '', 'Cancel'); cancel.className = 'msds-btn';
    m.foot.appendChild(prog); m.foot.appendChild(cancel); m.foot.appendChild(save);
    cancel.addEventListener('click', m.close);

    if (existing) {
      var dl = el('div', 'margin-top:12px;', '');
      if (existing.snapshot_key) {
        var a = document.createElement('a');
        a.href = snapshotUrl(existing.snapshot_key); a.target = '_blank'; a.rel = 'noopener';
        a.textContent = '⬇ read-only copy (' + fmtBytes(existing.snapshot_bytes) + ', ' + (existing.feature_count || 0).toLocaleString() + ' features)';
        dl.appendChild(a);
      } else {
        // registration succeeded but the freeze failed or was skipped — offer to finish it,
        // instead of leaving a registered dataset with no way to ever get its frozen copy
        dl.appendChild(el('span', 'color:#a8342a;font-size:12px;', 'No read-only copy yet.'));
      }
      var re = el('button', 'margin-left:10px;', existing.snapshot_key ? 'Re-freeze' : 'Freeze a copy now'); re.className = 'msds-btn';
      re.title = existing.snapshot_key ? 'Replace the frozen copy with the layer as it stands now' : 'Read the layer and store its frozen read-only copy';
      re.addEventListener('click', function () {
        re.disabled = true;
        // the freeze reads the DATASET'S origin layer, never the clicked one — a pointer copy
        // paged here is how NARN got a 724-byte zip of nothing (registerAndFreeze does the same)
        db.from('datasets').select('origin_layer_id').eq('id', existing.id).single()
          .then(function (o) { return (o.data && o.data.origin_layer_id) || lid; })
          .then(function (ownerLayer) { return freezeVia(existing.id, ownerLayer, form.read(), function (s) { prog.textContent = s; }); })
          .then(function () { prog.textContent = 'Copy frozen.'; re.disabled = false; })
          .catch(function (e) { prog.textContent = ''; showErr(m, e.message); re.disabled = false; });
      });
      dl.appendChild(re);
      m.body.appendChild(dl);
    }

    save.addEventListener('click', function () {
      var meta = form.read();
      if (!meta.name) { showErr(m, 'A dataset name is required.'); return; }
      save.disabled = true; cancel.disabled = true;
      var run = (existing && !opts.fork)
        ? register(lid, meta).then(function (id) { return { id: id }; })
        : registerAndFreeze(lid, meta, function (s) { prog.textContent = s; }, !!opts.fork);
      run.then(function () {
        prog.textContent = 'Done.';
        setTimeout(function () { m.close(); refreshPanel(node); }, 500);
      }).catch(function (e) {
        prog.textContent = ''; showErr(m, e.message);
        save.disabled = false; cancel.disabled = false;
      });
    });
    form.focus();
  }
  function showErr(m, msg) {
    var e = m.foot.querySelector('.msds-err');
    if (!e) { e = el('span', '', ''); e.className = 'msds-err'; m.foot.insertBefore(e, m.foot.firstChild); }
    e.textContent = msg;
  }

  // ── the layer panel button ────────────────────────────────────────────────
  var _panelNode = null;
  function refreshPanel(node) { if (node) onLayerPanel(node); }
  function onLayerPanel(node) {
    var body = document.getElementById('elp-body');
    if (!body) return;
    var btn = document.getElementById('elp-dataset');
    if (!btn) {
      btn = document.createElement('button');
      btn.id = 'elp-dataset';
      btn.style.cssText = 'display:none;width:100%;box-sizing:border-box;margin:0 0 8px;padding:6px 10px;border:1px solid #cfc4ea;border-radius:6px;background:#f6f2ff;color:#5b4b9a;font:600 12px Source Sans Pro,Arial,sans-serif;cursor:pointer;';
      btn.addEventListener('click', function () {
        var n = _panelNode; if (!n) return;
        var lid = n._layerDbId || n._dataLayerId;
        datasetsForLayers([lid])
          .then(function (map) { openRegister(n, map[lid] || null); })
          .catch(function () { openRegister(n, null); });   // can't tell → offer to register
      });
      var anchor = document.getElementById('elp-rebake');
      if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(btn, anchor);
      else body.insertBefore(btn, body.firstChild);
    }
    _panelNode = node;
    var lid = node && (node._layerDbId || node._dataLayerId);
    // Companions INHERIT — an outline split off a fill, a linked mirror and an instance are all the
    // same data wearing a different hat, so registering them separately would double-count it.
    var inherits = !!(node && (node.instanceOf || node.outlineOf));
    if (!lid || inherits) { btn.style.display = 'none'; return; }
    isAdmin().then(function (ok) {
      if (!ok) { btn.style.display = 'none'; return; }
      btn.style.display = 'block';
      btn.textContent = '🏷 Register as dataset';
      btn.title = 'Give this layer a permanent id, record where it came from, and freeze a read-only copy';
      // fork button (8/13): when the dataset is INHERITED through lineage (this layer is an
      // "All" copy of a registered layer), the owner can register THIS copy as a NEW dataset —
      // the server hydrates it into a real, independent copy first.
      var forkBtn = document.getElementById('elp-dataset-fork');
      if (!forkBtn) {
        forkBtn = document.createElement('button');
        forkBtn.id = 'elp-dataset-fork';
        forkBtn.style.cssText = 'display:none;width:100%;box-sizing:border-box;margin:0 0 8px;padding:6px 10px;border:1px solid #e3d2b8;border-radius:6px;background:#fdf8ef;color:#8a6420;font:600 12px Source Sans Pro,Arial,sans-serif;cursor:pointer;';
        forkBtn.textContent = '⑂ Register this copy as a NEW dataset…';
        forkBtn.title = 'This copy inherits its source’s dataset. Make it independent (its own data) and register it as a new dataset — your edits stay, the original is untouched.';
        forkBtn.addEventListener('click', function () { var n = _panelNode; if (n) openRegister(n, null, { fork: true }); });
        btn.parentNode.insertBefore(forkBtn, btn.nextSibling);
      }
      forkBtn.style.display = 'none';
      datasetsForLayers([lid]).then(function (map) {
        if (_panelNode !== node) return;
        var d = map[lid];
        if (d) {
          btn.textContent = '🏷 Dataset: ' + d.name;
          btn.title = 'Registered as "' + d.name + '" (' + d.licence + ') — click to view or edit';
          btn.style.background = '#f2fbf3'; btn.style.borderColor = '#bfe3c4'; btn.style.color = '#2f6b3a';
          // inherited (origin is another layer) → this is a copy; offer the fork
          db.from('datasets').select('origin_layer_id').eq('id', d.id).single().then(function (o) {
            if (_panelNode !== node) return;
            if (o.data && o.data.origin_layer_id && o.data.origin_layer_id !== lid) forkBtn.style.display = 'block';
          });
        } else {
          btn.style.background = '#f6f2ff'; btn.style.borderColor = '#cfc4ea'; btn.style.color = '#5b4b9a';
          // an EDITED copy owns overlay rows, so it no longer inherits through lineage — but its
          // POINTERS may still lead to a registered source. Offer the fork there too (8/13).
          if (node._msCopyOf || node._msFromLayer) {
            db.rpc('ms_dataset_for_fork', { p_layer: lid }).then(function (r) {
              if (_panelNode !== node) return;
              if (!r.error && r.data && r.data.id) {
                forkBtn.style.display = 'block';
                forkBtn.textContent = '⑂ Register as a NEW dataset (copy of "' + r.data.name + '")…';
              }
            });
          }
        }
      }).catch(function () { /* the button stays on its default label — clicking still works */ });
    });
  }

  // ── the map gate (point 6) ────────────────────────────────────────────────
  // Which layers of this map are not yet COVERED by a dataset? The server answers
  // (ms_dataset_missing — the exact clause ms_portal_eligible enforces), so the checklist and
  // the real gate can never drift. Coverage = origin layer, OR own rows stamped, OR lineage
  // (_msCopyOf / _msFromLayer / instanceOf) pointing at stamped rows (owner 8/12: all ways).
  function missingForProject(projectId) {
    if (!db) return Promise.resolve([]);
    return db.rpc('ms_dataset_missing', { p_project: projectId }).then(function (r) {
      if (r.error) throw new Error(r.error.message);
      return (r.data || []).map(function (l) {
        return { id: l.layer_id, name: l.layer_name || '(unnamed layer)', source_type: l.source_type };
      });
    });
    // deliberately NOT catching: a failed check must not read as "nothing is missing". The caller
    // shows "couldn't check" instead, and the database rule stays the real gate either way.
  }

  // The bulk modal, as the owner walked it through (8/12, twice — the second pass split
  // FILLING from REGISTERING):
  //   1 · it opens as a plain tick-list of the unregistered layers — no form in sight
  //   2 · tick the layers that share their facts, click "Share Info" → the common form appears
  //       (every field EXCEPT the name — each dataset is named after its layer automatically)
  //   3 · "Done" FILLS that shared info in for every ticked layer. Nothing is registered yet —
  //       the info is staged, and the rows say so
  //   4 · click any layer row → its OWN form, prefilled with the staged facts — adjust the
  //       specifics for that one (even its name) and Save; still nothing registered
  //   5 · "Register the ticked layers" (the button that was always at the bottom) commits:
  //       each ticked layer registers with its staged info, stamps its data, freezes its copy
  function openBulk(projectId, onDone) {
    missingForProject(projectId).then(function (missing) {
      if (!missing.length) { if (onDone) onDone(true); return; }
      var m = modal('Register these layers');
      m.body.appendChild(el('div', '', 'Tick the layers that share their info, click Share Info, fill the shared facts once, and click Done — that fills them in for every ticked layer (each dataset is named after its layer). Click any layer to adjust its own specifics. Nothing is saved to the catalogue until you click Register below.')).className = 'msds-note';

      var staged = {};   // layerId -> the meta that Register will use

      var btnRow = el('div', 'display:flex;gap:8px;margin:10px 0 8px;');
      var all = el('button', '', 'Select none'); all.className = 'msds-btn';
      var share = el('button', '', 'Share Info'); share.className = 'msds-btn pri';
      var done = el('button', '', 'Done'); done.className = 'msds-btn pri';
      done.style.display = 'none';   // appears once the form is up — Done means "fill it in"
      btnRow.appendChild(all); btnRow.appendChild(share); btnRow.appendChild(done);
      m.body.appendChild(btnRow);

      var boxes = [];
      function markStaged(b) {
        if (b.cb.disabled) return;   // already registered — leave the ✓ alone
        b.noteEl.textContent = 'info filled — click to adjust';
      }
      // click a row's NAME → that layer's own form (name included), editing the STAGE only
      function openOne(b) {
        if (b.cb.disabled) return;   // registered — nothing to stage any more
        var pm = modal(b.layer.name);
        var f = buildForm(staged[b.layer.id] || { name: b.layer.name }, {});
        pm.body.appendChild(f.el); f.grow();
        var save = el('button', '', 'Save'); save.className = 'msds-btn pri';
        var back = el('button', '', 'Cancel'); back.className = 'msds-btn';
        pm.foot.appendChild(back); pm.foot.appendChild(save);
        back.addEventListener('click', pm.close);
        save.addEventListener('click', function () {
          var meta = f.read();
          if (!meta.name) meta.name = b.layer.name;
          staged[b.layer.id] = meta;
          markStaged(b);
          pm.close();
        });
        f.focus();
      }
      var list = document.createElement('div'); list.style.cssText = 'margin:2px 0 10px;';
      missing.forEach(function (L) {
        var row = document.createElement('div'); row.className = 'msds-row';
        var c = document.createElement('input'); c.type = 'checkbox'; c.checked = true;
        var nm = el('span', 'flex:1;cursor:pointer;', L.name);
        nm.title = 'Open this layer’s own form — specific info, overwriting the shared facts if need be';
        var note = document.createElement('small');
        var b = { cb: c, layer: L, row: row, nameEl: nm, noteEl: note };
        nm.addEventListener('click', function () { openOne(b); });
        row.appendChild(c); row.appendChild(nm); row.appendChild(note);
        list.appendChild(row);
        boxes.push(b);
      });
      m.body.appendChild(list);

      all.addEventListener('click', function () {
        var any = boxes.some(function (b) { return b.cb.checked && !b.cb.disabled; });
        boxes.forEach(function (b) { if (!b.cb.disabled) b.cb.checked = !any; });
        all.textContent = any ? 'Select all' : 'Select none';
      });

      // the common form stays out of sight until Share Info summons it
      var formWrap = el('div', 'display:none;margin-top:4px;');
      m.body.appendChild(formWrap);
      var form = null;
      share.addEventListener('click', function () {
        if (!form) { form = buildForm({}, { noName: true }); formWrap.appendChild(form.el); }
        formWrap.style.display = '';
        form.grow(); form.focus();
        share.style.display = 'none';
        done.style.display = '';
      });
      done.addEventListener('click', function () {
        var picked = boxes.filter(function (b) { return b.cb.checked && !b.cb.disabled; });
        if (!picked.length) { showErr(m, 'Tick at least one layer.'); return; }
        var base = form.read();
        picked.forEach(function (b) {
          var meta = JSON.parse(JSON.stringify(base));
          meta.name = (staged[b.layer.id] && staged[b.layer.id].name) || b.layer.name;
          staged[b.layer.id] = meta;
          markStaged(b);
        });
        formWrap.style.display = 'none';
        done.style.display = 'none';
        share.style.display = ''; share.textContent = 'Share Info (edit)';
        prog.textContent = 'Filled in for ' + picked.length + ' layer' + (picked.length === 1 ? '' : 's') + ' — adjust any of them, then Register below.';
      });

      var prog = el('span', '', ''); prog.className = 'msds-prog';
      var go = el('button', '', 'Register the ticked layers'); go.className = 'msds-btn pri';
      var cancel = el('button', '', 'Close'); cancel.className = 'msds-btn';
      m.foot.appendChild(prog); m.foot.appendChild(cancel); m.foot.appendChild(go);
      cancel.addEventListener('click', function () { m.close(); if (onDone) onDone(false); });

      go.addEventListener('click', async function () {
        var picked = boxes.filter(function (b) { return b.cb.checked && !b.cb.disabled; });
        if (!picked.length) { showErr(m, 'Tick at least one layer.'); return; }
        go.disabled = true; cancel.disabled = true;
        var n = 0;
        for (var i = 0; i < picked.length; i++) {
          var b = picked[i];
          // never registered blank by accident: with nothing staged, the layer still registers
          // under its own name with the licence Unknown — the one answer that never blocks
          var meta = staged[b.layer.id] || { name: b.layer.name };
          try {
            /* eslint-disable no-await-in-loop */
            await registerAndFreeze(b.layer.id, meta, function (s) { prog.textContent = b.layer.name + ': ' + s; });
            b.row.className = 'msds-row done';
            b.nameEl.textContent = b.layer.name + '  ✓';
            b.noteEl.textContent = '';
            b.cb.checked = false; b.cb.disabled = true;
            n++;
          } catch (e) {
            prog.textContent = '';
            showErr(m, b.layer.name + ' — ' + e.message);
            go.disabled = false; cancel.disabled = false;
            return;
          }
        }
        cancel.disabled = false;
        missingForProject(projectId).then(function (still) {
          prog.textContent = still.length
            ? n + ' registered — ' + still.length + ' still to go.'
            : n + ' registered — all done.';
          go.disabled = !still.length;
          if (!still.length && onDone) onDone(true);
        });
      });
    });
  }

  window.MSDatasets = {
    LICENCES: LICENCES,
    licenceOf: licenceOf,
    isAdmin: isAdmin,
    register: register,
    registerAndFreeze: registerAndFreeze,
    snapshot: snapshot,
    snapshotUrl: snapshotUrl,
    datasetsForLayers: datasetsForLayers,
    missingForProject: missingForProject,
    openRegister: openRegister,
    openBulk: openBulk,
    onLayerPanel: onLayerPanel,
    usage: function (id) { return db.rpc('ms_dataset_usage', { p_dataset: id }); }
  };
})();
