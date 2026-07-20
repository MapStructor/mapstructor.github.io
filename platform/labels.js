// MapStructor — map labels for drawn/imported (geojson) layers, any geometry type.
// One "Map labels" checkbox per layer + a field pick; everything else is opinionated defaults:
// black text, 1px white halo, DIN Pro, size ramped by zoom. Loaded by BOTH map pages; the engine
// (addLayers.js) calls msLabelLayerFor() at add time, the editor rebuilds label layers live.
(function () {
  'use strict';

  // default text size across zooms — "local vs regional vs global" handled by one ramp
  var TEXT_SIZE = ['interpolate', ['linear'], ['zoom'], 6, 10, 10, 12, 14, 15, 16, 17];
  var FONTS_BOLD = ['DIN Pro Bold', 'Arial Unicode MS Bold'];
  var FONTS_REG = ['DIN Pro Regular', 'Arial Unicode MS Regular'];
  // fonts must exist on the STYLE's glyph server or Mapbox GL silently draws NO text (the request
  // 404s — the "labels never show" bug). Mapbox styles serve DIN Pro; the free basemaps (Esri
  // satellite / OpenFreeMap liberty) point glyphs at tiles.openfreemap.org, which only hosts Noto Sans.
  function fontsFor(map, bold) {
    var glyphs = '';
    try { glyphs = (map.getStyle() && map.getStyle().glyphs) || ''; } catch (e) {}
    if (glyphs && glyphs.indexOf('mapbox.com') === -1 && glyphs.indexOf('mapbox://') === -1)
      return bold ? ['Noto Sans Bold'] : ['Noto Sans Regular'];
    return bold ? FONTS_BOLD : FONTS_REG;   // no map / no glyphs info → Mapbox default (known good)
  }

  // ── pole of inaccessibility (compact port of Mapbox's polylabel) ──
  // the visual center of a polygon: the interior point farthest from every edge —
  // guaranteed inside, even for concave / donut shapes (a centroid is not).
  function pointToPolygonDist(x, y, rings) {
    var inside = false, minDistSq = Infinity;
    for (var r = 0; r < rings.length; r++) {
      var ring = rings[r];
      for (var i = 0, len = ring.length, j = len - 1; i < len; j = i++) {
        var a = ring[i], b = ring[j];
        if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
        var px = b[0], py = b[1], dx = a[0] - px, dy = a[1] - py;
        if (dx !== 0 || dy !== 0) {
          var t = ((x - px) * dx + (y - py) * dy) / (dx * dx + dy * dy);
          if (t > 1) { px = a[0]; py = a[1]; }
          else if (t > 0) { px += dx * t; py += dy * t; }
        }
        dx = x - px; dy = y - py;
        var d = dx * dx + dy * dy;
        if (d < minDistSq) minDistSq = d;
      }
    }
    return (inside ? 1 : -1) * Math.sqrt(minDistSq);
  }
  function msPolylabel(rings, precision) {
    precision = precision || 0.0001;   // ~10 m in degrees — plenty for label placement
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    rings[0].forEach(function (p) { if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0]; if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1]; });
    var width = maxX - minX, height = maxY - minY, cellSize = Math.min(width, height);
    if (cellSize === 0) return [minX, minY];
    function cell(x, y, h) { var d = pointToPolygonDist(x, y, rings); return { x: x, y: y, h: h, d: d, max: d + h * Math.SQRT2 }; }
    var queue = [], h = cellSize / 2;
    for (var x = minX; x < maxX; x += cellSize) for (var y = minY; y < maxY; y += cellSize) queue.push(cell(x + h, y + h, h));
    // centroid + bbox-center seeds
    var area = 0, cx = 0, cy = 0, r0 = rings[0];
    for (var i = 0, len = r0.length, j = len - 1; i < len; j = i++) { var a = r0[i], b = r0[j], f = a[0] * b[1] - b[0] * a[1]; cx += (a[0] + b[0]) * f; cy += (a[1] + b[1]) * f; area += f * 3; }
    var best = area === 0 ? cell(r0[0][0], r0[0][1], 0) : cell(cx / area, cy / area, 0);
    var bc = cell(minX + width / 2, minY + height / 2, 0);
    if (bc.d > best.d) best = bc;
    var iter = 0;
    while (queue.length && iter++ < 5000) {
      queue.sort(function (a2, b2) { return b2.max - a2.max; });
      var c = queue.shift();
      if (c.d > best.d) best = c;
      if (c.max - best.d <= precision) continue;
      var h2 = c.h / 2;
      if (h2 < precision / 2) continue;
      queue.push(cell(c.x - h2, c.y - h2, h2)); queue.push(cell(c.x + h2, c.y - h2, h2));
      queue.push(cell(c.x - h2, c.y + h2, h2)); queue.push(cell(c.x + h2, c.y + h2, h2));
    }
    return [best.x, best.y];
  }
  function ringArea(ring) {
    var s = 0;
    for (var i = 0, len = ring.length, j = len - 1; i < len; j = i++) s += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
    return Math.abs(s / 2);
  }
  function msLabelAnchor(geom) {   // → [lng,lat] or null (label anchor for polygon/point geometries)
    if (!geom) return null;
    if (geom.type === 'Point') return geom.coordinates;
    if (geom.type === 'MultiPoint') return geom.coordinates[0] || null;
    if (geom.type === 'Polygon') return msPolylabel(geom.coordinates);
    if (geom.type === 'MultiPolygon') {   // biggest part gets the label
      var best = null, bestA = -1;
      geom.coordinates.forEach(function (poly) { var a = ringArea(poly[0] || []); if (a > bestA) { bestA = a; best = poly; } });
      return best ? msPolylabel(best) : null;
    }
    return null;   // lines label along the line via symbol-placement, no anchor needed
  }

  // anchor FeatureCollection for polygon/point layers (text baked in as `lbl`).
  // Per-feature ms_labelsize (when numeric) is baked as `sz` and overrides the layer size.
  function msBuildLabelAnchors(features, field) {
    var out = [];
    (features || []).forEach(function (f) {
      if (!f || !f.geometry) return;
      var v = f.properties ? f.properties[field] : null;
      if (v == null || String(v).trim() === '') return;   // no value → no label (never "null" text)
      var at = msLabelAnchor(f.geometry);
      if (!at) return;
      var props = { lbl: String(v) };
      var ls = f.properties ? parseFloat(f.properties.ms_labelsize) : NaN;
      if (!isNaN(ls) && ls > 0) props.sz = ls;
      out.push({ type: 'Feature', geometry: { type: 'Point', coordinates: at }, properties: props });
    });
    return { type: 'FeatureCollection', features: out };
  }

  // the symbol layer (+ its own source for polygon/point anchors) for one layer/side.
  // Lines share the layer's existing source and curve along the path.
  // labels config: { field, color?, halo?, haloWidth?, bold?, sizeUniform?, varyZoom?, size?, density? }
  //   default sizing is UNIFORM (sizeUniform px at every zoom, default 14) — edits respond instantly;
  //   varyZoom:true switches to the size=[far,mid,close] ramp at z6/z11/z16.
  //   density = text-padding: the collision margin around each label — bigger margin, fewer labels drawn.
  function msLabelLayerFor(layer, side, initVis, map) {   // map (optional) picks glyph-server-safe fonts
    if (!layer || !layer.labels || !layer.labels.field) return null;
    var srcType = layer.source && layer.source.type;
    // geojson (drawn/imported) layers, PLUS tileset LINE layers (7/16): line labels ride the
    // vector source directly (symbol-placement: line) — no anchors needed. The label field must
    // be baked into the tiles (tilegen does: `label` always + the configured column at Publish).
    // Tileset points/polygons still need geojson anchors — not yet.
    if (!(srcType === 'geojson' || (srcType === 'vector' && layer.type === 'line'))) return null;
    var cfg = layer.labels;
    var field = cfg.field;
    // sizeFor(wrap): builds text-size with the per-feature override applied by `wrap` at each value.
    // A zoom curve must be the OUTERMOST expression, so in vary mode the interpolate stays on top
    // and the override sits inside each stop.
    // stops: cfg.sizeStops = [[zoom,px],…] (any count, editor-managed 7/15); legacy cfg.size =
    // [far,mid,close] maps to fixed z6/z11/z16. Sorted + deduped — interpolate needs ascending zooms.
    function sizeStopsOf() {
      var raw = (cfg.sizeStops && cfg.sizeStops.length) ? cfg.sizeStops
        : (cfg.size && cfg.size.length === 3) ? [[6, cfg.size[0]], [11, cfg.size[1]], [16, cfg.size[2]]] : null;
      if (!raw) return null;
      var st = raw.map(function (s) { return [+s[0], +s[1]]; }).filter(function (s) { return !isNaN(s[0]) && s[1] > 0; })
        .sort(function (a, b) { return a[0] - b[0]; });
      var out = [];
      st.forEach(function (s) { if (out.length && out[out.length - 1][0] === s[0]) out[out.length - 1] = s; else out.push(s); });
      return out.length ? out : null;
    }
    function sizeFor(wrap) {
      var st = cfg.varyZoom === true ? sizeStopsOf() : null;
      if (st && st.length === 1) return wrap(st[0][1]);   // a single stop = constant size (interpolate needs ≥2)
      if (st) {
        var e = ['interpolate', ['linear'], ['zoom']];
        st.forEach(function (s) { e.push(s[0], wrap(s[1])); });
        return e;
      }
      return wrap(cfg.sizeUniform != null && +cfg.sizeUniform > 0 ? +cfg.sizeUniform : 10);
    }
    // the halo control sets the CLOSE-UP width (default 2); it thins with the smaller text farther out
    var hw = cfg.haloWidth != null ? +cfg.haloWidth : 2;
    var halo = ['interpolate', ['linear'], ['zoom'], 6, Math.round(hw * 0.6 * 10) / 10, 11, Math.round(hw * 0.8 * 10) / 10, 16, hw];
    var id = layer.id + '-label-' + side;
    var base = {
      id: id, type: 'symbol',
      layout: {
        'text-font': map ? fontsFor(map, cfg.bold !== false) : (cfg.bold === false ? FONTS_REG : FONTS_BOLD), 'text-allow-overlap': false,
        'text-padding': cfg.density != null ? +cfg.density : 10, visibility: initVis || 'visible'
      },
      paint: {
        'text-color': cfg.color || '#000000',
        'text-halo-color': cfg.halo || '#ffffff',
        'text-halo-width': halo
      }
    };
    if (layer.type === 'circle') {   // sit below the marker, not on top of it
      base.layout['text-anchor'] = 'top';
      base.layout['text-offset'] = [0, 0.7];
    }
    if (layer.type === 'line') {
      // GROUPED tileset lines ("treat as one", 7/17): a long company name never fits along one short
      // FRAGMENT, so per-fragment line placement starves (~1 label/screen on the railways). Instead:
      // ONE anchor per group value, computed from what's actually RENDERED (timeline + zoom correct),
      // at the midpoint of the group's longest visible piece, rotated to lie along it. Refreshes on
      // map idle when the view/filter changes — labels behave as if the segments were one line.
      if (srcType === 'vector' && layer.groupBy && map) {
        var gsrcId = layer.id + '-glabels-' + side;
        base.source = gsrcId;
        base.layout['text-field'] = ['get', 't'];
        base.layout['text-rotate'] = ['get', 'r'];
        base.layout['text-rotation-alignment'] = 'map';
        base.layout['text-padding'] = cfg.density != null ? +cfg.density : 2;
        base.layout['text-size'] = sizeFor(function (v) { return v; });
        msWireGroupLabelAnchors(map, layer, side, gsrcId);
        return { sourceId: gsrcId, source: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } }, layer: base };
      }
      base.source = layer.id + '-' + side;                    // shared source; text follows the line
      if (srcType === 'vector') base['source-layer'] = layer['source-layer'] || 'features';   // tileset lines
      base.layout['symbol-placement'] = 'line';
      // fragmented data (e.g. railway segments) fits labels rarely — tolerate curvature, try
      // anchors far more often, and keep collision margins slim (measured 7/16: defaults left
      // 0–8 labels per screen at every zoom on the railways)
      base.layout['text-max-angle'] = 80;
      base.layout['symbol-spacing'] = 120;
      if (cfg.density == null) base.layout['text-padding'] = 2;   // line labels: slim default margin (the density control still overrides)
      base.layout['text-field'] = ['to-string', ['coalesce', ['get', field], '']];
      // per-feature ms_labelsize (numeric or numeric string) overrides the layer size
      var g2 = ['get', 'ms_labelsize'];
      base.layout['text-size'] = sizeFor(function (v) {
        return ['case',
          ['==', ['typeof', g2], 'number'], g2,
          ['all', ['==', ['typeof', g2], 'string'], ['!=', g2, ''], ['!=', g2, 'none']], ['to-number', g2, v],
          v];
      });
      return { layer: base };
    }
    var srcId = layer.id + '-labels-' + side;
    base.source = srcId;
    base.layout['text-field'] = ['get', 'lbl'];
    base.layout['text-size'] = sizeFor(function (v) { return ['coalesce', ['get', 'sz'], v]; });   // baked ms_labelsize wins
    return {
      sourceId: srcId,
      source: { type: 'geojson', data: msBuildLabelAnchors(layer.source.data && layer.source.data.features, field) },
      layer: base
    };
  }

  // Group-key normalizer — TRIM ONLY (user 7/18: variant folding like "&"↔"and" removed;
  // may return later as an opt-in — it can wrongly merge genuinely distinct values).
  // Blank/whitespace still never groups.
  function msGroupNorm(v) {
    return String(v == null ? '' : v).trim();
  }
  window.msGroupNorm = msGroupNorm;

  // one label anchor per group FAMILY (normalized), from the RENDERED (date-filtered, visible)
  // fragments — recomputed when the view or the layer's filter changes; wired once per map+layer+side
  function msWireGroupLabelAnchors(map, layer, side, gsrcId) {
    var reg = map._msGAnchors || (map._msGAnchors = {});
    var wkey = layer.id + '|' + side;
    if (reg[wkey]) return; reg[wkey] = true;
    var lineId = layer.id + '-' + side, key = layer.groupBy, lastSig = null, t = null;
    function lineLen(c) {
      var L = 0;
      for (var i = 1; i < c.length; i++) {
        var dx = (c[i][0] - c[i - 1][0]) * Math.cos(c[i][1] * Math.PI / 180), dy = c[i][1] - c[i - 1][1];
        L += Math.sqrt(dx * dx + dy * dy);
      }
      return L;
    }
    function recompute() {
      try {
        if (!map.getLayer(lineId) || !map.getSource(gsrcId)) return;
        var fs = map.queryRenderedFeatures({ layers: [lineId] }) || [];
        var best = {};   // normalized family → its longest visible piece (+ the raw name to display)
        for (var i = 0; i < fs.length; i++) {
          var p = fs[i].properties || {};
          var v = (key === 'label') ? p.label : p[key];
          var nv = msGroupNorm(v);
          if (!nv) continue;
          var g = fs[i].geometry; if (!g) continue;
          var lines = g.type === 'LineString' ? [g.coordinates] : (g.type === 'MultiLineString' ? g.coordinates : []);
          for (var j = 0; j < lines.length; j++) {
            if (lines[j].length < 2) continue;
            var L = lineLen(lines[j]);
            if (!best[nv] || L > best[nv].len) best[nv] = { len: L, coords: lines[j], raw: String(v).trim() };
          }
        }
        var out = [];
        Object.keys(best).forEach(function (v0) {
          var v = best[v0].raw;
          var c = best[v0].coords;
          var m2 = Math.floor(c.length / 2);
          var a = c[Math.max(0, m2 - 1)], b = c[Math.min(c.length - 1, m2 + 1)], mid = c[m2];
          var dx = (b[0] - a[0]) * Math.cos(mid[1] * Math.PI / 180), dy = b[1] - a[1];
          var rot = -(Math.atan2(dy, dx) * 180 / Math.PI);   // lie along the piece; text-rotate is clockwise
          while (rot > 90) rot -= 180; while (rot < -90) rot += 180;
          out.push({ type: 'Feature', geometry: { type: 'Point', coordinates: mid }, properties: { t: v, r: Math.round(rot) } });
        });
        var s = map.getSource(gsrcId);
        if (s && s.setData) s.setData({ type: 'FeatureCollection', features: out });
      } catch (e) {}
    }
    map.on('idle', function () {
      var sig;
      try { sig = map.getZoom().toFixed(2) + '|' + map.getCenter().lng.toFixed(3) + '|' + map.getCenter().lat.toFixed(3) + '|' + JSON.stringify(map.getFilter(lineId) || null); } catch (e) { sig = null; }
      // while the glabels source is EMPTY, never gate — a recompute that ran before the tiles
      // re-rendered (basemap switch) found 0 features, and with the camera unmoved the signature
      // would block every retry forever. Recomputing on an empty source is cheap.
      var empty = false;
      try { var s0 = map.getSource(gsrcId); empty = !s0 || !s0._data || !s0._data.features || !s0._data.features.length; } catch (e) {}
      if (!empty && sig !== null && sig === lastSig) return; lastSig = sig;
      clearTimeout(t); t = setTimeout(recompute, 120);
    });
    // A basemap switch re-adds the glabels source EMPTY without moving the camera — the idle
    // signature (zoom|center|filter) is unchanged, so the gate above would swallow the recompute
    // and the labels stay gone until a pan (7/18). Reset the gate and repopulate as soon as the
    // re-added layer + source exist again.
    map.on('style.load', function () {
      lastSig = null;
      var tries = 0;
      (function again() {
        try {
          if (map.getLayer(lineId) && map.getSource(gsrcId)) {
            recompute();
            // keep retrying until the recompute actually PRODUCED labels — right after the swap
            // the tiles may not have re-rendered yet, so an early recompute finds 0 features
            var s1 = map.getSource(gsrcId);
            if (s1 && s1._data && s1._data.features && s1._data.features.length) return;
          }
        } catch (e) {}
        if (++tries < 40) setTimeout(again, 500);
      })();
    });
  }

  // labels must never hide under fills/strokes added after them (engine layers, MapboxDraw copies,
  // the right-side mirror) — call after any batch of layer adds to put every label back on top
  function msRaiseLabelLayers(map, tree) {
    if (!map) return;
    (function walk(arr) {
      (arr || []).forEach(function (n) {
        if (n && n.id) ['left', 'right'].forEach(function (side) {
          var id = n.id + '-label-' + side;
          try { if (map.getLayer(id)) map.moveLayer(id); } catch (e) {}
        });
        if (n && n.children) walk(n.children);
      });
    })(tree);
  }

  window.msLabelAnchor = msLabelAnchor;
  window.msBuildLabelAnchors = msBuildLabelAnchors;
  window.msLabelLayerFor = msLabelLayerFor;
  window.msRaiseLabelLayers = msRaiseLabelLayers;
})();
