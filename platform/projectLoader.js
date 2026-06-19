/* projectLoader.js — boots the viewer from a Supabase project (Chunk A).

   map/index.html sets `platformProjectId` from the ?id=<uuid> query param.
   When it is set, the engine skips its three parse-time boot steps — each is
   exposed as a function instead (generateLayersPanel in generateLayers.js,
   generateBaseMapsPanel in generateMaps.js, initMaps in mapinit.js). This
   file fetches the project bundle, synthesizes the engine config through
   ConfigLoader (the exact shape layersList.js would have provided), installs
   it, and runs those same three boot steps. The engine never knows the config
   came from a database.

   The static lists declare their globals with `const`, so they cannot be
   reassigned from another script — instead they are emptied and refilled in
   place, which also keeps every engine reference to the same binding live.

   On any failure (Supabase unreachable, bad id, missing ConfigLoader) the
   static config is booted untouched, so the page still works. */

var PlatformProjectLoader = true;

(async function () {
  if (typeof platformProjectId === "undefined" || !platformProjectId) return;

  var SUPABASE_URL = "https://eqpxlwbjqiwfjlsuapvu.supabase.co";
  var SUPABASE_KEY = "sb_publishable_ijLmSmMUeNBrgMGL8Aol4g_S5-xwUzD";

  function replaceArray(target, items) {
    target.length = 0;
    items.forEach(function (item) { target.push(item); });
  }

  function replaceObject(target, source) {
    Object.keys(target).forEach(function (k) { delete target[k]; });
    Object.keys(source).forEach(function (k) { target[k] = source[k]; });
  }

  try {
    var db = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
    var bundle = await ConfigLoader.fetchProjectBundle(db, platformProjectId);
    var registry = typeof renderRegistry !== "undefined" ? renderRegistry : {};
    var projectLayers = ConfigLoader.synthesize(bundle, registry);

    var project = bundle.project;
    var raw = project.raw_config || {};

    replaceArray(layers, projectLayers);
    if (project.basemap_style != null) mapConfig.style = project.basemap_style;
    if (project.center_lng != null) mapConfig.center = [project.center_lng, project.center_lat];
    if (project.zoom != null) mapConfig.zoom = project.zoom;
    if (raw.baseMaps) replaceArray(baseMaps, raw.baseMaps);
    if (raw.mapSections) replaceArray(mapSections, raw.mapSections);
    if (raw.boundsList) replaceObject(boundsList, raw.boundsList);
    if (raw.zoomButtons) replaceArray(zoomButtons, raw.zoomButtons);
    if (raw.mapboxUsername) siteConfig.mapboxUsername = raw.mapboxUsername;
  } catch (e) {
    console.warn("Platform project load failed — booting the static config:", e);
  }

  generateLayersPanel();
  generateBaseMapsPanel();
  initMaps();
})();
