(function () {

// ---- State ----
var _map        = null;
var _mapReady   = false;
var _origLayer  = null;   // reference to original in layers[] (may have functions)
var _layer      = null;   // deep copy, functions stripped — this is what we edit
var _activeTab  = 'form';
var _PREV_SRC   = 'studio-src';
var _PREV_LYR   = 'studio-lyr';
var _draw       = null;
var _DRAW_SRC   = 'studio-draw-src';
var _DRAW_FILL  = 'studio-draw-fill';
var _DRAW_LINE  = 'studio-draw-line';
var _UPLOAD_SRC    = 'studio-upload-src';
var _UPLOAD_FILL   = 'studio-upload-fill';
var _UPLOAD_LINE   = 'studio-upload-line';
var _UPLOAD_CIRCLE = 'studio-upload-circle';

var UPLOAD_COLORS = ['#4a9eff','#ff6b4a','#4aff9e','#ff4adb','#ffe04a','#4af0ff','#ff9e4a'];

var dragId         = null;
var insertBeforeId = null;
var dropIntoId     = null;

// MapboxDraw styles: only editing handles + dashed outline while actively drawing.
// The actual fill/stroke is handled by _DRAW_FILL / _DRAW_LINE via setPaintProperty.
var DRAW_STYLES = [
  { id: 'studio-active-stroke', type: 'line',
    filter: ['all', ['==', '$type', 'Polygon'], ['==', 'active', 'true']],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#fff', 'line-width': 2, 'line-dasharray': [2, 2] },
  },
  { id: 'studio-vertex', type: 'circle',
    filter: ['all', ['==', '$type', 'Point'], ['==', 'meta', 'vertex']],
    paint: { 'circle-radius': 4, 'circle-color': '#fff', 'circle-stroke-width': 2, 'circle-stroke-color': '#888' },
  },
  { id: 'studio-midpoint', type: 'circle',
    filter: ['all', ['==', '$type', 'Point'], ['==', 'meta', 'midpoint']],
    paint: { 'circle-radius': 3, 'circle-color': '#fbb03b' },
  },
];

// ---- Init ----
window.addEventListener('load', function () {
  initMap();
  renderLayerList();
  initTabs();
  document.getElementById('copy-btn').addEventListener('click', copyJS);
  document.getElementById('add-layer-btn').addEventListener('click', openAddLayerForm);
  document.getElementById('add-group-btn').addEventListener('click', function () { openStudioAddInput('group'); });
  document.getElementById('add-section-btn').addEventListener('click', function () { openStudioAddInput('section'); });
  document.getElementById('cancel-layer-btn').addEventListener('click', cancelAddLayer);
  document.getElementById('create-layer-btn').addEventListener('click', createLayer);
  document.getElementById('new-layer-label').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') createLayer();
    if (e.key === 'Escape') cancelAddLayer();
  });
  document.getElementById('upload-layer-btn').addEventListener('click', function () {
    document.getElementById('upload-file-input').click();
  });
  document.getElementById('upload-file-input').addEventListener('change', function () {
    Array.from(this.files).forEach(handleUploadFile);
    this.value = '';
  });
  initLayerListDrag();
  initStudioAddInput();
});

