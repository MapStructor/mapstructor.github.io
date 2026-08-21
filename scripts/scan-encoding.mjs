#!/usr/bin/env node
/**
 * scan-encoding.mjs — find (and repair) text that has been round-tripped through cp1252.
 *
 * WHY THIS EXISTS
 * ---------------
 * Twice now a tool has read a UTF-8 file as Windows "ANSI", so `—` became `â€"`, then written it
 * back as UTF-8 so the corruption became permanent. The second time it happened in the very file
 * where I had written the rule against it. A rule I have to remember is a rule I will break; a
 * scanner is not. Running it on the repo the day it was written found **7 corrupted runs already
 * committed** — a `★`, a `⚑` and five em dashes, one mangled three times over — sitting in
 * `map/editor.html` and `map/index.html` where nobody had noticed them.
 *
 * THE SUBTLETY THAT DEFEATS NAÏVE REPAIRS
 * ---------------------------------------
 * A double-encoded em dash contains U+009D, which cp1252 leaves undefined — so a strict cp1252
 * encoder throws and the run is silently skipped. The corruption came from a decoder that passes
 * C1 bytes straight through (the Windows behaviour), so the inverse must too — see the byte table
 * below, and the note on why it is derived rather than typed. My first repair pass reported "4
 * runs matched" and fixed only the two that weren't em dashes: it matched, threw, and called that
 * a result. A repair that reports what it MATCHED rather than what it CHANGED reports nothing.
 *
 *   node scripts/scan-encoding.mjs           report only, exit 1 if anything is corrupted
 *   node scripts/scan-encoding.mjs --fix     repair in place
 */

import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, resolve, join, extname } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const FIX = args.includes("--fix");
/* Scannable from any repo, because the docs repo is where most of the prose — and therefore most
   of the em dashes — actually lives:  node scan-encoding.mjs C:/repos/mapstructor_docs  */
