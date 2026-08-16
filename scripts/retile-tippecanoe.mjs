/* retile-tippecanoe.mjs — the REMOTE tiler + fold engine (GitHub Actions, node 20+).
   The browser tiler (platform/tilegen.js) stays the instant, default path; this pass re-cuts a
   layer with real tippecanoe for big datasets — and, since The Fold (C2, 7/29), can also FOLD a
   layer: bake all four R2 artifacts and stamp the layer as R2-backed.

   MODE (env, default 'retile'):
     retile     today's behavior + the 7/29 fixes: R2 dual-write (delete-first), label columns
                baked into tiles, tilesFeatureCount/tilesMaxFid stamps (Publish no longer silently
                re-bakes in-browser), keyset paging (OFFSET silently truncated 302k rows, NTAD 7/23).
     fold-rows  same sources (Postgres rows) but bakes the FULL fold artifact set and stamps
                fold_state='folded' + parquet_key + r2_bytes. Rows are NOT deleted here —
                soft-first (C6 deletes after a soak).
     fold-raw   no rows exist: reads the FeatureCollection the import client uploaded to R2
                (RAW_KEY), mints feature ids 1..N, applies the import path's exact label/
                custom_fields semantics (editing.js importLabel/importCustomFields), bakes
                everything. Dates are null on import → tiles are dateless (0/99999999), same
                as a live import.
     fold-merge Publish = the fold (C5): reads the CURRENT raw artifact from R2, overlays the
                layer's DELTA rows (features rows carrying custom_fields.ms_foldsrc = the
                artifact feature id they shadow), rebuilds every artifact under the SAME
                feature ids, then DELETES the merged delta rows. Artifact ids stay stable
                across folds so tiles/sidecar/export/click-to-edit keys never drift.

   Artifacts on a fold (keys under the tiles bucket / R2):
     {pid}/{lid}.pmtiles        tiles         — Supabase + R2 (existing readers, dual-read)
     {pid}/{lid}.attr.parquet   attr sidecar  — Supabase + R2 (bigtable.js schema, EXACT mirror)
     tiles/{pid}/{lid}.parquet  GeoParquet    — R2 only (source of truth for future folds/merges)
     tiles/{pid}/{lid}.geojson  export FC     — R2 only (exportLayer's exact FeatureCollection —
                                                folded exports read this file verbatim)

   Env: SUPABASE_SERVICE_KEY, PROJECT_ID, LAYER_ID, MODE, RAW_KEY (fold-raw), MAX_ZOOM ('' = -zg),
        R2_ACCOUNT_ID + R2_ACCESS_KEY_ID + R2_SECRET_ACCESS_KEY (aws CLI, endpoint *.r2.cloudflarestorage.com).
   Needs `tippecanoe` on PATH; fold modes also need `python3 -c "import duckdb"` (workflow installs it).

   Tiles stay SKINNY (7/16 contract): id + DayStart/DayEnd + label (+ the raw_config.labels.field
   column) — full attributes live in the sidecar / parquet / export FC. */

import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, statSync } from "node:fs";
import { bakeScrubRaster } from "./bake-scrub-raster.mjs";

