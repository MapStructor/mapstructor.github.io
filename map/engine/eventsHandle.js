let hoveredID = new Array();
let hoverPopUp = new Array();

// Set a feature's hover state on BOTH swipe maps so the highlight shows left AND right. afterMap is the
// clipped top map and only fires events in its own half, so each side's handler must light up both.
function setHoverBoth(config, fid, on) {
  if (fid == null) return;
  if (on && (config.hoverHighlight === false || config.groupBy)) return;   // #11 gate; grouped ("treat as one") layers never emphasize ONE segment — the group overlay owns hover
  const sl = config["source-layer"];
  try { if (typeof beforeMap !== 'undefined' && beforeMap) beforeMap.setFeatureState({ source: config.id + "-left",  sourceLayer: sl, id: fid }, { hover: on }); } catch (e) {}
  try { if (typeof afterMap  !== 'undefined' && afterMap)  afterMap.setFeatureState({  source: config.id + "-right", sourceLayer: sl, id: fid }, { hover: on }); } catch (e) {}
}

let wiredInteraction = {};

function setupLayerEvents() {
  flatLayers(layers).filter(l => l.popupStyle || l.highlight || l.click).forEach(wireLayerInteraction);   // hover-highlight needs only `highlight` (e.g. curr-builds has no popupStyle); popup stays gated to popupStyle
}

// Idempotent per-layer wiring, also callable LIVE from the editor when the user turns interaction on for a
// layer that had none at load (#12 — no reload needed). Handlers read config at event time, so toggling
// popupStyle/click off applies live too.
function wireLayerInteraction(config) {
  if (wiredInteraction[config.id]) return;
  wiredInteraction[config.id] = true;
  setupLayerEventForMap(beforeMap, config, "left");
  setupLayerEventForMap(afterMap,  config, "right");
}
window.wireLayerInteraction = wireLayerInteraction;

