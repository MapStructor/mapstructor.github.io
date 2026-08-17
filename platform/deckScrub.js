/* deckScrub.js — THE TIMELINE RENDERER for dragged tiled layers (8/16 built, 8/17 promoted).
   While the slider is DRAGGED, every tiled layer renders as a deck.gl MVT layer reading the SAME
   tiles the engine already serves; date-visibility is a GPU DataFilterExtension uniform — instant
   at any data size, DAY-exact, styling-true (colours/opacities read live from the engine's paint),
   with no bake and no per-feature work per tick.

   ── THE SWITCH (owner 8/17: "just completely swap it out … keep code that lets you swap back") ──
   "deck"   deck.gl draws the drag for every layer whose tiles are fetchable. Bakes optional.
   "raster" the baked year-raster draws it (the 7/16–8/16 path) — also the AUTOMATIC fallback when
            deck can't run here (software GPU, unfetchable/mapbox-hosted tiles).
   "mapbox" nobody intercepts: the engine's own paint scrub animates the drag, exactly as before
            8/16. THIS IS THE SWAP-BACK — change the one word in DEFAULT_MODE below and the
            legacy timeline owns every layer again. Nothing else has to move: the engine code was
            never deleted, it just stops being told to stand aside (see __msScrubOwned in
            rasterScrub.hideVectors + _dpTargets in map/engine/mapinit.js).
   The editor's ⚡ chip flips the same three states live (localStorage ms-timeline).

   "layer"  THE DEFAULT since 8/17, and the answer to the 8/16 promotion: each layer decides, from
            the "Make Faster" section of its own panel (raw_config.fast → node.fast). A layer with
            nothing ticked scrubs through the engine, i.e. "mapbox" — so the shipped behaviour of a
            fresh layer is exactly the pre-8/16 timeline, and deck only ever draws layers somebody
            asked it to. Owner: "the reason why we've been doing all this has just been for speed …
            there are things it can't render that mapbox can", so correctness is the default and
            speed is a disclosed choice. The five named modes above remain as a GLOBAL override for
            comparison runs; they force every layer onto one renderer and ignore node.fast.

   REMOVE ENTIRELY: delete this file, its <script> include in map/index.html + map/editor.html,
   and the MSDeckScrub references in rasterScrub.js. Nothing else references it. */
