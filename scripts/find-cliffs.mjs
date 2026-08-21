#!/usr/bin/env node
/**
 * find-cliffs.mjs — every hard numeric limit that changes what a person gets, without saying so.
 *
 * WHY THIS EXISTS (bug family C: "hidden cliffs")
 * ----------------------------------------------
 * The codebase is full of numbers that silently decide outcomes: a `.slice(0, 500)` that drops the
 * 501st row, a retry loop that gives up after 40 tries, a cap that renders 1,500 features and not
 * the rest. None of them are wrong. What is wrong is that crossing one produces a *different
 * result with no signal* — the map just quietly has less in it, and the person cannot tell whether
 * they are looking at their data or at the limit.
 *
 * `MSGuard.cliff(key, value, limit, whatHappens)` fixes each one by announcing exactly once when
 * the limit is crossed. This script finds the ones that still need it, so the work comes from a
 * detector rather than from a list I wrote by hand and then followed for six hours — a list is a
 * stored copy of a judgment, and it goes stale the moment the code moves.
 *
 *   node scripts/find-cliffs.mjs              ranked, grouped by file
 *   node scripts/find-cliffs.mjs --count      just the totals, for tracking
 *   node scripts/find-cliffs.mjs --kind trunc only one kind
 *
 * A limit counts as ALREADY HANDLED if a `cliff(` call appears within 3 lines. That is deliberately
 * loose: the point is to find the ones nobody has looked at, not to police placement.
 */

import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ONLY = args.includes("--kind") ? args[args.indexOf("--kind") + 1] : null;
const COUNT_ONLY = args.includes("--count");

/* Ranked by how much a person loses when the limit bites, worst first. Truncation is top because
   it silently changes the ANSWER; a timeout only changes how long they wait for it. */
const KINDS = [
  { kind: "trunc", rank: 1, what: "drops data past a cap — the answer itself changes",
    re: /\.slice\(\s*0\s*,\s*(\d{2,})\s*\)|\.limit\(\s*(\d{2,})\s*\)|\blimit=(\d{2,})\b|\bLIMIT\s+(\d{2,})\b/g },
  /* Slicing a STRING is formatting, not truncation: `String(d).slice(0, 10)` is "take the date
     part", and nothing is lost. Only a collection can have a 501st row that never arrives. The
     first run of this detector returned 44 truncations of which most were ISO-date formatting —
     a detector that cries wolf gets ignored, which makes it worse than none. */

  { kind: "cap", rank: 2, what: "branches to a different code path at a threshold",
    re: /(?:>=?|<=?)\s*(\d{3,})\b|\bMath\.min\(\s*[^,]{1,40},\s*(\d{3,})\s*\)/g },
  /* `tries`-shaped names only. The first version also matched a bare `t`, which caught the lerp
     parameter in the label-anchor maths — `if (t > 1)` is geometry, not a retry budget. */
  { kind: "giveup", rank: 3, what: "stops retrying and leaves the surface unfinished",
    re: /\b(?:tries|attempts|_tries|retry|retries|_?count|iter)\s*(?:>|>=)\s*(\d{1,3})\b/g },
  { kind: "wait", rank: 4, what: "a blind wait — right until the machine is slower than mine",
    re: /setTimeout\([^,]{1,60},\s*(\d{4,})\s*\)/g }
];

/* A comparison against a number is only a CLIFF if crossing it changes what the person gets. These
   contexts are comparisons about something else entirely: the viewport (a responsive breakpoint),
   a calendar year, or a unit conversion. Excluding them took the cap list from 26 to the handful
   that are real — precision is what makes a detector worth running twice. */
const NOT_A_CAP = /innerWidth|innerHeight|windoWidth|clientWidth|clientHeight|offsetWidth|offsetHeight|matchMedia|screen\.|\bzoom\b|FullYear|\byear\b|\byrs?\b|\bY\b\s*[<>=]|1024|Date\.now\(\)|\.getTime\(\)/i;

/* Numbers that are never limits: years, ports, HTTP status, colour/geometry maths, epoch maths. */
const NOT_A_LIMIT = new Set([
  1048576, 1073741824, 9999, 99999999, 99990101,
  100, 200, 201, 204, 206, 301, 302, 304, 400, 401, 403, 404, 409, 422, 429, 500, 502, 503,
  180, 360, 255, 256, 512, 1024, 2048, 4096, 8192, 60, 24, 365, 1000, 3600,
  1970, 2000, 2020, 2024, 2025, 2026
]);

/* Is this `.slice(0, N)` slicing a string rather than a collection? Look at what sits immediately
   to its left: a String(...) wrapper, a quoted literal, a .replace/.trim/.toISOString chain, or a
   name that reads like text. Collections are what matter — `rows`, `feats`, `keys`, `data`. */
