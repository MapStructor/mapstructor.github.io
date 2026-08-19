/* MERGE — combine two or more layers' datasets into one, without rewriting a single row.
 *
 * WHY IT LOOKS LIKE THIS (owner 8/18): "This will be an operation we do constantly to build msds."
 * That one sentence sets the whole design:
 *   • N-WAY, never pairwise. Chaining A+B, then +C re-tiles at every step and tiling is the
 *     expensive part. Pick everything at once, tile once.
 *   • THE MAPPING SCREEN IS THE PRODUCT. The merge itself is a copy; all the human time goes into
 *     saying which column means which. So: auto-match identical names, show what is NOT mapped
 *     with a count (unmapped columns are how data quietly disappears), and remember the mapping
 *     for the next time the same sources meet.
 *   • msids NEVER change ("they are static, and cannot be changed, ever"). msid lives in
 *     custom_fields and is copied verbatim. The row's feature_id is a fresh primary key, which is
 *     not the same thing and is not user-visible. Identity in a merged dataset is (source, msid),
 *     which is why every merged row carries a `source` column.
 *   • Nothing is destroyed. Parents are untouched, so "un-merging" is filtering by source.
 *
 * The overlap question — two sources both covering a country-year — is deliberately NOT decided
 * here. Both rows land, tagged by source, and the owner filters later. That keeps a data judgement
 * out of a mechanical operation, and the source column keeps it changeable after the fact.
 */
