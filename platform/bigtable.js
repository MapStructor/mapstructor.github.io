// MSBigTable — the big-data attribute tier (7/18).
//
// PATTERN (SYSTEMS_MAP.md: bake-at-write / serve-static / edit-in-Postgres): big layers get a
// compressed Parquet "attribute sidecar" in the tiles bucket (same lifecycle as .pmtiles).
// Opening the table then reads ~1–3 MB of columnar data through DuckDB-WASM instead of
// re-streaming tens of MB of JSON rows from Postgres. Postgres stays the editable truth; the
// sidecar is a derived artifact, re-baked in the background after edits.
//
// The ~34 MB DuckDB engine is VENDORED (platform/vendor/duckdb/, pinned 1.32.0) so it's served
// free from the site's own host, loads lazily (only when a big table is opened — or prefetched
// at idle when the map is known to contain one), runs in a WEB WORKER (never blocks the map/tab),
// and is browser-cached after the first visit.
//
// Tiers, decided by per-layer raw_config stamps (declare-don't-sample):
//   rows ≤ BIG_ROWS ......... no sidecar; the plain stream is already fast.
//   BIG_ROWS < rows ≤ cap ... sidecar; table opens by materializing ALL rows from Parquet
//                             (everything downstream — sort/edit/select — works unchanged).
//   rows > cap .............. sidecar; VIRTUAL mode — rows page in on demand, sorts run as SQL
//                             in the worker; browser memory stays bounded (editing.js side).
(function () {
  "use strict";
  if (window.MSBigTable) return;

  var SUPABASE_URL = "https://eqpxlwbjqiwfjlsuapvu.supabase.co";
  var BUCKET = "tiles";
  var BIG_ROWS = 20000;     // past this, a layer earns a sidecar
  var BAKE_MAX = 300000;    // client-side bake ceiling (beyond this a server-side bake is needed — future GitHub Action, like the remote tippecanoe)
  var CF = "c:";            // custom_fields keys live in the parquet as "c:<key>" (never collides with std columns)

  // vendored engine location, derived from this script's own URL (works from /map/*.html)
  var VENDOR = (function () {
    try { return document.currentScript.src.replace(/bigtable\.js.*$/, "vendor/duckdb/"); }
    catch (e) { return "../platform/vendor/duckdb/"; }
  })();

  var STD = ["feature_id", "label", "description", "start_date", "end_date", "content_id"];
  function sq(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }          // SQL string literal
  function qi(s) { return '"' + String(s).replace(/"/g, '""') + '"'; }          // SQL identifier

  /* ── engine ────────────────────────────────────────────────────────────── */
  var _engine = null;   // Promise<{duckdb, adb, conn}>
  function ensureEngine() {
    if (_engine) return _engine;
    _engine = (async function () {
      var duckdb = await import(VENDOR + "duckdb-browser.mjs?v=1.32.0");
      var worker = new Worker(VENDOR + "duckdb-browser-eh.worker.js?v=1.32.0");
      var adb = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
      await adb.instantiate(VENDOR + "duckdb-eh.wasm?v=1.32.0");
      var conn = await adb.connect();
      return { duckdb: duckdb, adb: adb, conn: conn };
    })();
    _engine.catch(function () { _engine = null; });   // failed load → next call retries
    return _engine;
  }
  var _prefetched = false;
  function prefetch() {   // warm the engine at idle so a big table's first open doesn't pay the load
    if (_prefetched) return; _prefetched = true;
    var go = function () { ensureEngine().catch(function () {}); };
    if (window.requestIdleCallback) requestIdleCallback(go, { timeout: 15000 }); else setTimeout(go, 4000);
  }

  /* ── row shape ↔ parquet shape ─────────────────────────────────────────── */
  // rows are the attr-table's own objects: {feature_id, label, description, start_date,
  // end_date, content_id, custom_fields:{...}} — geometry is NEVER in the sidecar.
  function collectKeys(rows) {
    var keys = [], seen = {};
    for (var i = 0; i < rows.length; i++) {
      var cf = rows[i].custom_fields;
      if (cf && typeof cf === "object") for (var k in cf) if (!seen[k]) { seen[k] = 1; keys.push(k); }
    }
    return keys;
  }
  function keyTypes(rows, keys) {   // full scan (not a sample): DOUBLE only if every non-null value is a finite number
    var t = {};
    keys.forEach(function (k) { t[k] = { num: false, other: false }; });
    for (var i = 0; i < rows.length; i++) {
      var cf = rows[i].custom_fields; if (!cf) continue;
      for (var j = 0; j < keys.length; j++) {
        var v = cf[keys[j]];
        if (v == null || v === "") continue;
        if (typeof v === "number" && isFinite(v)) t[keys[j]].num = true; else t[keys[j]].other = true;
      }
    }
    var out = {};
    keys.forEach(function (k) { out[k] = (t[k].num && !t[k].other) ? "DOUBLE" : "VARCHAR"; });
    return out;
  }
  function toRow(obj) {   // one arrow-result object → one attr-table row
    var r = { custom_fields: {} };
    for (var k in obj) {
      var v = obj[k];
      if (typeof v === "bigint") v = Number(v);
      if (k.indexOf(CF) === 0) { if (v != null) r.custom_fields[k.slice(CF.length)] = v; }
      else r[k] = v == null ? null : v;
    }
    return r;
  }

  /* ── bake: rows → parquet → storage → raw_config stamp ─────────────────── */
  var _baking = {};   // layerId → true while a bake is in flight (dedup)
  async function bakeFromRows(db, projectId, layerId, rows, status) {
    if (_baking[layerId]) return null;
    if (!rows || !rows.length || rows.length > BAKE_MAX) return null;
    _baking[layerId] = true;
    status = status || function () {};
    try {
      var e = await ensureEngine();
      var keys = collectKeys(rows), types = keyTypes(rows, keys);
      status("Baking columnar sidecar (" + rows.length.toLocaleString("en-US") + " rows)…");
      var flat = new Array(rows.length);
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i], o = {};
        STD.forEach(function (f) { var v = r[f]; o[f] = v == null ? null : String(v); });
        var cf = r.custom_fields || {};
        for (var j = 0; j < keys.length; j++) {
          var k = keys[j], v2 = cf[k];
          o[CF + k] = v2 == null ? null : (types[k] === "DOUBLE" ? v2 : String(v2));
        }
        flat[i] = o;
      }
      var cols = STD.map(function (f) { return sq(f) + ": 'VARCHAR'"; })
        .concat(keys.map(function (k) { return sq(CF + k) + ": " + sq(types[k]); })).join(", ");
      var jname = "bake_" + layerId + ".json";
      await e.adb.registerFileText(jname, JSON.stringify(flat));
      flat = null;
      await e.conn.query("CREATE OR REPLACE TABLE bake_t AS SELECT * FROM read_json(" + sq(jname) + ", format='array', columns={" + cols + "})");
      try { await e.conn.query("COPY bake_t TO 'bake_out.parquet' (FORMAT PARQUET, COMPRESSION ZSTD)"); }
      catch (ez) { await e.conn.query("COPY bake_t TO 'bake_out.parquet' (FORMAT PARQUET)"); }   // zstd unavailable → default snappy
      var buf = await e.adb.copyFileToBuffer("bake_out.parquet");
      await e.conn.query("DROP TABLE IF EXISTS bake_t");
      try { await e.adb.dropFile(jname); } catch (e1) {}
      try { await e.adb.dropFile("bake_out.parquet"); } catch (e2) {}
      status("Uploading sidecar (" + (buf.length / 1048576).toFixed(1) + " MB)…");
      var path = projectId + "/" + layerId + ".attr.parquet";
      var blob = new Blob([buf], { type: "application/octet-stream" });
      // NEVER upsert:true (storage upsert 403s under RLS — see tilegen.js): insert, on exists delete+retry
      var up = await db.storage.from(BUCKET).upload(path, blob, { upsert: false });
      if (up.error && /exist|duplicate/i.test(up.error.message || "")) {
        await db.storage.from(BUCKET).remove([path]);
        up = await db.storage.from(BUCKET).upload(path, blob, { upsert: false });
      }
      if (up.error) throw new Error("sidecar upload: " + up.error.message);
      var url = SUPABASE_URL + "/storage/v1/object/public/" + BUCKET + "/" + path;
      var cur = await db.from("layers").select("raw_config").eq("id", layerId).single();
      var rc = (cur.data && cur.data.raw_config) || {};
      rc.attrParquet = url;
      rc.attrParquetRows = rows.length;
      rc.attrParquetAt = new Date().toISOString();
      delete rc.attrParquetDirty;
      await db.from("layers").update({ raw_config: rc }).eq("id", layerId);
      _dirtyDone[layerId] = false;   // re-arm: the NEXT edit after this bake must stamp dirty again
      status("Fast table ready — next open is instant.");
      return { url: url, rows: rows.length, bytes: buf.length };
    } finally { delete _baking[layerId]; }
  }

  // stream a layer's rows (geom-free) out of Postgres, then bake — the backfill/import path
  async function bakeFromDb(db, projectId, layerId, status) {
    var rows = [];
    for (var from = 0; from < BAKE_MAX; from += 1000) {
      var res = await db.from("features").select("feature_id, label, description, start_date, end_date, custom_fields, content_id").eq("layer_id", layerId).order("feature_id").range(from, from + 999);
      if (res.error) throw new Error(res.error.message);
      Array.prototype.push.apply(rows, res.data || []);
      if (!res.data || res.data.length < 1000) break;
    }
    if (rows.length <= BIG_ROWS) return null;   // shrunk below the tier since it was queued
    return bakeFromRows(db, projectId, layerId, rows, status);
  }

  // one cheap raw_config stamp when an edit lands on a sidecar'd layer (so a close-before-rebake
  // still gets caught by the freshness check on the next open)
  var _dirtyDone = {};
  async function noteDirty(db, layerId) {
    if (_dirtyDone[layerId]) return; _dirtyDone[layerId] = true;
    try {
      var cur = await db.from("layers").select("raw_config").eq("id", layerId).single();
      var rc = (cur.data && cur.data.raw_config) || {};
      if (!rc.attrParquet || rc.attrParquetDirty) return;
      rc.attrParquetDirty = true;
      await db.from("layers").update({ raw_config: rc }).eq("id", layerId);
    } catch (e) { _dirtyDone[layerId] = false; }
  }

  /* ── read: sidecar → rows ──────────────────────────────────────────────── */
  async function registerSidecar(layerId, url, ver) {
    var e = await ensureEngine();
    var name = "attr_" + layerId + ".parquet";
    try { await e.adb.dropFile(name); } catch (e1) {}
    // ?v= makes each bake a distinct URL — the browser/CDN can cache hard without ever serving a stale bake
    await e.adb.registerFileURL(name, url + "?v=" + encodeURIComponent(ver || "0"), e.duckdb.DuckDBDataProtocol.HTTP, false);
    return { e: e, name: name };
  }
  function resultRows(res) {
    var out = new Array(res.numRows), i = 0;
    var arr = res.toArray();
    for (var j = 0; j < arr.length; j++) out[i++] = toRow(arr[j].toJSON());
    return out;
  }
  // materialize the WHOLE sidecar (≤ cap rows) as plain attr-table rows
  async function loadAll(layerId, url, ver) {
    var s = await registerSidecar(layerId, url, ver);
    var res = await s.e.conn.query("SELECT * FROM read_parquet(" + sq(s.name) + ")");
    return resultRows(res);
  }
  // VIRTUAL provider (> cap rows): pages + SQL sorts, memory stays bounded
  async function openProvider(layerId, url, ver, count) {
    var s = await registerSidecar(layerId, url, ver);
    var head = await s.e.conn.query("SELECT * FROM read_parquet(" + sq(s.name) + ") LIMIT 0");
    var customKeys = head.schema.fields.map(function (f) { return f.name; })
      .filter(function (n) { return n.indexOf(CF) === 0; })
      .map(function (n) { return n.slice(CF.length); });
    return {
      count: count,
      customKeys: customKeys,
      // order: null (natural = feature_id order) or {col:'label'|{custom:'key'}|{selFids:[...]}, dir:'asc'|'desc'}
      range: async function (start, len, order) {
        var ob = "";
        if (order) {
          var col;
          if (order.selFids) {
            var lits = order.selFids.slice(0, 500).map(sq).join(",") || "''";
            col = "(CASE WHEN feature_id IN (" + lits + ") THEN 0 ELSE 1 END)";
            ob = " ORDER BY " + col + " " + (order.dir === "desc" ? "DESC" : "ASC") + ", feature_id";
          } else {
            col = order.custom ? qi(CF + order.custom) : qi(order.col);
            // blanks always last (matches the in-memory sort), then the value
            ob = " ORDER BY (" + col + " IS NULL OR CAST(" + col + " AS VARCHAR) = '') ASC, " + col + " " + (order.dir === "desc" ? "DESC" : "ASC");
          }
        }
        var res = await s.e.conn.query("SELECT * FROM read_parquet(" + sq(s.name) + ")" + ob + " LIMIT " + (len | 0) + " OFFSET " + (start | 0));
        return resultRows(res);
      }
    };
  }

  window.MSBigTable = {
    BIG_ROWS: BIG_ROWS,
    BAKE_MAX: BAKE_MAX,
    ensureEngine: ensureEngine,
    prefetch: prefetch,
    bakeFromRows: bakeFromRows,
    bakeFromDb: bakeFromDb,
    noteDirty: noteDirty,
    loadAll: loadAll,
    openProvider: openProvider,
    isBaking: function (lid) { return !!_baking[lid]; }
  };
})();
