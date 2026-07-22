/* tables.js — data tables + joins (MVP 7/16).
   "+ Table" button in the editor's add-row → a draggable manager where you can:
     • upload a CSV as a named table (stored in data_tables/data_rows — run
       mapstructor_docs/sql/setup/tables-setup.sql once),
     • view/delete tables,
     • JOIN a table onto a layer: pick layer + layer key + table + table key —
       matching rows' columns merge into features.custom_fields via ONE bulk call
       (ms_apply_join), so 78k features join in seconds. Re-open the attribute
       table to see the new columns; Publish re-bakes them into tiles.
   Self-contained: delete this file + its include lines to remove. */
(function () {
  "use strict";
  if (window._msTables) return;

  function db() { return (typeof MapAuth !== "undefined" && MapAuth.db) || null; }
  function nfmt(n) { try { return Number(n).toLocaleString("en-US"); } catch (e) { return String(n); } }

  /* ── CSV parser (quotes, escaped quotes, CRLF) ─────────────────────────── */
  function parseCSV(text) {
    var rows = [], row = [], cur = "", q = false;
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
        else cur += c;
      } else if (c === '"') q = true;
      else if (c === ",") { row.push(cur); cur = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(cur); cur = "";
        if (row.length > 1 || row[0] !== "") rows.push(row);
        row = [];
      } else cur += c;
    }
    if (cur !== "" || row.length) { row.push(cur); if (row.length > 1 || row[0] !== "") rows.push(row); }
    return rows;
  }
  function cellVal(s) {
    var t = String(s == null ? "" : s).trim();
    if (t === "") return null;
    return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : t;
  }

  /* ── data layer ────────────────────────────────────────────────────────── */
  async function listTables() {
    var r = await db().from("data_tables").select("id, name, columns, row_count, created_at").order("created_at", { ascending: false });
    if (r.error) throw new Error(r.error.message);
    return r.data || [];
  }
  async function createTable(name, csvText, status) {
    status = status || function () {};
    var rows = parseCSV(csvText);
    if (rows.length < 2) throw new Error("CSV needs a header row + at least one data row");
    var head = rows[0].map(function (h, i) { return String(h || "col" + (i + 1)).trim(); });
    var t = await db().from("data_tables").insert({ name: name, columns: head, row_count: rows.length - 1 }).select("id").single();
    if (t.error) throw new Error(t.error.message + (/(relation|does not exist)/i.test(t.error.message) ? " — run mapstructor_docs/sql/setup/tables-setup.sql first (Ctrl+A!)" : ""));
    var batch = [];
    for (var i = 1; i < rows.length; i++) {
      var obj = {};
      head.forEach(function (h, ci) { var v = cellVal(rows[i][ci]); if (v !== null) obj[h] = v; });
      batch.push({ table_id: t.data.id, row: obj });
      if (batch.length === 500 || i === rows.length - 1) {
        var r2 = await db().from("data_rows").insert(batch);
        if (r2.error) throw new Error(r2.error.message);
        status("Saving rows… " + nfmt(i) + "/" + nfmt(rows.length - 1));
        batch = [];
      }
    }
    return { id: t.data.id, columns: head, rows: rows.length - 1 };
  }
  async function deleteTable(id) {
    var r = await db().from("data_tables").delete().eq("id", id);
    if (r.error) throw new Error(r.error.message);
  }
  async function tableRows(id, limit) {
    var r = await db().from("data_rows").select("row").eq("table_id", id).limit(limit || 50);
    if (r.error) throw new Error(r.error.message);
    return (r.data || []).map(function (x) { return x.row; });
  }
  async function projectLayers() {
    var pid = (typeof platformProjectId !== "undefined" && platformProjectId) || window.platformProjectId;
    if (!pid) return [];
    var r = await db().from("project_layers").select("layers(id, name)").eq("project_id", pid);
    return ((r && r.data) || []).map(function (x) { return x.layers; }).filter(Boolean);
  }
  async function layerKeys(lid) {
    var r = await db().from("features").select("custom_fields").eq("layer_id", lid).limit(40);
    var keys = {};
    ((r && r.data) || []).forEach(function (f) { Object.keys(f.custom_fields || {}).forEach(function (k) { keys[k] = 1; }); });
    return ["label"].concat(Object.keys(keys).sort());
  }
  // the join: build { keyValue: {col:val,…} } from the table, one bulk RPC applies it
  async function applyJoin(layerId, layerKey, tableId, tableKey, status) {
    status = status || function () {};
    status("Reading the table…");
    var map = {}, from = 0;
    for (;;) {
      var r = await db().from("data_rows").select("row").eq("table_id", tableId).range(from, from + 999);
      if (r.error) throw new Error(r.error.message);
      (r.data || []).forEach(function (x) {
        var row = x.row || {}, k = row[tableKey];
        if (k == null) return;
        var merged = {};
        Object.keys(row).forEach(function (c) { if (c !== tableKey) merged[c] = row[c]; });
        map[String(k)] = merged;
      });
      if (!r.data || r.data.length < 1000) break;
      from += 1000;
    }
    if (!Object.keys(map).length) throw new Error("the table has no values in that key column");
    status("Joining " + nfmt(Object.keys(map).length) + " keys into the layer…");
    var res = await db().rpc("ms_apply_join", { p_layer: layerId, p_key: layerKey, p_map: map });
    if (res.error) throw new Error(res.error.message + (/(function|does not exist)/i.test(res.error.message) ? " — run mapstructor_docs/sql/setup/tables-setup.sql first (Ctrl+A!)" : ""));
    return res.data;   // features updated
  }
  window._msTables = { parseCSV: parseCSV, createTable: createTable, applyJoin: applyJoin, listTables: listTables };

  /* ── UI ────────────────────────────────────────────────────────────────── */
  function css() {
    if (document.getElementById("mst-css")) return;
    var s = document.createElement("style");
    s.id = "mst-css";
    s.textContent =
      "#mst-modal{position:fixed;left:70px;top:70px;z-index:5000;width:460px;max-width:94vw;background:#f8f8f8;border:1px solid #d7d3e4;border-radius:10px;box-shadow:0 10px 34px rgba(40,32,80,.25);font:14px 'Source Sans Pro',Arial,sans-serif;color:#333;display:none;}" +
      "#mst-head{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:#fff;border-bottom:1px solid #e4e0ef;border-radius:10px 10px 0 0;cursor:move;font-weight:700;}" +
      "#mst-x{cursor:pointer;font-size:20px;color:#8b86a3;padding:0 6px;border-radius:6px;}#mst-x:hover{background:#f1eef9;color:#4c4374;}" +
      "#mst-body{padding:12px 14px;max-height:70vh;overflow:auto;}" +
      ".mst-sec{background:#fff;border:1px solid #e4e0ef;border-radius:8px;padding:10px 12px;margin-bottom:10px;}" +
      ".mst-sec h4{margin:0 0 8px;font-size:13px;color:#5b458f;text-transform:uppercase;letter-spacing:.6px;}" +
      ".mst-row{display:flex;gap:6px;align-items:center;margin:6px 0;flex-wrap:wrap;}" +
      ".mst-in{flex:1;min-width:120px;padding:6px 8px;border:1px solid #ccc;border-radius:5px;font:inherit;background:#fff;}" +
      ".mst-btn{padding:6px 12px;border:1px solid #b9aee0;border-radius:6px;background:#efeaff;color:#4c3d8f;font:600 13px inherit;cursor:pointer;}" +
      ".mst-btn:hover{background:#e4dcff;}" +
      ".mst-del{border-color:#e0b9b9;background:#ffefef;color:#8f3d3d;}" +
      ".mst-note{color:#7a758f;font-size:12.5px;margin-top:4px;}" +
      ".mst-status{color:#5b458f;font-weight:600;font-size:13px;min-height:18px;margin-top:6px;white-space:normal;}" +
      ".mst-list td{padding:4px 8px;border-bottom:1px solid #f0edf7;font-size:13px;}" +
      "#mst-preview{max-height:200px;overflow:auto;margin-top:8px;}#mst-preview table{border-collapse:collapse;}#mst-preview td,#mst-preview th{border:1px solid #e4e0ef;padding:3px 7px;font-size:12px;white-space:nowrap;}";
    document.head.appendChild(s);
  }

  var el = null, tbls = [];
  function modal() {
    if (el) return el;
    css();
    el = document.createElement("div");
    el.id = "mst-modal";
    el.innerHTML =
      '<div id="mst-head"><span>📊 Data tables & joins</span><span id="mst-x">&times;</span></div>' +
      '<div id="mst-body">' +
      '<div class="mst-sec"><h4>Your tables</h4><table class="mst-list" style="width:100%"><tbody id="mst-tbls"></tbody></table><div id="mst-preview"></div></div>' +
      '<div class="mst-sec"><h4>Add a table (CSV)</h4>' +
      '<div class="mst-row"><input id="mst-name" class="mst-in" placeholder="Table name"><input id="mst-file" type="file" accept=".csv,text/csv" class="mst-in"></div>' +
      '<div class="mst-row"><button id="mst-upload" class="mst-btn">Upload</button></div>' +
      '<div class="mst-note">First row = column names. Numbers stay numeric.</div></div>' +
      '<div class="mst-sec"><h4>Join a table onto a layer</h4>' +
      '<div class="mst-row"><select id="mst-jlayer" class="mst-in"></select><select id="mst-jlkey" class="mst-in"></select></div>' +
      '<div class="mst-row"><select id="mst-jtable" class="mst-in"></select><select id="mst-jtkey" class="mst-in"></select></div>' +
      '<div class="mst-row"><button id="mst-join" class="mst-btn">Apply join</button></div>' +
      '<div class="mst-note">Rows whose <i>table key</i> equals the layer\'s <i>layer key</i> merge their other columns into those features. Re-open the attribute table to see them; hit Publish to bake into tiles.</div></div>' +
      '<div class="mst-status" id="mst-status"></div>' +
      "</div>";
    document.body.appendChild(el);
    el.querySelector("#mst-x").addEventListener("click", function () { el.style.display = "none"; });
    // drag by header
    el.querySelector("#mst-head").addEventListener("mousedown", function (e) {
      if (e.target.id === "mst-x") return;
      e.preventDefault();
      var sx = e.clientX, sy = e.clientY, r = el.getBoundingClientRect(), ox = r.left, oy = r.top;
      function mv(ev) { el.style.left = Math.max(0, ox + ev.clientX - sx) + "px"; el.style.top = Math.max(0, oy + ev.clientY - sy) + "px"; }
      function up() { document.removeEventListener("mousemove", mv); document.removeEventListener("mouseup", up); }
      document.addEventListener("mousemove", mv); document.addEventListener("mouseup", up);
    });
    el.querySelector("#mst-upload").addEventListener("click", onUpload);
    el.querySelector("#mst-join").addEventListener("click", onJoin);
    el.querySelector("#mst-jtable").addEventListener("change", fillTableKeys);
    el.querySelector("#mst-jlayer").addEventListener("change", fillLayerKeys);
    return el;
  }
  function status(m) { var s = document.getElementById("mst-status"); if (s) s.textContent = m || ""; }

  async function refresh() {
    var tb = document.getElementById("mst-tbls");
    tb.innerHTML = "<tr><td>Loading…</td></tr>";
    try { tbls = await listTables(); } catch (e) { tb.innerHTML = "<tr><td>" + e.message + "</td></tr>"; return; }
    tb.innerHTML = tbls.length ? "" : "<tr><td class='mst-note'>No tables yet — upload a CSV below.</td></tr>";
    tbls.forEach(function (t) {
      var tr = document.createElement("tr");
      tr.innerHTML = "<td><b>" + t.name + "</b></td><td>" + nfmt(t.row_count) + " rows</td>" +
        "<td><button class='mst-btn' data-v='" + t.id + "'>View</button></td><td><button class='mst-btn mst-del' data-d='" + t.id + "'>Delete</button></td>";
      tb.appendChild(tr);
    });
    tb.querySelectorAll("[data-v]").forEach(function (b) { b.addEventListener("click", function () { preview(this.getAttribute("data-v")); }); });
    tb.querySelectorAll("[data-d]").forEach(function (b) {
      b.addEventListener("click", async function () {
        var t = tbls.filter(function (x) { return x.id === b.getAttribute("data-d"); })[0];
        if (!confirm('Delete table "' + (t && t.name) + '"? (Already-joined columns stay on the features.)')) return;
        try { await deleteTable(b.getAttribute("data-d")); status("Deleted."); refresh(); fillJoinSelects(); } catch (e) { status(e.message); }
      });
    });
    fillJoinSelects();
  }
  async function preview(id) {
    var pv = document.getElementById("mst-preview");
    pv.innerHTML = "Loading…";
    try {
      var rows = await tableRows(id, 50);
      var t = tbls.filter(function (x) { return x.id === id; })[0];
      var cols = (t && t.columns) || Object.keys(rows[0] || {});
      var h = "<table><tr>" + cols.map(function (c) { return "<th>" + c + "</th>"; }).join("") + "</tr>";
      rows.forEach(function (r) { h += "<tr>" + cols.map(function (c) { return "<td>" + (r[c] != null ? r[c] : "") + "</td>"; }).join("") + "</tr>"; });
      pv.innerHTML = h + "</table>";
    } catch (e) { pv.innerHTML = e.message; }
  }
  async function fillJoinSelects() {
    var lsel = document.getElementById("mst-jlayer"), tsel = document.getElementById("mst-jtable");
    var ls = await projectLayers();
    lsel.innerHTML = '<option value="">— layer —</option>' + ls.map(function (l) { return '<option value="' + l.id + '">' + (l.name || "layer") + "</option>"; }).join("");
    tsel.innerHTML = '<option value="">— table —</option>' + tbls.map(function (t) { return '<option value="' + t.id + '">' + t.name + "</option>"; }).join("");
    fillTableKeys(); fillLayerKeys();
  }
  function fillTableKeys() {
    var tsel = document.getElementById("mst-jtable"), ksel = document.getElementById("mst-jtkey");
    var t = tbls.filter(function (x) { return x.id === tsel.value; })[0];
    ksel.innerHTML = ((t && t.columns) || []).map(function (c) { return '<option value="' + c + '">key: ' + c + "</option>"; }).join("") || "<option value=''>— table key —</option>";
  }
  async function fillLayerKeys() {
    var lsel = document.getElementById("mst-jlayer"), ksel = document.getElementById("mst-jlkey");
    if (!lsel.value) { ksel.innerHTML = "<option value=''>— layer key —</option>"; return; }
    ksel.innerHTML = "<option>loading…</option>";
    try {
      var ks = await layerKeys(lsel.value);
      ksel.innerHTML = ks.map(function (k) { return '<option value="' + k + '">key: ' + k + "</option>"; }).join("");
    } catch (e) { ksel.innerHTML = "<option value=''>— layer key —</option>"; }
  }
  async function onUpload() {
    var name = document.getElementById("mst-name").value.trim();
    var f = document.getElementById("mst-file").files[0];
    if (!name || !f) { status("Give the table a name and pick a .csv file."); return; }
    try {
      var text = await f.text();
      status("Parsing…");
      var res = await createTable(name, text, status);
      status('Table "' + name + '" saved — ' + nfmt(res.rows) + " rows, " + res.columns.length + " columns.");
      document.getElementById("mst-name").value = ""; document.getElementById("mst-file").value = "";
      refresh();
    } catch (e) { status("Upload failed: " + e.message); }
  }
  async function onJoin() {
    var lid = document.getElementById("mst-jlayer").value, lkey = document.getElementById("mst-jlkey").value;
    var tid = document.getElementById("mst-jtable").value, tkey = document.getElementById("mst-jtkey").value;
    if (!lid || !lkey || !tid || !tkey) { status("Pick a layer, layer key, table and table key."); return; }
    if (!confirm("Join will merge the table's columns into every matching feature of this layer (existing same-named columns are overwritten). Continue?")) return;
    try {
      var n = await applyJoin(lid, lkey, tid, tkey, status);
      status("Join done — " + nfmt(n) + " features updated. Re-open the attribute table to see the new columns; Publish re-bakes tiles.");
    } catch (e) { status("Join failed: " + e.message); }
  }

  function open() { modal().style.display = "block"; refresh(); }

  // "+ Table" button in the editor's add-row — re-injected if the row re-renders
  function inject() {
    var row = document.querySelector("#editor-add-buttons .erow");
    if (row && !document.getElementById("mst-open")) {
      var b = document.createElement("button");
      b.id = "mst-open";
      b.textContent = "Table";
      b.title = "Data tables & joins";
      b.addEventListener("click", function (e) { e.preventDefault(); open(); });
      row.appendChild(b);
    }
  }
  setInterval(inject, 1500);
  inject();
})();
