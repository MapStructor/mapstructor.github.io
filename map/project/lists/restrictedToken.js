/* Public Mapbox token (pk.) — REQUIRED for the map to render at all. mapbox-gl-js v3 refuses to
   PAINT any tiles — even free non-Mapbox basemaps (Esri / OpenFreeMap) — without a valid token
   (it downloads them but renders nothing). So a token must always be present on the platform.

   ⚠ SECURITY: this token is public (it's in a public repo + browser). Keep it a `pk.` token and
   URL-RESTRICT it to your domains (Mapbox dashboard → Access tokens → URL restrictions:
   https://mapstructor.github.io/* and http://localhost:*), so an extracted copy is useless
   elsewhere. Rotate this one — it was exposed unrestricted for a stretch.

   True token-FREE rendering (zero Mapbox billing) needs MapLibre, not mapbox-gl — that's the
   MapLibre migration (and it's already how the MapLibre download variant renders free basemaps). */
const restrictedToken = "pk.eyJ1Ijoibml0dHlqZWUiLCJhIjoiY21tcGlyeWt0MHExYzJ5b2VqcGJhdDRieSJ9.Ai9ymb2G5htA_2sUSB2GPg";
