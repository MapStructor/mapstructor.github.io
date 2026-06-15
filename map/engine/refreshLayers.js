function refreshLayers() {
    if (typeof layers !== 'undefined') {
        flatLayers(layers).forEach(layer => {
            const checkbox = document.getElementById(layer.toggleElement);
            const leftId  = layer.id + "-left";
            const rightId = layer.id + "-right";
            const vis = checkbox && checkbox.checked ? "visible" : "none";
            if (checkbox && beforeMap.getLayer(leftId))  beforeMap.setLayoutProperty(leftId,  "visibility", vis);
            if (checkbox && afterMap.getLayer(rightId))  afterMap.setLayoutProperty(rightId,  "visibility", vis);
            // keep a fill layer's separate stroke line layer in sync with its checkbox
            const strokeL = layer.id + "-stroke-left";
            const strokeR = layer.id + "-stroke-right";
            if (checkbox && beforeMap.getLayer(strokeL)) beforeMap.setLayoutProperty(strokeL, "visibility", vis);
            if (checkbox && afterMap.getLayer(strokeR)) afterMap.setLayoutProperty(strokeR, "visibility", vis);
        });
    }
}
