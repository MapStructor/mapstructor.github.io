/* showcase-update.mjs — publish a directory as a /maps/<slug> showcase, revertably. Todo #9's
 * bounded half: upload → manifest → live verify → --revert. The HEADLESS-EXPORT front half plugs
 * in when export-standalone E5 (the export draws no data) is resolved; until then the input is a
 * directory, which is also exactly how the railways showcase was built by hand.
 *
 *   node scripts/showcase-update.mjs --dir <folder> --slug <slug>     # stage, upload, verify
 *   node scripts/showcase-update.mjs --revert --slug <slug>           # restore the previous publish
 *   node scripts/showcase-update.mjs --status --slug <slug>           # what is live, what is _prev
 *
 * SAFETY MODEL (r2-foundation revert rule):
 *   · Before any overwrite, every live object is COPIED to maps/<slug>/_prev/<rel> — revert
 *     restores CONTENT, not just names. Files new in this publish are recorded so revert deletes
 *     them; files removed by this publish survive in _prev and come back on revert.
 *   · The manifest (maps/<slug>/_manifest.json) is written LAST, after verify — so a half-dead
 *     upload leaves the old manifest telling the truth about what _prev holds.
 *   · Verify fetches index.html through the PUBLIC worker route and compares bytes to the local
 *     file. A publish that cannot be read back the way a visitor reads it did not happen.
 *   · The signing helper is r2-sweep.mjs's SigV4, extended to PUT/DELETE/COPY. Same credentials
 *     file, same bucket the worker serves from.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const r2md = fs.readFileSync(path.join(ROOT, "secrets/cloudflare-r2-credentials.md"), "utf8");
const ENDPOINT = (r2md.match(/https:\/\/[a-z0-9]+\.r2\.cloudflarestorage\.com/) || [])[0];
const AK = (r2md.match(/SWEEP_ACCESS_KEY_ID = ([0-9a-f]{32})/) || [])[1];
const SK = (r2md.match(/SWEEP_SECRET_ACCESS_KEY = ([0-9a-f]{64})/) || [])[1];
const BUCKET = (r2md.match(/SWEEP_BUCKET = (\S+)/) || [])[1];
if (!ENDPOINT || !AK || !SK || !BUCKET) { console.error("could not read the SWEEP_* R2 credentials"); process.exit(1); }
/* The domain VISITORS use. tiles.mapstructor.com is the raw R2 custom domain — exact keys only,
   so the slash form 404s there (found 8/25 when the render smoke hit it); the worker's directory
   handling lives on mapstructor.com/maps/*. Verifying on the raw domain would pass while the page
   people actually open failed. */
const PUBLIC = "https://mapstructor.com/";

const arg = (k) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : null; };
const SLUG = (arg("--slug") || "").replace(/[^a-z0-9_-]/gi, "");
const DIR = arg("--dir");
const REVERT = process.argv.includes("--revert");
const STATUS = process.argv.includes("--status");
if (!SLUG) { console.error("usage: --dir <folder> --slug <slug> | --revert --slug <slug> | --status --slug <slug>"); process.exit(1); }
const PREFIX = `maps/${SLUG}/`;

