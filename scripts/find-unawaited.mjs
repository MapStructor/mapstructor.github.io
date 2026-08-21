#!/usr/bin/env node
/**
 * find-unawaited.mjs — writes that were fired and forgotten.
 *
 * WHY THIS EXISTS
 * ---------------
 * A Supabase call is a promise. `await db.from("layers").update(…)` waits for the row to change;
 * `db.from("layers").update(…)` on its own returns immediately and the request races whatever
 * happens next — a reload, a navigation, the tab closing. The person sees the change on screen
 * because the local object was already updated; whether it survived is decided by a race nobody
 * can observe. This is the write-side twin of family B: not a failure that was swallowed, but a
 * failure that was never waited for long enough to have an opinion about.
 *
 * PostgREST makes it worse than usual: its builder is *thenable but lazy*, so an un-awaited chain
 * may not even be SENT until something subscribes to it.
 *
 * Deliberately narrow, because a broad version is useless:
 *   - only `db.from(...).insert/update/delete/upsert` and `db.rpc(...)`, i.e. calls that CHANGE
 *     something. Reads that are fired and forgotten cost nothing.
 *   - a statement is fine if it is awaited, returned, assigned, or has `.then(`/`.catch(` attached —
 *     any of those means somebody is holding the promise.
 *   - `void ` in front, or a `fire-and-forget` comment on the line, marks a deliberate one.
 *
 *   node scripts/find-unawaited.mjs           list them
 *   node scripts/find-unawaited.mjs --count   totals only
 *   node scripts/find-unawaited.mjs --gate    exit 1 if any is unmarked
 */

import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const COUNT_ONLY = process.argv.includes("--count");
const GATE = process.argv.includes("--gate");

/* The write itself. `db` covers db/database/supabase-ish receivers via the \w* prefix. */
const WRITE = /\b(?:\w*[Dd]b|supabase|client)\s*\(?\s*\)?\s*\.\s*(?:from\s*\([^)]*\)\s*\.\s*(?:insert|update|delete|upsert)|rpc)\s*\(/;
/* Somebody is holding the promise — and it has to be holding THIS one.
   The first version tested whether a holder token appeared ANYWHERE in the surrounding statement,
   which is presence, not position: a planted unheld write on a line that also said `return 1` was
   declared safe, and the detector reported a confident zero. What counts is what sits IMMEDIATELY
   before the write (await / return / an assignment / an argument position) or immediately after
   (.then / .catch). */
const HOLDER_BEFORE = /(?:\bawait\s+|\breturn\s+|[=:(\[,]\s*|\bvoid\s+|Promise\.(?:all|allSettled|race)\s*\(\s*\[?\s*)$/;
const HOLDER_AFTER = /^\s*(?:\.then\s*\(|\.catch\s*\(|\.select\s*\(|\.eq\s*\(|\.in\s*\(|\.match\s*\(|\.single\s*\(|\.maybeSingle\s*\()/;
/* Wrapped by one of ours, which awaits internally and reports the outcome. */
const WRAPPED = /saveGuard\s*\(\s*$|saveSoft\s*\(\s*$|MSGuard\.\w+\([^)]*$/;
const OK = /fire-and-forget|unawaited-ok/;

const files = execSync("git ls-files platform/*.js map/engine/*.js scripts/*.mjs", { cwd: ROOT, encoding: "utf8" })
  .split("\n").map((s) => s.trim()).filter(Boolean);

const hits = [];
for (const rel of files) {
  const lines = readFileSync(join(ROOT, rel), "utf8").split(/\r?\n/);
  lines.forEach((line, i) => {
    if (/^\s*(\*|\/\/)/.test(line)) return;
    const code = line.replace(/\/\/.*$/, "");
    if (!WRITE.test(code)) return;
    /* LOOK BOTH WAYS. The first version read only forward from the write line and produced two
       false positives out of two hits — a perfect score in the wrong direction:
         · `db.rpc('ms_release_edit_lock', …)` inside a pagehide handler, whose "fire-and-forget;
           the 90s TTL is the real cleanup" note sits on the line AFTER;
         · `db.rpc('mapstructor_user_storage')` as the first element of `await Promise.race([`,
           which opens on the line BEFORE.
       A detector for "nobody is holding this promise" that does not look at who is holding it is
       not much of a detector. Three lines back, four forward. */
    const around = lines.slice(Math.max(0, i - 3), i + 3).join("\n");
    if (OK.test(around)) return;
    /* Strip line comments PER LINE, then join. Joining first and stripping after collapses every
       newline, so a single `//` anywhere in the preceding lines eats the rest of the joined string —
       including the `await` this is looking for. That took the list from 2 hits to 19, all false. */
    const strip = (l) => l.replace(/\/\/.*$/, "");
    let stmt = lines.slice(Math.max(0, i - 3), i + 1).map(strip).join(" ");
    let j = i;
    while (j + 1 < lines.length && !/[;}]\s*$/.test(stmt) && j - i < 4) { j++; stmt += " " + strip(lines[j]); }

    /* Position, not presence — but bounded rather than parsed. Trying to walk the builder chain
       with balanced-paren regexes produced six false positives (`db.rpc(…).then(` read as unheld,
       because the WRITE match ends at rpc's opening paren and the `.then` is past its arguments;
       `await saveSoft(EBg.db.from(…)` read as unheld, because the wrapper's own receiver sat
       between them). A 60-character window immediately BEFORE the write catches every real holder
       — `await`, `return`, an assignment, an argument position, a saveGuard/saveSoft wrapper —
       while a `return 1` three lines away falls outside it. `.then`/`.catch` anywhere later in the
       same statement is accepted, because one there attaches to this chain in practice. */
    const at = stmt.search(WRITE);
    if (at < 0) return;
    const near = stmt.slice(Math.max(0, at - 60), at);
    const rest = stmt.slice(at);
    if (/\.(?:then|catch)\s*\(/.test(rest)) return;
    if (/\bawait\b|\breturn\b|[=:(\[,]\s*[\w$.]*$|\bvoid\b|Promise\.(?:all|allSettled|race)|saveGuard\s*\(|saveSoft\s*\(|MSGuard\./.test(near)) return;
    hits.push({ rel, line: i + 1, text: line.trim().slice(0, 110) });
  });
}

console.log(`${hits.length} write(s) fired without anyone holding the promise, in ${files.length} files`);
if (COUNT_ONLY) process.exit(0);

let last = "";
for (const h of hits) {
  if (h.rel !== last) { console.log(`\n  ${h.rel}`); last = h.rel; }
  console.log(`    ${String(h.line).padStart(5)}  ${h.text}`);
}

if (GATE) {
  if (hits.length) { console.log(`\nFAIL — ${hits.length} unheld write(s). Await them, or mark the line 'fire-and-forget' with the reason.`); process.exit(1); }
  console.log("PASS — every write is awaited, returned, assigned, chained, or explicitly fire-and-forget");
}
