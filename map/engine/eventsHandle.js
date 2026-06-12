let hoveredID = new Array();
let hoverPopUp = new Array();

function setupLayerEvents() {
  flatLayers(layers).filter(l => l.popupStyle).forEach(config => {
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
    hoverPopUp[index].setLngLat(e.lngLat).addTo(map);
  });

  map.on("mousemove", layerID, function (e) {
    map.getCanvas().style.cursor = "pointer";
    if (e.features.length > 0) {
      if (hoveredID[index]) {
        map.setFeatureState({ source: layerID, sourceLayer: sourceLayer, id: hoveredID[index] }, { hover: false });
      }
      hoveredID[index] = e.features[0].id;
      map.setFeatureState({ source: layerID, sourceLayer: sourceLayer, id: hoveredID[index] }, { hover: true });

      if (config.prop) {
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
      map.setFeatureState({ source: layerID, sourceLayer: sourceLayer, id: hoveredID[index] }, { hover: false });
    }
    hoveredID[index] = null;
    if (hoverPopUp[index].isOpen()) hoverPopUp[index].remove();
  });

  // CLICK
  if (config.click) {
    let viewId = null;
    const afterPopup  = new mapboxgl.Popup({ closeButton: false, closeOnClick: false, offset: 5 });
    const beforePopup = new mapboxgl.Popup({ closeButton: false, closeOnClick: false, offset: 5 });

    const highlightLeft  = config.id + "-highlighted-left";
    const highlightRight = config.id + "-highlighted-right";

    function setHighlight(m, source, featureId, isHovered) {
      if (featureId == null) return;
      m.setFeatureState({ source, sourceLayer: sourceLayer, id: featureId }, { hover: isHovered });
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
