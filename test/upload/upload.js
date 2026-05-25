(function () {

  var MAPBOX_TOKEN = mapboxToken;
  var LAYER_COLORS = ['#4a9eff','#ff6b4a','#4aff9e','#ff4adb','#ffe04a','#4af0ff','#ff9e4a'];

  var layers = []; // [{ id, name, format, type:'vector'|'raster', color, visible, featureCount }]

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

  // ── File input / drop zone ───────────────────────────────────────────────────
  var dropZone  = document.getElementById('drop-zone');
  var fileInput = document.getElementById('file-input');

  // Prevent browser from navigating/downloading for any drop on the page
  document.addEventListener('dragover', function (e) { e.preventDefault(); });
  document.addEventListener('drop',     function (e) { e.preventDefault(); });

  fileInput.addEventListener('change', function () {
    Array.from(this.files).forEach(handleFile);
    this.value = '';
  });

  dropZone.addEventListener('dragover', function (e) {
    e.preventDefault();
    dropZone.classList.add('drag-over');
  });
  dropZone.addEventListener('dragleave', function (e) {
    if (!dropZone.contains(e.relatedTarget)) dropZone.classList.remove('drag-over');
  });
  dropZone.addEventListener('drop', function (e) {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    Array.from(e.dataTransfer.files).forEach(handleFile);
  });

  // ── Route each file by extension ─────────────────────────────────────────────
  function handleFile(file) {
    var ext = file.name.split('.').pop().toLowerCase();
    var reader = new FileReader();

    if (ext === 'geojson' || ext === 'json') {
      reader.onload = function (e) {
        try {
          var geojson = JSON.parse(e.target.result);
          addVectorLayer(geojson, file.name, 'GeoJSON');
        } catch (err) {
          showToast('Could not parse GeoJSON: ' + err.message, true);
        }
      };
      reader.readAsText(file);

    } else if (ext === 'kml') {
      reader.onload = function (e) {
        try {
          var dom = new DOMParser().parseFromString(e.target.result, 'text/xml');
          var parseErr = dom.querySelector('parsererror');
          if (parseErr) { showToast('KML is not valid XML', true); return; }
          var geojson = toGeoJSON.kml(dom);
          addVectorLayer(geojson, file.name, 'KML');
        } catch (err) {
          showToast('Could not parse KML: ' + err.message, true);
        }
      };
      reader.readAsText(file);

    } else if (ext === 'kmz') {
      showToast('KMZ not yet supported — unzip to KML first', true);

    } else if (ext === 'zip') {
      reader.onload = function (e) {
        shp(e.target.result).then(function (result) {
          var collections = Array.isArray(result) ? result : [result];
          collections.forEach(function (fc, i) {
            var label = collections.length > 1
              ? file.name.replace(/\.zip$/i, '') + ' (' + (i + 1) + ')'
              : file.name;
            addVectorLayer(fc, label, 'SHP');
          });
        }).catch(function (err) {
          showToast('Could not parse Shapefile ZIP: ' + err.message, true);
        });
      };
      reader.readAsArrayBuffer(file);

    } else if (ext === 'tif' || ext === 'tiff') {
      reader.onload = function (e) {
        loadGeoTIFF(e.target.result, file.name);
      };
      reader.readAsArrayBuffer(file);

    } else {
      showToast('Unsupported format: .' + ext, true);
    }
  }

  // ── Vector layer (GeoJSON / KML / SHP) ──────────────────────────────────────
  function addVectorLayer(geojson, filename, format) {
    if (!geojson || !geojson.features || !geojson.features.length) {
      showToast('No features found in ' + filename, true);
      return;
    }

    var color  = LAYER_COLORS[layers.length % LAYER_COLORS.length];
    var id     = 'layer-' + Date.now() + '-' + Math.random().toString(36).slice(2);
    var srcId  = 'src-' + id;

    map.addSource(srcId, { type: 'geojson', data: geojson });

    map.addLayer({
      id: id + '-fill',
      type: 'fill',
      source: srcId,
      filter: ['==', '$type', 'Polygon'],
      paint: { 'fill-color': color, 'fill-opacity': 0.3 }
    });
    map.addLayer({
      id: id + '-line',
      type: 'line',
      source: srcId,
      filter: ['in', '$type', 'LineString', 'Polygon'],
      paint: { 'line-color': color, 'line-width': 2, 'line-opacity': 0.9 }
    });
    map.addLayer({
      id: id + '-circle',
      type: 'circle',
      source: srcId,
      filter: ['==', '$type', 'Point'],
      paint: {
        'circle-color': color,
        'circle-radius': 6,
        'circle-stroke-color': '#fff',
        'circle-stroke-width': 1.5
      }
    });

    var bounds = computeBounds(geojson);
    if (bounds) map.fitBounds(bounds, { padding: 60, maxZoom: 16 });

    layers.push({
      id: id,
      srcId: srcId,
      name: stripExt(filename),
      format: format,
      type: 'vector',
      color: color,
      visible: true,
      featureCount: geojson.features.length
    });

    renderLayerList();
    showToast(geojson.features.length + ' features loaded from ' + filename);
  }

  // ── Raster layer (GeoTIFF) ───────────────────────────────────────────────────
  async function loadGeoTIFF(arrayBuffer, filename) {
    try {
      var tiff  = await GeoTIFF.fromArrayBuffer(arrayBuffer);
      var image = await tiff.getImage();

      var width  = image.getWidth();
      var height = image.getHeight();
      var bbox   = image.getBoundingBox(); // [west, south, east, north]
      var west = bbox[0], south = bbox[1], east = bbox[2], north = bbox[3];
      var spp    = image.getSamplesPerPixel();
      var bits   = image.getBitsPerSample();
      var maxVal = bits > 8 ? (Math.pow(2, bits) - 1) : 255;

      var data = await image.readRasters({ interleave: true });

      var canvas  = document.createElement('canvas');
      canvas.width  = width;
      canvas.height = height;
      var ctx = canvas.getContext('2d');
      var imgData = ctx.createImageData(width, height);
      var total   = width * height;

      for (var i = 0; i < total; i++) {
        var off = i * spp;
        var r, g, b, a;
        if (spp >= 3) {
          r = Math.round((data[off]     / maxVal) * 255);
          g = Math.round((data[off + 1] / maxVal) * 255);
          b = Math.round((data[off + 2] / maxVal) * 255);
          a = spp >= 4 ? Math.round((data[off + 3] / maxVal) * 255) : 255;
        } else {
          var v = Math.round((data[off] / maxVal) * 255);
          r = g = b = v;
          a = 255;
        }
        imgData.data[i * 4]     = r;
        imgData.data[i * 4 + 1] = g;
        imgData.data[i * 4 + 2] = b;
        imgData.data[i * 4 + 3] = a;
      }

      ctx.putImageData(imgData, 0, 0);
      var dataUrl = canvas.toDataURL('image/png');

      var id    = 'layer-' + Date.now() + '-' + Math.random().toString(36).slice(2);
      var srcId = 'src-' + id;

      map.addSource(srcId, {
        type: 'image',
        url: dataUrl,
        coordinates: [
          [west, north],
          [east, north],
          [east, south],
          [west, south]
        ]
      });
      map.addLayer({
        id: id + '-raster',
        type: 'raster',
        source: srcId,
        paint: { 'raster-opacity': 0.85 }
      });

      map.fitBounds([[west, south], [east, north]], { padding: 60 });

      layers.push({
        id: id,
        srcId: srcId,
        name: stripExt(filename),
        format: 'GeoTIFF',
        type: 'raster',
        color: null,
        visible: true,
        featureCount: null,
        dims: width + '\xd7' + height
      });

      renderLayerList();
      showToast('GeoTIFF loaded — ' + width + '\xd7' + height + 'px, ' + bits + '-bit, ' + spp + ' band' + (spp > 1 ? 's' : ''));

    } catch (err) {
      showToast('Could not load GeoTIFF: ' + err.message, true);
    }
  }

  // ── Sidebar ──────────────────────────────────────────────────────────────────
  function renderLayerList() {
    var el = document.getElementById('layer-list');
    el.innerHTML = '';

    layers.slice().reverse().forEach(function (layer) {
      var div = document.createElement('div');
      div.className = 'layer-item';

      var chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.className = 'layer-visibility';
      chk.checked = layer.visible;
      chk.title = 'Toggle visibility';
      chk.addEventListener('change', function (e) {
        e.stopPropagation();
        toggleVisibility(layer, chk.checked);
      });

      var swatch = document.createElement('div');
      swatch.className = 'layer-swatch';
      if (layer.type === 'raster') {
        swatch.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16"><rect x="1" y="1" width="14" height="14" rx="1" fill="none" stroke="#666" stroke-width="1.5"/><line x1="1" y1="6" x2="15" y2="6" stroke="#666" stroke-width="0.8"/><line x1="1" y1="10" x2="15" y2="10" stroke="#666" stroke-width="0.8"/><line x1="6" y1="1" x2="6" y2="15" stroke="#666" stroke-width="0.8"/><line x1="10" y1="1" x2="10" y2="15" stroke="#666" stroke-width="0.8"/></svg>';
      } else {
        swatch.style.background = layer.color;
      }

      var info = document.createElement('div');
      info.className = 'layer-info';

      var nameEl = document.createElement('span');
      nameEl.className = 'layer-name';
      nameEl.textContent = layer.name;

      var metaEl = document.createElement('span');
      metaEl.className = 'layer-meta';
      if (layer.type === 'vector') {
        metaEl.textContent = layer.format + ' \xb7 ' + layer.featureCount + ' feature' + (layer.featureCount !== 1 ? 's' : '');
      } else {
        metaEl.textContent = 'GeoTIFF \xb7 ' + layer.dims;
      }

      info.appendChild(nameEl);
      info.appendChild(metaEl);

      div.appendChild(chk);
      div.appendChild(swatch);
      div.appendChild(info);
      el.appendChild(div);
    });
  }

  // ── Visibility ────────────────────────────────────────────────────────────────
  function toggleVisibility(layer, visible) {
    layer.visible = visible;
    var vis = visible ? 'visible' : 'none';
    if (layer.type === 'raster') {
      if (map.getLayer(layer.id + '-raster')) map.setLayoutProperty(layer.id + '-raster', 'visibility', vis);
    } else {
      ['-fill', '-line', '-circle'].forEach(function (suffix) {
        if (map.getLayer(layer.id + suffix)) map.setLayoutProperty(layer.id + suffix, 'visibility', vis);
      });
    }
  }

  // ── Bounds ────────────────────────────────────────────────────────────────────
  function computeBounds(geojson) {
    var minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
    geojson.features.forEach(function (f) {
      collectCoords(f.geometry, function (lng, lat) {
        if (lng < minLng) minLng = lng;
        if (lat < minLat) minLat = lat;
        if (lng > maxLng) maxLng = lng;
        if (lat > maxLat) maxLat = lat;
      });
    });
    if (!isFinite(minLng)) return null;
    return [[minLng, minLat], [maxLng, maxLat]];
  }

  // Handles both regular geometries (coordinates) and GeometryCollections (geometries)
  function collectCoords(geometry, fn) {
    if (!geometry) return;
    if (geometry.type === 'GeometryCollection') {
      (geometry.geometries || []).forEach(function (g) { collectCoords(g, fn); });
    } else if (geometry.coordinates) {
      walkCoords(geometry.coordinates, fn);
    }
  }

  function walkCoords(coords, fn) {
    if (!coords || !coords.length) return;
    if (typeof coords[0] === 'number') {
      fn(coords[0], coords[1]);
    } else {
      coords.forEach(function (c) { walkCoords(c, fn); });
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────
  function stripExt(filename) {
    return filename.replace(/\.[^.]+$/, '');
  }

  var _toastTimer = null;
  function showToast(msg, isError) {
    var el = document.getElementById('toast');
    el.textContent = msg;
    el.className = isError ? 'error' : '';
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(function () { el.className = 'hidden'; }, isError ? 5000 : 3000);
  }

})();
