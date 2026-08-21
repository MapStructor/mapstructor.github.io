#!/usr/bin/env node
/**
 * find-twins.mjs — the same logic living in two places, where it can drift apart.
 *
 * WHY THIS EXISTS (bug family D: "two owners of one rule")
 * -------------------------------------------------------
 * Twice in one afternoon I found a rule implemented twice by accident, not by looking for it:
 *   - `layerKeys()` is byte-identical in queryWindow.js and tables.js — including the 40-row
 *     sample cap that silently hides any column first appearing on feature 41.
 *   - `styleCatsFor()` is mirrored between editing.js and viewerTable.js, cap and all.
 * Both were found by tripping over them. Neither would have been found by reading, because the
 * two copies are a thousand lines apart in different files and each one looks right on its own.
 *
 * A twin is not automatically a bug. It becomes one the moment someone fixes a limit, a filter or
 * an off-by-one in one copy and not the other — and nothing anywhere says the other copy exists.
 * That is family D, and unlike the interaction wiring it is cheap to survey.
 *
 * Three signals, cheapest and most certain first:
 *   1. IDENTICAL   — same normalised body in two places. A change to one is a bug in the other.
 *   2. SAME NAME   — same function name in two files with different bodies. Either an intentional
 *                    per-surface variant (fine, and worth a comment) or a copy that has ALREADY
 *                    drifted — which is the failure this whole family is about.
 *   3. NEAR        — same name, same shape, bodies differing only slightly.
 *
 *   node scripts/find-twins.mjs            grouped report
 *   node scripts/find-twins.mjs --count    totals only
 *
 * `twin-ok` in a comment inside either body marks the pair as deliberate, so triage is recorded in
 * the code and the list converges instead of re-reporting forever.
 */

import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const COUNT_ONLY = process.argv.includes("--count");
/* Two thresholds, because the two signals have different confidence. An EXACT body match is strong
   evidence at any length, so it needs only 2 lines; "same name, different body" needs more bulk
   before it means anything. The single 4-line threshold hid the pair that mattered most:
   `editorCurrentDate` and `currentMapDate` are byte-identical 3-line bodies ten thousand lines
   apart in ONE file — two names for one rule, which the detector could not see. */
const MIN_IDENTICAL = 2;
const MIN_LINES = 4;

const files = execSync("git ls-files platform/*.js map/engine/*.js scripts/*.mjs", { cwd: ROOT, encoding: "utf8" })
  .split("\n").map((s) => s.trim()).filter(Boolean);

/* Brace-matching from the opening `{`, skipping strings, template literals, regexes and comments.
   Crude compared to a parser, and enough: this is a survey, and anything it mis-parses simply
   fails to produce a twin rather than producing a wrong one. */
function bodyAt(src, open) {
  let d = 0, i = open;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      const q = c; i++;
      while (i < src.length && src[i] !== q) { if (src[i] === "\\") i++; i++; }
    } else if (c === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") i++; }
    else if (c === "/" && src[i + 1] === "*") { i = src.indexOf("*/", i); if (i < 0) return null; i++; }
    else if (c === "{") d++;
    else if (c === "}") { d--; if (!d) return src.slice(open, i + 1); }
    i++;
  }
  return null;
}

