/* retile-tippecanoe.mjs — the REMOTE "deep re-tile" tier (runs in GitHub Actions, node 20+).
   The browser tiler (platform/tilegen.js) stays the instant, default path; this pass re-cuts a
   layer with real tippecanoe (feature dropping/coalescing per zoom) for big datasets, then
   uploads the archive to the same Supabase Storage slot the service worker already serves.

   Env: SUPABASE_SERVICE_KEY (repo secret), PROJECT_ID, LAYER_ID, optional MAX_ZOOM ('' = -zg).
   Needs `tippecanoe` on PATH (the workflow builds felt/tippecanoe).

   Tiles are SKINNY by design (same contract as the browser tiler, 7/16): feature id +
   DayStart/DayEnd only — attributes stay in the DB and are fetched by id on click. */

import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, statSync } from "node:fs";

const SUPABASE_URL = process.env.SUPABASE_URL || "https://eqpxlwbjqiwfjlsuapvu.supabase.co";
const KEY = process.env.SUPABASE_SERVICE_KEY;
const PROJECT_ID = process.env.PROJECT_ID;
const LAYER_ID = process.env.LAYER_ID;
const MAX_ZOOM = (process.env.MAX_ZOOM || "").trim();
const LAYER_NAME = "features";   // every archive uses this source-layer name
const BUCKET = "tiles";

if (!KEY || !PROJECT_ID || !LAYER_ID) {
  console.error("need SUPABASE_SERVICE_KEY, PROJECT_ID, LAYER_ID");
  process.exit(1);
}

const H = { apikey: KEY, Authorization: "Bearer " + KEY };
const nfmt = (n) => Number(n).toLocaleString("en-US");

async function rest(path, opts = {}) {
  const r = await fetch(SUPABASE_URL + path, { ...opts, headers: { ...H, ...(opts.headers || {}) } });
  if (!r.ok) throw new Error(path + " -> " + r.status + " " + (await r.text()).slice(0, 300));
  return r;
}

function day(d, fallback) {
  return d ? +String(d).slice(0, 10).replace(/-/g, "") || fallback : fallback;
}

// ── 1. pull the layer's features (paged) ─────────────────────────────────────
console.log("Fetching features for layer " + LAYER_ID + "…");
const feats = [];
for (let from = 0; ; from += 1000) {
  const r = await rest(
    `/rest/v1/features?layer_id=eq.${LAYER_ID}&select=feature_id,geom,start_date,end_date&order=feature_id&limit=1000&offset=${from}`
  );
  const rows = await r.json();
  for (const f of rows) {
    feats.push({
      type: "Feature",
      id: f.feature_id,
      properties: { DayStart: day(f.start_date, 0), DayEnd: day(f.end_date, 99999999) },
      geometry: f.geom,
    });
  }
  if (rows.length < 1000) break;
  if (feats.length % 10000 < 1000) console.log("  " + nfmt(feats.length) + " so far…");
}
if (!feats.length) { console.error("layer has no features"); process.exit(1); }
writeFileSync("layer.geojson", JSON.stringify({ type: "FeatureCollection", features: feats }));
console.log(nfmt(feats.length) + " features, source " + (statSync("layer.geojson").size / 1048576).toFixed(1) + " MB");

// ── 2. tippecanoe → PMTiles ──────────────────────────────────────────────────
const zoomArgs = MAX_ZOOM ? ["-z" + MAX_ZOOM] : ["-zg"];   // -zg = tippecanoe picks the max zoom
const args = [
  "-o", "layer.pmtiles", "--force",
  "-l", LAYER_NAME,
  ...zoomArgs,
  "--drop-densest-as-needed",        // the low-zoom diet the browser tiler approximates
  "--extend-zooms-if-still-dropping",
  "--read-parallel",
  "layer.geojson",
];
console.log("tippecanoe " + args.join(" "));
execFileSync("tippecanoe", args, { stdio: "inherit" });
const bytes = readFileSync("layer.pmtiles");
const achievedMaxZoom = bytes[101];   // PMTiles v3 header: max_zoom byte
console.log("archive " + (bytes.length / 1048576).toFixed(1) + " MB, maxzoom z" + achievedMaxZoom);

// ── 3. upload (plain POST; on exists DELETE + retry — never x-upsert, the 7/15 trap) ──
const objPath = `/storage/v1/object/${BUCKET}/${PROJECT_ID}/${LAYER_ID}.pmtiles`;
const put = () =>
  fetch(SUPABASE_URL + objPath, { method: "POST", headers: { ...H, "Content-Type": "application/octet-stream" }, body: bytes });
let up = await put();
if (!up.ok && /exist|duplicate/i.test(await up.clone().text())) {
  await rest(objPath, { method: "DELETE" });
  up = await put();
}
if (!up.ok) { console.error("upload failed: " + up.status + " " + (await up.text()).slice(0, 300)); process.exit(1); }
console.log("uploaded to " + BUCKET + "/" + PROJECT_ID + "/" + LAYER_ID + ".pmtiles");

// ── 4. point the layer at its tiles (same stamps as the browser tiler) ───────
const cur = await (await rest(`/rest/v1/layers?id=eq.${LAYER_ID}&select=raw_config,source_type`)).json();
const rc = (cur[0] && cur[0].raw_config) || {};
rc.pmtiles = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${PROJECT_ID}/${LAYER_ID}.pmtiles`;
rc.convertedFrom = rc.convertedFrom || (cur[0] && cur[0].source_type) || "geojson-supabase";
rc.tilesGeneratedAt = new Date().toISOString();
rc.tilesBytes = bytes.length;
rc.tiler = "tippecanoe";   // vs the browser default — surfaces in comparisons
await rest(`/rest/v1/layers?id=eq.${LAYER_ID}`, {
  method: "PATCH",
  headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
  body: JSON.stringify({
    source_type: "vector-tiles-url",
    source_url: `pmt/${PROJECT_ID}/${LAYER_ID}/{z}/{x}/{y}.pbf`,
    source_layer: LAYER_NAME,
    source_maxzoom: achievedMaxZoom,
    raw_config: rc,
  }),
});
console.log("layer re-pointed — done. Viewers pick up the new archive within a minute (service-worker ETag revalidation).");