// ---- Map preview ----
function initMap() {
  mapboxgl.accessToken = mapboxToken;
  _map = new mapboxgl.Map({
    container:          'map-preview',
    style:              'mapbox://styles/mapbox/streets-v12',
    center:             [-96, 38],
    zoom:               4,
    attributionControl: false,
    hash: true,
  });
  _map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), 'top-right');
  _map.on('load', function () {
    _mapReady = true;

    // Upload display layers
    _map.addSource(_UPLOAD_SRC, { type: 'geojson', data: emptyFC() });
    _map.addLayer({ id: _UPLOAD_FILL, type: 'fill', source: _UPLOAD_SRC,
      filter: ['==', '$type', 'Polygon'],
      paint: { 'fill-color': '#4a9eff', 'fill-opacity': 0.3 } });
    _map.addLayer({ id: _UPLOAD_LINE, type: 'line', source: _UPLOAD_SRC,
      filter: ['in', '$type', 'LineString', 'Polygon'],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#4a9eff', 'line-width': 2 } });
    _map.addLayer({ id: _UPLOAD_CIRCLE, type: 'circle', source: _UPLOAD_SRC,
      filter: ['==', '$type', 'Point'],
      paint: { 'circle-color': '#4a9eff', 'circle-radius': 6,
               'circle-stroke-color': '#fff', 'circle-stroke-width': 1.5 } });

    // Draw display layers (added before MapboxDraw so handles render on top)
    _map.addSource(_DRAW_SRC, { type: 'geojson', data: emptyFC() });
    _map.addLayer({ id: _DRAW_FILL, type: 'fill', source: _DRAW_SRC,
      paint: { 'fill-color': '#888888', 'fill-opacity': 0.5 } });
    _map.addLayer({ id: _DRAW_LINE, type: 'line', source: _DRAW_SRC,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#000000', 'line-width': 2 } });

    _draw = new MapboxDraw({
      displayControlsDefault: false,
      controls: { polygon: true, trash: true },
      styles: DRAW_STYLES,
    });
    _map.addControl(_draw, 'top-left');
    _map.on('draw.create', saveDraw);
    _map.on('draw.update', saveDraw);
    _map.on('draw.delete', saveDraw);
  });
}

function emptyFC() { return { type: 'FeatureCollection', features: [] }; }

function loadOnMap(layer) {
  if (!_mapReady) { _map.once('load', function () { loadOnMap(layer); }); return; }
  if (layer.type === 'draw' || layer.type === 'upload') return;
  if (!layer.source || (!layer.source.url && !(layer.source.tiles && layer.source.tiles[0]))) return;
  if (_map.getLayer(_PREV_LYR)) _map.removeLayer(_PREV_LYR);
  if (_map.getSource(_PREV_SRC)) _map.removeSource(_PREV_SRC);
  try {
    _map.addSource(_PREV_SRC, layer.source);
    _map.addLayer({
      id:             _PREV_LYR,
      type:           layer.type,
      source:         _PREV_SRC,
      'source-layer': layer['source-layer'] || '',
      layout:         layer.layout || { visibility: 'visible' },
      paint:          layer.paint  || {},
    });
    if (layer.zoomCenter && layer.zoomLevel) {
      _map.flyTo({ center: layer.zoomCenter, zoom: layer.zoomLevel, duration: 700 });
    }
  } catch (e) {
    console.warn('[studio] preview:', e.message);
  }
}

function liveUpdate() {
  if (!_map || !_layer) return;
  if (_layer.type === 'draw')   { liveUpdateDraw();   return; }
  if (_layer.type === 'upload') { liveUpdateUpload(); return; }
  if (!_map.getLayer(_PREV_LYR)) return;
  Object.keys(_layer.paint || {}).forEach(function (p) {
    try { _map.setPaintProperty(_PREV_LYR, p, _layer.paint[p]); } catch (e) {}
  });
}

// ---- Draw ----
function saveDraw() {
  if (!_draw || !_layer || _layer.type !== 'draw') return;
  var fc = _draw.getAll();
  _layer.features = fc;
  if (_origLayer) _origLayer.features = fc;
  if (_map.getSource(_DRAW_SRC)) _map.getSource(_DRAW_SRC).setData(fc);
  syncJSON();
}

function activateDrawLayer() {
  if (!_mapReady) { _map.once('load', activateDrawLayer); return; }
  if (_map.getLayer(_PREV_LYR)) _map.removeLayer(_PREV_LYR);
  if (_map.getSource(_PREV_SRC)) _map.removeSource(_PREV_SRC);
  _draw.deleteAll();
  var fc = _layer.features || emptyFC();
  if (fc.features && fc.features.length) _draw.add(fc);
  _map.getSource(_DRAW_SRC).setData(fc);
  liveUpdateDraw();
  document.getElementById('studio-wrap').classList.add('draw-active');
}

function deactivateDrawLayer() {
  if (!_draw) return;
  _draw.deleteAll();
  try { _draw.changeMode('simple_select'); } catch (e) {}
  if (_map && _map.getSource(_DRAW_SRC)) _map.getSource(_DRAW_SRC).setData(emptyFC());
  document.getElementById('studio-wrap').classList.remove('draw-active');
}

function liveUpdateDraw() {
  if (!_map.getLayer(_DRAW_FILL)) return;
  var p = _layer.paint || {};
  try { _map.setPaintProperty(_DRAW_FILL, 'fill-color',   p['fill-color']         || '#888888'); } catch (e) {}
  try { _map.setPaintProperty(_DRAW_FILL, 'fill-opacity', p['fill-opacity']        !== undefined ? p['fill-opacity'] : 0.5); } catch (e) {}
  try { _map.setPaintProperty(_DRAW_LINE, 'line-color',   p['fill-outline-color'] || '#000000'); } catch (e) {}
}

// ---- Upload ----
function handleUploadFile(file) {
  var ext = file.name.split('.').pop().toLowerCase();
  var reader = new FileReader();

  if (ext === 'geojson' || ext === 'json') {
    reader.onload = function (e) {
      try {
        addUploadLayer(JSON.parse(e.target.result), file.name, 'GeoJSON');
      } catch (err) { alert('Could not parse GeoJSON: ' + err.message); }
    };
    reader.readAsText(file);

  } else if (ext === 'kml') {
    reader.onload = function (e) {
      try {
        var dom = new DOMParser().parseFromString(e.target.result, 'text/xml');
        addUploadLayer(toGeoJSON.kml(dom), file.name, 'KML');
      } catch (err) { alert('Could not parse KML: ' + err.message); }
    };
    reader.readAsText(file);

  } else if (ext === 'zip') {
    reader.onload = function (e) {
      shp(e.target.result).then(function (result) {
        var cols = Array.isArray(result) ? result : [result];
        cols.forEach(function (fc, i) {
          var name = cols.length > 1
            ? file.name.replace(/\.zip$/i, '') + ' (' + (i + 1) + ')'
            : file.name;
          addUploadLayer(fc, name, 'SHP');
        });
      }).catch(function (err) { alert('Could not parse Shapefile: ' + err.message); });
    };
    reader.readAsArrayBuffer(file);

  } else {
    alert('Unsupported format: .' + ext + '\nSupported: GeoJSON, KML, SHP (ZIP)');
  }
}

function addUploadLayer(geojson, filename, format) {
  if (!geojson || !geojson.features || !geojson.features.length) {
    alert('No features found in ' + filename);
    return;
  }
  var uploadCount = layers.filter(function (l) { return l.type === 'upload'; }).length;
  var color = UPLOAD_COLORS[uploadCount % UPLOAD_COLORS.length];
  var id = 'layer-' + Date.now();

  layers.push({
    id:           id,
    name:         id,
    label:        stripExt(filename),
    iconColor:    color,
    type:         'upload',
    format:       format,
    featureCount: geojson.features.length,
    paint:        { color: color, opacity: 0.7 },
    geojson:      geojson,
    _new:         true,
  });

  renderLayerList();
  selectLayer(id);

  var bounds = computeBounds(geojson);
  if (bounds && _map) _map.fitBounds(bounds, { padding: 60, maxZoom: 16 });
}

function loadUploadLayer() {
  if (!_mapReady) { _map.once('load', loadUploadLayer); return; }
  if (_map.getLayer(_PREV_LYR)) _map.removeLayer(_PREV_LYR);
  if (_map.getSource(_PREV_SRC)) _map.removeSource(_PREV_SRC);
  var fc = _layer.geojson || emptyFC();
  _map.getSource(_UPLOAD_SRC).setData(fc);
  liveUpdateUpload();
}

function deactivateUploadLayer() {
  if (_map && _map.getSource(_UPLOAD_SRC)) _map.getSource(_UPLOAD_SRC).setData(emptyFC());
}

function liveUpdateUpload() {
  if (!_map.getLayer(_UPLOAD_FILL)) return;
  var p = _layer.paint || {};
  var color   = p.color   || '#4a9eff';
  var opacity = p.opacity !== undefined ? p.opacity : 0.7;
  try { _map.setPaintProperty(_UPLOAD_FILL,   'fill-color',         color); } catch (e) {}
  try { _map.setPaintProperty(_UPLOAD_FILL,   'fill-opacity',       opacity * 0.5); } catch (e) {}
  try { _map.setPaintProperty(_UPLOAD_LINE,   'line-color',         color); } catch (e) {}
  try { _map.setPaintProperty(_UPLOAD_LINE,   'line-opacity',       opacity); } catch (e) {}
  try { _map.setPaintProperty(_UPLOAD_CIRCLE, 'circle-color',       color); } catch (e) {}
  try { _map.setPaintProperty(_UPLOAD_CIRCLE, 'circle-opacity',     opacity); } catch (e) {}
}

function computeBounds(geojson) {
  var w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  geojson.features.forEach(function (f) {
    collectCoords(f.geometry, function (lng, lat) {
      if (lng < w) w = lng; if (lat < s) s = lat;
      if (lng > e) e = lng; if (lat > n) n = lat;
    });
  });
  return isFinite(w) ? [[w, s], [e, n]] : null;
}

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
  if (typeof coords[0] === 'number') { fn(coords[0], coords[1]); }
  else { coords.forEach(function (c) { walkCoords(c, fn); }); }
}

function stripExt(filename) { return filename.replace(/\.[^.]+$/, ''); }

// ---- Layer list ----
function buildLayerHTML(arr, depth) {
  var html = '';
  var indent = 8 + depth * 16;
  (arr || []).forEach(function (item) {
    var isContainer = item.type === 'group' || item.type === 'section';
    if (isContainer) {
      var isOpen = item.open !== undefined ? item.open : !item.collapsed;
      html += '<div class="row list-container ' + item.type + '" data-id="' + esc(item.id) + '"'
            + ' style="padding-left:' + indent + 'px" draggable="true">'
            + '<span class="row-toggle">' + (isOpen ? '▾' : '▸') + '</span> '
            + esc(item.label || item.id) + '</div>';
      if (isOpen && item.children && item.children.length) {
        html += buildLayerHTML(item.children, depth + 1);
      }
    } else if (item.id) {
      html += '<div class="row list-layer' + (item._new ? ' is-new' : '') + '" data-id="' + esc(item.id) + '"'
            + ' style="padding-left:' + indent + 'px" draggable="true">'
            + '<span class="l-swatch" style="background:' + esc(item.iconColor || '#888') + '"></span>'
            + esc(item.label || item.id) + '</div>';
    }
  });
  return html;
}

function renderLayerList() {
  var list = document.getElementById('layer-list');
  list.innerHTML = buildLayerHTML(layers, 0);

  list.querySelectorAll('.list-layer').forEach(function (el) {
    el.addEventListener('click', function () { selectLayer(this.dataset.id); });
  });

  list.querySelectorAll('.row-toggle').forEach(function (el) {
    el.addEventListener('click', function (e) {
      e.stopPropagation();
      var row = e.target.closest('[data-id]');
      if (!row) return;
      var found = findItem(row.dataset.id);
      if (!found) return;
      var cur = found.item.open !== undefined ? found.item.open : !found.item.collapsed;
      found.item.open = !cur;
      renderLayerList();
    });
  });

  list.querySelectorAll('[draggable]').forEach(function (el) {
    el.addEventListener('dragstart', function (e) {
      dragId = el.dataset.id;
      e.dataTransfer.effectAllowed = 'move';
      setTimeout(function () { el.classList.add('dragging'); }, 0);
    });
    el.addEventListener('dragend', function () {
      el.classList.remove('dragging');
      dragId = null;
      clearDragIndicator();
    });
  });
}

function findLayer(id, arr) {
  arr = arr || layers;
  for (var i = 0; i < arr.length; i++) {
    if (arr[i].id === id) return arr[i];
    if (arr[i].children) { var f = findLayer(id, arr[i].children); if (f) return f; }
  }
  return null;
}

function findItem(id, arr, parentType) {
  arr = arr || layers;
  parentType = parentType || null;
  for (var i = 0; i < arr.length; i++) {
    if (arr[i].id === id) return { item: arr[i], arr: arr, idx: i, parentType: parentType };
    if (arr[i].children) {
      var r = findItem(id, arr[i].children, arr[i].type);
      if (r) return r;
    }
  }
  return null;
}

function moveItemInto(fromId, containerId) {
  var from = findItem(fromId);
  if (!from) return;
  var cont = findItem(containerId);
  if (!cont || !cont.item.children) return;
  if (from.item.type === 'section') return;
  if (from.item.type === 'group' && cont.item.type === 'group') return;

  from.arr.splice(from.idx, 1);
  var cont2 = findItem(containerId);
  if (!cont2) { from.arr.splice(from.idx, 0, from.item); return; }
  cont2.item.children.push(from.item);
  cont2.item.open = true;
}

function moveItemBefore(fromId, toId) {
  var from = findItem(fromId);
  if (!from) return;

  if (toId === null) {
    if (from.arr === layers && from.idx === layers.length - 1) return;
    from.arr.splice(from.idx, 1);
    layers.push(from.item);
    return;
  }

  var check = findItem(toId);
  if (check && check.arr === from.arr && check.idx === from.idx + 1) return;

  from.arr.splice(from.idx, 1);
  var to = findItem(toId);
  if (!to) { from.arr.splice(from.idx, 0, from.item); return; }

  if (from.item.type === 'section' && to.parentType !== null) {
    from.arr.splice(from.idx, 0, from.item); return;
  }
  if (from.item.type === 'group' && to.parentType === 'group') {
    from.arr.splice(from.idx, 0, from.item); return;
  }

  to.arr.splice(to.idx, 0, from.item);
}

// ---- Drag (container-level) ----
function initLayerListDrag() {
  var list = document.getElementById('layer-list');

  list.addEventListener('dragover', function (e) {
    e.preventDefault();
    if (dragId === null) return;

    var els = Array.from(list.querySelectorAll('.row:not(.dragging)'));
    var cursor = e.clientY;
    var newInsert = null;
    var newInto   = null;

    for (var i = 0; i < els.length; i++) {
      var r = els[i].getBoundingClientRect();
      var isContainer = els[i].classList.contains('list-container');
      var mid = r.top + r.height / 2;

      if (cursor < mid) {
        if (isContainer && cursor >= r.top + r.height * 0.35) {
          newInto = els[i].dataset.id;
        } else {
          newInsert = els[i].dataset.id;
        }
        break;
      } else if (isContainer && cursor < r.bottom) {
        newInto = els[i].dataset.id;
        break;
      }
    }

    if (newInsert === insertBeforeId && newInto === dropIntoId) return;
    insertBeforeId = newInsert;
    dropIntoId     = newInto;
    clearDragIndicator();

    if (dropIntoId !== null) {
      var t = list.querySelector('[data-id="' + dropIntoId + '"]');
      if (t) t.classList.add('drop-into');
    } else if (insertBeforeId !== null) {
      var t2 = list.querySelector('[data-id="' + insertBeforeId + '"]');
      if (t2) t2.classList.add('drop-before');
    } else {
      list.classList.add('drop-after-last');
    }
  });

  list.addEventListener('dragleave', function (e) {
    if (!list.contains(e.relatedTarget)) {
      clearDragIndicator();
      insertBeforeId = null;
      dropIntoId     = null;
    }
  });

  list.addEventListener('drop', function (e) {
    e.preventDefault();
    clearDragIndicator();
    if (dragId === null) return;
    if (dropIntoId !== null) {
      moveItemInto(dragId, dropIntoId);
    } else {
      moveItemBefore(dragId, insertBeforeId);
    }
    insertBeforeId = null;
    dropIntoId     = null;
    dragId         = null;
    renderLayerList();
  });
}

function clearDragIndicator() {
  document.querySelectorAll('#layer-list .drop-before').forEach(function (el) { el.classList.remove('drop-before'); });
  document.querySelectorAll('#layer-list .drop-into').forEach(function (el) { el.classList.remove('drop-into'); });
  var list = document.getElementById('layer-list');
  if (list) list.classList.remove('drop-after-last');
}

// ---- Select ----
function selectLayer(id) {
  // Persist current layer's paint (and draw features) before switching
  if (_layer && _origLayer) {
    if (_layer.type === 'draw') {
      _origLayer.paint    = JSON.parse(JSON.stringify(_layer.paint || {}));
      _origLayer.features = _draw ? _draw.getAll() : (_layer.features || emptyFC());
    } else if (_layer.type === 'upload') {
      _origLayer.paint = JSON.parse(JSON.stringify(_layer.paint || {}));
    }
  }
  // Always deactivate both special modes before switching
  deactivateDrawLayer();
  deactivateUploadLayer();

  document.querySelectorAll('.list-layer').forEach(function (el) {
    el.classList.toggle('active', el.dataset.id === id);
  });
  _origLayer = findLayer(id);
  if (!_origLayer) return;
  _layer = JSON.parse(JSON.stringify(_origLayer)); // strip functions
  openEditor();

  if (_layer.type === 'draw')        activateDrawLayer();
  else if (_layer.type === 'upload') loadUploadLayer();
  else                               loadOnMap(_origLayer);
}

// ---- Editor ----
function openEditor() {
  document.getElementById('no-selection').style.display  = 'none';
  document.getElementById('studio-editor').style.display = '';
  document.getElementById('studio-footer').style.display = 'flex';
  document.getElementById('layer-title').textContent      = _layer.label || _layer.id;
  document.getElementById('layer-type-badge').textContent = _layer.type  || '';
  if (_activeTab === 'form') { renderForm(); syncJSON(); }
  else                       { syncJSON(); }
}

// ---- Tabs ----
function initTabs() {
  document.querySelectorAll('.tab-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var to = this.dataset.tab;
      if (to === _activeTab) return;

      if (_activeTab === 'json' && to === 'form') {
        var ta = document.getElementById('json-editor');
        try {
          _layer = JSON.parse(ta.value);
          ta.classList.remove('json-error');
        } catch (e) {
          ta.classList.add('json-error');
          return;
        }
      }

      _activeTab = to;
      document.querySelectorAll('.tab-btn').forEach(function (b) {
        b.classList.toggle('active', b.dataset.tab === to);
      });
      document.getElementById('tab-form').style.display = to === 'form' ? '' : 'none';
      document.getElementById('tab-json').style.display  = to === 'json' ? '' : 'none';

      if (to === 'form') renderForm();
      if (to === 'json') {
        document.getElementById('json-editor').value = JSON.stringify(_layer, null, 2);
      }
    });
  });
}

