(function () {

  var MAPBOX_TOKEN = mapboxToken;
  var PIN_COLORS   = ['#4a9eff','#ff6b4a','#4aff9e','#ff4adb','#ffe04a','#4af0ff','#ff9e4a'];

  var places = []; // [{ id, name, coords, color, marker }]
  var activeId = null;

  // ── Map ─────────────────────────────────────────────────────────────────────
  mapboxgl.accessToken = MAPBOX_TOKEN;

  var map = new mapboxgl.Map({
    container: 'map',
    style: 'mapbox://styles/mapbox/streets-v12',
    zoom: 3,
    center: [-96, 38],
    hash: true
  });

  map.addControl(new mapboxgl.NavigationControl(), 'top-right');

  // ── Geocoder ─────────────────────────────────────────────────────────────────
  var geocoder = new MapboxGeocoder({
    accessToken: MAPBOX_TOKEN,
    mapboxgl: mapboxgl,
    marker: false,      // we manage our own markers
    flyTo: false        // we manage our own flyTo
  });

  // Add to map first (required for internal setup), then move element to sidebar
  map.addControl(geocoder, 'top-left');
  geocoder.on('result', function (e) {
    var result = e.result;
    addPlace(result.place_name, result.center);
    geocoder.clear();
  });

  map.on('load', function () {
    // Move geocoder DOM element into the sidebar
    var geocoderEl = document.querySelector('.mapboxgl-ctrl-geocoder');
    if (geocoderEl) {
      document.getElementById('geocoder-container').appendChild(geocoderEl);
    }
    renderPlaceList();
  });

  // ── Add / remove places ──────────────────────────────────────────────────────
  function addPlace(name, coords) {
    var id    = 'place-' + Date.now();
    var color = PIN_COLORS[places.length % PIN_COLORS.length];

    var markerEl = document.createElement('div');
    markerEl.className = 'custom-marker';
    markerEl.innerHTML = pinSvg(color);
    markerEl.style.cursor = 'pointer';
    markerEl.title = name;

    var popup = new mapboxgl.Popup({ offset: [0, -32], closeButton: false })
      .setText(name);

    var marker = new mapboxgl.Marker({ element: markerEl, anchor: 'bottom' })
      .setLngLat(coords)
      .setPopup(popup)
      .addTo(map);

    markerEl.addEventListener('click', function () {
      setActive(id);
    });

    places.push({ id: id, name: name, coords: coords, color: color, marker: marker });

    map.flyTo({ center: coords, zoom: Math.max(map.getZoom(), 11), duration: 800 });
    setActive(id);
  }

  function removePlace(id) {
    var idx = places.findIndex(function (p) { return p.id === id; });
    if (idx === -1) return;
    places[idx].marker.remove();
    places.splice(idx, 1);
    if (activeId === id) activeId = null;
    renderPlaceList();
  }

  function setActive(id) {
    activeId = id;
    var place = places.find(function (p) { return p.id === id; });
    if (place) {
      places.forEach(function (p) { p.marker.getPopup().isOpen() && p.marker.togglePopup(); });
      place.marker.togglePopup();
    }
    renderPlaceList();
  }

  // ── Sidebar ──────────────────────────────────────────────────────────────────
  function renderPlaceList() {
    var el = document.getElementById('place-list');
    el.innerHTML = '';

    if (!places.length) {
      var empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = 'Search for a place above.\nIt will be pinned on the map.';
      el.appendChild(empty);
      return;
    }

    places.slice().reverse().forEach(function (place) {
      var div = document.createElement('div');
      div.className = 'place-item' + (place.id === activeId ? ' active' : '');

      var pin = document.createElement('div');
      pin.className = 'place-pin';
      pin.innerHTML = pinSvg(place.color, 14);

      var info = document.createElement('div');
      info.className = 'place-info';

      var nameEl = document.createElement('div');
      nameEl.className = 'place-name';
      nameEl.textContent = place.name;

      var coordsEl = document.createElement('div');
      coordsEl.className = 'place-coords';
      coordsEl.textContent = place.coords[1].toFixed(5) + ', ' + place.coords[0].toFixed(5);

      info.appendChild(nameEl);
      info.appendChild(coordsEl);

      var removeBtn = document.createElement('button');
      removeBtn.className = 'place-remove';
      removeBtn.textContent = '\xd7';
      removeBtn.title = 'Remove';
      removeBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        removePlace(place.id);
      });

      div.appendChild(pin);
      div.appendChild(info);
      div.appendChild(removeBtn);

      div.addEventListener('click', function () {
        map.flyTo({ center: place.coords, zoom: Math.max(map.getZoom(), 13), duration: 600 });
        setActive(place.id);
      });

      el.appendChild(div);
    });
  }

  // ── Pin SVG ───────────────────────────────────────────────────────────────────
  function pinSvg(color, size) {
    size = size || 24;
    return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 30" xmlns="http://www.w3.org/2000/svg">' +
      '<path d="M12 0C7.58 0 4 3.58 4 8c0 5.25 8 22 8 22s8-16.75 8-22c0-4.42-3.58-8-8-8z" fill="' + color + '"/>' +
      '<circle cx="12" cy="8" r="3.5" fill="rgba(0,0,0,0.25)"/>' +
      '</svg>';
  }

  // ── Toast ─────────────────────────────────────────────────────────────────────
  var _toastTimer = null;
  function showToast(msg) {
    var el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(function () { el.classList.add('hidden'); }, 3000);
  }

})();
