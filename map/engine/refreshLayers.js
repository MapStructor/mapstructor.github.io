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
            // keep every companion (outline, hover highlight, labels, edited-features overlay) in
            // sync with the checkbox. This list used to stop at labels, so unticking a folded,
            // edited layer left its edited shapes painted over a layer that was switched off.
            // Falls back to the historical subset if utils.js somehow has not loaded.
            const companions = (typeof MS_COMPANIONS !== "undefined" && MS_COMPANIONS) || ["-stroke-", "-highlighted-", "-label-"];
            companions.forEach(sfx => {
                const l = layer.id + sfx + "left", r = layer.id + sfx + "right";
                if (checkbox && beforeMap.getLayer(l)) beforeMap.setLayoutProperty(l, "visibility", vis);
                if (checkbox && afterMap.getLayer(r)) afterMap.setLayoutProperty(r, "visibility", vis);
            });
        });
    }
}
