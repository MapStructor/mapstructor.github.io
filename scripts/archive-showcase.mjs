/* archive-showcase.mjs — take a durable, dated copy of a live /maps/<slug>/ bundle BEFORE it is
 * overwritten for the first time.
 *
 * WHY, specifically for railways (9/3): the live bundle was hand-built from project f914d5e6,
 * which has since been DELETED — it cannot be regenerated from anything. showcase-update's
 * `_prev` is one level deep, so the FIRST publish protects it but the SECOND would overwrite
 * _prev and the original would be gone for good. The owner's 7/27 rule is "reverting is
 * mandatory"; a one-deep undo does not satisfy that for an irreplaceable artifact.
 *
 * Server-side COPY only — no bytes leave Cloudflare, so a 150 MB bundle archives in seconds.
 *
 *   node archive-showcase.mjs <slug> <archive-name>
 */
import fs from "node:fs";
import crypto from "node:crypto";

const ROOT = "c:/repos/mapstructor.github.io";
const r2md = fs.readFileSync(ROOT + "/secrets/cloudflare-r2-credentials.md", "utf8");
const ENDPOINT = (r2md.match(/https:\/\/[a-z0-9]+\.r2\.cloudflarestorage\.com/) || [])[0];
const AK = (r2md.match(/SWEEP_ACCESS_KEY_ID = ([0-9a-f]{32})/) || [])[1];
const SK = (r2md.match(/SWEEP_SECRET_ACCESS_KEY = ([0-9a-f]{64})/) || [])[1];
const BUCKET = (r2md.match(/SWEEP_BUCKET = (\S+)/) || [])[1];

const SLUG = process.argv[2], NAME = process.argv[3];
if (!SLUG || !NAME) { console.error("usage: node archive-showcase.mjs <slug> <archive-name>"); process.exit(1); }
const PREFIX = `maps/${SLUG}/`, DEST = `archives/${NAME}/`;

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
  const r = await fetch(url, { method, headers: h, body: body || undefined, signal: AbortSignal.timeout(120000) });
  if (!r.ok && r.status !== 404) throw new Error(`${method} ${key}: HTTP ${r.status} ${(await r.text()).slice(0, 160)}`);
  return r;
}
async function listAll(prefix) {
  const out = []; let token = null;
  for (;;) {
    const q = { "list-type": "2", "max-keys": "1000", prefix };
    if (token) q["continuation-token"] = token;
    const xml = await (await s3("GET", "", { query: q })).text();
    const keys = [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]);
    const sizes = [...xml.matchAll(/<Size>(\d+)<\/Size>/g)].map((m) => Number(m[1]));
    keys.forEach((k, i) => out.push({ key: k, size: sizes[i] || 0 }));
    token = (xml.match(/<NextContinuationToken>([^<]+)</) || [])[1] || null;
    if (!token) break;
  }
  return out;
}

const live = (await listAll(PREFIX)).filter((o) => !o.key.startsWith(PREFIX + "_prev/"));
const total = live.reduce((a, o) => a + o.size, 0);
console.log(`archiving ${live.length} object(s), ${(total / 1048576).toFixed(1)} MB  →  ${DEST}`);
let n = 0;
for (const o of live) {
  const rel = o.key.slice(PREFIX.length);
  await s3("PUT", DEST + rel, { headers: { "x-amz-copy-source": `/${BUCKET}/${encodeURIComponent(o.key).replace(/%2F/g, "/")}` } });
  if (++n % 25 === 0 || n === live.length) console.log(`  ${n}/${live.length}`);
}
/* an index of what this archive holds, so a restore does not depend on remembering */
const idx = JSON.stringify({ archivedFrom: PREFIX, at: new Date().toISOString(), files: live.map((o) => ({ rel: o.key.slice(PREFIX.length), size: o.size })) }, null, 2);
await s3("PUT", DEST + "_archive.json", { body: Buffer.from(idx), headers: { "content-type": "application/json" } });
const check = await listAll(DEST);
console.log(`archived: ${check.length} object(s) now under ${DEST} (expected ${live.length + 1})`);
