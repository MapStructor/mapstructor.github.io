/* seed.js — the config → db seeder (Chunk A, dev plan 2026-06-12 review).

   Walks the `layers` tree from layersList.js (loaded by index.html) and writes
   the AHM project to Supabase. Exact mirror of platform/configLoader.js —
   change them together. Also holds the round-trip verifier (the Chunk A
   acceptance test): seed → fetch back → synthesize → deep-diff vs source.

   One global sort counter numbers every node (sections, groups, leaves) as the
   tree is walked, so sorting by sort_order on load reconstructs the original
   interleaving. Columns with DB defaults receive explicit null when the source
   key is absent, so the loader's "emit only when non-null" rule reproduces the
   source's exact key set. */

(function () {
  var SUPABASE_URL = "https://eqpxlwbjqiwfjlsuapvu.supabase.co";
  var SUPABASE_KEY = "sb_publishable_ijLmSmMUeNBrgMGL8Aol4g_S5-xwUzD";
  var db = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

  var logEl = document.getElementById("log");
  function log(msg) { logEl.textContent += msg + "\n"; }

  function val(v) { return v === undefined ? null : v; }

  /* Keys consumed into real columns — everything else rides in raw_config.
     Must mirror the emission rules in configLoader.js. */
  var LEAF_CONSUMED = ["id", "label", "iconColor", "checked", "type", "source", "layout",
    "source-layer", "paint", "highlight", "popupStyle", "prop", "click", "infoId",
    "zoomCenter", "zoomLevel", "zoomLevelLeft", "zoomLevelRight", "panel"];
  var GROUP_CONSUMED = ["type", "id", "label", "children", "zoomCenter", "zoomLevel",
    "infoId", "collapsed", "checked"];
  var SECTION_CONSUMED = ["type", "id", "label", "children"];
  var PANEL_CONSUMED = ["encyclopediaBase", "nidProp", "color", "render"];

  function rawFrom(node, consumed) {
    var raw = {};
    Object.keys(node).forEach(function (k) {
      if (consumed.indexOf(k) === -1) raw[k] = node[k];
    });
    return raw;
  }

  async function insertOne(table, row) {
    var res = await db.from(table).insert(row).select("id").single();
    if (res.error) throw new Error(table + " insert failed: " + res.error.message);
    return res.data.id;
  }

  function leafRow(node) {
    var raw = rawFrom(node, LEAF_CONSUMED);
    var panel = node.panel || null;
    if (panel) {
      var extras = {};
      Object.keys(panel).forEach(function (k) {
        if (PANEL_CONSUMED.indexOf(k) === -1) extras[k] = panel[k];
      });
      if (Object.keys(extras).length) raw.panel = extras;
    }
    var src = node.source || {};
    var isTilesUrl = !!src.tiles;
    return {
      slug: node.id,
      name: val(node.label),
      color: val(node.iconColor),
      type: val(node.type),
      source_type: isTilesUrl ? "vector-tiles-url" : (src.url ? "mapbox-tileset" : null),
      source_url: isTilesUrl ? src.tiles[0] : val(src.url),
      source_layer: val(node["source-layer"]),
      source_minzoom: val(src.minzoom),
      source_maxzoom: val(src.maxzoom),
      paint: val(node.paint),
      layout: val(node.layout),
      hover: node.highlight ? true : null,
      hover_paint: val(node.highlight),
      click: val(node.click),
      popup_style: val(node.popupStyle),
      popup_prop: val(node.prop),
      info_id: val(node.infoId),
      enabled_by_default: val(node.checked),
      zoom_center_lng: node.zoomCenter ? node.zoomCenter[0] : null,
      zoom_center_lat: node.zoomCenter ? node.zoomCenter[1] : null,
      zoom_level: val(node.zoomLevel),
      zoom_level_left: val(node.zoomLevelLeft),
      zoom_level_right: val(node.zoomLevelRight),
      content_base_url: panel ? val(panel.encyclopediaBase) : null,
      content_id_prop: panel ? val(panel.nidProp) : null,
      panel_color: panel ? val(panel.color) : null,
      is_public: true,
      raw_config: Object.keys(raw).length ? raw : null,
    };
  }

  var sortCounter;

  async function walkNode(node, projectId, sectionId, groupId) {
    var i;
    if (node.type === "section") {
      var sRaw = rawFrom(node, SECTION_CONSUMED);
      var sid = await insertOne("layer_sections", {
        project_id: projectId,
        name: val(node.label),
        sort_order: sortCounter++,
        slug: node.id,
        raw_config: Object.keys(sRaw).length ? sRaw : null,
      });
      log('  section "' + node.label + '" → ' + sid);
      for (i = 0; i < (node.children || []).length; i++) {
        await walkNode(node.children[i], projectId, sid, null);
      }
    } else if (node.type === "group") {
      var gRaw = rawFrom(node, GROUP_CONSUMED);
      var gid = await insertOne("layer_groups", {
        project_id: projectId,
        section_id: sectionId,
        name: val(node.label),
        sort_order: sortCounter++,
        slug: node.id,
        collapsed: val(node.collapsed),
        checked: val(node.checked),
        info_id: val(node.infoId),
        zoom_center_lng: node.zoomCenter ? node.zoomCenter[0] : null,
        zoom_center_lat: node.zoomCenter ? node.zoomCenter[1] : null,
        zoom_level: val(node.zoomLevel),
        raw_config: Object.keys(gRaw).length ? gRaw : null,
      });
      log('  group "' + node.label + '" → ' + gid);
      for (i = 0; i < (node.children || []).length; i++) {
        await walkNode(node.children[i], projectId, sectionId, gid);
      }
    } else {
      var layerId = await insertOne("layers", leafRow(node));
      await insertOne("project_layers", {
        project_id: projectId,
        layer_id: layerId,
        sort_order: sortCounter++,
        section_id: sectionId,
        group_id: groupId,
      });
      log('  layer "' + node.label + '" → ' + layerId);
    }
  }

  async function seed() {
    try {
      log("Seeding AHM project…");
      sortCounter = 0;
      var projectId = await insertOne("projects", {
        name: "Ames History Museum",
        is_public: true,
        center_lng: mapConfig.center[0],
        center_lat: mapConfig.center[1],
        zoom: mapConfig.zoom,
        basemap_style: mapConfig.style,
        raw_config: {
          baseMaps: baseMaps,
          boundsList: boundsList,
          zoomButtons: zoomButtons,
          mapboxUsername: siteConfig.mapboxUsername,
        },
      });
      log("project → " + projectId);
      for (var i = 0; i < layers.length; i++) {
        await walkNode(layers[i], projectId, null, null);
      }
      document.getElementById("project-id").value = projectId;
      log("\nDone. Project UUID: " + projectId);
      log("Now click Verify round-trip.");
    } catch (e) {
      log("ERROR: " + (e.message || e));
      console.error(e);
    }
  }

  function isObj(v) { return v !== null && typeof v === "object" && !Array.isArray(v); }

  function deepDiff(a, b, path, out) {
    if (typeof a === "function" && typeof b === "function") return;
    if (typeof a === "function" || typeof b === "function") {
      out.push(path + ": function on one side only");
      return;
    }
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) out.push(path + ": array length " + a.length + " (source) vs " + b.length + " (db)");
      var n = Math.min(a.length, b.length);
      for (var i = 0; i < n; i++) deepDiff(a[i], b[i], path + "[" + i + "]", out);
      return;
    }
    if (isObj(a) && isObj(b)) {
      var keys = {};
      Object.keys(a).forEach(function (k) { keys[k] = 1; });
      Object.keys(b).forEach(function (k) { keys[k] = 1; });
      Object.keys(keys).forEach(function (k) {
        if (!(k in a)) out.push(path + "." + k + ": missing in source, present in db");
        else if (!(k in b)) out.push(path + "." + k + ": present in source, missing in db");
        else deepDiff(a[k], b[k], path + "." + k, out);
      });
      return;
    }
    if (a !== b) out.push(path + ": " + JSON.stringify(a) + " (source) vs " + JSON.stringify(b) + " (db)");
  }

  async function verify() {
    try {
      var pid = document.getElementById("project-id").value.trim();
      if (!pid) { log("Enter a project UUID first."); return; }
      log("\nVerifying round-trip for " + pid + "…");
      var bundle = await ConfigLoader.fetchProjectBundle(db, pid);
      var synth = ConfigLoader.synthesize(bundle, renderRegistry);
      var diffs = [];
      deepDiff(layers, synth, "$", diffs);
      if (!diffs.length) {
        log("ROUND-TRIP OK — synthesized config is deep-equal to layersList.js (" + layers.length + " top-level items).");
      } else {
        log("ROUND-TRIP FAILED — " + diffs.length + " difference(s):");
        diffs.forEach(function (d) { log("  " + d); });
      }
    } catch (e) {
      log("ERROR: " + (e.message || e));
      console.error(e);
    }
  }

  document.getElementById("seed-btn").addEventListener("click", seed);
  document.getElementById("verify-btn").addEventListener("click", verify);
})();
