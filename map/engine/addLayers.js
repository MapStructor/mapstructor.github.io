function addLayersToMap(map, side, date) {
  flatLayers(layers).forEach(layer => {
    addMapLayer(map, { ...layer, id: layer.id + "-" + side }, date);
    if (layer.highlight) {
      const hl = { ...layer, paint: layer.highlight, source: layer.id + "-" + side };
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
