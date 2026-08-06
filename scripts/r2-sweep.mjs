/* r2-sweep.mjs — STAGE 1: DRY RUN ONLY. Reports what an R2 sweep WOULD reclaim; deletes nothing.
 *
 * Why this exists: Postgres cannot reach into the bucket, so ms_delete_project_forever /
 * ms_delete_layer_forever record every purged layer in ms_deleted_artifacts and leave the R2
 * objects behind. This script reads that ledger, finds each row's objects in the bucket, and
 * classifies them:
 *   WOULD DELETE — object belongs to a purged layer and no live layer's parquet_key points at it
 *   KEEP        — a live layer (C7 pointer copy) still reads this artifact base
 *   MARK SWEPT  — ledger row has no objects in R2 at all (layer was never baked)
 * Plus an audit: layer-keyed objects in the bucket that belong to NO live layer and NO ledger row.
 *
 * Stage 2 flags (8/6 — the pre-approval half; actual deletion still needs owner sign-off on the
 * orphan manifest AND a Write token, and is deliberately not implemented until both exist):
 *   --stamp              stamp swept_at on MARK-SWEPT rows (rows with zero R2 objects — pure
 *                        bookkeeping, nothing to delete for them by construction)
 *   --orphans-out <file> write EVERY audit orphan (key + bytes, grouped by project) to <file>;
 *                        that file is the approval manifest --apply-orphans consumes
 *   --apply-orphans <file>  THE DELETE PASS (owner approved the manifest 2026-08-06). Deletes only
 *                        keys that are in the manifest AND still classify as orphans in this same
 *                        run (drift protection), then re-lists the bucket to verify. Requires the
 *                        sweeper token to have Object Write — a 403 aborts cleanly before damage.
 * Run:  node scripts/r2-sweep.mjs        (credentials come from secrets/, which is gitignored)
 */
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const r2md = fs.readFileSync(path.join(ROOT, "secrets/cloudflare-r2-credentials.md"), "utf8");
const sbmd = fs.readFileSync(path.join(ROOT, "secrets/supabase.md"), "utf8");
const ENDPOINT = (r2md.match(/https:\/\/[a-z0-9]+\.r2\.cloudflarestorage\.com/) || [])[0];
// SWEEP_* lines are the read-only token scoped to the LIVE bucket (mapstructor-tiles); the plain
// R2_* lines are the old ames-tiles token, kept for the Ames map. The sweeper prefers SWEEP_*.
const sweepAK = (r2md.match(/SWEEP_ACCESS_KEY_ID = ([0-9a-f]{32})/) || [])[1];   // hex only — PASTE_HERE placeholders don't count
const sweepSK = (r2md.match(/SWEEP_SECRET_ACCESS_KEY = ([0-9a-f]{64})/) || [])[1];
const haveSweep = !!(sweepAK && sweepSK);
const BUCKET = haveSweep ? (r2md.match(/SWEEP_BUCKET = (\S+)/) || [])[1] : (r2md.match(/R2_BUCKET = (\S+)/) || [])[1];
const AK = haveSweep ? sweepAK : (r2md.match(/R2_ACCESS_KEY_ID = (\S+)/) || [])[1];
const SK = haveSweep ? sweepSK : (r2md.match(/R2_SECRET_ACCESS_KEY = (\S+)/) || [])[1];
if (!haveSweep) console.warn(`(no sweeper token yet — reporting against the OLD ${BUCKET} bucket; paste the SWEEP_* token to point at the live one)\n`);
const SB_URL = (sbmd.match(/https:\/\/[a-z0-9]+\.supabase\.co/) || [])[0];
const SVC = (sbmd.match(/sb_secret_[A-Za-z0-9_\-]+/) || [])[0];
if (!ENDPOINT || !BUCKET || !AK || !SK || !SB_URL || !SVC) { console.error("could not read credentials"); process.exit(1); }

