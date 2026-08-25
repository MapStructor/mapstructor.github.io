#!/usr/bin/env node
/**
 * find-swallowed.mjs — the catches that eat something that mattered.
 *
 * WHY THIS EXISTS (bug family B: "absence treated as a benign default")
 * --------------------------------------------------------------------
 * There are ~550 empty `catch (e) {}` blocks in `platform/`. Almost all of them are right: this
 * codebase talks to a map object that legitimately may not have a layer yet, and wrapping those
 * lookups is how it stays alive through a basemap switch. A blanket "empty catch is bad" rule
 * would flag 550 places, be ignored, and take the useful signal with it.
 *
 * So this ranks them by WHAT IS INSIDE THE TRY, because that is what decides the cost:
 *
 *   WRITE   — a database call (`.insert/.update/.delete/.upsert/.rpc/saveGuard/fetch`). Swallowing
 *             this means the person's change did not save and the screen says it did. This is the
 *             exact shape MSGuard was built for and it should be a very short list.
 *   PARSE   — JSON.parse / Number / new Date on real input. Swallowing turns bad data into a
 *             default, so the map draws something plausible and wrong.
 *   PROMISE — `.catch(() => {})` / `.catch(function(){})` on an await-less call: a whole async
 *             chain can fail with nothing to show for it.
 *   LOOKUP  — getLayer / getSource / querySelector / getElementById. Overwhelmingly correct here;
 *             counted, never listed, so the number stays honest without drowning the report.
 *
 *   node scripts/find-swallowed.mjs           the first three classes, worst first
 *   node scripts/find-swallowed.mjs --count   totals only
 *   node scripts/find-swallowed.mjs --all     include LOOKUP
 *
 * `swallow-ok` in a comment inside the catch, or on the try line, marks one as considered.
 */

import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const COUNT_ONLY = process.argv.includes("--count");
const SHOW_ALL = process.argv.includes("--all");

