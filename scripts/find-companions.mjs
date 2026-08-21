#!/usr/bin/env node
/**
 * find-companions.mjs — every place that enumerates a layer's companion layers, and what it misses.
 *
 * WHY THIS EXISTS (bug family A: "a stored copy of a derivable fact drifts")
 * -------------------------------------------------------------------------
 * One logical layer becomes many real map layers: the fill, plus `-stroke-`, `-highlighted-`,
 * `-label-` and `-edited-` companions, each in a `-left`/`-right` pair for the swipe comparison.
 * Every operation that hides, removes, reorders, refilters or hit-tests a layer has to walk that
 * set — and each site wrote its own list of suffixes from memory. They disagree.
 *
 * The consequence is not theoretical. Deleting a layer runs a removal that knows four of the ten
 * ids, so the layer's LABELS AND HOVER HIGHLIGHT KEEP DRAWING — with no sidebar row left to switch
 * them off — until the page is reloaded. `-edited-*` is added, refilled, date-filtered and
 * hit-tested, and is never hidden, removed or reordered by anything at all.
 *
 * The canonical list is `MS_COMPANIONS` in map/engine/utils.js, with `msLayerVariants(slug)` to
 * expand it. This script finds the sites still writing their own, so the sweep is driven by a
 * detector rather than by a list I typed out once and then followed while the code moved.
 *
 *   node scripts/find-companions.mjs            every site, worst coverage first
 *   node scripts/find-companions.mjs --count    totals only
 *
 * `companions-ok` in a comment on the line marks a site as deliberately partial — a place that
 * genuinely only means the side pair, say — so triage is recorded in the code and the list
 * converges instead of re-reporting the same lines forever.
 */

import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const COUNT_ONLY = process.argv.includes("--count");

/* Read the canonical list out of the source rather than restating it here — restating it would
   make THIS file the twenty-second site with its own copy. */
const utils = readFileSync(join(ROOT, "map/engine/utils.js"), "utf8");
const CANON = (utils.match(/var MS_COMPANIONS\s*=\s*\[([^\]]*)\]/) || [, ""])[1]
  .split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
if (!CANON.length) { console.log("could not read MS_COMPANIONS from map/engine/utils.js"); process.exit(2); }

const SUFFIX_RE = /["'](-(?:stroke|highlighted|label|labels|edited)-)["']|["'](-(?:left|right))["']/g;
const WINDOW = 6;              // lines that count as "the same enumeration"

/* Naming ONE companion is not a defect — `labels.js` building the label layer names `-label-` and
   nothing else, correctly. The defect is a SWEEPING operation that walks an incomplete set: hide,
   remove, reorder, refilter. The first version of this detector flagged every mention and reported
   31 sites to fix, most of which were single-companion code doing exactly its job. A detector that
   reports correct code as broken teaches you to ignore it. */
const SWEEPING = /removeLayer|moveLayer|setFilter|setLayoutProperty\s*\([^,]+,\s*["']visibility|removeSource/;

const files = execSync("git ls-files platform/*.js map/engine/*.js", { cwd: ROOT, encoding: "utf8" })
  .split("\n").map((s) => s.trim()).filter(Boolean);

const sites = [];
for (const rel of files) {
  const lines = readFileSync(join(ROOT, rel), "utf8").split(/\r?\n/);
  let cluster = null;
  lines.forEach((line, i) => {
    if (/^\s*(\*|\/\/)/.test(line)) return;                 // prose, not code
    SUFFIX_RE.lastIndex = 0;
    const found = new Set();
    let m;
    while ((m = SUFFIX_RE.exec(line))) found.add(m[1] || m[2]);
    if (!found.size) return;
    const sweep = lines.slice(Math.max(0, i - 2), i + 3).some((l) => SWEEPING.test(l));
    /* The marker lives on a COMMENT line, and comments are skipped above before it could be read —
       so look for it in the same window as the verb. Triage that the detector cannot see is
       triage that does not exist. */
    const okHere = lines.slice(Math.max(0, i - 3), i + 4).some((l) => /companions-ok/.test(l));
    if (cluster && i - cluster.last <= WINDOW) {
      cluster.last = i;
      found.forEach((s) => cluster.suffixes.add(s));
      if (sweep) cluster.verbs.add("sweep");
      if (okHere) cluster.ok = true;
    } else {
      cluster = { rel, line: i + 1, last: i, suffixes: new Set(found), ok: okHere,
                  text: line.trim().slice(0, 96), verbs: new Set(sweep ? ["sweep"] : []) };
      sites.push(cluster);
    }
  });
}

/* A site that only ever names -left/-right is talking about the swipe pair, not the companion set;
   it is not evidence of a missing suffix. Judged separately rather than counted as 0/4, because a
   number that lumps them together is a number nobody can act on. */
const isCompanionSite = (s) => [...s.suffixes].some((x) => CANON.includes(x));
const real = sites.filter((s) => isCompanionSite(s) && s.verbs.has("sweep"));
/* Three buckets, named separately, because one leftover number covering two different reasons is
   how a count starts lying. */
const sidePairOnly = sites.filter((s) => !isCompanionSite(s)).length;
const buildsOne = sites.filter((s) => isCompanionSite(s) && !s.verbs.has("sweep")).length;

for (const s of real) {
  s.have = CANON.filter((c) => s.suffixes.has(c));
  s.missing = CANON.filter((c) => !s.suffixes.has(c));
}
real.sort((a, b) => b.missing.length - a.missing.length || a.rel.localeCompare(b.rel) || a.line - b.line);

const complete = real.filter((s) => !s.missing.length).length;
const triaged = real.filter((s) => s.ok && s.missing.length).length;
console.log(`canonical set: ${CANON.join(" ")}`);
console.log(`${real.length} SWEEPING companion site(s)  ·  ${complete} complete  ·  ${triaged} marked deliberate  ·  ${real.length - complete - triaged} to fix`);
console.log(`not counted: ${buildsOne} site(s) that build or read ONE companion (correct by construction)  ·  ${sidePairOnly} that name only the -left/-right pair`);
if (COUNT_ONLY) process.exit(0);

let lastFile = "";
for (const s of real) {
  if (!s.missing.length || s.ok) continue;
  if (s.rel !== lastFile) { console.log(`\n  ${s.rel}`); lastFile = s.rel; }
  console.log(`    ${String(s.line).padStart(5)}  missing ${s.missing.join(" ")}${s.have.length ? "   (has " + s.have.join(" ") + ")" : ""}`);
  console.log(`           ${s.text}`);
}