// ---- Form rendering ----
function renderForm() {
  var l = _layer;
  if (!l) return;
  var html = '';

  html += fSection('Basic', [
    fRow('Label',      fText('f-label',      l.label     || '')),
    fRow('Icon Color', fColor('f-icon-color', l.iconColor || '#888888')),
  ]);

  if (l.type === 'line') {
    html += fSection('Style', [
      fRow('Color',   fColor('f-line-color',  paintVal(l, 'line-color',   '#888888'))),
      fRow('Opacity', fRange('f-line-opacity', paintVal(l, 'line-opacity', 1), 0, 1, 0.05)),
      fRow('Width',   fWidthCtrl('f-line-width', paintVal(l, 'line-width', 1))),
      l.paint && l.paint['line-blur'] !== undefined
        ? fRow('Blur', fNum('f-line-blur', paintVal(l, 'line-blur', 0), 0, 20, 0.5))
        : '',
    ]);
  } else if (l.type === 'fill' || l.type === 'draw') {
    html += fSection('Style', [
      fRow('Fill Color',    fColor('f-fill-color',   paintVal(l, 'fill-color',         '#888888'))),
      fRow('Outline Color', fColor('f-fill-outline', paintVal(l, 'fill-outline-color', '#000000'))),
      fRow('Opacity',       fRange('f-fill-opacity', paintVal(l, 'fill-opacity',        0.5), 0, 1, 0.05)),
    ]);
  } else if (l.type === 'upload') {
    var p = l.paint || {};
    html += fSection('Style', [
      fRow('Color',   fColor('f-upload-color',   p.color   || '#4a9eff')),
      fRow('Opacity', fRange('f-upload-opacity', p.opacity !== undefined ? p.opacity : 0.7, 0, 1, 0.05)),
    ]);
    html += fSection('Source', [
      fRow('Format',   '<span class="f-static">' + esc(l.format || 'GeoJSON') + '</span>'),
      fRow('Features', '<span class="f-static">' + esc(String(l.featureCount || '?')) + '</span>'),
    ]);
  }

  if (l.source) {
    var srcRows = [];
    if ('url'   in l.source) srcRows.push(fRow('Mapbox URL', fText('f-src-url',  l.source.url)));
    if ('tiles' in l.source) srcRows.push(fRow('Tile URL',   fText('f-src-tile', (l.source.tiles || [''])[0])));
    if (l['source-layer'] !== undefined)
      srcRows.push(fRow('Source Layer', fText('f-src-layer', l['source-layer'])));
    if (srcRows.length) html += fSection('Source', srcRows);
  }

  document.getElementById('tab-form').innerHTML = html;
  bindForm();
}

