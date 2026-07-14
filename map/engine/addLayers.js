// A hover-driven highlight paint also responds to a persistent `selected` state (set on click) so the
// click highlight survives mouseleave and shows on BOTH swipe sides. Replaces every ["feature-state","hover"]
// lookup with hover-OR-selected.
function highlightSelectablePaint(p) {
  if (Array.isArray(p)) {
    if (p.length === 2 && p[0] === "feature-state" && p[1] === "hover")
      return ["any", ["boolean", ["feature-state", "hover"], false], ["boolean", ["feature-state", "selected"], false]];
    return p.map(highlightSelectablePaint);
  }
  if (p && typeof p === "object") { var o = {}; for (var k in p) o[k] = highlightSelectablePaint(p[k]); return o; }
  return p;
}
// UNIVERSAL STYLE COLUMNS (geojson layers): every feature carries ms_color / ms_opacity / ms_thickness —
// when set, they override the layer style per feature. Applied at ADD time only, so the stored paint stays
// clean (no double-wrapping). Numbers need guarded expressions: to-number(null) is 0, which would zero
// widths/opacities for every feature without a value.
function msNumCol(prop, fallback) {
  const g = ["get", prop];
  return ["case",
    ["==", ["typeof", g], "number"], g,
    ["all", ["==", ["typeof", g], "string"], ["!=", g, ""]], ["to-number", g, fallback],
    fallback];
}
function styleColumnPaint(layer) {
  if (!layer.paint || !(layer.source && layer.source.type === "geojson")) return layer.paint;
  const p = { ...layer.paint };
  const ck = layer.type === "fill" ? "fill-color" : layer.type === "line" ? "line-color" : "circle-color";
  const ok = layer.type === "fill" ? "fill-opacity" : layer.type === "line" ? "line-opacity" : "circle-opacity";
  if (p[ck] != null) p[ck] = ["to-color", ["get", "ms_color"], p[ck]];
  if (p[ok] != null && typeof p[ok] !== "object") p[ok] = msNumCol("ms_opacity", p[ok]);
  if (layer.type === "line" && p["line-width"] != null) p["line-width"] = msNumCol("ms_thickness", p["line-width"]);
  if (layer.type === "circle" && p["circle-radius"] != null) {
    // per-feature ms_thickness override, then zoom-scaled: the stored radius is the ZOOMED-IN size,
    // shrinking toward 35% by z6 — matches the editor's draw copies (points read like real markers)
    const R = msNumCol("ms_thickness", p["circle-radius"]);
    p["circle-radius"] = ["interpolate", ["linear"], ["zoom"], 6, ["max", 2, ["*", 0.35, R]], 11, ["*", 0.65, R], 16, R];
  }
  // ms_linecolor: polygon outline / point stroke colour ("none"/invalid falls through to the layer's own)
  if (layer.type === "fill" && p["fill-outline-color"] != null) p["fill-outline-color"] = ["to-color", ["get", "ms_linecolor"], p["fill-outline-color"]];
  if (layer.type === "circle" && p["circle-stroke-color"] != null) p["circle-stroke-color"] = ["to-color", ["get", "ms_linecolor"], p["circle-stroke-color"]];
  return p;
}
// the stroke companion (a fill's real outline line layer) takes the same per-feature columns:
// ms_linecolor drives its colour, ms_thickness its width
function styleColumnStroke(layer) {
  if (!layer.stroke || !(layer.source && layer.source.type === "geojson")) return layer.stroke;
  const s = { ...layer.stroke };
  if (s["line-color"] != null) s["line-color"] = ["to-color", ["get", "ms_linecolor"], s["line-color"]];
  if (s["line-width"] != null && typeof s["line-width"] !== "object") s["line-width"] = msNumCol("ms_thickness", s["line-width"]);
  return s;
}
// A fill whose `highlight` is the marker `true` hovers INLINE: the fill's OWN opacity drops to 0.5
// on hover/selected (the AHM building-dim). An overlay twin in the layer's own colour is invisible
// on an opaque fill — same colour painted over itself — so opaque tileset fills use this instead.
function hoverInlinePaint(layer, p) {
  if (!p || layer.type !== "fill" || layer.highlight !== true || typeof p["fill-opacity"] !== "number") return p;
  const on = ["any", ["boolean", ["feature-state", "hover"], false], ["boolean", ["feature-state", "selected"], false]];
  return { ...p, "fill-opacity": ["case", on, 0.5, p["fill-opacity"]] };
}
function addLayersToMap(map, side, date) {
  flatLayers(layers).forEach(layer => {
    // off-by-default layers (and their stroke/highlight companions) are ADDED hidden — no visible-then-hidden load flash
    const initVis = layer.checked === false ? "none" : "visible";
    addMapLayer(map, { ...layer, paint: hoverInlinePaint(layer, styleColumnPaint(layer)), id: layer.id + "-" + side }, date);
    if (layer.highlight && layer.highlight !== true) {   // `true` = inline hover (above), no overlay layer
      const hl = { ...layer, paint: highlightSelectablePaint(layer.highlight), source: layer.id + "-" + side };
      hl.layout = { ...(hl.layout || {}), visibility: initVis };
      addMapLayer(map, { ...hl, id: layer.id + "-highlighted-" + side }, date);
    }
    // A fill layer with a `stroke` paint renders its boundary as a real line layer,
    // sharing the fill's source (Mapbox fill-outline-color can't exceed 1px). For a vector
    // tileset the line needs the same source-layer to find the geometry; geojson has none.
    if (layer.stroke) {
      const strokeCfg = { id: layer.id + "-stroke-" + side, type: "line", source: layer.id + "-" + side, paint: styleColumnStroke(layer), layout: { "line-cap": "round", "line-join": "round", visibility: initVis } };
      if (layer["source-layer"]) strokeCfg["source-layer"] = layer["source-layer"];
      addMapLayer(map, strokeCfg, date);
    }
    // per-layer map labels (raw_config.labels = {field}) — polygons/points get an anchor source
    // (pole of inaccessibility via labels.js), lines label along the path from the shared source
    if (layer.labels && typeof msLabelLayerFor === "function") {
      const ll = msLabelLayerFor(layer, side, initVis);
      if (ll) {
        try {
          if (ll.sourceId && !map.getSource(ll.sourceId)) map.addSource(ll.sourceId, ll.source);
          if (!map.getLayer(ll.layer.id)) map.addLayer(ll.layer);
        } catch (e) { console.warn("label layer failed", layer.id, e); }
      }
    }
  });
}

function addLayers(date) {
  addLayersToMap(beforeMap, "left",  date);
  addLayersToMap(afterMap,  "right", date);
  // labels always render ABOVE fills/strokes added after them in the loop
  if (typeof msRaiseLabelLayers === "function") {
    msRaiseLabelLayers(beforeMap, layers);
    msRaiseLabelLayers(afterMap,  layers);
  }
}