const SUPABASE_URL = process.env.SUPABASE_URL || "https://eqpxlwbjqiwfjlsuapvu.supabase.co";
const KEY = process.env.SUPABASE_SERVICE_KEY;
const PROJECT_ID = process.env.PROJECT_ID;
const LAYER_ID = process.env.LAYER_ID;
const MODE = (process.env.MODE || "retile").trim();
const RAW_KEY = (process.env.RAW_KEY || "").trim();
const MAX_ZOOM = (process.env.MAX_ZOOM || "").trim();
// Tile-level simplification (8/15). Raising the multiplier thins the low zooms, which is exactly
// where a timeline scrub re-tessellates the whole country. tippecanoe simplifies the MAX zoom too
// unless told not to — measured on AtlasHCB: --simplification=6 alone left z12 carrying 73% of the
// source vertices, so every bake that thins also passes --simplify-only-low-zooms to pin the top
// zoom back to full detail. It touches the TILES ONLY — the stored geometry, the downloads and the
// dataset keep every vertex. Empty = tippecanoe's default.
const SIMPLIFY = (process.env.SIMPLIFY || "").trim();
const LAYER_NAME = "features";   // every archive uses this source-layer name
const BUCKET = "tiles";          // Supabase Storage bucket
const R2_BUCKET = process.env.R2_BUCKET || "mapstructor-tiles";
const R2_ENDPOINT = process.env.R2_ACCOUNT_ID ? `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : null;
const R2_PUBLIC = "https://tiles.mapstructor.com";   // bucket custom domain (public reads)
const FOLD = MODE === "fold-rows" || MODE === "fold-raw" || MODE === "fold-merge";

if (!KEY || !PROJECT_ID || !LAYER_ID) { console.error("need SUPABASE_SERVICE_KEY, PROJECT_ID, LAYER_ID"); process.exit(1); }
if (!["retile", "fold-rows", "fold-raw", "fold-merge"].includes(MODE)) { console.error("bad MODE " + MODE); process.exit(1); }
if (MODE === "fold-raw" && !RAW_KEY) { console.error("fold-raw needs RAW_KEY"); process.exit(1); }
if (FOLD && !R2_ENDPOINT) { console.error("fold modes need R2_ACCOUNT_ID (+ key pair)"); process.exit(1); }

const H = { apikey: KEY, Authorization: "Bearer " + KEY };
const nfmt = (n) => Number(n).toLocaleString("en-US");

async function rest(path, opts = {}) {
  // retry 5xx/timeouts: a concurrent heavy statement (quota recompute, bulk cleanup) can starve
  // service-role reads into 57014 for a few seconds — one such blip killed a whole merge run (7/30)
  //
  // 8/16: four tries at a flat 8s = a 24-second budget, and that is far too short for what actually
  // happens. Cloudflare 520-527 mean the ORIGIN is down or unreachable, not busy, and tonight that
  // state lasted MINUTES — run #64 burned all four tries against a 521 and failed a bake that was
  // otherwise fine. A network blip should never cost a ten-minute bake, so back off exponentially
  // to roughly five minutes. Fetch itself can also reject (socket reset mid-outage); that is the
  // same event and gets the same treatment rather than an unhandled throw.
  const WAITS = [5000, 10000, 20000, 40000, 60000, 60000, 60000, 60000];
  for (let a = 0; ; a++) {
    let r = null, netErr = null;
    try { r = await fetch(SUPABASE_URL + path, { ...opts, headers: { ...H, ...(opts.headers || {}) } }); }
    catch (e) { netErr = e; }
    if (r && r.ok) return r;
    const body = r ? (await r.text()).slice(0, 300) : String((netErr && netErr.message) || netErr);
    const retryable = !r || r.status >= 500;
    if (!retryable || a >= WAITS.length) throw new Error(path.split("?")[0] + " -> " + (r ? r.status : "network") + " " + body);
    console.warn(`rest ${r ? r.status : "network"} (try ${a + 1}/${WAITS.length}, waiting ${WAITS[a] / 1000}s): ${body.slice(0, 100)}`);
    await new Promise((rs) => setTimeout(rs, WAITS[a]));
  }
}
function day(d, fallback) { return d ? +String(d).slice(0, 10).replace(/-/g, "") || fallback : fallback; }

/* ── R2 via the aws CLI (preinstalled on ubuntu-latest; same pattern as the AHM
      regenerate-tiles workflow). Delete-first invariant: R2 holds the CURRENT artifact or
      NOTHING — a stale R2 copy would shadow fresh Supabase (pmt-sw reads R2 first and
      success never fails over). The *_CHECKSUM_* env vars stop aws v2's newer default
      CRC32 headers from tripping R2's S3 shim. ── */
const AWS_ENV = {
  ...process.env,
  AWS_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID || "",
  AWS_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY || "",
  AWS_DEFAULT_REGION: "auto",
  AWS_REQUEST_CHECKSUM_CALCULATION: "when_required",
  AWS_RESPONSE_CHECKSUM_VALIDATION: "when_required",
};
function r2(args) { execFileSync("aws", ["--endpoint-url", R2_ENDPOINT, "s3api", ...args], { env: AWS_ENV, stdio: ["ignore", "inherit", "inherit"] }); }
function r2del(key, must) {
  try { r2(["delete-object", "--bucket", R2_BUCKET, "--key", key]); }
  catch (e) { if (must) throw new Error("R2 delete " + key + " failed — aborting before Supabase is overwritten (stale-shadow invariant)"); console.warn("R2 delete " + key + " failed (best-effort)"); }
}
function r2put(key, file, contentType, must) {
  try { r2(["put-object", "--bucket", R2_BUCKET, "--key", key, "--body", file, "--content-type", contentType]); }
  catch (e) { if (must) throw new Error("R2 put " + key + " failed"); console.warn("R2 put " + key + " failed — readers fall back to Supabase for this artifact"); }
}

/* Supabase Storage upload: plain POST; on exists DELETE + retry — never x-upsert (7/15 trap). */
async function supaUpload(path, bytes, contentType) {
  const objPath = `/storage/v1/object/${BUCKET}/${path}`;
  const put = () => fetch(SUPABASE_URL + objPath, { method: "POST", headers: { ...H, "Content-Type": contentType }, body: bytes });
  let up = await put();
  if (!up.ok && /exist|duplicate/i.test(await up.clone().text())) { await rest(objPath, { method: "DELETE" }); up = await put(); }
  if (!up.ok) throw new Error("upload " + path + " failed: " + up.status + " " + (await up.text()).slice(0, 300));
}

/* ── import-path mirrors (editing.js) — fold-raw must shape data EXACTLY like a live import ── */
const LABEL_KEYS = ["name", "Name", "NAME", "label", "Label", "LABEL", "title", "Title", "TITLE"];
function importLabelKey(props) {
  if (!props) return null;
  for (const k of LABEL_KEYS) if (props[k] != null && props[k] !== "") return k;
  return null;
}
function importLabel(props) { const k = importLabelKey(props); return k ? String(props[k]).slice(0, 250) : null; }
function importCustomFields(props) {
  if (!props || typeof props !== "object") return null;
  const labelKey = importLabelKey(props), out = {}; let n = 0;
  for (const k of Object.keys(props)) {
    if (k === labelKey) continue;
    let v = props[k];
    if (v == null || v === "") continue;
    if (typeof v === "object") { try { v = JSON.stringify(v); } catch (e) { continue; } }
    out[k] = v; n++;
  }
  return n ? out : null;
}

/* ── export-FC mirror (editing.js exportLayer) — folded exports serve this file verbatim,
      so its shape must match what the same layer would export live. ── */
function orderAttrKeys(keys) {   // msid FIRST, ms_* style columns LAST (editing.js:6865)
  const style = ["ms_color", "ms_linecolor", "ms_opacity", "ms_thickness", "ms_labelsize"].filter((k) => keys.includes(k));
  const msid = keys.includes("msid") ? ["msid"] : [];
  const mid = keys.filter((k) => k !== "msid" && !style.includes(k));
  return msid.concat(mid).concat(style);
}
const exportRenames = {};   // source column -> artifact column, when a name collides case-insensitively
function buildExportFC(rows, attrView) {
  const custKeys = [];
  for (const r of rows) if (r.custom_fields) for (const k of Object.keys(r.custom_fields)) if (!custKeys.includes(k)) custKeys.push(k);
  const ordKeys = (attrView && attrView.order && attrView.order.length)
    ? attrView.order
    : ["label", "start_date", "end_date", "description", "content_id"].concat(orderAttrKeys(custKeys));
  const feats = rows.filter((r) => r.geom).map((r) => {
    const raw = { feature_id: r.feature_id };
    if (r.label) raw.label = r.label;
    if (r.description) raw.description = r.description;
    if (r.start_date) raw.start_date = r.start_date;
    if (r.end_date) raw.end_date = r.end_date;
    if (r.content_id != null) raw.content_id = r.content_id;
    if (r.image_url) raw.image_url = r.image_url;
    // CASE-INSENSITIVE uniqueness (8/15). GDAL/DuckDB fold column names case-insensitively, so a
    // source column literally named END_DATE sitting beside the platform's own end_date is a
    // DUPLICATE to them, and the GeoParquet step dies: 'Binder Error: table "st_read" has
    // duplicate column name "END_DATE"'. It only appears AFTER dates are applied from those very
    // columns, so a layer folds fine at import and fails on its first re-bake (owner's AtlasHCB,
    // whose shapefile names its columns START_DATE/END_DATE — the normal case, not an exotic one).
    // The platform keys keep their names (merges and tables read them); a colliding SOURCE key is
    // carried under a suffix so nothing is dropped. The database and the attribute sidecar keep
    // the original name either way — this rename exists only inside the fold artifacts.
    if (r.custom_fields && typeof r.custom_fields === "object") {
      const lower = new Set(Object.keys(raw).map((k) => k.toLowerCase()));
      for (const k of Object.keys(r.custom_fields)) {
        let key = k;
        if (lower.has(k.toLowerCase())) {
          let n = 1;
          while (lower.has((k + "_src" + (n > 1 ? n : "")).toLowerCase())) n++;
          key = k + "_src" + (n > 1 ? n : "");
          if (!exportRenames[k]) exportRenames[k] = key;
        }
        if (!(key in raw)) { raw[key] = r.custom_fields[k]; lower.add(key.toLowerCase()); }
      }
    }
    const props = { feature_id: raw.feature_id };
    for (const k of ordKeys) if (k in raw && !(k in props)) props[k] = raw[k];
    for (const k of Object.keys(raw)) if (!(k in props)) props[k] = raw[k];
    return { type: "Feature", id: r.feature_id, geometry: r.geom, properties: props };
  });
  const rn = Object.keys(exportRenames);
  if (rn.length) console.log("export: renamed " + rn.length + " colliding source column(s) — " + rn.map((k) => k + " -> " + exportRenames[k]).join(", "));
  return { type: "FeatureCollection", features: feats };
}

/* ── on failure: leave a readable trace on the layer so the importing client can react ── */
async function stampFailure(msg) {
  try {
    const cur = await (await rest(`/rest/v1/layers?id=eq.${LAYER_ID}&select=raw_config`)).json();
    const rc = (cur[0] && cur[0].raw_config) || {};
    rc.foldError = String(msg).slice(0, 300);
    const patch = { raw_config: rc };
    if (MODE === "fold-rows") patch.fold_state = "live";   // rows still exist — revert cleanly
    await rest(`/rest/v1/layers?id=eq.${LAYER_ID}`, { method: "PATCH", headers: { "Content-Type": "application/json", Prefer: "return=minimal" }, body: JSON.stringify(patch) });
  } catch (e) { console.error("could not stamp foldError:", e.message); }
}

try {
  /* ── 0. the layer row (config drives labels + export column order) ─────────── */
  const layerRow = (await (await rest(`/rest/v1/layers?id=eq.${LAYER_ID}&select=*`)).json())[0];
  if (!layerRow) throw new Error("layer not found");
  const rc0 = layerRow.raw_config || {};
  let lblField = (rc0.labels && rc0.labels.field) || null;
  if (lblField === "label") lblField = null;
  // The COLOUR-BY column has to ride into the tiles too — the paint match reads it from tile
  // properties exactly like the label column does. The browser tiler has always carried it
  // (tilegen.js sewUpLayer, `cbField`); this one never did, so any layer baked in the cloud
  // came back with its colour column missing and categorical styling with nothing to match on
  // (8/16, found while unblocking the owner's re-bake after they coloured this layer).
  let cbField = (rc0.colorBy && rc0.colorBy.prop) || null;
  if (cbField === "label" || cbField === lblField) cbField = null;

  /* ── 1. acquire rows (full attributes — artifacts need them; retile ignores extras) ── */
  let rows = [];
  let sourceBytes = 0;   // fold-raw: the uploaded source FC stays on R2 and counts toward r2_bytes
  let mergedDeltaIds = [];   // fold-merge: delta rows to DELETE after a successful stamp
  if (MODE === "fold-merge") {
    // C7 pointer copies: parquet_key names WHERE the current artifacts live — for a copy that
    // has never folded, that is the SOURCE layer's key space. Outputs always land under THIS
    // layer's own keys + the success stamp re-points parquet_key here (copy-on-write moment).
    const pk = layerRow.parquet_key;
    const exKey = (pk && pk.endsWith(".parquet"))
      ? pk.slice(0, -".parquet".length) + ".geojson"
      : `tiles/${PROJECT_ID}/${LAYER_ID}.geojson`;
    console.log("Fetching current artifact from R2: " + exKey);
    let afc = null;
    for (let a = 1; a <= 3 && !afc; a++) {
      const r = await fetch(`${R2_PUBLIC}/${exKey}`, { cache: "no-store" });
      if (r.ok) afc = await r.json();
      else { console.warn("artifact fetch " + r.status + " (try " + a + ")"); await new Promise((rs) => setTimeout(rs, 3000)); }
    }
    if (!afc || !afc.features || !afc.features.length) throw new Error("current artifact unavailable at " + exKey);
    // artifact features → row shape (props back to columns; ARTIFACT ids preserved — id stability
    // across folds is the contract that keeps tiles/sidecar/export/click-to-edit keys aligned)
    const STDK = { feature_id: 1, label: 1, description: 1, start_date: 1, end_date: 1, content_id: 1, image_url: 1 };
    const byId = new Map();
    rows = afc.features.map((f) => {
      const p = f.properties || {}, cf = {};
      for (const k of Object.keys(p)) if (!STDK[k]) cf[k] = p[k];
      const row = {
        feature_id: f.id != null ? f.id : p.feature_id, geom: f.geometry,
        label: p.label != null ? p.label : null, description: p.description != null ? p.description : null,
        start_date: p.start_date || null, end_date: p.end_date || null,
        content_id: p.content_id != null ? p.content_id : null, image_url: p.image_url || null,
        custom_fields: Object.keys(cf).length ? cf : null,
      };
      byId.set(String(row.feature_id), row);
      return row;
    });
    // delta rows (keyset) — only rows MARKED ms_foldsrc merge; anything else is left untouched
    let lastD = null; const deltas = [];
    for (;;) {
      const gt = lastD != null ? `&feature_id=gt.${lastD}` : "";
      const batch = await (await rest(`/rest/v1/features?layer_id=eq.${LAYER_ID}${gt}&select=feature_id,geom,label,description,start_date,end_date,content_id,image_url,custom_fields&order=feature_id&limit=1000`)).json();
      if (!batch.length) break;
      deltas.push(...batch); lastD = batch[batch.length - 1].feature_id;
      if (batch.length < 1000) break;
    }
    let applied = 0, orphans = 0;
    for (const d of deltas) {
      const src = d.custom_fields && d.custom_fields.ms_foldsrc;
      if (src == null) { orphans++; continue; }
      const t = byId.get(String(src));
      const cf2 = { ...(d.custom_fields || {}) }; delete cf2.ms_foldsrc;
      const merged = {
        feature_id: t ? t.feature_id : Number(src), geom: d.geom, label: d.label, description: d.description,
        start_date: d.start_date, end_date: d.end_date, content_id: d.content_id, image_url: d.image_url,
        custom_fields: Object.keys(cf2).length ? cf2 : null,
      };
      if (t) rows[rows.indexOf(t)] = merged; else rows.push(merged);   // vanished target → the edit survives as its own feature
      byId.set(String(merged.feature_id), merged);
      mergedDeltaIds.push(d.feature_id);
      applied++;
    }
    console.log(`merge: ${rows.length} artifact features · ${applied} deltas applied · ${orphans} unmarked rows untouched`);
    try {   // the fold-raw source file (if any) still occupies R2 — keep counting it in r2_bytes
      // s3api, not a public HEAD: the bucket custom domain refuses HEAD, which silently
      // under-billed merged layers by the source-file size (caught by the v5 trigger, 7/30)
      const out = execFileSync("aws", ["--endpoint-url", R2_ENDPOINT, "s3api", "head-object", "--bucket", R2_BUCKET, "--key", `tiles/${PROJECT_ID}/${LAYER_ID}.source.geojson`], { env: AWS_ENV, encoding: "utf8" });
      sourceBytes = JSON.parse(out).ContentLength || 0;
    } catch (e) {}
  } else if (MODE === "fold-raw") {
    console.log("Fetching source FC from R2: " + RAW_KEY);
    let fr = null;
    for (let a = 1; a <= 3 && !fr; a++) {
      const r = await fetch(`${R2_PUBLIC}/${RAW_KEY}`, { cache: "no-store" });
      if (r.ok) fr = await r.json();
      else { console.warn("source fetch " + r.status + " (try " + a + ")"); await new Promise((rs) => setTimeout(rs, 3000)); }
    }
    if (!fr || !fr.features || !fr.features.length) throw new Error("source FC unavailable or empty at " + RAW_KEY);
    sourceBytes = JSON.stringify(fr).length;
    rows = fr.features.map((f, i) => ({
      feature_id: i + 1,                                  // minted — tiles/sidecar/export all agree on it
      geom: f.geometry,
      label: importLabel(f.properties),
      description: null, start_date: null, end_date: null, content_id: null, image_url: null,
      custom_fields: importCustomFields(f.properties),
    }));
  } else {
    console.log("Fetching features for layer " + LAYER_ID + " (keyset, adaptive)…");
    // ADAPTIVE PAGES (8/15). A fixed 1000-row page assumes rows are small. The owner's AtlasHCB
    // layer is 220 rows carrying 9.3M vertices — ~1.7 MB of JSON PER ROW — so the very first page
    // asked Postgres for the entire 370 MB layer in one statement and died on the timeout:
    // "row fetch failed at 0 … canceling statement due to statement timeout", after a 25-minute
    // import that had otherwise succeeded. Shrink the bite and retry the SAME cursor (the browser's
    // MSFetchRows has done this since 8/13); a single row is always small enough to move.
    // A layer the importer flagged as heavy-geometry starts SMALL rather than discovering the
    // ceiling through three failed attempts (each of which costs 10-40s of the bake's clock).
    let lastFid = null, size = rc0.heavyGeom ? 25 : 1000, shrinks = 0;
    const tFetch = Date.now();
    for (;;) {
      const gt = lastFid != null ? `&feature_id=gt.${lastFid}` : "";
      const tPage = Date.now();
      let batch;
      try {
        batch = await (await rest(`/rest/v1/features?layer_id=eq.${LAYER_ID}${gt}&select=feature_id,geom,label,description,start_date,end_date,content_id,image_url,custom_fields&order=feature_id&limit=${size}`)).json();
      } catch (e) {
        if (size > 1) {
          size = Math.max(1, Math.floor(size / 4)); shrinks++;
          console.warn(`  page failed at ${nfmt(rows.length)} rows — retrying the same cursor at ${size} row(s)/page · ${String(e.message).slice(0, 90)}`);
          await new Promise((rs) => setTimeout(rs, 2000));
          continue;
        }
        throw new Error("row fetch failed at " + rows.length + " even at 1 row per page: " + e.message);   // ABORT LOUDLY — a partial archive must never look like a bake
      }
      if (!batch.length) break;
      rows.push(...batch);
      lastFid = batch[batch.length - 1].feature_id;
      // per-page timings, so a slow bake can be READ rather than guessed at (owner 8/15)
      console.log(`  +${batch.length} rows @${size}/page in ${((Date.now() - tPage) / 1000).toFixed(1)}s · ${nfmt(rows.length)} total · ${((Date.now() - tFetch) / 1000).toFixed(0)}s elapsed`);
      if (batch.length < size) break;
    }
    console.log(`rows fetched in ${((Date.now() - tFetch) / 1000).toFixed(0)}s${shrinks ? ` (page size shrank ${shrinks}× to ${size})` : ""}`);
  }
  if (!rows.length) throw new Error("layer has no features");
  console.log(nfmt(rows.length) + " features (" + MODE + ")");
  const tPhase = Date.now();
  const phase = (name) => { console.log(`⏱  ${name} at ${((Date.now() - tPhase) / 1000).toFixed(0)}s`); };

  /* ── 2. skinny tile FC (sewUpLayer's exact contract) → tippecanoe → PMTiles ── */
  const skinny = rows.map((r) => {
    const props = { DayStart: day(r.start_date, 0), DayEnd: day(r.end_date, 99999999) };
    if (r.label != null && r.label !== "") props.label = r.label;
    if (lblField && r.custom_fields && r.custom_fields[lblField] != null && r.custom_fields[lblField] !== "") props[lblField] = String(r.custom_fields[lblField]);
    if (cbField && r.custom_fields && r.custom_fields[cbField] != null && r.custom_fields[cbField] !== "") props[cbField] = String(r.custom_fields[cbField]);
    return { type: "Feature", id: r.feature_id, properties: props, geometry: r.geom };
  });
  writeFileSync("layer.geojson", JSON.stringify({ type: "FeatureCollection", features: skinny }));
  // fold modes match the browser tiler's depth (points 13, else 15 — tilegen.js convertLayer):
  // -zg guessed z8 for a sparse metro layer and every deeper view rode ~75m-quantized geometry.
  // retile keeps -zg (its existing deep-retile behavior for huge datasets); MAX_ZOOM overrides both.
  // ZOOM DEPTH IS THE BAKE'S REAL COST (8/15). Every extra level roughly doubles the work, and
  // --extend-zooms-if-still-dropping keeps ADDING levels while anything is still being dropped —
  // which on survey-resolution polygons never settles. The owner's AtlasHCB bake fetched its rows
  // in 106s and then spent 27 minutes inside tippecanoe at z15 before the job cap killed it.
  // State and county outlines carry no detail worth a z15 tile, so heavy geometry bakes shallower
  // (an explicit MAX_ZOOM from the caller still wins, and nothing else changes).
  const heavyBake = !!(rc0.heavyGeom || (rc0.heavyVertices || 0) > 2000000);
  const zoomArgs = MAX_ZOOM ? ["-z" + MAX_ZOOM]
    : FOLD ? ["-z" + (layerRow.type === "circle" ? 13 : heavyBake ? 12 : 15)]
    : ["-zg"];
  // heavy layers default to 6 (measured: 670ms per date step at tippecanoe's default) — an explicit
  // SIMPLIFY always wins, including "1" to ask for tippecanoe's untouched default.
  const simplifyArg = SIMPLIFY || (heavyBake ? "6" : "");
  if (simplifyArg) console.log("tile simplification: --simplification=" + simplifyArg + " on low zooms only — max zoom keeps full detail (tiles only; stored geometry untouched)");
  if (heavyBake) console.log(`heavy geometry (${nfmt(rc0.heavyVertices || 0)} vertices) — baking to z${MAX_ZOOM || 12} without zoom extension`);
  const args = ["-o", "layer.pmtiles", "--force", "-l", LAYER_NAME, ...zoomArgs,
    "--drop-densest-as-needed", ...(heavyBake ? [] : ["--extend-zooms-if-still-dropping"]),
    ...(simplifyArg ? ["--simplification=" + simplifyArg, "--simplify-only-low-zooms"] : []),
    "--read-parallel", "layer.geojson"];
  console.log("tippecanoe " + args.join(" "));
  execFileSync("tippecanoe", args, { stdio: "inherit" });
  const pmBytes = readFileSync("layer.pmtiles");
  const achievedMaxZoom = pmBytes[101];   // PMTiles v3 header: max_zoom byte
  console.log("archive " + (pmBytes.length / 1048576).toFixed(1) + " MB, maxzoom z" + achievedMaxZoom);

  /* ── 3. fold artifacts: export FC + the two parquets (python duckdb) ───────── */
  let exportBytes = null, attrBytes = 0, geoBytes = 0;
  if (FOLD) {
    const exportFC = buildExportFC(rows, rc0.attrView);
    exportBytes = Buffer.from(JSON.stringify(exportFC));
    writeFileSync("layer_export.geojson", exportBytes);
    writeFileSync("rows_attr.json", JSON.stringify(rows.map((r) => ({
      feature_id: r.feature_id, label: r.label, description: r.description,
      start_date: r.start_date, end_date: r.end_date, content_id: r.content_id,
      custom_fields: r.custom_fields,
    }))));
    console.log("Baking parquet artifacts (duckdb)…");
    execFileSync("python3", ["scripts/fold-parquet.py", "rows_attr.json", "layer_export.geojson", "layer.attr.parquet", "layer.geo.parquet"], { stdio: "inherit" });
    attrBytes = statSync("layer.attr.parquet").size;
    geoBytes = statSync("layer.geo.parquet").size;
  }

  /* ── 4. uploads — per artifact: R2 DELETE (hard) → Supabase (where dual-read) → R2 PUT ── */
  const pmKey = `tiles/${PROJECT_ID}/${LAYER_ID}.pmtiles`;
  const attrKey = `tiles/${PROJECT_ID}/${LAYER_ID}.attr.parquet`;
  const geoKey = `tiles/${PROJECT_ID}/${LAYER_ID}.parquet`;
  const exportKey = `tiles/${PROJECT_ID}/${LAYER_ID}.geojson`;
  const r2ok = !!(R2_ENDPOINT && process.env.R2_ACCESS_KEY_ID);

  // Big folds can exceed the Supabase bucket's per-object cap (413 killed the 78k-row C6
  // folds, 7/30). R2 is the authoritative store — on 413 the dual goes R2-ONLY: DELETE the
  // stale Supabase copy so the fallback path 404s instead of quietly serving pre-fold tiles.
  async function supaDual(pathTail, bytes, contentType) {
    try { await supaUpload(pathTail, bytes, contentType); }
    catch (e) {
      if (!(FOLD && /413|too large/i.test(String(e.message || e)))) throw e;
      console.warn("Supabase dual refused " + pathTail + " (bucket size cap) — R2-only; clearing the stale dual");
      await rest(`/storage/v1/object/${BUCKET}/${pathTail}`, { method: "DELETE" }).catch(() => {});
    }
  }
  if (r2ok) r2del(pmKey, true); else if (FOLD) throw new Error("fold needs R2 credentials");
  await supaDual(`${PROJECT_ID}/${LAYER_ID}.pmtiles`, pmBytes, "application/octet-stream");
  if (r2ok) r2put(pmKey, "layer.pmtiles", "application/octet-stream", FOLD);
  console.log("tiles uploaded (" + (r2ok ? "Supabase + R2" : "Supabase only — no R2 creds") + ")");

  if (FOLD) {
    r2del(attrKey, true);
    await supaDual(`${PROJECT_ID}/${LAYER_ID}.attr.parquet`, readFileSync("layer.attr.parquet"), "application/octet-stream");
    r2put(attrKey, "layer.attr.parquet", "application/octet-stream", true);
    r2del(geoKey, true);   r2put(geoKey, "layer.geo.parquet", "application/octet-stream", true);
    r2del(exportKey, true); r2put(exportKey, "layer_export.geojson", "application/geo+json", true);
    console.log("fold artifacts on R2: attr " + nfmt(attrBytes) + " B · parquet " + nfmt(geoBytes) + " B · geojson " + nfmt(exportBytes.length) + " B");
  }

  /* ── 5. stamp the layer (same stamps as the browser tiler, + fold columns) ─── */
  const cur = await (await rest(`/rest/v1/layers?id=eq.${LAYER_ID}&select=raw_config,source_type`)).json();
  const rc = (cur[0] && cur[0].raw_config) || {};
  rc.pmtiles = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${PROJECT_ID}/${LAYER_ID}.pmtiles`;
  rc.convertedFrom = rc.convertedFrom || (cur[0] && cur[0].source_type) || "geojson-supabase";
  rc.tilesGeneratedAt = new Date().toISOString();
  rc.tilesBytes = pmBytes.length;
  rc.tilesFeatureCount = rows.length;                                        // dirty-tracking stamps (7/21):
  rc.tilesMaxFid = rows.reduce((m, r) => (Number(r.feature_id) > m ? Number(r.feature_id) : m), 0) || null;   // without these Publish silently re-baked in-browser
  rc.tiler = "tippecanoe";

  /* ── 4b. INSTANT-SCRUB RASTER (8/16) ────────────────────────────────────────
     Without this the timeline drag falls back to a per-feature opacity expression re-evaluated
     on every tick — the lag the owner hit on AtlasHCB. The raster is baked by driving the REAL
     platform/tilegen.js headlessly (scripts/bake-scrub-raster.mjs) so the indexed format keeps
     ONE definition shared with its only reader, platform/rasterScrub.js.
     A failure here never fails the bake: no raster means the layer animates as a vector, which
     is correct — and a WRONG raster is far worse than none (the loader never second-guesses one
     that exists). SCRUB_RASTER=0 opts out. */
  if ((process.env.SCRUB_RASTER || "1") !== "0") {
    try {
      const baked = await bakeScrubRaster({
        projectId: PROJECT_ID, layerId: LAYER_ID, geojsonPath: "layer.geojson",
        geomKind: layerRow.type, tilegenPath: "platform/tilegen.js",
      });
      if (baked && baked.pngs.length) {
        for (const png of baked.pngs) {
          const key = `tiles/${png.storagePath}`;
          if (r2ok) r2del(key, false);                                    // delete-first: no stale shadow
          await supaDual(png.storagePath, readFileSync(png.file), "image/png");
          if (r2ok) r2put(key, png.file, "image/png", false);
        }
        rc.rasterYears = baked.cfg;
        console.log("instant-scrub raster stamped — " + nfmt(baked.cfg.bytes || 0) + " B across " + baked.pngs.length + " images");
      } else if (!baked) {
        delete rc.rasterYears;   // unfit (points, or a span wider than the 255-year window) — clear any stale stamp
      }
    } catch (eRas) {
      console.warn("scrub raster skipped: " + ((eRas && eRas.message) || eRas));
    }
  }
  const patch = { source_type: "vector-tiles-url", source_url: `pmt/${PROJECT_ID}/${LAYER_ID}/{z}/{x}/{y}.pbf`, source_layer: LAYER_NAME, source_maxzoom: achievedMaxZoom, raw_config: rc };
  if (FOLD) {
    rc.attrParquet = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${PROJECT_ID}/${LAYER_ID}.attr.parquet`;
    rc.attrParquetRows = rows.length;
    rc.attrParquetAt = new Date().toISOString();
    delete rc.attrParquetDirty;
    delete rc.foldError;
    patch.fold_state = "folded";
    patch.parquet_key = geoKey;
    patch.r2_bytes = pmBytes.length + attrBytes + geoBytes + exportBytes.length + sourceBytes;
  }
  await rest(`/rest/v1/layers?id=eq.${LAYER_ID}`, { method: "PATCH", headers: { "Content-Type": "application/json", Prefer: "return=minimal" }, body: JSON.stringify(patch) });

  /* ── 5b. fold-merge: clear the merged deltas (ONLY after the stamp landed — a failed run
        leaves them in place and the next merge re-applies identically, so this is idempotent) ── */
  if (MODE === "fold-merge" && mergedDeltaIds.length) {
    for (let i = 0; i < mergedDeltaIds.length; i += 100) {
      const chunk = mergedDeltaIds.slice(i, i + 100);
      await rest(`/rest/v1/features?feature_id=in.(${chunk.join(",")})`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
    }
    console.log("cleared " + mergedDeltaIds.length + " merged delta rows");
  }

  /* ── 6. instrumentation — folded imports insert no rows, so the stats triggers never see
        them; keep item-3's numbers honest via the definer RPCs (fold-raw = new data only). ── */
  if (MODE === "fold-raw") {
    try {
      const bump = (fn, body) => rest(`/rest/v1/rpc/${fn}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      await bump("ms_stat_bump", { p_metric: "features_inserted", p_delta: rows.length });
      await bump("ms_stat_bump", { p_metric: "bytes_added", p_delta: sourceBytes });
      await bump("ms_stat_max", { p_metric: "max_statement_rows", p_value: rows.length });
      const pr = await (await rest(`/rest/v1/projects?id=eq.${PROJECT_ID}&select=user_id`)).json();
      if (pr[0] && pr[0].user_id) await rest(`/rest/v1/ms_editor_days?on_conflict=day,user_id`, {
        method: "POST", headers: { "Content-Type": "application/json", Prefer: "resolution=ignore-duplicates,return=minimal" },
        body: JSON.stringify([{ day: new Date().toISOString().slice(0, 10), user_id: pr[0].user_id }]),
      });
    } catch (e) { console.warn("stats bump failed (non-fatal):", e.message); }
  }

  console.log(FOLD
    ? `layer FOLDED — ${nfmt(rows.length)} features, r2_bytes ${nfmt(pmBytes.length + attrBytes + geoBytes + (exportBytes ? exportBytes.length : 0) + sourceBytes)}.`
    : "layer re-pointed — done. Viewers pick up the new archive within a minute (service-worker ETag revalidation).");
} catch (e) {
  console.error("FAILED: " + (e && e.message ? e.message : e));
  await stampFailure(e && e.message ? e.message : String(e));
  process.exit(1);
}