const CLASSES = [
  /* Must be a call that leaves the browser. Matching a bare `.delete(` swept in every
     `draw.delete(drawId)` — MapboxDraw's local, in-memory removal, which cannot fail the way a
     save can — and those alone were most of the first WRITE list. The word is the same; the
     consequence is not. */
  { kind: "WRITE", rank: 1, what: "a save that failed, and the screen said it worked",
    re: /\bdb\s*\.\s*(?:from\s*\([^)]*\)\s*\.\s*(?:insert|update|delete|upsert)|rpc)\s*\(|saveSoft\s*\(|\bfetch\s*\([^)]*(?:method|PUT|POST|DELETE)/ },
  { kind: "PARSE", rank: 2, what: "bad input became a default, and the map drew something plausible",
    re: /JSON\.parse\s*\(|\bnew Date\s*\(|\bparseFloat\s*\(|\bNumber\s*\(/ },
  { kind: "PROMISE", rank: 3, what: "an async chain failed with nothing to show for it",
    re: /\.catch\s*\(\s*(?:function\s*\([^)]*\)\s*\{\s*\}|\([^)]*\)\s*=>\s*\{?\s*\}?|\(\s*\)\s*=>\s*(?:null|undefined|\{\s*\}))\s*\)/ },
  { kind: "LOOKUP", rank: 4, what: "a map/DOM lookup that legitimately may not be there",
    re: /getLayer|getSource|querySelector|getElementById|getStyle|closest\(/ }
];

/* BLANK — the same family from the other side: a value that is present but says nothing.
   On 8/21 one click on the public viewer opened FOUR popups: the real label plus three 20×24 boxes
   containing `<div class="…"> </div>`. Every guard in the code tested `String(val) !== ""`, and a
   label that is a single SPACE passes that — so it counted as having a label and got a bubble with
   nothing in it. Every popup site looked correct; only dumping the rendered HTML found it.
   This finds presence tests that whitespace defeats. It is deliberately narrow: only comparisons
   against an empty string, and only where the value is not already trimmed. */
const BLANK_RE = /(?<![.\w])(?:String\([^()]*\)|\b[\w.$\[\]]+)\s*(?:!==|===|!=|==)\s*(?:""|'')/g;
const BLANK_OK = /\.trim\(\)|trimmed|\.length|swallow-ok|blank-ok/;

/* An empty catch, or one whose whole body is a console call — same thing from the user's side. */
const EMPTY_CATCH = /catch\s*\((\w+)?\)?\s*\{\s*(?:\/\*[^*]*\*\/\s*)?\}|catch\s*\(\w*\)\s*\{\s*console\.\w+\([^;]*\);?\s*\}/g;

/* vendor/ is excluded IN JS, not via a `:!` pathspec — cmd.exe mangles the quoting and git then
   dies on a literal `':!platform'` path. 5 of the PARSE class's 20 hits were minified duckdb
   worker internals: not ours to annotate, and noise that buries the real 15 (8/25 sweep). */
const files = execSync("git ls-files platform/*.js map/engine/*.js", { cwd: ROOT, encoding: "utf8" })
  .split("\n").map((s) => s.trim()).filter(Boolean)
  .filter((f) => !f.includes("/vendor/"));

/* Walk backwards from the `catch` to the matching `try {`, so the classification looks at the code
   that was actually protected rather than at whatever happens to be on the same line. */
function tryBodyBefore(src, catchAt) {
  let i = src.lastIndexOf("}", catchAt);
  if (i < 0) return "";
  let d = 1, j = i - 1;
  while (j >= 0 && d > 0) {
    if (src[j] === "}") d++;
    else if (src[j] === "{") d--;
    j--;
  }
  return d === 0 ? src.slice(j + 1, i) : "";
}

const hits = [];
for (const rel of files) {
  const src = readFileSync(join(ROOT, rel), "utf8");
  EMPTY_CATCH.lastIndex = 0;
  let m;
  while ((m = EMPTY_CATCH.exec(src))) {
    const body = tryBodyBefore(src, m.index);
    if (!body) continue;
    const line = src.slice(0, m.index).split("\n").length;
    const near = src.slice(Math.max(0, m.index - 400), m.index + 200);
    if (/swallow-ok/.test(near)) continue;
    /* Already reported by MSGuard inside the try? Then the catch is not swallowing anything — the
       failure has already been announced and this is just belt-and-braces. Counting those as
       WRITEs would pad the list with the very places that are done properly. */
    if (/saveGuard\s*\(|saveSoft\s*\(|MSGuard\./.test(body)) continue;
    const cls = CLASSES.find((c) => c.re.test(body)) || CLASSES[3];
    hits.push({ rel, line, kind: cls.kind, rank: cls.rank,
                text: body.replace(/\s+/g, " ").trim().slice(0, 104) });
  }
  /* Presence tests that whitespace defeats — see BLANK_RE. */
  src.split(/\r?\n/).forEach((l, i) => {
    if (/^\s*(\*|\/\/)/.test(l) || BLANK_OK.test(l)) return;
    BLANK_RE.lastIndex = 0;
    if (BLANK_RE.test(l)) hits.push({ rel, line: i + 1, kind: "BLANK", rank: 2, text: l.trim().slice(0, 104) });
  });

  /* Bare .catch(noop) is its own shape and never has a try block to inspect. */
  const P = CLASSES[2].re;
  src.split(/\r?\n/).forEach((l, i) => {
    if (/^\s*(\*|\/\/)/.test(l) || /swallow-ok/.test(l)) return;
    /* Same exemption the try-block scan applies, and it has to be repeated here because this pass
       walks lines rather than blocks: a line that already reports through saveGuard/saveSoft/MSGuard
       is one of the places done PROPERLY, and counting it pads the list with its own good examples. */
    if (/saveGuard\s*\(|saveSoft\s*\(|MSGuard\./.test(l)) return;
    P.lastIndex = 0;
    if (P.test(l)) hits.push({ rel, line: i + 1, kind: "PROMISE", rank: 3, text: l.trim().slice(0, 104) });
  });
}

CLASSES.push({ kind: "BLANK", rank: 2, what: "a presence test that whitespace defeats: a single space counts as a value" });
const by = (k) => hits.filter((h) => h.kind === k);
console.log(`${hits.length} swallowed failure(s)  ·  ` +
  CLASSES.map((c) => `${c.kind} ${by(c.kind).length}`).join(" · "));
if (COUNT_ONLY) process.exit(0);

for (const c of CLASSES) {
  if (c.kind === "LOOKUP" && !SHOW_ALL) continue;
  const list = by(c.kind);
  if (!list.length) continue;
  console.log(`\n── ${c.kind} — ${c.what}`);
  let last = "";
  for (const h of list.sort((a, b) => a.rel.localeCompare(b.rel) || a.line - b.line)) {
    if (h.rel !== last) { console.log(`  ${h.rel}`); last = h.rel; }
    console.log(`    ${String(h.line).padStart(5)}  ${h.text}`);
  }
}
if (!SHOW_ALL) console.log(`\n(${by("LOOKUP").length} LOOKUP catches not listed — mostly correct here. --all to see them.)`);
