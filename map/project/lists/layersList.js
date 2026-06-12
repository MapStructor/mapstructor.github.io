const layers = [

  /*
  // ─────────────────────────────────────────────
  // STANDALONE LAYER EXAMPLE
  // A single layer with no children.
  // ─────────────────────────────────────────────
  {
    id: "my-layer",
    name: "my-layer",
    label: "My Layer",
    iconColor: "#ff0000",
    className: "my_layer_class",
    topLayerClass: "my_layer_class",
    isSolid: true,
    iconType: "slash",       // "slash" for lines, "square" for polygons
    checked: true,
    containerId: "my-layer-cont",
    zoomCenter: [-98.5795, 39.8283], // [lng, lat]
    zoomLevel: 10,
    infoId: "my-layer-info", // must match a key in modalinfo.js
    type: "line",            // "line", "fill", or "circle"
    source: {
      type: "vector",
      url: "mapbox://YOUR_USERNAME.YOUR_TILESET_ID",
    },
    layout: { visibility: "visible" },
    "source-layer": "YOUR_SOURCE_LAYER_NAME",
    paint: {
      "line-color": "#ff0000",
      "line-width": 2,
      "line-opacity": 1.0,
    },
    toggleElement: "my-layer",
  },
  */

  /*
  // ─────────────────────────────────────────────
  // GROUP EXAMPLE
  // A collapsible group containing two layers.
  // ─────────────────────────────────────────────
  {
    type: "group",
    id: "my_group_items",
    containerId: "my-group-section-layers",
    caretId: "my-group-caret",
    label: "My Group",
    itemSelector: ".my_group_layer_item",
    zoomCenter: [-98.5795, 39.8283],
    zoomLevel: 10,
    infoId: "my-group-info",
    collapsed: true,
    checked: true,
    children: [

      {
        id: "group-layer-a",
        name: "group-layer-a",
        label: "Layer A",
        iconColor: "#0000ff",
        className: "my_group_layer",
        topLayerClass: "my_group_layer",
        isSolid: true,
        iconType: "square",
        checked: true,
        type: "fill",
        source: {
          type: "vector",
          url: "mapbox://YOUR_USERNAME.YOUR_TILESET_ID",
        },
        layout: { visibility: "visible" },
        "source-layer": "YOUR_SOURCE_LAYER_NAME",
        paint: {
          "fill-color": "#0000ff",
          "fill-opacity": 0.4,
          "fill-outline-color": "#000000",
        },
        toggleElement: "group-layer-a",
      },

      {
        id: "group-layer-b",
        name: "group-layer-b",
        label: "Layer B",
        iconColor: "#00ff00",
        className: "my_group_layer",
        topLayerClass: "my_group_layer",
        isSolid: true,
        iconType: "square",
        checked: true,
        type: "fill",
        source: {
          type: "vector",
          url: "mapbox://YOUR_USERNAME.YOUR_TILESET_ID",
        },
        layout: { visibility: "visible" },
        "source-layer": "YOUR_SOURCE_LAYER_NAME",
        paint: {
          "fill-color": "#00ff00",
          "fill-opacity": 0.4,
          "fill-outline-color": "#000000",
        },
        toggleElement: "group-layer-b",
      },

    ],
  },
  */

  /*
  // ─────────────────────────────────────────────
  // SECTION EXAMPLE
  // A named section that groups related layers
  // (can contain standalone layers and groups).
  // ─────────────────────────────────────────────
  {
    type: "section",
    id: "my-section",
    label: "My Section",
    caretId: "my-section-caret",
    containerId: "my-section-content",
    children: [

      {
        id: "section-layer",
        name: "section-layer",
        label: "Section Layer",
        iconColor: "#ff8800",
        className: "section_layer_class",
        topLayerClass: "section_layer_class",
        isSolid: true,
        iconType: "square",
        checked: true,
        containerId: "section-layer-cont",
        zoomCenter: [-98.5795, 39.8283],
        zoomLevel: 10,
        infoId: "section-layer-info",
        type: "fill",
        source: {
          type: "vector",
          url: "mapbox://YOUR_USERNAME.YOUR_TILESET_ID",
        },
        layout: { visibility: "visible" },
        "source-layer": "YOUR_SOURCE_LAYER_NAME",
        paint: {
          "fill-color": "#ff8800",
          "fill-opacity": 0.3,
          "fill-outline-color": "#000000",
        },
        toggleElement: "section-layer",
      },

    ],
  },
  */

  /*
  // ─────────────────────────────────────────────
  // INFO PANEL EXAMPLE
  // A layer that opens a side panel with
  // encyclopedia data when clicked.
  // ─────────────────────────────────────────────
  {
    id: "panel-layer",
    name: "panel-layer",
    label: "Panel Layer",
    iconColor: "#ff69b4",
    className: "panel_layer_class",
    topLayerClass: "panel_layer_class",
    isSolid: true,
    iconType: "square",
    checked: true,
    type: "fill",
    source: {
      type: "vector",
      url: "mapbox://YOUR_USERNAME.YOUR_TILESET_ID",
    },
    layout: { visibility: "visible" },
    "source-layer": "YOUR_SOURCE_LAYER_NAME",
    paint: {
      "fill-color": "#ff69b4",
      "fill-opacity": ["case", ["boolean", ["feature-state", "hover"], false],
        0.6,  // hover
        0.3,  // default
      ],
      "fill-outline-color": "#000000",
    },
    highlight: {
      "fill-color": "#ff69b4",
      "fill-opacity": ["case", ["boolean", ["feature-state", "hover"], false],
        0.8,  // hover
        0,    // default
      ],
      "fill-outline-color": "#ff69b4",
    },
    toggleElement: "panel-layer",
    panel: {
      encyclopediaBase: "https://your-drupal-site.com/encyclopedia",
      nidProp: "nid",           // feature property that holds the encyclopedia node ID
      color: "#ff69b4",
      render: function(_props, f) {
        return `
          <div class="panel-hero">${f("field-main-image", "hero")}</div>
          <h3><a href="${f("node-url")}" target="_blank">${f("node-title") || "Feature"}</a></h3>
          <hr/>
          ${f()}
        `;
      },
    },
  },
  */

];
