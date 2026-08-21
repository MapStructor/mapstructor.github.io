#!/usr/bin/env node
/**
 * stamp-version.mjs — one cache-buster rule for every local script and stylesheet on the site.
 *
 * WHY THIS EXISTS (bug family G: "the fix never reached the user's runtime")
 * -------------------------------------------------------------------------
 * Cache busters were hand-typed per <script> tag, so the site drifted into 17 different
 * ?v= values at once — 50 includes still on 20260731a, 25 on 20260728a, one literally
 * "?v=now" — and 58 production includes with no buster at all. Whether a fix reached a
 * person's browser depended on which stale constant happened to sit next to that file's
 * tag. Worse, the date-plus-letter convention has a same-day trap: stamp a file 20260821a,
 * edit it an hour later, and every browser that already fetched it keeps the old copy
 * forever. I hit exactly that trap on 8/21.
 *
 * THE RULE HERE: the stamp is the file's CONTENT HASH, not a date.
 *   - Edit a file  → its stamp changes → every browser refetches that one file.
 *   - Edit nothing → stamps are identical → running this produces no diff (idempotent).
 *   - `--check`    → a falsifiable claim: "every local include is stamped with the hash of
 *                    what it actually serves". A date can't be falsified; a hash can.
 * Per-file (not one global hash) so a one-line CSS fix doesn't re-download the whole site.
 *
 * USAGE
 *   node scripts/stamp-version.mjs           stamp everything (run before deploy)
 *   node scripts/stamp-version.mjs --check    exit 1 if any include is missing or stale
 *   node scripts/stamp-version.mjs --list     show every include and its state, change nothing
 *
 * KNOWN LIMIT, stated rather than hidden: a file's hash covers only that file. If a.js
 * imports b.js at runtime, editing b.js does not change a.js's stamp. All of this site's
 * script chains are flat <script> tags, so that limit is currently untriggered — if that
 * changes, this is the place it breaks.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MODE = process.argv.includes("--check") ? "check"
           : process.argv.includes("--list")  ? "list"
           : "stamp";

/* Every local .js/.css reference, in all three shapes the site uses:
     <script src="x.js">                          plain tag
     <link href="x.css" rel="stylesheet">          plain tag
     document.write('<script src="' + _project + '/lists/x.js"><\/script>')   concatenated
   The pattern deliberately also matches inside HTML comments: a commented-out include that
   someone later uncomments must not come back unstamped. */
const INCLUDE = /((?:src|href)=")([^"]*?\.(?:js|css))(\?v=[^"]*)?(")/g;

/* A buster built at runtime — `?v=' + Date.now() + '` — is a DELIBERATE always-fresh choice on
   the handful of files under active edit, where a stale copy costs an hour of chasing ghosts.
   The first version of this script ate those expressions and replaced them with a static hash,
   which would have made exactly those files cacheable and stale. Left alone, and counted out
   loud so the choice stays visible instead of becoming invisible. */
const DYNAMIC = /[+']/;

/* Left alone on purpose:
     - third-party bundles pinned to their own upstream version;
     - anything under secrets/, which is gitignored and per-deployment — its content differs
       between my machine and the deployed site, so a hash of my copy would be a stamp
       nobody else can reproduce, which is worse than no stamp. */
const KEEP_OWN_VERSION = [/duckdb-browser-eh\.worker\.js/, /(^|\/)secrets\//];

const hashCache = new Map();

function hashOf(diskPath) {
  if (hashCache.has(diskPath)) return hashCache.get(diskPath);
  let h = null;
  if (existsSync(diskPath)) {
    h = createHash("sha256").update(readFileSync(diskPath)).digest("hex").slice(0, 8);
  }
  hashCache.set(diskPath, h);
  return h;
}

/* Resolve an href as written in HTML to a file on disk.
   `' + _project + '/lists/x.js` is built at runtime; _project is the project folder, which
   is `project` in this repo. Anything that still doesn't resolve gets reported, not guessed. */
function toDisk(htmlFile, href) {
  const cleaned = href.replace(/'\s*\+\s*_project\s*\+\s*'/g, "project");
  if (/^(https?:)?\/\//.test(cleaned) || cleaned.startsWith("data:")) return null;
  return resolve(join(dirname(htmlFile), cleaned));
}

const files = execSync("git ls-files *.html **/*.html", { cwd: ROOT, encoding: "utf8" })
  .split("\n").map((s) => s.trim()).filter(Boolean);

let stamped = 0, already = 0, changed = 0, skipped = 0, dynamic = 0;
const stale = [];        // had a buster, but not the current content hash
const unbusted = [];     // resolved fine, simply had no buster at all
const unresolved = [];   // points at a file I cannot read — never guess a stamp for these

for (const rel of files) {
  const abs = join(ROOT, rel);
  const before = readFileSync(abs, "utf8");

  const after = before.replace(INCLUDE, (whole, pre, href, oldQ, post) => {
    if (/^(https?:)?\/\//.test(href)) return whole;
    if (KEEP_OWN_VERSION.some((re) => re.test(href))) { skipped++; return whole; }
    if (oldQ && DYNAMIC.test(oldQ)) { dynamic++; return whole; }

    const disk = toDisk(abs, href);
    const h = disk ? hashOf(disk) : null;
    if (!h) {
      unresolved.push(`${rel} → ${href}`);
      return whole;                       // never invent a stamp for a file I can't read
    }

    const want = `?v=${h}`;
    if (oldQ === want) { already++; return whole; }
    if (!oldQ) unbusted.push(`${rel} → ${href}`);
    else stale.push(`${rel} → ${href} ${oldQ} → ${want}`);
    changed++;
    return pre + href + want + post;
  });

  if (after !== before && MODE === "stamp") {
    writeFileSync(abs, after, "utf8");
    stamped++;
  }
}

const total = already + changed + dynamic + skipped + unresolved.length;
console.log(
  `includes: ${total} local  ·  ${already} correct  ·  ${stale.length} stale  ·  ` +
  `${unbusted.length} unbusted  ·  ${dynamic} always-fresh  ·  ${skipped} pinned upstream  ·  ` +
  `${unresolved.length} unresolved`
);

if (MODE === "list" || MODE === "check") {
  for (const u of unbusted.slice(0, 80))   console.log("  UNBUSTED    " + u);
  for (const s of stale.slice(0, 80))      console.log("  STALE       " + s);
  for (const m of unresolved.slice(0, 80)) console.log("  UNRESOLVED  " + m);
}

if (MODE === "stamp") {
  console.log(`rewrote ${stamped} html file(s)`);
  if (unresolved.length) {
    console.log(`WARNING: ${unresolved.length} include(s) point at a file not on disk — left unstamped. See --list.`);
  }
}

if (MODE === "check") {
  /* Unresolved is reported but does NOT fail the gate: those are references into generated
     or gitignored folders (secrets, per-project exports) that are legitimately absent here.
     Failing on them would make the gate un-passable, and a gate nobody can pass gets ignored. */
  if (changed > 0) {
    console.log("FAIL — run `node scripts/stamp-version.mjs` and commit the result");
    process.exit(1);
  }
  console.log("PASS — every resolvable local include carries the hash of what it serves");
}
