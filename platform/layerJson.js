/* layerJson.js — per-layer JSON options (MVP 7/16).
   A "{ } JSON" button in the layer panel header opens a two-tab modal:
     • CONFIG (read-only) — the layer's live engine config as pretty JSON, with Copy.
     • CUSTOM JSON — raw JSON stored on the layer (raw_config.customJson), deep-merged
       over the engine layer's live definition: ANYTHING the renderer's layer spec allows
       (paint, layout, filter, zoom range, type — blur, dasharray, expressions, all of it).
       Applies live as you type when valid; Save persists; re-applied on every load.
   Self-contained: delete this file + its include lines to remove. */
(function () {
  "use strict";
  if (window._msLayerJson) return;
  window._msLayerJson = true;

  function db() { return (typeof MapAuth !== "undefined" && MapAuth.db) || null; }
  function tree() { return (typeof layers !== "undefined" && layers) || []; }
  function walk(cb) { (function w(a) { (a || []).forEach(function (n) { cb(n); if (n.children) w(n.children); }); })(tree()); }
  function nodeById(id) { var hit = null; walk(function (n) { if (n.id === id) hit = n; }); return hit; }
  function leafNodes() { var out = []; walk(function (n) { if (!n.children && n.id) out.push(n); }); return out; }

  // node → readable JSON: functions dropped, huge feature arrays elided, cycles guarded
  function nodeJson(node) {
    var seen = [];
    return JSON.stringify(node, function (k, v) {
      if (typeof v === "function") return undefined;
      if (k === "features" && Array.isArray(v) && v.length > 50) return "[" + v.length + " features omitted]";
      if (v && typeof v === "object") {
        if (seen.indexOf(v) !== -1) return "[circular]";
        seen.push(v);
      }
      return v;
    }, 2);
  }

  async function dbIdOf(node) {   // tileset URL carries the id; otherwise match by name
    try {
      var u = node.source && (node.source.url || (node.source.tiles && node.source.tiles[0]) || "");
      var m = String(u).match(/pmt\/[^/]+\/([0-9a-f-]{36})\//i);
      if (m) return m[1];
    } catch (e) {}
    var pid = (typeof platformProjectId !== "undefined" && platformProjectId) || window.platformProjectId;
    if (!pid) return null;
    var r = await db().from("project_layers").select("layers(id, name)").eq("project_id", pid);
    var hit = null;
    (((r && r.data) || [])).forEach(function (x) { if (x.layers && x.layers.name === node.label) hit = x.layers.id; });
    return hit;
  }

  // UNLIMITED within the renderer's layer spec (user 7/16): paint/layout keys go through the fast
  // setProperty path; ANY other key (filter, minzoom/maxzoom, type, source-layer, …) triggers a
  // remove + re-add of the layer with the custom JSON deep-merged over its live definition — so
  // everything mapbox-gl/maplibre can express (blur, dasharray, expressions, …) just works.
  // NOTE: the timeline overwrites `filter` on every slider move — a custom filter lasts until then.
  var LAYER_KEYS = ["type", "source", "source-layer", "minzoom", "maxzoom", "filter", "layout", "paint", "metadata"];
  function applyCustom(slug, cj) {
    // SANITIZE (7/16 bug): pasting a full config/node JSON must never nuke the layer — only
    // style-spec layer keys pass, and `source` only as a string (style layers reference by id)
    var clean = {};
    Object.keys(cj || {}).forEach(function (k) { if (LAYER_KEYS.indexOf(k) !== -1) clean[k] = cj[k]; });
    if (clean.source != null && typeof clean.source !== "string") delete clean.source;
    cj = clean;
    if (!Object.keys(cj).length) return 0;
    var n = 0;
    var fastOnly = Object.keys(cj).every(function (k) { return k === "paint" || k === "layout"; });
    [[typeof beforeMap !== "undefined" ? beforeMap : null, "left"], [typeof afterMap !== "undefined" ? afterMap : null, "right"]].forEach(function (pr) {
      var m = pr[0]; if (!m) return;
      var id = slug + "-" + pr[1];
      try {
        if (!m.getLayer(id)) return;
        if (fastOnly) {
          Object.keys(cj.paint || {}).forEach(function (k) { try { m.setPaintProperty(id, k, cj.paint[k]); n++; } catch (e) {} });
          Object.keys(cj.layout || {}).forEach(function (k) { try { m.setLayoutProperty(id, k, cj.layout[k]); n++; } catch (e) {} });
          return;
        }
        var st = m.getStyle(), def = null, beforeId = null;
        for (var i = 0; i < st.layers.length; i++) {
          if (st.layers[i].id === id) { def = st.layers[i]; beforeId = st.layers[i + 1] ? st.layers[i + 1].id : null; break; }
        }
        if (!def) return;
        var merged = JSON.parse(JSON.stringify(def));
        Object.keys(cj).forEach(function (k) {
          if ((k === "paint" || k === "layout") && merged[k] && typeof cj[k] === "object") {
            Object.keys(cj[k]).forEach(function (kk) { merged[k][kk] = cj[k][kk]; });
          } else merged[k] = cj[k];
        });
        merged.id = id;                                     // identity is never overridable — everything else is
        if (!cj.source) merged.source = def.source;
        m.removeLayer(id);
        // RESTORE-ON-FAILURE (7/16 bug): a merged def the renderer rejects must never cost the layer
        try { m.addLayer(merged, beforeId || undefined); n++; }
        catch (eAdd) {
          try { m.addLayer(def, beforeId || undefined); } catch (e2) {}
          console.warn("layerJson: custom JSON rejected for", id, eAdd && eAdd.message);
        }
      } catch (e) { console.warn("layerJson apply:", e && e.message); }
    });
    return n;
  }

  /* ── modal ─────────────────────────────────────────────────────────────── */
  var el = null;
  function css() {
    if (document.getElementById("msj-css")) return;
    var s = document.createElement("style");
    s.id = "msj-css";
    s.textContent =
      "#msj-modal{position:fixed;left:110px;top:60px;z-index:5001;width:520px;max-width:94vw;background:#f8f8f8;border:1px solid #d7d3e4;border-radius:10px;box-shadow:0 10px 34px rgba(40,32,80,.25);font:14px 'Source Sans Pro',Arial,sans-serif;color:#333;display:none;}" +
      "#msj-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 14px;background:#fff;border-bottom:1px solid #e4e0ef;border-radius:10px 10px 0 0;cursor:move;font-weight:700;}" +
      "#msj-x{cursor:pointer;font-size:20px;color:#8b86a3;padding:0 6px;border-radius:6px;}#msj-x:hover{background:#f1eef9;color:#4c4374;}" +
      "#msj-body{padding:12px 14px;}" +
      "#msj-tabs{display:flex;gap:6px;margin-bottom:10px;}" +
      ".msj-tab{padding:6px 12px;border:1px solid #d7d3e4;border-radius:6px;background:#fff;cursor:pointer;font:600 13px inherit;color:#6f6a87;}" +
      ".msj-tab.on{background:#efeaff;color:#4c3d8f;border-color:#b9aee0;}" +
      "#msj-sel{width:100%;padding:6px 8px;border:1px solid #ccc;border-radius:5px;font:inherit;margin-bottom:10px;background:#fff;}" +
      "#msj-view{width:100%;height:320px;box-sizing:border-box;font:12.5px Consolas,monospace;border:1px solid #d7d3e4;border-radius:6px;background:#fff;padding:8px;overflow:auto;white-space:pre;}" +
      "#msj-edit{width:100%;height:320px;box-sizing:border-box;font:12.5px Consolas,monospace;border:1px solid #d7d3e4;border-radius:6px;padding:8px;display:none;}" +
      ".msj-row{display:flex;gap:8px;margin-top:10px;align-items:center;}" +
      ".msj-btn{padding:6px 14px;border:1px solid #b9aee0;border-radius:6px;background:#efeaff;color:#4c3d8f;font:600 13px inherit;cursor:pointer;}" +
      ".msj-btn:hover{background:#e4dcff;}" +
      "#msj-status{color:#5b458f;font-weight:600;font-size:13px;min-height:18px;flex:1;}" +
      ".msj-note{color:#7a758f;font-size:12.5px;margin-top:8px;}";
    document.head.appendChild(s);
  }
  function modal() {
    if (el) return el;
    css();
    el = document.createElement("div");
    el.id = "msj-modal";
    el.innerHTML =
      '<div id="msj-head"><span>{ } Layer JSON</span><span id="msj-x">&times;</span></div>' +
      '<div id="msj-body">' +
      '<select id="msj-sel"></select>' +
      '<div id="msj-tabs"><span class="msj-tab on" data-t="view">Config (read-only)</span><span class="msj-tab" data-t="edit">Custom JSON</span></div>' +
      '<div id="msj-view"></div>' +
      '<textarea id="msj-edit" spellcheck="false"></textarea>' +
      '<div class="msj-row"><button id="msj-copy" class="msj-btn">Copy</button><button id="msj-save" class="msj-btn" style="display:none">Save & apply</button><span id="msj-status"></span></div>' +
      '<div class="msj-note">Custom JSON starts empty — type or paste here. Anything the renderer\'s layer spec allows — <b>paint, layout, filter, minzoom/maxzoom, type…</b> (blur, dasharray, expressions, all of it); other keys are ignored, and JSON the renderer rejects leaves the layer untouched. Example: <code>{"paint":{"line-color":"#ff0000","line-width":3}}</code>. Applies <b>live as you type</b> when valid; Save stores it and re-applies every load. The Config tab is copy-paste-safe as a starting point. Note: the timeline re-writes <i>filter</i> on each slider move.</div>' +
      "</div>";
    document.body.appendChild(el);
    el.querySelector("#msj-x").addEventListener("click", function () { el.style.display = "none"; });
    el.querySelector("#msj-head").addEventListener("mousedown", function (e) {
      if (e.target.id === "msj-x") return;
      e.preventDefault();
      var sx = e.clientX, sy = e.clientY, r = el.getBoundingClientRect(), ox = r.left, oy = r.top;
      function mv(ev) { el.style.left = Math.max(0, ox + ev.clientX - sx) + "px"; el.style.top = Math.max(0, oy + ev.clientY - sy) + "px"; }
      function up() { document.removeEventListener("mousemove", mv); document.removeEventListener("mouseup", up); }
      document.addEventListener("mousemove", mv); document.addEventListener("mouseup", up);
    });
    el.querySelectorAll(".msj-tab").forEach(function (t) {
      t.addEventListener("click", function () {
        el.querySelectorAll(".msj-tab").forEach(function (x) { x.classList.remove("on"); });
        t.classList.add("on");
        var edit = t.getAttribute("data-t") === "edit";
        document.getElementById("msj-view").style.display = edit ? "none" : "block";
        document.getElementById("msj-edit").style.display = edit ? "block" : "none";
        document.getElementById("msj-save").style.display = edit ? "inline-block" : "none";
        document.getElementById("msj-copy").style.display = edit ? "none" : "inline-block";
      });
    });
    el.querySelector("#msj-sel").addEventListener("change", fill);
    // live apply-as-you-type: whenever the JSON parses, it hits the map (debounced; Save persists)
    var liveT = null;
    el.querySelector("#msj-edit").addEventListener("input", function () {
      clearTimeout(liveT);
      var ta = this;
      liveT = setTimeout(function () {
        var txt = ta.value.trim();
        if (!txt) return;
        try {
          var cj = JSON.parse(txt);
          var n = applyCustom(document.getElementById("msj-sel").value, cj);
          status(n ? "Applied live (" + n + ") — Save to keep it." : "Valid JSON — nothing applicable (paint / layout / filter / zoom keys apply).");
        } catch (e) { status("…" + e.message); }
      }, 600);
    });
    el.querySelector("#msj-copy").addEventListener("click", function () {
      try { navigator.clipboard.writeText(document.getElementById("msj-view").textContent); status("Copied."); } catch (e) { status("Copy failed"); }
    });
    el.querySelector("#msj-save").addEventListener("click", save);
    return el;
  }
  function status(m) { var s = document.getElementById("msj-status"); if (s) s.textContent = m || ""; }

  async function fill() {
    var slug = document.getElementById("msj-sel").value;
    var node = nodeById(slug);
    // the read-only view is the LIVE STYLE-LAYER definition — safe to copy straight into
    // Custom JSON as a starting point (the tree-node config is not layer-spec and was the
    // 7/16 disappearing-layer trap); falls back to the node when the layer isn't on the map
    var view = "";
    try {
      var st = (typeof beforeMap !== "undefined" && beforeMap && beforeMap.getStyle) ? beforeMap.getStyle() : null;
      if (st) for (var i = 0; i < st.layers.length; i++) if (st.layers[i].id === slug + "-left") { view = JSON.stringify(st.layers[i], null, 2); break; }
    } catch (e) {}
    if (!view && node) view = nodeJson(node);
    document.getElementById("msj-view").textContent = view;
    var ta = document.getElementById("msj-edit");
    ta.value = ""; status("");
    if (!node) return;
    try {
      var lid = await dbIdOf(node);
      if (lid) {
        var r = await db().from("layers").select("raw_config").eq("id", lid).single();
        var cj = r.data && r.data.raw_config && r.data.raw_config.customJson;
        if (cj) ta.value = JSON.stringify(cj, null, 2);
        ta.setAttribute("data-lid", lid);
      } else ta.removeAttribute("data-lid");
    } catch (e) {}
  }
  async function save() {
    var slug = document.getElementById("msj-sel").value;
    var ta = document.getElementById("msj-edit");
    var lid = ta.getAttribute("data-lid");
    var txt = ta.value.trim();
    var cj = null;
    if (txt) {
      try { cj = JSON.parse(txt); } catch (e) { status("Invalid JSON: " + e.message); return; }
    }
    if (!lid) { status("This layer has no editable database row (external tileset?) — applied live only."); if (cj) applyCustom(slug, cj); return; }
    try {
      var cur = await db().from("layers").select("raw_config").eq("id", lid).single();
      var rc = (cur.data && cur.data.raw_config) || {};
      if (cj) rc.customJson = cj; else delete rc.customJson;
      var r = await db().from("layers").update({ raw_config: rc }).eq("id", lid);
      if (r.error) throw new Error(r.error.message);
      var n = cj ? applyCustom(slug, cj) : 0;
      status(cj ? "Saved — " + n + " properties applied live." : "Cleared.");
    } catch (e) { status("Save failed: " + e.message); }
  }

  function open(preferLabel) {
    modal();
    var sel = document.getElementById("msj-sel");
    var nodes = leafNodes();
    sel.innerHTML = nodes.map(function (n) { return '<option value="' + n.id + '">' + (n.label || n.id) + "</option>"; }).join("");
    if (preferLabel) nodes.forEach(function (n) { if (n.label === preferLabel) sel.value = n.id; });
    el.style.display = "block";
    fill();
  }
  window._msLayerJsonOpen = open;

  // "{ } JSON" chip in the layer panel header (next to Close) — re-injected per panel render
  function inject() {
    var close = document.getElementById("elp-close");
    if (close && !document.getElementById("msj-open")) {
      var b = document.createElement("button");
      b.id = "msj-open";
      b.textContent = "{ } JSON";
      b.title = "View this layer's config as JSON / add custom JSON";
      b.style.cssText = "flex:0 0 auto;margin-right:6px;padding:3px 9px;border:1px solid #d7d3e4;border-radius:6px;background:#f4f2fa;color:#544f6e;font:600 12px 'Source Sans Pro',Arial,sans-serif;cursor:pointer;line-height:1;";
      b.addEventListener("click", function () {
        var nameEl = document.getElementById("elp-name");
        open(nameEl ? nameEl.value : null);
      });
      close.parentNode.insertBefore(b, close);
    }
  }
  setInterval(inject, 1500);
  inject();

  // boot: re-apply every stored customJson once the engine layers exist
  var tries = 0;
  async function boot() {
    tries++;
    var pid = (typeof platformProjectId !== "undefined" && platformProjectId) || window.platformProjectId;
    if (!pid || !db() || typeof beforeMap === "undefined" || !beforeMap || !beforeMap.getLayer) { if (tries < 40) setTimeout(boot, 500); return; }
    try {
      var r = await db().from("project_layers").select("layers(id, name, raw_config)").eq("project_id", pid);
      var todo = (((r && r.data) || [])).map(function (x) { return x.layers; }).filter(function (L) { return L && L.raw_config && L.raw_config.customJson; });
      if (!todo.length) return;
      var applied = 0, waits = 0;
      (function tick() {
        todo.forEach(function (L) {
          if (L._done) return;
          var slug = null;
          walk(function (n) { if (!slug && n.label === L.name && !n.children) slug = n.id; });
          try { var u = null; walk(function (n) { if (u) return; var s = n.source && (n.source.url || (n.source.tiles && n.source.tiles[0]) || ""); if (String(s).indexOf(L.id) !== -1) u = n.id; }); if (u) slug = u; } catch (e) {}
          if (slug && beforeMap.getLayer(slug + "-left")) { applyCustom(slug, L.raw_config.customJson); L._done = true; applied++; }
        });
        if (applied < todo.length && waits++ < 40) setTimeout(tick, 700);
      })();
    } catch (e) {}
  }
  boot();
})();
