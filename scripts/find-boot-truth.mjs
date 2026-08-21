#!/usr/bin/env node
/**
 * find-boot-truth.mjs — state decided once at boot that the rest of the session then trusts.
 *
 * WHY THIS EXISTS (bug family E: "boot-time truth")
 * ------------------------------------------------
 * This is the one family with NO instrument at all — never surveyed, so its size is unknown. Its
 * signature is the sentence "it works after a refresh", which is a bug report, not a workaround.
 *
 * Two shapes, both drawn from failures this codebase has actually had:
 *
 *   ONCE-ONLY WIRING — `if (wired) return; wired = true;`. Correct until the map's style is
 *   replaced. A basemap switch wipes every custom layer and fires `style.load`, and whatever was
 *   wired once is now wired to layers that no longer exist. The opposite mistake — re-registering
 *   on every `style.load` without a guard — stacks duplicate listeners, which is how one click
 *   came to open four popups. So a latch is only safe if something CLEARS it on `style.load`;
 *   this reports latches where nothing does.
 *
 *   DOM AS THE SOURCE OF TRUTH — reading application state back out of rendered text, e.g.
 *   `parseInt($("#date").text())`. The current date lived in a label's text content, and produced
 *   a NaN boot twice: once flagged in July, once shipped in August. A rendered element is a render
 *   TARGET; the moment it is also the source, every formatting change is a state change.
 *
 *   node scripts/find-boot-truth.mjs            grouped report
 *   node scripts/find-boot-truth.mjs --count    totals only
 *
 * `boot-ok` in a comment on or just above the line marks it as considered.
 */

import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const COUNT_ONLY = process.argv.includes("--count");

/* A latch: a flag set true exactly once to make an action idempotent. Named for what they look
   like here — _wired, _patched, _booted, wiredInteraction, _engineMapClickWired. */
const LATCH_SET = /\b(_?[A-Za-z][\w$]*(?:[Ww]ired|[Pp]atched|[Bb]ooted|[Ii]nited|[Ii]nitialised|[Ii]nitialized|[Dd]one|[Rr]eady|[Mm]ounted|[Aa]ttached|[Ll]oaded))\s*=\s*true\b/g;
/* Reading state back out of RENDERED TEXT. `.value` is deliberately not here: a form input is the
   legitimate source of truth for its own value, and including it turned a 3-hit list into a 10-hit
   list of correct code — the same over-reporting that made the first cliff detector useless.

   The lazy `[^;\n]*?` rather than `[^)]*` matters: the canonical case is `parseInt($("#date").text())`,
   whose inner call carries its own closing paren. With `[^)]*` the rule could never match the one
   example it was written from — a rule scoped so tightly it cannot fire, reporting a confident
   zero. Mutation-tested by planting exactly that line and watching it go red.

   No trailing `\b` either, and that one cost a second false zero: `text()` ends in `)`, and a word
   boundary after a close-paren followed by a comma can never match. Both mistakes had the same
   shape — a rule that reports "clean" because it is incapable of reporting anything. Test the
   pattern against the example BEFORE trusting the count. */
const DOM_TRUTH = /(?:parseInt|parseFloat|Number|moment|Date)\s*\([^;\n]*?\.(?:text\(\)|innerText|textContent)/;

const files = execSync("git ls-files platform/*.js map/engine/*.js", { cwd: ROOT, encoding: "utf8" })
  .split("\n").map((s) => s.trim()).filter(Boolean);

const latches = [], domTruth = [];
for (const rel of files) {
  const src = readFileSync(join(ROOT, rel), "utf8");
  const lines = src.split(/\r?\n/);
  /* Does ANYTHING in this file clear a latch when the style is replaced? Looked for per file
     rather than per latch, deliberately loose — the question is "did anyone think about it here",
     and a file that resets on style.load has thought about it. */
  const clearsOnStyleLoad = /style\.load/.test(src) && /\b[\w$]*(?:[Ww]ired|[Pp]atched|[Bb]ooted)[\w$]*\s*=\s*false\b/.test(src);

  lines.forEach((line, i) => {
    if (/^\s*(\*|\/\/)/.test(line)) return;
    /* ±12 lines, because the reason a latch is deliberate takes a paragraph to state and the
       paragraph belongs above the code. A two-line window meant a marker I had just written was
       invisible to the detector that asked for it — triage the instrument cannot see is not
       triage, and the list stops converging. */
    const near = lines.slice(Math.max(0, i - 12), i + 3).join("\n");
    if (/boot-ok/.test(near)) return;

    LATCH_SET.lastIndex = 0;
    let m;
    while ((m = LATCH_SET.exec(line))) {
      const name = m[1];
      /* Reported only when nothing in the file ever sets this latch back to false. A latch that is
         cleared somewhere has an owner thinking about re-wiring; one that is never cleared is a
         decision made at boot and trusted forever. */
      /* `var X = false` at the declaration is NOT a clear — every latch starts false. Only a
         RE-assignment counts. The first version matched the declaration and therefore excluded
         every latch in the codebase, reporting a confident zero. A detector that returns zero
         because its filter is wrong is the worst possible instrument: it reads as "surveyed and
         clean" when nothing was surveyed at all. */
      const n = name.replace(/\$/g, "\\$");
      const cleared = new RegExp("(?<!\\b(?:var|let|const)\\s+)\\b" + n + "\\s*=\\s*false\\b").test(src);
      if (cleared) continue;
      latches.push({ rel, line: i + 1, name, clearsOnStyleLoad, text: line.trim().slice(0, 96) });
    }
    if (DOM_TRUTH.test(line)) domTruth.push({ rel, line: i + 1, text: line.trim().slice(0, 100) });
  });
}

/* A latch in a file that never mentions style.load at all is the higher risk: nothing there has
   considered the map being rebuilt underneath it. */
const blind = latches.filter((l) => !l.clearsOnStyleLoad);
console.log(`${latches.length} never-cleared latch(es) · ${blind.length} in files with no style.load reset · ${domTruth.length} read state back out of the DOM`);
if (COUNT_ONLY) process.exit(0);

if (blind.length) {
  console.log("\n── NEVER-CLEARED LATCH — wired once; a basemap switch rebuilds the style underneath it");
  let last = "";
  for (const l of blind) {
    if (l.rel !== last) { console.log(`  ${l.rel}`); last = l.rel; }
    console.log(`    ${String(l.line).padStart(5)}  ${l.name}`);
    console.log(`           ${l.text}`);
  }
}
if (domTruth.length) {
  console.log("\n── DOM AS THE SOURCE OF TRUTH — a render target read back as state");
  let last = "";
  for (const d of domTruth) {
    if (d.rel !== last) { console.log(`  ${d.rel}`); last = d.rel; }
    console.log(`    ${String(d.line).padStart(5)}  ${d.text}`);
  }
}
