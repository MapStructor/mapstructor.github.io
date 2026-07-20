// IDEMPOTENT (7/18): the basemap-switch self-heal re-runs the whole add pass, so an id that
// already made it in is skipped, and a source that survived a half-failed add is reused by
// reference instead of re-declared (a duplicate inline addSource rejects the whole addLayer).
function addMapLayer(map, layerConfig, date) {
  if (map.getLayer(layerConfig.id)) return;
  const cfg = date
    ? { ...layerConfig, filter: ["all", ["<=", "DayStart", date], [">=", "DayEnd", date]] }
    : { ...layerConfig };
  if (cfg.source && typeof cfg.source === "object" && map.getSource(cfg.id)) cfg.source = cfg.id;
  map.addLayer(cfg);
}
