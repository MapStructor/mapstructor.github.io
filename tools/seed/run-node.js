/* run-node.js — headless runner for the Chunk A seeder (Node 18+).

   Executes the exact files tools/seed/index.html loads — layersList.js,
   mapData.js, bounds.js, renderRegistry.js, configLoader.js, seed.js — in a
   vm context, so the seed/verify logic is never duplicated. Two stand-ins:
   a minimal supabase-js shim over global fetch (only the query-builder calls
   seed.js and configLoader.js actually use), and a stub document that
   captures the button handlers so they can be invoked directly.

   Usage:
     node run-node.js            seed a new AHM project, then verify it
     node run-node.js <uuid>     verify an existing project only */

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const FILES = [
  "../../map/test_project/lists/layersList.js",
  "../../map/test_project/lists/mapData.js",
  "../../map/test_project/lists/bounds.js",
  "../../map/test_project/lists/header.js",
  "../../platform/renderRegistry.js",
  "../../platform/configLoader.js",
  "seed.js",
];

/* --- supabase-js shim: just enough of the query builder for our two files.
   Supports .insert(row).select(cols).single() and .select(cols).eq(...).single(),
   returning { data, error } like the real client. --- */
function createClient(url, key) {
  const baseHeaders = {
    apikey: key,
    Authorization: "Bearer " + key,
    "Content-Type": "application/json",
  };
  function from(table) {
    const q = { filters: [], cols: null, insertRow: null, single: false };
    const api = {
      insert(row) { q.insertRow = row; return api; },
      select(cols) { q.cols = cols; return api; },
      eq(col, val) { q.filters.push(col + "=eq." + encodeURIComponent(val)); return api; },
      single() { q.single = true; return api; },
      then(resolve, reject) { return exec().then(resolve, reject); },
    };
    async function exec() {
      try {
        let res, data;
        if (q.insertRow) {
          res = await fetch(url + "/rest/v1/" + table, {
            method: "POST",
            headers: { ...baseHeaders, Prefer: "return=representation" },
            body: JSON.stringify(q.insertRow),
          });
          if (!res.ok) return { data: null, error: { message: res.status + " " + (await res.text()) } };
          data = await res.json();
          return { data: q.single ? data[0] : data, error: null };
        }
        const params = [];
        if (q.cols) params.push("select=" + encodeURIComponent(q.cols));
        params.push(...q.filters);
        res = await fetch(url + "/rest/v1/" + table + "?" + params.join("&"), { headers: baseHeaders });
        if (!res.ok) return { data: null, error: { message: res.status + " " + (await res.text()) } };
        data = await res.json();
        if (q.single) {
          if (data.length !== 1) return { data: null, error: { message: table + ": expected 1 row, got " + data.length } };
          data = data[0];
        }
        return { data, error: null };
      } catch (e) {
        return { data: null, error: { message: String(e && e.message || e) } };
      }
    }
    return api;
  }
  return { from };
}

/* --- stub document: captures addEventListener handlers by element id --- */
const handlers = {};
const elements = {};
function getElementById(id) {
  if (!elements[id]) {
    elements[id] = {
      value: "",
      textContent: "",
      addEventListener(_ev, fn) { handlers[id] = fn; },
    };
  }
  return elements[id];
}

const sandbox = {
  console,
  supabase: { createClient },
  document: { getElementById },
};
vm.createContext(sandbox);

for (const f of FILES) {
  const code = fs.readFileSync(path.join(__dirname, f), "utf8");
  vm.runInContext(code, sandbox, { filename: f });
}

(async () => {
  const existingId = process.argv[2];
  if (existingId) {
    elements["project-id"].value = existingId;
  } else {
    await handlers["seed-btn"]();
  }
  await handlers["verify-btn"]();
  process.stdout.write(elements["log"].textContent);
  if (/^ERROR:|ROUND-TRIP FAILED/m.test(elements["log"].textContent)) process.exitCode = 1;
})();