/* ── minimal SigV4 for ListObjectsV2 (GET, empty body) ─────────────────────── */
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const hmac = (k, s) => crypto.createHmac("sha256", k).update(s).digest();
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
async function listPage(prefix, token) {
  const host = ENDPOINT.replace("https://", "");
  const q = { "list-type": "2", "max-keys": "1000", prefix };
  if (token) q["continuation-token"] = token;
  const qs = Object.keys(q).sort().map((k) => enc(k) + "=" + enc(q[k])).join("&");
  const now = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const day = now.slice(0, 8);
  const scope = `${day}/auto/s3/aws4_request`;
  const canon = `GET\n/${BUCKET}\n${qs}\nhost:${host}\nx-amz-content-sha256:${sha("")}\nx-amz-date:${now}\n\nhost;x-amz-content-sha256;x-amz-date\n${sha("")}`;
  const toSign = `AWS4-HMAC-SHA256\n${now}\n${scope}\n${sha(canon)}`;
  const sig = crypto.createHmac("sha256", hmac(hmac(hmac(hmac("AWS4" + SK, day), "auto"), "s3"), "aws4_request")).update(toSign).digest("hex");
  const r = await fetch(`${ENDPOINT}/${BUCKET}?${qs}`, {
    headers: {
      "x-amz-date": now, "x-amz-content-sha256": sha(""),
      Authorization: `AWS4-HMAC-SHA256 Credential=${AK}/${scope}, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=${sig}`,
    },
  });
  const xml = await r.text();
  if (!r.ok) throw new Error(`R2 list HTTP ${r.status}: ${xml.slice(0, 300)}`);
  // parse per <Contents> block — element ORDER inside is not guaranteed, so match Key/Size separately
  const objs = [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map((m) => ({
    key: (m[1].match(/<Key>([^<]+)<\/Key>/) || [])[1],
    size: Number((m[1].match(/<Size>(\d+)<\/Size>/) || [])[1] || 0),
  })).filter((o) => o.key);
  const next = (xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/) || [])[1] || null;
  return { objs, next };
}
// object-level request (DELETE) — same SigV4 shape as listPage but path carries the key, no query
async function s3req(method, key) {
  const host = ENDPOINT.replace("https://", "");
  const canonPath = "/" + BUCKET + "/" + key.split("/").map(enc).join("/");
  const now = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const day = now.slice(0, 8);
  const scope = `${day}/auto/s3/aws4_request`;
  const canon = `${method}\n${canonPath}\n\nhost:${host}\nx-amz-content-sha256:${sha("")}\nx-amz-date:${now}\n\nhost;x-amz-content-sha256;x-amz-date\n${sha("")}`;
  const toSign = `AWS4-HMAC-SHA256\n${now}\n${scope}\n${sha(canon)}`;
  const sig = crypto.createHmac("sha256", hmac(hmac(hmac(hmac("AWS4" + SK, day), "auto"), "s3"), "aws4_request")).update(toSign).digest("hex");
  return fetch(`${ENDPOINT}${canonPath}`, {
    method,
    headers: {
      "x-amz-date": now, "x-amz-content-sha256": sha(""),
      Authorization: `AWS4-HMAC-SHA256 Credential=${AK}/${scope}, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=${sig}`,
    },
  });
}
async function listAll(prefix) {
  const out = []; let token = null;
  for (let page = 0; page < 100; page++) {           // 100k-object hard stop — a report, not a crawler
    const { objs, next } = await listPage(prefix, token);
    out.push(...objs);
    if (!next) return out;
    token = next;
  }
  console.warn(`  (listing under "${prefix}" stopped at 100k objects — report is a floor, not a total)`);
  return out;
}
async function sb(pathQ) {
  const r = await fetch(`${SB_URL}/rest/v1/${pathQ}`, { headers: { apikey: SVC, Authorization: "Bearer " + SVC } });
  if (!r.ok) throw new Error(`supabase ${r.status} on ${pathQ}`);
  return r.json();
}
const mb = (b) => (b / 1048576).toFixed(1) + " MB";

/* ── the report ────────────────────────────────────────────────────────────── */
const ledger = await sb("ms_deleted_artifacts?swept_at=is.null&select=id,layer_id,parquet_key,bytes,deleted_at");
const live = await sb("layers?select=id,parquet_key");
const liveIds = new Set(live.map((l) => l.id));
const liveBases = new Set(live.filter((l) => l.parquet_key).map((l) => l.parquet_key.replace(/\.parquet$/, "")));
console.log(`ledger: ${ledger.length} unswept row(s) · live layers: ${live.length} (${liveBases.size} with artifacts)\n`);

// one listing per artifact prefix; every layer-keyed file lives under these (see worker/README.md)
const objects = [];
for (const p of ["tiles/", "sidecars/", "geoparquet/"]) objects.push(...await listAll(p));
const totalBucket = objects.reduce((a, o) => a + o.size, 0);
console.log(`bucket (artifact prefixes): ${objects.length} objects · ${mb(totalBucket)}\n`);

