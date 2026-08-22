/* keymatch-ok: rasterYears.borders — border bakes only (8 of 34); a fill-only bake has no borders
   layer and the absence is the feature working. */
/* rasterScrub.js — EXPERIMENTAL "instant scrub" (7/16, v4). While the timeline slider is being
   DRAGGED, converted layers render from a tiny year-encoded PNG (pixel R = build year − 1799,
   G = end year − 1799, baked at convert/Publish time by tilegen.js) — date-visibility is ONE GPU
   uniform per tick, instant at any data size. The vector layer HIDES for the drag's duration
   (and its per-frame repaint is frozen — zero wasted work while invisible); on release it
   reappears snapped to the exact release date and the raster fades. (v3's both-at-once variant
   was rejected: the opaque raster hides forward changes and exposes vector lag backward.)

   8/17 — THIS FILE IS NOW THE SEAM, NOT THE ONLY RENDERER. It picks who draws the drag:
   deck.gl (platform/deckScrub.js) → the baked raster below (this file) → the engine's own paint
   scrub (nobody intercepts). The one-word swap back to the pure mapbox-gl timeline lives at the top
   of deckScrub.js.
   WHO CHOOSES (8/17): each LAYER does, in the "Make Faster" section of its panel — raw_config.fast
   = { raster, deck }, written by editing.js and read here (rasterOptedIn) and in deckScrub
   (deckOptedIn). Neither ticked = the engine draws the drag, exact and animated. Nothing bakes by
   itself any more: the owner asks for a snapshot with the panel's Bake button, because "baking takes
   a lot of time often, and it has to be redone". Absent `fast` on a layer that already HAS a bake
   counts as raster ON, so no pre-8/17 map needed migrating.
   NO UI OF ITS OWN (owner 8/17: "Get rid of this"). The ⚡ chip is deleted — the layer panel is the
   one place a renderer is chosen. Every page, editor and viewer alike, runs mode "layer": with no
   `fast` key a baked layer scrubs from its raster and everything else animates through the engine,
   which is exactly the arrangement that shipped before any of the deck work.
   REMOVE ENTIRELY: delete this file, its <script> include in map/index.html + map/editor.html,
   and the bakeYearsRaster block in platform/tilegen.js. Nothing else references it. */

/* keymatch-ok: rasterYears.lw · keymatch-ok: rasterYears.isBorder · keymatch-ok: rasterYears.fillLid
   · keymatch-ok: rasterYears.thin — these are read off `it.cfg`, the scrub item's RUNTIME object,
   which is rasterYears plus fields assembled here and by download.js at export time. They are
   correctly absent from the stored config; find-key-mismatch compares against stored shape and
   cannot see that distinction. */

