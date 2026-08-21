/* r2-inventory.mjs — what does each layer ACTUALLY occupy, across BOTH stores?
 *
 * WHY. Tiles are dual-written to Supabase Storage and Cloudflare R2, and `layers.r2_bytes` is a
 * single stamped number covering artifacts in both. Every attempt to check it against one store
 * gives a confident wrong answer: on 8/21 I compared it to the Supabase bucket alone, measured a
 * steady 12x, and committed it as a billing bug before finding that most of the gap was simply the
 * other store. `r2-sweep.mjs` reads R2, but it lists only the prefixes it derives from the deleted
 * -artifact ledger and from layers with a parquet_key — so "0 objects" there means "not in scope",
 * not "nothing stored", and reading it as absence is the same error one layer down.
 *
 * This lists the WHOLE bucket, unfiltered, joins both stores by layer id, and prints the three
 * numbers side by side. It is the reconciliation the orphan census says does not exist.
 *
 *   node scripts/r2-inventory.mjs           # per-layer, worst mismatch first
 *   node scripts/r2-inventory.mjs --all     # every layer, not just billed ones
 */
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { Client } = require("c:/repos/mapstructor_docs/testing/harness/node_modules/pg/lib/index.js");

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const r2md = fs.readFileSync(path.join(ROOT, "secrets/cloudflare-r2-credentials.md"), "utf8");
const ENDPOINT = (r2md.match(/https:\/\/[a-z0-9]+\.r2\.cloudflarestorage\.com/) || [])[0];
const sweepAK = (r2md.match(/SWEEP_ACCESS_KEY_ID = ([0-9a-f]{32})/) || [])[1];
const sweepSK = (r2md.match(/SWEEP_SECRET_ACCESS_KEY = ([0-9a-f]{64})/) || [])[1];
const haveSweep = !!(sweepAK && sweepSK);
const BUCKET = haveSweep ? (r2md.match(/SWEEP_BUCKET = (\S+)/) || [])[1] : (r2md.match(/R2_BUCKET = (\S+)/) || [])[1];
const AK = haveSweep ? sweepAK : (r2md.match(/R2_ACCESS_KEY_ID = (\S+)/) || [])[1];
const SK = haveSweep ? sweepSK : (r2md.match(/R2_SECRET_ACCESS_KEY = (\S+)/) || [])[1];
const CONN = "postgresql://postgres:0NgLopITNa4cug7v@db.eqpxlwbjqiwfjlsuapvu.supabase.co:5432/postgres";
const ALL = process.argv.includes("--all");

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const hmac = (k, s) => crypto.createHmac("sha256", k).update(s).digest();
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

async function listPage(token) {
  const host = ENDPOINT.replace("https://", "");
  const q = { "list-type": "2", "max-keys": "1000" };
  if (token) q["continuation-token"] = token;
  const qs = Object.keys(q).sort().map((k) => enc(k) + "=" + enc(q[k])).join("&");
  const now = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const day = now.slice(0, 8), scope = `${day}/auto/s3/aws4_request`;
  const canon = `GET\n/${BUCKET}\n${qs}\nhost:${host}\nx-amz-content-sha256:${sha("")}\nx-amz-date:${now}\n\nhost;x-amz-content-sha256;x-amz-date\n${sha("")}`;
  const toSign = `AWS4-HMAC-SHA256\n${now}\n${scope}\n${sha(canon)}`;
  const sig = crypto.createHmac("sha256", hmac(hmac(hmac(hmac("AWS4" + SK, day), "auto"), "s3"), "aws4_request")).update(toSign).digest("hex");
  const r = await fetch(`${ENDPOINT}/${BUCKET}?${qs}`, {
    headers: { "x-amz-date": now, "x-amz-content-sha256": sha(""),
      Authorization: `AWS4-HMAC-SHA256 Credential=${AK}/${scope}, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=${sig}` } });
  const xml = await r.text();
  if (!r.ok) throw new Error(`R2 list HTTP ${r.status}: ${xml.slice(0, 300)}`);
  const objs = [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map((m) => ({
    key: (m[1].match(/<Key>([^<]+)<\/Key>/) || [])[1],
    size: Number((m[1].match(/<Size>(\d+)<\/Size>/) || [])[1] || 0),
  })).filter((o) => o.key);
  return { objs, next: (xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/) || [])[1] || null };
}

