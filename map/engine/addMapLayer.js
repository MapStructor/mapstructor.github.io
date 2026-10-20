// IDEMPOTENT (7/18): the basemap-switch self-heal re-runs the whole add pass, so an id that
// already made it in is skipped, and a source that survived a half-failed add is reused by
// reference instead of re-declared (a duplicate inline addSource rejects the whole addLayer).
function addMapLayer(map, layerConfig, date) {
  if (map.getLayer(layerConfig.id)) return;
  // 7/21: timelineIgnore layers never take the date filter — they always show everything
  // 10/18: a layer's OWN filter (config `filter`, legacy syntax) is ANDed with the date filter,
  // not replaced by it — see msLayerFilter in utils.js
  const dateF = (date && !layerConfig.timelineIgnore) ? ["all", ["<=", "DayStart", date], [">=", "DayEnd", date]] : null;
  // a filter in the layer's Custom JSON (raw_config.customJson.filter, the panel's { } JSON tab) is
  // the same thing as an own filter — honoured here at add time, not only when layerJson re-applies
  const own = (layerConfig.customJson && layerConfig.customJson.filter) || layerConfig.filter || null;
  const f = msLayerFilter(own, dateF);
  const cfg = { ...layerConfig };
  if (f) cfg.filter = f; else delete cfg.filter;
  if (cfg.source && typeof cfg.source === "object" && map.getSource(cfg.id)) cfg.source = cfg.id;
  // CUSTOM JSON IS A COMPLETE OVERRIDE (owner 10/18: "any time there is a custom JSON, it should
  // override all styling, and not selectively"). When a layer carries raw_config.customJson, its
  // paint and layout are REPLACED by the custom ones — not merged — so the panel's styling plays
  // no part; keys the custom JSON leaves out fall to the renderer's defaults. The engine applies
  // it here, at add time, so the first frame, the viewer, the editor and a downloaded copy all
  // agree (layerJson.js re-applies live edits the same way). Two things are not styling and stay
  // the engine's: layout.visibility (the layer checkbox) and the hover/selected opacity wrap.
  const cjA = layerConfig.customJson;
  if (cjA && typeof cjA === "object") {
    const vis = cfg.layout && cfg.layout.visibility;
    cfg.paint = JSON.parse(JSON.stringify(cjA.paint || {}));
    if (typeof hoverInlinePaint === "function") cfg.paint = hoverInlinePaint(layerConfig, cfg.paint);
    cfg.layout = JSON.parse(JSON.stringify(cjA.layout || {}));
    if (vis != null) cfg.layout.visibility = vis;
    if (cjA.minzoom != null) cfg.minzoom = cjA.minzoom;
    if (cjA.maxzoom != null) cfg.maxzoom = cjA.maxzoom;
  }
  // A tileset layer imported without a stored paint (styleColumnPaint returns the raw null for
  // non-geojson sources) would make map.addLayer THROW on `paint: null` — the whole layer then
  // never renders (only its separately-added highlight shows). Fall back to the layer's own colour.
  if (cfg.paint == null) {
    const c = cfg.iconColor || "#3bb2d0";
    cfg.paint = cfg.type === "fill" ? { "fill-color": c, "fill-opacity": 0.4 }
      : cfg.type === "circle" ? { "circle-color": c, "circle-radius": 5 }
      : { "line-color": c, "line-width": 2 };
  }
  /* ONLY THE LAYER'S OWN PAINT KEYS REACH THE RENDERER (10/20). A fill's stored paint carries
     `line-width` / `line-opacity` — the stroke companion's settings, kept on the fill's row because
     the companion is derived from it (configLoader). Mapbox GL warns about an unknown paint key
     and draws the layer anyway; MapLibre REJECTS the layer ("paint.line-width: unknown property"),
     so in a downloaded copy every fill with a non-1 border was silently missing — found by the
     export gate on the property map (E6: 0 ordered layers present; E11f: no fill layer to read).
     The config keeps every key; only the spec handed to addLayer is trimmed. */
  if ((cfg.type === "fill" || cfg.type === "line" || cfg.type === "circle") && cfg.paint && typeof cfg.paint === "object") {
    const own = {};
    Object.keys(cfg.paint).forEach(function (k) { if (k.indexOf(cfg.type + "-") === 0) own[k] = cfg.paint[k]; });
    cfg.paint = own;
  }
  map.addLayer(cfg);
}
