/* r2-usage.mjs — read the one meter the platform cannot see, and park it where the guard acts.
 *
 * Tiles go browser → R2 custom domain. They never touch the Worker, the database, or any of our
 * code, so nothing inside MapStructor can count them. Cloudflare's analytics is the only place
 * that number exists. This fetches it, writes it into ms_service_guard, and opens a GitHub issue
 * (which GitHub emails) once either class crosses half its ceiling.
 *
 * WHY NODE AND NOT bash+jq: the first version was a shell step and it died in 0.24s with no
 * output at all — unreproducible without another push each time. This runs identically on my
 * machine and on the runner, so it can be proven before it ships.
 *
 * Free tier: 1,000,000 class A (writes) · 10,000,000 class B (reads).
 * Class A over the ceiling stops WRITES. Class B over it FREEZES THE SITE — blocking writes would
 * not slow tile reads by a single request. The ceilings live in sql/setup/service-guard-v3.sql. */

const CF_TOKEN = process.env.CF_TOKEN;
const CF_ACCOUNT = process.env.CF_ACCOUNT;
const SB_KEY = process.env.SB_KEY;
const SB_URL = process.env.SB_URL || "https://eqpxlwbjqiwfjlsuapvu.supabase.co";
const GH_TOKEN = process.env.GH_TOKEN;
const GH_REPO = process.env.GH_REPO;
const DRY = process.env.DRY_RUN === "1";

if (!CF_TOKEN || !CF_ACCOUNT) { console.log("Cloudflare secrets not set — skipping"); process.exit(0); }
if (!SB_KEY) { console.log("Supabase key not set — skipping"); process.exit(0); }

// Cloudflare bills by operation class. Deletes are free and belong in neither list.
const CLASS_A = new Set(["PutObject", "CopyObject", "CompleteMultipartUpload", "CreateMultipartUpload",
  "UploadPart", "UploadPartCopy", "ListBuckets", "PutBucket", "ListObjects", "ListMultipartUploads",
  "ListParts", "PutBucketEncryption", "PutBucketCors", "PutBucketLifecycleConfiguration",
  "LifecycleStorageTierTransition"]);
const CLASS_B = new Set(["GetObject", "HeadObject", "HeadBucket", "UsageSummary",
  "GetBucketEncryption", "GetBucketCors", "GetBucketLifecycleConfiguration"]);

const since = new Date().toISOString().slice(0, 8) + "01";   // first of this month, UTC
const QUERY = `query($acc:String!,$since:Date!){
  viewer{ accounts(filter:{accountTag:$acc}){
    r2OperationsAdaptiveGroups(limit:10000, filter:{date_geq:$since}){
      sum{requests} dimensions{actionType} } } } }`;

const fail = (msg) => { console.error("::error::" + msg); process.exit(1); };

const cf = await fetch("https://api.cloudflare.com/client/v4/graphql", {
  method: "POST",
  headers: { Authorization: "Bearer " + CF_TOKEN, "Content-Type": "application/json" },
  body: JSON.stringify({ query: QUERY, variables: { acc: CF_ACCOUNT, since } })
}).then(r => r.json()).catch(e => ({ errors: [{ message: String(e) }] }));

if (cf.errors) fail("Cloudflare refused the query (the token most likely lacks Account Analytics: Read): "
  + JSON.stringify(cf.errors).slice(0, 300));

const rows = cf?.data?.viewer?.accounts?.[0]?.r2OperationsAdaptiveGroups || [];
let classA = 0, classB = 0, other = 0;
for (const r of rows) {
  const t = r.dimensions.actionType, n = r.sum.requests;
  if (CLASS_A.has(t)) classA += n; else if (CLASS_B.has(t)) classB += n; else other += n;
}
console.log(`since ${since} — class A: ${classA.toLocaleString()} · class B: ${classB.toLocaleString()}` +
            ` · unbilled/other: ${other.toLocaleString()}`);
rows.sort((a, b) => b.sum.requests - a.sum.requests).slice(0, 10)
  .forEach(r => console.log(`   ${r.dimensions.actionType.padEnd(24)} ${r.sum.requests.toLocaleString()}`));