// Form element builders
function fSection(title, rows) {
  return '<div class="f-section"><div class="f-section-title">' + esc(title) + '</div>' +
    rows.filter(Boolean).join('') + '</div>';
}
function fRow(label, ctrl) {
  return '<div class="f-row"><div class="f-label">' + esc(label) + '</div><div class="f-ctrl">' + ctrl + '</div></div>';
}
function fText(id, val) {
  return '<input type="text" class="s-input" id="' + id + '" value="' + esc(String(val)) + '"/>';
}
function fNum(id, val, min, max, step) {
  return '<input type="number" class="s-input s-num" id="' + id + '" value="' + val + '"' +
    (min  !== undefined ? ' min="' + min + '"'   : '') +
    (max  !== undefined ? ' max="' + max + '"'   : '') +
    (step !== undefined ? ' step="' + step + '"' : '') + '/>';
}
function fColor(id, val) {
  val = String(val || '#888888');
  var hex = /^#[0-9a-fA-F]{6}$/.test(val) ? val : '#888888';
  return '<div class="color-pair">' +
    '<input type="color" class="s-color" id="' + id + '" value="' + hex + '"/>' +
    '<input type="text" class="s-input s-color-txt" id="' + id + '-txt" value="' + esc(val) + '" maxlength="7"/>' +
    '</div>';
}
function fRange(id, val, min, max, step) {
  var v = parseFloat(val) || 0;
  return '<div class="range-pair">' +
    '<input type="range" class="s-range" id="' + id + '" min="' + min + '" max="' + max + '" step="' + step + '" value="' + v + '"/>' +
    '<span class="range-disp" id="' + id + '-disp">' + v + '</span></div>';
}
function fWidthCtrl(id, val) {
  var isStops = Array.isArray(val) && val[0] === 'interpolate';
  return '<div class="width-wrap" id="' + id + '-wrap">' +
    '<div class="mode-bar">' +
    '<button class="mode-btn' + (!isStops ? ' active' : '') + '" data-mode="simple" data-fid="' + id + '">Simple</button>' +
    '<button class="mode-btn' + ( isStops ? ' active' : '') + '" data-mode="stops"  data-fid="' + id + '">Zoom Stops</button>' +
    '</div>' +
    (isStops ? fStopsWidget(id, val) : fNum(id + '-simple', Array.isArray(val) ? 1 : val, 0, 100, 0.5)) +
    '</div>';
}
function fStopsWidget(id, expr) {
  var pairs = [];
  for (var i = 3; i + 1 < expr.length; i += 2) pairs.push([expr[i], expr[i + 1]]);
  var html = '<div class="stops-tbl" id="' + id + '-stops">' +
    '<div class="stops-hdr"><span>Zoom</span><span>Width</span><span></span></div>';
  pairs.forEach(function (p, idx) { html += fStopRow(id, idx, p[0], p[1]); });
  html += '</div><button class="add-stop" data-fid="' + id + '">+ Add Stop</button>';
  return html;
}
function fStopRow(fid, idx, zoom, val) {
  return '<div class="stop-row" data-idx="' + idx + '">' +
    '<input type="number" class="s-input s-stop-z" value="' + zoom + '" min="0" max="22" step="1"/>' +
    '<input type="number" class="s-input s-stop-v" value="' + val  + '" min="0" step="0.5"/>' +
    '<button class="rm-stop" data-fid="' + fid + '" data-idx="' + idx + '">&#215;</button></div>';
}