const FN = /(?:^|\n)\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/g;
const fns = [];
for (const rel of files) {
  const src = readFileSync(join(ROOT, rel), "utf8");
  FN.lastIndex = 0;
  let m;
  while ((m = FN.exec(src))) {
    const open = src.indexOf("{", m.index + m[0].length - 1);
    const body = bodyAt(src, open);
    if (!body) continue;
    const lines = body.split("\n").length;
    if (lines < MIN_IDENTICAL) continue;
    /* Normalise away everything that is not the logic: comments, whitespace, quote style. Keeps
       identifiers, so two functions differing only in variable names are NOT called identical —
       that would over-report, and this list has to be believable to be used. */
    const norm = body
      .replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ")
      .replace(/'/g, '"').replace(/\s+/g, " ").trim();
    /* The marker is looked for in the body AND in the eight lines above it, because the natural
       place to explain why two functions are deliberately different is the comment block over the
       declaration — not buried inside. A marker the detector cannot see is not triage. */
    const preamble = src.slice(Math.max(0, m.index - 900), m.index);
    fns.push({ rel, name: m[1], line: src.slice(0, m.index).split("\n").length + 1,
               lines, norm, hash: createHash("sha1").update(norm).digest("hex").slice(0, 12),
               ok: /twin-ok/.test(body) || /twin-ok/.test(preamble.split("\n").slice(-8).join("\n")) });
  }
}

/* SHADOWED GLOBALS — the sharpest version of this whole family.
   The engine files are plain script-scope: `map/engine/*.js` all declare their functions as
   globals, every page loads all of them in a fixed order, and a later file's declaration silently
   OVERWRITES an earlier one. So two engine files declaring the same name means one of them has
   never run — dead code that looks completely live, and editing it does nothing at all.
   Found exactly one on 8/21: `simple_tooltip` in both utils.js and index.js, differing by a single
   trailing comma. Nothing was lost functionally; what was at stake was the hour someone would
   spend changing a copy that could not possibly take effect. Zero remain, and this keeps it so. */
const TOP_LEVEL_FN = /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm;
const globalsByName = new Map();
for (const rel of files.filter((f) => f.startsWith("map/engine/"))) {
  const src = readFileSync(join(ROOT, rel), "utf8");
  TOP_LEVEL_FN.lastIndex = 0;
  let g;
  while ((g = TOP_LEVEL_FN.exec(src))) {
    const set = globalsByName.get(g[1]) || globalsByName.set(g[1], new Set()).get(g[1]);
    set.add(rel);
  }
}
const shadowed = [...globalsByName.entries()].filter(([, s]) => s.size > 1);

const byHash = new Map(), byName = new Map();
for (const f of fns) {
  (byHash.get(f.hash) || byHash.set(f.hash, []).get(f.hash)).push(f);
  (byName.get(f.name) || byName.set(f.name, []).get(f.name)).push(f);
}

const identical = [...byHash.values()].filter((g) => g.length > 1 && new Set(g.map((f) => f.rel + f.line)).size > 1);
// same-name needs more bulk than an exact match before it means anything
const bulky = (g) => g.every((f) => f.lines >= MIN_LINES);
const identicalKeys = new Set(identical.flat().map((f) => f.rel + ":" + f.line));
/* Bulk is the wrong confidence signal for a SHORT pair, and using it as the only one hid the most
   expensive bug of 8/21: `opKeyFor` is a one-liner mirrored between editing.js and viewerTable.js,
   the two copies had drifted to different fallbacks, and nine layers got a different paint property
   in the editor than in the viewer. One line, invisible to a 4-line floor.
   Similarity is the right signal there — but short bodies have few tokens, so two unrelated
   one-liners can score high by accident. Hence a stricter bar for shorts: high overlap AND enough
   distinct tokens for the overlap to mean something. */
const SHORT_SIM = 0.75, SHORT_MIN_TOKENS = 8;
const shortButAlike = (g) => {
  const t = (f) => new Set((f.norm.toLowerCase().match(/[a-z_$][\w$]*|\d+|[^\s\w]/g) || []));
  for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) {
    const A = t(g[i]), B = t(g[j]);
    if (A.size < SHORT_MIN_TOKENS || B.size < SHORT_MIN_TOKENS) continue;
    let inter = 0; for (const x of A) if (B.has(x)) inter++;
    if (inter / (A.size + B.size - inter) >= SHORT_SIM) return true;
  }
  return false;
};
const sameName = [...byName.values()].filter((g) =>
  g.length > 1 && (bulky(g) || shortButAlike(g)) && new Set(g.map((f) => f.rel)).size > 1 && !g.every((f) => identicalKeys.has(f.rel + ":" + f.line)));

const live = (gs) => gs.filter((g) => !g.some((f) => f.ok));
const idLive = live(identical), snLive = live(sameName);

