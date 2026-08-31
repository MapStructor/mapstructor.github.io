/* breakin.mjs — the ONE COMMAND for a suspected break-in (A27). Runbook: process/break-in.md
 *
 *   node scripts/breakin.mjs on  ["what you saw"]   → snapshot evidence, flip break-in mode,
 *                                                     sign everyone out, verify the block holds
 *   node scripts/breakin.mjs thaw                    → turn it off (service key — no browser can)
 *   node scripts/breakin.mjs status                  → where things stand
 *
 * ORDER MATTERS AND THE SCRIPT ENFORCES IT: evidence is saved BEFORE anything flips, because the
 * response must never destroy the only record of what happened. The snapshot lands in
 * ~/Downloads/CLAUDE_OUTPUTS/breakin-<timestamp>/ — copy it somewhere safe before cleanup.
 *
 * What "on" does, in this order:
 *   0 · SNAPSHOT: every account (id, email, last sign-in), active session count, the deletion
 *       ledger, the 500 most recently touched features/layers/projects, the guard row.
 *   1 · ms_breakin_lock(): the database refuses every write AND delete to user data (trigger,
 *       not page JavaScript), and every refresh token is revoked — the thief's login dies too.
 *       Already-issued access tokens live out their remaining minutes (≤1h); nothing renews.
 *   2 · VERIFY: reads the state back and attempts a write, expecting refusal. Trust the check,
 *       not the intention.
 * Uploads 503 and maps go dark through the EXISTING enforcement (ms_service_state now reports
 * locked+frozen while breakin is set) — no separate steps to remember.
 *
 * What it does NOT do (by design): rotate keys (manual, ordered — the runbook lists the order),
 * take the site full-dark (Cloudflare/Supabase pause — manual, for confirmed active exfiltration),
 * or touch any data.
 */
import fs from "node:fs";
import path from "node:path";

const MODE = process.argv[2];
const REASON = process.argv[3] || "suspected break-in";
if (!["on", "thaw", "status"].includes(MODE || "")) {
  console.log("usage: node scripts/breakin.mjs on [\"reason\"] | thaw | status");
  process.exit(2);
}

const md = fs.readFileSync(new URL("../secrets/supabase.md", import.meta.url), "utf8");
const SB = (md.match(/https:\/\/[a-z0-9]+\.supabase\.co/) || [])[0];
const SVC = (md.match(/sb_secret_[A-Za-z0-9_\-]+/) || [])[0];
const H = { apikey: SVC, Authorization: "Bearer " + SVC, "Content-Type": "application/json" };
const rpc = async (fn, body) => {
  const r = await fetch(`${SB}/rest/v1/rpc/${fn}`, { method: "POST", headers: H, body: JSON.stringify(body || {}) });
  const t = await r.text();
  if (!r.ok) throw new Error(`${fn}: HTTP ${r.status} ${t.slice(0, 200)}`);
  try { return JSON.parse(t); } catch { return t; }
};
const get = async (pathq) => {
  const r = await fetch(`${SB}/rest/v1/${pathq}`, { headers: H });
  if (!r.ok) throw new Error(`${pathq}: HTTP ${r.status}`);
  return r.json();
};

const state = async () => {
  const s = await rpc("ms_service_state");
  return Array.isArray(s) ? s[0] : s;
};

if (MODE === "status") {
  const s = await state();
  console.log(s.breakin ? "BREAK-IN MODE IS ON" : s.locked ? "cost-freeze is on (not break-in)" : "normal operation");
  console.log("  locked:", s.locked, "· frozen:", s.frozen, "· reason:", s.reason || "—");
  process.exit(0);
}

if (MODE === "thaw") {
  await rpc("ms_breakin_thaw");
  const s = await state();
  console.log(s.breakin ? "*** STILL ON — investigate before trusting anything ***" : "break-in mode is OFF.");
  console.log("Remember: everyone (you included) must sign in again, and rotated keys must be in place first.");
  process.exit(s.breakin ? 1 : 0);
}

// ── ON ─────────────────────────────────────────────────────────────────────────────────────
// 0 · evidence FIRST
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const dir = path.join(process.env.USERPROFILE || process.env.HOME, "Downloads", "CLAUDE_OUTPUTS", "breakin-" + stamp);
fs.mkdirSync(dir, { recursive: true });
const save = (name, data) => fs.writeFileSync(path.join(dir, name), JSON.stringify(data, null, 2));
console.log("0 · saving evidence →", dir);

const users = [];
for (let page = 1; page <= 20; page++) {
  const r = await fetch(`${SB}/auth/v1/admin/users?page=${page}&per_page=200`, { headers: H });
  const j = await r.json();
  const batch = j.users || [];
  users.push(...batch.map((u) => ({ id: u.id, email: u.email, last_sign_in_at: u.last_sign_in_at, created_at: u.created_at })));
  if (batch.length < 200) break;
}
save("accounts.json", users);
console.log(`    accounts: ${users.length}`);
save("deletion-ledger.json", await get("ms_deleted_artifacts?select=*&order=deleted_at.desc&limit=1000").catch(() => "unavailable"));
save("recent-features.json", await get("features_data?select=feature_id,layer_id,updated_at&order=updated_at.desc.nullslast&limit=500").catch(() => "unavailable"));
save("recent-layers.json", await get("layers?select=id,name,user_id,updated_at&order=updated_at.desc.nullslast&limit=200").catch(() => "unavailable"));
save("recent-projects.json", await get("projects?select=id,name,user_id,updated_at&order=updated_at.desc.nullslast&limit=200").catch(() => "unavailable"));
save("guard-row.json", await get("ms_service_guard?id=eq.1").catch(() => "unavailable"));
console.log("    ledger, recent changes, guard row saved");

// 1 · flip + sign-out (one statement server-side)
console.log("1 · flipping break-in mode + revoking every session…");
await rpc("ms_breakin_lock", { p_reason: REASON });

// 2 · verify — trust the check, not the intention
const s = await state();
let writeRefused = false;
try {
  const r = await fetch(`${SB}/rest/v1/projects`, { method: "POST", headers: { ...H, Prefer: "return=minimal" }, body: JSON.stringify([{ name: "breakin-probe", user_id: users[0]?.id }]) });
  const t = await r.text();
  writeRefused = !r.ok && /service_breakin_lock/.test(t);
} catch { writeRefused = true; }
console.log(`2 · verify: breakin=${s.breakin} locked=${s.locked} frozen=${s.frozen} · write refused by DB=${writeRefused}`);
if (!s.breakin || !writeRefused) { console.log("*** VERIFY FAILED — the site is NOT protected. Investigate now. ***"); process.exit(1); }

console.log(`
BREAK-IN MODE IS ON. The site is read-only, maps are dark, everyone is signed out.
NEXT, BY HAND (the runbook is process/break-in.md):
  1. Rotate keys, most powerful first:
     a. database service key   (Supabase → Settings → API)
     b. Worker secrets         (wrangler secret put …)
     c. Stripe restricted keys (Stripe → Developers → API keys)
     d. publishable key last
  2. Copy the evidence folder somewhere safe: ${dir}
  3. Only after keys are rotated: node scripts/breakin.mjs thaw
Full dark (Cloudflare route / Supabase pause) stays manual — for confirmed, active data theft.`);
