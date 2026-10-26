/* gpkg-prepare.mjs — the CLOUD half of GeoPackage import (owner 10/26: "we need to add very large
   files … maybe not have it dealt with in the browser").

   The browser reads a GeoPackage under its ceiling itself (platform/gpkg.js). Above it, the editor
   uploads the package to R2 in chunks (Worker /mpu/*) and asks the Worker to dispatch this
   workflow with mode=fold-file. This script then:
     1. downloads the package from R2 (RAW_KEY = tiles/<pid>/<lid>.source.gpkg);
     2. lists its feature tables with ogrinfo and converts each with ogr2ogr to a GeoJSON
        FeatureCollection in EPSG:4326 (GDAL reads GeoPackage natively — no JS parser, no size cap);
        a table of mixed geometry types is split by kind, exactly as the browser importer splits;
     3. turns the ONE placeholder layer the editor created into the first table and INSERTS a
        sibling layer row (+ project link) for every further table, stamping the placeholder's
        raw_config.siblings so the editor can pick them up live;
     4. runs scripts/retile-tippecanoe.mjs in mode fold-raw with RAW_FILE once per layer — the same
        bake, artifacts and stamps every other cloud fold gets. No feature rows are written: the
        layers are tiles + sidecar until someone pulls features in to edit (the C4 delta path).

   Env: SUPABASE_SERVICE_KEY, PROJECT_ID, LAYER_ID (the placeholder), RAW_KEY, plus everything the
   bake script reads (R2 creds, MAX_ZOOM, SIMPLIFY) — passed through to each child run.
   Needs ogrinfo/ogr2ogr (GDAL ≥ 3.7 for `ogrinfo -json`) and tippecanoe on PATH. */