const mb = (b) => (Number(b) / 1048576).toFixed(1);
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const LAYER_IN_KEY = new RegExp(`(${UUID})/(${UUID})\\.`, "i");

const r2 = [];
let token = null;
for (let page = 0; page < 100; page++) {
  const { objs, next } = await listPage(token);
  r2.push(...objs);
  if (!next) break;
  token = next;
}
const r2Total = r2.reduce((n, o) => n + o.size, 0);
console.log(`R2 bucket ${BUCKET}: ${r2.length} objects · ${mb(r2Total)} MB (FULL listing, no prefix filter)`);

const r2ByLayer = new Map();
let r2Unattributed = 0;
for (const o of r2) {
  const m = o.key.match(LAYER_IN_KEY);
  if (!m) { r2Unattributed += o.size; continue; }
  r2ByLayer.set(m[2].toLowerCase(), (r2ByLayer.get(m[2].toLowerCase()) || 0) + o.size);
}

const c = new Client({ connectionString: CONN, ssl: { rejectUnauthorized: false } });
await c.connect();
try {
  const { rows: sup } = await c.query(`
    select lower(split_part(split_part(name,'/',2),'.',1)) as lid, sum(coalesce((metadata->>'size')::bigint,0)) as sz
      from storage.objects where bucket_id='tiles' group by 1`);
  const supByLayer = new Map(sup.map((r) => [r.lid, Number(r.sz)]));

  const { rows: layers } = await c.query(`
    select lower(id::text) as id, name, coalesce(r2_bytes,0) as meter, deleted_at is not null as trashed
      from layers order by r2_bytes desc nulls last`);

  const rows = [];
  for (const L of layers) {
    const r2b = r2ByLayer.get(L.id) || 0, supb = supByLayer.get(L.id) || 0;
    if (!ALL && Number(L.meter) === 0 && r2b === 0 && supb === 0) continue;
    rows.push({ ...L, meter: Number(L.meter), r2b, supb, real: r2b + supb });
  }
  rows.sort((a, b) => (b.meter - b.real) - (a.meter - a.real));

  console.log(`\n${"layer".padEnd(30)} ${"meter".padStart(9)} ${"R2".padStart(9)} ${"supabase".padStart(9)} ${"real".padStart(9)}  gap`);
  for (const r of rows.slice(0, 20)) {
    const gap = r.meter - r.real;
    console.log(`${(r.name || "?").slice(0, 30).padEnd(30)} ${(mb(r.meter) + "M").padStart(9)} ${(mb(r.r2b) + "M").padStart(9)} ${(mb(r.supb) + "M").padStart(9)} ${(mb(r.real) + "M").padStart(9)}  ${gap >= 0 ? "+" : ""}${mb(gap)}M${r.trashed ? "  (trashed)" : ""}`);
  }
  const tM = rows.reduce((n, r) => n + r.meter, 0), tR = rows.reduce((n, r) => n + r.real, 0);
  const billed = rows.filter((r) => r.meter > 0).length, unbilled = rows.filter((r) => r.meter === 0 && r.real > 0);
  console.log(`\nTOTAL billed ${mb(tM)} MB  ·  stored across both stores for those layers ${mb(tR)} MB`);
  console.log(`R2 bytes under no layer id (datasets/, thumbs/, deleted layers): ${mb(r2Unattributed)} MB`);
  console.log(`\n${billed} layer(s) carry a non-zero r2_bytes. ${unbilled.length} hold real artifacts and are billed ZERO`);
  console.log(`(${mb(unbilled.reduce((n, r) => n + r.real, 0))} MB of them). The retile Action stamps r2_bytes only inside its`);
  console.log(`\`if (FOLD)\` branch, so a layer that got tiles WITHOUT being folded is free forever.`);
  console.log(`\nTwo cautions on the numbers above, both learned the hard way today:`);
  console.log(`  · R2 + supabase is not double counting for COST — tiles are dual-written and both`);
  console.log(`    stores are paid for — but it is not "how much data this layer represents" either.`);
  console.log(`  · The dashboard totals data_bytes + r2_bytes over LIVE layers, so files belonging to`);
  console.log(`    DELETED layers are real storage the quota does not count. Freeing them is worth`);
  console.log(`    doing and will NOT move that number.`);
} finally { await c.end(); }
