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
function addLayersToMap(map, side, date) {
  flatLayers(layers).forEach(layer => {
    addMapLayer(map, { ...layer, id: layer.id + "-" + side }, date);
    if (layer.highlight) {
      const hl = { ...layer, paint: highlightSelectablePaint(layer.highlight), source: layer.id + "-" + side };
      addMapLayer(map, { ...hl, id: layer.id + "-highlighted-" + side }, date);
    }
    // A fill layer with a `stroke` paint renders its boundary as a real line layer,
    // sharing the fill's source (Mapbox fill-outline-color can't exceed 1px). For a vector
    // tileset the line needs the same source-layer to find the geometry; geojson has none.
    if (layer.stroke) {
      const strokeCfg = { id: layer.id + "-stroke-" + side, type: "line", source: layer.id + "-" + side, paint: layer.stroke, layout: { "line-cap": "round", "line-join": "round" } };
      if (layer["source-layer"]) strokeCfg["source-layer"] = layer["source-layer"];
      addMapLayer(map, strokeCfg, date);
    }
  });
}

function addLayers(date) {
  addLayersToMap(beforeMap, "left",  date);
  addLayersToMap(afterMap,  "right", date);
}