(function () {
  "use strict";
  var M = {};
  window.MSMerge = M;

  // The editor injects what it owns (db handle, project id, and the layer-creation path). Without
  // a host, merge still opens and previews — it just cannot write, which is exactly what we want
  // in the viewer and in standalone copies.
  M.host = null;

  var LS_KEY = "ms-merge-mappings";
  function recallMapping(key) {
    try { return (JSON.parse(localStorage.getItem(LS_KEY) || "{}") || {})[key] || null; } catch (e) { return null; }
  }
  function rememberMapping(key, map) {
    try {
      var all = JSON.parse(localStorage.getItem(LS_KEY) || "{}") || {};
      all[key] = map; localStorage.setItem(LS_KEY, JSON.stringify(all));
    } catch (e) {}
  }

  function flat() {
    try { return (typeof flatLayers === "function" && typeof layers !== "undefined") ? (flatLayers(layers) || []) : []; }
    catch (e) { return []; }
  }

  /* ── reading a source ───────────────────────────────────────────────────────────────────────
     A sample is enough to LEARN the columns; the count is asked for separately and exactly,
     because "rows in vs rows out" is the number that tells you the merge did what you think. */
  M.describe = async function (node) {
    var host = M.host;
    var out = { id: node.id, label: node.label || node.name || node.id, lid: null, dataLid: null,
                count: 0, fields: [], hasLabel: false, hasStart: false, hasEnd: false, error: null };
    if (!host || !host.db) { out.error = "not connected"; return out; }
    try {
      out.lid = host.slugToLayerDbId ? host.slugToLayerDbId[node.id] : null;
      if (!out.lid) { out.error = "this layer has no saved data yet"; return out; }
      out.dataLid = out.lid;
      // pointer copies own no rows — read from the data root, same resolver the bake uses
      var probe = await host.db.from("features").select("feature_id").eq("layer_id", out.lid).limit(1);
      if (!probe.error && (!probe.data || !probe.data.length)) {
        var rt = await host.db.rpc("ms_layer_data_root", { p_layer: out.lid });
        if (!rt.error && rt.data) out.dataLid = rt.data;
      }
      var cnt = await host.db.from("features").select("feature_id", { count: "exact", head: true }).eq("layer_id", out.dataLid);
      out.count = cnt.count || 0;
      var samp = await host.db.from("features").select("label, start_date, end_date, custom_fields").eq("layer_id", out.dataLid).limit(200);
      var keys = {};
      (samp.data || []).forEach(function (r) {
        if (r.label != null && r.label !== "") out.hasLabel = true;
        if (r.start_date) out.hasStart = true;
        if (r.end_date) out.hasEnd = true;
        Object.keys(r.custom_fields || {}).forEach(function (k) { if (k !== "msid") keys[k] = (keys[k] || 0) + 1; });
      });
      out.fields = Object.keys(keys).sort();
      out.sample = (samp.data || []).slice(0, 3);
    } catch (e) { out.error = String(e && e.message || e); }
    return out;
  };

  // Pinned first because the timeline dies without them: these three are not ordinary columns.
  var CORE = [
    { key: "__label", name: "name", why: "what each feature is called" },
    { key: "__start", name: "start date", why: "when it appears on the timeline" },
    { key: "__end", name: "end date", why: "when it disappears" }
  ];
  // What a source offers for a core slot: its own column, or one of its custom fields
  function coreCandidates(d, core) {
    var own = core === "__label" ? "label" : core === "__start" ? "start_date" : "end_date";
    var has = core === "__label" ? d.hasLabel : core === "__start" ? d.hasStart : d.hasEnd;
    return [{ v: own, t: own + (has ? "" : "  (empty)") }].concat(d.fields.map(function (f) { return { v: "cf:" + f, t: f }; }));
  }
  // auto-match: same name wins, then the source's own column if it carries anything
  function guessCore(d, core) {
    var want = core === "__label" ? ["name", "NAME", "label"] : core === "__start" ? ["start", "start_date", "start_year", "gwsdate"] : ["end", "end_date", "end_year", "gwedate"];
    for (var i = 0; i < want.length; i++) if (d.fields.indexOf(want[i]) > -1) return "cf:" + want[i];
    var has = core === "__label" ? d.hasLabel : core === "__start" ? d.hasStart : d.hasEnd;
    return has ? (core === "__label" ? "label" : core === "__start" ? "start_date" : "end_date") : "";
  }

  /* Build the initial plan: every core slot guessed, and every field name that appears in MORE THAN
     ONE source auto-paired (identical names are the same thing often enough that pre-matching them
     saves most of the clicking; anything else starts unmapped and visible). */
  function initialPlan(descs) {
    var recalled = recallMapping(descs.map(function (d) { return d.id; }).sort().join("|"));
    if (recalled) return recalled;
    var plan = { core: {}, cols: [] };
    descs.forEach(function (d) {
      plan.core[d.id] = {};
      CORE.forEach(function (c) { plan.core[d.id][c.key] = guessCore(d, c.key); });
    });
    var seen = {};
    descs.forEach(function (d) { d.fields.forEach(function (f) { (seen[f] = seen[f] || []).push(d.id); }); });
    Object.keys(seen).sort().forEach(function (f) {
      if (seen[f].length < 2) return;   // only in one source → starts unmapped, listed below
      var col = { out: f, from: {} };
      seen[f].forEach(function (id) { col.from[id] = f; });
      plan.cols.push(col);
    });
    return plan;
  }

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]; }); }

  function css() {
    if (document.getElementById("msmg-css")) return;
    var s = document.createElement("style"); s.id = "msmg-css";
    s.textContent =
      "#msmg-ov{position:fixed;inset:0;background:rgba(24,20,40,.5);z-index:100001;display:flex;align-items:center;justify-content:center;}" +
      "#msmg{width:900px;max-width:96vw;max-height:88vh;display:flex;flex-direction:column;background:#fff;border-radius:10px;box-shadow:0 20px 60px rgba(0,0,0,.35);font:13px Source Sans Pro,Arial,sans-serif;}" +
      "#msmg-head{display:flex;justify-content:space-between;align-items:center;padding:11px 14px;border-bottom:1px solid #e6e3ef;}" +
      "#msmg-head b{font-size:15px}#msmg-head small{display:block;color:#6b6580;font-size:11px;font-weight:400}" +
      "#msmg-x{cursor:pointer;font-size:21px;color:#6b6580;line-height:1}" +
      "#msmg-body{overflow:auto;padding:12px 14px;flex:1}" +
      "#msmg-foot{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:10px 14px;border-top:1px solid #e6e3ef}" +
      ".msmg-btn{padding:6px 14px;border:1px solid #cdbff0;border-radius:6px;background:#f2ecff;color:#5b4b9a;font:600 12px Source Sans Pro,Arial,sans-serif;cursor:pointer}" +
      ".msmg-btn[disabled]{opacity:.45;cursor:not-allowed}" +
      ".msmg-ghost{border-color:#d7d3e4;background:#f4f2fa;color:#544f6e}" +
      "#msmg table{border-collapse:collapse;width:100%}" +
      "#msmg th,#msmg td{border:1px solid #e6e3ef;padding:5px 7px;text-align:left;vertical-align:middle}" +
      "#msmg th{background:#faf9fe;font-weight:600;color:#443f5c;position:sticky;top:0}" +
      "#msmg tr.msmg-core{background:#fbf8ff}" +
      "#msmg tr.msmg-core td:first-child{font-weight:600}" +
      "#msmg select,#msmg input[type=text]{width:100%;box-sizing:border-box;padding:3px 5px;border:1px solid #d7d3e4;border-radius:4px;font:12px Source Sans Pro,Arial,sans-serif;background:#fff}" +
      ".msmg-pick{display:flex;align-items:center;gap:8px;padding:6px 8px;border:1px solid #e2e0ea;border-radius:6px;margin:3px 0;background:#fbfaff}" +
      ".msmg-warn{margin:8px 0;padding:7px 9px;border:1px solid #f0d9a8;background:#fffaf0;border-radius:6px;color:#7a5a13}" +
      ".msmg-ok{margin:8px 0;padding:7px 9px;border:1px solid #c9e6c9;background:#f4fbf4;border-radius:6px;color:#2f6b34}" +
      ".msmg-tray{margin-top:10px;padding:8px 10px;border:1px dashed #d7d3e4;border-radius:6px;background:#fafafe;color:#544f6e;font-size:12px}" +
      ".msmg-drop{color:#8a8398}" +
      "#msmg-status{font-size:12px;color:#544f6e}";
    document.head.appendChild(s);
  }

  function shell(title, sub) {
    css();
    var old = document.getElementById("msmg-ov"); if (old) old.parentNode.removeChild(old);
    var ov = document.createElement("div"); ov.id = "msmg-ov";
    ov.innerHTML =
      '<div id="msmg">' +
        '<div id="msmg-head"><div><b>' + esc(title) + "</b><small>" + esc(sub) + "</small></div><span id=\"msmg-x\" title=\"Close\">&times;</span></div>" +
        '<div id="msmg-body"></div>' +
        '<div id="msmg-foot"><span id="msmg-status"></span><span id="msmg-actions"></span></div>' +
      "</div>";
    document.body.appendChild(ov);
    try { window.__msModalLock = true; } catch (e) {}
    function close() { try { window.__msModalLock = false; } catch (e) {} if (ov.parentNode) ov.parentNode.removeChild(ov); }
    ov.querySelector("#msmg-x").onclick = close;
    ov.addEventListener("mousedown", function (e) { if (e.target === ov) close(); });
    return { ov: ov, body: ov.querySelector("#msmg-body"), foot: ov.querySelector("#msmg-actions"), status: ov.querySelector("#msmg-status"), close: close };
  }

  /* ── step 1 · pick the layers ──────────────────────────────────────────────────────────────── */
  M.open = function () {
    var nodes = flat().filter(function (n) { return n && n.id && !n.msDivider; });
    var ui = shell("Merge layers", "Combine two or more layers into one dataset. Nothing is overwritten — the originals stay exactly as they are.");
    ui.body.innerHTML = nodes.length
      ? nodes.map(function (n) {
          return '<label class="msmg-pick"><input type="checkbox" value="' + esc(n.id) + '" style="margin:0 4px 0 0" />' +
            '<span style="flex:1">' + esc(n.label || n.name || n.id) + "</span></label>";
        }).join("")
      : '<div class="msmg-warn">This map has no layers to merge yet.</div>';
    ui.foot.innerHTML = '<button class="msmg-btn" id="msmg-next" disabled>Next: map the columns</button>';
    var next = ui.ov.querySelector("#msmg-next");
    function picked() { return [].slice.call(ui.body.querySelectorAll("input:checked")).map(function (i) { return i.value; }); }
    ui.body.addEventListener("change", function () {
      var p = picked();
      next.disabled = p.length < 2;
      ui.status.textContent = p.length < 2 ? "Pick at least two." : p.length + " layers selected";
    });
    next.onclick = function () { M.mapColumns(picked()); };
  };

  /* ── step 2 · map the columns ──────────────────────────────────────────────────────────────── */
  M.mapColumns = async function (ids) {
    var ui = shell("Merge — map the columns", "Say which column on each source means the same thing. Identical names are matched for you.");
    ui.body.innerHTML = '<div class="msmg-ok">Reading the sources…</div>';
    var nodes = ids.map(function (id) { var f = flat(); for (var i = 0; i < f.length; i++) if (f[i].id === id) return f[i]; return { id: id }; });
    var descs = [];
    for (var i = 0; i < nodes.length; i++) {
      ui.status.textContent = "Reading " + (nodes[i].label || nodes[i].id) + "… (" + (i + 1) + " of " + nodes.length + ")";
      descs.push(await M.describe(nodes[i]));
    }
    ui.status.textContent = "";
    var bad = descs.filter(function (d) { return d.error; });
    if (bad.length) {
      ui.body.innerHTML = '<div class="msmg-warn">Cannot read ' + bad.map(function (d) { return "<b>" + esc(d.label) + "</b> (" + esc(d.error) + ")"; }).join(", ") + "</div>";
      return;
    }
    var plan = initialPlan(descs);
    M._descs = descs; M._plan = plan;

    function render() {
      var head = "<tr><th style='width:190px'>Merged column</th>" + descs.map(function (d) {
        return "<th>" + esc(d.label) + "<div style='font-weight:400;color:#6b6580;font-size:11px'>" + d.count.toLocaleString() + " rows</div></th>";
      }).join("") + "<th style='width:34px'></th></tr>";

      var coreRows = CORE.map(function (c) {
        return "<tr class='msmg-core'><td>" + esc(c.name) + "<div style='font-weight:400;color:#6b6580;font-size:11px'>" + esc(c.why) + "</div></td>" +
          descs.map(function (d) {
            var cands = coreCandidates(d, c.key), cur = plan.core[d.id][c.key] || "";
            return "<td><select data-core='" + c.key + "' data-src='" + esc(d.id) + "'>" +
              "<option value=''>— not mapped —</option>" +
              cands.map(function (o) { return "<option value='" + esc(o.v) + "'" + (o.v === cur ? " selected" : "") + ">" + esc(o.t) + "</option>"; }).join("") +
              "</select></td>";
          }).join("") + "<td></td></tr>";
      }).join("");

      var colRows = plan.cols.map(function (col, ci) {
        return "<tr><td><input type='text' data-out='" + ci + "' value='" + esc(col.out) + "' /></td>" +
          descs.map(function (d) {
            var cur = col.from[d.id] || "";
            return "<td><select data-col='" + ci + "' data-src='" + esc(d.id) + "'>" +
              "<option value=''>— none —</option>" +
              d.fields.map(function (f) { return "<option value='" + esc(f) + "'" + (f === cur ? " selected" : "") + ">" + esc(f) + "</option>"; }).join("") +
              "</select></td>";
          }).join("") +
          "<td><span class='msmg-drop' data-del='" + ci + "' title='Remove this column' style='cursor:pointer'>&times;</span></td></tr>";
      }).join("");

      // what is NOT coming across — named and counted, because this is where data goes missing
      var mapped = {};
      plan.cols.forEach(function (c) { Object.keys(c.from).forEach(function (sid) { mapped[sid + "|" + c.from[sid]] = 1; }); });
      CORE.forEach(function (c) { descs.forEach(function (d) { var v = plan.core[d.id][c.key] || ""; if (v.indexOf("cf:") === 0) mapped[d.id + "|" + v.slice(3)] = 1; }); });
      var unmapped = [];
      descs.forEach(function (d) { d.fields.forEach(function (f) { if (!mapped[d.id + "|" + f]) unmapped.push({ src: d.label, f: f, id: d.id }); }); });

      ui.body.innerHTML =
        "<table>" + head + coreRows + colRows + "</table>" +
        "<div style='margin-top:8px'><button class='msmg-btn msmg-ghost' id='msmg-add'>+ Add a column</button></div>" +
        "<div class='msmg-tray'><b>Not included (" + unmapped.length + ")</b>" +
          (unmapped.length
            ? "<div style='margin-top:4px'>" + unmapped.map(function (u) { return "<span style='display:inline-block;margin:2px 6px 2px 0'><code>" + esc(u.f) + "</code> <span style='color:#8a8398'>from " + esc(u.src) + "</span> <a href='#' data-add-src='" + esc(u.id) + "' data-add-f='" + esc(u.f) + "'>add</a></span>"; }).join("") + "</div>"
            : "<div style='margin-top:4px'>Everything is mapped.</div>") +
        "</div>";

      ui.body.querySelectorAll("select[data-core]").forEach(function (s) {
        s.onchange = function () { plan.core[this.getAttribute("data-src")][this.getAttribute("data-core")] = this.value; render(); };
      });
      ui.body.querySelectorAll("select[data-col]").forEach(function (s) {
        s.onchange = function () {
          var c = plan.cols[+this.getAttribute("data-col")];
          if (this.value) c.from[this.getAttribute("data-src")] = this.value; else delete c.from[this.getAttribute("data-src")];
          render();
        };
      });
      ui.body.querySelectorAll("input[data-out]").forEach(function (i) {
        i.onchange = function () { plan.cols[+this.getAttribute("data-out")].out = this.value.trim() || "column"; render(); };
      });
      ui.body.querySelectorAll("[data-del]").forEach(function (x) {
        x.onclick = function () { plan.cols.splice(+this.getAttribute("data-del"), 1); render(); };
      });
      ui.body.querySelectorAll("[data-add-f]").forEach(function (a) {
        a.onclick = function (e) {
          e.preventDefault();
          var f = this.getAttribute("data-add-f"), sid = this.getAttribute("data-add-src");
          var col = { out: f, from: {} }; col.from[sid] = f;
          descs.forEach(function (d) { if (d.id !== sid && d.fields.indexOf(f) > -1) col.from[d.id] = f; });
          plan.cols.push(col); render();
        };
      });
      ui.body.querySelector("#msmg-add").onclick = function () { plan.cols.push({ out: "new column", from: {} }); render(); };

      var missing = [];
      CORE.forEach(function (c) { descs.forEach(function (d) { if (!plan.core[d.id][c.key]) missing.push(d.label + " → " + c.name); }); });
      ui.status.innerHTML = missing.length
        ? "<span style='color:#8a6a13'>⚠ unmapped: " + esc(missing.join(", ")) + "</span>"
        : descs.reduce(function (t, d) { return t + d.count; }, 0).toLocaleString() + " rows in total";
    }
    render();
    ui.foot.innerHTML = '<button class="msmg-btn" id="msmg-prev">Next: preview</button>';
    ui.ov.querySelector("#msmg-prev").onclick = function () {
      rememberMapping(descs.map(function (d) { return d.id; }).sort().join("|"), plan);
      M.preview(descs, plan);
    };
  };

  /* ── step 3 · preview ──────────────────────────────────────────────────────────────────────── */
  M.preview = function (descs, plan) {
    var ui = shell("Merge — preview", "What the merged dataset will contain. Nothing has been written yet.");
    var total = descs.reduce(function (t, d) { return t + d.count; }, 0);
    var outCols = ["source"].concat(plan.cols.map(function (c) { return c.out; }));
    var noDate = descs.filter(function (d) { return !plan.core[d.id].__start || !plan.core[d.id].__end; });
    var dropped = [];
    var mapped = {};
    plan.cols.forEach(function (c) { Object.keys(c.from).forEach(function (sid) { mapped[sid + "|" + c.from[sid]] = 1; }); });
    CORE.forEach(function (c) { descs.forEach(function (d) { var v = plan.core[d.id][c.key] || ""; if (v.indexOf("cf:") === 0) mapped[d.id + "|" + v.slice(3)] = 1; }); });
    descs.forEach(function (d) { d.fields.forEach(function (f) { if (!mapped[d.id + "|" + f]) dropped.push(d.label + "." + f); }); });

    ui.body.innerHTML =
      "<table>" +
        "<tr><th>Source</th><th>Rows in</th><th>name</th><th>start</th><th>end</th></tr>" +
        descs.map(function (d) {
          return "<tr><td>" + esc(d.label) + "</td><td>" + d.count.toLocaleString() + "</td>" +
            CORE.map(function (c) { var v = plan.core[d.id][c.key]; return "<td>" + (v ? "<code>" + esc(v.replace(/^cf:/, "")) + "</code>" : "<span style='color:#b4342f'>— none —</span>") + "</td>"; }).join("") +
            "</tr>";
        }).join("") +
      "</table>" +
      "<div class='msmg-ok'><b>" + total.toLocaleString() + " rows out</b> across <b>" + outCols.length + "</b> columns: " + outCols.map(function (c) { return "<code>" + esc(c) + "</code>"; }).join(" ") +
        "<div style='margin-top:4px'>Every row keeps its own <code>msid</code>, and gains <code>source</code> — so identity in the merged dataset is (source, msid) and nothing is renumbered.</div></div>" +
      (noDate.length ? "<div class='msmg-warn'><b>No dates mapped for:</b> " + esc(noDate.map(function (d) { return d.label; }).join(", ")) + ". Those rows will be there but will not appear or disappear on the timeline.</div>" : "") +
      (dropped.length ? "<div class='msmg-warn'><b>" + dropped.length + " column(s) will NOT be copied:</b> " + esc(dropped.slice(0, 24).join(", ")) + (dropped.length > 24 ? " …" : "") + "</div>" : "") +
      "<div style='margin-top:10px'><label>Name the merged layer<br><input type='text' id='msmg-name' value='" + esc(descs.map(function (d) { return d.label; }).join(" + ").slice(0, 80)) + "' style='width:100%;box-sizing:border-box;padding:6px 8px;border:1px solid #d7d3e4;border-radius:5px' /></label></div>" +
      "<div class='msmg-tray'>The sources are left exactly as they are. To undo a merge, delete the merged layer — or filter it by <code>source</code>.</div>";

    ui.foot.innerHTML =
      '<button class="msmg-btn msmg-ghost" id="msmg-back">Back</button> ' +
      '<button class="msmg-btn" id="msmg-go"' + (M.host && M.host.runMerge ? "" : " disabled title='Merging writes data — available in the editor'") + ">Merge " + total.toLocaleString() + " rows</button>";
    ui.ov.querySelector("#msmg-back").onclick = function () { M.mapColumns(descs.map(function (d) { return d.id; })); };
    var go = ui.ov.querySelector("#msmg-go");
    if (go && M.host && M.host.runMerge) go.onclick = function () {
      go.disabled = true;
      M.host.runMerge({ descs: descs, plan: plan, name: (document.getElementById("msmg-name") || {}).value || "Merged layer", core: CORE },
        function (msg) { ui.status.textContent = msg; },
        function (err) { ui.status.textContent = err ? "Merge failed — " + err : "Merged."; if (!err) setTimeout(ui.close, 900); else go.disabled = false; });
    };
  };

  // exposed so the editor can offer it, and so a test can drive it without clicking
  M.CORE = CORE;
})();