// ── park the numbers where the guard can act on them (service key bypasses RLS; no new function)
if (!DRY) {
  const patch = await fetch(`${SB_URL}/rest/v1/ms_service_guard?id=eq.1`, {
    method: "PATCH",
    headers: { apikey: SB_KEY, Authorization: "Bearer " + SB_KEY,
               "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({ r2_class_a_month: classA, r2_class_b_month: classB,
                           r2_ops_period: since, r2_ops_checked: new Date().toISOString() })
  });
  if (!patch.ok) fail(`could not record the numbers: HTTP ${patch.status} ${(await patch.text()).slice(0, 200)}`);
  console.log("recorded: HTTP " + patch.status);
}

// ── read back what the guard now decides
const state = await fetch(`${SB_URL}/rest/v1/rpc/ms_service_state`, {
  method: "POST",
  headers: { apikey: SB_KEY, Authorization: "Bearer " + SB_KEY, "Content-Type": "application/json" },
  body: "{}"
}).then(r => r.json()).catch(() => null);
const S = Array.isArray(state) ? state[0] : state;
if (!S || S.r2_class_a_cap == null) fail("ms_service_state has no R2 columns — run sql/setup/service-guard-v3.sql");

const aCap = Number(S.r2_class_a_cap), bCap = Number(S.r2_class_b_cap);
const aPct = Math.round(classA * 100 / aCap), bPct = Math.round(classB * 100 / bCap);
console.log(`ceilings: A ${aPct}% of ${aCap.toLocaleString()} · B ${bPct}% of ${bCap.toLocaleString()}` +
            ` · fresh=${S.r2_ops_fresh} · locked=${S.locked} · frozen=${S.frozen}`);

if (process.env.GITHUB_STEP_SUMMARY) {
  const { appendFileSync } = await import("node:fs");
  appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `- R2 ops: writes **${classA.toLocaleString()}** (${aPct}%) · tile reads **${classB.toLocaleString()}** (${bPct}%)\n`);
}

// ── alert, so nobody has to visit a dashboard to find out
async function issue(titleMatch, title, body) {
  if (!GH_TOKEN || !GH_REPO || DRY) { console.log("(would alert: " + title + ")"); return; }
  const H = { Authorization: "Bearer " + GH_TOKEN, Accept: "application/vnd.github+json",
              "User-Agent": "r2-usage", "Content-Type": "application/json" };
  const open = await fetch(`https://api.github.com/repos/${GH_REPO}/issues?state=open&per_page=50`, { headers: H })
    .then(r => r.json()).catch(() => []);
  const hit = (Array.isArray(open) ? open : []).find(i => i.title.includes(titleMatch));
  const url = hit ? `https://api.github.com/repos/${GH_REPO}/issues/${hit.number}`
                  : `https://api.github.com/repos/${GH_REPO}/issues`;
  const r = await fetch(url, { method: hit ? "PATCH" : "POST", headers: H, body: JSON.stringify({ title, body }) });
  console.log(`${hit ? "updated" : "opened"} issue: HTTP ${r.status}`);
}

if (aPct >= 50 || bPct >= 50) {
  await issue("R2 operations at",
    `⚠ R2 operations at ${aPct}% (writes) / ${bPct}% (tile reads) of the ceiling`,
    `This month so far: **${classA.toLocaleString()}** class A operations of ${aCap.toLocaleString()}, ` +
    `and **${classB.toLocaleString()}** class B of ${bCap.toLocaleString()}. Cloudflare's free tier is ` +
    `1,000,000 and 10,000,000.\n\nRight now — writes stopped: **${S.locked}** · maps frozen: **${S.frozen}**\n\n` +
    `Class A over the ceiling stops writes. Class B over it freezes the site, because blocking writes ` +
    `would not slow tile reads at all. Adjust with \`select public.ms_service_set_r2_op_caps(a, b);\`\n\n` +
    `(Automated daily check: .github/workflows/r2-usage.yml → scripts/r2-usage.mjs)`);
} else {
  console.log("both well under the ceilings — no alert");
}

// ── a meter that silently stops measuring is the dangerous failure: it looks like zero usage
if (S.r2_ops_fresh === false) {
  await issue("R2 usage meter has gone stale", "⚠ R2 usage meter has gone stale",
    "`r2_ops_fresh` is false — the R2 operations feed has not updated in over 3 days.\n\n" +
    "The guard deliberately treats a stale meter as UNKNOWN rather than as zero, so it will not " +
    "freeze anything on old numbers. But tile reads are currently unwatched. Check the " +
    "CLOUDFLARE_API_TOKEN secret and this workflow's last run.");
}
