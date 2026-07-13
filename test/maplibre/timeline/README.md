# test/maplibre/timeline — renderer A/B twins (time-slider crispness)

Moved HOME to mapstructor.github.io 2026-07-12 (was ames_history_museum/test_movetomapstructor),
then into `timeline/` — these pages exist ONLY for timeline/slider comparisons; other MapLibre
experiments get sibling folders under test/maplibre/.

The renderer A/B twin pages (byte-identical except the renderer block):
  - `maplibre.html` — MapLibre; `?mode=state` (v5 global-state slider idiom), `?basemap=raster` (USGS
    imagery instead of OpenFreeMap liberty). Default = v4.7.1 + plain setFilter.
  - `mapboxgl.html` — Mapbox GL v3.1.2 control (prod's exact version; token from
    `map/project/lists/restrictedToken.js` + gitignored `map/project/secrets/mapbox-token.js`).
  - Both render the AHM buildings PMTiles via the worker (`ames-tiles.mapstructor.workers.dev`).
  - Purpose: slider-crispness verdicts on real hardware + the benchmark repro for the MapLibre perf
    contribution (todo → free-stack section, track E).

Serve the REPO ROOT (`python -m http.server 8000`) and open
`http://localhost:8000/test/maplibre/timeline/<page>`.