import { execFileSync, spawnSync } from "node:child_process";
import { createWriteStream, readFileSync, writeFileSync, statSync, mkdirSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";

const SUPABASE_URL = process.env.SUPABASE_URL || "https://eqpxlwbjqiwfjlsuapvu.supabase.co";
const KEY = process.env.SUPABASE_SERVICE_KEY;
const PROJECT_ID = process.env.PROJECT_ID;
const LAYER_ID = process.env.LAYER_ID;
const RAW_KEY = (process.env.RAW_KEY || "").trim();
const R2_PUBLIC = "https://tiles.mapstructor.com";
const H = { apikey: KEY, Authorization: "Bearer " + KEY };
const nfmt = (n) => Number(n).toLocaleString("en-US");
const LAYER_COLORS = ["#4a9eff", "#e8553e", "#3bb273", "#b56cd6", "#e8a33e", "#3ec0d0", "#d64576"];   // editing.js palette

if (!KEY || !PROJECT_ID || !LAYER_ID || !RAW_KEY) { console.error("need SUPABASE_SERVICE_KEY, PROJECT_ID, LAYER_ID, RAW_KEY"); process.exit(1); }
if (RAW_KEY.indexOf(`tiles/${PROJECT_ID}/`) !== 0) { console.error("RAW_KEY must live under tiles/" + PROJECT_ID + "/"); process.exit(1); }

async function rest(path, opts = {}) {
  const r = await fetch(SUPABASE_URL + path, { ...opts, headers: { ...H, ...(opts.headers || {}) } });
  if (!r.ok) throw new Error(`${opts.method || "GET"} ${path} → ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r;
}
async function stampFailure(msg) {
  try {
    const cur = await (await rest(`/rest/v1/layers?id=eq.${LAYER_ID}&select=raw_config`)).json();
    const rc = (cur[0] && cur[0].raw_config) || {};
    rc.foldError = String(msg).slice(0, 300);
    await rest(`/rest/v1/layers?id=eq.${LAYER_ID}`, { method: "PATCH", headers: { "Content-Type": "application/json", Prefer: "return=minimal" }, body: JSON.stringify({ raw_config: rc }) });
  } catch (e) { console.error("could not stamp foldError:", e.message); }
}
// GDAL geometry type names → the editor's three layer kinds
function kindOf(typeName) {
  const t = String(typeName || "");
  if (/point/i.test(t)) return "circle";
  if (/line|curve/i.test(t)) return "line";
  if (/polygon|surface/i.test(t)) return "fill";
  return null;   // Unknown / Geometry / GeometryCollection → decide per feature
}
function kindOfGeom(g) {
  const t = g && g.type;
  return t === "Point" || t === "MultiPoint" ? "circle" : t === "LineString" || t === "MultiLineString" ? "line" : t === "Polygon" || t === "MultiPolygon" ? "fill" : null;
}
const KIND_LABEL = { circle: "points", line: "lines", fill: "polygons" };

try {
  /* ── 1. the package ──────────────────────────────────────────────────────────── */
  console.log("Downloading " + RAW_KEY);
  let res = null;
  for (let a = 1; a <= 4 && !res; a++) {
    const r = await fetch(`${R2_PUBLIC}/${RAW_KEY}`, { cache: "no-store" });
    if (r.ok) res = r; else { console.warn("download " + r.status + " (try " + a + ")"); await new Promise((rs) => setTimeout(rs, 4000)); }
  }
  if (!res) throw new Error("source package unavailable at " + RAW_KEY);
  await pipeline(Readable.fromWeb(res.body), createWriteStream("source.gpkg"));
  const sourceBytes = statSync("source.gpkg").size;
  console.log("package: " + nfmt(sourceBytes) + " bytes");

  /* ── 2. tables → GeoJSON (EPSG:4326, 2-D) ───────────────────────────────────── */
  const info = JSON.parse(execFileSync("ogrinfo", ["-json", "-so", "source.gpkg"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
  const tables = (info.layers || []).filter((l) => l.geometryFields && l.geometryFields.length);
  if (!tables.length) throw new Error("the package holds no feature tables (rasters or attributes only)");
  console.log("feature tables: " + tables.map((t) => t.name + " (" + nfmt(t.featureCount) + ", " + ((t.geometryFields[0] || {}).type || "?") + ")").join(" · "));
  mkdirSync("gpkg-out", { recursive: true });
  const outputs = [];   // {name, kind, file}
  tables.forEach((t, i) => {
    const file = `gpkg-out/${i}.geojson`;
    execFileSync("ogr2ogr", ["-f", "GeoJSON", "-t_srs", "EPSG:4326", "-dim", "XY", "-skipfailures", "-lco", "RFC7946=NO", "-lco", "WRITE_BBOX=NO", "-lco", "ID_FIELD=", file, "source.gpkg", t.name], { stdio: ["ignore", "inherit", "inherit"] });
    const kind = kindOf((t.geometryFields[0] || {}).type);
    if (kind) { outputs.push({ name: t.name, kind, file }); return; }
    // mixed or undeclared geometry: split by kind, one layer per kind, named like the browser does
    const fc = JSON.parse(readFileSync(file, "utf8"));
    const by = { circle: [], line: [], fill: [] };
    (fc.features || []).forEach((f) => { const k = kindOfGeom(f.geometry); if (k) by[k].push(f); });
    const kinds = Object.keys(by).filter((k) => by[k].length);
    kinds.forEach((k) => {
      const kf = `gpkg-out/${i}-${k}.geojson`;
      writeFileSync(kf, JSON.stringify({ type: "FeatureCollection", features: by[k] }));
      outputs.push({ name: kinds.length > 1 ? t.name + " (" + KIND_LABEL[k] + ")" : t.name, kind: k, file: kf });
    });
  });
  if (!outputs.length) throw new Error("no point, line or polygon features in the package");

  /* ── 3. layer rows: the placeholder becomes the first table; siblings for the rest ── */
  const ph = (await (await rest(`/rest/v1/layers?id=eq.${LAYER_ID}&select=*`)).json())[0];
  if (!ph) throw new Error("placeholder layer not found");
  const link = (await (await rest(`/rest/v1/project_layers?project_id=eq.${PROJECT_ID}&layer_id=eq.${LAYER_ID}&select=sort_order,section_id,group_id`)).json())[0] || {};
  const rc0 = ph.raw_config || {};
  const first = outputs[0];
  const phPatch = { type: first.kind, raw_config: { ...rc0 } };
  if (outputs.length > 1) phPatch.name = first.name;   // one table keeps the file's name; several take their table names
  const siblingIds = [];
  for (let i = 1; i < outputs.length; i++) {
    const o = outputs[i];
    const row = {
      slug: "new-" + Date.now().toString(36) + randomUUID().slice(0, 3),   // the editor's uid() shape
      name: o.name, type: o.kind, color: LAYER_COLORS[i % LAYER_COLORS.length],
      user_id: ph.user_id, fold_state: "folding", enabled_by_default: true,
      source_type: null, paint: ph.paint, layout: ph.layout,
      hover: ph.hover, hover_paint: ph.hover_paint, click: ph.click, popup_style: ph.popup_style, popup_prop: ph.popup_prop,
      raw_config: { cloudImport: rc0.cloudImport || null, siblingOf: LAYER_ID },
    };
    const ins = await (await rest(`/rest/v1/layers`, { method: "POST", headers: { "Content-Type": "application/json", Prefer: "return=representation" }, body: JSON.stringify(row) })).json();
    const sid = ins[0] && ins[0].id; if (!sid) throw new Error("sibling layer insert returned no id");
    await rest(`/rest/v1/project_layers`, { method: "POST", headers: { "Content-Type": "application/json", Prefer: "return=minimal" }, body: JSON.stringify({ project_id: PROJECT_ID, layer_id: sid, sort_order: (link.sort_order || 0) + i, section_id: link.section_id || null, group_id: link.group_id || null }) });
    siblingIds.push(sid);
    console.log("sibling layer " + sid + " ← " + o.name + " (" + o.kind + ")");
  }
  if (siblingIds.length) phPatch.raw_config.siblings = siblingIds;
  await rest(`/rest/v1/layers?id=eq.${LAYER_ID}`, { method: "PATCH", headers: { "Content-Type": "application/json", Prefer: "return=minimal" }, body: JSON.stringify(phPatch) });

  /* ── 4. bake each layer with the one bake script ──────────────────────────────── */
  const ids = [LAYER_ID, ...siblingIds];
  let failed = 0;
  for (let i = 0; i < outputs.length; i++) {
    console.log(`\n═══ bake ${i + 1}/${outputs.length}: ${outputs[i].name} → layer ${ids[i]} ═══`);
    const r = spawnSync(process.execPath, ["--max-old-space-size=12288", "scripts/retile-tippecanoe.mjs"], {
      stdio: "inherit",
      env: { ...process.env, MODE: "fold-raw", LAYER_ID: ids[i], RAW_FILE: outputs[i].file, SOURCE_BYTES: String(i === 0 ? sourceBytes : 0) },
    });
    if (r.status !== 0) { failed++; console.error("bake failed for " + outputs[i].name + " (exit " + r.status + ")"); }   // the child stamped its own foldError
  }
  if (failed) { console.error(failed + " of " + outputs.length + " layers failed"); process.exit(1); }
  console.log("\nall " + outputs.length + " layer(s) baked from " + RAW_KEY);
} catch (e) {
  console.error("gpkg-prepare failed:", e && e.stack || e);
  await stampFailure((e && e.message) || String(e));
  process.exit(1);
}
