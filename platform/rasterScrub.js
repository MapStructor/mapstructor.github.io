/* rasterScrub.js — EXPERIMENTAL "instant scrub" (7/16, v4). While the timeline slider is being
   DRAGGED, converted layers render from a tiny year-encoded PNG (pixel R = build year − 1799,
   G = end year − 1799, baked at convert/Publish time by tilegen.js) — date-visibility is ONE GPU
   uniform per tick, instant at any data size. The vector layer HIDES for the drag's duration
   (and its per-frame repaint is frozen — zero wasted work while invisible); on release it
   reappears snapped to the exact release date and the raster fades. (v3's both-at-once variant
   was rejected: the opaque raster hides forward changes and exposes vector lag backward.)

   ON/OFF: the "⚡ Instant scrub" chip near the timeline (persisted: localStorage ms-raster-scrub).
   REMOVE ENTIRELY: delete this file, its <script> include in map/index.html + map/editor.html,
   and the bakeYearsRaster block in platform/tilegen.js. Nothing else references it. */
(function () {
  "use strict";
  if (window.MSRasterScrub) return;
  var LS = "ms-raster-scrub";
  // beyond maxZoom the raster steps aside entirely (user 7/16): up close N-in-view is small, so
  // the engine's own paint-scrub animates the vector cheaply AND crisply — the raster's job is
  // the wide views where N explodes and its resolution limit doesn't show.
  var S = { on: localStorage.getItem(LS) !== "off", maxZoom: 8.5, items: [], views: [], dragging: false, hideT: null, lastYear: 1900 };
  window.MSRasterScrub = S;

  function yearOf(unix) { var d = new Date(unix * 1000); return d.getUTCFullYear() + d.getUTCMonth() / 12; }
  function hexToRgb(h) {
    var m = /^#?([0-9a-f]{6})$/i.exec(String(h || "").trim());
    if (!m) return [0.56, 0.48, 0.88];   // fallback: the site purple
    var n = parseInt(m[1], 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }
  function slugOf(lid) {
    // converted layers carry their db id inside their tile URL (pmt/{pid}/{lid}/…) — works on
    // viewer AND editor, no dependency on editing.js internals
    try {
      var hit = null;
      (function walk(a) {
        (a || []).forEach(function (n) {
          if (hit) return;
          var u = n.source && (n.source.url || (n.source.tiles && n.source.tiles[0]) || "");
          if (u && String(u).indexOf(lid) !== -1) hit = n.id;
          if (n.children) walk(n.children);
        });
      })(typeof layers !== "undefined" ? layers : []);
      if (hit) return hit;
    } catch (e) {}
    return null;
  }
  function colorOf(lid) {   // the engine node's own colour, when findable (editor exposes the slug map)
    try {
      var slug = slugOf(lid);
      if (slug && typeof layers !== "undefined") {
        var node = (function find(a) { for (var i = 0; i < (a || []).length; i++) { if (a[i].id === slug) return a[i]; var c = find(a[i].children); if (c) return c; } return null; })(layers);
        var p = (node && node.paint) || {};
        var c = p["line-color"] || p["fill-color"] || p["circle-color"] || (node && node.color);
        if (typeof c === "string") return hexToRgb(c);
      }
    } catch (e) {}
    return hexToRgb(null);
  }

  var VS = "attribute vec2 q;uniform vec2 p0,p1;varying vec2 v;void main(){v=q;vec2 px=mix(p0,p1,q);gl_Position=vec4(px.x*2.-1.,1.-px.y*2.,0.,1.);}";
  var FS = "precision mediump float;varying vec2 v;uniform sampler2D t;uniform float uYear,uBase;uniform vec3 uCol;" +
    "void main(){vec4 s=texture2D(t,v);if(s.a<0.5)discard;float ys=uBase+s.r*255.0;float ye=uBase+s.g*255.0;" +
    "if(uYear<ys||uYear>ye)discard;gl_FragColor=vec4(uCol,0.9);}";

  function makeView(m) {
    var el = m.getContainer(), cv = document.createElement("canvas");
    cv.className = "ms-raster-scrub";
    // explicit 100% size is LOAD-BEARING: without it the canvas displays at buffer size × dpr (the 7/16 offset bug)
    cv.style.cssText = "position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:2;display:none;opacity:1;transition:opacity .35s";
    el.appendChild(cv);
    var gl = cv.getContext("webgl", { alpha: true, preserveDrawingBuffer: true });
    if (!gl) return null;
    function sh(ty, src) { var s = gl.createShader(ty); gl.shaderSource(s, src); gl.compileShader(s); return s; }
    var pr = gl.createProgram();
    gl.attachShader(pr, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(pr); gl.useProgram(pr);
    var buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    var loc = gl.getAttribLocation(pr, "q");
    gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    var U = { year: gl.getUniformLocation(pr, "uYear"), base: gl.getUniformLocation(pr, "uBase"), col: gl.getUniformLocation(pr, "uCol"), p0: gl.getUniformLocation(pr, "p0"), p1: gl.getUniformLocation(pr, "p1") };
    gl.clearColor(0, 0, 0, 0);
    var view = { m: m, el: el, cv: cv, gl: gl, U: U, tex: {}, loading: {} };
    S.items.forEach(function (it) { ensureTex(view, it, 0, 0); });   // smallest level up-front; finer ones load on demand
    m.on("render", function () { if (S.dragging && S.on) drawView(view, S.lastYear); });   // stay glued through pans mid-drag
    // PREFETCH the level this view will actually want whenever the map comes to rest — without
    // this, the first click on the slider draws the fat coarse level until finer textures land
    // (the "thickness explodes, then reduces" report, 7/16)
    m.on("idle", function () { if (S.on) prefetchWanted(view); });
    return view;
  }
  function prefetchWanted(view) {
    var el = view.el, w = el.clientWidth, h = el.clientHeight;
    if (!w || !h || view.m.getZoom() > S.maxZoom) return;   // deep zoom never draws the raster — don't load for it
    S.items.forEach(function (it) {
      var want = Math.min(pickLevel(view.m, it), it.levels.length - 1);
      var tiles = it.levels[want].tiles;
      for (var ti = 0; ti < tiles.length; ti++) {
        var B = tiles[ti].bounds;
        var nw = view.m.project([B[0], B[3]]), se = view.m.project([B[2], B[1]]);
        if (se.x > 0 && nw.x < w && se.y > 0 && nw.y < h) ensureTex(view, it, want, ti);
      }
    });
  }

  // PYRAMID (7/16): textures load lazily per (item, level, tile) — zooming in pulls the finer
  // bake the first time it's needed; until it arrives coarser levels keep drawing underneath.
  function ensureTex(view, it, li, ti) {
    var key = it.lid + "|" + li + "|" + ti;
    var lv = it.levels[li], tile = lv && lv.tiles[ti];
    if (!tile || view.tex[key] || view.loading[key]) return;
    view.loading[key] = true;
    var gl = view.gl, img = new Image();
    img.crossOrigin = "anonymous";   // storage is public + CORS * — required for WebGL textures
    img.onload = function () {
      var tx = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tx);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);   // exact year values — never blend
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      view.tex[key] = tx;
      delete view.loading[key];
      if (S.dragging && S.on) drawView(view, S.lastYear);   // sharpen mid-drag as soon as it lands
    };
    img.onerror = function () { delete view.loading[key]; };
    img.src = tile.url + "?v=" + encodeURIComponent(it.cfg.bakedAt || "1");   // fresh after every re-bake
  }
  function pickLevel(m, it) {   // the level whose pixels ≈ the screen's pixels for this span
    var span = it.cfg.bounds[2] - it.cfg.bounds[0];
    var need = 512 * Math.pow(2, m.getZoom()) * span / 360;
    for (var i = 0; i < it.levels.length; i++) if (it.levels[i].width >= need * 0.8) return i;
    return it.levels.length - 1;
  }

  function drawView(view, year) {
    var cv = view.cv, el = view.el, dpr = window.devicePixelRatio || 1;
    var w = el.clientWidth, h = el.clientHeight;
    if (!w || !h) return;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    var gl = view.gl;
    gl.viewport(0, 0, cv.width, cv.height);
    gl.clear(gl.COLOR_BUFFER_BIT);
    S.items.forEach(function (it) {
      var want = pickLevel(view.m, it);
      gl.uniform1f(view.U.year, year);
      gl.uniform1f(view.U.base, it.cfg.yearBase || 1799);
      gl.uniform3f(view.U.col, it.color[0], it.color[1], it.color[2]);
      // Draw exactly ONE level: the finest whose visible tiles are ALL loaded. NEVER stack levels —
      // fine levels are transparent where there's no ink, so a coarse level underneath shows
      // through as giant solid blobs (the 7/16 purple-flood bug). Loads ladder upward: every
      // level ≤ wanted kicks its visible tiles, so quality climbs level by level as they land.
      var use = -1, geom = [];
      for (var li = 0; li <= want && li < it.levels.length; li++) {
        var tiles = it.levels[li].tiles, all = true, vis = [];
        for (var ti = 0; ti < tiles.length; ti++) {
          var B = tiles[ti].bounds;
          var nw = view.m.project([B[0], B[3]]), se = view.m.project([B[2], B[1]]);
          if (!(se.x > 0 && nw.x < w && se.y > 0 && nw.y < h)) continue;   // offscreen — never loaded, never drawn
          ensureTex(view, it, li, ti);
          if (view.tex[it.lid + "|" + li + "|" + ti]) vis.push([ti, nw, se]);
          else all = false;
        }
        if (all && vis.length) { use = li; geom = vis; }
      }
      if (use === -1) return;
      S._lastLevel = it.levels[use].width;   // debug/verification seam
      geom.forEach(function (g) {
        gl.bindTexture(gl.TEXTURE_2D, view.tex[it.lid + "|" + use + "|" + g[0]]);
        gl.uniform2f(view.U.p0, g[1].x / w, g[1].y / h);
        gl.uniform2f(view.U.p1, g[2].x / w, g[2].y / h);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      });
    });
  }

  function showAll() { S.views.forEach(function (v) { v.cv.style.display = "block"; v.cv.style.opacity = "1"; }); }
  function hideAllSoon() {
    clearTimeout(S.hideT);
    S.hideT = setTimeout(function () {
      S.views.forEach(function (v) {
        v.cv.style.opacity = "0";
        setTimeout(function () { if (!S.dragging) v.cv.style.display = "none"; }, 380);
      });
    }, 350);   // give the real filter a beat to land, then fade — the hand-off illusion
  }

  // v4: during the drag the raster answers ALONE — the tiled layers hide (ONE visibility flip,
  // previous state saved/restored exactly) and paintDate freezes (no point repainting an
  // invisible layer). On release the engine snaps the vector to the release date, it reappears,
  // and the raster fades.
  var _vis = null, _paint = null;
  function hideVectors() {
    _vis = [];
    S.items.forEach(function (it) {
      if (!it.slug) return;
      [[typeof beforeMap !== "undefined" ? beforeMap : null, "left"], [typeof afterMap !== "undefined" ? afterMap : null, "right"]].forEach(function (pr) {
        var m = pr[0]; if (!m) return;
        [it.slug + "-" + pr[1], it.slug + "-stroke-" + pr[1], it.slug + "-highlighted-" + pr[1], it.slug + "-label-" + pr[1]].forEach(function (id) {
          try {
            if (!m.getLayer(id)) return;
            _vis.push([m, id, m.getLayoutProperty(id, "visibility") || "visible"]);
            m.setLayoutProperty(id, "visibility", "none");
          } catch (e) {}
        });
      });
    });
    if (typeof window.paintDate === "function" && !_paint) { _paint = window.paintDate; window.paintDate = function () {}; }
  }
  function restoreVectors() {
    (_vis || []).forEach(function (t) { try { t[0].setLayoutProperty(t[1], "visibility", t[2]); } catch (e) {} });
    _vis = null;
    if (_paint) { window.paintDate = _paint; _paint = null; }
  }

  function fadeSoon() {
    clearTimeout(S.hideT);
    S.hideT = setTimeout(function () {
      S.views.forEach(function (v) {
        v.cv.style.opacity = "0";
        setTimeout(function () { if (!S.dragging) v.cv.style.display = "none"; }, 380);
      });
    }, 120);
  }

  function hook() {
    var $s = $("#slider");
    $s.on("slidestart", function () {
      if (!S.on || !S.items.length || !S.views.length) return;
      if (S.views[0].m.getZoom() > S.maxZoom) return;   // deep zoom: vector animates natively — raster stays out entirely
      S.items.forEach(function (it) { if (!it.slug) { it.slug = slugOf(it.lid); it.color = colorOf(it.lid); } });   // slug map may not exist at load time
      S.dragging = true; clearTimeout(S.hideT); showAll(); hideVectors();
    });
    $s.on("slide", function (e, ui) {
      if (!S.on || !S.dragging || !ui) return;
      S.lastYear = yearOf(ui.value);
      S.views.forEach(function (v) { drawView(v, S.lastYear); });
    });
    $s.on("slidestop slidechange", function () {
      restoreVectors();   // vector reappears snapped to the release date (engine applies the real filter)
      if (!S.dragging) return;
      S.dragging = false;
      fadeSoon();
    });
  }

  function chip() {
    if (document.getElementById("ms-raster-chip")) return;
    var d = document.createElement("label");
    d.id = "ms-raster-chip";
    d.style.cssText = "position:fixed;right:14px;bottom:64px;z-index:4000;background:rgba(30,27,43,.92);color:#e8e5f2;font:12.5px/1 'Segoe UI',sans-serif;padding:7px 11px;border-radius:99px;border:1px solid #4a4368;cursor:pointer;user-select:none;display:flex;gap:6px;align-items:center";
    d.innerHTML = '<input type="checkbox" style="accent-color:#8f7ae0;margin:0"' + (S.on ? " checked" : "") + '>⚡ Instant scrub';
    document.body.appendChild(d);
    d.querySelector("input").addEventListener("change", function () {
      S.on = this.checked;
      localStorage.setItem(LS, S.on ? "on" : "off");
      if (!S.on) {   // turning off mid-drag must leave nothing hidden or frozen
        S.views.forEach(function (v) { v.cv.style.display = "none"; });
        restoreVectors();
        S.dragging = false;
      }
    });
  }

  async function load(pid) {
    var db = MapAuth.db;
    var r = await db.from("project_layers").select("layers(id, raw_config)").eq("project_id", pid);
    ((r && r.data) || []).forEach(function (row) {
      var L = row.layers, ry = L && L.raw_config && L.raw_config.rasterYears;
      if (ry && (ry.url || ry.levels) && ry.bounds) S.items.push({
        lid: L.id, cfg: ry, color: colorOf(L.id), slug: slugOf(L.id),
        // every level normalizes to a TILE LIST: whole-image levels = one tile with the full
        // bounds; the finest level ships real quadrant tiles (pre-pyramid bakes still work)
        levels: (ry.levels || [{ url: ry.url, width: ry.width, height: ry.height }]).map(function (lv) {
          return { width: lv.width, height: lv.height, tiles: lv.tiles || [{ url: lv.url, bounds: ry.bounds }] };
        })
      });
    });
    if (!S.items.length) return;   // nothing baked yet — the next convert/Publish bakes one per tiled layer
    [typeof beforeMap !== "undefined" ? beforeMap : null, typeof afterMap !== "undefined" ? afterMap : null].forEach(function (m) {
      if (m && m.getContainer) { var v = makeView(m); if (v) S.views.push(v); }
    });
    if (!S.views.length) return;
    chip(); hook();
  }

  var tries = 0;
  function boot() {
    tries++;
    var pid = (typeof platformProjectId !== "undefined" && platformProjectId) ? platformProjectId : window.platformProjectId;
    if (!pid || typeof MapAuth === "undefined" || !MapAuth.db || typeof $ === "undefined" || !$.fn || typeof beforeMap === "undefined" || !beforeMap || !beforeMap.getContainer) {
      if (tries < 40) setTimeout(boot, 500);   // static maps never qualify — boot gives up quietly
      return;
    }
    load(pid).catch(function (e) { console.warn("rasterScrub: disabled (" + (e && e.message) + ")"); });
  }
  boot();
})();
