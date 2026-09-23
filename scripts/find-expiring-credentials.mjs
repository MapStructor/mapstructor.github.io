#!/usr/bin/env node
/**
 * find-expiring-credentials.mjs — every credential that dies on a date, and how long it has.
 *
 * WHY THIS EXISTS (bug family C: hidden cliffs, the credential kind)
 * -----------------------------------------------------------------
 * On 2026-08-29 the GitHub dispatch token expired. Nothing crashed, nothing paged anyone, and no
 * report went red — the import pipeline's own fallback caught the failure and quietly took the
 * expensive path instead, bulk-inserting rows into Postgres rather than folding to R2. It ran that
 * way for ELEVEN DAYS before a test built for an unrelated reason happened to dispatch the Worker
 * and read the real response: "401 Bad credentials".
 *
 * The expiry date was not hidden. It was written, in plain text, in the same file as the token —
 * `secrets/github.md`, "expires 2026-08-29". Nobody read it, because nothing ever read it.
 *
 * A date sitting in a markdown file is a limit like any other: crossing it changes what the system
 * does, with no signal. `find-cliffs.mjs` watches that shape in CODE (a slice, a retry cap, a
 * render limit); this watches it in CREDENTIALS, which code-shaped detectors cannot see.
 *
 *   node scripts/find-expiring-credentials.mjs            list every credential and its runway
 *   node scripts/find-expiring-credentials.mjs --gate     fail if any is expired or due within 21 days
 *   node scripts/find-expiring-credentials.mjs --days 45  use a different warning window
 *
 * It reads ONLY the date lines. No token value is printed, logged, or returned — a detector that
 * spills the secret it guards is worse than no detector.
 */
import fs from "node:fs";
import path from "node:path";

const DIR = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "secrets");
const GATE = process.argv.includes("--gate");
const DAYS = (() => { const i = process.argv.indexOf("--days"); return i > -1 ? Number(process.argv[i + 1]) : 21; })();

/* "expires 2026-09-25", "EXPIRES ~2026-09-13", "expiry 2026-09-13", "valid to 2041".
   Deliberately loose on the verb and tolerant of a leading ~, because these lines are written by
   hand and a detector that only matches one phrasing silently stops covering the file that drifts. */
const DATE = /\b(?:expir\w*|valid\s+(?:to|until))\b[^0-9\n]{0,24}~?(\d{4})-(\d{2})-(\d{2})/gi;
/* a bare year, as in "valid to 2041" — treated as 1 Jan of that year, which is the pessimistic read */
const YEAR_ONLY = /\b(?:expir\w*|valid\s+(?:to|until))\b[^0-9\n]{0,24}(\d{4})(?![-\d])/gi;

const today = new Date(); today.setHours(0, 0, 0, 0);
const dayMs = 864e5;
const found = [];

for (const f of fs.readdirSync(DIR).filter((n) => n.endsWith(".md"))) {
  const text = fs.readFileSync(path.join(DIR, f), "utf8");
  text.split(/\r?\n/).forEach((line, i) => {
    /* skip lines that are clearly ABOUT a past expiry rather than declaring a live one — the
       github file narrates the 8/29 failure in prose, and flagging that forever is noise */
    if (/previous token|expired \d{4}-\d{2}-\d{2} silently|no alerting exists/i.test(line)) return;
    let m, hit = null;
    DATE.lastIndex = 0;
    if ((m = DATE.exec(line))) hit = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    else { YEAR_ONLY.lastIndex = 0; if ((m = YEAR_ONLY.exec(line))) hit = new Date(Date.UTC(+m[1], 0, 1)); }
    if (!hit || isNaN(hit)) return;
    found.push({ file: f, line: i + 1, when: hit, days: Math.round((hit - today) / dayMs),
      what: line.replace(/\b(?:gh[pous]_|sbp_|sb_secret_|dop_v1_|github_pat_)[A-Za-z0-9_-]+/g, "<token>").trim().slice(0, 100) });
  });
}

found.sort((a, b) => a.days - b.days);
const stamp = (d) => d.toISOString().slice(0, 10);
const dead = found.filter((c) => c.days < 0);
const soon = found.filter((c) => c.days >= 0 && c.days <= DAYS);

console.log(`${found.length} credential expiry date(s) across ${new Set(found.map((f) => f.file)).size} file(s)\n`);
for (const c of found) {
  const tag = c.days < 0 ? `EXPIRED ${-c.days}d ago` : c.days <= DAYS ? `${c.days}d left` : `${c.days}d`;
  console.log(`  ${tag.padEnd(18)} ${stamp(c.when)}  ${c.file}:${c.line}`);
  console.log(`  ${" ".repeat(18)} ${c.what}`);
}

if (GATE) {
  if (dead.length || soon.length) {
    console.log(`\nFAIL — ${dead.length} expired, ${soon.length} due within ${DAYS} days.`);
    console.log(`An expired credential does not announce itself: the GitHub token died 2026-08-29`);
    console.log(`and every oversized import bulk-inserted for 11 days before anyone noticed.`);
    process.exit(1);
  }
  console.log(`\nPASS — nothing expired, nothing due within ${DAYS} days.`);
}
