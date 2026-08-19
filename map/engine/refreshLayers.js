function refreshLayers() {
    if (typeof layers !== 'undefined') {
        flatLayers(layers).forEach(layer => {
            // FALL BACK TO THE NODE'S OWN ID (8/18). Every other consumer of toggleElement already
            // does — generateMaps, mapinit, deckScrub, editing all read `toggleElement || id`. This
            // one did not, and because every branch below is guarded by `checkbox &&`, a stale
            // toggleElement meant refreshLayers did NOTHING for that layer: unticking it left the
            // features on the map with no way to turn them off ("everything is off in the sidebar,
            // but there is still stuff on the map"). Hit by copied OUTLINE layers, whose new slug
            // was written while toggleElement kept the pre-copy id.
            const checkbox = document.getElementById(layer.toggleElement) || document.getElementById(layer.id);
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