function paintVal(layer, prop, def) {
  return (layer.paint && layer.paint[prop] !== undefined) ? layer.paint[prop] : def;
}

// ---- Form events ----
function bindForm() {
  var form = document.getElementById('tab-form');
  form.addEventListener('input', function (e) {
    var t = e.target;
    if (t.classList.contains('s-color')) {
      var txt = document.getElementById(t.id + '-txt');
      if (txt) txt.value = t.value;
    }
    if (t.classList.contains('s-color-txt')) {
      if (/^#[0-9a-fA-F]{6}$/.test(t.value)) {
        var picker = document.getElementById(t.id.replace('-txt', ''));
        if (picker) picker.value = t.value;
      }
    }
    if (t.classList.contains('s-range')) {
      var disp = document.getElementById(t.id + '-disp');
      if (disp) disp.textContent = parseFloat(t.value).toFixed(2).replace(/\.?0+$/, '') || '0';
    }
    collect();
  });
  form.addEventListener('click', function (e) {
    if (e.target.classList.contains('mode-btn'))  { switchWidthMode(e.target.dataset.fid, e.target.dataset.mode); return; }
    if (e.target.classList.contains('add-stop'))  { addStop(e.target.dataset.fid); return; }
    if (e.target.classList.contains('rm-stop'))   { removeStop(e.target.dataset.fid, parseInt(e.target.dataset.idx)); return; }
  });
}

