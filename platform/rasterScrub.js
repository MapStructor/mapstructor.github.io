/* rasterScrub.js — EXPERIMENTAL "instant scrub" (7/16, v4). While the timeline slider is being
   DRAGGED, converted layers render from a tiny year-encoded PNG (pixel R = build year − 1799,
   G = end year − 1799, baked at convert/Publish time by tilegen.js) — date-visibility is ONE GPU
   uniform per tick, instant at any data size. The vector layer HIDES for the drag's duration
   (and its per-frame repaint is frozen — zero wasted work while invisible); on release it
   reappears snapped to the exact release date and the raster fades. (v3's both-at-once variant
   was rejected: the opaque raster hides forward changes and exposes vector lag backward.)

   ON/OFF: the "⚡ Instant scrub" chip near the timeline — EDITOR ONLY (persisted: localStorage
   ms-raster-scrub). VIEW mode is always on with no chip (user 7/21: the public should never miss
   the speed; may become configurable later).
   REMOVE ENTIRELY: delete this file, its <script> include in map/index.html + map/editor.html,
   and the bakeYearsRaster block in platform/tilegen.js. Nothing else references it. */
(function () {
  "use strict";
  if (window.MSRasterScrub) return;
  var LS = "ms-raster-scrub";
  // the chip (and its localStorage opt-out) is an editor testing tool; viewers always scrub fast
  var IS_EDITOR = /editor\.html/i.test((location && location.pathname) || "");
  // beyond maxZoom the raster steps aside entirely (user 7/16): up close N-in-view is small, so
  // the engine's own paint-scrub animates the vector cheaply AND crisply — the raster's job is
  // the wide views where N explodes and its resolution limit doesn't show.
  var S = { on: IS_EDITOR ? localStorage.getItem(LS) !== "off" : true, maxZoom: 8.5, items: [], views: [], dragging: false, hideT: null, lastYear: 1900 };
  window.MSRasterScrub = S;

  function yearOf(unix) { var d = new Date(unix * 1000); return d.getUTCFullYear() + d.getUTCMonth() / 12; }
  function hexToRgb(h) {
    var m = /^#?([0-9a-f]{6})$/i.exec(String(h || "").trim());
    if (!m) return [0.56, 0.48, 0.88];   // fallback: the site purple
    var n = parseInt(m[1], 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }
  function cfgKey(c) {   // stable identity of a rasterYears config: first level's first tile URL + bounds
    try {
      var lv = (c.levels && c.levels[0]) || c;
      var t = (lv.tiles && lv.tiles[0]) || lv;
      return String(t.url || c.url || "") + "|" + String(c.bounds || "");
    } catch (e) { return ""; }
  }
  function slugOf(lid, cfg) {
    // standalone copies pre-resolve the slug at download time (embedded sources rewrite the tile
    // URLs, so the id-in-URL match below can't work there)
    if (Array.isArray(window.rasterScrubData)) {
      for (var i = 0; i < window.rasterScrubData.length; i++) {
        var d = window.rasterScrubData[i];
        if (d.lid === lid && d.slug) return d.slug;
      }
    }
    // converted layers carry their db id inside their tile URL (pmt/{pid}/{lid}/…) — works on
    // viewer AND editor, no dependency on editing.js internals
    try {
      var hits = [];
      (function walk(a) {
        (a || []).forEach(function (n) {
          var u = n.source && (n.source.url || (n.source.tiles && n.source.tiles[0]) || "");
          if (u && String(u).indexOf(lid) !== -1) hits.push(n);
          if (n.children) walk(n.children);
        });
      })(typeof layers !== "undefined" ? layers : []);
      if (hits.length) {
        // MULTIPLE nodes can share one tileset URL: an OUTLINE SPLIT renders from its fill's
        // tiles. Taking the FIRST hit let the fill's raster item adopt the OUTLINE's identity —
        // and its line-color — so the scrub painted the whole world BLACK (owner 8/13,
        // reproduced pixel-for-pixel on the CShapes map, outline sorted above the fill).
        // The node that OWNS this bake wins (its rasterYears IS this cfg); then any
        // non-companion node; the first hit only as a last resort.
        var want0 = cfg ? cfgKey(cfg) : "";
        var own = null, plain = null;
        hits.forEach(function (n) {
          if (!own && want0 && n.rasterYears && cfgKey(n.rasterYears) === want0) own = n;
          if (!plain && !n.outlineOf) plain = n;
        });
        return (own || plain || hits[0]).id;
      }
      // COPIED maps (7/22): cloned layers keep the SOURCE map's ids inside their tile URLs, so
      // the id-in-URL match above never hits — every checkbox/colour lookup failed and rasters
      // drew for switched-off layers, all in fallback purple. The node itself carries the same
      // rasterYears config (raw_config spreads onto nodes) — match on that instead.
      if (cfg) {
        var want = cfgKey(cfg);
        if (want) (function walk2(a) {
          (a || []).forEach(function (n) {
            if (hit) return;
            if (n.rasterYears && cfgKey(n.rasterYears) === want) hit = n.id;
            if (n.children) walk2(n.children);
          });
        })(typeof layers !== "undefined" ? layers : []);
        if (hit) return hit;
      }
    } catch (e) {}
    return null;
  }
  // deepest/last #rrggbb inside a value: a plain colour string returns itself; a categorical paint
  // EXPRESSION (['match'…] / ['case'…]) yields its last (category/fallback) colour. Before this the
  // raster only accepted a plain string, so EVERY colour-by layer dropped to the default purple
  // during scrub instead of the layer's real colour (user 7/20, quick-fix #1 — full per-category
  // colouring is still TODO). NOTE: matches #rrggbb only; named/rgb() colours still fall through.
  function hexIn(x) {
    var hit = null;
    (function walk(v) {
      if (typeof v === "string") { if (/^#[0-9a-f]{6}$/i.test(v.trim())) hit = v.trim(); }
      else if (Array.isArray(v)) v.forEach(walk);
    })(x);
    return hit;
  }
  function findNode(slug) {
    try {
      return (function find(a) { for (var i = 0; i < (a || []).length; i++) { if (a[i].id === slug) return a[i]; var c = find(a[i].children); if (c) return c; } return null; })(typeof layers !== "undefined" ? layers : []);
    } catch (e) { return null; }
  }
  function colorOf(lid, cfg) {   // the engine node's own colour, when findable (editor exposes the slug map)
    try {
      var slug = slugOf(lid, cfg);
      if (slug && typeof layers !== "undefined") {
        var node = findNode(slug);
        var p = (node && node.paint) || {};
        // TYPE-AWARE order (8/13 — "it all went black"): the node's OWN paint key first. The old
        // fixed order tried line-color before fill-color, so a FILL layer whose paint carried a
        // stray line-color (#000000 via the outline machinery) scrubbed the whole world BLACK.
        var ty = (node && node.type) || "";
        var keys = ty === "line" ? ["line-color", "fill-color", "circle-color"]
                 : ty === "circle" ? ["circle-color", "fill-color", "line-color"]
                 : ["fill-color", "circle-color", "line-color"];
        var c = hexIn(p[keys[0]]) || hexIn(p[keys[1]]) || hexIn(p[keys[2]]) || (node && hexIn(node.iconColor)) || (node && hexIn(node.color));
        if (c) return hexToRgb(c);
      }
    } catch (e) {}
    return hexToRgb(null);   // fallback: the site purple — only when nothing resolvable
  }
  function alphaOf(lid, cfg) {   // the vector's own translucency (8/14 "match the fill"): mid-drag
    // paints at the SAME opacity the at-rest layer uses, so release no longer pops brighter→dimmer.
    // Numeric paint values only — a data-driven opacity expression can't be one uniform, so those
    // layers keep the legacy 0.9. Borders never call this (they stay solid by contract).
    try {
      var slug = slugOf(lid, cfg);
      var node = slug ? findNode(slug) : null;
      var p = (node && node.paint) || {};
      var ty = (node && node.type) || "";
      var v = p[ty === "line" ? "line-opacity" : ty === "circle" ? "circle-opacity" : "fill-opacity"];
      if (typeof v === "number" && v >= 0 && v <= 1) return v;
    } catch (e) {}
    return 0.9;   // no resolvable vector opacity — the long-standing raster default
  }
  // BORDER companion raster (option B, 8/8 — "shapes are defined by their outlines"): each baked
  // polygon layer may carry cfg.borders (ring-only pyramid, same year encoding) drawn OVER the flat
  // fill so contiguous features stay distinguishable mid-drag. The border follows its OWNER: the
  // fill layer normally (shade = its fill-outline-color, default black) — but when the outline is
  // SPLIT into its own layer (fill.outlineSplit → a node with outlineOf = fill.id), the SPLIT layer
  // rules: its checkbox gates the mid-drag border, its line-color shades it. No claiming node =
  // orphaned split → ownership returns to the fill (the configLoader repair rule). Re-resolved
  // every slidestart — split/merge and recolour both happen live in a session.
  function resolveBorder(it) {
    var fillSlug = slugOf(it.fillLid, it.cfg);
    var fillNode = fillSlug ? findNode(fillSlug) : null;
    var gate = fillSlug, col = null;
    if (fillNode && fillNode.outlineSplit) {
      var O = null;
      try {
        (function walk(a) { (a || []).forEach(function (n) { if (O) return; if (n.outlineOf === fillSlug) O = n; if (n.children) walk(n.children); }); })(typeof layers !== "undefined" ? layers : []);
      } catch (e) {}
      if (O) { gate = O.toggleElement || O.id; col = hexIn((O.paint || {})["line-color"]) || hexIn(O.iconColor) || hexIn(O.color); }
    }
    if (!col) col = (fillNode && fillNode.paint && hexIn(fillNode.paint["fill-outline-color"])) || "#000000";
    it.slug = gate; it.color = hexToRgb(col);
    return it;
  }
  // a converted layer switched OFF in the sidebar must not scrub either (user 7/20). The checkbox
  // id IS the layer slug (toggleElement), and it survives hideVectors (which only flips map layer
  // visibility) — so it's a stable per-frame signal.
  // 7/22 FLIP: can't resolve → DON'T draw (was: draw). The old default made copied maps scrub
  // every baked layer at once — switched-off ones and layers no longer on the map included.
  // A raster with no matching sidebar node has no business on this map's screen.
  function itemActive(it) {
    try {
      var slug = it.isBorder ? (it.slug || resolveBorder(it).slug) : (it.slug || (it.slug = slugOf(it.lid, it.cfg)));
      if (!slug) return false;
      var cb = document.getElementById(slug);
      if (cb && cb.type === "checkbox") return !!cb.checked;
      return false;
    } catch (e) {}
    return false;
  }

  var VS = "attribute vec2 q;uniform vec2 p0,p1;varying vec2 v;void main(){v=q;vec2 px=mix(p0,p1,q);gl_Position=vec4(px.x*2.-1.,1.-px.y*2.,0.,1.);}";
  // uCov = 1 on BORDER textures. Borders draw SOLID — every texel the bake kept renders at full
  // opacity, and tilegen's border KEEP floor is the single cutoff (a reader-side threshold was
  // tried and removed: it can only subtract from what the bake shipped, and subtracting made thin
  // diagonals dotted). Coverage-as-opacity was also tried and rejected the same day: partial alpha
  // made thin lines look washed out and, because a line's texels pass the year test at slightly
  // different dates, made borders dissolve in and out instead of switching cleanly (owner:
  // "borders should instantly appear and disappear").
  var FS = "precision mediump float;varying vec2 v;uniform sampler2D t;uniform float uYear,uBase,uCov,uAlpha;uniform vec3 uCol;" +
    "void main(){vec4 s=texture2D(t,v);if(s.a<0.5)discard;float ys=uBase+s.r*255.0;float ye=uBase+s.g*255.0;" +
    // ye is a WHOLE year and uYear is fractional (year + month/12), so `uYear > ye` hid every
    // feature whose end year is the year being viewed, from February onward — at the end of the
    // CShapes span that emptied the map for most of 2019 (owner 8/8). A year-ending era lives
    // through the WHOLE of that year: alive while ys ≤ uYear < ye+1.
    // uAlpha = the layer's own paint opacity (borders force 1.0). PREMULTIPLIED (8/14): the canvas
    // composites premultiplied, and the old straight write vec4(c, 0.9) over-added — displayed
    // colour was c + 0.1·bg instead of 0.9·c + 0.1·bg, which is why mid-drag read "more vivid".
    "if(uYear<ys||uYear>=ye+1.0)discard;float a=uCov>0.5?1.0:uAlpha;" +
    "gl_FragColor=vec4(uCol*a,a);}";
  // INDEXED shader (8/9) — used only for bakes stamped cfg.indexed. The texel is an ID, not a date
  // range: id = R*65536 + G*256 + B, which indexes the LUT's row of up to 8 time stretches for that
  // exact patch of ground. A pixel can now be ON, OFF, ON — which is the whole point: the old single
  // interval drew Poland's 1918 border straight through the 1939-1945 partition.
  // HIGHP IS LOAD-BEARING: ids run to 16.7M and only highp's 24-bit mantissa holds those integers
  // exactly. mediump (10-bit minimum) would round ids together and colour ground with a stranger's
  // timeline, so the guarded #ifdef takes highp wherever the fragment stage offers it.
  var FS2 = "#ifdef GL_FRAGMENT_PRECISION_HIGH\nprecision highp float;\n#else\nprecision mediump float;\n#endif\n" +
    "varying vec2 v;uniform sampler2D t;uniform sampler2D tl;uniform sampler2D tp;uniform float uYear,uBase,uCov,uV2,uPal,uAlpha;uniform vec2 uLutSize;uniform vec3 uCol;" +
    "void main(){vec4 s=texture2D(t,v);if(s.a<0.5)discard;" +
    "float id=floor(s.r*255.0+0.5)*65536.0+floor(s.g*255.0+0.5)*256.0+floor(s.b*255.0+0.5);" +
    "if(id<0.5)discard;" +
    "float row=floor(id/256.0);float colBase=(id-row*256.0)*8.0;float vv=(row+0.5)/uLutSize.y;" +
    "for(int c=0;c<8;c++){" +
    "vec4 e=texture2D(tl,vec2((colBase+float(c)+0.5)/uLutSize.x,vv));" +
    "if(e.a*255.0<0.5)break;" +                 // alpha-0 texel = end of this pixel's stretch list;
    // any non-zero alpha is in use (it carries 255 − a future colour index, 255 today)
    // MONTH PRECISION (8/9b): B packs startMonth<<4 | endMonth, each 0-11. Whole-year stretches
    // drew a border's before AND after position for the entire year it moved in — 1880 ghost px
    // at 1920 (Trianon, 4 Jun) and 2114 at 1945 (Oder-Neisse, 8 May). Months are as fine as this
    // reader can go: uYear is the slider's own getUTCFullYear() + getUTCMonth()/12.
    "float b255=floor(e.b*255.0+0.5);float sm=floor(b255/16.0);float em=b255-sm*16.0;" +
    "float ysb=floor(e.r*255.0+0.5);float yeb=floor(e.g*255.0+0.5);" +
    "float ys=uBase+ysb+sm/12.0;float ye=uBase+yeb+em/12.0;" +
    // DATELESS = PERMANENT (8/13, "if a feature has no dates, it should be shown the whole
    // time"): on uV2 bakes, start byte 1 is the reserved "since forever" sentinel (real starts
    // begin at byte 2) and end byte 255 means "open-ended" — dateless CRN used to clamp to the
    // codec floor and vanish when the slider went below 1800.
    "if(uV2>0.5){if(ysb<1.5)ys=-1e6;if(yeb>254.5)ye=1e6;}" +
    // the 8/8 fractional-slider rule, now at month granularity: an era whose END month is the
    // viewed month lives through the WHOLE of that month, so the test is ye + one month, not
    // ye + one year. EPS is 1.2% of a month — far too small to admit or drop a month of its own,
    // large enough that a float32 rounding wobble can never make a border a month late.
    "float EPS=0.001;" +
    // PER-ERA COLOURS (8/14): the texel's alpha byte carries 255 − palette index — when this
    // bake ships a palette (uPal), the alive stretch paints in ITS OWN colour; single-colour
    // bakes (and all borders) keep uCol exactly as before.
    "if(uYear>=ys-EPS&&uYear<ye+1.0/12.0-EPS){" +
    "vec3 cc=uCol;" +
    "if(uPal>0.5){float ci=255.0-floor(e.a*255.0+0.5);cc=texture2D(tp,vec2((ci+0.5)/256.0,0.5)).rgb;}" +
    // same premultiplied uAlpha contract as the legacy shader (see FS comment)
    "float aa=uCov>0.5?1.0:uAlpha;gl_FragColor=vec4(cc*aa,aa);return;}}" +
    "discard;}";

  function makeView(m) {
    var el = m.getContainer(), cv = document.createElement("canvas");
    cv.className = "ms-raster-scrub";
    // explicit 100% size is LOAD-BEARING: without it the canvas displays at buffer size × dpr (the 7/16 offset bug)
    cv.style.cssText = "position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:2;display:none;opacity:1;transition:opacity .35s";
    el.appendChild(cv);
    var gl = cv.getContext("webgl", { alpha: true, preserveDrawingBuffer: true });
    if (!gl) return null;
    function sh(ty, src) { var s = gl.createShader(ty); gl.shaderSource(s, src); gl.compileShader(s); return s; }
    // TWO programs, one buffer: the legacy date-range shader (untouched — old bakes keep rendering
    // exactly as before) and the indexed one. Attribute "q" is bound to slot 0 in BOTH before
    // linking, so the single vertexAttribPointer set up below serves whichever is in use.
    function mkProg(fsrc) {
      var p = gl.createProgram();
      gl.attachShader(p, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fsrc));
      gl.bindAttribLocation(p, 0, "q");
      gl.linkProgram(p);
      return { pr: p, U: { year: gl.getUniformLocation(p, "uYear"), base: gl.getUniformLocation(p, "uBase"), col: gl.getUniformLocation(p, "uCol"), cov: gl.getUniformLocation(p, "uCov"), v2: gl.getUniformLocation(p, "uV2"), pal: gl.getUniformLocation(p, "uPal"), alpha: gl.getUniformLocation(p, "uAlpha"), p0: gl.getUniformLocation(p, "p0"), p1: gl.getUniformLocation(p, "p1"), lutSize: gl.getUniformLocation(p, "uLutSize") } };
    }
    var P1 = mkProg(FS), P2 = mkProg(FS2);
    // A silent link failure would draw NOTHING for indexed layers and look like "the bake is
    // missing" — say so once instead. The legacy program is unaffected either way.
    if (!gl.getProgramParameter(P2.pr, gl.LINK_STATUS)) {
      console.warn("rasterScrub: indexed shader unavailable — " + gl.getProgramInfoLog(P2.pr));
      P2 = null;
    }
    var buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    if (P2) {                                                    // index texture on unit 0, LUT on unit 1, palette on unit 2
      gl.useProgram(P2.pr);
      gl.uniform1i(gl.getUniformLocation(P2.pr, "t"), 0);
      gl.uniform1i(gl.getUniformLocation(P2.pr, "tl"), 1);
      gl.uniform1i(gl.getUniformLocation(P2.pr, "tp"), 2);
    }
    gl.useProgram(P1.pr);
    gl.clearColor(0, 0, 0, 0);
    var view = { m: m, el: el, cv: cv, gl: gl, P1: P1, P2: P2, U: P1.U, tex: {}, loading: {} };
    S.items.forEach(function (it) { ensureTex(view, it, 0, 0); if (it.cfg && it.cfg.indexed) ensureLut(view, it); });   // smallest level up-front; finer ones load on demand
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
      gl.activeTexture(gl.TEXTURE0);   // unit 1 belongs to the LUT — never bind a level over it
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
  // The LUT of an indexed bake (8/9): ONE small texture per view, keyed by its url so the fill and
  // border items of the same layer share the single fetch. Same crossOrigin + cache-buster pattern
  // as the level textures; NEAREST because a blended texel would be a blend of two unrelated
  // timelines. Returns null while it is still in flight — the item simply doesn't draw that frame.
  function ensureLut(view, it) {
    var lu = it.cfg && it.cfg.lut;
    if (!lu || !lu.url) return null;
    var key = "lut|" + lu.url;
    if (view.tex[key]) return view.tex[key];
    if (view.loading[key]) return null;
    view.loading[key] = true;
    var gl = view.gl, img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = function () {
      var tx = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tx);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      view.tex[key] = tx;
      delete view.loading[key];
      if (S.dragging && S.on) drawView(view, S.lastYear);
    };
    img.onerror = function () { delete view.loading[key]; };
    img.src = lu.url + "?v=" + encodeURIComponent(it.cfg.bakedAt || "1");
    return null;
  }
  // The PALETTE of a coloured bake (8/14): a 256×1 texture built synchronously from
  // cfg.palette — no fetch, exact bytes (raw texImage2D, no 2D-canvas premultiply round trip).
  // Unused indices repeat the base colour so a stray index can never paint garbage.
  function ensurePalette(view, it) {
    var pal = it.cfg && it.cfg.palette;
    if (!pal || !pal.length || it.isBorder) return null;
    var key = "pal|" + cfgKey(it.cfg);
    if (view.tex[key]) return view.tex[key];
    var gl = view.gl;
    function rgb(h) { var n = parseInt(String(h).replace("#", ""), 16); return isNaN(n) ? [86, 74, 154] : [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
    var data = new Uint8Array(256 * 4), base = rgb(pal[0]);
    for (var i = 0; i < 256; i++) {
      var c = i < pal.length ? rgb(pal[i]) : base;
      data[i * 4] = c[0]; data[i * 4 + 1] = c[1]; data[i * 4 + 2] = c[2]; data[i * 4 + 3] = 255;
    }
    var tx = gl.createTexture();
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, tx);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.activeTexture(gl.TEXTURE0);
    view.tex[key] = tx;
    return tx;
  }
  function pickLevel(m, it) {   // the level whose pixels ≈ the screen's pixels for this span
    var span = it.cfg.bounds[2] - it.cfg.bounds[0];
    var need = 512 * Math.pow(2, m.getZoom()) * span / 360;
    // BORDERS pick device-exact (8/8): thin lines can't afford the 0.8 fudge or a missing dpr —
    // upscaled border texels read fat and blocky at world zooms ("z2.4 and below it gets bad");
    // fills are solid area so the coarser pick never shows.
    if (it.isBorder) {
      need *= (window.devicePixelRatio || 1);
      for (var j = 0; j < it.levels.length; j++) if (it.levels[j].width >= need) return j;
      return it.levels.length - 1;
    }
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
      if (!itemActive(it)) return;   // layer unchecked in the sidebar → its raster stays dark too
      var want = pickLevel(view.m, it);
      // indexed bakes decode through the LUT program; everything else through the original one
      var idx = !!(it.cfg && it.cfg.indexed);
      if (idx && !view.P2) return;   // no indexed shader on this device — never draw ids as dates
      var lutTex = idx ? ensureLut(view, it) : null;
      if (idx && !lutTex) return;    // nothing to decode ids with yet — draws as soon as it lands
      var P = idx ? view.P2 : view.P1;
      gl.useProgram(P.pr);
      if (idx) {
        gl.uniform2f(P.U.lutSize, (it.cfg.lut && it.cfg.lut.width) || 2048, (it.cfg.lut && it.cfg.lut.height) || 1);
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, lutTex);
        // colour palette (8/14): fills of a coloured bake paint per-era colours; borders keep uCol
        var palTex = ensurePalette(view, it);
        if (P.U.pal) gl.uniform1f(P.U.pal, palTex ? 1 : 0);
        if (palTex) { gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, palTex); }
        gl.activeTexture(gl.TEXTURE0);   // level textures bind here, below
      }
      gl.uniform1f(P.U.year, year);
      gl.uniform1f(P.U.base, it.cfg.yearBase || 1799);
      gl.uniform1f(P.U.v2, it.cfg.yearsV2 ? 1 : 0);   // sentinel bytes (dateless-permanent) — uV2 is null on the legacy program, silently ignored
      gl.uniform3f(P.U.col, it.color[0], it.color[1], it.color[2]);
      gl.uniform1f(P.U.cov, it.isBorder ? 1 : 0);
      gl.uniform1f(P.U.alpha, it.isBorder ? 1 : (it.alpha == null ? 0.9 : it.alpha));
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
        gl.uniform2f(P.U.p0, g[1].x / w, g[1].y / h);
        gl.uniform2f(P.U.p1, g[2].x / w, g[2].y / h);
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
    if (_vis) return;   // already hidden — a second pass would record "none" as the prior state
    _vis = [];
    var seen = {};   // fill + border items share a slug when the outline isn't split — a second
    // pass would record "none" as the prior state and restore would leave the vector hidden
    S.items.forEach(function (it) {
      if (!it.slug || seen[it.slug]) return;
      seen[it.slug] = true;
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
    // The EDITOR OVERLAYS ride on top of the raster and carry no live date filter during a drag:
    // gl-draw has none at all, and the armed/attr highlights only re-filter inside changeDate,
    // which a scrub deliberately skips. Left alone they freeze the clicked feature on screen at
    // dates it never existed (owner 8/9: click Saudi Arabia, unclick, drag — it stayed lit at
    // 1918, seventeen years before its first era). They restore with everything else on release.
    [typeof beforeMap !== "undefined" ? beforeMap : null, typeof afterMap !== "undefined" ? afterMap : null].forEach(function (m) {
      if (!m || !m.getStyle) return;
      var ls; try { ls = (m.getStyle() || {}).layers || []; } catch (e) { return; }
      ls.forEach(function (l) {
        if (!/^(gl-draw-|editor-armed-hl|editor-attr-hl)/.test(l.id)) return;
        try {
          _vis.push([m, l.id, m.getLayoutProperty(l.id, "visibility") || "visible"]);
          m.setLayoutProperty(l.id, "visibility", "none");
        } catch (e) {}
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
    $s.on("slidestart", function (e, ui) {
      mergeNodeItems();   // published/copied maps: the DB rows may not match the rendered nodes — adopt node-carried bakes (8/13)
      if (!S.on || !S.items.length || !S.views.length) return;
      if (S.views[0].m.getZoom() > S.maxZoom) return;   // deep zoom: vector animates natively — raster stays out entirely
      // EVERY item re-resolves EVERY drag (8/13): colours change live in a session (colour-by,
      // engine edits) — a colour cached once at load can go stale, and a stale black stuck until
      // reload. resolveBorder already did this for borders; fills now match.
      S.items.forEach(function (it) { if (it.isBorder) resolveBorder(it); else { if (!it.slug) it.slug = slugOf(it.lid, it.cfg); it.color = colorOf(it.lid, it.cfg); it.alpha = alphaOf(it.lid, it.cfg); } });
      S.dragging = true; clearTimeout(S.hideT);
      // draw the CURRENT year BEFORE revealing the canvas — it otherwise flashed its stale
      // last-drag frame (looked like "all the data") for the whole click-hold until the first
      // slide event landed, then snapped (user 7/22)
      var v0 = (ui && ui.value != null) ? ui.value : (function () { try { return $s.slider("value"); } catch (e2) { return null; } })();
      if (v0 != null) S.lastYear = yearOf(v0);
      S.views.forEach(function (v) { drawView(v, S.lastYear); });
      showAll(); hideVectors();
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

  // PUBLISHED / COPIED maps (8/13): the DB's live project_layers rows can name DIFFERENT layer
  // ids than the nodes this page actually renders (a published viewer renders the snapshot's
  // layers) — every slug lookup missed and the scrub was a silent NO-OP for the public. The
  // rendered nodes carry their own rasterYears (raw_config spreads onto nodes), so adopt any
  // node bake the DB pass didn't cover. Idempotent (cfgKey-deduped); called at load AND at every
  // slidestart (the layers global may not exist yet at load time).
  function mergeNodeItems() {
    try {
      if (typeof layers === "undefined") return;
      var have = {};
      S.items.forEach(function (it) { var k = cfgKey(it.cfg); if (k) have[k] = 1; });
      var add = [];
      (function walk(a) {
        (a || []).forEach(function (n) {
          var ry = n.rasterYears;
          if (ry && (ry.url || ry.levels) && ry.bounds) {
            var k = cfgKey(ry);
            if (k && !have[k]) {
              have[k] = 1;
              var lid = n._layerDbId || n._dataLayerId || n.id;
              add.push({ lid: lid, cfg: ry, color: colorOf(lid, ry), alpha: alphaOf(lid, ry), slug: n.id,
                levels: (ry.levels || [{ url: ry.url, width: ry.width, height: ry.height }]).map(function (lv) {
                  return { width: lv.width, height: lv.height, tiles: lv.tiles || [{ url: lv.url, bounds: ry.bounds }] };
                }) });
              if (ry.borders && ry.borders.levels && ry.borders.levels.length) add.push({
                lid: lid + "|b", fillLid: lid, isBorder: true, cfg: ry, slug: null, color: [0, 0, 0],
                levels: ry.borders.levels.map(function (lv) {
                  return { width: lv.width, height: lv.height, tiles: lv.tiles || [{ url: lv.url, bounds: ry.bounds }] };
                }) });
            }
          }
          if (n.children) walk(n.children);
        });
      })(layers);
      if (add.length) {
        add.forEach(function (it) { S.items.push(it); });
        S.views.forEach(function (v) { add.forEach(function (it) { ensureTex(v, it, 0, 0); if (it.cfg && it.cfg.indexed) ensureLut(v, it); }); });
      }
    } catch (e) {}
  }

  var _pid = null;
  async function buildItems(pid) {
    // standalone downloads carry the baked configs as a generated global (URLs point at files
    // inside the zip) — same rows the platform reads from Supabase, no MapAuth/db needed
    var rows;
    if (Array.isArray(window.rasterScrubData)) {
      rows = window.rasterScrubData.map(function (d) { return { layers: { id: d.lid, raw_config: { rasterYears: d.cfg } } }; });
    } else {
      var r = await MapAuth.db.from("project_layers").select("layers(id, raw_config)").eq("project_id", pid);
      rows = (r && r.data) || [];
    }
    var items = [];
    var borderItems = [];   // appended AFTER every fill item — array order is draw order, borders sit on top
    rows.forEach(function (row) {
      var L = row.layers, ry = L && L.raw_config && L.raw_config.rasterYears;
      if (ry && ry.isBorder && ry.levels && ry.bounds) {   // standalone copies ship border items FLAT (download.js marker)
        borderItems.push({
          lid: L.id, fillLid: ry.fillLid, isBorder: true, cfg: ry, slug: null, color: [0, 0, 0],
          levels: ry.levels.map(function (lv) {
            return { width: lv.width, height: lv.height, tiles: lv.tiles || [{ url: lv.url, bounds: ry.bounds }] };
          })
        });
        return;
      }
      // A feature-count threshold briefly lived here (8/7): "small tilesets scrub as vectors".
      // WRONG CALL, reverted the same day — it silently refused the owner's own baked raster on
      // an 8,695-feature world map ("Should be instantaneous with baked raster. Looks like there
      // isn't one" — they even re-baked it, and this line threw the bake away). Whether a layer
      // has an instant-scrub raster is decided where it is BAKED, not second-guessed at load: if
      // a bake exists, the person who made it wanted it.
      if (ry && (ry.url || ry.levels) && ry.bounds) items.push({
        lid: L.id, cfg: ry, color: colorOf(L.id, ry), alpha: alphaOf(L.id, ry), slug: slugOf(L.id, ry),
        // every level normalizes to a TILE LIST: whole-image levels = one tile with the full
        // bounds; the finest level ships real quadrant tiles (pre-pyramid bakes still work)
        levels: (ry.levels || [{ url: ry.url, width: ry.width, height: ry.height }]).map(function (lv) {
          return { width: lv.width, height: lv.height, tiles: lv.tiles || [{ url: lv.url, bounds: ry.bounds }] };
        })
      });
      if (ry && ry.borders && ry.borders.levels && ry.borders.levels.length && ry.bounds) borderItems.push({
        lid: L.id + "|b", fillLid: L.id, isBorder: true, cfg: ry, slug: null, color: [0, 0, 0],
        levels: ry.borders.levels.map(function (lv) {
          return { width: lv.width, height: lv.height, tiles: lv.tiles || [{ url: lv.url, bounds: ry.bounds }] };
        })
      });
    });
    borderItems.forEach(function (bi) { items.push(bi); });
    return items;
  }

  async function load(pid) {
    _pid = pid;
    S.items = await buildItems(pid);
    mergeNodeItems();
    if (!S.items.length) return;   // nothing baked yet — the next convert/Publish bakes one per tiled layer
    [typeof beforeMap !== "undefined" ? beforeMap : null, typeof afterMap !== "undefined" ? afterMap : null].forEach(function (m) {
      if (m && m.getContainer) { var v = makeView(m); if (v) S.views.push(v); }
    });
    if (!S.views.length) return;
    if (IS_EDITOR) chip();
    hook();
  }

  // RELOAD after a bake (8/13, "I rebaked, it all went black"): nothing told the running scrub
  // that a re-bake replaced (and deleted) its artifacts, so the session kept drawing from stale
  // configs and textures until a page reload. tilegen calls this when a bake lands; items and
  // the smallest textures rebuild from the fresh configs (stale GPU textures are keyed by the
  // old URLs and simply never referenced again).
  S.reload = async function () {
    try {
      if (_pid == null && !Array.isArray(window.rasterScrubData)) return;
      var fresh = await buildItems(_pid);
      S.items.length = 0;
      fresh.forEach(function (it) { S.items.push(it); });
      mergeNodeItems();
      if (S.items.length && !S.views.length) {   // first-ever bake this session: views/hook don't exist yet
        [typeof beforeMap !== "undefined" ? beforeMap : null, typeof afterMap !== "undefined" ? afterMap : null].forEach(function (m) {
          if (m && m.getContainer) { var v = makeView(m); if (v) S.views.push(v); }
        });
        if (S.views.length) { if (IS_EDITOR) chip(); hook(); }
        return;
      }
      S.views.forEach(function (v) {
        S.items.forEach(function (it) { ensureTex(v, it, 0, 0); if (it.cfg && it.cfg.indexed) ensureLut(v, it); });
      });
    } catch (e) { console.warn("rasterScrub: reload failed", e && e.message); }
  };

  var tries = 0;
  function boot() {
    tries++;
    var pid = (typeof platformProjectId !== "undefined" && platformProjectId) ? platformProjectId : window.platformProjectId;
    var staticData = Array.isArray(window.rasterScrubData);   // standalone copy: no Supabase, no project id
    var needPlatform = !staticData && (!pid || typeof MapAuth === "undefined" || !MapAuth.db);
    if (needPlatform || typeof $ === "undefined" || !$.fn || typeof beforeMap === "undefined" || !beforeMap || !beforeMap.getContainer) {
      if (tries < 40) setTimeout(boot, 500);   // static maps without baked data never qualify — boot gives up quietly
      return;
    }
    load(pid).catch(function (e) { console.warn("rasterScrub: disabled (" + (e && e.message) + ")"); });
  }
  boot();
})();
