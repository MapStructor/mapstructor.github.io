/* viewerTable.js — VIEW-mode sidebar extras (map/index.html only; the editor never uses this —
   the wiring below stands down when window.__msEditorAttr is set).

   1) ▦ FEATURES LIST — the per-row table icon opens a lightweight docked list of the layer's
      features (colored glyph + name + count), mirroring the editor's list. Click a row to zoom
      to that feature (geometry fetched on demand). The FULL attribute table stays editor-only
      for now (user 7/21). Layers opt out with raw_config.tableBtn === false (the editor's
      "Table button shown in view mode" checkbox).
   2) STYLE DIVISIONS — layers with style categories (styleRows + colorBy) show the same
      indented category checkboxes as the editor. Toggles are session-only in view: opacity
      expressions go to the map, nothing is persisted.

   Feature rows come from the features table (anonymous reads work on public projects — the same
   RLS path hydration uses); list rendering is windowed via MSAttrWindow (attrGrid.js), so DOM
   size never depends on row count. Standalone downloads ship without platform/, so none of this
   exists there and viewer rows render exactly as before. */
(function () {
  "use strict";
  if (window.MSViewerTable) return;
  window.__msViewerAttr = true;   // generateLayers renders the ▦ on viewer rows when set
  var CAP = 100000, PAGE = 1000;  // same tier-1 guardrail as the editor

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function findNode(a, id) { for (var i = 0; i < (a || []).length; i++) { if (a[i].id === id) return a[i]; var c = findNode(a[i].children, id); if (c) return c; } return null; }
  function allLayers() { return typeof layers !== "undefined" ? layers : []; }
  function maps() { return [typeof beforeMap !== "undefined" ? beforeMap : null, typeof afterMap !== "undefined" ? afterMap : null].filter(Boolean); }

  /* ───────────────────────── 1) the features list ───────────────────────── */
  var _win = null, _rows = [], _gen = 0, _selFid = null, _icon = "", _geomCache = {};

  function ensureUi() {
    if (document.getElementById("ms-vl")) return;
    var st = document.createElement("style");
    st.textContent =
      '#ms-vl{position:fixed;z-index:3990;width:300px;background:#fff;border:1px solid #c9bfe8;border-radius:6px;box-shadow:0 3px 16px rgba(0,0,0,0.18);display:none;flex-direction:column;overflow:hidden;font-family:"Source Sans Pro",Arial,sans-serif;}' +
      '#ms-vl-head{display:flex;align-items:center;gap:6px;padding:9px 10px;border-bottom:1px solid #ececec;}' +
      '#ms-vl-title{font-weight:700;color:#2b3a4a;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;min-width:0;}' +
      '#ms-vl-close{cursor:pointer;color:#333333;font-size:18px;font-weight:700;line-height:1;padding:2px 9px;border:1px solid #bbbbbb;border-radius:3px;background:#f2f2f2;}' +
      '#ms-vl-close:hover{background:#fdeaea;color:#b4453a;border-color:#e0b4b4;}' +
      '#ms-vl-wrap{flex:1;overflow:auto;position:relative;}' +
      '#ms-vl-table{width:100%;border-collapse:separate;border-spacing:0;font-size:13.5px;table-layout:fixed;}' +
      '#ms-vl-table td{padding:7px 10px;border-bottom:1px solid #f0f0f3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer;box-sizing:border-box;}' +
      '#ms-vl-table tr:hover td{background:#d6f3ff;}' +
      '#ms-vl-table tr.ms-vl-sel td{background:#fff5cc;}' +
      '.ms-vl-ico{display:inline-block;width:16px;text-align:center;margin-right:9px;font-size:12px;vertical-align:middle;}' +
      '.ms-vl-untitled{color:#aaaaaa;font-style:italic;}' +
      '#ms-vl-foot{padding:7px 12px;border-top:1px solid #ececec;font-size:12px;color:#888888;}';
    document.head.appendChild(st);
    var el = document.createElement("div");
    el.id = "ms-vl";
    el.innerHTML =
      '<div id="ms-vl-head"><b id="ms-vl-title">Features</b><span id="ms-vl-close" title="Close">&times;</span></div>' +
      '<div id="ms-vl-wrap"><table id="ms-vl-table"><tbody id="ms-vl-tbody"></tbody></table></div>' +
      '<div id="ms-vl-foot"></div>';
    document.body.appendChild(el);
    document.getElementById("ms-vl-close").addEventListener("click", close);
    document.getElementById("ms-vl-tbody").addEventListener("click", function (e) {
      var tr = e.target && e.target.closest && e.target.closest("tr[data-fid]"); if (!tr) return;
      var fid = tr.getAttribute("data-fid");
      _selFid = fid;
      Array.prototype.forEach.call(this.querySelectorAll("tr[data-fid]"), function (t) { t.classList.toggle("ms-vl-sel", t.getAttribute("data-fid") === fid); });
      zoomToFeature(fid);
    });
    window.addEventListener("resize", function () { if (el.style.display !== "none") dock(); });
  }
  function dock() {
    var el = document.getElementById("ms-vl"); if (!el) return;
    var anchor = document.getElementById("layers-panel-content");
    var r = anchor ? anchor.getBoundingClientRect() : { right: 470, top: 96 };
    var top = Math.round(Math.max(8, r.top));
    var tl = document.querySelector(".timeline");
    var bottom = tl ? Math.max(top + 160, Math.round(tl.getBoundingClientRect().top - 10)) : (window.innerHeight - 12);
    el.style.left = Math.round(r.right + 10) + "px";
    el.style.top = top + "px";
    el.style.height = (bottom - top) + "px";
  }
  function close() { _gen++; var el = document.getElementById("ms-vl"); if (el) el.style.display = "none"; }

  function layerGlyph(node) {
    var col = (node && node.iconColor) || "#3bb2d0";
    var t = node && node.type;
    var glyph = t === "line" ? "━" : (t === "circle" ? "●" : "■");
    return '<span class="ms-vl-ico" style="color:' + esc(col) + ';">' + glyph + "</span>";
  }
  function rowHtml(r) {
    if (!r) return '<tr><td style="color:#bbbbbb;">…</td></tr>';
    var lbl = (r.label == null || r.label === "") ? '<span class="ms-vl-untitled">(untitled)</span>' : esc(r.label);
    var sel = _selFid != null && String(r.feature_id) === String(_selFid);
    return '<tr data-fid="' + esc(r.feature_id) + '"' + (sel ? ' class="ms-vl-sel"' : "") + '><td title="' + esc(r.label || "") + '">' + _icon + '<span>' + lbl + "</span></td></tr>";
  }

  function geomBounds(g) {
    if (!g || !g.coordinates) return null;
    var mm = null;
    (function walk(c) {
      if (typeof c[0] === "number") {
        if (!mm) mm = [c[0], c[1], c[0], c[1]];
        else { if (c[0] < mm[0]) mm[0] = c[0]; if (c[1] < mm[1]) mm[1] = c[1]; if (c[0] > mm[2]) mm[2] = c[0]; if (c[1] > mm[3]) mm[3] = c[1]; }
      } else if (Array.isArray(c)) c.forEach(walk);
    })(g.coordinates);
    return mm ? [[mm[0], mm[1]], [mm[2], mm[3]]] : null;
  }
  async function zoomToFeature(fid) {
    try {
      var g = _geomCache[fid];
      if (!g) {
        var r = await MapAuth.db.from("features").select("geom").eq("feature_id", fid).single();
        g = r.data && r.data.geom;
        if (g) _geomCache[fid] = g;
      }
      var b = geomBounds(g); if (!b) return;
      maps().forEach(function (m) { try { m.fitBounds(b, { padding: 90, maxZoom: 15, bearing: 0 }); } catch (e) {} });
    } catch (e) {}
  }

  async function openList(node) {
    ensureUi(); dock();
    var gen = ++_gen;
    var lid = node._dataLayerId || node._layerDbId;
    var el = document.getElementById("ms-vl");
    el.style.display = "flex";
    document.getElementById("ms-vl-title").textContent = node.label || "Features";
    document.getElementById("ms-vl-foot").textContent = "loading…";
    _rows = []; _selFid = null; _icon = layerGlyph(node);
    document.getElementById("ms-vl-tbody").innerHTML = "";
    if (_win) { _win.destroy(); _win = null; }
    if (!lid || typeof MapAuth === "undefined" || !MapAuth.db) { document.getElementById("ms-vl-foot").textContent = "No list available for this layer."; return; }
    var db = MapAuth.db, from = 0, rows = [];
    try {
      while (from < CAP) {
        var r = await db.from("features").select("feature_id, label").eq("layer_id", lid).order("feature_id").range(from, from + PAGE - 1);
        if (gen !== _gen) return;   // closed / another layer opened mid-load
        if (r.error) throw new Error(r.error.message);
        var got = r.data || [];
        rows = rows.concat(got);
        document.getElementById("ms-vl-foot").textContent = rows.length.toLocaleString() + " features…";
        if (got.length < PAGE) break;
        from += PAGE;
      }
    } catch (e) { document.getElementById("ms-vl-foot").textContent = "Load failed: " + (e && e.message); return; }
    if (gen !== _gen) return;
    _rows = rows;
    document.getElementById("ms-vl-foot").textContent = rows.length.toLocaleString() + " feature" + (rows.length === 1 ? "" : "s") + (from >= CAP ? " (first " + CAP.toLocaleString() + ")" : "");
    if (!rows.length) { document.getElementById("ms-vl-tbody").innerHTML = '<tr><td style="color:#777777;">No features.</td></tr>'; return; }
    _win = new MSAttrWindow({
      scrollEl: document.getElementById("ms-vl-wrap"),
      tbody: document.getElementById("ms-vl-tbody"),
      renderRow: rowHtml,
      colCount: function () { return 1; }
    });
    _win.setRows(_rows);
  }

  document.addEventListener("click", function (e) {
    if (window.__msEditorAttr) return;   // the editor wires its own ▦ (features list) — never both
    var t = e.target && e.target.closest && e.target.closest(".attr-table-btn"); if (!t) return;
    e.stopPropagation(); e.preventDefault();
    var row = t.closest(".layer-list-row"); if (!row) return;
    var cb = row.querySelector('input[type="checkbox"]'); if (!cb || !cb.id) return;
    var node = findNode(allLayers(), cb.id); if (!node) return;
    openList(node).catch(function (err) { console.warn("viewerTable:", err); });
  });

  /* ─────────────────── 2) style divisions (category rows) ─────────────────── */
  function opKeyFor(node) { var t = node && node.type; return t === "line" ? "line-opacity" : (t === "circle" ? "circle-opacity" : "fill-opacity"); }
  function styleCatsFor(node) {   // mirror of the editor's — [{key,label,color}]; [] for single-color layers
    var cb = node.colorBy;
    if (cb && cb.mode === "presence") return [{ key: "__present__", label: "Labeled", color: cb.present || "#3bb2d0" }, { key: "__absent__", label: "Unlabeled", color: cb.absent || "#cccccc" }];
    if (cb && cb.mapping) { var ks = Object.keys(cb.mapping); return ks.slice(0, 20).map(function (k) { return { key: k, label: (k === " " || k === "") ? "(blank)" : k, color: cb.mapping[k] }; }); }
    return [];
  }
  function styleOpacityExpr(node) {
    var key = opKeyFor(node), cur = node.paint && node.paint[key];
    if (typeof cur === "number") node.styleBaseOp = cur;
    var base = (typeof node.styleBaseOp === "number") ? node.styleBaseOp : 1;
    var hidden = node.styleHidden || [];
    if (!hidden.length) return base;
    var cb = node.colorBy;
    if (cb && cb.mode === "presence") {
      var f = ["to-string", ["get", cb.prop || "label"]], blank = ["any", ["==", f, ""], ["==", f, " "]];
      return ["case", blank, (hidden.indexOf("__absent__") > -1 ? 0 : base), (hidden.indexOf("__present__") > -1 ? 0 : base)];
    }
    if (cb && cb.mapping) { var expr = ["match", ["to-string", ["get", cb.prop]]]; hidden.forEach(function (v) { expr.push(v, 0); }); expr.push(base); return expr; }
    return base;
  }
  function applyStyleVisibility(node) {   // session-only in view: map paint updated, nothing persisted
    var key = opKeyFor(node), expr = styleOpacityExpr(node);
    node.paint = node.paint || {}; node.paint[key] = expr;
    [["-left", typeof beforeMap !== "undefined" ? beforeMap : null], ["-right", typeof afterMap !== "undefined" ? afterMap : null]].forEach(function (pr) {
      var m = pr[1]; if (!m) return;
      try { if (m.getLayer(node.id + pr[0])) m.setPaintProperty(node.id + pr[0], key, expr); } catch (e) {}
    });
  }
  function syncLayerMaster(node) {   // partial → indeterminate dash, exactly like the editor
    var cats = node.styleRows ? styleCatsFor(node) : []; if (!cats.length) return;
    var cb = document.getElementById(node.toggleElement || node.id); if (!cb) return;
    var hidden = node.styleHidden || [];
    var off = cats.filter(function (c) { return hidden.indexOf(c.key) > -1; }).length;
    if (off === 0) { cb.indeterminate = false; cb.checked = true; }
    else if (off >= cats.length) { cb.indeterminate = false; cb.checked = false; }
    else { cb.indeterminate = true; cb.checked = true; }
  }
  function injectStyleRows() {
    if (window.__msEditorAttr) return;   // the editor injects its own
    var panel = document.getElementById("layers-panel-content"); if (!panel) return;
    if (!document.getElementById("ms-stylerow-css")) {   // same classes as the editor = same look
      var st = document.createElement("style"); st.id = "ms-stylerow-css";
      st.textContent = ".ms-stylerow{display:flex;align-items:center;gap:7px;padding:3px 8px 3px 46px;font-size:12.5px;color:#4a4a4a;}" +
        ".ms-stylerow input{margin:0;flex:0 0 auto;cursor:pointer;}" +
        ".ms-stylerow-sw{display:inline-block;width:12px;height:12px;flex:0 0 auto;border:1px solid #999999;border-radius:2px;}" +
        ".ms-stylerow-lbl{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}";
      document.head.appendChild(st);
    }
    Array.prototype.forEach.call(panel.querySelectorAll(".ms-stylerow"), function (r) { r.remove(); });
    Array.prototype.forEach.call(panel.querySelectorAll(".layer-list-row"), function (row) {
      var cb0 = row.querySelector('input[type="checkbox"]'); if (!cb0 || !cb0.id) return;
      var node = findNode(allLayers(), cb0.id); if (!node || !node.styleRows) return;
      var cats = styleCatsFor(node); if (!cats.length) return;
      var hidden = node.styleHidden || [];
      cats.slice().reverse().forEach(function (c) {   // reversed inserts keep top-to-bottom order under the row
        var d = document.createElement("div"); d.className = "ms-stylerow";
        var on = hidden.indexOf(c.key) < 0;
        d.innerHTML = '<input type="checkbox" ' + (on ? "checked" : "") + ' /><span class="ms-stylerow-sw" style="background:' + esc(c.color) + ';"></span><span class="ms-stylerow-lbl" title="' + esc(c.label) + '">' + esc(c.label) + "</span>";
        d.querySelector("input").addEventListener("change", function () {
          node.styleHidden = node.styleHidden || [];
          var i = node.styleHidden.indexOf(c.key);
          if (this.checked) { if (i > -1) node.styleHidden.splice(i, 1); } else { if (i < 0) node.styleHidden.push(c.key); }
          applyStyleVisibility(node); syncLayerMaster(node);
        });
        row.parentNode.insertBefore(d, row.nextSibling);
      });
      syncLayerMaster(node);
    });
  }
  // the layer's own checkbox acts group-like over its categories (all on / all off)
  document.addEventListener("change", function (e) {
    if (window.__msEditorAttr) return;
    var t = e.target; if (!t || t.type !== "checkbox" || !t.closest) return;
    if (!t.closest(".layer-list-row")) return;   // category sub-rows live OUTSIDE .layer-list-row
    var node = findNode(allLayers(), t.id); if (!node || !node.styleRows) return;
    var cats = styleCatsFor(node); if (!cats.length) return;
    node.styleHidden = t.checked ? [] : cats.map(function (c) { return c.key; });
    t.indeterminate = false;
    applyStyleVisibility(node);
    injectStyleRows();
  }, true);
  var _tries = 0;
  (function boot() {   // panel + maps arrive async; static maps never qualify — boot gives up quietly
    _tries++;
    var panel = document.getElementById("layers-panel-content");
    var ready = panel && panel.querySelector(".layer-list-row") && typeof beforeMap !== "undefined" && beforeMap;
    if (!ready) { if (_tries < 80) setTimeout(boot, 500); return; }
    injectStyleRows();
  })();

  window.MSViewerTable = { open: openList, close: close, injectStyleRows: injectStyleRows };
})();