const ROOT = resolve(args.find((a) => !a.startsWith("--")) || resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const TEXT = new Set([".html", ".js", ".mjs", ".css", ".json", ".md", ".txt", ".sql", ".py", ".ps1", ".yml", ".yaml", ".svg"]);

/* cp1252 decode table — DERIVED, never typed out.
   The first version of this file hand-wrote the 0x80-0x9F row as a string literal. The five slots
   cp1252 leaves undefined (0x81 0x8D 0x8F 0x90 0x9D) cannot be typed, so the literal came out 27
   characters instead of 32 and every entry past 0x80 was shifted: the em dash mapped to 0x93
   instead of 0x97, the reverse transform produced invalid UTF-8, and the scanner reported a
   corrupted file as CLEAN. Exactly the defect it exists to find — a stored copy of a table that
   could be derived. WHATWG windows-1252 passes the undefined slots through as C1 controls, which
   is precisely the Windows "ANSI" behaviour that causes the corruption in the first place. */
const DEC = (() => {
  const d = new TextDecoder("windows-1252");
  return [...Array(256).keys()].map((b) => d.decode(Uint8Array.of(b)));
})();
const REV = new Map(DEC.map((c, b) => [c, b]));   // bijective — all 256 entries are distinct

/* A mojibake run is EXACTLY ONE mangled UTF-8 sequence: a character standing in for a UTF-8 lead
   byte (0xC2-0xF4), followed by 1-3 characters standing in for continuation bytes (0x80-0xBF).
   Nothing longer.
     The first version matched greedily — "a lead character, then anything that could have come
   from a byte" — which swallowed the ASCII after it and ran to the end of the file. Every mangled
   sequence in a file became one giant run, so the moment ONE part of it decoded cleanly (say a ★
   that was only single-encoded), the resulting character was no longer byte-representable and the
   next pass bailed for the whole run — leaving double-encoded text half repaired and reporting
   "1 run" for a file with dozens. Precise boundaries, then repeat the whole pass. */
/* Bytes 0xC2-0xF4 decode through cp1252 to exactly U+00C2-U+00F4, so this is an exact fast reject,
   not an approximation — a file without one of these characters cannot contain mojibake. */
const FAST = /[Â-ô]/;
const UTF8_LEAD = (b) => b >= 0xc2 && b <= 0xf4;
const UTF8_CONT = (b) => b >= 0x80 && b <= 0xbf;
const U8 = new TextDecoder("utf-8", { fatal: true });

/* Text that LOOKS corrupted and is meant to. Found on the first real run: `logs/time_log.md`
   carries a historical entry reading "ALL mojibake fixed (<mangled em dash> -> -)" — the entry
   describing the repair quotes the corruption it repaired, so "fixing" it would destroy the
   sentence. Listed as escape sequences rather than literals for the obvious reason: written out
   as characters, this file would flag ITSELF.
   Keyed on file + exact sequence, so it stops covering anything the moment either changes. */
const ALLOWED = [
  /* String.fromCharCode, not a literal: the sequence written out as characters would make
     THIS file a mojibake hit, and the scanner would flag its own allowlist. */
  { file: "logs/time_log.md", seq: String.fromCharCode(0xe2, 0x20ac, 0x201d),
    why: "log entry quoting the mojibake it reports fixing" }
];
let allowed = 0;

function repairOnce(text, rel) {
  let out = "", i = 0, runs = 0;
  while (i < text.length) {
    const b0 = REV.get(text[i]);
    if (b0 === undefined || !UTF8_LEAD(b0)) { out += text[i++]; continue; }
    const exempt = ALLOWED.find((a) => rel.replace(/\\/g, "/").endsWith(a.file) && text.startsWith(a.seq, i));
    if (exempt) { allowed++; out += text.slice(i, i + exempt.seq.length); i += exempt.seq.length; continue; }

    const want = b0 < 0xe0 ? 2 : b0 < 0xf0 ? 3 : 4;
    const bytes = [b0];
    for (let k = 1; k < want; k++) {
      const b = REV.get(text[i + k]);
      if (b === undefined || !UTF8_CONT(b)) break;
      bytes.push(b);
    }
    if (bytes.length !== want) { out += text[i++]; continue; }

    try {
      const ch = U8.decode(Uint8Array.from(bytes));
      out += ch; i += want; runs++;
    } catch {
      out += text[i++];                       // not actually a mangled sequence — leave it alone
    }
  }
  return { out, runs };
}

function repair(text, rel) {
  let cur = text, runs = 0;
  for (let pass = 0; pass < 4; pass++) {      // undo double and triple encoding
    const r = repairOnce(cur, rel);
    if (!r.runs) break;
    cur = r.out; runs += r.runs;
  }
  return { out: cur, runs };
}

/* --others so UNTRACKED files are scanned too. Corruption is introduced at write time, and the
   cheapest moment to catch it is before it is committed — a scanner that only sees tracked files
   would have passed every one of my own mistakes at the moment I made them. */
const files = execSync("git ls-files --cached --others --exclude-standard", { cwd: ROOT, encoding: "utf8" })
  .split("\n").map((s) => s.trim()).filter((f) => f && TEXT.has(extname(f).toLowerCase()));

let dirty = 0, totalRuns = 0;
for (const rel of files) {
  const abs = join(ROOT, rel);
  let text;
  try { text = readFileSync(abs, "utf8"); } catch { continue; }
  if (!FAST.test(text)) continue;   // fast reject: nothing that could stand in for a UTF-8 lead byte
  const { out, runs } = repair(text, rel);
  if (!runs) continue;
  dirty++; totalRuns += runs;
  console.log(`${FIX ? "FIXED " : "CORRUPT"}  ${rel}  (${runs} run${runs > 1 ? "s" : ""})`);
  const sample = [...text.matchAll(/[À-ÿ][-ÿ]{1,8}/g)].slice(0, 3).map((m) => m[0]);
  if (sample.length) console.log(`           e.g. ${sample.join("  ")}`);
  if (FIX) writeFileSync(abs, out, "utf8");
}

console.log(`\nscanned ${files.length} text files · ${dirty} corrupted · ${totalRuns} run(s)`
  + (allowed ? ` · ${allowed} deliberate occurrence(s) allowed` : ""));
if (!dirty) { console.log("PASS — no cp1252 round-trip damage"); process.exit(0); }
if (FIX)    { console.log("repaired — re-run without --fix to confirm"); process.exit(0); }
console.log("FAIL — run `node scripts/scan-encoding.mjs --fix`");
process.exit(1);