function switchWidthMode(fid, mode) {
  var wrap = document.getElementById(fid + '-wrap');
  if (!wrap) return;
  wrap.querySelectorAll('.mode-btn').forEach(function (b) { b.classList.toggle('active', b.dataset.mode === mode); });
  var bar = wrap.querySelector('.mode-bar');
  while (bar.nextSibling) wrap.removeChild(bar.nextSibling);
  if (mode === 'stops') {
    var cur = paintVal(_layer, 'line-width', 1);
    var expr = (Array.isArray(cur) && cur[0] === 'interpolate')
      ? cur
      : (function () {
          var v = parseFloat(cur) || 1;
          return ['interpolate', ['linear'], ['zoom'], 8, v, 12, v * 1.5, 16, v * 2.5, 20, v * 4];
        }());
    wrap.insertAdjacentHTML('beforeend', fStopsWidget(fid, expr));
  } else {
    var curr = paintVal(_layer, 'line-width', 1);
    wrap.insertAdjacentHTML('beforeend', fNum(fid + '-simple', Array.isArray(curr) ? 2 : curr, 0, 100, 0.5));
  }
  collect();
}

function addStop(fid) {
  var tbl = document.getElementById(fid + '-stops');
  if (!tbl) return;
  var rows = tbl.querySelectorAll('.stop-row');
  var z = 22, v = 6;
  if (rows.length) {
    var last = rows[rows.length - 1];
    z = Math.min(22, parseFloat(last.querySelector('.s-stop-z').value) + 2);
    v = parseFloat(last.querySelector('.s-stop-v').value);
  }
  tbl.insertAdjacentHTML('beforeend', fStopRow(fid, rows.length, z, v));
  collect();
}