(function () {
  "use strict";
  if (window.MSDeckScrub) return;
  var DEFAULT_MODE = "layer";   // ← the one word. "mapbox" = nobody intercepts, ever; "deck" = the 8/16 promotion

  var D = { mode: DEFAULT_MODE, active: false };
  window.MSDeckScrub = D;

  var _avail = null;
  D.available = function () {
    if (_avail != null) return _avail;
    try {
      if (!window.deck || !deck.MapboxOverlay || !deck.MVTLayer || !deck.DataFilterExtension) return (_avail = false);
      var cv = document.createElement("canvas");
      var gl = cv.getContext("webgl2") || cv.getContext("webgl");
      if (!gl) return (_avail = false);
      var ext = gl.getExtension("WEBGL_debug_renderer_info");
      var r = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : "";
      // software rasterizers scrub faster from the baked raster — leave them on it
      if (/swiftshader|software|llvmpipe|angle \(google/i.test(r)) return (_avail = false);
      _avail = true;
    } catch (e) { _avail = false; }
    return _avail;
  };

  // fp32-exact month-granular number — raw YYYYMMDD ints (20,260,816) exceed fp32's 2^24 integer
  // ceiling and would round by ±2 days inside the GPU filter
  function ymd2n(v) {
    v = +v;
    if (!v || isNaN(v)) return null;
    var y = Math.floor(v / 10000);
    if (y > 2200) y = 2200;
    if (y < 1) y = 1;
    var m = Math.floor(v / 100) % 100 || 1, d = v % 100 || 1;
    return y * 372 + (m - 1) * 31 + (d - 1);
  }

  // ANY CSS colour, not just #rrggbb (8/17): a 78k-feature rail layer scrubbed in fallback PURPLE
  // because its live line-color reads "rgb(165,83,183)" — the styling system hands back rgb()
  // strings as readily as hex, and a hex-only parser silently loses the layer's identity mid-drag
  // (the same shape as the 7/20 raster purple bug). Hex and rgb() are parsed directly; anything
  // else CSS knows (hsl, 3-digit hex, named colours) goes through a 1×1 canvas once and is cached.
  var _cx = null, _ccache = {};
  function rgbOf(c, fb) {
    var s = String(c == null ? "" : c).trim();
    if (!s) return fb;
    if (_ccache[s]) return _ccache[s];
    var m = /^#([0-9a-f]{6})$/i.exec(s);
    if (m) { var n = parseInt(m[1], 16); return (_ccache[s] = [(n >> 16) & 255, (n >> 8) & 255, n & 255]); }
    var r = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(s);
    if (r) return (_ccache[s] = [Math.round(+r[1]), Math.round(+r[2]), Math.round(+r[3])]);
    try {
      if (!_cx) { var cv = document.createElement("canvas"); cv.width = cv.height = 1; _cx = cv.getContext("2d"); }
      _cx.fillStyle = "#000000";
      _cx.fillStyle = s;                       // an invalid value leaves fillStyle untouched…
      var norm = String(_cx.fillStyle);
      if (norm !== "#000000" || /^(black|#000|#000000|rgba?\(0[\s,]+0[\s,]+0)/i.test(s)) {   // …so only trust black when black was asked for
        var m2 = /^#([0-9a-f]{6})$/i.exec(norm);
        if (m2) { var n2 = parseInt(m2[1], 16); return (_ccache[s] = [(n2 >> 16) & 255, (n2 >> 8) & 255, n2 & 255]); }
        var r2 = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(norm);
        if (r2) return (_ccache[s] = [Math.round(+r2[1]), Math.round(+r2[2]), Math.round(+r2[3])]);
      }
    } catch (e) {}
    return fb;
  }
  // deepest colour inside any paint value — the last resort for an expression shape this file
  // doesn't model (e.g. ["case", …, "#5286b7", "#a553b7"], ["to-color", ["get","ms_color"], …]).
  // Purple-by-default was the 7/20 raster bug; don't repeat it where the colour is right there.
  function colorIn(x, fb) {
    var hit = null;
    (function walk(v) {
      if (typeof v === "string") { var c = rgbOf(v, null); if (c) hit = c; }
      else if (Array.isArray(v)) v.forEach(walk);
    })(x);
    return hit || fb;
  }
  // What a match/case keys off: ["id"], ["get",prop], and the to-string/to-number wrappers the
  // styling system emits (["to-string",["get","cntry_name"]] — unwrapping only ["get"] meant a
  // colour-by went unrecognised and drew as ONE colour, owner 8/17 "the coloring is uniform").
  function keyOf(inp, f) {
    if (!Array.isArray(inp)) return undefined;
    var op = inp[0];
    if (op === "id") return f.id != null ? f.id : (f.properties || {}).msid;
    if (op === "get") return (f.properties || {})[inp[1]];
    if (op === "to-string") { var s = keyOf(inp[1], f); return s == null ? "" : String(s); }
    if (op === "to-number") { var n = +keyOf(inp[1], f); return isNaN(n) ? 0 : n; }
    return undefined;
  }
  // COMPILE the live paint into a per-feature accessor. Paint values NEST: the engine writes
  // per-feature overrides as ["match",["id"],id,colour,…,<fallback>] and that fallback is itself
  // the colour-by ["match",["to-string",["get",prop]],…]. Reading only the outer level painted
  // 1,361 of 1,369 features fallback purple on Global Borders (8/17). Compiled ONCE per drag into
  // hash lookups, so per-feature cost stays O(depth) rather than a walk of a 6KB expression.
  function compile(expr, fb) {
    if (expr == null) return function () { return fb; };
    if (typeof expr === "string") { var flat = rgbOf(expr, fb); return function () { return flat; }; }
    if (!Array.isArray(expr)) return function () { return fb; };
    var op = expr[0];
    if (op === "match" && Array.isArray(expr[1])) {
      var inp = expr[1], map = Object.create(null);
      for (var i = 2; i + 1 < expr.length; i += 2) {
        var labels = Array.isArray(expr[i]) ? expr[i] : [expr[i]];
        var child = compile(expr[i + 1], fb);
        for (var L = 0; L < labels.length; L++) map[String(labels[L])] = child;
      }
      var dflt = compile(expr[expr.length - 1], fb);
      return function (f) {
        var k = keyOf(inp, f);
        var hit = k == null ? null : map[String(k)];
        return (hit || dflt)(f);
      };
    }
    // ["case", cond, a, …, fallback]: every condition the engine writes here is hover/selected
    // feature-state, which is false for every feature during a drag — so the fallback IS the answer
    if (op === "case") return compile(expr[expr.length - 1], fb);
    if (op === "coalesce" || op === "to-color") {
      var kids = [];
      for (var j = 1; j < expr.length; j++) kids.push(compile(expr[j], null));
      return function (f) {
        for (var n = 0; n < kids.length; n++) { var c = kids[n](f); if (c) return c; }
        return fb;
      };
    }
    var one = colorIn(expr, fb);   // zoom/value ramps and anything unmodelled: one representative colour
    return function () { return one; };
  }
  function accessorFor(m, layerId, prop, fallback) {
    var v = null;
    try { v = m.getPaintProperty(layerId, prop); } catch (e) {}
    return compile(v, fallback);
  }
  // widths/radii: a plain number, else a zoom interpolation evaluated at the CURRENT zoom (the
  // engine's stored widths are usually ["interpolate",["linear"],["zoom"],…] — taking a hardcoded
  // default instead drew mid-drag lines visibly bolder than the layer's own), else any number the
  // expression carries. One value for the whole drag: zoom doesn't change while the slider does.
  function numIn(x) {
    if (typeof x === "number" && isFinite(x)) return x;
    var hit = null;
    if (Array.isArray(x)) x.forEach(function (v) { if (hit == null) hit = numIn(v); });
    return hit;
  }
  function numOf(m, layerId, prop, fb) {
    var v = null;
    try { v = m.getPaintProperty(layerId, prop); } catch (e) {}
    if (typeof v === "number" && isFinite(v)) return v;
    // ["case", <hover/selected cond>, 0.5, 0.4]: the FALLBACK is the at-rest value. numIn below
    // would grab 0.5 — the hover value — and draw every feature as if the cursor were on it,
    // which is part of why the drag read "slightly off the baked version" (8/17).
    if (Array.isArray(v) && v[0] === "case") v = v[v.length - 1];
    if (Array.isArray(v) && v[0] === "interpolate" && Array.isArray(v[2]) && v[2][0] === "zoom") {
      var z = 0; try { z = m.getZoom(); } catch (e2) {}
      var stops = v.slice(3), pick = null, pickZ = -1e9, first = null;
      for (var i = 0; i + 1 < stops.length; i += 2) {
        var sz = +stops[i], sv = numIn(stops[i + 1]);
        if (sv == null) continue;
        if (first == null) first = sv;
        if (sz <= z && sz > pickZ) { pickZ = sz; pick = sv; }
      }
      if (pick != null) return pick;
      if (first != null) return first;   // viewport is below the first stop
    }
    var n = numIn(v);
    return n == null ? fb : n;
  }
  function tilesOf(node) {
    var s = node && node.source;
    if (!s) return null;
    var t = (s.tiles && s.tiles[0]) || s.url || null;
    if (!t || /^mapbox:/.test(String(t))) return null;   // mapbox-hosted tilesets have no raw tile URL
    if (!/\{z\}/i.test(String(t))) return null;          // a TileJSON endpoint, not a tile template
    // new URL() percent-encodes the {z}/{x}/{y} braces, which makes MVTLayer read the template
    // as a TileJSON endpoint — decode them back after resolving
    try { return { url: new URL(String(t), location.href).href.replace(/%7B/gi, "{").replace(/%7D/gi, "}"), minZoom: s.minzoom || 0, maxZoom: s.maxzoom != null ? +s.maxzoom : 15 }; } catch (e) { return null; }
  }

  // EVERY dated tiled layer the sidebar is showing — bake or no bake (8/17). Before this, deck
  // only covered layers that happened to carry a rasterYears bake, so a tiled layer without one
  // still scrubbed through mapbox-gl paint. timelineIgnore layers are deliberately absent: they
  // show everything at every date, so their vector simply stays up and nothing re-filters it.
  // PER-LAYER OPT-IN (8/17). The panel's "Make Faster" section writes raw_config.fast = {raster,deck},
  // which spreads onto the rendered node. Absent = never chosen = deck off (deck is new, so there is
  // nothing to inherit — unlike the raster, where an existing bake counts as consent; see
  // fastOf() in editing.js and the same rule in rasterScrub.js). Under a forced chip mode this
  // returns true for everything, which is the point of a comparison run.
  function deckOptedIn(n) { return D.mode === "layer" ? !!(n && n.fast && n.fast.deck) : true; }
  function collect() {
    var out = [], seen = {};
    (function walk(a) {
      (a || []).forEach(function (n) {
        if (!n) return;
        if (n.children) return walk(n.children);
        if (!n.id || seen[n.id] || n.timelineIgnore) return;
        var t = tilesOf(n);
        if (!t) return;   // geojson / mapbox-hosted / TileJSON: the legacy paint scrub keeps these
        var cb = document.getElementById(n.toggleElement || n.id);
        if (cb && "checked" in cb && !cb.checked) return;   // switched off in the sidebar
        if (!deckOptedIn(n)) return;                        // not asked for under "Make Faster"
        seen[n.id] = true;
        out.push({ slug: n.id, tiles: t, type: n.type || "fill", sourceLayer: n["source-layer"] || null });
      });
    })(typeof layers !== "undefined" ? layers : []);
    return out;
  }
  D.canDraw = function () { try { return D.available() && collect().length > 0; } catch (e) { return false; } };
  // WHY DID / DIDN'T DECK DRAW — one call that names the reason per layer. Added 8/17 because
  // "canDraw() is false" is unfalsifiable on its own: five different conditions produce it, and the
  // stale-toggle bug earlier the same day was exactly a silent one. Gates and the console read this.
  D.why = function () {
    var rows = [];
    (function walk(a) {
      (a || []).forEach(function (n) {
        if (!n) return;
        if (n.children) return walk(n.children);
        if (!n.id) return;
        var cb = document.getElementById(n.toggleElement || n.id);
        rows.push({
          slug: n.id, label: n.label,
          off: !!(cb && "checked" in cb && !cb.checked),
          tlIgnore: !!n.timelineIgnore,
          noTiles: !tilesOf(n),
          notOptedIn: !deckOptedIn(n),
          fast: n.fast || null
        });
      });
    })(typeof layers !== "undefined" ? layers : []);
    return { mode: D.mode, available: D.available(), owned: _owned.slice(), collected: collect().length, layers: rows };
  };
  var _owned = [];
  D.owned = function () { return _owned.slice(); };

  function eachMap(fn) {
    [[typeof beforeMap !== "undefined" ? beforeMap : null, "left"], [typeof afterMap !== "undefined" ? afterMap : null, "right"]].forEach(function (pr) {
      if (pr[0]) fn(pr[0], pr[1]);
    });
  }
  function overlayFor(m) {
    if (m.__msDeckOverlay) return m.__msDeckOverlay;
    // useDevicePixels 1 = CSS-pixel resolution, i.e. native on a 1× display and HALF on a retina /
    // scaled one. On a 2560-wide editor with two swipe maps, full device resolution means two extra
    // ~3200px canvases to fill every frame — invisible sharpness for a drag preview, real fill cost
    // (the lab learned the same trick 8/16). Release hands the picture back to the crisp vectors.
    var o = new deck.MapboxOverlay({ layers: [], useDevicePixels: 1 });
    m.addControl(o);
    m.__msDeckOverlay = o;
    return o;
  }

  // PER-TICK CHEAPNESS (owner 8/16, "deck checked is as slow as with both unchecked"): deck
  // decides how much to redo by PROP IDENTITY. Rebuilding accessors/extensions per tick made it
  // re-process attributes every slider move — the exact per-feature cost this path exists to
  // avoid. So: everything is built ONCE per drag (begin) and frozen; setDate recreates the layer
  // shells with the SAME function/extension objects and only a new filterRange — a pure uniform.
  var _ext = null, _built = null, _sig = null;
  function getFilterValue(f) {
    var p = f.properties || {};
    var s0 = ymd2n(p.DayStart), e0 = ymd2n(p.DayEnd);
    return [s0 == null ? -1 : s0, e0 == null ? 1e7 : e0];   // undated = visible always, like the engine's coalesce filter
  }
  function buildOnce() {
    _built = { left: [], right: [] };
    _owned = [];
    collect().forEach(function (it) {
      _owned.push(it.slug);
      var isLine = it.type === "line", isPoint = it.type === "circle";
      eachMap(function (m, side) {
        var id = it.slug + "-" + side, strokeId = it.slug + "-stroke-" + side;
        var hasStroke = false; try { hasStroke = !!m.getLayer(strokeId); } catch (e) {}
        var mainKey = isLine ? "line-color" : isPoint ? "circle-color" : "fill-color";
        var fill = accessorFor(m, id, mainKey, [143, 122, 224]);
        // the outline follows whatever the engine actually draws: the stroke companion layer when
        // there is one (it can exceed 1px), else the fill's own fill-outline-color
        var line = isLine ? fill
          : hasStroke ? accessorFor(m, strokeId, "line-color", [40, 40, 40])
          : accessorFor(m, id, "fill-outline-color", [40, 40, 40]);
        // MATCH THE LAYER'S OWN TRANSLUCENCY (the 8/14 raster lesson): a hardcoded alpha made
        // release pop brighter→dimmer. Data-driven opacity can't be one value, so those keep the default.
        var op = numOf(m, id, isLine ? "line-opacity" : isPoint ? "circle-opacity" : "fill-opacity", isLine ? 1 : 0.6);
        var a = Math.max(20, Math.min(255, Math.round(op * 255)));
        var lw = isLine ? numOf(m, id, "line-width", 1.6) : hasStroke ? numOf(m, strokeId, "line-width", 1) : 1;
        var props = {
          id: "ms-deck-" + it.slug,
          data: it.tiles.url,
          minZoom: it.tiles.minZoom, maxZoom: it.tiles.maxZoom,
          binary: false,   // full GeoJSON features so accessors see feature.id (the engine's per-feature colour key)
          filled: !isLine, stroked: true,
          getFillColor: (function (fl, aa) { return function (f) { return fl(f).concat(aa); }; })(fill, a),
          getLineColor: (function (ln, aa) { return function (f) { return ln(f).concat(aa); }; })(line, isLine ? a : Math.min(255, a + 60)),
          getLineWidth: lw, lineWidthUnits: "pixels", lineWidthMinPixels: isLine ? 1 : 0.5,
          getPointRadius: isPoint ? numOf(m, id, "circle-radius", 4) : 4, pointRadiusUnits: "pixels",
          getFilterValue: getFilterValue,
          extensions: _ext || (_ext = [new deck.DataFilterExtension({ filterSize: 2 })]),
          pickable: false
        };
        // one archive can hold several source layers; render only the one this node points at
        if (it.sourceLayer) props.loadOptions = { mvt: { layers: [it.sourceLayer] } };
        _built[side].push(props);
      });
    });
  }
  function buildLayers(side, day) {
    var n = ymd2n(day);
    if (n == null || !_built) return [];
    var range = [[-1, n], [n, 1e7]];
    return _built[side].map(function (props) {
      var p = Object.assign({}, props);   // same object identities everywhere except the range
      p.filterRange = range;
      return new deck.MVTLayer(p);
    });
  }

  // Which layers, styled how — everything buildOnce() reads. Same signature means the props (and
  // so the attributes deck already built and the tiles it already parsed) are still valid, which is
  // what lets a hover PREPARE the drag. Colours/opacity change live in a session (colour-by, engine
  // edits), and reusing a stale accessor is the 8/13 "stale black stuck until reload" bug — so the
  // whole paint value goes in, unabridged.
  function signature() {
    var out = [];
    collect().forEach(function (it) {
      out.push(it.slug + "/" + it.type + "/" + it.tiles.url);
      eachMap(function (m, side) {
        ["fill-color", "line-color", "circle-color", "fill-outline-color", "fill-opacity", "line-opacity", "circle-opacity", "line-width", "circle-radius"].forEach(function (k) {
          var v = null;
          try { v = m.getPaintProperty(it.slug + "-" + side, k); } catch (e) {}
          if (v == null) return;
          out.push(k + "=" + (typeof v === "object" ? JSON.stringify(v) : String(v)));
        });
      });
    });
    return out.join(";");
  }
  function ensureBuilt() {
    var sg = signature();
    if (_built && _sig === sg) return;   // unchanged — keep the warmed props (and deck's parsed tiles)
    _sig = sg;
    buildOnce();
  }

  // PREPARE ON HOVER (8/17): the first drag on a map paid ~0.4s while deck fetched and parsed tiles
  // mapbox-gl had already cached where deck can't read it. Mounting the layers with a filter range
  // NOTHING can satisfy loads and builds everything while drawing zero pixels — so the walk from
  // "cursor arrives at the timeline" to "button goes down" absorbs the cost. Nothing is mounted
  // while the map just sits there, so panning and zooming stay exactly as they were.
  var WARM_RANGE = [[0, 0], [0, 0]];   // every real DayStart is ≥372 or -1; nothing passes this
  // "deck" and "deck+raster" both mean deck draws (the 5-option chip) — an exact === "deck" test
  // silently skipped the combo, which is how deck+raster came out raster-only (8/17 gate)
  // "layer" counts as wanted: whether deck actually draws is then decided per layer by collect(),
  // which returns [] when nobody opted in — and every entry point already treats empty as "stand aside".
  function deckWanted() { return D.mode === "layer" || String(D.mode || "").indexOf("deck") !== -1; }
  D.prepare = function () {
    if (D.active || !deckWanted() || !D.available()) return;
    try {
      ensureBuilt();
      if (!_owned.length) return;
      eachMap(function (m, side) {
        overlayFor(m).setProps({ layers: _built[side].map(function (props) {
          var p = Object.assign({}, props);
          p.filterRange = WARM_RANGE;
          return new deck.MVTLayer(p);
        }) });
      });
    } catch (e) {}
  };

  // cursor left the timeline without pressing: drop the warm mount so a hover can never leave a
  // second tile pipeline running (and re-fetching on every pan) for the rest of the session
  D.unprepare = function () {
    if (D.active) return;
    eachMap(function (m) { try { if (m.__msDeckOverlay) m.__msDeckOverlay.setProps({ layers: [] }); } catch (e) {} });
  };

  D.begin = function (ymd) {
    if (!D.available()) return false;
    ensureBuilt();
    // refuse when nothing resolved — the caller falls back to the raster rather than hiding the
    // vectors behind an empty overlay
    if (!_owned.length) return false;
    D.active = true;
    D.setDate(ymd);
    return true;
  };
  // one uniform move per rAF, never more — pointer events can outrun frames
  var _pendDay = null, _rafOn = false;
  function pump() {
    if (!D.active) { _rafOn = false; return; }
    if (_pendDay != null) {
      var day = _pendDay; _pendDay = null;
      eachMap(function (m, side) {
        try { overlayFor(m).setProps({ layers: buildLayers(side, day) }); } catch (e) {}
      });
    }
    requestAnimationFrame(pump);
  }
  D.setDate = function (ymd) {
    if (!D.active || ymd == null) return;
    _pendDay = ymd;
    if (!_rafOn) { _rafOn = true; pump(); }
  };
  D.end = function () {
    D.active = false;
    eachMap(function (m) {
      try { if (m.__msDeckOverlay) m.__msDeckOverlay.setProps({ layers: [] }); } catch (e) {}
    });
  };

  // PREWARM (8/17): the FIRST drag of a session paid a ~0.5s hitch fetching + parsing tiles deck
  // had never asked for. The engine's own tiles come from the same URLs, but through mapbox-gl's
  // internal cache, which deck cannot read — so warm the HTTP/service-worker cache at idle and
  // the first drag starts from a warm cache like every later one. Bounded and idempotent.
  var _warmed = {}, _warmN = 0;
  function x2(lon, z) { return Math.floor(((lon + 180) / 360) * Math.pow(2, z)); }
  function y2(lat, z) {
    var l = Math.max(-85.05, Math.min(85.05, lat)) * Math.PI / 180;
    return Math.floor(((1 - Math.log(Math.tan(l) + 1 / Math.cos(l)) / Math.PI) / 2) * Math.pow(2, z));
  }
  D.warm = function () {
    if (D.active || !deckWanted() || !D.available() || _warmN > 400) return;
    var m = typeof beforeMap !== "undefined" ? beforeMap : null;
    if (!m || !m.getBounds) return;
    var b; try { b = m.getBounds(); } catch (e) { return; }
    var z0 = Math.floor(m.getZoom()), budget = 12;
    collect().forEach(function (it) {
      var z = Math.max(it.tiles.minZoom, Math.min(it.tiles.maxZoom, z0)), N = Math.pow(2, z) - 1;
      var xa = Math.max(0, x2(b.getWest(), z)), xb = Math.min(N, x2(b.getEast(), z));
      var ya = Math.max(0, y2(b.getNorth(), z)), yb = Math.min(N, y2(b.getSouth(), z));
      for (var x = xa; x <= xb && budget > 0; x++) {
        for (var y = ya; y <= yb && budget > 0; y++) {
          var u = it.tiles.url.replace(/\{z\}/gi, z).replace(/\{x\}/gi, x).replace(/\{y\}/gi, y);
          if (_warmed[u]) continue;
          _warmed[u] = 1; _warmN++; budget--;
          try { fetch(u, { credentials: "omit" }).then(function (r) { return r.arrayBuffer(); }).catch(function () {}); } catch (e) {}
        }
      }
    });
  };
  // self-contained boot: rasterScrub only exists on maps that have bakes, and deck now serves
  // maps that have none
  var t = 0;
  (function hook() {
    if (++t > 40) return;
    var m = typeof beforeMap !== "undefined" ? beforeMap : null;
    if (!m || !m.on) return void setTimeout(hook, 500);
    m.on("idle", function () { try { D.warm(); } catch (e) {} });
  })();
})();