/* ── SigV4, any method (lifted from r2-sweep.mjs, which is GET-only) ─────────────────────────── */
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const hmac = (k, s) => crypto.createHmac("sha256", k).update(s).digest();
function signed(method, key, query, body, extraHeaders) {
  const host = ENDPOINT.replace("https://", "");
  const now = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const day = now.slice(0, 8);
  const bodyHash = sha(body || "");
  const hdrs = Object.assign({ host, "x-amz-content-sha256": bodyHash, "x-amz-date": now }, extraHeaders || {});
  const names = Object.keys(hdrs).map((h) => h.toLowerCase()).sort();
  const canonHdrs = names.map((h) => `${h}:${String(hdrs[h] ?? hdrs[Object.keys(hdrs).find((k) => k.toLowerCase() === h)]).trim()}\n`).join("");
  const qs = Object.keys(query || {}).sort().map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k])}`).join("&");
  const canonPath = `/${BUCKET}/${key}`.split("/").map(encodeURIComponent).join("/").replace(/%2F/g, "/");
  const canon = `${method}\n${canonPath}\n${qs}\n${canonHdrs}\n${names.join(";")}\n${bodyHash}`;
  const scope = `${day}/auto/s3/aws4_request`;
  const toSign = `AWS4-HMAC-SHA256\n${now}\n${scope}\n${sha(canon)}`;
  const sig = crypto.createHmac("sha256", hmac(hmac(hmac(hmac("AWS4" + SK, day), "auto"), "s3"), "aws4_request")).update(toSign).digest("hex");
  const auth = `AWS4-HMAC-SHA256 Credential=${AK}/${scope}, SignedHeaders=${names.join(";")}, Signature=${sig}`;
  const out = Object.assign({}, hdrs, { Authorization: auth });
  delete out.host;
  return { url: `${ENDPOINT}/${BUCKET}/${key}${qs ? "?" + qs : ""}`, headers: out };
}
async function s3(method, key, { query, body, headers } = {}) {
  const { url, headers: h } = signed(method, key, query, body, headers);
  const r = await fetch(url, { method, headers: h, body: body || undefined, signal: AbortSignal.timeout(60000) });
  if (!r.ok && r.status !== 404) throw new Error(`${method} ${key}: HTTP ${r.status} ${(await r.text()).slice(0, 160)}`);
  return r;
}
async function listAll(prefix) {
  const keys = [];
  let token = null;
  for (;;) {
    const q = { "list-type": "2", "max-keys": "1000", prefix };
    if (token) q["continuation-token"] = token;
    const r = await s3("GET", "", { query: q });
    const xml = await r.text();
    for (const m of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) keys.push(m[1]);
    token = (xml.match(/<NextContinuationToken>([^<]+)</) || [])[1] || null;
    if (!token) break;
  }
  return keys;
}
/* Kept CHARACTER-FOR-CHARACTER in step with publishSite.js's MIME map. They write the same objects,
   so a divergence stores a different Content-Type depending on which one last pushed — and a page
   served as bare `text/html` leaves the browser guessing the encoding on non-ASCII content. */
const MIME = { html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8", json: "application/json",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", svg: "image/svg+xml", webp: "image/webp",
  pbf: "application/x-protobuf", pmtiles: "application/octet-stream", geojson: "application/geo+json",
  parquet: "application/octet-stream", ico: "image/x-icon", woff2: "font/woff2" };
const mime = (f) => MIME[f.split(".").pop().toLowerCase()] || "application/octet-stream";

/* ── status ──────────────────────────────────────────────────────────────────────────────────── */
if (STATUS) {
  const keys = await listAll(PREFIX);
  const live = keys.filter((k) => !k.startsWith(PREFIX + "_prev/") && !k.endsWith("_manifest.json"));
  const prev = keys.filter((k) => k.startsWith(PREFIX + "_prev/"));
  let man = null;
  try { man = JSON.parse(await (await s3("GET", PREFIX + "_manifest.json")).text()); } catch (e) {}
  console.log(`${SLUG}: ${live.length} live object(s), ${prev.length} in _prev`);
  if (man) console.log(`manifest: published ${man.at} · ${man.files.length} file(s) · added ${man.added.length} · prev holds ${man.prevHolds.length}`);
  process.exit(0);
}

/* ── revert ──────────────────────────────────────────────────────────────────────────────────── */
if (REVERT) {
  const man = JSON.parse(await (await s3("GET", PREFIX + "_manifest.json")).text());
  if (!man || !man.prevHolds) { console.error("no manifest with a _prev record — nothing to revert to"); process.exit(1); }
  console.log(`reverting ${SLUG} to the publish before ${man.at}…`);
  for (const rel of man.prevHolds) {
    await s3("PUT", PREFIX + rel, { headers: { "x-amz-copy-source": `/${BUCKET}/${encodeURIComponent(PREFIX + "_prev/" + rel).replace(/%2F/g, "/")}` } });
    console.log(`  restored ${rel}`);
  }
  for (const rel of man.added) {
    await s3("DELETE", PREFIX + rel);
    console.log(`  removed ${rel} (was new in the reverted publish)`);
  }
  await s3("DELETE", PREFIX + "_manifest.json");
  console.log(`reverted — ${man.prevHolds.length} restored, ${man.added.length} removed. _prev kept for inspection.`);
  process.exit(0);
}

/* ── publish ─────────────────────────────────────────────────────────────────────────────────── */
if (!DIR || !fs.existsSync(DIR)) { console.error("--dir does not exist: " + DIR); process.exit(1); }
const files = [];
(function walk(d, rel) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    const p2 = path.join(d, e.name), r2 = rel ? rel + "/" + e.name : e.name;
    if (e.isDirectory()) walk(p2, r2); else files.push(r2.replace(/\\/g, "/"));
  }
})(DIR, "");
if (!files.includes("index.html")) { console.error("the folder has no index.html — a showcase must open"); process.exit(1); }
console.log(`publishing ${files.length} file(s) from ${DIR} → /${PREFIX}`);

const liveKeys = (await listAll(PREFIX)).filter((k) => !k.startsWith(PREFIX + "_prev/") && !k.endsWith("_manifest.json"));
const liveRel = liveKeys.map((k) => k.slice(PREFIX.length));
console.log(`  live now: ${liveRel.length} object(s) — copying to _prev before anything is touched`);
for (const rel of liveRel) {
  await s3("PUT", PREFIX + "_prev/" + rel, { headers: { "x-amz-copy-source": `/${BUCKET}/${encodeURIComponent(PREFIX + rel).replace(/%2F/g, "/")}` } });
}

const added = files.filter((f) => !liveRel.includes(f));
for (const rel of files) {
  const body = fs.readFileSync(path.join(DIR, rel));
  await s3("PUT", PREFIX + rel, { body, headers: { "content-type": mime(rel) } });
  process.stdout.write(`\r  uploaded ${rel}                              `);
}
console.log("");

/* verify THROUGH THE PUBLIC ROUTE, byte-for-byte on index.html */
const pub = await fetch(PUBLIC + PREFIX + "index.html", { cache: "no-store", signal: AbortSignal.timeout(30000) });
const pubBytes = Buffer.from(await pub.arrayBuffer());
const localBytes = fs.readFileSync(path.join(DIR, "index.html"));
if (!pub.ok || !pubBytes.equals(localBytes)) {
  console.error(`VERIFY FAILED — public route returned HTTP ${pub.status}, bytes ${pubBytes.equals(localBytes) ? "match" : "DIFFER"}.`);
  console.error(`The old manifest is untouched; run --revert --slug ${SLUG} to restore the previous publish.`);
  process.exit(1);
}
await s3("PUT", PREFIX + "_manifest.json", {
  body: JSON.stringify({ at: new Date().toISOString(), files, added, prevHolds: liveRel }, null, 2),
  headers: { "content-type": "application/json" },
});
console.log(`verified live (index.html byte-identical via ${PUBLIC}${PREFIX}) — manifest written.`);
console.log(`revert anytime:  node scripts/showcase-update.mjs --revert --slug ${SLUG}`);
