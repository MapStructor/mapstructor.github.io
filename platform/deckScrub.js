/* deckScrub.js — instant timeline scrub rendered by deck.gl (8/16, the "win-win" track).
   While the slider is DRAGGED, the baked layers render as deck.gl MVT layers reading the SAME
   pmtiles the engine already serves (via the pmt service worker); date-visibility is a GPU
   DataFilterExtension uniform — instant at any data size, DAY-exact, styling-true (colours read
   live from the engine's paint), with NO bake artifacts. rasterScrub owns the seam and calls
   this when available; the baked raster stays as the automatic fallback for software-rendered /
   weak GPUs (D.available() false) or when the "deck" chip is unchecked.
   REMOVE ENTIRELY: delete this file, its <script> include in map/index.html + map/editor.html,
   and the MSDeckScrub references in rasterScrub.js. Nothing else references it. */
(function () {
  "use strict";
  if (window.MSDeckScrub) return;
  var LS = "ms-deck-scrub";
  var D = { enabled: localStorage.getItem(LS) !== "off", active: false, items: null };
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
  D.setEnabled = function (on) { D.enabled = !!on; localStorage.setItem(LS, on ? "on" : "off"); };

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

  function nodeById(id) {
    var hit = null;
    (function walk(a) { (a || []).forEach(function (n) { if (hit) return; if (n.id === id) hit = n; else if (n.children) walk(n.children); }); })(typeof layers !== "undefined" ? layers : []);
    return hit;
  }
  function rgbOf(c, fb) {
    var m = /^#?([0-9a-f]{6})/i.exec(String(c || "").replace(/^#/, "").length >= 6 ? String(c || "").trim() : "");
    if (!m) return fb;
    var n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  // colour accessor from the LIVE engine paint — a flat colour string, or a categorical
  // ["match", ["get",prop] | ["id"], v,c,…,fallback] lookup, so colour-by and per-feature
  // styling survive (the engine paints per-feature via ["match",["id"],msid,colour,…])
  function accessorFor(m, layerId, prop, fallback) {
    var v = null;
    try { v = m.getPaintProperty(layerId, prop); } catch (e) {}
    if (Array.isArray(v) && v[0] === "match" && Array.isArray(v[1])) {
      var byId = v[1][0] === "id";
      var key = byId ? null : (v[1][0] === "get" ? v[1][1] : null);
      if (byId || key) {
        var map = {}, dflt = rgbOf(v[v.length - 1], fallback);
        for (var i = 2; i + 1 < v.length; i += 2) map[v[i]] = rgbOf(v[i + 1], dflt);
        return function (f) {
          var k = byId ? (f.id != null ? f.id : (f.properties || {}).msid) : (f.properties || {})[key];
          return map[k] || dflt;
        };
      }
    }
    var flat = rgbOf(v, fallback);
    return function () { return flat; };
  }
  function tilesOf(node) {
    var s = node && node.source;
    if (!s) return null;
    var t = (s.tiles && s.tiles[0]) || s.url || null;
    if (!t || /^mapbox:/.test(String(t))) return null;   // mapbox-hosted tilesets have no raw tile URL
    // new URL() percent-encodes the {z}/{x}/{y} braces, which makes MVTLayer read the template
    // as a TileJSON endpoint — decode them back after resolving
    try { return { url: new URL(String(t), location.href).href.replace(/%7B/gi, "{").replace(/%7D/gi, "}"), minZoom: s.minzoom || 0, maxZoom: s.maxzoom != null ? +s.maxzoom : 15 }; } catch (e) { return null; }
  }

  // one deck layer list per MAP (deck layer instances cannot be shared between two Deck contexts)
  function buildLayers(m, side, day) {
    var n = ymd2n(day);
    if (n == null) return [];
    var out = [], seen = {};
    (D.items || []).forEach(function (it) {
      if (it.isBorder || !it.slug || seen[it.slug]) return;
      seen[it.slug] = true;
      var cb = document.getElementById(it.slug);   // sidebar checkbox gates the layer, same rule as the raster
      if (cb && "checked" in cb && !cb.checked) return;
      var node = nodeById(it.slug);
      var t = tilesOf(node);
      if (!t) return;
      var engineId = it.slug + "-" + side;
      var isLine = !!(node && node.type === "line");
      var fill = accessorFor(m, engineId, isLine ? "line-color" : "fill-color", [143, 122, 224]);
      var line = isLine ? fill : accessorFor(m, engineId, "fill-outline-color", [40, 40, 40]);
      out.push(new deck.MVTLayer({
        id: "ms-deck-" + it.slug,
        data: t.url,
        minZoom: t.minZoom, maxZoom: t.maxZoom,
        binary: false,   // full GeoJSON features so accessors see feature.id (the engine's per-feature colour key)
        filled: !isLine, stroked: true,
        getFillColor: function (f) { return fill(f).concat(150); },
        getLineColor: function (f) { return line(f).concat(isLine ? 235 : 200); },
        getLineWidth: isLine ? 1.6 : 1, lineWidthUnits: "pixels",
        getPointRadius: 4, pointRadiusUnits: "pixels",
        getFilterValue: function (f) {
          var p = f.properties || {};
          var s0 = ymd2n(p.DayStart), e0 = ymd2n(p.DayEnd);
          return [s0 == null ? -1 : s0, e0 == null ? 1e7 : e0];   // undated = visible always, like the engine's coalesce filter
        },
        filterRange: [[-1, n], [n, 1e7]],
        extensions: [new deck.DataFilterExtension({ filterSize: 2 })],
        pickable: false
      }));
    });
    return out;
  }

  function eachMap(fn) {
    [[typeof beforeMap !== "undefined" ? beforeMap : null, "left"], [typeof afterMap !== "undefined" ? afterMap : null, "right"]].forEach(function (pr) {
      if (pr[0]) fn(pr[0], pr[1]);
    });
  }
  function overlayFor(m) {
    if (m.__msDeckOverlay) return m.__msDeckOverlay;
    var o = new deck.MapboxOverlay({ layers: [] });
    m.addControl(o);
    m.__msDeckOverlay = o;
    return o;
  }

  D.begin = function (items, ymd) {
    if (!D.available()) return false;
    // refuse when no item resolves to fetchable tiles — the caller falls back to the raster
    // rather than hiding the vectors behind an empty overlay
    var usable = (items || []).some(function (it) { return !it.isBorder && it.slug && tilesOf(nodeById(it.slug)); });
    if (!usable) return false;
    D.items = items;
    D.active = true;
    D.setDate(ymd);
    return true;
  };
  D.setDate = function (ymd) {
    if (!D.active) return;
    eachMap(function (m, side) {
      try { overlayFor(m).setProps({ layers: buildLayers(m, side, ymd) }); } catch (e) {}
    });
  };
  D.end = function () {
    D.active = false;
    eachMap(function (m) {
      try { if (m.__msDeckOverlay) m.__msDeckOverlay.setProps({ layers: [] }); } catch (e) {}
    });
  };
})();