(function () {
  "use strict";
  if (window.MSRasterScrub) return;
  var LS = "ms-timeline";   // legacy key — cleared on every load, never read again (see readMode)
  function codeDefault() { return (window.MSDeckScrub && MSDeckScrub.mode) || "layer"; }
  // The two OLD chip keys are deliberately NOT migrated (8/17): they were comparison toggles, and
  // the owner had left both "off" from an A/B the night before. Reading them as a preference put
  // them on the legacy mapbox path on the very load that was supposed to swap it out — "it's slower
  // than ever", correctly, because it WAS the old scrub. A stale experiment must never outvote the
  // shipped default; the keys are cleared so nothing can read them again.
  // "layer" is THE mode — each layer decides in its panel's "Make Faster" section. The five forced
  // ids below it no longer appear anywhere in the UI; they survive as a console A/B seam
  // (MSRasterScrub.setMode("deck")) because the renderers still branch on them.
  var MODES = [
    { id: "layer", label: "Per layer (panel)" },
    { id: "deck", label: "Deck only" },
    { id: "raster", label: "Raster only" },
    { id: "mapbox", label: "Mapbox only" },
    { id: "deck+raster", label: "Deck + Raster" },
    { id: "mapbox+raster", label: "Mapbox + Raster" }
  ];
  // isMode() removed 8/21: unreferenced helper.
  function wantsDeck(m) { return m === "layer" || m === "deck" || m === "deck+raster"; }
  function wantsRaster(m) { return m === "layer" || m === "raster" || m === "deck+raster" || m === "mapbox+raster"; }
  // "layer" is absent here on purpose: hiding is already scoped to the slugs a fast renderer
  // actually claimed (hideVectors(slugs) → __msScrubOwned), so every layer that opted out keeps
  // animating through the engine while the ones that opted in hand over. That per-slug handoff is
  // what makes a mixed map work at all.
  function keepsVectors(m) { return m === "mapbox" || m === "mapbox+raster"; }   // mapbox paints them live
  // The raster half of the same opt-in rule deckScrub.js applies to deck. Absent fast = never
  // chosen, and for a layer that ALREADY carries a bake that reads as ON — the 8/7 rule ("if a bake
  // exists, the person who made it wanted it") survives intact, so no pre-8/17 map needs migrating.
  // An explicit untick is still obeyed: the bake is kept on disk, just not used.
  function rasterOptedIn(rc) {
    if (!rc) return false;
    return rc.fast ? !!rc.fast.raster : !!rc.rasterYears;
  }
  // NOTHING PERSISTS A MODE (8/17). The old keys made a leftover comparison toggle silently decide
  // which renderer ran — on the very load that was meant to prove a change ("slower than ever").
  // They are removed, not read, and every load starts from what the layers themselves say.
  function readMode() {
    try { localStorage.removeItem("ms-raster-scrub"); localStorage.removeItem("ms-deck-scrub"); localStorage.removeItem(LS); } catch (e0) {}
    return codeDefault();
  }
  // beyond maxZoom the raster steps aside entirely (user 7/16): up close N-in-view is small, so
  // the engine's own paint-scrub animates the vector cheaply AND crisply — the raster's job is
  // the wide views where N explodes and its resolution limit doesn't show. (deck has no such
  // limit — it scrubs the real geometry at every zoom.)
  var S = { mode: readMode(), maxZoom: 8.5, items: [], views: [], dragging: false, hideT: null, lastYear: 1900 };
  S.on = S.mode !== "mapbox";   // "is a fast renderer intercepting the drag at all"
  window.MSRasterScrub = S;
  // console seam for renderer A/B now that the chip is gone (see the note above chip's old home)
  setTimeout(function () { try { S.setMode = setMode; } catch (e) {} }, 0);

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
        // `hit` was UNDECLARED here (8/16, "scrubbing is not working"): the first read threw a
        // ReferenceError the outer catch swallowed, so this whole fallback silently returned null
        // for every copied layer — their rasters refused to draw AND their vectors never hid,
        // leaving the picture frozen at the press-down date until release.
        var hit = null;
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
      if (O) { gate = O.toggleElement || O.id; col = hexIn((O.paint || {})["line-color"]) || hexIn(O.iconColor) || hexIn(O.color); it.catBorder = Array.isArray((O.paint || {})["line-color"]); }
    }
    if (!col) col = (fillNode && fillNode.paint && hexIn(fillNode.paint["fill-outline-color"])) || "#000000";
    // CATEGORICAL BORDERS (8/16, "It's still not working for the borders… when I press down, it's
    // blue. Same issue was there for cshapes"): a match-fill / colour-by outline carries a match
    // EXPRESSION in line-color — hexIn can't read one, so the border item fell back to a uniform
    // and mid-drag borders lost their categories while the fills kept theirs. When the owning
    // line paint is an expression, the border draws through the SAME palette the fills use (the
    // LUT colour byte is shared — one id space, one palette). Honest limit: the baked indices
    // encode the FILL's category colours, so an outline given a DIFFERENT mapping than its fill
    // shows the fill's colours mid-drag; release renders the truth.
    it.catBorder = !!it.catBorder || Array.isArray(fillNode && fillNode.paint && fillNode.paint["fill-outline-color"]);
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
    "if(uV2>0.5){if(ysb<1.5)ys=-1e6;if(yeb>254.5)ye=1e6;}" +   // cliff-ok: GLSL source — 254.5 is a byte-value boundary in the shader, not a data limit
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

  /* ── WHERE THE BAKE LIVES IN THE STACK (8/18) ───────────────────────────────────────────────
     This used to render into its OWN canvas, appended over the map container at z-index 2. A
     sibling canvas is above the ENTIRE map canvas by construction, so the bake covered the
     labels — including its own layer's labels — and no DOM ordering could fix it, because labels
     are drawn inside the map's single canvas ("the bake should be at the same level in the stack
     as its original layer. When I scrub, the bake layer appears above the labels").
     So the renderer now lives in the MAP's GL context as a custom layer, inserted directly above
     the topmost vector layer it owns. Everything above that — other layers, every label layer —
     draws over it, exactly as it does over the vectors the bake stands in for.
     The shaders did not have to change: geometry was always normalized SCREEN space (m.project()
     → p0/p1 in 0..1), never a projection matrix, so the same quad works in any viewport. What
     goes away is the canvas, its resize dance, gl.clear(), and the CSS opacity fade — a custom
     layer cannot fade with CSS, and it does not need to: the vectors are restored in the same
     frame the bake stops drawing. */
  function buildGL(view, gl) {
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
    view.gl = gl; view.P1 = P1; view.P2 = P2; view.U = P1.U; view.buf = buf;
    return true;
  }

  // The layer id immediately ABOVE the topmost vector layer this bake stands in for. Companions
  // (-stroke-, -label-) of an owned layer sit above its base layer, so this lands the bake under
  // its own labels, which is the whole point.
  function ownedBeforeId(view) {
    try {
      var layers = view.m.getStyle().layers, sfx = "-" + view.side, owned = {}, top = -1;
      S.items.forEach(function (it) { if (it.slug) owned[it.slug + sfx] = 1; });
      for (var i = 0; i < layers.length; i++) if (owned[layers[i].id]) top = i;
      if (top < 0) return null;
      for (var j = top + 1; j < layers.length; j++) if (layers[j].id !== view.layer.id) return layers[j].id;
      return null;   // the layers it owns are already the topmost — nothing to sit under
    } catch (e) { return null; }
  }
  // If no owned layer id matched (a published copy whose slugs differ, a layer not yet added), the
  // old code returned null and the bake was added ON TOP OF EVERYTHING — the exact symptom the
  // owner reported. Falling back to the first label layer keeps labels readable no matter what.
  function firstLabelId(view) {
    try {
      var layers = view.m.getStyle().layers, sfx = "-label-" + view.side;
      for (var i = 0; i < layers.length; i++) if (layers[i].id.indexOf(sfx) > -1) return layers[i].id;
      return null;
    } catch (e) { return null; }
  }
  // Present, and in the right place. Re-checked at every slidestart because a basemap switch drops
  // custom layers and because the owned set can change between drags.
  function ensureLayer(view) {
    var m = view.m, id = view.layer.id, want = ownedBeforeId(view) || firstLabelId(view);
    try {
      if (m.getLayer(id)) {
        if (view.beforeId === want) return;
        m.removeLayer(id);   // GL resources belong to the CONTEXT, not the layer — textures survive
      }
      m.addLayer(view.layer, want || undefined);
      view.beforeId = want;
      S.lastLayerError = null;
    } catch (e) {
      // A swallowed failure here is invisible AND destructive: the vectors are hidden for the drag
      // while nothing draws in their place, so the layers simply vanish. Record it and say so once.
      S.lastLayerError = String(e && e.message || e);
      if (!S._warnedLayer) { S._warnedLayer = 1; console.warn("rasterScrub: could not place the scrub layer — " + S.lastLayerError); }
    }
  }

  function makeView(m, side) {
    var view = { m: m, el: m.getContainer(), side: side, gl: null, P1: null, P2: null,
                 tex: {}, loading: {}, on: false, beforeId: null, builtFor: null };
    view.layer = {
      id: "ms-scrub-" + side, type: "custom", renderingMode: "2d",
      onAdd: function (map, gl) {
        // rebuild only if the CONTEXT itself changed (a style reload re-adds the layer but keeps
        // the context, so textures must NOT be thrown away on every basemap switch)
        if (view.builtFor !== gl) {
          view.tex = {}; view.loading = {};
          if (!buildGL(view, gl)) return;
          view.builtFor = gl;
          S.items.forEach(function (it) { ensureTex(view, it, 0, 0); if (it.cfg && it.cfg.indexed) ensureLut(view, it); });
        }
        view.gl = gl;
      },
      render: function () { if (view.on && S.dragging && S.usingRaster) drawItems(view, S.lastYear); }
    };
    // PREFETCH the level this view will actually want whenever the map comes to rest — without
    // this, the first click on the slider draws the fat coarse level until finer textures land
    // (the "thickness explodes, then reduces" report, 7/16)
    m.on("idle", function () { if (wantsRaster(S.mode)) prefetchWanted(view); });
    return view;
  }
  function prefetchWanted(view) {
    var el = view.el, w = el.clientWidth, h = el.clientHeight;
    // deep zoom never draws the raster — don't load for it. Crossing this is exactly the
    // "it was smooth a second ago" report: the scrub silently falls back to vectors.
    if (!w || !h) return;
    if (view.m.getZoom() > S.maxZoom) {
      if (window.MSGuard) MSGuard.cliff("raster-scrub-zoom", Math.round(view.m.getZoom() * 10) / 10, S.maxZoom,
        "zoomed in past where the fast timeline snapshot can draw, so the scrub is running on the live shapes and may feel slower");
      return;
    }
    // Idle is also where the layer self-heals: a basemap switch drops every custom layer, and
    // textures live in the context we only get through onAdd, so re-add before touching view.gl.
    ensureLayer(view);
    if (!view.gl) return;
    S.items.forEach(function (it) {
      /* Switched OFF means don't fetch it. `drawItems` already skips inactive items — "layer
         unchecked in the sidebar → its raster stays dark too" — but this loop never asked, so the
         snapshot PNGs for hidden layers were downloaded and then never drawn.
         Measured 8/21 on "Railroads and the Making of Modern America": 2 of 13 layers on at boot,
         ~11 kB of visible row data, and 43.9 MB pulled over the wire. First data pixels at 20s.
         Self-healing rather than a trade-off: this runs on every map `idle`, so the moment a layer
         is ticked on its raster is prefetched by the next idle. Until then the drag falls back to
         the vectors for that one layer, which is what already happens for an unbaked layer. */
      if (!itemActive(it)) return;
      if (!itemServes(it, view.m)) return;   // past its own crossover — nothing to prefetch for it
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
    if (!view.gl) return;   // no map context yet — the custom layer has not been added
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
      if (S.dragging && S.usingRaster) repaint(view);   // sharpen mid-drag as soon as it lands
    };
    img.onerror = function () { delete view.loading[key]; };
    img.src = tile.url + "?v=" + encodeURIComponent(it.cfg.bakedAt || "1");   // fresh after every re-bake
  }
  // The LUT of an indexed bake (8/9): ONE small texture per view, keyed by its url so the fill and
  // border items of the same layer share the single fetch. Same crossOrigin + cache-buster pattern
  // as the level textures; NEAREST because a blended texel would be a blend of two unrelated
  // timelines. Returns null while it is still in flight — the item simply doesn't draw that frame.
  function ensureLut(view, it) {
    if (!view.gl) return null;
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
      if (S.dragging && S.usingRaster) repaint(view);
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
    if (!pal || !pal.length || (it.isBorder && !it.catBorder)) return null;   // borders join the palette only when their line paint is categorical (see resolveBorder)
    var key = "pal|" + cfgKey(it.cfg);
    if (view.tex[key]) return view.tex[key];
    if (!view.gl) return null;
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
  // THE CROSSOVER ZOOM — past this, this item's finest level would have to be STRETCHED, and a
  // stretched stroke is a fat blocky stroke. The flat 8.5 below is a whole-renderer limit; it says
  // nothing about whether a particular bake still has pixels to spend. Measured on the railways
  // layer (span 57.3°, finest 16384, dpr 1.5): upscale is 0.81 at z6 but 2.28 at z7.5 and 4.26 at
  // z8.4 — a 1.8-texel stroke landing 4–7 screen px wide against a line-width of 1.5. The pyramid
  // simply runs out at ~z7.1, and no level-picking fix can invent resolution.
  //   need(z) = 512·2^z·span/360 device px  ⇒  serve while need·dpr ≤ finestWidth
  // Only THIN geometry is held to it: a solid fill upscales invisibly (it is area, not edge), which
  // is why it keeps the lenient global limit. Beyond the crossover the layer keeps its vectors and
  // the engine's paint-scrub animates them — crisp, correctly sized, and cheap up close where few
  // features are in view, which was always the stated division of labour.
  function itemMaxZoom(it) {
    if (!(it.thin || it.isBorder)) return S.maxZoom;
    var span = it.cfg && it.cfg.bounds ? (it.cfg.bounds[2] - it.cfg.bounds[0]) : 0;
    var finest = 0;
    for (var i = 0; i < it.levels.length; i++) if (it.levels[i].width > finest) finest = it.levels[i].width;
    if (!span || !finest) return S.maxZoom;
    var dpr = window.devicePixelRatio || 1;
    var z = Math.log(finest * 360 / (512 * span * dpr)) / Math.LN2;
    return Math.min(S.maxZoom, z);
  }
  function itemServes(it, m) { try { return m.getZoom() <= itemMaxZoom(it); } catch (e) { return true; } }
  S.crossover = itemMaxZoom;   // console seam: MSRasterScrub.crossover(MSRasterScrub.items[0])
  S.place = function () { S.views.forEach(function (v) { ensureLayer(v); }); };   // MSLayerOrder calls this after a reorder

  /* ── MATCHING THE VECTOR'S THICKNESS (owner 8/18: "needs to be slightly thicker; it should
     match the vector") ────────────────────────────────────────────────────────────────────────
     pickLevel deliberately takes the first level at or FINER than the device (thin geometry cannot
     afford an upscaled, blocky texel), so the bake is always OVERsampled: the scale factor runs
     between 0.5 and 1.0 through each level band. A stroke baked at a fixed 1.8 texels therefore
     lands between 0.6 and 1.2 CSS px against a 1.5 px vector — thinner everywhere, and thinnest
     right after a level boundary. Measured on Railroads: 1.27x at z4, 0.85x at z6, 0.54x at z6.5.
     No single baked width fixes it, because the requirement varies 2x inside every band.
     So the reader compensates: work out how wide the stroke is ACTUALLY landing, compare it to the
     vector's own line-width, and dilate by the shortfall — drawing the same quad a few times at
     sub-pixel offsets, which unions into a wider line without touching the shader or the bake. */
  function bakeTexels(levelW, isBorder) {
    // MUST STAY IN STEP with tilegen.js bakeIndexCanvas (sctx.lineWidth). Bakes made from 8/18 on
    // record it in the config as `lw`; this table is the fallback for everything baked before that.
    return isBorder ? (levelW >= 16384 ? 1.5 : levelW >= 8192 ? 1.6 : levelW >= 4096 ? 1.8 : 2.0)   // cliff-ok: a line-width ramp by texture size — rendering quality, nothing is dropped
                    : (levelW >= 16384 ? 1.8 : levelW >= 8192 ? 2.0 : levelW >= 4096 ? 2.5 : 3.0);   // cliff-ok: second line of the same width ramp
  }
  // the vector width this bake stands in for: a plain number, or a zoom interpolate resolved later
  function vecWidth(node, ry) {
    if (ry && typeof ry.lw === "number") return ry.lw;          // frozen into standalone copies
    try {
      var p = node && node.paint && node.paint["line-width"];
      if (typeof p === "number") return p;
      if (Array.isArray(p)) return p;                            // resolved per-zoom in targetWidth()
    } catch (e) {}
    return null;
  }
  function targetWidth(it, m) {
    var p = it.lw;
    if (typeof p === "number") return p;
    if (Array.isArray(p) && p[0] === "interpolate") {            // linear zoom stops, the shape the editor writes
      try {
        var z = m.getZoom(), st = [];
        for (var i = 3; i < p.length; i += 2) if (typeof p[i] === "number" && typeof p[i + 1] === "number") st.push([p[i], p[i + 1]]);
        if (!st.length) return 1.5;
        if (z <= st[0][0]) return st[0][1];
        if (z >= st[st.length - 1][0]) return st[st.length - 1][1];
        for (var j = 1; j < st.length; j++) if (z <= st[j][0])
          return st[j - 1][1] + (st[j][1] - st[j - 1][1]) * (z - st[j - 1][0]) / (st[j][0] - st[j - 1][0]);
      } catch (e) {}
    }
    return 1.5;   // the engine's own default line width
  }
  // how far to spread the quad, in CSS px, so the drawn stroke reaches the vector's width
  function dilationCss(it, m, levelW) {
    if (!(it.thin || it.isBorder)) return 0;                     // fills are area, not edge
    try {
      var span = it.cfg.bounds[2] - it.cfg.bounds[0];
      var needCss = 512 * Math.pow(2, m.getZoom()) * span / 360;
      var texels = (it.cfg && typeof it.cfg.lw === "number") ? it.cfg.lw : bakeTexels(levelW, it.isBorder);
      var apparent = texels * needCss / levelW;
      var want = targetWidth(it, m);
      if (!(want > 0) || !(apparent > 0)) return 0;
      var r = Math.max(0, Math.min(1.25, (want - apparent) / 2));   // half the shortfall on each side
      // An offset below half a DEVICE pixel cannot change coverage — it rounds to the same texel and
      // the extra passes draw exactly on top of themselves. Measured at z6 the shortfall works out
      // to r = 0.115 css, which did nothing at all and left the line a pixel thin. Round any real
      // shortfall up to the smallest offset that actually moves a pixel.
      var dpr = window.devicePixelRatio || 1;
      if (r > 0.03 && r * dpr < 0.3) r = 0.3 / dpr;
      return r;
    } catch (e) { return 0; }
  }

  function pickLevel(m, it) {   // the level whose pixels ≈ the screen's pixels for this span
    var span = it.cfg.bounds[2] - it.cfg.bounds[0];
    var need = 512 * Math.pow(2, m.getZoom()) * span / 360;
    // THIN GEOMETRY picks device-exact: it cannot afford the 0.8 fudge or a missing dpr — upscaled
    // texels read fat and blocky ("z2.4 and below it gets bad", 8/8). Solid fills are area, so a
    // coarser pick never shows on them.
    // 8/18: this was scoped to isBorder, which meant polygon RINGS got the exact pick but a LINE
    // LAYER did not — plain LineStrings bake into the fill pyramid by design (they ARE the layer),
    // so `it.isBorder` is false for them and they fell through to the fudged branch. Combined with
    // dpr the chosen level ran up to ~1.9× too coarse, and the baked stroke upscaled to several
    // screen pixels against a line-width of 1.5 ("the bake is not accounting for line thickness
    // again — it's extremely thick"). Thin is thin, whichever pyramid it lives in.
    if (it.isBorder || it.thin) {
      need *= (window.devicePixelRatio || 1);
      for (var j = 0; j < it.levels.length; j++) if (it.levels[j].width >= need) return j;
      return it.levels.length - 1;
    }
    for (var i = 0; i < it.levels.length; i++) if (it.levels[i].width >= need * 0.8) return i;
    return it.levels.length - 1;
  }

  function drawItems(view, year) {
    var el = view.el, gl = view.gl;
    var w = el.clientWidth, h = el.clientHeight;
    if (!w || !h || !gl || !view.P1) return;
    // We are a guest in the map's context: no clear, no viewport change, and every bit of state we
    // rely on gets set here because the layers drawn before us set their own.
    gl.bindBuffer(gl.ARRAY_BUFFER, view.buf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);   // shader emits premultiplied alpha, as before
    S.items.forEach(function (it) {
      if (!itemActive(it)) return;   // layer unchecked in the sidebar → its raster stays dark too
      if (!itemServes(it, view.m)) return;   // past its crossover: its vectors are still up, drawing would double-ink it
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
      // DILATION (8/18): the quad is drawn once at its true position, then again at ring offsets,
      // so the union reads as a stroke `2*r` CSS px wider — the amount pickLevel's oversampling
      // costs us against the vector. Cheap: it is the SAME fragments and the same texture, N times,
      // with no extra per-fragment sampling and no shader change. r == 0 → exactly one pass, so a
      // bake that already matches (or any fill) pays nothing.
      var r = dilationCss(it, view.m, it.levels[use].width);
      var ring = [[0, 0]];
      if (r > 0.03) {
        var d = r * 0.7071;
        ring = [[0, 0], [r, 0], [-r, 0], [0, r], [0, -r], [d, d], [d, -d], [-d, d], [-d, -d]];
      }
      geom.forEach(function (g) {
        gl.bindTexture(gl.TEXTURE_2D, view.tex[it.lid + "|" + use + "|" + g[0]]);
        for (var oi = 0; oi < ring.length; oi++) {
          gl.uniform2f(P.U.p0, (g[1].x + ring[oi][0]) / w, (g[1].y + ring[oi][1]) / h);
          gl.uniform2f(P.U.p1, (g[2].x + ring[oi][0]) / w, (g[2].y + ring[oi][1]) / h);
          gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        }
      });
    });
    gl.activeTexture(gl.TEXTURE0);   // leave the unit the map expects
  }
  function repaint(view) { try { view.m.triggerRepaint(); } catch (e) {} }

  function showAll() { S.views.forEach(function (v) { ensureLayer(v); v.on = true; repaint(v); }); }
  // hideAllSoon() removed 8/21: superseded by fadeSoon() below, which is the same body with a
  // 120ms delay instead of 350. Nothing called it. Dead code that looks live is a trap.

  // v4: during the drag the raster answers ALONE — the tiled layers hide (ONE visibility flip,
  // previous state saved/restored exactly) and paintDate freezes (no point repainting an
  // invisible layer). On release the engine snaps the vector to the release date, it reappears,
  // and the raster fades.
  var _vis = null;
  function hideVectors(slugs) {
    if (_vis) return;   // already hidden — a second pass would record "none" as the prior state
    // LABEL SNAPSHOT FIRST (8/16, "as I drag the labels are not there"): querySourceFeatures only
    // answers from a source some VISIBLE layer uses — once the fills flip to none below, the anchor
    // recompute reads 0 features and empties the labels. Each wired anchor set caches its source
    // features NOW, while the fills still render; recompute(day) filters the cache mid-drag.
    try { (window._msLabelDragPrep || []).forEach(function (f) { f(); }); } catch (e) {}
    _vis = [];
    var seen = {};   // fill + border items share a slug when the outline isn't split — a second
    // pass would record "none" as the prior state and restore would leave the vector hidden
    (slugs || []).forEach(function (slug) {
      if (!slug || seen[slug]) return;
      seen[slug] = true;
      var it = { slug: slug };
      [[typeof beforeMap !== "undefined" ? beforeMap : null, "left"], [typeof afterMap !== "undefined" ? afterMap : null, "right"]].forEach(function (pr) {
        var m = pr[0]; if (!m) return;
        // LABELS STAY UP (8/16, "It would be great to be able to see the labels while animating,
        // and not have them disappear"): "-label-" is no longer in this hide list — the vector
        // symbol layers keep rendering over the raster, and labelDate() below re-filters them to
        // the dragged date every tick, so names appear and vanish WITH their features. Labels are
        // a few hundred symbols, so the per-tick re-filter is cheap where a fill re-filter is not.
        [it.slug + "-" + pr[1], it.slug + "-stroke-" + pr[1], it.slug + "-highlighted-" + pr[1]].forEach(function (id) {
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
    // OWNERSHIP HANDOFF (8/17) — replaces the old blanket `window.paintDate = noop`. The engine's
    // paint scrub now skips exactly the layers we just hid (see _dpTargets in map/engine/mapinit.js),
    // so nothing repaints what deck/the raster is drawing, AND the layers we don't cover (geojson,
    // mapbox-hosted tilesets) keep animating through the engine instead of freezing until release.
    window.__msScrubOwned = seen;
  }
  function restoreVectors() {
    (_vis || []).forEach(function (t) { try { t[0].setLayoutProperty(t[1], "visibility", t[2]); } catch (e) {} });
    _vis = null;
    window.__msScrubOwned = null;
    try { (window._msLabelDragEnd || []).forEach(function (f) { f(); }); } catch (e) {}   // drop the label snapshot
  }

  function fadeSoon() {
    clearTimeout(S.hideT);
    S.hideT = setTimeout(function () {
      S.views.forEach(function (v) {
        v.on = false; repaint(v);
      });
    }, 120);
  }

  // THE RENDERER CHAIN (8/17 swap — owner: "just completely swap it out"): deck → baked raster →
  // the engine's own paint scrub. Each step stands aside on its own terms: deck when it can't run
  // on this machine or no layer resolves to fetchable tiles, the raster when there's no bake or the
  // zoom is past its resolution limit. The one-word swap back to the pure mapbox-gl timeline lives
  // in the switch block at the top of deckScrub.js (DEFAULT_MODE = "mapbox").
  function deckMode() { return wantsDeck(S.mode) && !!(window.MSDeckScrub && MSDeckScrub.available()); }
  function ymdOf(unix) { try { return parseInt(moment.unix(unix).format("YYYYMMDD")); } catch (e) { return null; } }

  var _hooked = false;
  function hook() {
    if (_hooked) return;   // reload() can reach here after load() already wired the slider — a second
    _hooked = true;        // set of handlers would run every drag twice (the duplicate-listener trap)
    var $s = $("#slider");
    // Hovering the timeline PREPARES deck: it fetches and parses its tiles during the walk from
    // "cursor arrives" to "button goes down", so the first drag of a session starts glued instead
    // of paying ~0.4s at press-down. Draws nothing, costs nothing until the cursor comes over.
    try {
      $("div.timeline").add($s)
        .on("mouseenter", function () { if (deckMode()) try { MSDeckScrub.prepare(); } catch (e2) {} })
        .on("mouseleave", function () { if (!S.dragging && window.MSDeckScrub) try { MSDeckScrub.unprepare(); } catch (e3) {} });
    } catch (e0) {}
    $s.on("slidestart", function (e, ui) {
      mergeNodeItems();   // published/copied maps: the DB rows may not match the rendered nodes — adopt node-carried bakes (8/13)
      var M = S.mode;
      S.usingDeck = S.usingRaster = false;
      if (M === "mapbox") return;   // the engine's paint scrub owns every layer, nothing to set up
      var v0 = (ui && ui.value != null) ? ui.value : (function () { try { return $s.slider("value"); } catch (e2) { return null; } })();
      var slugs = [], live = [];
      // ── deck: needs no bake and has no zoom limit, so it covers maps (and zooms) the raster can't
      if (wantsDeck(M) && deckMode()) {
        S.usingDeck = MSDeckScrub.begin(v0 != null ? ymdOf(v0) : null);
        if (S.usingDeck) { slugs = slugs.concat(MSDeckScrub.owned()); live.push("deck·" + MSDeckScrub.owned().length); }
      }
      // ── baked raster
      // per-item crossover (8/18): the raster serves only the layers whose bake still has the
      // resolution for this zoom. Any layer past its crossover is left OUT of `slugs`, so its
      // vectors are never hidden and the engine's paint-scrub animates them at the right width.
      var served = (wantsRaster(M) && S.views.length)
        ? S.items.filter(function (it) { return itemServes(it, S.views[0].m); }) : [];
      if (served.length) {
        // EVERY item re-resolves EVERY drag (8/13): colours change live in a session (colour-by,
        // engine edits) — a colour cached once at load can go stale, and a stale black stuck until
        // reload. resolveBorder already did this for borders; fills now match.
        served.forEach(function (it) { if (it.isBorder) resolveBorder(it); else { if (!it.slug) it.slug = slugOf(it.lid, it.cfg); it.color = colorOf(it.lid, it.cfg); it.alpha = alphaOf(it.lid, it.cfg); } });
        // draw the CURRENT year BEFORE revealing the canvas — it otherwise flashed its stale
        // last-drag frame (looked like "all the data") for the whole click-hold until the first
        // slide event landed, then snapped (user 7/22)
        if (v0 != null) S.lastYear = yearOf(v0);
        S.dragging = true;   // the custom layer's render guard reads this
        showAll();
        S.usingRaster = true;
        slugs = slugs.concat(served.map(function (it) { return it.slug; }));
        live.push(served.length === S.items.length ? "raster" : "raster·" + served.length + "/" + S.items.length);
      }
      if (!live.length) {   // asked for a fast renderer, none could draw here — say which way it fell
        S.dragging = false;
        return void setLive("mapbox (fallback)", true);
      }
      S.dragging = true; clearTimeout(S.hideT);
      // the mapbox combos deliberately leave the vectors up and animating underneath
      if (!keepsVectors(M)) hideVectors(slugs);
      setLive(live.join(" + "));
    });
    $s.on("slide", function (e, ui) {
      if (!S.dragging || !ui) return;
      if (S.usingDeck) MSDeckScrub.setDate(ymdOf(ui.value));
      if (S.usingRaster) {
        S.lastYear = yearOf(ui.value);
        S.views.forEach(function (v) { repaint(v); });
      }
      labelDate(ui.value);
    });
    $s.on("slidestop slidechange", function () {
      restoreVectors();   // vector reappears snapped to the release date (engine applies the real filter)
      endLabelPaint();    // labels go back to filter-owned visibility (unconditional: the drag may have ended any number of ways)
      if (!S.dragging) return;
      S.dragging = false;
      if (S.usingDeck) { MSDeckScrub.end(); S.usingDeck = false; }
      if (S.usingRaster) { fadeSoon(); S.usingRaster = false; }
    });
  }

  // Drag-time label visibility runs through PAINT, not setFilter (8/21).
  //
  // Changing a symbol layer's FILTER makes the worker re-run layout and glyph collision for every
  // visible tile. Measured on the Borders map: 80 of the 124 style calls in a one-second drag were
  // label setFilters — two thirds of the scrub's entire style budget spent re-placing text that is
  // sliding past too fast to read. `text-opacity` is a paint property: the GPU stops drawing the
  // glyphs and layout never re-runs. This is the same move `paintDate` already makes for fills,
  // lines and circles; labels were the one kind left paying the old price.
  //
  // The trade, stated plainly: with the filter dropped, out-of-date labels still take part in
  // COLLISION — an invisible label keeps reserving its box — so a dense map can show fewer labels
  // DURING a drag than at rest. At release changeDate restores the real filter and placement is
  // exact again. Dropping the filter costs one re-layout on the first tick, not one per tick.
  var _lblLast = 0, _lblPaintBase = {}, _lblFilterDropped = {};
  function labelDate(unixVal) {
    var now = Date.now();
    if (now - _lblLast < 120) return;   // cliff-ok: a paint throttle, not a deadline
    _lblLast = now;
    var day;
    try { day = parseInt(moment.unix(unixVal).format("YYYYMMDD")); } catch (e) { return; }
    if (!day || isNaN(day)) return;
    var f = ["all", ["<=", ["coalesce", ["get", "DayStart"], 0], day], [">=", ["coalesce", ["get", "DayEnd"], 99999999], day]];
    var seen = {};
    S.items.forEach(function (it) {
      if (it.isBorder || !it.slug || seen[it.slug]) return;
      seen[it.slug] = true;
      [[typeof beforeMap !== "undefined" ? beforeMap : null, "left"], [typeof afterMap !== "undefined" ? afterMap : null, "right"]].forEach(function (pr) {
        var m = pr[0]; if (!m) return;
        var id = it.slug + "-label-" + pr[1];
        try { if (!m.getLayer(id)) return; } catch (eL) { return; }
        if (!_lblFilterDropped[id]) {   // once per drag: paint owns label visibility until release
          _lblFilterDropped[id] = 1;
          try { m.setFilter(id, null); } catch (eF) {}
        }
        var ck = id + "|text-opacity";
        if (!(ck in _lblPaintBase)) {
          var base;
          try { base = m.getPaintProperty(id, "text-opacity"); } catch (eG) { base = null; }
          _lblPaintBase[ck] = base == null ? 1 : base;
        }
        try { m.setPaintProperty(id, "text-opacity", ["case", f, _lblPaintBase[ck], 0]); } catch (eP) {}
      });
    });
    // group-anchor labels (fills/tileset lines) carry no Day props of their own — the filter above
    // can't touch them. Their anchors recompute from SOURCE features at the dragged date instead.
    try { (window._msLabelRecomputes || []).forEach(function (rr) { rr.fn(day); }); } catch (e) {}
  }
  // The inverse of labelDate, on EVERY exit path — a drag that ends without this leaves labels
  // wearing a case-expression opacity and no filter, which reads as "labels stopped working".
  // changeDate re-applies the real filters right after, so only the paint has to be put back.
  function endLabelPaint() {
    if (!_lblFilterDropped || !Object.keys(_lblPaintBase).length) { _lblPaintBase = {}; _lblFilterDropped = {}; return; }
    var maps = [typeof beforeMap !== "undefined" ? beforeMap : null, typeof afterMap !== "undefined" ? afterMap : null];
    Object.keys(_lblPaintBase).forEach(function (ck) {
      var i = ck.lastIndexOf("|"), id = ck.slice(0, i), key = ck.slice(i + 1);
      maps.forEach(function (m) {
        try { if (m && m.getLayer(id)) m.setPaintProperty(id, key, _lblPaintBase[ck]); } catch (e) {}
      });
    });
    _lblPaintBase = {}; _lblFilterDropped = {};
  }

  // ONE writer for the renderer choice — whatever was mid-drag stops cleanly (nothing left hidden,
  // nothing left frozen, no stale raster canvas on screen) before the next drag picks the new path.
  // WHAT IS ACTUALLY DRAWING (8/17): the two checkboxes could not answer "did the swap happen?" —
  // they look identical whichever renderer is live, and an unchecked pair silently meant the legacy
  // path. The chip now names the renderer, and after each drag it names what really drew.
  function setLive(txt, warn) {
    var el = document.getElementById("ms-scrub-live");
    if (!el) return;
    el.textContent = txt;
    el.style.color = warn ? "#f0a86a" : "#9ce6b4";
  }
  function setMode(m) {
    S.mode = m;
    S.on = m !== "mapbox";
    if (window.MSDeckScrub) MSDeckScrub.mode = m;   // deck's hover prewarm reads the same field
    // deliberately NOT persisted — see readMode. This session only.
    var lab = (MODES.filter(function (x) { return x.id === m; })[0] || {}).label || m;
    setLive(lab, m === "mapbox" || m === "mapbox+raster");
    try { if (window.MSDeckScrub) MSDeckScrub.end(); } catch (e2) {}
    S.usingDeck = S.usingRaster = false;
    S.views.forEach(function (v) { v.on = false; repaint(v); });
    restoreVectors();
    endLabelPaint();
    S.dragging = false;
    var box = document.getElementById("ms-raster-chip");
    if (box) [].forEach.call(box.querySelectorAll("input"), function (i) { i.checked = i.value === m; });
    // Switching in or out of "layer" changes WHICH bakes are eligible, and the DB pass built the
    // item list once at load — without this, items gated out under "layer" never come back when a
    // forced mode is picked (and vice versa), so the chip would appear to do nothing.
    try { if (S.reload) S.reload(); } catch (e3) {}
  }
  // THE ⚡ CHIP IS GONE (owner 8/17: "Get rid of this"). It was a comparison instrument from the
  // deck experiment, and once the layer panel's "Make Faster" section existed it was a SECOND place
  // to set one thing — exactly the shape of the stale-toggle bug that made a whole morning read as
  // "slower than ever". The mode machinery below stays because the renderers still branch on it,
  // but nothing in the UI writes it any more: every page runs "layer", i.e. each layer's own
  // choice. With no `fast` key that means baked layers scrub from their raster and everything else
  // animates through the engine — the arrangement that was the default before any of the deck work.
  // To A/B renderers again, set MSRasterScrub mode from the console: MSRasterScrub.setMode("deck").
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
          if (S.mode === "layer" && !rasterOptedIn(n)) ry = null;   // baked, but switched off in its panel
          if (ry && (ry.url || ry.levels) && ry.bounds) {
            var k = cfgKey(ry);
            if (k && !have[k]) {
              have[k] = 1;
              var lid = n._layerDbId || n._dataLayerId || n.id;
              add.push({ lid: lid, cfg: ry, color: colorOf(lid, ry), alpha: alphaOf(lid, ry), slug: n.id,
                thin: n.type === "line",   // a line layer needs the exact level pick (see pickLevel)
                lw: vecWidth(n, ry),        // the vector width the bake has to MATCH (see dilation in drawItems)
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
      // `type` rides along so pickLevel can tell THIN geometry (a line layer) from solid fills —
      // without it every line layer took the coarse fudged level and baked strokes read fat (8/18)
      var r = await MapAuth.db.from("project_layers").select("layers(id, type, raw_config)").eq("project_id", pid);
      rows = (r && r.data) || [];
    }
    var items = [];
    var borderItems = [];   // appended AFTER every fill item — array order is draw order, borders sit on top
    rows.forEach(function (row) {
      var L = row.layers, ry = L && L.raw_config && L.raw_config.rasterYears;
      // 8/17: the layer's own "Make Faster" toggle gates its bake. Border items are exempt — they
      // are the companion half of a fill whose own row was already gated one line above.
      if (ry && !ry.isBorder && S.mode === "layer" && !rasterOptedIn(L.raw_config)) return;
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
        thin: L.type === "line" || ry.thin === true,   // ry.thin: standalone copies carry it in the frozen config
        lw: vecWidth(L, ry),

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
    // 8/17: a map with NO bakes used to stop right here, which is why deck never got a chance on
    // one — it reads the layer's own tiles and needs no bake at all. Hook whenever EITHER renderer
    // could draw; the raster's canvases are only built when there is something baked to draw.
    if (S.items.length) {
      [typeof beforeMap !== "undefined" ? beforeMap : null, typeof afterMap !== "undefined" ? afterMap : null].forEach(function (m) {
        if (m && m.getContainer) { var v = makeView(m, S.views.length ? "right" : "left"); if (v) { S.views.push(v); ensureLayer(v); } }
      });
    }
    if (!S.views.length && !(window.MSDeckScrub && MSDeckScrub.available())) return;
    hook();
  }

  // RELOAD after a bake (8/13, "I rebaked, it all went black"): nothing told the running scrub
  // that a re-bake replaced (and deleted) its artifacts, so the session kept drawing from stale
  // configs and textures until a page reload. tilegen calls this when a bake lands; items and
  // the smallest textures rebuild from the fresh configs (stale GPU textures are keyed by the
  // old URLs and simply never referenced again).
  S.reload = async function () {
    try {
      // SELF-HEAL A DEAD BOOT (8/19): _pid is only set by load(), and if boot() gave up before
      // the map existed (heavy editor boots exceed its wait window), a later bake's reload()
      // returned RIGHT HERE — bake saved, opted in, and the session still scrubbed as a vector
      // with no error anywhere. The project id global is on the page; use it.
      if (_pid == null) _pid = (typeof platformProjectId !== "undefined" && platformProjectId) ? platformProjectId : window.platformProjectId;
      if (_pid == null && !Array.isArray(window.rasterScrubData)) return;
      var fresh = await buildItems(_pid);
      S.items.length = 0;
      fresh.forEach(function (it) { S.items.push(it); });
      mergeNodeItems();
      if (S.items.length && !S.views.length) {   // first-ever bake this session: views/hook don't exist yet
        [typeof beforeMap !== "undefined" ? beforeMap : null, typeof afterMap !== "undefined" ? afterMap : null].forEach(function (m) {
          if (m && m.getContainer) { var v = makeView(m, S.views.length ? "right" : "left"); if (v) { S.views.push(v); ensureLayer(v); } }
        });
        if (S.views.length) { hook(); }
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
      // A SLOW map is not a STATIC map (8/19): 40×500ms gave up at 20s while a heavy editor boot
      // took 42s — the session lost its scrub silently (bake present + opted in, items []). A
      // page that will never qualify (static, no baked data) still stops at 40 tries; a platform
      // page (MapAuth is loading or loaded) waits up to 6 minutes and says so if it gives up.
      var isPlatform = typeof MapAuth !== "undefined" || (typeof platformProjectId !== "undefined" && platformProjectId) || window.platformProjectId;
      if (tries < 40 || (isPlatform && tries < 720)) setTimeout(boot, 500);
      else if (isPlatform) {
        // Was a bare console.warn — the right words, in a place no test can read and the person
        // never looks. Through MSGuard it lands in the assertable log as well as the console.
        var msg = "gave up waiting for the map after " + Math.round(tries / 2) + "s — baked layers will scrub as vectors this session, which is slower than the snapshot they have";
        if (window.MSGuard) MSGuard.cliff("raster-scrub-boot-giveup", tries, 719, msg);
        else console.warn("rasterScrub: " + msg);
      }
      return;
    }
    load(pid).catch(function (e) { console.warn("rasterScrub: disabled (" + (e && e.message) + ")"); });
  }
  boot();
})();
