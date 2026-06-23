let hoveredID = new Array();
let hoverPopUp = new Array();

// Set a feature's hover state on BOTH swipe maps so the highlight shows left AND right. afterMap is the
// clipped top map and only fires events in its own half, so each side's handler must light up both.
function setHoverBoth(config, fid, on) {
  if (fid == null) return;
  if (on && config.hoverHighlight === false) return;   // #11: hover-highlight disabled for this layer (click `selected` still works)
  const sl = config["source-layer"];
  try { if (typeof beforeMap !== 'undefined' && beforeMap) beforeMap.setFeatureState({ source: config.id + "-left",  sourceLayer: sl, id: fid }, { hover: on }); } catch (e) {}
  try { if (typeof afterMap  !== 'undefined' && afterMap)  afterMap.setFeatureState({  source: config.id + "-right", sourceLayer: sl, id: fid }, { hover: on }); } catch (e) {}
}

function setupLayerEvents() {
  flatLayers(layers).filter(l => l.popupStyle || l.highlight || l.click).forEach(config => {   // hover-highlight needs only `highlight` (e.g. curr-builds has no popupStyle); popup stays gated to popupStyle
    setupLayerEventForMap(beforeMap, config, "left");
    setupLayerEventForMap(afterMap,  config, "right");
  });
}

function setupLayerEventForMap(map, config, side) {
  const layerID = config.id + "-" + side;
  const index   = config.id + "-" + side;
  const sourceLayer = config["source-layer"];

  // HOVER
  hoveredID[index] = null;
  hoverPopUp[index] = new mapboxgl.Popup({ closeButton: false, closeOnClick: false });

  map.on("mouseenter", layerID, function (e) {
    map.getCanvas().style.cursor = "pointer";
    if (config.popupStyle) hoverPopUp[index].setLngLat(e.lngLat).addTo(map);
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
        const val = e.features[0].properties[config.prop];
        if (typeof val !== 'undefined') {
          hoverPopUp[index].setLngLat(e.lngLat).setHTML("<div class='" + config.popupStyle + "'>" + val + "</div>");
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

  // CLICK
  if (config.click) {
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
      const clickedId = event.features?.[0]?.id;
      if (clickedId == null) return;
      if (viewId === clickedId) { closeInfo(); return; }

      setHighlight(afterMap,  highlightRight, viewId, false);
      setHighlight(afterMap,  highlightRight, clickedId, true);
      setHighlight(beforeMap, highlightLeft,  viewId, false);
      setHighlight(beforeMap, highlightLeft,  clickedId, true);
      viewId = clickedId;

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
