function addLayersToMap(map, side, date) {
  flatLayers(layers).forEach(layer => {
    addMapLayer(map, { ...layer, id: layer.id + "-" + side }, date);
    if (layer.highlight) {
      const hl = { ...layer, paint: layer.highlight, source: layer.id + "-" + side };
      addMapLayer(map, { ...hl, id: layer.id + "-highlighted-" + side }, date);
    }
    // A fill layer with a `stroke` paint renders its boundary as a real line layer,
    // sharing the fill's source (Mapbox fill-outline-color can't exceed 1px).
    if (layer.stroke) {
      addMapLayer(map, { id: layer.id + "-stroke-" + side, type: "line", source: layer.id + "-" + side, paint: layer.stroke, layout: { "line-cap": "round", "line-join": "round" } }, date);
    }
  });
}

function addLayers(date) {
  addLayersToMap(beforeMap, "left",  date);
  addLayersToMap(afterMap,  "right", date);
}
