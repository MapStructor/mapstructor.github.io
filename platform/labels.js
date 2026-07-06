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
  function msLabelLayerFor(layer, side, initVis) {
    if (!layer || !layer.labels || !layer.labels.field) return null;
    if (!(layer.source && layer.source.type === 'geojson')) return null;   // geojson (drawn/imported) layers only for now
    var cfg = layer.labels;
    var field = cfg.field;
    // sizeFor(wrap): builds text-size with the per-feature override applied by `wrap` at each value.
    // A zoom curve must be the OUTERMOST expression, so in vary mode the interpolate stays on top
    // and the override sits inside each stop.
    function sizeFor(wrap) {
      if (cfg.varyZoom === true && cfg.size && cfg.size.length === 3) {
        return ['interpolate', ['linear'], ['zoom'], 6, wrap(+cfg.size[0] || 10), 11, wrap(+cfg.size[1] || 13), 16, wrap(+cfg.size[2] || 17)];
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
        'text-font': cfg.bold === false ? FONTS_REG : FONTS_BOLD, 'text-allow-overlap': false,
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
      base.source = layer.id + '-' + side;                    // shared source; text follows the line
      base.layout['symbol-placement'] = 'line';
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
