function refreshLayers() {
    if (typeof layers !== 'undefined') {
        flatLayers(layers).forEach(layer => {
            const checkbox = document.getElementById(layer.toggleElement);
            const leftId  = layer.id + "-left";
            const rightId = layer.id + "-right";
            const vis = checkbox && checkbox.checked ? "visible" : "none";
            if (checkbox && beforeMap.getLayer(leftId))  beforeMap.setLayoutProperty(leftId,  "visibility", vis);
            if (checkbox && afterMap.getLayer(rightId))  afterMap.setLayoutProperty(rightId,  "visibility", vis);
            // keep the companion layers (stroke outline, hover highlight, map labels) in sync with the checkbox
            ["-stroke-", "-highlighted-", "-label-"].forEach(sfx => {
                const l = layer.id + sfx + "left", r = layer.id + sfx + "right";
                if (checkbox && beforeMap.getLayer(l)) beforeMap.setLayoutProperty(l, "visibility", vis);
                if (checkbox && afterMap.getLayer(r)) afterMap.setLayoutProperty(r, "visibility", vis);
            });
        });
    }
}