function setupLayerEventForMap(map, config, side) {
  const layerID = config.id + "-" + side;
  const index   = config.id + "-" + side;
  const sourceLayer = config["source-layer"];

  // HOVER
  hoveredID[index] = null;
  hoverPopUp[index] = new mapboxgl.Popup({ closeButton: false, closeOnClick: false });

  map.on("mouseenter", layerID, function (e) {
    if (!config.popupStyle && !config.click && !config.highlight) return;   // #12: interaction toggled off live → no cursor/popup
    map.getCanvas().style.cursor = "pointer";
    // #13: don't open the popup here — it would show the PREVIOUS feature's HTML until mousemove
    // overwrites it (the stale-label bug). mousemove opens it once it has this feature's own label.
  });

  map.on("mousemove", layerID, function (e) {
    map.getCanvas().style.cursor = "pointer";
    if (e.features.length > 0) {
      if (hoveredID[index]) {
        setHoverBoth(config, hoveredID[index], false);   // clear on BOTH swipe sides
      }
      hoveredID[index] = e.features[0].id;
      setHoverBoth(config, hoveredID[index], true);       // highlight on BOTH swipe sides

      if (config.popupStyle && config.prop) {
        // If this feature's click pill (infoPanel) is already open, it labels the feature — no hover
        // bubble on top of it (that stack was the double-bubble bug).
        var pillOpen = false;
        try { var st = (typeof infoPanelState !== "undefined") ? infoPanelState[config.id] : null; pillOpen = !!(st && st.isOpen && st.viewId === e.features[0].id); } catch (err) {}
        const val = e.features[0].properties[config.prop];
        // #13: a feature with no label gets NO bubble — never leave the previous feature's label showing
        if (!pillOpen && val !== undefined && val !== null && String(val) !== "") {
          // panel layers use the layer-coloured pill class (colour rule) instead of the legacy green;
          // colour-by-attribute layers go further — the bubble takes the FEATURE's own colour
          var cls = config.panel ? ("infoPanelPopUp-" + config.id) : config.popupStyle;
          var styleAttr = "";
          try {
            if (config.colorBy && config.colorBy.mapping) {
              var cbv = e.features[0].properties[config.colorBy.prop];
              var cbc = cbv != null ? config.colorBy.mapping[String(cbv)] : null;
              if (cbc && typeof hexToRgba === "function") styleAttr = " style=\"background-color:" + hexToRgba(cbc, 0.5) + ";border-color:" + cbc + "\"";
            }
          } catch (err2) {}
          hoverPopUp[index].setLngLat(e.lngLat).setHTML("<div class='" + cls + "'" + styleAttr + ">" + val + "</div>");
          if (!hoverPopUp[index].isOpen()) hoverPopUp[index].addTo(map);
        } else if (hoverPopUp[index].isOpen()) {
          hoverPopUp[index].remove();
        }
      }
    }
  });

  map.on("mouseleave", layerID, function () {
    map.getCanvas().style.cursor = "";
    if (hoveredID[index]) {
      setHoverBoth(config, hoveredID[index], false);   // clear on BOTH swipe sides
    }
    hoveredID[index] = null;
    if (hoverPopUp[index].isOpen()) hoverPopUp[index].remove();
  });

  // CLICK — always wired; clickHandle gates on live config.click so the editor toggle applies without reload (#12)
  {
    let viewId = null;
    const afterPopup  = new mapboxgl.Popup({ closeButton: false, closeOnClick: false, offset: 5 });
    const beforePopup = new mapboxgl.Popup({ closeButton: false, closeOnClick: false, offset: 5 });

    const highlightLeft  = config.id + "-left";    // the REAL sources (slug-highlighted-side has no source); `selected` drives the highlight layer on BOTH sides
    const highlightRight = config.id + "-right";

    function setHighlight(m, source, featureId, isSelected) {
      if (featureId == null) return;
      try { m.setFeatureState({ source, sourceLayer: sourceLayer, id: featureId }, { selected: isSelected }); } catch (e) {}
    }

    function buildPopupHTML(event) {
      const val = event.features?.[0]?.properties?.[config.prop] ?? "";
      return "<div class='" + config.popupStyle + "'>" + val + "</div>";
    }

    function closeInfo() {
      setHighlight(afterMap,  highlightRight, viewId, false);
      setHighlight(beforeMap, highlightLeft,  viewId, false);
      viewId = null;
      if (afterPopup.isOpen())  afterPopup.remove();
      if (beforePopup.isOpen()) beforePopup.remove();
    }

    function clickHandle(event) {
      if (config.panel) return;   // layers with an info panel: infoPanel.js owns the click (pill + side panel) — never BOTH bubbles stacked
      if (!config.click) { closeInfo(); return; }   // #12: click-popup toggled off live
      const clickedId = event.features?.[0]?.id;
      if (clickedId == null) return;
      if (viewId === clickedId) { closeInfo(); return; }

      setHighlight(afterMap,  highlightRight, viewId, false);
      setHighlight(afterMap,  highlightRight, clickedId, true);
      setHighlight(beforeMap, highlightLeft,  viewId, false);
      setHighlight(beforeMap, highlightLeft,  clickedId, true);
      viewId = clickedId;

      // #13: no label → no bubble (the highlight above still shows the selection)
      const val = event.features?.[0]?.properties?.[config.prop];
      if (val === undefined || val === null || String(val) === "") {
        if (afterPopup.isOpen())  afterPopup.remove();
        if (beforePopup.isOpen()) beforePopup.remove();
        return;
      }
      const html = buildPopupHTML(event);
      afterPopup.setLngLat(event.lngLat).setHTML(html);
      beforePopup.setLngLat(event.lngLat).setHTML(html);
      if (!afterPopup.isOpen())  afterPopup.addTo(afterMap);
      if (!beforePopup.isOpen()) beforePopup.addTo(beforeMap);
    }

    // Only register click on one side to avoid double-firing
    if (side === "right") {
      beforeMap.on("click", config.id + "-left",  clickHandle);
      afterMap.on("click",  config.id + "-right", clickHandle);

      const mainCheckbox  = document.getElementById(config.id);
      const groupCheckbox = config.groupId ? document.getElementById(config.groupId) : null;
      if (mainCheckbox)  mainCheckbox.addEventListener("change",  function () { if (!mainCheckbox.checked)  closeInfo(); });
      if (groupCheckbox) groupCheckbox.addEventListener("change", function () { if (!groupCheckbox.checked) closeInfo(); });
    }
  }
}

function addEvents() {
  setupLayerEvents();
}
