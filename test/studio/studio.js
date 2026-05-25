(function () {

// ---- State ----
var _map        = null;
var _mapReady   = false;
var _origLayer  = null;   // reference to original in layers[] (may have functions)
var _layer      = null;   // deep copy, functions stripped — this is what we edit
var _activeTab  = 'form';
var _PREV_SRC   = 'studio-src';
var _PREV_LYR   = 'studio-lyr';

// ---- Init ----
window.addEventListener('load', function () {
  initMap();
  renderLayerList();
  initTabs();
  document.getElementById('copy-btn').addEventListener('click', copyJS);
  document.getElementById('add-layer-btn').addEventListener('click', openAddLayerForm);
  document.getElementById('cancel-layer-btn').addEventListener('click', cancelAddLayer);
  document.getElementById('create-layer-btn').addEventListener('click', createLayer);
  document.getElementById('new-layer-label').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') createLayer();
    if (e.key === 'Escape') cancelAddLayer();
  });
});

// ---- Map preview ----
function initMap() {
  mapboxgl.accessToken = (typeof mapboxToken !== 'undefined') ? mapboxToken : restrictedToken;
  _map = new mapboxgl.Map({
    container:        'map-preview',
    style:            mapConfig.style,
    center:           mapConfig.center,
    zoom:             mapConfig.zoom,
    attributionControl: false,
    hash: true,
  });
  _map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), 'top-right');
  _map.on('load', function () { _mapReady = true; });
}

function loadOnMap(layer) {
  if (!_mapReady) { _map.once('load', function () { loadOnMap(layer); }); return; }
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
  if (!_map || !_layer || !_map.getLayer(_PREV_LYR)) return;
  Object.keys(_layer.paint || {}).forEach(function (p) {
    try { _map.setPaintProperty(_PREV_LYR, p, _layer.paint[p]); } catch (e) {}
  });
}

// ---- Layer list ----
function flattenLayers(arr) {
  var out = [];
  (arr || []).forEach(function (item) {
    if (item.type === 'group' || item.type === 'section') {
      out.push({ isGroup: true, label: item.label });
      (item.children || []).forEach(function (c) {
        if (c.id) out.push({ isGroup: false, layer: c });
      });
    } else if (item.id) {
      out.push({ isGroup: false, layer: item });
    }
  });
  return out;
}

function renderLayerList() {
  var flat = flattenLayers(layers);
  var html = '';
  flat.forEach(function (item) {
    if (item.isGroup) {
      html += '<div class="list-group">' + esc(item.label) + '</div>';
    } else {
      var l = item.layer;
      html += '<div class="list-layer' + (l._new ? ' is-new' : '') + '" data-id="' + esc(l.id) + '">' +
        '<span class="l-swatch" style="background:' + esc(l.iconColor || '#888') + '"></span>' +
        esc(l.label || l.id) + '</div>';
    }
  });
  document.getElementById('layer-list').innerHTML = html;
  document.querySelectorAll('.list-layer').forEach(function (el) {
    el.addEventListener('click', function () { selectLayer(this.dataset.id); });
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

// ---- Select ----
function selectLayer(id) {
  document.querySelectorAll('.list-layer').forEach(function (el) {
    el.classList.toggle('active', el.dataset.id === id);
  });
  _origLayer = findLayer(id);
  if (!_origLayer) return;
  _layer = JSON.parse(JSON.stringify(_origLayer)); // strip functions
  openEditor();
  loadOnMap(_origLayer);
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
  } else if (l.type === 'fill') {
    html += fSection('Style', [
      fRow('Fill Color',    fColor('f-fill-color',   paintVal(l, 'fill-color',         '#888888'))),
      fRow('Outline Color', fColor('f-fill-outline', paintVal(l, 'fill-outline-color', '#000000'))),
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
  } else if (l.type === 'fill') {
    if (!l.paint) l.paint = {};
    if ((el = document.getElementById('f-fill-color-txt')))   l.paint['fill-color']         = el.value;
    if ((el = document.getElementById('f-fill-outline-txt'))) l.paint['fill-outline-color']  = el.value;
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

  var paintDefaults = {
    line: { 'line-color': '#888888', 'line-width': 2, 'line-opacity': 1 },
    fill: { 'fill-color': '#888888', 'fill-opacity': 0.5, 'fill-outline-color': '#000000' },
  };

  var newLayer = {
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
