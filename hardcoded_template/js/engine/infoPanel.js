// Generic info panel engine.
// Each layer with a `panel` config must define a `render(props, data)` function
// that returns the full HTML string for the panel.
// props = Mapbox feature properties
// data  = raw JSON response from the encyclopedia API (may be null if no encyclopediaBase)

var infoPanelState = {};
var infoPanelClickFired = {};

function setupInfoPanels() {
  flatLayers(layers).forEach(function(layer) {
    if (!layer.panel) return;

    var panel = layer.panel;
    var divId = "infoPanel-" + layer.id;

    // Create the panel div and append to rightInfoBar
    var $div = $("<div>").addClass("infoLayerElem").attr("id", divId);
    $("#rightInfoBar").append($div);

    // Inject color styles for this layer's panel and popup
    var popupClass = "infoPanelPopUp-" + layer.id;
    $("<style>")
      .text(
        "#" + divId + ", ." + popupClass + " {" +
        "  background-color: " + hexToRgba(panel.color, 0.5) + ";" +
        "  border-color: " + panel.color + ";" +
        "}" +
        "." + popupClass + " {" +
        "  padding-left: 5px;" +
        "  padding-right: 5px;" +
        "}"
      )
      .appendTo("head");

    // Create floating map popups (small label that appears on the map at click point)
    var afterPopup  = new mapboxgl.Popup({ closeButton: false, closeOnClick: false, offset: 5 });
    var beforePopup = new mapboxgl.Popup({ closeButton: false, closeOnClick: false, offset: 5 });

    infoPanelState[layer.id] = {
      viewId: null,
      isOpen: false,
      divId: divId,
      popupClass: popupClass,
      afterPopup: afterPopup,
      beforePopup: beforePopup,
    };

    infoPanelClickFired[layer.id] = false;
  });
}

function registerInfoPanelClicks() {
  // Background click — toggle sidebar if no panel layer was hit
  // Debounced to avoid firing on double-click (which should zoom, not toggle)
  var clickTimer = null;
  function scheduleToggle() {
    clearTimeout(clickTimer);
    clickTimer = setTimeout(function() { infoPanelDefaultHandle(); }, 250);
  }
  beforeMap.on("click",    scheduleToggle);
  beforeMap.on("dblclick", function() { clearTimeout(clickTimer); });
  afterMap.on("click",     scheduleToggle);
  afterMap.on("dblclick",  function() { clearTimeout(clickTimer); });

  flatLayers(layers).forEach(function(layer) {
    if (!layer.panel) return;

    var hoveredId = { left: null, right: null };
    var sourceLayer = layer["source-layer"];

    beforeMap.on("mousemove", layer.id + "-left", function(e) {
      beforeMap.getCanvas().style.cursor = "pointer";
      if (e.features.length > 0) {
        if (hoveredId.left !== null)
          beforeMap.setFeatureState({ source: layer.id + "-left", sourceLayer: sourceLayer, id: hoveredId.left }, { hover: false });
        hoveredId.left = e.features[0].id;
        beforeMap.setFeatureState({ source: layer.id + "-left", sourceLayer: sourceLayer, id: hoveredId.left }, { hover: true });
      }
    });
    beforeMap.on("mouseleave", layer.id + "-left", function() {
      beforeMap.getCanvas().style.cursor = "";
      if (hoveredId.left !== null)
        beforeMap.setFeatureState({ source: layer.id + "-left", sourceLayer: sourceLayer, id: hoveredId.left }, { hover: false });
      hoveredId.left = null;
    });

    afterMap.on("mousemove", layer.id + "-right", function(e) {
      afterMap.getCanvas().style.cursor = "pointer";
      if (e.features.length > 0) {
        if (hoveredId.right !== null)
          afterMap.setFeatureState({ source: layer.id + "-right", sourceLayer: sourceLayer, id: hoveredId.right }, { hover: false });
        hoveredId.right = e.features[0].id;
        afterMap.setFeatureState({ source: layer.id + "-right", sourceLayer: sourceLayer, id: hoveredId.right }, { hover: true });
      }
    });
    afterMap.on("mouseleave", layer.id + "-right", function() {
      afterMap.getCanvas().style.cursor = "";
      if (hoveredId.right !== null)
        afterMap.setFeatureState({ source: layer.id + "-right", sourceLayer: sourceLayer, id: hoveredId.right }, { hover: false });
      hoveredId.right = null;
    });

    beforeMap.on("click", layer.id + "-left",  function(e) { handlePanelClick(layer, e); });
    afterMap.on("click",  layer.id + "-right", function(e) { handlePanelClick(layer, e); });
  });
}

function infoPanelDefaultHandle() {
  var anyFired = Object.keys(infoPanelClickFired).some(function(id) {
    return infoPanelClickFired[id];
  });
  if (!anyFired) {
    if ($("#view-hide-layer-panel").length > 0)
      $("#view-hide-layer-panel").trigger("click");
  }
}

function handlePanelClick(layer, event) {
  if (infoPanelClickFired[layer.id]) return;
  infoPanelClickFired[layer.id] = true;
  setTimeout(function() { infoPanelClickFired[layer.id] = false; }, 300);

  var state = infoPanelState[layer.id];
  var panel = layer.panel;
  var props = event.features[0].properties;
  var clickedId = event.features[0].id;

  if (!props[panel.nidProp]) return;

  var popupHTML =
    "<div class='" + state.popupClass + "'>" +
    (props.name || "") +
    (panel.popupLabel ? "<br><b>" + panel.popupLabel + ": </b>" + props[panel.popupProp] : "") +
    "</div>";

  if (state.viewId === clickedId) {
    if (state.isOpen) {
      closePanelInfo(layer);
    } else {
      fetchAndRender(layer, props, clickedId, event.lngLat, popupHTML);
    }
  } else {
    setPanelHighlight(layer, state.viewId, false);
    state.viewId = clickedId;
    fetchAndRender(layer, props, clickedId, event.lngLat, popupHTML);
  }
}