console.log(`${fns.length} named functions scanned  ·  ${shadowed.length} shadowed engine global(s)  ·  ${idLive.length} identical twin group(s)  ·  ${snLive.length} same-name-different-body group(s)  ·  ${identical.length - idLive.length + sameName.length - snLive.length} marked deliberate`);
if (shadowed.length && !COUNT_ONLY) {
  console.log("\n── SHADOWED ENGINE GLOBAL — every page loads both files, so one of these has never run");
  shadowed.forEach(([n, s]) => console.log(`  ${n}()  declared in  ${[...s].join("  ")}`));
}
/* --gate holds the line on the strongest signal only: an UNMARKED identical body in two places.
   The same-name groups are real work but need a judgement each, so gating on them would make the
   suite un-passable — and a gate nobody can pass gets switched off, taking the enforceable half
   with it. */
if (process.argv.includes("--gate")) {
  if (shadowed.length) {
    console.log(`FAIL — ${shadowed.length} function name(s) declared at top level in more than one engine file; every page loads them all, so one copy is dead code that looks live`);
    shadowed.forEach(([n, s]) => console.log(`         ${n}()  ${[...s].join("  ")}`));
    process.exit(1);
  }
  if (idLive.length) {
    console.log(`FAIL — ${idLive.length} identical function bod${idLive.length > 1 ? "ies exist" : "y exists"} in two places with no twin-ok note saying it is deliberate`);
    idLive.forEach((g) => g.forEach((f) => console.log(`         ${f.name}()  ${f.rel}:${f.line}`)));
    process.exit(1);
  }
  console.log("PASS — no unmarked identical twins");
  process.exit(0);
}
if (COUNT_ONLY) process.exit(0);

if (idLive.length) {
  console.log("\n── IDENTICAL — one change to either copy is a bug in the other");
  for (const g of idLive) {
    console.log(`  ${g[0].name}()  ${g[0].lines} lines`);
    g.forEach((f) => console.log(`      ${f.rel}:${f.line}`));
  }
}
/* SAME NAME is two different findings wearing one label, and reporting them together is why this
   list sat at 37 for days without anybody able to act on it. `flat`, `walk`, `boot`, `modal` and
   `ensureCss` are private helpers in unrelated modules that happen to share an obvious name —
   there is nothing to fix and never will be. A copy that DRIFTED is the opposite: same name,
   substantially the same body, one of them quietly changed. Only the second kind is a bug, and it
   is the kind a reader most needs pointed out.
   So: measure it. Jaccard over the normalised token multiset — cheap, no parser, and it separates
   the two cleanly at the observed distribution (drifted pairs score high, coincidences near zero).
   Same channel, two conditions, again: the same defect this run keeps finding in the product. */
const toks = (s) => s.toLowerCase().match(/[a-z_$][\w$]*|\d+|[^\s\w]/g) || [];
function similarity(a, b) {
  const A = new Set(toks(a)), B = new Set(toks(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}
const DRIFT_AT = 0.6;
function peakSimilarity(g) {
  let best = 0, pair = null;
  for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) {
    const s = similarity(g[i].norm, g[j].norm);
    if (s > best) { best = s; pair = [g[i], g[j]]; }
  }
  return { best, pair };
}
const scored = snLive.map((g) => ({ g, ...peakSimilarity(g) }));
const drifted = scored.filter((x) => x.best >= DRIFT_AT).sort((a, b) => b.best - a.best);
const coincidence = scored.filter((x) => x.best < DRIFT_AT);

if (drifted.length && !COUNT_ONLY) {
  console.log(`\n── DRIFTED COPY — same name AND ≥${Math.round(DRIFT_AT * 100)}% the same body, so one of them changed and the other did not`);
  for (const { g, best, pair } of drifted) {
    console.log(`  ${g[0].name}()  ${Math.round(best * 100)}% alike`);
    (pair || g).forEach((f) => console.log(`      ${f.rel}:${f.line}  (${f.lines} lines)`));
  }
}
if (coincidence.length && !COUNT_ONLY) {
  console.log(`\n── SAME NAME ONLY — unrelated bodies sharing an obvious helper name (${coincidence.length}); informational, not a defect`);
  for (const { g, best } of coincidence) {
    console.log(`  ${g[0].name}()  ${Math.round(best * 100)}% alike  ·  ${g.map((f) => f.rel + ":" + f.line).join("  ")}`);
  }
}
