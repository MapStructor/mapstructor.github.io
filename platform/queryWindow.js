/* queryWindow.js — the power/query window (7/17).
   "⚡ Query" button in the editor's add-row → a draggable window with three tabs:
     • Operations — named, safe, server-side PostGIS ops (run
       mapstructor_docs/sql/setup/query-ops-setup.sql once). duplicate_layer =
       sandbox copies; merge_lines_timeline = ONE complete merged line per
       company per era (time cut at every segment start/end; geometry
       duplicates across eras BY DESIGN so the slider always shows whole
       lines); optional single-company test via "only". Every op: dry-run
       stats first, apply writes to a NEW layer (originals untouched unless
       "replace" is checked — and even then only unlinked, never deleted).
     • SQL — DuckDB-WASM in YOUR browser (lazy ~35 MB one-time load). Query the
       selected layer, or any GeoParquet/CSV/JSON URL on the web in place —
       nothing passes through our servers. Results preview on the map; save as
       a new layer.
     • JS — a scratch function over the selected layer's GeoJSON (ms.features);
       return features to preview/save.
   One pipeline for all tabs: run → preview (cyan) → save as new layer (via the
   editor's import seam, so auto-convert/tree/panel all behave like an import).
   The operations registry is published as window.MSOps — the future AI
   assistant emits calls against the same registry the buttons use.
   Self-contained: delete this file + its include line to remove. */
