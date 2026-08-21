/* find-ownerless.mjs — every row that gets written must have an owner.
 *
 * WHY. `project_layer_owner_rule` records the invariant "every layers INSERT sets user_id", and on
 * 8/21 three of the five insert sites broke it:
 *   · queryWindow.makeResultLayer  — no user_id at all; EVERY layer it ever made was ownerless
 *   · editing.js instance path     — `userId || src.user_id || null`, so an ownerless SOURCE
 *                                    produced an ownerless INSTANCE
 *   · editing.js copy path         — strip() carries the source's user_id, same cascade
 * An ownerless row is invisible to any policy keyed on user_id, bills its storage to nobody, and
 * — this is the part that makes it spread — seeds more of itself, because copy and instance both
 * inherit the source's owner. One ownerless layer in June had produced descendants by August.
 *
 * The check is static and blunt on purpose: find every `.from("<table>").insert(` for the tables
 * that carry an owner, and require the inserted row object to mention `user_id` WITHOUT a `|| null`
 * escape. It cannot prove the value is non-null at runtime — that is what the thrown guards at the
 * call sites are for — but it does catch the shape that keeps recurring, which is a row literal
 * that simply never mentions the column.
 *
 *   node scripts/find-ownerless.mjs          # report
 *   node scripts/find-ownerless.mjs --gate   # fail if any insert omits it
 */
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GATE = process.argv.includes("--gate");
const OWNED = ["layers", "projects", "datasets"];   // tables whose rows belong to somebody

const files = execSync("git ls-files platform/*.js map/engine/*.js *.html", { cwd: ROOT, encoding: "utf8" })
  .split("\n").map((s) => s.trim()).filter(Boolean);

const findings = [];
for (const rel of files) {
  let src = "";
  try { src = readFileSync(resolve(ROOT, rel), "utf8"); } catch { continue; }
  for (const table of OWNED) {
    const re = new RegExp(`\\.from\\(\\s*["'\`]${table}["'\`]\\s*\\)\\s*\\.insert\\s*\\(`, "g");
    let m;
    while ((m = re.exec(src))) {
      const line = src.slice(0, m.index).split("\n").length;
      /* The row is usually a variable built above the call, so look BACK as well as forward — a
         window each way, which is what the three real sites needed. Looking only at the argument
         would have missed all three. */
      const back = src.slice(Math.max(0, m.index - 2000), m.index);
      const fwd = src.slice(m.index, m.index + 600);
      /* The row is often BUILT BY A FUNCTION — `var row = mirrorRow(L, …)` — whose body sits
         thousands of characters away. Reporting that as "never mentions user_id" is a false
         positive, and a detector that cries wolf gets ignored, which is worse than not having it.
         So when the row comes from a call, follow the callee and read ITS body. */
      let builderBody = "";
      const argName = (fwd.match(/\.insert\s*\(\s*([A-Za-z_$][\w$]*)/) || [])[1];
      /* Take the LAST assignment in the window, not one anchored at its end — at portalAdd:531 two
         `if` statements sit between `var row = mirrorRow(…)` and the insert. */
      let asg = null, ar;
      const ARE = /(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?([A-Za-z_$][\w$]*)\s*\(/g;
      while ((ar = ARE.exec(back))) if (!argName || ar[1] === argName) asg = ar;
      if (asg) {
        const fnAt = src.search(new RegExp(`function\\s+${asg[2]}\\s*\\(`));
        if (fnAt > -1) builderBody = src.slice(fnAt, fnAt + 3000);
      }
      /* Comments do not set columns. The first version tested the raw text, so the explanatory
         note "EVERY layers INSERT sets user_id" sitting above a site was enough to satisfy it —
         a planted bug went undetected in the mutation test for exactly that reason. */
      const decomment = (s) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
      const near = decomment(back + fwd + builderBody);
      const mentions = /user_id/.test(near);
      const nullable = /user_id\s*[:=][^,;\n]*\|\|\s*null/.test(near);
      /* `ownerless-ok` on the line or just above records a deliberate exception, the same triage
         idiom the other detectors use, so this list can converge instead of being re-read. */
      const marked = /ownerless-ok/.test(src.slice(Math.max(0, m.index - 400), m.index + 200));
      if (marked) continue;
      if (!mentions) findings.push({ rel, line, table, why: "row never mentions user_id" });
      else if (nullable) findings.push({ rel, line, table, why: "user_id has a `|| null` fallback" });
    }
  }
}

console.log(`${findings.length} owner-less insert site(s) across ${files.length} files`);
for (const f of findings) console.log(`  ${f.rel}:${f.line}  ${f.table}  — ${f.why}`);

if (GATE) {
  if (findings.length) {
    console.log(`\nFAIL — ${findings.length} insert(s) can write a row nobody owns`);
    process.exit(1);
  }
  console.log("\nPASS — every owned-table insert sets user_id with no null escape");
}
