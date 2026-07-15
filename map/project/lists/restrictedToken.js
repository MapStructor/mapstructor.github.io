/* No committed Mapbox token (7/15). Public maps render tokenless — free basemaps (Esri /
   OpenFreeMap) + PMTiles, and projectLoader empties mapboxgl.accessToken for token-free maps,
   so nothing here can bill anyone. A Mapbox-based map supplies its token another way: the admin
   token (localStorage, editor only) or a token bundled into a download. AHM's own site (separate
   repo) keeps its own token. */
const restrictedToken = "";