// index objects by the uuid(s) in their key and by their extensionless base
const byLayer = new Map();
for (const o of objects) {
  o.base = o.key.replace(/\.[a-z.]+$/i, "");
  for (const m of o.key.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g)) {
    if (!byLayer.has(m[0])) byLayer.set(m[0], []);
    byLayer.get(m[0]).push(o);
  }
}

let wouldDelete = [], kept = [], sweepable = [];
const claimed = new Set();
for (const row of ledger) {
  const cand = new Map();
  for (const o of byLayer.get(row.layer_id) || []) cand.set(o.key, o);
  if (row.parquet_key) {
    const base = row.parquet_key.replace(/\.parquet$/, "");
    for (const o of objects) if (o.base === base) cand.set(o.key, o);
  }
  if (!cand.size) { sweepable.push(row); continue; }
  for (const o of cand.values()) {
    claimed.add(o.key);
    if (liveBases.has(o.base)) kept.push({ row, o });          // a live pointer copy still reads it
    else wouldDelete.push({ row, o });
  }
}

console.log(`── WOULD DELETE (${wouldDelete.length} objects · ${mb(wouldDelete.reduce((a, x) => a + x.o.size, 0))}) ──`);
for (const { row, o } of wouldDelete) console.log(`  ${o.key}  ${mb(o.size)}  (ledger #${row.id})`);
// many purged mirrors claim the SAME live source objects — print each object once, with a claim count
const keepByKey = new Map();
for (const { o } of kept) keepByKey.set(o.key, { o, n: (keepByKey.get(o.key)?.n || 0) + 1 });
console.log(`\n── KEEP — still referenced by a live layer (${keepByKey.size} objects, claimed by ${kept.length} ledger rows) ──`);
for (const { o, n } of keepByKey.values()) console.log(`  ${o.key}  ${mb(o.size)}${n > 1 ? `  (×${n} rows)` : ""}`);
console.log(`\n── MARK SWEPT — ledger rows with no R2 objects (${sweepable.length}) ──`);
for (const r of sweepable) console.log(`  ledger #${r.id}  layer ${r.layer_id.slice(0, 8)}  recorded ${mb(r.bytes)} (never baked — nothing in R2)`);

// audit: objects owned by NOBODY — no uuid in the key is a live layer, no live pointer reads the
// base, and no ledger row claimed it. (Keys carry BOTH project and layer uuids — only the layer
// uuid can vouch for the object, so require that NONE of them is a live layer id.)
const orphanObjs = objects.filter((o) => {
  if (claimed.has(o.key) || liveBases.has(o.base)) return false;
  const ids = [...o.key.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g)].map((m) => m[0]);
  return ids.length > 0 && !ids.some((id) => liveIds.has(id));
});
const uniq = orphanObjs.sort((a, b) => b.size - a.size);
console.log(`\n── AUDIT — bucket objects belonging to NO live layer and NO ledger row: ${uniq.length} · ${mb(uniq.reduce((a, o) => a + o.size, 0))} ──`);
for (const o of uniq.slice(0, 15)) console.log(`  ${o.key}  ${mb(o.size)}`);
if (uniq.length > 15) console.log(`  … and ${uniq.length - 15} more (largest 15 shown)`);

/* ── stage-2 pre-approval actions ──────────────────────────────────────────── */
const STAMP = process.argv.includes("--stamp");
const orphIdx = process.argv.indexOf("--orphans-out");
const ORPH_OUT = orphIdx > -1 ? process.argv[orphIdx + 1] : null;