(function () {
  "use strict";
  if (window._msQuery) return;

  function db() { return (typeof MapAuth !== "undefined" && MapAuth.db) || null; }
  function nfmt(n) { try { return Number(n).toLocaleString("en-US"); } catch (e) { return String(n); } }
  function pid() { return (typeof platformProjectId !== "undefined" && platformProjectId) || window.platformProjectId || null; }

  /* ── shared pipeline: preview on both maps + history ───────────────────── */
  var PV = "msq-preview";
  function maps() {
    var m = [];
    try { if (typeof beforeMap !== "undefined" && beforeMap) m.push(beforeMap); } catch (e) {}
    try { if (typeof afterMap !== "undefined" && afterMap) m.push(afterMap); } catch (e) {}
    return m;
  }
  function clearPreview() {
    maps().forEach(function (m) {
      [PV + "-fill", PV + "-line", PV + "-circle"].forEach(function (id) { try { if (m.getLayer(id)) m.removeLayer(id); } catch (e) {} });
      try { if (m.getSource(PV)) m.removeSource(PV); } catch (e) {}
    });
  }
  function showPreview(fc) {
    clearPreview();
    maps().forEach(function (m) {
      try {
        m.addSource(PV, { type: "geojson", data: fc });
        m.addLayer({ id: PV + "-fill", type: "fill", source: PV, filter: ["==", ["geometry-type"], "Polygon"], paint: { "fill-color": "#00e5c7", "fill-opacity": 0.25 } });
        m.addLayer({ id: PV + "-line", type: "line", source: PV, filter: ["!=", ["geometry-type"], "Point"], paint: { "line-color": "#00b39b", "line-width": 2.5, "line-dasharray": [2, 1.5] } });
        m.addLayer({ id: PV + "-circle", type: "circle", source: PV, filter: ["==", ["geometry-type"], "Point"], paint: { "circle-color": "#00e5c7", "circle-radius": 5, "circle-stroke-color": "#00655a", "circle-stroke-width": 1.5 } });
      } catch (e) {}
    });
  }
  var history = [];
  function pushHist(tab, summary) {
    history.unshift({ t: new Date().toLocaleTimeString(), tab: tab, s: summary });
    if (history.length > 30) history.pop();
    var h = document.getElementById("msq-hist");
    if (h) h.innerHTML = history.map(function (x) { return "<div class='msq-hrow'><b>" + x.t + " · " + x.tab + "</b> — " + x.s + "</div>"; }).join("");
  }

  /* ── data helpers ──────────────────────────────────────────────────────── */
  async function projectLayers() {
    if (!pid()) return [];
    var r = await db().from("project_layers").select("layers(id, name, type)").eq("project_id", pid());
    return ((r && r.data) || []).map(function (x) { return x.layers; }).filter(Boolean);
  }
  async function layerKeys(lid) {
    var r = await db().from("features").select("custom_fields").eq("layer_id", lid).limit(40);
    var keys = {};
    ((r && r.data) || []).forEach(function (f) { Object.keys(f.custom_fields || {}).forEach(function (k) { keys[k] = 1; }); });
    return ["label"].concat(Object.keys(keys).sort());
  }
  // full layer → FeatureCollection (paged; props flattened: label/dates + custom fields)
  async function fetchLayerFC(lid, status) {
    status = status || function () {};
    var feats = [], from = 0;
    for (;;) {
      var r = await db().from("features").select("feature_id, geom, label, description, start_date, end_date, custom_fields").eq("layer_id", lid).order("feature_id").range(from, from + 999);
      if (r.error) throw new Error(r.error.message);
      (r.data || []).forEach(function (f) {
        var p = { feature_id: f.feature_id, label: f.label, description: f.description, start_date: f.start_date, end_date: f.end_date };
        Object.keys(f.custom_fields || {}).forEach(function (k) { if (!(k in p)) p[k] = f.custom_fields[k]; });
        feats.push({ type: "Feature", id: f.feature_id, geometry: f.geom, properties: p });
      });
      status("Loading layer… " + nfmt(feats.length) + " features");
      if (!r.data || r.data.length < 1000) break;
      from += 1000;
    }
    return { type: "FeatureCollection", features: feats };
  }
  function toFC(out) {   // normalize whatever a tab returned into a FeatureCollection (or null)
    if (!out) return null;
    if (out.type === "FeatureCollection") return out;
    if (out.type === "Feature") return { type: "FeatureCollection", features: [out] };
    if (Array.isArray(out) && out.length && out[0] && out[0].type === "Feature") return { type: "FeatureCollection", features: out };
    return null;
  }
  async function saveAsLayer(fc, name, status) {
    if (!fc || !fc.features || !fc.features.length) throw new Error("nothing to save");
    if (typeof window._msImportFC !== "function") throw new Error("editor import seam not available");
    status("Saving " + nfmt(fc.features.length) + " features as a new layer…");
    await window._msImportFC(fc, name || "Query result");
    clearPreview();
    return fc.features.length;
  }

  /* ── OPERATIONS registry (window.MSOps — the AI seam) ──────────────────── */
  function rpcHint(msg) { return msg + (/(function|does not exist|postgis)/i.test(msg) ? " — run mapstructor_docs/sql/setup/query-ops-setup.sql first (Ctrl+A!)" : ""); }
  async function rpc(fn, args) {
    var r = await db().rpc(fn, args);
    if (r.error) throw new Error(rpcHint(r.error.message));
    return r.data;
  }
  function isTimeout(m) { return /timeout|canceling statement/i.test(m || ""); }
  // resilient batched copy: transient errors retry with backoff, timeouts shrink
  // the batch (3000 → … → 200) and keep going — "always works" beats fast
  async function copyIds(target, ids, label, status, onChunk) {
    var i = 0, ch = 3000, copied = 0, fails = 0;
    while (i < ids.length) {
      var batch = ids.slice(i, i + ch);
      try {
        copied += await rpc("ms_copy_features", { p_target: target, p_ids: batch });
        i += batch.length; fails = 0;
        if (onChunk) onChunk(i);
        status(label + " " + nfmt(copied) + "/" + nfmt(ids.length));
      } catch (e) {
        fails++;
        if (fails > 6) throw e;
        if (isTimeout(e.message) && ch > 200) { ch = Math.max(200, ch >> 1); status(label + " slow patch — retrying with smaller batches (" + nfmt(ch) + ")…"); }
        else { status(label + " hiccup — retrying…"); }
        await new Promise(function (r) { setTimeout(r, 900 * fails); });
      }
    }
    return copied;
  }
  // chunked FULL delete of a layer — a one-shot delete times out on big layers
  async function wipeLayer(layerId, status) {
    status = status || function () {};
    status("Listing features to remove…");
    var ids = (await rpc("ms_layer_ids", { p_layer: layerId, p_passthrough_key: null })) || [];
    for (var i = 0; i < ids.length; i += 2000) {
      var r = await db().from("features").delete().in("feature_id", ids.slice(i, i + 2000));
      if (r.error) throw new Error(r.error.message);
      status("Removing features… " + nfmt(Math.min(i + 2000, ids.length)) + "/" + nfmt(ids.length));
    }
    await db().from("project_layers").delete().eq("layer_id", layerId);
    await db().from("layers").delete().eq("id", layerId);
    return ids.length;
  }
  function fmtBytes(b) {
    if (!b && b !== 0) return "?";
    if (b >= 1e9) return (b / 1e9).toFixed(1) + " GB";
    if (b >= 1e6) return Math.round(b / 1e6) + " MB";
    return Math.round(b / 1e3) + " KB";
  }
  // ── merge resume state (localStorage) — a big merge survives failures and
  // page reloads: progress is remembered per source layer+key, and the era RPC
  // is idempotent per company, so Apply after a failure CONTINUES, not restarts.
  function mergeStateKey(p) { return "msq_merge_" + p.layer + "_" + (p.key || "label"); }
  function loadMergeState(p) { try { return JSON.parse(localStorage.getItem(mergeStateKey(p)) || "null"); } catch (e) { return null; } }
  function saveMergeState(p, st) { try { localStorage.setItem(mergeStateKey(p), JSON.stringify(st)); } catch (e) {} }
  function clearMergeState(p) { try { localStorage.removeItem(mergeStateKey(p)); } catch (e) {} }
  // ── one company, a WINDOW of eras per call — for companies too big to merge
  // in a single ~8s statement. The skip=0 call clears the company's rows in the
  // target first, so retries/resumes replace instead of duplicate. A timed-out
  // call rolls back whole, so `skip` only ever advances past committed eras.
  async function mergeCompanyByEras(p, key, name, target, simplify, status) {
    var skip = 0, take = 12, fails = 0, out = { eras: 0, segs: 0, copies: 0 };
    while (true) {
      try {
        var r = await rpc("ms_merge_company_eras", { p_layer: p.layer, p_name: name, p_key: key, p_target: target, p_skip: skip, p_take: take, p_dry_run: false, p_simplify: simplify });
        out.segs = r.namedSegments; out.eras += r.merged; out.copies += Number(r.geometryCopies || 0);
        skip += r.merged; fails = 0;
        status('Big company "' + name + '" — era by era… ' + skip + "/" + r.totalEras);
        if (r.done) return out;
        if (take < 12) take++;   // creep back up after a slow patch
      } catch (e) {
        fails++;
        if (isTimeout(e.message)) {
          if (take > 1) { take = Math.max(1, take >> 1); status('"' + name + '" is heavy — ' + take + " era(s) per call…"); }
          else if (fails > 3) throw new Error('company "' + name + '" — even ONE era won\'t fit in a single call. Tell Claude (a per-era geometry split is the next lever).');
        } else if (fails > 6) throw e;
        await new Promise(function (r2) { setTimeout(r2, 900 * fails); });
      }
    }
  }
  var _lastTarget = null;   // result layer of the op in flight — offered for cleanup if the op dies
  async function offerCleanup(status) {
    if (!_lastTarget) return;
    var t = _lastTarget; _lastTarget = null;
    if (!confirm("The operation failed partway. Delete the partial result layer so it doesn't waste storage?")) return;
    try { await wipeLayer(t, status); status("Partial result cleaned up."); }
    catch (e) { status("Cleanup failed: " + e.message + " — use 'Delete layer' below."); }
  }
  // new empty layer row + project link, styled after the source layer
  async function makeResultLayer(srcLayerId, suffix, status) {
    status("Creating the result layer…");
    var src = await db().from("layers").select("name, color, type, paint").eq("id", srcLayerId).single();
    var s = (src && src.data) || {};
    var row = {
      slug: "msq" + Math.random().toString(36).slice(2, 8),
      name: (s.name || "layer") + " " + suffix,
      color: s.color || "#7b5cd6",
      type: s.type || "line",
      source_type: "geojson-supabase",
      paint: s.paint || null,
      enabled_by_default: true
    };
    var nl = await db().from("layers").insert(row).select("id").single();
    if (nl.error) throw new Error("layer insert: " + nl.error.message);
    var so = 0;
    try {
      var mr = await db().from("project_layers").select("sort_order").eq("project_id", pid()).order("sort_order", { ascending: false }).limit(1);
      so = ((mr.data && mr.data[0] && mr.data[0].sort_order) || 0) + 1;
    } catch (e) {}
    var pl = await db().from("project_layers").insert({ project_id: pid(), layer_id: nl.data.id, sort_order: so });
    if (pl.error) throw new Error("project link: " + pl.error.message);
    _lastTarget = nl.data.id;
    return nl.data.id;
  }
  var OPS = {
    duplicate_layer: {
      title: "Duplicate layer",
      desc: "Server-side copy of a layer (features never download) — a sandbox to test operations on. Chunked so no call hits Supabase's ~8s statement timeout. Counts toward storage.",
      params: { layer: "uuid — source layer id" },
      apply: async function (p, status) {
        status = status || function () {};
        status("Listing the layer's features…");
        var ids = (await rpc("ms_layer_ids", { p_layer: p.layer, p_passthrough_key: null })) || [];
        if (!ids.length) throw new Error("that layer has no features");
        var target = await makeResultLayer(p.layer, "(copy)", status);
        var copied = await copyIds(target, ids, "Copying on the server…", status);
        _lastTarget = null;
        return { copied: copied, newLayerId: target };
      }
    },
    merge_lines_timeline: {
      title: "Merge complete lines per company, per era",
      desc: "For each key value (company), time is cut wherever any of its segments starts or ends; for each era ALL segments alive then merge into ONE feature stamped with that era's dates. At any slider position you see one complete line per company. Geometry duplicates across eras by design. Server-side; result goes to a NEW layer. Big companies merge era-by-era; a failed apply RESUMES on the next apply.",
      params: { layer: "uuid — source layer id", key: "string — 'label' or a custom-field name", only: "string|null — restrict to one key value (testing)", simplify: "number|null — simplify tolerance in METERS (shrinks result, shape kept)", replaceOriginal: "boolean — unlink (not delete) the original from this map" },
      // Batched by SIZE, not name-count: companies are sized up front, small ones
      // pack into segment-capped batches, and any company too big for a single
      // ~8s call merges ERA-BY-ERA (ms_merge_company_eras). Every finished
      // company is remembered, so a failed apply RESUMES instead of restarting.
      run: async function (p, write, target, status) {
        status = status || function () {};
        var key = p.key || "label";
        var simplify = (p.simplify && p.simplify > 0) ? p.simplify / 111320 : null;   // meters → degrees (4326)
        var agg = { namedSegments: 0, names: 0, eras: 0, resultFeatures: 0, geometryCopies: 0, passthrough: 0, sample: [], only: p.only || null, applied: write, newLayerId: target || null, skippedCompanies: 0 };
        if (p.only) {
          var st = await rpc("ms_merge_lines_timeline", { p_layer: p.layer, p_key: key, p_dry_run: !write, p_target: target || null, p_only: p.only, p_names: null, p_simplify: simplify });
          agg.namedSegments = st.namedSegments; agg.names = st.names; agg.eras = st.eras;
          agg.resultFeatures = st.resultFeatures; agg.geometryCopies = st.geometryCopies; agg.sample = st.sample;
          agg.dupFactor = st.dupFactor;
          return agg;
        }
        status("Sizing companies…");
        var counts = (await rpc("ms_layer_key_counts", { p_layer: p.layer, p_key: key })) || [];   // [{k, n}] small → large
        if (!counts.length) throw new Error("no mergeable named lines under that key");
        agg.names = counts.length;
        var resume = (write && p._resume) || null;
        var done = (resume && resume.doneNames) || {};
        var todo = counts.filter(function (c) { return !done[c.k]; });
        agg.skippedCompanies = counts.length - todo.length;
        var doneCount = agg.skippedCompanies;
        function finished(names2) {
          doneCount += names2.length;
          if (resume) { names2.forEach(function (n) { resume.doneNames[n] = 1; }); p._save && p._save(); }
          status((write ? "Merging" : "Analyzing") + " companies… " + doneCount + "/" + counts.length);
        }
        // pack by total segments (CAP per batch); apply routes big companies to era-mode
        var BIG = write ? 1500 : Infinity, CAP = 3500;
        var eraCos = todo.filter(function (c) { return c.n >= BIG; });
        var batches = [], cur = [], sz = 0;
        todo.forEach(function (c) {
          if (c.n >= BIG) return;
          if (cur.length && (sz + c.n > CAP || cur.length >= 60)) { batches.push(cur); cur = []; sz = 0; }
          cur.push(c.k); sz += c.n;
        });
        if (cur.length) batches.push(cur);
        var bi = 0, fails = 0;
        while (bi < batches.length) {
          var chunk = batches[bi];
          try {
            var st2 = await rpc("ms_merge_lines_timeline", { p_layer: p.layer, p_key: key, p_dry_run: !write, p_target: target || null, p_only: null, p_names: chunk, p_simplify: simplify });
            agg.namedSegments += st2.namedSegments; agg.eras += st2.eras; agg.geometryCopies += Number(st2.geometryCopies || 0);
            agg.resultFeatures += st2.eras;
            if (agg.sample.length < 10) agg.sample = agg.sample.concat(st2.sample || []).slice(0, 10);
            bi++; fails = 0; finished(chunk);
          } catch (e2) {
            fails++;
            if (isTimeout(e2.message) && chunk.length > 1) {
              var mid = chunk.length >> 1;   // split just the slow batch — the rest keep their size
              batches.splice(bi, 1, chunk.slice(0, mid), chunk.slice(mid));
              status("Slow batch — splitting it…"); fails = Math.min(fails, 3);
            } else if (isTimeout(e2.message) && chunk.length === 1) {
              // one company that can't merge in a single call → era-windowed path
              if (write) {
                var r3 = await mergeCompanyByEras(p, key, chunk[0], target, simplify, status);
                agg.namedSegments += r3.segs; agg.eras += r3.eras; agg.geometryCopies += r3.copies; agg.resultFeatures += r3.eras;
              } else {
                var r4 = await rpc("ms_merge_company_eras", { p_layer: p.layer, p_name: chunk[0], p_key: key, p_target: null, p_skip: 0, p_take: 100000, p_dry_run: true, p_simplify: null });
                agg.namedSegments += r4.namedSegments; agg.eras += r4.totalEras; agg.geometryCopies += Number(r4.geometryCopies || 0); agg.resultFeatures += r4.totalEras;
              }
              bi++; fails = 0; finished(chunk);
              continue;   // era path succeeded — no backoff needed
            } else if (fails > 6) { throw e2; }
            else { status("Hiccup — retrying…"); }
            await new Promise(function (r) { setTimeout(r, 900 * Math.max(1, fails)); });
          }
        }
        for (var ei = 0; ei < eraCos.length; ei++) {   // the pre-identified giants
          var r5 = await mergeCompanyByEras(p, key, eraCos[ei].k, target, simplify, status);
          agg.namedSegments += r5.segs; agg.eras += r5.eras; agg.geometryCopies += r5.copies; agg.resultFeatures += r5.eras;
          finished([eraCos[ei].k]);
        }
        if (write) {   // pass-through (unnamed lines + non-lines): resilient id-batch copy, resumable
          var pids = (await rpc("ms_layer_ids", { p_layer: p.layer, p_passthrough_key: key })) || [];
          var startAt = Math.min((resume && resume.pass) || 0, pids.length);
          var rest = pids.slice(startAt);
          if (rest.length) {
            await copyIds(target, rest, "Copying pass-through features…", status, function (i2) {
              if (resume) { resume.pass = startAt + i2; p._save && p._save(); }
            });
          }
          agg.passthrough += pids.length; agg.resultFeatures += pids.length;
        } else {
          agg.passthrough = (await rpc("ms_layer_ids", { p_layer: p.layer, p_passthrough_key: key }) || []).length;
          agg.resultFeatures += agg.passthrough;
        }
        agg.dupFactor = agg.namedSegments ? Math.round(100 * agg.geometryCopies / agg.namedSegments) / 100 : 0;
        return agg;
      },
      dryRun: function (p, status) { return OPS.merge_lines_timeline.run(p, false, null, status); },
      apply: async function (p, status) {
        status = status || function () {};
        var target = null, resumed = false;
        var prev = !p.only && loadMergeState(p);
        if (prev && prev.target) {
          var still = null;
          try { still = await db().from("layers").select("id").eq("id", prev.target).maybeSingle(); } catch (e) {}
          if (still && still.data) {
            if (confirm("A previous merge of this layer stopped partway (" + Object.keys(prev.doneNames || {}).length + " companies finished). RESUME into the same result layer?\n\nOK = resume where it left off · Cancel = start fresh")) {
              target = prev.target; resumed = true;
            } else { clearMergeState(p); }
          } else { clearMergeState(p); prev = null; }
        }
        if (!target) target = await makeResultLayer(p.layer, p.only ? "(merged: " + p.only + ")" : "(merged)", status);
        _lastTarget = target;
        if (!p.only) {
          var st8 = resumed ? prev : { target: target, doneNames: {}, pass: 0 };
          saveMergeState(p, st8);
          p._resume = st8;
          p._save = function () { saveMergeState(p, st8); };
        }
        var agg;
        try {
          agg = await OPS.merge_lines_timeline.run(p, true, target, status);
        } catch (e) {
          e._mergeResumable = !p.only;   // progress is saved — Apply again continues
          throw e;
        }
        if (!p.only) clearMergeState(p);   // an `only` test must not clear a full run's saved progress
        p._resume = null;
        _lastTarget = null;
        agg.resumed = resumed;
        if (p.replaceOriginal && !p.only) {
          status("Unlinking the original from this map (its data stays in the database)…");
          await db().from("project_layers").delete().eq("project_id", pid()).eq("layer_id", p.layer);
        }
        return agg;
      }
    },
    merge_lines: {   // simple variant: only exact same-dates segments merge (kept for the registry/AI)
      title: "Merge touching lines by name (same dates only)",
      desc: "Joins touching segments that share the same key AND identical start/end dates. Use merge_lines_timeline for whole-line-per-era results.",
      params: { layer: "uuid — source layer id", key: "string — 'label' or a custom-field name", replaceOriginal: "boolean" },
      dryRun: function (p) { return rpc("ms_merge_lines", { p_layer: p.layer, p_key: p.key || "label", p_dry_run: true, p_target: null }); },
      apply: async function (p, status) {
        status = status || function () {};
        var target = await makeResultLayer(p.layer, "(merged)", status);
        status("Merging on the server… (nothing downloads)");
        var stats = await rpc("ms_merge_lines", { p_layer: p.layer, p_key: p.key || "label", p_dry_run: false, p_target: target });
        if (p.replaceOriginal) {
          status("Unlinking the original from this map (its data stays in the database)…");
          await db().from("project_layers").delete().eq("project_id", pid()).eq("layer_id", p.layer);
        }
        stats.newLayerId = target;
        return stats;
      }
    }
  };
  window.MSOps = {
    registry: OPS,
    dryRun: function (name, params, status) { return OPS[name].dryRun(params, status); },
    run: function (name, params, status) { return OPS[name].apply(params, status || function () {}); }
  };

  /* ── SQL tab: DuckDB-WASM, lazy-loaded on first Run ────────────────────── */
  var _duck = null;
  async function duck(status) {
    if (_duck) return _duck;
    // reuse the VENDORED, already-warmed engine the attribute tables use (platform/bigtable.js) —
    // no CDN, no second 35 MB download, and it's often prefetched at idle so this is instant.
    // A separate connection keeps our registered files/views isolated from the table's paging.
    if (window.MSBigTable) {
      try {
        var e = await window.MSBigTable.ensureEngine();
        _duck = { db: e.adb, conn: await e.adb.connect(), duckdb: e.duckdb, shared: true };
        return _duck;
      } catch (eShared) { /* engine missing/broken — fall back to the CDN copy below */ }
    }
    status("Loading the SQL engine (one-time ~35 MB; cached by the browser after)…");
    var m = await import("https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.29.0/+esm");
    var bundle = await m.selectBundle(m.getJsDelivrBundles());
    var wurl = URL.createObjectURL(new Blob(['importScripts("' + bundle.mainWorker + '");'], { type: "text/javascript" }));
    var worker = new Worker(wurl);
    var d = new m.AsyncDuckDB(new m.ConsoleLogger(), worker);
    await d.instantiate(bundle.mainModule, bundle.pthreadWorker);
    URL.revokeObjectURL(wurl);
    _duck = { db: d, conn: await d.connect(), duckdb: m };
    return _duck;
  }
  function cellStr(v) {
    if (v == null) return "";
    if (typeof v === "bigint") return String(v);
    if (typeof v === "object") { try { return JSON.stringify(v); } catch (e) { return String(v); } }
    return String(v);
  }
  async function runSQL(sql, status) {
    var d = await duck(status);
    status("Running…");
    var res = await d.conn.query(sql);
    var cols = res.schema.fields.map(function (f) { return f.name; });
    var rows = res.toArray().map(function (r) { return typeof r.toJSON === "function" ? r.toJSON() : r; });
    return { cols: cols, rows: rows };
  }
  // Load the selected layer as the SQL table `layer` (+ legacy `'layer.json'` in full mode).
  // FAST path (wantGeom=false + a fresh Parquet sidecar exists): point DuckDB straight at the
  // ~1–2 MB columnar sidecar over HTTP range reads — instant, no row stream. Attributes only.
  // FULL path (geometry referenced, or no sidecar): stream every feature WITH geometry from
  // Postgres (the original behavior) so map preview / save-as-layer keep working.
  var _sqlLoadMode = null;   // 'fast' | 'full' — for Run-time messaging
  var _loadedLid = null;     // which layer is currently registered as `layer` (skip redundant reloads)
  async function sidecarMeta(lid) {   // {url, ver, rows} when a fresh, count-matching sidecar exists, else null
    if (!window.MSBigTable) return null;
    try {
      var q = await db().from("layers").select("raw_config").eq("id", lid).single();
      var rc = (q.data && q.data.raw_config) || {};
      if (!rc.attrParquet || rc.attrParquetDirty) return null;
      var cq = await db().from("features").select("feature_id", { count: "exact", head: true }).eq("layer_id", lid);
      if (((cq && cq.count) || 0) !== rc.attrParquetRows) return null;   // edited since the bake → not fresh
      return { url: rc.attrParquet, ver: rc.attrParquetAt, rows: rc.attrParquetRows };
    } catch (e) { return null; }
  }
  async function loadLayerIntoDuck(lid, status, wantGeom) {
    var d = await duck(status);
    var sc = wantGeom ? null : await sidecarMeta(lid);
    if (sc) {
      // sidecar columns: std as-is + custom fields as "c:<key>" — alias them back to bare names
      // so the SQL you'd write for either mode is identical (SELECT "InOpBy", not "c:InOpBy")
      var fname = "qw_" + lid + ".parquet";
      try { await d.db.dropFile(fname); } catch (e0) {}
      await d.db.registerFileURL(fname, sc.url + "?v=" + encodeURIComponent(sc.ver || "0"), d.duckdb.DuckDBDataProtocol.HTTP, false);
      var head = await d.conn.query("SELECT * FROM read_parquet('" + fname + "') LIMIT 0");
      var fields = head.schema.fields.map(function (f) { return f.name; });
      var std = ["feature_id", "label", "description", "start_date", "end_date", "content_id"];
      var sel = [];
      std.forEach(function (s) { if (fields.indexOf(s) > -1) sel.push('"' + s + '"'); });
      fields.forEach(function (f) {
        if (f.indexOf("c:") !== 0) return;
        var bare = f.slice(2);
        if (std.indexOf(bare) > -1) return;   // a custom field colliding with a std name keeps its c: name
        sel.push('"' + f.replace(/"/g, '""') + '" AS "' + bare.replace(/"/g, '""') + '"');
      });
      await d.conn.query("CREATE OR REPLACE VIEW layer AS SELECT " + sel.join(", ") + " FROM read_parquet('" + fname + "')");
      _sqlLoadMode = "fast"; _loadedLid = lid;
      return { n: sc.rows, mode: "fast" };
    }
    var fc = await fetchLayerFC(lid, status);
    var rows = fc.features.map(function (f) {
      var o = {};
      Object.keys(f.properties || {}).forEach(function (k) { o[k] = f.properties[k]; });
      o.geom = JSON.stringify(f.geometry);   // GeoJSON text — usable, and turns back into geometry on save
      return o;
    });
    try { await d.db.dropFile("layer.json"); } catch (e) {}
    await d.db.registerFileText("layer.json", JSON.stringify(rows));
    await d.conn.query("CREATE OR REPLACE VIEW layer AS SELECT * FROM read_json_auto('layer.json')");
    _sqlLoadMode = "full"; _loadedLid = lid;
    return { n: rows.length, mode: "full" };
  }
  // if a result column holds GeoJSON geometry (object or text), rebuild a FeatureCollection
  function sqlResultToFC(cols, rows) {
    if (!rows.length) return null;
    var gcol = null;
    cols.forEach(function (c) {
      if (gcol) return;
      var v = rows[0][c];
      if (v && typeof v === "object" && v.type && v.coordinates) gcol = c;
      else if (typeof v === "string" && /^\s*\{/.test(v)) { try { var g = JSON.parse(v); if (g && g.type && g.coordinates) gcol = c; } catch (e) {} }
    });
    if (!gcol) return null;
    var feats = [];
    rows.forEach(function (r) {
      var g = r[gcol];
      if (typeof g === "string") { try { g = JSON.parse(g); } catch (e) { g = null; } }
      if (!g || !g.type) return;
      var p = {};
      cols.forEach(function (c) { if (c !== gcol) p[c] = typeof r[c] === "bigint" ? Number(r[c]) : r[c]; });
      feats.push({ type: "Feature", geometry: g, properties: p });
    });
    return feats.length ? { type: "FeatureCollection", features: feats } : null;
  }

  /* ── JS tab ────────────────────────────────────────────────────────────── */
  async function runJS(code, lid, status) {
    var fc = lid ? await fetchLayerFC(lid, status) : null;
    var logs = [];
    var ms = {
      features: fc,
      turf: window.turf || null,
      log: function () { logs.push(Array.prototype.slice.call(arguments).map(cellStr).join(" ")); }
    };
    status("Running…");
    var fn = new Function("ms", '"use strict";\n' + code);
    var out = await fn(ms);
    return { fc: toFC(out), logs: logs, raw: out };
  }

  /* ── UI ────────────────────────────────────────────────────────────────── */
  function css() {
    if (document.getElementById("msq-css")) return;
    var s = document.createElement("style");
    s.id = "msq-css";
    s.textContent =
      "#msq-modal{position:fixed;left:90px;top:60px;z-index:5000;width:600px;max-width:96vw;background:#f8f8f8;border:1px solid #d7d3e4;border-radius:10px;box-shadow:0 10px 34px rgba(40,32,80,.25);font:14px 'Source Sans Pro',Arial,sans-serif;color:#333;display:none;}" +
      "#msq-head{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:#fff;border-bottom:1px solid #e4e0ef;border-radius:10px 10px 0 0;cursor:move;font-weight:700;}" +
      "#msq-x{cursor:pointer;font-size:20px;color:#8b86a3;padding:0 6px;border-radius:6px;}#msq-x:hover{background:#f1eef9;color:#4c4374;}" +
      "#msq-tabs{display:flex;gap:4px;padding:8px 14px 0;background:#fff;border-bottom:1px solid #e4e0ef;}" +
      ".msq-tab{padding:6px 14px;border:1px solid #e4e0ef;border-bottom:none;border-radius:8px 8px 0 0;background:#f1eef9;color:#6a6390;cursor:pointer;font-weight:600;font-size:13px;}" +
      ".msq-tab.on{background:#fff;color:#4c3d8f;border-color:#c9bfe8;position:relative;top:1px;}" +
      ".msq-lead{padding:10px 14px;margin:0;font-size:12.5px;line-height:1.5;color:#5b537d;background:#f7f5fd;border-bottom:1px solid #ece8f7;}" +
      "#msq-body{padding:12px 14px;max-height:72vh;overflow:auto;}" +
      ".msq-sec{background:#fff;border:1px solid #e4e0ef;border-radius:8px;padding:10px 12px;margin-bottom:10px;}" +
      ".msq-sec h4{margin:0 0 8px;font-size:13px;color:#5b458f;text-transform:uppercase;letter-spacing:.6px;}" +
      ".msq-row{display:flex;gap:6px;align-items:center;margin:6px 0;flex-wrap:wrap;}" +
      ".msq-in{flex:1;min-width:120px;padding:8px 11px;border:1px solid #ccc;border-radius:5px;font:inherit;background:#fff;}" +
      "select.msq-in{padding-right:28px;}" +
      ".msq-in option{padding:6px 10px;}" +
      ".msq-btn{padding:6px 12px;border:1px solid #b9aee0;border-radius:6px;background:#efeaff;color:#4c3d8f;font:600 13px inherit;cursor:pointer;}" +
      ".msq-btn:hover{background:#e4dcff;}" +
      ".msq-btn[disabled]{opacity:.5;cursor:default;}" +
      ".msq-go{border-color:#8fd0b9;background:#e8fbf2;color:#1c6b4c;}" +
      ".msq-note{color:#7a758f;font-size:12.5px;margin-top:4px;line-height:1.45;}" +
      ".msq-status{color:#5b458f;font-weight:600;font-size:13px;min-height:18px;margin-top:6px;white-space:normal;}" +
      ".msq-code{width:100%;min-height:110px;box-sizing:border-box;font:12.5px/1.5 Consolas,Menlo,monospace;border:1px solid #ccc;border-radius:6px;padding:8px;background:#fff;color:#333;resize:vertical;}" +
      "#msq-out{max-height:230px;overflow:auto;margin-top:8px;}#msq-out table{border-collapse:collapse;}#msq-out td,#msq-out th{border:1px solid #e4e0ef;padding:3px 7px;font-size:12px;white-space:nowrap;max-width:280px;overflow:hidden;text-overflow:ellipsis;}" +
      "#msq-hist{max-height:120px;overflow:auto;}.msq-hrow{font-size:12px;color:#5f5a75;padding:3px 0;border-bottom:1px solid #f0edf7;}" +
      ".msq-stats{font-size:13px;line-height:1.6;}";
    document.head.appendChild(s);
  }

  var el = null, curTab = "ops", lastFC = null;
  function status(m) { var s = document.getElementById("msq-status"); if (s) s.textContent = m || ""; }

  function modal() {
    if (el) return el;
    css();
    el = document.createElement("div");
    el.id = "msq-modal";
    el.innerHTML =
      '<div id="msq-head"><span>⚡ Query &amp; operations</span><span id="msq-x">&times;</span></div>' +
      '<div id="msq-tabs">' +
      '<div class="msq-tab on" data-t="ops">Operations</div>' +
      '<div class="msq-tab" data-t="sql">SQL</div>' +
      '<div class="msq-tab" data-t="js">JS</div>' +
      "</div>" +
      '<div id="msq-body">' +

      // OPERATIONS
      '<div id="msq-pane-ops">' +
      '<div class="msq-lead"><b>Operations</b> — ready-made, safe actions (no code). Pick a layer, run; results save to a <b>new</b> layer and originals are never touched.</div>' +
      '<div class="msq-sec"><h4>Duplicate layer (sandbox copy)</h4>' +
      '<div class="msq-row"><select id="msq-dup-layer" class="msq-in"></select><button id="msq-dup" class="msq-btn">Duplicate → "(copy)"</button></div>' +
      '<div class="msq-note">Server-side copy — nothing downloads. Test operations on the copy; delete it when done. Counts toward storage while it exists.</div>' +
      "</div>" +
      '<div class="msq-sec"><h4>Delete layer (full, chunked)</h4>' +
      '<div class="msq-row"><select id="msq-del-layer" class="msq-in"></select><button id="msq-del" class="msq-btn" style="border-color:#e0b9b9;background:#ffefef;color:#8f3d3d;">Delete completely</button></div>' +
      '<div class="msq-note">Removes the layer\'s features in batches (the normal delete can time out on big layers), then the layer itself — from <b>every</b> map that uses it. Frees storage. No undo.</div>' +
      "</div>" +
      '<div class="msq-sec"><h4>Merge complete lines per company, per era</h4>' +
      '<div class="msq-row"><select id="msq-op-layer" class="msq-in"></select><select id="msq-op-key" class="msq-in"></select></div>' +
      '<div class="msq-row"><input id="msq-op-only" class="msq-in" placeholder="only this name (optional — cheap single-company test)"></div>' +
      '<div class="msq-row"><input id="msq-op-simplify" class="msq-in" type="number" min="0" step="1" placeholder="simplify tolerance in meters (optional — e.g. 10 shrinks the result a LOT, shape kept)"></div>' +
      '<div class="msq-row"><button id="msq-op-dry" class="msq-btn">Dry run (stats only)</button>' +
      '<button id="msq-op-apply" class="msq-btn msq-go" disabled>Apply → new layer</button>' +
      '<label style="font-size:12.5px;color:#6a6390;"><input type="checkbox" id="msq-op-replace"> replace original on this map (unlink only — data stays)</label></div>' +
      '<div id="msq-op-stats" class="msq-stats"></div>' +
      '<div class="msq-note">Time is cut wherever any of a company\'s segments starts or ends (an <b>era</b>); within each era, all segments alive then merge into <b>one complete line</b> stamped with that era\'s dates — so the slider always shows whole lines, never fragments. Geometry duplicates across eras by design (the dry run shows the factor). Unnamed lines and non-lines pass through. Runs on the server in size-packed batches; companies too big for one call merge <b>era by era</b>, and a failed run <b>resumes</b> — hit Apply again and it continues where it stopped (never duplicates). Optional <b>simplify</b> keeps shapes but shrinks the result (~10 m is invisible at map scale). Nothing downloads. Needs <b>query-ops-setup.sql</b> (v6) run once.</div>' +
      "</div></div>" +

      // SQL
      '<div id="msq-pane-sql" style="display:none">' +
      '<div class="msq-lead"><b>SQL</b> — ask questions of a layer\'s data (counts, unique values, filters). Pick a common question below, or write your own. Runs on <b>your</b> machine.</div>' +
      '<div class="msq-sec"><h4>SQL — DuckDB in your browser</h4>' +
      '<div class="msq-row"><select id="msq-sql-layer" class="msq-in"></select></div>' +
      '<div class="msq-row"><select id="msq-sql-common" class="msq-in"></select><select id="msq-sql-col" class="msq-in"><option value="">— column —</option></select></div>' +
      '<textarea id="msq-sql" class="msq-code" spellcheck="false" placeholder="-- pick a layer above and Run — it loads automatically (query it as `layer`):\n-- SELECT label, COUNT(*) AS n FROM layer GROUP BY 1 ORDER BY n DESC;   (quote mixed-case names: \\"InOpBy\\")\n\n-- shapes on the map? reference geom (loads the full layer):\n-- SELECT label, geom FROM layer LIMIT 50;\n\n-- any file on the web, queried in place (nothing passes through our servers):\n-- SELECT * FROM read_parquet(\'https://example.com/data.parquet\') LIMIT 100;"></textarea>' +
      '<div class="msq-row"><button id="msq-sql-run" class="msq-btn msq-go">Run</button><button id="msq-sql-save" class="msq-btn" disabled>Save result as layer</button><button id="msq-clear1" class="msq-btn">Clear preview</button></div>' +
      '<div class="msq-note">The engine loads once (~35 MB, then browser-cached) and runs on <b>your</b> machine. A result column holding GeoJSON geometry previews on the map automatically.</div>' +
      "</div></div>" +

      // JS
      '<div id="msq-pane-js" style="display:none">' +
      '<div class="msq-lead"><b>JS</b> — for custom logic SQL can\'t express: write JavaScript over the layer\'s features and return the ones you want. For power users.</div>' +
      '<div class="msq-sec"><h4>JS — script over a layer</h4>' +
      '<div class="msq-row"><select id="msq-js-layer" class="msq-in"></select></div>' +
      '<textarea id="msq-js" class="msq-code" spellcheck="false" placeholder="// ms.features = the selected layer as GeoJSON; ms.log(...) prints below.\n// Return features (FeatureCollection / array / one Feature) to preview them.\n// e.g. keep only pre-1900 features:\nreturn ms.features.features.filter(f => (f.properties.start_date||\'\') < \'1900\');"></textarea>' +
      '<div class="msq-row"><button id="msq-js-run" class="msq-btn msq-go">Run</button><button id="msq-js-save" class="msq-btn" disabled>Save result as layer</button><button id="msq-clear2" class="msq-btn">Clear preview</button></div>' +
      '<div class="msq-note">Runs in your browser with plain JavaScript (async allowed). Returned features preview in cyan; save writes a real new layer.</div>' +
      "</div></div>" +

      '<div class="msq-sec"><h4>Result</h4><div id="msq-out" class="msq-note">Nothing yet.</div></div>' +
      '<div class="msq-sec"><h4>History (this session)</h4><div id="msq-hist" class="msq-note">Empty.</div></div>' +
      '<div class="msq-status" id="msq-status"></div>' +
      "</div>";
    document.body.appendChild(el);

    el.querySelector("#msq-x").addEventListener("click", function () { el.style.display = "none"; });
    el.querySelector("#msq-head").addEventListener("mousedown", function (e) {
      if (e.target.id === "msq-x") return;
      e.preventDefault();
      var sx = e.clientX, sy = e.clientY, r = el.getBoundingClientRect(), ox = r.left, oy = r.top;
      function mv(ev) { el.style.left = Math.max(0, ox + ev.clientX - sx) + "px"; el.style.top = Math.max(0, oy + ev.clientY - sy) + "px"; }
      function up() { document.removeEventListener("mousemove", mv); document.removeEventListener("mouseup", up); }
      document.addEventListener("mousemove", mv); document.addEventListener("mouseup", up);
    });
    el.querySelectorAll(".msq-tab").forEach(function (t) {
      t.addEventListener("click", function () {
        curTab = t.getAttribute("data-t");
        el.querySelectorAll(".msq-tab").forEach(function (x) { x.classList.toggle("on", x === t); });
        ["ops", "sql", "js"].forEach(function (k) { document.getElementById("msq-pane-" + k).style.display = k === curTab ? "" : "none"; });
      });
    });

    // operations wiring
    el.querySelector("#msq-dup").addEventListener("click", onDup);
    el.querySelector("#msq-del").addEventListener("click", onDelLayer);
    el.querySelector("#msq-op-layer").addEventListener("change", fillOpKeys);
    el.querySelector("#msq-op-dry").addEventListener("click", onOpDry);
    el.querySelector("#msq-op-apply").addEventListener("click", onOpApply);
    // sql wiring
    fillCommonSelect();
    el.querySelector("#msq-sql-layer").addEventListener("change", fillSqlCols);
    el.querySelector("#msq-sql-common").addEventListener("change", onCommonPick);
    el.querySelector("#msq-sql-run").addEventListener("click", onSqlRun);
    el.querySelector("#msq-sql-save").addEventListener("click", function () { onSave("SQL result"); });
    el.querySelector("#msq-clear1").addEventListener("click", clearPreview);
    // js wiring
    el.querySelector("#msq-js-run").addEventListener("click", onJsRun);
    el.querySelector("#msq-js-save").addEventListener("click", function () { onSave("JS result"); });
    el.querySelector("#msq-clear2").addEventListener("click", clearPreview);
    return el;
  }

  async function fillLayerSelects() {
    var ls = [];
    try { ls = await projectLayers(); } catch (e) {}
    var opts = '<option value="">— layer —</option>' + ls.map(function (l) { return '<option value="' + l.id + '">' + (l.name || "layer") + "</option>"; }).join("");
    ["msq-dup-layer", "msq-op-layer", "msq-sql-layer", "msq-js-layer"].forEach(function (id) {
      var s = document.getElementById(id);
      var v = s.value;
      s.innerHTML = opts;
      if (v) s.value = v;
    });
    // the delete tool lists EVERY layer you own (cleanup targets often aren't on this map)
    try {
      var all = await db().from("layers").select("id, name").order("created_at", { ascending: false });
      var ds = document.getElementById("msq-del-layer");
      ds.innerHTML = '<option value="">— any layer you own —</option>' +
        ((all.data || []).map(function (l) { return '<option value="' + l.id + '">' + (l.name || "layer") + "</option>"; }).join(""));
    } catch (e) {}
    fillOpKeys();
  }
  async function fillOpKeys() {
    var lsel = document.getElementById("msq-op-layer"), ksel = document.getElementById("msq-op-key");
    if (!lsel.value) { ksel.innerHTML = "<option value='label'>key: label</option>"; return; }
    ksel.innerHTML = "<option>loading…</option>";
    try {
      var ks = await layerKeys(lsel.value);
      ksel.innerHTML = ks.map(function (k) { return '<option value="' + k + '">key: ' + k + "</option>"; }).join("");
    } catch (e) { ksel.innerHTML = "<option value='label'>key: label</option>"; }
  }

  function showStats(st) {
    var d = document.getElementById("msq-op-stats");
    var top = (st.sample || []).map(function (s) { return s.k + " (" + nfmt(s.eras) + " eras)"; }).slice(0, 6).join(", ");
    d.innerHTML =
      "<b>" + nfmt(st.namedSegments) + "</b> named segments · <b>" + nfmt(st.names) + "</b> companies · <b>" + nfmt(st.eras) + "</b> eras" +
      "<br>Result layer: <b>" + nfmt(st.resultFeatures) + "</b> features (one complete line per company per era" +
      (st.passthrough ? " + " + nfmt(st.passthrough) + " pass-through" : "") + ")" +
      "<br>Geometry copies: <b>" + nfmt(st.geometryCopies) + "</b> (×" + st.dupFactor + " the source — eras duplicate geometry by design)" +
      (st.projBytes ? "<br>Projected result size: <b>~" + fmtBytes(st.projBytes) + "</b> before simplify" +
        (st.projBytes > 250e6 ? " — <b style='color:#a33d3d'>⚠ that can blow the free 500 MB database.</b> Set the simplify option (10 m is usually invisible on a map), or merge → Publish to tiles → delete the merged layer." : "") : "") +
      (st.resumed || st.skippedCompanies ? "<br><span class='msq-note'>Resumed — " + nfmt(st.skippedCompanies) + " companies were already done from the earlier run (totals above cover this run only).</span>" : "") +
      (st.only ? "<br><span class='msq-note'>Test mode: only \"" + st.only + "\" (pass-through skipped)</span>" : "") +
      (top ? "<br><span class='msq-note'>Most eras: " + top + "</span>" : "");
  }
  function opParams() {
    return {
      layer: document.getElementById("msq-op-layer").value,
      key: document.getElementById("msq-op-key").value,
      only: document.getElementById("msq-op-only").value.trim() || null,
      simplify: parseFloat(document.getElementById("msq-op-simplify").value) || null,
      replaceOriginal: document.getElementById("msq-op-replace").checked
    };
  }
  async function onDup() {
    var lid = document.getElementById("msq-dup-layer").value;
    if (!lid) { status("Pick a layer to duplicate."); return; }
    if (!confirm("Duplicate this layer now? The copy counts toward storage until you delete it.")) return;
    try {
      var res = await MSOps.run("duplicate_layer", { layer: lid }, status);
      status("Duplicated ✓ — " + nfmt(res.copied) + " features in the \"(copy)\" layer.");
      pushHist("Operations", "DUPLICATED layer (" + nfmt(res.copied) + " features)");
      if (confirm("Duplicated " + nfmt(res.copied) + " features. Reload now to show the new layer on the map?")) location.reload();
    } catch (e) { status("Duplicate failed: " + e.message); await offerCleanup(status); }
  }
  async function onOpDry() {
    var p = opParams();
    if (!p.layer) { status("Pick a layer."); return; }
    status("Dry run — counting on the server…");
    try {
      var st = await MSOps.dryRun("merge_lines_timeline", p, status);
      if (!p.only && st.dupFactor) {   // projected size ≈ source live bytes × duplication factor
        try {
          var ls = await db().rpc("mapstructor_layer_stat", { p_layer: p.layer });
          if (!ls.error && ls.data && ls.data.bytes) st.projBytes = Number(ls.data.bytes) * st.dupFactor;
        } catch (e9) {}
      }
      showStats(st);
      document.getElementById("msq-op-apply").disabled = !st.eras;
      status(st.eras ? "Dry run done — nothing written. Apply when ready." : "No mergeable named lines found" + (p.only ? " for \"" + p.only + "\"" : "") + ".");
      pushHist("Operations", "dry-run timeline merge: " + nfmt(st.namedSegments) + " segs → " + nfmt(st.eras) + " eras" + (p.only ? " (only " + p.only + ")" : ""));
    } catch (e) { status("Dry run failed: " + e.message); }
  }
  async function onOpApply() {
    var p = opParams();
    if (!p.layer) { status("Pick a layer."); return; }
    if (!confirm("Merge into a NEW layer now?" + (p.only ? " Test mode: only \"" + p.only + "\"." : "") + (p.replaceOriginal && !p.only ? " The original will be unlinked from this map (its data stays in the database)." : " The original stays on the map too."))) return;
    try {
      var st = await MSOps.run("merge_lines_timeline", p, status);
      showStats(st);
      status("Merged ✓ — " + nfmt(st.resultFeatures) + " features in the new layer" + (st.resumed ? " (resumed run — count covers the remainder)" : "") + ".");
      pushHist("Operations", "APPLIED timeline merge → new layer, " + nfmt(st.resultFeatures) + " features" + (p.only ? " (only " + p.only + ")" : "") + (st.resumed ? " (resumed)" : ""));
      if (confirm("Merge complete. Reload now to show the new layer on the map?")) location.reload();
    } catch (e) {
      status("Apply stopped: " + e.message);
      if (e._mergeResumable) {
        // progress is SAVED and the merge is idempotent per company — Apply again continues
        _lastTarget = null;
        if (confirm("The merge stopped partway, but your progress is SAVED.\n\nOK = keep the partial layer (hit Apply again anytime to RESUME where it left off)\nCancel = delete the partial layer and forget the progress")) {
          status("Progress kept — hit Apply again to resume the merge.");
        } else {
          try { await wipeLayer(loadMergeState(p).target, status); } catch (e4) {}
          clearMergeState(p);
          status("Partial result deleted.");
        }
      } else { await offerCleanup(status); }
    }
  }
  async function onDelLayer() {
    var sel = document.getElementById("msq-del-layer");
    var lid = sel.value;
    if (!lid) { status("Pick a layer to delete."); return; }
    var nm = sel.options[sel.selectedIndex].textContent;
    if (!confirm('FULLY delete "' + nm + '" — all its features, from every map that uses it?')) return;
    if (!confirm("Really delete? This cannot be undone.")) return;
    try {
      var n = await wipeLayer(lid, status);
      status("Deleted ✓ — " + nfmt(n) + " features freed. Reload to update the map.");
      pushHist("Operations", "DELETED layer " + nm + " (" + nfmt(n) + " features)");
      fillLayerSelects();
    } catch (e) { status("Delete failed: " + e.message); }
  }

  function renderTable(cols, rows) {
    var out = document.getElementById("msq-out");
    if (!rows.length) { out.innerHTML = "0 rows."; return; }
    var lim = rows.slice(0, 200);
    var h = "<table><tr>" + cols.map(function (c) { return "<th>" + c + "</th>"; }).join("") + "</tr>";
    lim.forEach(function (r) { h += "<tr>" + cols.map(function (c) { return "<td>" + cellStr(r[c]) + "</td>"; }).join("") + "</tr>"; });
    out.innerHTML = h + "</table>" + (rows.length > 200 ? "<div class='msq-note'>Showing 200 of " + nfmt(rows.length) + " rows.</div>" : "");
  }
  // ── common queries: a menu of ready-made questions (extend this list to add more) ──
  function qcol(c) { return '"' + String(c).replace(/"/g, '""') + '"'; }
  var COMMON_SQL = [
    {
      id: "uniques", label: "How many uniques? — count each distinct value in a column", needsCol: true,
      // ordered BY THE VALUE (numbers ascending, then text A–Z) — years/ids come out 1830,1835,1837…
      // like the queries you've been writing. Swap to `ORDER BY count DESC` for most-common-first.
      sql: function (c) { return "SELECT " + qcol(c) + " AS value, COUNT(*) AS count\nFROM layer\nGROUP BY 1\nORDER BY TRY_CAST(value AS DOUBLE) NULLS LAST, value;"; }
    }
  ];
  function fillCommonSelect() {
    var s = document.getElementById("msq-sql-common"); if (!s) return;
    s.innerHTML = '<option value="">Common questions…</option>' + COMMON_SQL.map(function (c) { return '<option value="' + c.id + '">' + c.label + "</option>"; }).join("");
  }
  async function fillSqlCols() {   // populate the column picker from the selected layer
    var lsel = document.getElementById("msq-sql-layer"), csel = document.getElementById("msq-sql-col");
    if (!csel) return;
    if (!lsel.value) { csel.innerHTML = '<option value="">— column —</option>'; return; }
    csel.innerHTML = '<option value="">loading…</option>';
    try {
      var ks = await layerKeys(lsel.value);   // ['label', ...custom fields]
      // + the standard editable columns, so "uniques per year" (start_date) etc. are pickable too
      var cols = ["label", "start_date", "end_date", "description"].concat(ks.filter(function (k) { return k !== "label"; }));
      csel.innerHTML = '<option value="">— column —</option>' + cols.map(function (k) { return '<option value="' + k + '">' + k + "</option>"; }).join("");
    } catch (e) { csel.innerHTML = '<option value="">— column —</option>'; }
  }
  async function onCommonPick() {
    var sel = document.getElementById("msq-sql-common"), cid = sel.value;
    if (!cid) return;
    var spec = COMMON_SQL.filter(function (c) { return c.id === cid; })[0];
    var lid = document.getElementById("msq-sql-layer").value;
    var col = document.getElementById("msq-sql-col").value;
    sel.value = "";   // reset so the same item can be re-picked
    if (!lid) { status("Pick a layer first, then the question."); return; }
    if (spec.needsCol && !col) { status("Pick a column first (the “— column —” dropdown), then the question."); return; }
    document.getElementById("msq-sql").value = spec.sql(col);   // show it — editable, and teaches the SQL
    await onSqlRun();
  }
  // Run auto-loads the selected layer if the SQL queries `layer` and it isn't already loaded the
  // right way (there's no separate Load button anymore — loading is instant). External-URL
  // queries that don't reference `layer` just run.
  async function ensureSqlLayerLoaded(sql) {
    if (!/\b(from|join)\s+layer\b/i.test(sql)) return;   // not a layer query (e.g. read_parquet of a web URL)
    var lid = document.getElementById("msq-sql-layer").value;
    if (!lid) throw new Error("Pick a layer first (the top dropdown).");
    var wantGeom = /\bgeom\b|\bgeometry\b|\bst_[a-z_]+\s*\(/i.test(sql);
    // reload only when the layer changed, or we need geometry but only have the fast (geom-less) load;
    // a full load is a superset, so attribute queries reuse it
    if (_loadedLid !== lid || (wantGeom && _sqlLoadMode !== "full")) {
      status(wantGeom ? "Loading the layer (with geometry)…" : "Loading…");
      await loadLayerIntoDuck(lid, status, wantGeom);
    }
  }
  async function onSqlRun() {
    var sql = document.getElementById("msq-sql").value.trim();
    if (!sql) { status("Type some SQL, or pick a common question above."); return; }
    try {
      await ensureSqlLayerLoaded(sql);   // no separate Load button — Run loads the layer if needed
      var res = await runSQL(sql, status);
      renderTable(res.cols, res.rows);
      lastFC = sqlResultToFC(res.cols, res.rows);
      document.getElementById("msq-sql-save").disabled = !lastFC;
      if (lastFC) showPreview(lastFC);
      status(nfmt(res.rows.length) + " rows" + (lastFC ? " — geometry found, previewing in cyan." : "."));
      pushHist("SQL", sql.slice(0, 70) + (sql.length > 70 ? "…" : "") + " → " + nfmt(res.rows.length) + " rows");
    } catch (e) {
      var msg = (e && e.message ? e.message : String(e));
      // fast (sidecar) mode registers the table as `layer`, not the file 'layer.json'
      if (_sqlLoadMode === "fast" && /layer\.json/i.test(sql) && /layer\.json/i.test(msg))
        msg = "The table is called `layer` now — query `FROM layer` (not read_json_auto('layer.json')).";
      status("SQL failed: " + msg);
    }
  }
  async function onJsRun() {
    var code = document.getElementById("msq-js").value;
    var lid = document.getElementById("msq-js-layer").value;
    if (!code.trim()) { status("Type some JS (return features to preview them)."); return; }
    try {
      var res = await runJS(code, lid || null, status);
      lastFC = res.fc;
      document.getElementById("msq-js-save").disabled = !lastFC;
      var out = document.getElementById("msq-out");
      var logHtml = res.logs.length ? "<div class='msq-note'>" + res.logs.map(cellStr).join("<br>") + "</div>" : "";
      if (lastFC) {
        showPreview(lastFC);
        out.innerHTML = logHtml + "<b>" + nfmt(lastFC.features.length) + "</b> features returned — previewing in cyan.";
        status("Done.");
      } else {
        out.innerHTML = logHtml + "<div class='msq-note'>Returned: " + cellStr(res.raw).slice(0, 400) + "</div>";
        status("Done (no features returned).");
      }
      pushHist("JS", (lastFC ? nfmt(lastFC.features.length) + " features" : "no features") + (res.logs.length ? ", " + res.logs.length + " logs" : ""));
    } catch (e) { status("JS failed: " + (e && e.message ? e.message : e)); }
  }
  async function onSave(name) {
    if (!lastFC) { status("Run something that returns features first."); return; }
    var nm = prompt("Name for the new layer:", name);
    if (!nm) return;
    try {
      var n = await saveAsLayer(lastFC, nm, status);
      status("Saved ✓ — " + nfmt(n) + " features as \"" + nm + "\".");
      pushHist(curTab === "sql" ? "SQL" : "JS", "SAVED \"" + nm + "\" (" + nfmt(n) + " features)");
    } catch (e) { status("Save failed: " + e.message); }
  }

  function open() { modal().style.display = "block"; fillLayerSelects(); }
  window._msQuery = { open: open, fetchLayerFC: fetchLayerFC, showPreview: showPreview, clearPreview: clearPreview, saveAsLayer: saveAsLayer };

  // "⚡ Query" button in the editor's add-row — re-injected if the row re-renders
  function inject() {
    var row = document.querySelector("#editor-add-buttons .erow");
    if (row && !document.getElementById("msq-open")) {
      var b = document.createElement("button");
      b.id = "msq-open";
      b.textContent = "⚡ Query";
      b.title = "Query & operations (merge lines, SQL, JS)";
      b.addEventListener("click", function (e) { e.preventDefault(); open(); });
      row.appendChild(b);
    }
  }
  setInterval(inject, 1500);
  inject();
})();
