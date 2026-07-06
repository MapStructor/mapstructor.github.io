/* search.js — place search (Mapbox Geocoder) + "find my location" (GeolocateControl).
   Works on the editor and the viewer. Attaches to beforeMap; mapbox-gl-compare keeps afterMap
   in sync, so a search/locate flies BOTH swipe sides. Polls for beforeMap since the engine
   creates it asynchronously. Requires mapbox-gl, mapbox-gl-geocoder, and the engine's beforeMap. */
(function () {
  function add() {
    if (typeof mapboxgl === 'undefined' || typeof MapboxGeocoder === 'undefined' ||
        typeof beforeMap === 'undefined' || !beforeMap) { setTimeout(add, 500); return; }
    if (beforeMap._searchAdded) return;
    beforeMap._searchAdded = true;
    try {
      var geocoder = new MapboxGeocoder({
        accessToken: mapboxgl.accessToken,
        mapboxgl: mapboxgl,
        marker: false,
        placeholder: 'Search for a place…',
        flyTo: { speed: 1.6 }
      });
      beforeMap.addControl(geocoder, 'top-left');
      beforeMap.addControl(new mapboxgl.GeolocateControl({
        positionOptions: { enableHighAccuracy: true },
        trackUserLocation: false
      }), 'top-left');
    } catch (e) { console.warn('search: geocoder init failed', e); }
  }
  add();
})();
