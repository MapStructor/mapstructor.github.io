/* configLoader.js — the db → config adapter (Chunk A, dev plan 2026-06-12 review).

   Synthesizes the exact `layers[]` config shape the engine consumes (the
   layersList.js shape) from Supabase rows. The engine never knows the config
   came from a database.

   Pure synthesis lives in ConfigLoader.synthesize(bundle, registry) so the
   round-trip acceptance test (tools/seed/) can run it without a map page.

   Field mapping is the exact mirror of the seeder in tools/seed/seed.js —
   change them together:

     column                      config field
     ------                     ------------
     slug                        id
     name                        label          (the config's own `name` key, when
                                                 present, rides in raw_config)
     color                       iconColor
     enabled_by_default          checked
     source_url (+min/maxzoom)   source.url | source.tiles[0]
     source_layer                "source-layer"
     hover_paint                 highlight
     popup_style / popup_prop    popupStyle / prop
     info_id                     infoId
     zoom_center_lng/lat         zoomCenter
     zoom_level(_left/_right)    zoomLevel / zoomLevelLeft / zoomLevelRight
     content_base_url            panel.encyclopediaBase
     content_id_prop             panel.nidProp
     panel_color                 panel.color
     raw_config                  every unmapped key (className, topLayerClass,
                                 isSolid, iconType, groupId, toggleElement,
                                 containerId, caretId, itemSelector, ...)

   panel.render is never stored — reattached from renderRegistry by slug.
   Mapped keys are emitted only when the column is non-null, so the
   synthesized objects carry the same key set as the seeded source. */

