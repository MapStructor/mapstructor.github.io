// IDEMPOTENT (7/18): the basemap-switch self-heal re-runs the whole add pass, so an id that
// already made it in is skipped, and a source that survived a half-failed add is reused by
// reference instead of re-declared (a duplicate inline addSource rejects the whole addLayer).
function addMapLayer(map, layerConfig, date) {
  if (map.getLayer(layerConfig.id)) return;
  // 7/21: timelineIgnore layers never take the date filter — they always show everything
  const cfg = (date && !layerConfig.timelineIgnore)
    ? { ...layerConfig, filter: ["all", ["<=", "DayStart", date], [">=", "DayEnd", date]] }
    : { ...layerConfig };
  if (cfg.source && typeof cfg.source === "object" && map.getSource(cfg.id)) cfg.source = cfg.id;
  // A tileset layer imported without a stored paint (styleColumnPaint returns the raw null for
  // non-geojson sources) would make map.addLayer THROW on `paint: null` — the whole layer then
  // never renders (only its separately-added highlight shows). Fall back to the layer's own colour.
  if (cfg.paint == null) {
    const c = cfg.iconColor || "#3bb2d0";
    cfg.paint = cfg.type === "fill" ? { "fill-color": c, "fill-opacity": 0.4 }
      : cfg.type === "circle" ? { "circle-color": c, "circle-radius": 5 }
      : { "line-color": c, "line-width": 2 };
  }
  map.addLayer(cfg);
}
