const layers = [

  // Roads
  {
    type: "group",
    id: "roads_items",
    containerId: "roads-section-layers",
    caretId: "roads-layer-caret",
    label: "Roads",
    itemSelector: ".roads_layer_item",
    zoomCenter: [-93.64369, 42.02561],
    zoomLevel: 12.3,
    infoId: "roads-info-layer",
    collapsed: true,
    checked: true,
    children: [

      // Confirmed Roads
      {
        id: "confirmed-roads",
        name: "confirmed-roads",
        label: "Confirmed Roads",
        iconColor: "#A9A9A9",
        className: "roads_layer",
        topLayerClass: "roads_layer",
        isSolid: true,
        iconType: "slash",
        checked: true,
        type: "line",
        source: {
          type: "vector",
          url: "mapbox://nittyjee.5u39kagk",
        },
        layout: { visibility: "visible" },
        "source-layer": "roads_maps_ames_iowa-4rufgk",
        paint: {
          "line-color": "#A9A9A9",
          "line-width": ["interpolate", ["linear"], ["zoom"],
            8, 0.5,
            12, 1.5,
            16, 3,
            20, 6,
          ],
          "line-opacity": 1.0,
        },
        toggleElement: "confirmed-roads",
      },

      // Subdivision Roads
      {
        id: "sub-roads",
        name: "sub-roads",
        label: "Subdivision Roads",
        iconColor: "#808080",
        className: "roads_layer",
        topLayerClass: "roads_layer",
        isSolid: true,
        iconType: "slash",
        checked: true,
        type: "line",
        source: {
          type: "vector",
          url: "mapbox://nittyjee.4k1su4m3",
        },
        layout: { visibility: "visible" },
        "source-layer": "roads_subd_ames_iowa_2026-8t8va0",
        paint: {
          "line-color": "#00b7ff",
          "line-width": ["interpolate", ["linear"], ["zoom"],
            8, 0.5,
            13, 2,
            15, 3.5,
            18, 6,
            19, 26,
          ],
          "line-opacity": 0.5,
          "line-blur": 0,
        },
        toggleElement: "sub-roads",
      },

      /*
      // Proximity Roads
      {
        id: "proxy-roads",
        name: "proxy-roads",
        label: "Proximity",
        iconColor: "#696969",
        className: "roads_layer",
        topLayerClass: "roads_layer",
        isSolid: true,
        iconType: "slash",
        checked: true,
        type: "line",
        source: {
          type: "vector",
          url: "mapbox://nittyjee.proxy-roads",
        },
        layout: { visibility: "visible" },
        "source-layer": "roads_proximity_ames_iowa-458tl3",
        paint: {
          "line-color": "#696969",
          "line-width": ["interpolate", ["linear"], ["zoom"],
            8, 0.5,
            12, 1.5,
            16, 3,
            20, 6,
          ],
          "line-opacity": 1.0,
        },
        toggleElement: "proxy-roads",
      },
      */

    ],
  },

  // Railroads
  {
    id: "rail-roads",
    name: "rail-roads",
    label: "Railroads",
    iconColor: "#ff0000",
    className: "rail_roads_layer",
    topLayerClass: "rail_roads_layer",
    isSolid: true,
    iconType: "slash",
    checked: true,
    containerId: "rail-roads-cont",
    zoomCenter: [-93.64029, 42.04075],
    zoomLevel: 12.6,
    infoId: "rail-roads-info-layer",
    type: "line",
    source: {
      type: "vector",
      url: "mapbox://nittyjee.bfibuetx",
    },
    layout: { visibility: "visible" },
    "source-layer": "railroads-bdj6n3",
    paint: {
      "line-color": "#ea00ff",
      "line-width": ["interpolate", ["linear"], ["zoom"],
        8, 0.5,
        12, 1.5,
        16, 3,
        20, 6,
      ],
      "line-opacity": 1.0,
    },
    toggleElement: "rail-roads",
  },

  // Buildings
  {
    type: "group",
    id: "builds_items",
    containerId: "buildings-section-layers",
    caretId: "builds-layer-caret",
    label: "Buildings",
    itemSelector: ".builds_layer_item",
    zoomCenter: [-93.64369, 42.02561],
    zoomLevel: 12.3,
    infoId: "builds-info-layer",
    collapsed: true,
    checked: true,
    children: [

      // Previous Buildings
      {
        id: "prev-builds",
        name: "prev-builds",
        label: "Previous buildings",
        iconColor: "#FF7F50",
        className: "builds_layer",
        topLayerClass: "builds_layer",
        isSolid: true,
        iconType: "square",
        checked: true,
        type: "fill",
        source: {
          type: "vector",
          url: "mapbox://nittyjee.1394txes",
        },
        layout: { visibility: "visible" },
        "source-layer": "previous_buildings-1q9xnn",
        paint: {
          "fill-color": "#FF7F50",
          "fill-opacity": ["case", ["boolean", ["feature-state", "hover"], false],
            0.5,  // hover
            1,    // default
          ],
          "fill-outline-color": "#FF7F50",
        },
        highlight: {
          "fill-color": "#FF7F50",
          "fill-opacity": ["case", ["boolean", ["feature-state", "hover"], false],
            0.7,  // hover
            0,    // default
          ],
          "fill-outline-color": "#FF7F50",
        },
        groupId: "builds_items",
        popupStyle: "infoLayerCoralPopUp",
        prop: "label",
        click: true,
        toggleElement: "prev-builds",
        panel: {
          encyclopediaBase: "https://mapstructor.com/ames/encyclopedia",
          nidProp: "nid",
          color: "#FF7F50",
          render: function(_props, f) {
            return `
              <div class="panel-hero">${f("field-main-image", "hero")}</div>
              <h3><a href="${f("node-url")}" target="_blank">${f("node-title") || "Building"}</a></h3>
              <hr/>
              ${f()}
            `;
          },
        },
      },

      // Current Buildings
      {
        id: "curr-builds",
        name: "curr-builds",
        label: "Current buildings",
        iconColor: "#35b779",
        className: "builds_layer",
        topLayerClass: "builds_layer",
        isSolid: true,
        iconType: "square",
        checked: true,
        type: "fill",
        source: {
          type: "vector",
          url: "mapbox://nittyjee.du0aopr8",
        },
        layout: { visibility: "visible" },
        "source-layer": "buildings_ames_2026-9v0yur",
        paint: {
          "fill-color": "#ffb255",
          "fill-opacity": ["case", ["boolean", ["feature-state", "hover"], false],
            0.5,  // hover
            1.0,  // default
          ],
          "fill-outline-color": "#ff0000",
        },
        highlight: {
          "fill-color": "#35b779",
          "fill-opacity": ["case", ["boolean", ["feature-state", "hover"], false],
            0.7,  // hover
            0,    // default
          ],
          "fill-outline-color": "#35b779",
        },
        groupId: "builds_items",
        popupStyle: "infoLayerGreenPopUp",
        toggleElement: "curr-builds",
        panel: {
          encyclopediaBase: "https://mapstructor.com/ames/encyclopedia",
          nidProp: "nid",
          color: "#35b779",
          render: function(_props, f) {
            return `
              <div class="panel-hero">${f("field-main-image", "hero")}</div>
              <h3><a href="${f("node-url")}" target="_blank">${f("node-title") || "Building"}</a></h3>
              <hr/>
              ${f()}
            `;
          },
        },
      },

    ],
  },

  // City Limits
  {
    id: "city-limits",
    name: "city-limits",
    label: "City Limits",
    iconColor: "#7ab11b",
    className: "city_limits_layer",
    topLayerClass: "city_limits_layer",
    isSolid: true,
    iconType: "slash",
    checked: true,
    containerId: "city-limits-cont",
    zoomCenter: [-93.63891, 42.02708],
    zoomLevel: 11.85,
    infoId: "city-limits-info-layer",
    type: "line",
    source: {
      type: "vector",
      url: "mapbox://nittyjee.41zrmwvc",
    },
    layout: { visibility: "visible" },
    "source-layer": "city_limits_lines_2026-a8hdoi",
    paint: {
      "line-color": "#00c610",
      "line-width": 4,
      "line-opacity": 1,
    },
    toggleElement: "city-limits",
  },

  // Properties
  {
    type: "section",
    id: "properties-section",
    label: "Properties",
    caretId: "properties-caret",
    containerId: "properties-content",
    children: [

      // Pre-Subdivisions
      {
        id: "plss-own",
        name: "plss-own",
        label: "Pre-Subdivisions",
        iconColor: "#00E5D9",
        className: "pre_subdivisions",
        topLayerClass: "pre_subdivisions_layer",
        isSolid: true,
        iconType: "square",
        checked: true,
        containerId: "pre-subdivisions-cont",
        zoomCenter: [-93.61106, 42.02711],
        zoomLevel: 14.27,
        infoId: "pre-subdivisions-info-layer",
        type: "fill",
        source: {
          type: "vector",
          url: "mapbox://nittyjee.blb6xx89",
        },
        layout: { visibility: "visible" },
        "source-layer": "plss_ownership_boundaries-7d8k3v",
        paint: {
          "fill-color": "#00E5D9",
          "fill-opacity": ["case", ["boolean", ["feature-state", "hover"], false],
            0.5,  // hover
            0.2,  // default
          ],
          "fill-outline-color": "#000000",
        },
        highlight: {
          "fill-color": "#00E5D9",
          "fill-opacity": ["case", ["boolean", ["feature-state", "hover"], false],
            0.7,  // hover
            0,    // default
          ],
          "fill-outline-color": "#000000",
        },
        groupId: "plss_parcels_items",
        popupStyle: "infoLayerAquaPopUp",
        prop: "LABEL",
        click: true,
        toggleElement: "plss-own",
      },

      // Parcels
      {
        type: "group",
        id: "parcels_items",
        containerId: "parcels-section-layers",
        caretId: "parcels-layer-caret",
        label: "Parcels",
        itemSelector: ".parcels_layer_item",
        zoomCenter: [-93.64369, 42.02561],
        zoomLevel: 12.3,
        infoId: "parcels-info-layer",
        collapsed: true,
        checked: false,
        children: [

          // Lot Lines
          {
            id: "lot-lines",
            name: "lot-lines",
            label: "Lot Lines",
            iconColor: "#ffd700",
            className: "parcels_layer",
            topLayerClass: "parcels_layer",
            isSolid: false,
            iconType: "square",
            checked: false,
            type: "line",
            source: {
              type: "vector",
              url: "mapbox://nittyjee.95nfth3k",
            },
            layout: { visibility: "visible" },
            "source-layer": "lots-bv0zn0",
            paint: {
              "line-color": "#ffd700",
              "line-width": 2,
              "line-opacity": 1.0,
            },
            toggleElement: "lot-lines",
          },

          // Parcels
          {
            id: "parcels-parcels",
            name: "parcels-parcels",
            label: "Parcels",
            iconColor: "#ff1493",
            className: "parcels_layer",
            topLayerClass: "parcels_layer",
            isSolid: true,
            iconType: "square",
            checked: false,
            type: "fill",
            source: {
              type: "vector",
              url: "mapbox://nittyjee.5eq8mpcd",
            },
            layout: { visibility: "visible" },
            "source-layer": "parcels-136ib8",
            paint: {
              "fill-color": "#d1d1d1",
              "fill-opacity": ["case", ["boolean", ["feature-state", "hover"], false],
                0.2,  // hover
                0.1,  // default
              ],
              "fill-outline-color": "#000000",
              "fill-outline-color-opacity": 1,
            },
            highlight: {
              "fill-color": "#ff1493",
              "fill-opacity": ["case", ["boolean", ["feature-state", "hover"], false],
                0.3,  // hover
                0,    // default
              ],
              "fill-outline-color": "#FFD700",
            },
            groupId: "parcels_items",
            popupStyle: "infoLayerPinkPopUp",
            toggleElement: "parcels-parcels",
          },

        ],
      },

      // Subdivisions
      {
        id: "parcels-subs",
        name: "parcels-subs",
        label: "Subdivisions",
        iconColor: "#7b68ee",
        className: "subdivisions_layer",
        topLayerClass: "subdivisions_layer",
        isSolid: true,
        iconType: "square",
        checked: false,
        containerId: "subdivisions-cont",
        zoomCenter: [-93.64369, 42.02561],
        zoomLevel: 12.3,
        infoId: "subdivisions-info-layer",
        type: "fill",
        source: {
          type: "vector",
          url: "mapbox://nittyjee.4ccvb6kg",
        },
        layout: { visibility: "visible" },
        "source-layer": "subdivisions-67jdnv",
        paint: {
          "fill-color": "#7b68ee",
          "fill-opacity": ["case", ["boolean", ["feature-state", "hover"], false],
            0.4,  // hover
            0.2,  // default
          ],
          "fill-outline-color": "#000000",
        },
        highlight: {
          "fill-color": "#7b68ee",
          "fill-opacity": ["case", ["boolean", ["feature-state", "hover"], false],
            0.6,  // hover
            0,    // default
          ],
          "fill-outline-color": "#000000",
        },
        popupStyle: "infoLayerSlateBluePopUp",
        prop: "label",
        toggleElement: "parcels-subs",
      },

      // Story County Land Patents
      {
        id: "land-patents",
        name: "land-patents",
        label: "Story County Land Patents",
        iconColor: "#e3ed58",
        className: "story_patents",
        topLayerClass: "story_patents_layer",
        isSolid: true,
        iconType: "square",
        checked: false,
        containerId: "story-patents-cont",
        zoomCenter: [-93.5116, 42.0363],
        zoomLevelLeft: 10,
        zoomLevelRight: 12.5,
        infoId: "story-patents-info-layer",
        type: "fill",
        source: {
          type: "vector",
          url: "mapbox://nittyjee.5ttrrebx",
        },
        layout: { visibility: "visible" },
        "source-layer": "land_patents_story_county-3r2b0g",
        paint: {
          "fill-color": "#e3ed58",
          "fill-opacity": ["case", ["boolean", ["feature-state", "hover"], false],
            0.5,  // hover
            0.2,  // default
          ],
          "fill-outline-color": "#000000",
        },
        highlight: {
          "fill-color": "#e3ed58",
          "fill-opacity": ["case", ["boolean", ["feature-state", "hover"], false],
            0.7,  // hover
            0,    // default
          ],
          "fill-outline-color": "#000000",
        },
        popupStyle: "infoLayerYellowPopUp",
        toggleElement: "land-patents",
      },

    ],
  },


/*
//TESTING INFO PANEL WITH DUTCH GRANTS

  // Dutch Grants (Manhattan historical, connected to NAHC encyclopedia)
  {
    id: "dutch-grants",
    name: "dutch-grants",
    label: "Dutch Grants",
    iconColor: "#FFD700",
    className: "dutch_grants_layer",
    topLayerClass: "dutch_grants_layer",
    isSolid: true,
    iconType: "square",
    checked: false,
    containerId: "dutch-grants-cont",
    zoomCenter: [-74.0116, 40.7063],
    zoomLevel: 15,
    infoId: "dutch-grants-info-layer",
    type: "fill",
    source: {
      type: "vector",
      url: "mapbox://nittyjee.8gj92p8f",
    },
    layout: { visibility: "none" },
    "source-layer": "dutch_grants-4p18ol",
    paint: {
      "fill-color": "#FFD700",
      "fill-opacity": ["case", ["boolean", ["feature-state", "hover"], false],
        0.6,  // hover
        0.3,  // default
      ],
      "fill-outline-color": "#B8860B",
    },
    highlight: {
      "fill-color": "#FFD700",
      "fill-opacity": ["case", ["boolean", ["feature-state", "hover"], false],
        0.7,  // hover
        0,    // default
      ],
      "fill-outline-color": "#FFD700",
    },
    toggleElement: "dutch-grants",
    panel: {
      encyclopediaBase: "https://encyclopedia.nahc-mapping.org",
      nidProp: "nid",
      popupLabel: "Dutch Grant Lot",
      popupProp: "Lot",
      color: "#ffff00",
      render: function(_props, f) {
        return `
          <h3>Dutch Grant</h3>
          <hr/>

          <p>
            <a href="${f("node-url")}" target="_blank">
              ${f("field-old-title")}
            </a>
          </p>

          <p>
            <b>Start:</b><br>
            ${f("field-date-start-text-")}
          </p>

          <p>
            <b>Date End:</b><br>
            ${f("field-date-end-text-")}
          </p>

          <p>
            <b>To Party 1:</b><br>
            ${f("field-to-party-1222", "html")}
          </p>

          <p>
            <b>To Party 1 (text):</b><br>
            ${f("field-to-party-1-text-")}
          </p>

          <p>
            <b>From Party:</b><br>
            ${f("field-from-party", "html")}
          </p>

          <p>
            <b>From Party (text):</b><br>
            ${f("field-from-party-text-")}
          </p>

          ${f("all-images") ? `<p><b>Images:</b></p>${f("all-images")}` : ""}
        `;
      },
    },
  },

  // Dutch Grants 2 (same data, totally different panel style — for comparison testing)
  {
    id: "dutch-grants-2",
    name: "dutch-grants-2",
    label: "Dutch Grants 2",
    iconColor: "#ff4500",
    className: "dutch_grants_2_layer",
    topLayerClass: "dutch_grants_2_layer",
    isSolid: true,
    iconType: "square",
    checked: false,
    containerId: "dutch-grants-2-cont",
    zoomCenter: [-74.0116, 40.7063],
    zoomLevel: 15,
    infoId: "dutch-grants-2-info-layer",
    type: "fill",
    source: {
      type: "vector",
      url: "mapbox://nittyjee.8gj92p8f",
    },
    layout: { visibility: "none" },
    "source-layer": "dutch_grants-4p18ol",
    paint: {
      "fill-color": "#ff4500",
      "fill-opacity": ["case", ["boolean", ["feature-state", "hover"], false],
        0.7,  // hover
        0.2,  // default
      ],
      "fill-outline-color": "#ff0000",
    },
    highlight: {
      "fill-color": "#ff4500",
      "fill-opacity": ["case", ["boolean", ["feature-state", "hover"], false],
        0.9,  // hover
        0,    // default
      ],
      "fill-outline-color": "#ff0000",
    },
    toggleElement: "dutch-grants-2",
    panel: {
      encyclopediaBase: "https://encyclopedia.nahc-mapping.org",
      nidProp: "nid",
      popupLabel: "Lot",
      popupProp: "Lot",
      color: "#ff4500",
      render: function(props, f) {
        return `
          <div style="background:#ff4500; color:#fff; padding:6px 8px; font-size:1.1em; font-weight:bold; margin-bottom:8px;">
            <a href="${f("node-url")}" target="_blank" style="color:#fff; text-decoration:none;">
              ${f("field-old-title") || props.Lot}
            </a>
          </div>

          <div style="font-size:0.8em; background:#222; color:#fff; display:inline-block; padding:2px 6px; margin-bottom:8px;">
            ${f("field-date-start-text-")} → ${f("field-date-end-text-")}
          </div>

          <div style="font-size:0.75em; color:#888; margin:6px 0 2px; letter-spacing:1px;">PARTIES INVOLVED</div>

          <table style="width:100%; font-size:0.9em; border-collapse:collapse; margin-bottom:8px;">
            <tr>
              <td style="padding:3px 0; color:#aaa; width:40%;">To</td>
              <td style="padding:3px 0;">
                ${f("field-to-party-1222", "html")}
                <em style="color:#aaa;">${f("field-to-party-1-text-")}</em>
              </td>
            </tr>
            <tr>
              <td style="padding:3px 0; color:#aaa;">From</td>
              <td style="padding:3px 0;">
                ${f("field-from-party", "html")}
                <em style="color:#aaa;">${f("field-from-party-text-")}</em>
              </td>
            </tr>
            <tr>
              <td style="padding:3px 0; color:#aaa;">Lot</td>
              <td style="padding:3px 0; font-weight:bold;">${props.Lot}</td>
            </tr>
          </table>

          ${f("all-images")}

          <div style="margin-top:10px; padding:4px 6px; background:#ff4500; color:#fff; font-size:0.7em; text-align:center; letter-spacing:1px;">
            NAHC ENCYCLOPEDIA
          </div>
        `;
      },
    },
  },

  */

  /*
  // PLSS Parcels
  {
    id: "plss-parcels",
    type: "fill",
    source: {
      type: "vector",
      url: "mapbox://nittyjee.6o2n1b1w",
    },
    layout: { visibility: "visible" },
    "source-layer": "plss_parcels_ames_area-cphlvs",
    paint: {
      "fill-color": "#00ff7f",
      "fill-opacity": 0.3,
      "fill-outline-color": "#000000",
    },
    toggleElement: "plss-parcels",
  },
  */

];