var ConfigLoader = (function () {

  // "1962-07-02" (or a timestamp) → 19620702; null/blank → fallback.
  function ymd(dateStr, fallback) {
    if (dateStr == null || dateStr === "") return fallback;
    var n = parseInt(String(dateStr).slice(0, 10).replace(/-/g, ""), 10);
    return isNaN(n) ? fallback : n;
  }

  function geojsonDefaultPaint(type, color) {
    if (type === "fill") return { "fill-color": color, "fill-opacity": 0.35, "fill-outline-color": color };
    if (type === "line") return { "line-color": color, "line-width": 2 };
    return { "circle-radius": 5, "circle-color": color, "circle-stroke-width": 1.5, "circle-stroke-color": "#000" };
  }

  function leafFromRow(row, registry, features) {
    var raw = row.raw_config || {};
    var leaf = {};

    leaf.id = row.slug;
    Object.keys(raw).forEach(function (k) {
      if (k !== "panel") leaf[k] = raw[k];
    });
    // refreshLayers toggles map visibility via layer.toggleElement → the checkbox id
    // (which is the slug). Tileset configs carry it; synthesized layers need it too,
    // or the layer never becomes visible.
    if (leaf.toggleElement == null) leaf.toggleElement = row.slug;
    if (row.name != null) leaf.label = row.name;
    if (row.color != null) leaf.iconColor = row.color;
    if (row.enabled_by_default != null) leaf.checked = row.enabled_by_default;
    if (row.type != null) leaf.type = row.type;

    if (row.source_type === "vector-tiles-url") {
      leaf.source = { type: "vector", tiles: [row.source_url] };
      if (row.source_minzoom != null) leaf.source.minzoom = row.source_minzoom;
      if (row.source_maxzoom != null) leaf.source.maxzoom = row.source_maxzoom;
    } else if (row.source_url != null) {
      leaf.source = { type: "vector", url: row.source_url };
    }

    if (row.layout != null) leaf.layout = row.layout;
    if (row.source_layer != null) leaf["source-layer"] = row.source_layer;
    if (row.paint != null) leaf.paint = row.paint;
    if (row.hover_paint != null) leaf.highlight = row.hover_paint;
    if (row.popup_style != null) leaf.popupStyle = row.popup_style;
    if (row.popup_prop != null) leaf.prop = row.popup_prop;
    if (row.click != null) leaf.click = row.click;
    if (row.info_id != null) leaf.infoId = row.info_id;
    if (row.zoom_center_lng != null) leaf.zoomCenter = [row.zoom_center_lng, row.zoom_center_lat];
    if (row.zoom_level != null) leaf.zoomLevel = row.zoom_level;
    if (row.zoom_level_left != null) leaf.zoomLevelLeft = row.zoom_level_left;
    if (row.zoom_level_right != null) leaf.zoomLevelRight = row.zoom_level_right;

    // Drawn (geojson-supabase) layers render from their Supabase features as a real
    // GeoJSON map layer — so they get the engine's paint/popup/panel like any tileset.
    if (row.source_type === "geojson-supabase") {
      leaf.source = { type: "geojson", data: { type: "FeatureCollection", features: (features || []).map(function (f) {
        // DayStart/DayEnd gate visibility on the timeline (engine date filter is a
        // YYYYMMDD int). Derive from the feature's start_date/end_date columns; a null
        // date means "no bound", so default to an always-visible range.
        return { type: "Feature", id: f.feature_id, geometry: f.geom, properties: {
          label: f.label != null ? f.label : null, description: f.description != null ? f.description : null,
          content_id: f.content_id != null ? f.content_id : null,   // the per-feature encyclopedia page id (panel.nidProp = "content_id" for drawn layers)
          DayStart: ymd(f.start_date, 0), DayEnd: ymd(f.end_date, 99999999)
        } };
      }) } };
      if (leaf.type == null) leaf.type = "circle";
      if (leaf.paint == null) leaf.paint = geojsonDefaultPaint(leaf.type, leaf.iconColor || "#3bb2d0");
    }

    // Mapbox fill-outline-color is always 1px; to allow a real (thicker) outline, render a
    // polygon's boundary as a separate line layer — for DRAWN and TILESET fills alike (the engine
    // shares the fill's source, adding source-layer for vector tilesets). Drawn fills always get it
    // (default width 2); a tileset fill gets it when it has an outline color, defaulting to width 1
    // so it's visually identical to today's 1px fill-outline (no surprise change) but now widenable.
    // Skipped when the outline was split into its own standalone layer (raw.outlineSplit).
    if (leaf.type === "fill" && leaf.paint && !raw.outlineSplit &&
        (row.source_type === "geojson-supabase" || leaf.paint["fill-outline-color"])) {
      leaf.stroke = {
        "line-color": leaf.paint["fill-outline-color"] || leaf.iconColor || "#3bb2d0",
        "line-width": (leaf.paint && leaf.paint["line-width"]) || (row.source_type === "geojson-supabase" ? 2 : 1),
        // a stored line-opacity of 0 = "outline hidden" (the show-outline toggle)
        "line-opacity": leaf.paint["line-opacity"] != null ? leaf.paint["line-opacity"] : 1
      };
    }

    if (row.content_base_url != null) {
      var panel = { encyclopediaBase: row.content_base_url };
      if (row.content_id_prop != null) panel.nidProp = row.content_id_prop;
      if (raw.panel) Object.keys(raw.panel).forEach(function (k) { panel[k] = raw.panel[k]; });
      if (row.panel_color != null) panel.color = row.panel_color;
      if (panel.color == null) panel.color = leaf.iconColor || "#3bb2d0";   // setupInfoPanels colours the panel via hexToRgba(panel.color); a missing panel_color would throw + break EVERY panel
      var rend = registry && (registry[row.slug] || registry["_default"]); if (rend) panel.render = rend;   // drawn layers fall back to the generic render
      leaf.panel = panel;
    }

    return leaf;
  }

  /* bundle = { project, sections, groups, projectLayers } — projectLayers rows
     carry their joined layers row as .layers. sort_order is one global counter
     across all three tables, so sorting each children array (and the top level)
     by it reconstructs the original interleaving of sections, groups, and
     standalone layers. */
  function synthesize(bundle, registry) {
    var top = [];
    var sectionNodes = {};
    var groupNodes = {};

    (bundle.sections || []).forEach(function (s) {
      var raw = s.raw_config || {};
      var node = { type: "section", id: s.slug };
      if (s.name != null) node.label = s.name;
      Object.keys(raw).forEach(function (k) { node[k] = raw[k]; });
      sectionNodes[s.id] = { node: node, kids: [] };
      top.push({ sort: s.sort_order, node: node });
    });

    (bundle.groups || []).forEach(function (g) {
      var raw = g.raw_config || {};
      var node = { type: "group", id: g.slug };
      Object.keys(raw).forEach(function (k) { node[k] = raw[k]; });
      if (g.name != null) node.label = g.name;
      if (g.zoom_center_lng != null) node.zoomCenter = [g.zoom_center_lng, g.zoom_center_lat];
      if (g.zoom_level != null) node.zoomLevel = g.zoom_level;
      if (g.info_id != null) node.infoId = g.info_id;
      if (g.collapsed != null) node.collapsed = g.collapsed;
      if (g.checked != null) node.checked = g.checked;
      groupNodes[g.id] = { node: node, kids: [] };
      var entry = { sort: g.sort_order, node: node };
      if (g.section_id && sectionNodes[g.section_id]) sectionNodes[g.section_id].kids.push(entry);
      else top.push(entry);
    });

    // slug → layer id, so a split-out outline layer can borrow its parent polygon's features
    var slugToId = {};
    (bundle.projectLayers || []).forEach(function (pl) { if (pl.layers && pl.layers.slug != null) slugToId[pl.layers.slug] = pl.layers.id; });

    (bundle.projectLayers || []).forEach(function (pl) {
      if (!pl.layers) return;
      var praw = pl.layers.raw_config || {};
      var featLayerId = praw.outlineOf ? slugToId[praw.outlineOf] : pl.layers.id;   // outline layers draw their parent's features
      var entry = { sort: pl.sort_order, node: leafFromRow(pl.layers, registry, (bundle.featuresByLayer || {})[featLayerId]) };
      if (pl.group_id && groupNodes[pl.group_id]) groupNodes[pl.group_id].kids.push(entry);
      else if (pl.section_id && sectionNodes[pl.section_id]) sectionNodes[pl.section_id].kids.push(entry);
      else top.push(entry);
    });

    function bySort(a, b) { return (a.sort || 0) - (b.sort || 0); }
    function finalize(holder) {
      holder.node.children = holder.kids.sort(bySort).map(function (e) { return e.node; });
    }
    Object.keys(groupNodes).forEach(function (id) { finalize(groupNodes[id]); });
    Object.keys(sectionNodes).forEach(function (id) { finalize(sectionNodes[id]); });

    return top.sort(bySort).map(function (e) { return e.node; });
  }

  async function fetchProjectBundle(db, projectId) {
    var p = await db.from("projects").select("*").eq("id", projectId).single();
    if (p.error) throw p.error;
    var s = await db.from("layer_sections").select("*").eq("project_id", projectId);
    if (s.error) throw s.error;
    var g = await db.from("layer_groups").select("*").eq("project_id", projectId);
    if (g.error) throw g.error;
    var l = await db.from("project_layers").select("*, layers(*)").eq("project_id", projectId);
    if (l.error) throw l.error;
    var bundle = { project: p.data, sections: s.data, groups: g.data, projectLayers: l.data, featuresByLayer: {} };
    // Pull features for drawn (geojson-supabase) layers so synthesize can build their source.
    var drawnIds = (l.data || []).filter(function (pl) { return pl.layers && pl.layers.source_type === "geojson-supabase"; }).map(function (pl) { return pl.layers.id; });
    if (drawnIds.length) {
      var push = function (data) { (data || []).forEach(function (row) { (bundle.featuresByLayer[row.layer_id] = bundle.featuresByLayer[row.layer_id] || []).push(row); }); };
      var sel = "feature_id, layer_id, geom, label, description, start_date, end_date, content_id";
      // Supabase caps a select at 1000 rows; get the total, then page through (the rest in parallel)
      // so layers with many features (e.g. imported datasets) render fully, not just the first 1000.
      var first = await db.from("features").select(sel, { count: "exact" }).in("layer_id", drawnIds).order("feature_id").range(0, 999);
      if (!first.error) {
        push(first.data);
        var total = first.count || (first.data ? first.data.length : 0);
        var pages = [];
        for (var off = 1000; off < total; off += 1000) pages.push(db.from("features").select(sel).in("layer_id", drawnIds).order("feature_id").range(off, off + 999));
        if (pages.length) { var results = await Promise.all(pages); results.forEach(function (r) { if (!r.error) push(r.data); }); }
      }
    }
    return bundle;
  }

  async function loadProjectConfig(db, projectId, registry) {
    var bundle = await fetchProjectBundle(db, projectId);
    return synthesize(bundle, registry);
  }

  return {
    leafFromRow: leafFromRow,
    synthesize: synthesize,
    fetchProjectBundle: fetchProjectBundle,
    loadProjectConfig: loadProjectConfig,
  };
})();
