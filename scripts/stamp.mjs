/* stamp.mjs — ONE cache-busting mechanism instead of 246 hand-edited tags (owner 10/6: "Maybe we
 * should factor/refactor the approach, so you can just update one thing?").
 *
 * Every local <script src> / <link href> in every page gets `?v=<8 hex of that file's content>`.
 * Content hashes, not a global version: a page re-fetches exactly the files that changed and keeps
 * caching the rest, and nobody ever bumps anything — the pre-commit hook runs this and stages the
 * result, so a commit that changes platform/editing.js also carries the new stamp in every page
 * that loads it. The `document.write('<script src="…?v=' + Date.now() + '"…')` loaders in
 * editor.html are rewritten to plain stamped tags: Date.now() defeated caching entirely (every
 * load re-downloaded editing.js), which is the opposite of a cache-buster.
 *
 * Untouched: remote URLs, anything in node_modules/_backups/_docs_backup, and refs to files that do
 * not exist (left as they are, listed in the report).
 *
 *   node scripts/stamp.mjs            rewrite in place, print what changed
 *   node scripts/stamp.mjs --check    exit 1 if anything would change (CI / curiosity), write nothing
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHECK = process.argv.includes("--check");
const SKIP_DIRS = new Set(["node_modules", ".git", "_backups", "_docs_backup", "secrets"]);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const f = path.join(dir, e.name);
    if (e.isDirectory()) walk(f, out); else if (/\.html?$/i.test(e.name)) out.push(f);
  }
  return out;
}
const hashes = new Map();
function hashOf(file) {
  if (!hashes.has(file)) {
    try { hashes.set(file, crypto.createHash("sha1").update(fs.readFileSync(file)).digest("hex").slice(0, 8)); }
    catch (e) { hashes.set(file, null); }
  }
  return hashes.get(file);
}
const isLocal = (u) => !/^(https?:)?\/\//i.test(u) && !/^(data|blob|mailto|javascript):/i.test(u) && !u.startsWith("#");

let pages = 0, changed = 0, stamped = 0, missing = [];
for (const html of walk(ROOT)) {
  const src = fs.readFileSync(html, "utf8");
  const dir = path.dirname(html);
  let out = src;
  // 1. the Date.now() document.write loaders → plain tags (same position, same attributes)
  out = out.replace(/<script>document\.write\('(<script src=")([^"'?]+)\?v=' \+ Date\.now\(\) \+ '("[^']*?)><\\\/script>'\);<\/script>/g,
    (m, open, file, rest) => `${open}${file}${rest}></script>`);
  // 2. every local script/link ref gets the content hash of the file it points at
  out = out.replace(/(<(?:script|link)\b[^>]*?\b(?:src|href)=")([^"]+?)(")/g, (m, pre, url, post) => {
    if (!isLocal(url)) return m;
    const [p, q = ""] = url.split("?");
    if (!/\.(js|mjs|css)$/i.test(p)) return m;
    const file = path.resolve(dir, p);
    const h = hashOf(file);
    if (!h) { missing.push(path.relative(ROOT, html) + " → " + p); return m; }
    const params = q.split("&").filter((x) => x && !/^v=/.test(x));
    params.push("v=" + h);
    stamped++;
    return `${pre}${p}?${params.join("&")}${post}`;
  });
  pages++;
  if (out !== src) {
    changed++;
    if (!CHECK) fs.writeFileSync(html, out);
    console.log((CHECK ? "would change " : "stamped ") + path.relative(ROOT, html));
  }
}
console.log(`${pages} pages scanned · ${stamped} local refs stamped · ${changed} page(s) ${CHECK ? "would change" : "rewritten"}`);
if (missing.length) console.log("refs to files that do not exist (left alone):\n  " + [...new Set(missing)].slice(0, 20).join("\n  "));
if (CHECK && changed) process.exit(1);