function fetchAndRender(layer, props, clickedId, lngLat, popupHTML) {
  var panel = layer.panel;
  var state = infoPanelState[layer.id];
  var $el = $("#" + state.divId);
  var nid = props[panel.nidProp];

  fetch(panel.encyclopediaBase + "/rendered-export-single?nid=" + nid)
    .then(function(r) { return r.json(); })
    .then(function(data) {
        if (!data || !data[0] || !data[0].rendered_entity) { return; }
        var docEl = document.createElement("div");
        docEl.innerHTML = processEncyclopediaHtml(data[0].rendered_entity, panel.encyclopediaBase);
        var $doc = $(docEl);

        // Hide the node title heading; capture its href for f("node-url")
        var $titleLink = $doc.find("h2.node__title a");
        var titleHref  = $titleLink.attr("href") || "";
        var titleText  = $titleLink.text().trim() || "";
        $titleLink.closest("h2").hide();

        // f()                     → full processed doc HTML (raw Drupal, like MENY)
        // f("node-url")           → href from the node title link
        // f("node-title")         → plain text of the node title
        // f("field-name", "hero")  → first <img> from that field, removes it from doc (no duplication)
        // f("field-name")         → plain text of that field's first item
        // f("field-name", "html") → inner HTML of that field (for linked entity fields)
        // f("field-name", "imgs") → all <img> tags in that field joined
        var f = function(name, mode) {
          if (!name)                 return $doc.html();
          if (name === "node-url")   return titleHref;
          if (name === "node-title") return titleText;
          if (name === "all-images") return $doc.find("img").map(function() { return this.outerHTML; }).get().join("");
          if (mode === "hero") {
            var $field = $doc.find(".field--name-" + name);
            var img = $field.find("img").first().prop("outerHTML") || "";
            $field.remove();
            return img;
          }
          var $items = $doc.find(".field--name-" + name + " .field__item");
          if (!$items.length) $items = $doc.find(".field--name-" + name + ".field__item");
          if (mode === "html") return $items.first().html() || "";
          if (mode === "imgs") return $items.find("img").map(function() { return this.outerHTML; }).get().join("");
          return $items.first().text().trim();
        };
        var rendered = document.createElement("div");
        rendered.innerHTML = panel.render(props, f);
        // Auto-remove <p> blocks that have a <b> label but empty content
        $(rendered).find("p").each(function() {
          var $p = $(this);
          if ($p.find("b").length) {
            var clone = $p.clone();
            clone.find("b, br").remove();
            if (!clone.text().trim()) $p.remove();
          }
        });
        $el.html(rendered.innerHTML);
        floatPanelToTop(state.divId);
        openSidebarIfHidden();
        state.isOpen = true;
        setPanelHighlight(layer, clickedId, true);
        showPanelPopups(state, lngLat, popupHTML);
        $el.slideDown();
      });
}

function closePanelInfo(layer) {
  var state = infoPanelState[layer.id];
  $("#" + state.divId).slideUp();
  state.isOpen = false;
  setPanelHighlight(layer, state.viewId, false);
  if (state.afterPopup.isOpen()) state.afterPopup.remove();
  if (state.beforePopup.isOpen()) state.beforePopup.remove();
}

function setPanelHighlight(layer, featureId, hover) {
  if (featureId == null) return;
  var sourceLayer = layer["source-layer"];
  afterMap.setFeatureState(
    { source: layer.id + "-highlighted-right", sourceLayer: sourceLayer, id: featureId },
    { hover: hover }
  );
  beforeMap.setFeatureState(
    { source: layer.id + "-highlighted-left", sourceLayer: sourceLayer, id: featureId },
    { hover: hover }
  );
}

function showPanelPopups(state, lngLat, html) {
  state.afterPopup.setLngLat(lngLat).setHTML(html);
  if (!state.afterPopup.isOpen()) state.afterPopup.addTo(afterMap);
  state.beforePopup.setLngLat(lngLat).setHTML(html);
  if (!state.beforePopup.isOpen()) state.beforePopup.addTo(beforeMap);
}

function floatPanelToTop(divId) {
  if ($(".infoLayerElem").first().attr("id") !== divId)
    $("#" + divId).insertBefore($(".infoLayerElem").first());
}

function openSidebarIfHidden() {
  if ($("#view-hide-layer-panel").length > 0)
    if (!layer_view_flag) $("#view-hide-layer-panel").trigger("click");
}

function processEncyclopediaHtml(html, base) {
  var origin = base.replace(/^(https?:\/\/[^\/]+).*/, "$1");
  return html
    .replace(/(<a\s+href=")([^"]+)(")/g, function(_, p1, p2, p3) {
      if (p2.slice(0, 4) === "http") return p1 + p2 + p3;
      return p1 + origin + p2 + p3;
    })
    .replace(/(<a\s+[^>]*)(>)/g, function(_, p1, p2) {
      return p1 + ' target="_blank"' + p2;
    })
    .replace(/(<img.*src=")([^"]+)(")/g, function(_, p1, p2, p3) {
      if (p2.slice(0, 4) === "http") return p1 + p2 + p3;
      return p1 + origin + p2 + p3;
    });
}

function hexToRgba(hex, alpha) {
  var r = parseInt(hex.slice(1, 3), 16);
  var g = parseInt(hex.slice(3, 5), 16);
  var b = parseInt(hex.slice(5, 7), 16);
  return "rgba(" + r + ", " + g + ", " + b + ", " + alpha + ")";
}