function removeStop(fid, idx) {
  var tbl = document.getElementById(fid + '-stops');
  if (!tbl) return;
  var rows = tbl.querySelectorAll('.stop-row');
  if (rows.length <= 2) return; // minimum 2 stops
  rows[idx].remove();
  tbl.querySelectorAll('.stop-row').forEach(function (r, i) {
    r.dataset.idx = i;
    r.querySelector('.rm-stop').dataset.idx = i;
  });
  collect();
}

// ---- Collect form → state ----
function collect() {
  if (!_layer) return;
  var l = _layer;
  var el;

  if ((el = document.getElementById('f-label')))          l.label     = el.value;
  if ((el = document.getElementById('f-icon-color-txt'))) l.iconColor = el.value;

  if (l.type === 'line') {
    if (!l.paint) l.paint = {};
    if ((el = document.getElementById('f-line-color-txt')))  l.paint['line-color']   = el.value;
    if ((el = document.getElementById('f-line-opacity')))    l.paint['line-opacity'] = parseFloat(el.value);
    if ((el = document.getElementById('f-line-blur')))       l.paint['line-blur']    = parseFloat(el.value) || 0;

    var wrap = document.getElementById('f-line-width-wrap');
    if (wrap) {
      var activeMode = wrap.querySelector('.mode-btn.active');
      if (activeMode && activeMode.dataset.mode === 'stops') {
        var tbl = document.getElementById('f-line-width-stops');
        if (tbl) {
          var expr = ['interpolate', ['linear'], ['zoom']];
          tbl.querySelectorAll('.stop-row').forEach(function (r) {
            expr.push(parseFloat(r.querySelector('.s-stop-z').value));
            expr.push(parseFloat(r.querySelector('.s-stop-v').value));
          });
          l.paint['line-width'] = expr;
        }
      } else {
        if ((el = document.getElementById('f-line-width-simple')))
          l.paint['line-width'] = parseFloat(el.value) || 1;
      }
    }
  } else if (l.type === 'fill' || l.type === 'draw') {
    if (!l.paint) l.paint = {};
    if ((el = document.getElementById('f-fill-color-txt')))   l.paint['fill-color']         = el.value;
    if ((el = document.getElementById('f-fill-outline-txt'))) l.paint['fill-outline-color']  = el.value;
    if ((el = document.getElementById('f-fill-opacity')))     l.paint['fill-opacity']        = parseFloat(el.value);
  } else if (l.type === 'upload') {
    if (!l.paint) l.paint = {};
    if ((el = document.getElementById('f-upload-color-txt'))) l.paint.color   = el.value;
    if ((el = document.getElementById('f-upload-opacity')))   l.paint.opacity = parseFloat(el.value);
  }

  if (l.source) {
    if ((el = document.getElementById('f-src-url')))  l.source.url        = el.value;
    if ((el = document.getElementById('f-src-tile'))) l.source.tiles      = [el.value];
  }
  if ((el = document.getElementById('f-src-layer'))) l['source-layer'] = el.value;

  syncJSON();
  liveUpdate();
}

