function addLayersToMap(map, side, date) {
  flatLayers(layers).forEach(layer => {
    addMapLayer(map, { ...layer, id: layer.id + "-" + side }, date);
    if (layer.highlight) {
      const hl = { ...layer, paint: layer.highlight };
      addMapLayer(map, { ...hl, id: layer.id + "-highlighted-" + side }, date);
    }
  });
}

function addLayers(date) {
  addLayersToMap(beforeMap, "left",  date);
  addLayersToMap(afterMap,  "right", date);
}