if (ORPH_OUT && uniq.length) {
  // group by project uuid (the first uuid in every key) so the owner reads a few blocks, not 100+ lines
  const groups = new Map();
  for (const o of uniq) {
    const proj = (o.key.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/) || ["(no uuid)"])[0];
    if (!groups.has(proj)) groups.set(proj, []);
    groups.get(proj).push(o);
  }
  const stamp = new Date().toISOString().slice(0, 10);
  const lines = [
    `# R2 pre-ledger orphan deletion list — ${stamp}, generated by r2-sweep.mjs --orphans-out`,
    `# bucket ${BUCKET} · ${uniq.length} objects · ${mb(uniq.reduce((a, o) => a + o.size, 0))}`,
    `# NOTHING has been deleted. This file is the approval manifest: the owner reads it, says yes,`,
    `# the sweeper token gets Write, and only then does a delete pass consume exactly these keys.`,
    "",
  ];
  for (const [proj, objs] of [...groups.entries()].sort((a, b) => b[1].reduce((s, o) => s + o.size, 0) - a[1].reduce((s, o) => s + o.size, 0))) {
    lines.push(`## project ${proj} — ${objs.length} objects · ${mb(objs.reduce((s, o) => s + o.size, 0))}`);
    for (const o of objs.sort((a, b) => b.size - a.size)) lines.push(`${o.key}\t${o.size}`);
    lines.push("");
  }
  fs.writeFileSync(ORPH_OUT, lines.join("\n"));
  console.log(`\norphan manifest written: ${ORPH_OUT} (${uniq.length} keys)`);
}

if (STAMP && sweepable.length) {
  // MARK-SWEPT rows have no R2 objects at all — swept_at here is bookkeeping, not deletion
  const ids = sweepable.map((r) => r.id).join(",");
  const r = await fetch(`${SB_URL}/rest/v1/ms_deleted_artifacts?id=in.(${ids})&swept_at=is.null`, {
    method: "PATCH",
    headers: { apikey: SVC, Authorization: "Bearer " + SVC, "Content-Type": "application/json", Prefer: "return=representation" },
    body: JSON.stringify({ swept_at: new Date().toISOString() }),
  });
  const rows = await r.json();
  if (!r.ok) throw new Error(`stamp failed HTTP ${r.status}: ${JSON.stringify(rows).slice(0, 200)}`);
  console.log(`\nSTAMPED swept_at on ${rows.length} never-baked ledger row(s).`);
} else if (STAMP) {
  console.log(`\n--stamp: no MARK-SWEPT rows to stamp.`);
}

/* ── the delete pass (owner-approved manifest only) ────────────────────────── */
const appIdx = process.argv.indexOf("--apply-orphans");
const APPLY = appIdx > -1 ? process.argv[appIdx + 1] : null;
if (APPLY) {
  const man = fs.readFileSync(APPLY, "utf8").split("\n").filter((l) => l.includes("\t")).map((l) => l.split("\t")[0]);
  const cur = new Set(uniq.map((o) => o.key));
  const doomed = man.filter((k) => cur.has(k));
  const drifted = man.filter((k) => !cur.has(k));
  if (drifted.length) console.log(`\ndrift protection — ${drifted.length} manifest key(s) no longer classify as orphan, SKIPPED:\n  ` + drifted.join("\n  "));
  const sizes = new Map(uniq.map((o) => [o.key, o.size]));
  console.log(`\nAPPLY: deleting ${doomed.length} approved orphan object(s) · ${mb(doomed.reduce((a, k) => a + (sizes.get(k) || 0), 0))}…`);
  let ok = 0, freed = 0;
  for (const k of doomed) {
    const r = await s3req("DELETE", k);
    if (r.ok || r.status === 204) { ok++; freed += sizes.get(k) || 0; continue; }
    const body = await r.text();
    console.error(`  FAILED HTTP ${r.status} on ${k}${r.status === 403 || r.status === 401 ? " — the sweeper token has no Write yet; flip it to Object Read & Write and re-run" : ""}: ${body.slice(0, 160)}`);
    if (r.status === 401 || r.status === 403) { console.error(`aborting — ${ok} deleted before the permission error.`); process.exit(1); }
  }
  console.log(`deleted ${ok}/${doomed.length} · ${mb(freed)} freed`);
  const after = [];
  for (const p of ["tiles/", "sidecars/", "geoparquet/"]) after.push(...await listAll(p));
  const afterKeys = new Set(after.map((o) => o.key));
  const remain = doomed.filter((k) => afterKeys.has(k));
  if (remain.length) { console.error(`VERIFY FAIL — ${remain.length} approved key(s) still present:\n  ` + remain.join("\n  ")); process.exit(1); }
  console.log(`VERIFY: all ${doomed.length} gone. Bucket now ${after.length} objects · ${mb(after.reduce((a, o) => a + o.size, 0))}.`);
}

console.log(`\n${APPLY ? "Delete pass done — only manifest-approved keys were touched." : (STAMP ? "Stamping aside, nothing was deleted." : "DRY RUN — nothing was deleted, nothing was stamped.")}`);