// ---- JSON sync ----
function syncJSON() {
  if (_activeTab === 'json') return; // don't overwrite while user edits
  var ta = document.getElementById('json-editor');
  if (ta && _layer) ta.value = JSON.stringify(_layer, null, 2);
}

// ---- Copy output ----
function copyJS() {
  if (!_layer) return;
  var out = JSON.stringify(_layer, null, 2);
  var note = document.getElementById('copy-note');
  note.style.display = hasFunctions(_origLayer) ? '' : 'none';

  var fallback = function () {
    var ta = document.createElement('textarea');
    ta.value = out;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  };

  if (navigator.clipboard) {
    navigator.clipboard.writeText(out).then(flash).catch(fallback);
  } else {
    fallback();
    flash();
  }
}

function flash() {
  var fb = document.getElementById('copy-feedback');
  fb.textContent = 'Copied!';
  setTimeout(function () { fb.textContent = ''; }, 2000);
}

function hasFunctions(obj) {
  if (!obj || typeof obj !== 'object') return false;
  for (var k in obj) {
    if (typeof obj[k] === 'function') return true;
    if (typeof obj[k] === 'object' && obj[k] !== null && hasFunctions(obj[k])) return true;
  }
  return false;
}

// ---- Add group / section ----
var _studioPendingType = null;
var _studioAddBtns = null;
var _studioAddInput = null;

function initStudioAddInput() {
  _studioAddBtns = ['add-layer-btn', 'add-group-btn', 'add-section-btn', 'upload-layer-btn'].map(function (id) {
    return document.getElementById(id);
  });
  _studioAddInput = document.getElementById('add-input');
  _studioAddInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      var name = _studioAddInput.value.trim();
      if (name && _studioPendingType) {
        var id = _studioPendingType + '-' + Date.now() + '-' + Math.random().toString(36).slice(2);
        layers.push({ id: id, type: _studioPendingType, label: name, open: true, children: [] });
        renderLayerList();
      }
      closeStudioAddInput();
    }
    if (e.key === 'Escape') closeStudioAddInput();
  });
}

function openStudioAddInput(type) {
  _studioPendingType = type;
  _studioAddBtns.forEach(function (b) { b.style.display = 'none'; });
  _studioAddInput.style.display = '';
  _studioAddInput.value = '';
  _studioAddInput.focus();
}

function closeStudioAddInput() {
  _studioAddInput.style.display = 'none';
  _studioAddBtns.forEach(function (b) { b.style.display = ''; });
  _studioPendingType = null;
}

// ---- Add layer ----
function openAddLayerForm() {
  document.getElementById('add-layer-bar').style.display  = 'none';
  document.getElementById('add-layer-form').style.display = '';
  document.getElementById('new-layer-label').value = '';
  document.getElementById('new-layer-label').focus();
}

function cancelAddLayer() {
  document.getElementById('add-layer-form').style.display = 'none';
  document.getElementById('add-layer-bar').style.display  = '';
}

function createLayer() {
  var label = document.getElementById('new-layer-label').value.trim();
  if (!label) { document.getElementById('new-layer-label').focus(); return; }
  var type = document.getElementById('new-layer-type').value;
  var id   = 'layer-' + Date.now();

  var newLayer;
  if (type === 'draw') {
    newLayer = {
      id:        id,
      name:      id,
      label:     label,
      iconColor: '#888888',
      type:      'draw',
      paint: {
        'fill-color':         '#888888',
        'fill-opacity':       0.5,
        'fill-outline-color': '#000000',
      },
      features: emptyFC(),
      _new: true,
    };
  } else {
    var paintDefaults = {
      line: { 'line-color': '#888888', 'line-width': 2, 'line-opacity': 1 },
      fill: { 'fill-color': '#888888', 'fill-opacity': 0.5, 'fill-outline-color': '#000000' },
    };
    newLayer = {
      id:             id,
      name:           id,
      label:          label,
      iconColor:      '#888888',
      type:           type,
      source:         { type: 'vector', url: '' },
      'source-layer': '',
      layout:         { visibility: 'visible' },
      paint:          paintDefaults[type] || {},
      checked:        true,
      _new:           true,
    };
  }

  layers.push(newLayer);
  cancelAddLayer();
  renderLayerList();
  selectLayer(id);
}

// ---- Util ----
function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

})();