const STRINGY = /(?:String\([^()]*\)|toISOString\(\)|\.replace\([^()]*\)|\.trim\(\)|\.toUpperCase\(\)|\.toLowerCase\(\)|['"`][^'"`]*['"`]|\b\w*(?:name|label|text|title|msg|message|str|sql|url|id|desc|note|line|json|css|html)\w*)\s*$/i;
function isStringSlice(code, at) {
  return STRINGY.test(code.slice(0, at));
}

const files = execSync("git ls-files platform/*.js map/engine/*.js", { cwd: ROOT, encoding: "utf8" })
  .split("\n").map((s) => s.trim()).filter(Boolean);

const hits = [];
for (const rel of files) {
  const lines = readFileSync(join(ROOT, rel), "utf8").split(/\r?\n/);
  lines.forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, "");                  // a limit in a comment is prose
    if (/^\s*(\*|\/\*)/.test(line)) return;
    /* Markup built as a string, and ISO-date parsing, are not data limits — a `maxlength='80'` in
       an input and a `.slice(0, 10)` on "2026-08-21" both produced false positives that would have
       made this list not worth reading twice. */
    if (/maxlength|placeholder|<textarea|<input|<div|<label/i.test(code)) return;
    if (/\\d\{4\}-\\d\{2\}|\d{4}-\d{2}-\d{2}/.test(code)) return;
    for (const K of KINDS) {
      if (ONLY && K.kind !== ONLY) continue;
      K.re.lastIndex = 0;
      let m;
      while ((m = K.re.exec(code))) {
        const n = Number(m.slice(1).find((g) => g !== undefined));
        if (!Number.isFinite(n) || NOT_A_LIMIT.has(n)) continue;
        if (K.kind === "trunc" && isStringSlice(code, m.index)) continue;
        if (K.kind === "cap" && NOT_A_CAP.test(code)) continue;
        /* Already announced? Look 6 lines either side — loose on purpose, and widened from 3 once
           a cliff I had just added sat 4 lines from its limit and got re-reported as unhandled. */
        const near = lines.slice(Math.max(0, i - 6), i + 7).join("\n");
        /* `cliff-ok` in a comment on the line means "looked at, deliberately silent" — a format
           branch that is correct either way, or a limit so far above any real value that
           announcing it would be noise. Triaging has to be recordable in the CODE, or the same
           lines come back every run and the list stops converging. */
        if (/\bcliff\(/.test(near) || /cliff-ok/.test(line)) continue;
        hits.push({ rel, line: i + 1, kind: K.kind, rank: K.rank, n, text: line.trim().slice(0, 110) });
      }
    }
  });
}

/* One line can match two kinds (a slice inside an if). Keep the worst-ranked one only, so the
   count is a count of PLACES TO FIX, not of regex matches — a number that overstates the work is
   as useless as one that understates it. */
const byPlace = new Map();
for (const h of hits) {
  const k = h.rel + ":" + h.line;
  if (!byPlace.has(k) || byPlace.get(k).rank > h.rank) byPlace.set(k, h);
}
const uniq = [...byPlace.values()].sort((a, b) => a.rank - b.rank || a.rel.localeCompare(b.rel) || a.line - b.line);

const wired = files.reduce((n, rel) =>
  n + (readFileSync(join(ROOT, rel), "utf8").match(/\bcliff\(/g) || []).length, 0);

const tally = KINDS.map((K) => `${K.kind} ${uniq.filter((h) => h.kind === K.kind).length}`).join(" · ");
console.log(`${uniq.length} unannounced limit(s) in ${files.length} files  ·  ${tally}  ·  ${wired} already wired`);

/* --gate. Worth having only because the count reached zero on 8/21: every hard limit in platform/
   and map/engine/ either announces when it is crossed, or carries a `cliff-ok` saying why it is
   deliberately silent. The rule this enforces is not "no limits" — it is "no limit changes what a
   person gets without anyone having decided that is fine". */
if (process.argv.includes("--gate")) {
  if (uniq.length) {
    console.log(`FAIL — ${uniq.length} hard limit(s) change behaviour with no MSGuard.cliff and no cliff-ok note`);
    uniq.slice(0, 20).forEach((h) => console.log(`         ${h.rel}:${h.line}  [${h.n}]  ${h.kind}`));
    process.exit(1);
  }
  console.log("PASS — every hard limit either announces or says why it does not");
  process.exit(0);
}
if (COUNT_ONLY) process.exit(0);

let lastFile = "", lastKind = "";
for (const h of uniq) {
  if (h.kind !== lastKind) {
    const K = KINDS.find((k) => k.kind === h.kind);
    console.log(`\n── ${h.kind.toUpperCase()} — ${K.what}`);
    lastKind = h.kind; lastFile = "";
  }
  if (h.rel !== lastFile) { console.log(`  ${h.rel}`); lastFile = h.rel; }
  console.log(`    ${String(h.line).padStart(5)}  [${h.n}]  ${h.text}`);
}
