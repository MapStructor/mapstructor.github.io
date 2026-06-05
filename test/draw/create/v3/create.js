/*
  MERGE — MULTIPOLYGON BEHAVIOUR
  ─────────────────────────────────────────────────────────────────────────────
  turf.union returns a MultiPolygon when the source polygons don't touch or
  overlap. This means merging two non-adjacent polygons produces one draw
  feature with multiple separate rings — valid GeoJSON, but a single object.

  MultiPolygon is not supported. Merge is blocked if turf.union returns a
  MultiPolygon (i.e. the source polygons don't touch or overlap). Users get
  an error: "Polygons must touch or overlap to merge."

  If revisiting (e.g. for non-contiguous territories — countries with
  detached regions, island chains, exclaves):
    - Remove the MultiPolygon check in doMerge()
    - Add a "Separate Parts" function to split a MultiPolygon back into
      individual Polygon features (was implemented, then removed)
    - Ensure Split, Copy, export, and attribute handling all cope with
      MultiPolygon geometry

  DRAW BUTTON FEEDBACK (not implemented here — see Additional features/graying_version/)
  ─────────────────────────────────────────────────────────────────────────────
  An earlier version grayed out draw buttons when their geometry type was
  already claimed by an existing layer. That version is preserved in
  Additional features/graying_version/ for reference.

  If revisiting: making buttons fully unclickable (pointerEvents: none) is
  probably too heavy-handed. Softer options worth considering:
    - Outline/highlight the active layer's button type only (least intrusive)
    - Dim the other buttons (opacity) without disabling them
    - Change the icon color of unavailable buttons
    - Show a tooltip explaining why a type is "taken" and which layer owns it
*/
(function () {

  // ── Config ──────────────────────────────────────────────────────────────────
  var MAPBOX_TOKEN  = mapboxToken;
  var SUPABASE_URL  = 'https://padavlcmwidjnhxzkhyb.supabase.co';
  var SUPABASE_KEY  = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBhZGF2bGNtd2lkam5oeHpraHliIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY3NzMzODEsImV4cCI6MjA5MjM0OTM4MX0.me5DqJgtSHBHKnZowf2AFIWqof-oydvly40Aeo6wC9o';

  // Layer colours — cycle through these for new layers
  var LAYER_COLORS = ['#4a9eff','#ff6b4a','#4aff9e','#ff4adb','#ffe04a','#4af0ff','#ff9e4a'];

  // Basemaps — add entries here to extend the switcher
  var BASEMAPS = [
    { id: 'streets',   label: 'Streets',   style: 'mapbox://styles/mapbox/streets-v12' },
    { id: 'satellite', label: 'Satellite', style: 'mapbox://styles/mapbox/satellite-v9' },
    { id: 'hybrid',    label: 'Hybrid',    style: 'mapbox://styles/mapbox/satellite-streets-v12' },
    { id: 'outdoors',  label: 'Outdoors',  style: 'mapbox://styles/mapbox/outdoors-v12' },
    { id: 'light',     label: 'Light',     style: 'mapbox://styles/mapbox/light-v11' },
    { id: 'dark',      label: 'Dark',      style: 'mapbox://styles/mapbox/dark-v11' },
  ];

  // ── State ───────────────────────────────────────────────────────────────────
  var db          = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
  var map         = null;
  var draw        = null;
  var projectId   = null;
  var userId      = null;
  var layers      = [
    { id: 'section-reference', name: 'Reference', type: 'section', open: true, children: [
      { id: 'ts-curr-builds', name: 'Current Buildings', type: 'fill', visible: true, color: '#ffb255', featureIds: [],
        source: { type: 'vector', url: 'mapbox://nittyjee.du0aopr8' }, 'source-layer': 'buildings_ames_2026-9v0yur',
        paint: { 'fill-color': '#ffb255', 'fill-opacity': 0.7, 'fill-outline-color': '#ff6600' } },
      { id: 'ts-city-limits', name: 'City Limits', type: 'line', visible: true, color: '#00c610', featureIds: [],
        source: { type: 'vector', url: 'mapbox://nittyjee.41zrmwvc' }, 'source-layer': 'city_limits_lines_2026-a8hdoi',
        paint: { 'line-color': '#00c610', 'line-width': 3, 'line-opacity': 1 } },
      { id: 'ts-conf-roads', name: 'Confirmed Roads', type: 'line', visible: true, color: '#A9A9A9', featureIds: [],
        source: { type: 'vector', url: 'mapbox://nittyjee.5u39kagk' }, 'source-layer': 'roads_maps_ames_iowa-4rufgk',
        paint: { 'line-color': '#A9A9A9', 'line-width': 2, 'line-opacity': 1 } },
    ]},
  ];
  var features    = {};   // { drawId: { label, notes, layerId } }
  var activeLayerId = null;
  var selectedDrawId = null;
  var hoveredDrawId  = null;

  var clipboard         = null;
  var measureMode       = false;
  var measureType       = 'distance';  // 'distance' | 'area'
  var measurePoints     = [];
  var measureDone       = false;
  var splitMode         = false;
  var splitTarget       = null;
  var _suppressUndo     = false;
  var _selectedSnapshot = {};
  var undoStack         = [];
  var redoStack         = [];
  var dragId         = null;
  var insertBeforeId = null;
  var dropIntoId     = null;
  var drawLayerIds         = [];
  var _mapEventsRegistered = false;
  var attrExpanded         = false;

  // ── Style panel state ──────────────────────────────────────────────────────
  var _DRAW_SRC    = 'draw-src';
  var _DRAW_FILL   = 'draw-fill';
  var _DRAW_LINE   = 'draw-line';
  var _DRAW_CIRCLE = 'draw-circle';
  var _origLayer = null;
  var _layer     = null;
  var _activeTab = 'form';

  // ── Debug logger ─────────────────────────────────────────────────────────────
  var _dbgLines = [];
  function dbg(msg, type) {
    var ts  = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    var txt = ts + '  ' + msg;
    console.log(txt);
    _dbgLines.push({ txt: txt, type: type || '' });
    if (_dbgLines.length > 200) _dbgLines.shift();
    var log = document.getElementById('dbg-log');
    if (!log) return;
    var line = document.createElement('div');
    line.className = 'dbg-line' + (type ? ' dbg-' + type : '');
    line.textContent = txt;
    log.appendChild(line);
    log.scrollTop = log.scrollHeight;
  }

  document.addEventListener('DOMContentLoaded', function () {
    document.getElementById('dbg-copy').addEventListener('click', function () {
      var text = _dbgLines.map(function (l) { return l.txt; }).join('\n');
      navigator.clipboard.writeText(text).then(function () {
        var btn = document.getElementById('dbg-copy');
        btn.textContent = 'Copied!';
        setTimeout(function () { btn.textContent = 'Copy'; }, 1500);
      });
    });
    document.getElementById('dbg-clear').addEventListener('click', function () {
      _dbgLines = [];
      document.getElementById('dbg-log').innerHTML = '';
    });
    document.getElementById('dbg-toggle').addEventListener('click', function () {
      var panel = document.getElementById('dbg-panel');
      var collapsed = panel.classList.toggle('collapsed');
      this.textContent = collapsed ? '▸' : '▾';
    });
  });

  function fmt(n, dec) {
    return n.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
  }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function flatLayers(arr) {
    var out = [];
    (arr || layers).forEach(function (item) {
      if (item.type === 'group' || item.type === 'section') {
        flatLayers(item.children || []).forEach(function (c) { out.push(c); });
      } else {
        out.push(item);
      }
    });
    return out;
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
    if (from.item.type === 'section' && to.parentType !== null) { from.arr.splice(from.idx, 0, from.item); return; }
    if (from.item.type === 'group' && to.parentType === 'group') { from.arr.splice(from.idx, 0, from.item); return; }
    to.arr.splice(to.idx, 0, from.item);
  }

  // ── Tileset helpers ──────────────────────────────────────────────────────────
  function isTileset(l) { return l && (l.type === 'fill' || l.type === 'line'); }

  function addTilesetToMap(layer) {
    if (!map) return;
    var srcId = 'ext-' + layer.id;
    if (map.getSource(srcId)) return;
    var url  = layer.source && layer.source.url;
    var tile = layer.source && layer.source.tiles && layer.source.tiles[0];
    if (!url && !tile) return;
    // Sit below draw display but above basemap
    var beforeId = map.getLayer('hover-highlight-line') ? 'hover-highlight-line'
                 : (function () { var fd = map.getStyle().layers.find(function (l) { return l.id.indexOf('gl-draw') > -1; }); return fd ? fd.id : undefined; }());
    var vis = layer.visible !== false ? 'visible' : 'none';
    try {
      map.addSource(srcId, layer.source);
      var p = layer.paint || {};
      if (layer.type === 'fill') {
        map.addLayer({ id: srcId + '-fill', type: 'fill', source: srcId,
          'source-layer': layer['source-layer'] || '', layout: { visibility: vis },
          paint: { 'fill-color': p['fill-color'] || '#888888',
                   'fill-opacity': p['fill-opacity'] !== undefined ? p['fill-opacity'] : 0.5,
                   'fill-outline-color': p['fill-outline-color'] || '#000000' }
        }, beforeId);
      } else {
        map.addLayer({ id: srcId + '-line', type: 'line', source: srcId,
          'source-layer': layer['source-layer'] || '',
          layout: { 'line-cap': 'round', 'line-join': 'round', visibility: vis },
          paint: { 'line-color': p['line-color'] || '#888888',
                   'line-opacity': p['line-opacity'] !== undefined ? p['line-opacity'] : 1,
                   'line-width': p['line-width'] !== undefined ? p['line-width'] : 2 }
        }, beforeId);
      }
    } catch (e) { console.warn('[tileset]', e.message); }
  }

  function removeTilesetFromMap(layerId) {
    if (!map) return;
    var srcId = 'ext-' + layerId;
    if (map.getLayer(srcId + '-fill')) map.removeLayer(srcId + '-fill');
    if (map.getLayer(srcId + '-line')) map.removeLayer(srcId + '-line');
    if (map.getSource(srcId))          map.removeSource(srcId);
  }

  function syncTilesetLayers() {
    flatLayers().forEach(function (l) { if (isTileset(l)) addTilesetToMap(l); });
  }

  function liveUpdateTileset() {
    if (!_layer || !map) return;
    var l = _layer;
    var srcId = 'ext-' + l.id;
    var p = l.paint || {};
    if (l.type === 'fill' && map.getLayer(srcId + '-fill')) {
      try { map.setPaintProperty(srcId + '-fill', 'fill-color',         p['fill-color']         || '#888888'); } catch (e) {}
      try { map.setPaintProperty(srcId + '-fill', 'fill-opacity',       p['fill-opacity']        !== undefined ? p['fill-opacity'] : 0.5); } catch (e) {}
      try { map.setPaintProperty(srcId + '-fill', 'fill-outline-color', p['fill-outline-color']  || '#000000'); } catch (e) {}
    }
    if (l.type === 'line' && map.getLayer(srcId + '-line')) {
      try { map.setPaintProperty(srcId + '-line', 'line-color',   p['line-color']   || '#888888'); } catch (e) {}
      try { map.setPaintProperty(srcId + '-line', 'line-opacity', p['line-opacity'] !== undefined ? p['line-opacity'] : 1); } catch (e) {}
      try { map.setPaintProperty(srcId + '-line', 'line-width',   p['line-width']   !== undefined ? p['line-width']   : 2); } catch (e) {}
    }
  }

  // ── Init ────────────────────────────────────────────────────────────────────
  mapboxgl.accessToken = MAPBOX_TOKEN;

  map = new mapboxgl.Map({
    container: 'map',
    style: 'mapbox://styles/mapbox/streets-v12',
    zoom: 3,
    center: [-96, 38],
    hash: true
  });

  map.addControl(new mapboxgl.NavigationControl(), 'top-right');

  var DRAW_STYLES = [
    { id: 'draw-active-stroke', type: 'line',
      filter: ['all', ['in', '$type', 'LineString', 'Polygon'], ['==', 'active', 'true']],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#fff', 'line-width': 2, 'line-dasharray': [2, 2] }
    },
    { id: 'draw-vertex', type: 'circle',
      filter: ['all', ['==', '$type', 'Point'], ['==', 'meta', 'vertex']],
      paint: { 'circle-radius': 4, 'circle-color': '#fff', 'circle-stroke-width': 2, 'circle-stroke-color': '#888' }
    },
    { id: 'draw-midpoint', type: 'circle',
      filter: ['all', ['==', '$type', 'Point'], ['==', 'meta', 'midpoint']],
      paint: { 'circle-radius': 3, 'circle-color': '#fbb03b' }
    },
  ];

  draw = new MapboxDraw({
    displayControlsDefault: false,
    controls: { polygon: true, line_string: true, point: true, trash: true },
    styles: DRAW_STYLES
  });
  map.addControl(draw, 'top-left');
  map.on('style.load', function () {
    // Re-add custom sources and layers after every style change
    map.addSource('hover-highlight', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] }
    });
    var firstDrawLayer = map.getStyle().layers.find(function (l) { return l.id.indexOf('gl-draw') > -1; });
    var beforeId = firstDrawLayer ? firstDrawLayer.id : undefined;

    map.addLayer({ id: 'hover-highlight-line', type: 'line', source: 'hover-highlight',
      filter: ['in', '$type', 'LineString', 'Polygon'],
      paint: { 'line-color': '#fff', 'line-width': 16, 'line-opacity': 1, 'line-blur': 0 }
    }, beforeId);
    map.addLayer({ id: 'hover-highlight-point', type: 'circle', source: 'hover-highlight',
      filter: ['==', '$type', 'Point'],
      paint: { 'circle-color': '#fff', 'circle-radius': 16, 'circle-opacity': 1, 'circle-blur': 0 }
    }, beforeId);

    drawLayerIds = map.getStyle().layers
      .filter(function (l) { return l.id.indexOf('gl-draw') > -1; })
      .map(function (l) { return l.id; });

    // ── Draw display layers (before handles so handles render on top) ─────────
    map.addSource(_DRAW_SRC, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({ id: _DRAW_FILL, type: 'fill', source: _DRAW_SRC,
      filter: ['==', '$type', 'Polygon'],
      paint: {
        'fill-color':   ['coalesce', ['get', '_c'], '#888888'],
        'fill-opacity': ['coalesce', ['get', '_a'], 0.5]
      }
    }, beforeId);
    map.addLayer({ id: _DRAW_LINE, type: 'line', source: _DRAW_SRC,
      filter: ['in', '$type', 'LineString', 'Polygon'],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': ['coalesce', ['get', '_o'], '#000000'],
        'line-width': 2
      }
    }, beforeId);
    map.addLayer({ id: _DRAW_CIRCLE, type: 'circle', source: _DRAW_SRC,
      filter: ['==', '$type', 'Point'],
      paint: {
        'circle-color':        ['coalesce', ['get', '_c'], '#888888'],
        'circle-radius':       6,
        'circle-opacity':      ['coalesce', ['get', '_a'], 0.8],
        'circle-stroke-color': ['coalesce', ['get', '_o'], '#000000'],
        'circle-stroke-width': 2
      }
    }, beforeId);
    syncDrawDisplay();
    if (!new URLSearchParams(location.search).get('id')) syncTilesetLayers();

    // ── Measure overlay ──────────────────────────────────────────────────────
    map.addSource('measure-source', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] }
    });
    map.addLayer({ id: 'measure-fill', type: 'fill', source: 'measure-source',
      filter: ['==', '$type', 'Polygon'],
      paint: { 'fill-color': '#ffcc00', 'fill-opacity': 0.15 }
    });
    map.addLayer({ id: 'measure-line', type: 'line', source: 'measure-source',
      filter: ['in', '$type', 'LineString', 'Polygon'],
      paint: { 'line-color': '#ffcc00', 'line-width': 2, 'line-dasharray': [4, 3] }
    });
    map.addLayer({ id: 'measure-points', type: 'circle', source: 'measure-source',
      filter: ['==', '$type', 'Point'],
      paint: { 'circle-radius': 5, 'circle-color': '#ffcc00', 'circle-stroke-width': 2, 'circle-stroke-color': '#1a1a1a' }
    });

    if (!_mapEventsRegistered) {
      _mapEventsRegistered = true;

      map.on('click', function (e) {
        if (!measureMode || measureDone) return;
        measurePoints.push([e.lngLat.lng, e.lngLat.lat]);
        refreshMeasureSource(null);
        updateMeasureDisplay(null);
      });

      map.on('dblclick', function (e) {
        if (!measureMode || measureDone) return;
        e.preventDefault();
        if (measurePoints.length > 0) measurePoints.pop();
        measureDone = true;
        refreshMeasureSource(null);
        updateMeasureDisplay(null);
      });

      map.on('mousemove', function (e) {
        if (measureMode && !measureDone && measurePoints.length > 0) {
          refreshMeasureSource([e.lngLat.lng, e.lngLat.lat]);
          updateMeasureDisplay([e.lngLat.lng, e.lngLat.lat]);
        }
      });

      map.on('mousemove', function (e) {
        var hoverLayers = [_DRAW_FILL, _DRAW_LINE, _DRAW_CIRCLE].filter(function (id) { return !!map.getLayer(id); });
        var rendered = hoverLayers.length ? map.queryRenderedFeatures(e.point, { layers: hoverLayers }) : [];
        var fid = rendered.length ? (rendered[0].properties && rendered[0].properties._id) || rendered[0].id || null : null;
        dbg('hover rendered=' + rendered.length + ' fid=' + fid, 'feat');
        if (fid === hoveredDrawId) return;
        hoveredDrawId = fid;
        updateSidebarHover();
        if (fid && features[fid]) {
          var feat = draw.get(fid);
          if (feat) map.getSource('hover-highlight').setData({ type: 'FeatureCollection', features: [feat] });
        } else {
          map.getSource('hover-highlight').setData({ type: 'FeatureCollection', features: [] });
        }
      });

      map.getCanvas().addEventListener('mouseleave', function () {
        hoveredDrawId = null;
        updateSidebarHover();
        map.getSource('hover-highlight').setData({ type: 'FeatureCollection', features: [] });
      });

      map.on('draw.update', syncDrawDisplay);
    }
  });

  // Anonymous sign-in — no friction
  db.auth.getSession().then(function (res) {
    if (res.data.session) {
      userId = res.data.session.user.id;
    } else {
      db.auth.signInAnonymously().then(function (res2) {
        if (res2.data.session) userId = res2.data.session.user.id;
      });
    }
    afterAuth();
  });

  function afterAuth() {
    var urlId = new URLSearchParams(location.search).get('id');
    if (urlId) {
      loadProject(urlId);
    } else {
      autoCreateProject();
    }
  }

  async function autoCreateProject() {
    var result = await db.from('map_projects_testing').insert({
      user_id: userId,
      name: 'Untitled Map',
      layers_data: layers,
      features_data: []
    }).select().single();
    if (result.error) { showToast('Could not initialize project'); return; }
    projectId = result.data.id;
    var url = new URL(location.href);
    url.searchParams.set('id', projectId);
    history.replaceState(null, '', url);
  }

  // ── Draw events ─────────────────────────────────────────────────────────────
  map.on('draw.create', function (e) {
    var feature = e.features[0];

    if (splitMode && feature.geometry.type === 'LineString') {
      doSplit(feature);
      return;
    }

    if (_suppressUndo) { updateToolbar(); return; }

    var geomType = feature.geometry.type;
    var activeLayer = findLayer(activeLayerId);
    var typeLayer;

    if (activeLayer && activeLayer.type === null) {
      activeLayer.type = geomType;
      typeLayer = activeLayer;
    } else if (activeLayer && activeLayer.type === geomType) {
      typeLayer = activeLayer;
    } else {
      typeLayer = flatLayers().find(function (l) { return l.type === geomType; });
      if (!typeLayer) {
        typeLayer = createLayer(geomType);
      } else {
        draw.delete(feature.id);
        showToast('Select the correct layer in the sidebar first', true);
        return;
      }
    }

    var id      = feature.id;
    var geom    = JSON.parse(JSON.stringify(feature.geometry));
    var layerId = typeLayer.id;

    features[id] = { label: '', notes: '', layerId: layerId };
    typeLayer.featureIds.push(id);
    renderLayerList();
    openFeaturePanel(id);
    scheduleSave();

    pushUndo(
      function () {
        _suppressUndo = true;
        draw.delete([id]);
        removeFeatureFromState(id);
        renderLayerList();
        scheduleSave();
        _suppressUndo = false;
      },
      function () {
        _suppressUndo = true;
        draw.add({ type: 'Feature', id: id, geometry: JSON.parse(JSON.stringify(geom)), properties: {} });
        var layer = findLayer(layerId);
        if (layer && layer.featureIds.indexOf(id) === -1) {
          features[id] = { label: '', notes: '', layerId: layerId };
          layer.featureIds.push(id);
        }
        renderLayerList();
        scheduleSave();
        _suppressUndo = false;
      }
    );
  });

  map.on('draw.update', function (e) {
    if (_suppressUndo) return;
    e.features.forEach(function (f) {
      var id       = f.id;
      var prevGeom = _selectedSnapshot[id];
      var newGeom  = JSON.parse(JSON.stringify(f.geometry));
      if (!prevGeom) return;
      var pg = JSON.parse(JSON.stringify(prevGeom));
      pushUndo(
        function () { _suppressUndo = true; _setGeometry(id, pg);      _suppressUndo = false; },
        function () { _suppressUndo = true; _setGeometry(id, newGeom); _suppressUndo = false; }
      );
      _selectedSnapshot[id] = newGeom;
    });
    scheduleSave();
    updateToolbar();
  });

  map.on('draw.delete', function (e) {
    if (_suppressUndo) return;
    var deleted = e.features.map(function (f) {
      return {
        id:   f.id,
        geom: JSON.parse(JSON.stringify(f.geometry)),
        meta: JSON.parse(JSON.stringify(features[f.id] || {}))
      };
    });
    deleted.forEach(function (d) { removeFeatureFromState(d.id); });
    closeFeaturePanel();
    renderLayerList();
    scheduleSave();

    pushUndo(
      function () {
        _suppressUndo = true;
        deleted.forEach(function (d) {
          draw.add({ type: 'Feature', id: d.id, geometry: JSON.parse(JSON.stringify(d.geom)), properties: {} });
          features[d.id] = d.meta;
          var layer = findLayer(d.meta.layerId);
          if (layer && layer.featureIds.indexOf(d.id) === -1) layer.featureIds.push(d.id);
        });
        renderLayerList();
        scheduleSave();
        _suppressUndo = false;
      },
      function () {
        _suppressUndo = true;
        deleted.forEach(function (d) {
          draw.delete([d.id]);
          removeFeatureFromState(d.id);
        });
        renderLayerList();
        scheduleSave();
        _suppressUndo = false;
      }
    );
    updateToolbar();
  });

  map.on('draw.selectionchange', function (e) {
    if (!_suppressUndo) {
      _selectedSnapshot = {};
      e.features.forEach(function (f) {
        _selectedSnapshot[f.id] = JSON.parse(JSON.stringify(f.geometry));
      });
    }
    if (e.features.length === 0) {
      closeFeaturePanel();
    } else {
      openFeaturePanel(e.features[0].id);
    }
    updateToolbar();
  });

  // ── Layer management ────────────────────────────────────────────────────────
  function createLayer(type, name) {
    var color = LAYER_COLORS[flatLayers().length % LAYER_COLORS.length];
    var names = { Polygon: 'Polygons', LineString: 'Lines', Point: 'Points' };
    var layer = {
      id: 'layer-' + Date.now() + '-' + Math.random().toString(36).slice(2),
      name: name || (type ? (names[type] || type) : 'New Layer'),
      type: type || null,
      color: color,
      visible: true,
      featureIds: [],
      paint: {
        'fill-color':         color,
        'fill-outline-color': '#000000',
        'fill-opacity':       0.5
      }
    };
    layers.push(layer);
    activeLayerId = layer.id;
    renderLayerList();
    return layer;
  }

  function setActiveLayer(id) {
    activeLayerId = id;
    _origLayer = findLayer(id);
    _layer = _origLayer;
    openEditor();
    liveUpdateDraw();
    if (_layer && isTileset(_layer)) { removeTilesetFromMap(id); addTilesetToMap(_layer); }
    renderLayerList();
  }

  function updateSidebarHover() {
    document.querySelectorAll('.feature-item').forEach(function (el) {
      el.classList.toggle('hover', el.dataset.id === hoveredDrawId);
    });
    updateAttrTableHover();
  }

  function updateAttrTableHover() {
    document.querySelectorAll('#attr-table tbody tr').forEach(function (tr) {
      tr.classList.toggle('hover', tr.dataset.id === hoveredDrawId);
    });
  }

  function removeFeatureFromState(drawId) {
    var meta = features[drawId];
    if (!meta) return;
    var layer = findLayer(meta.layerId);
    if (layer) {
      layer.featureIds = layer.featureIds.filter(function (fid) { return fid !== drawId; });
    }
    delete features[drawId];
  }

  // ── Sidebar rendering ────────────────────────────────────────────────────────
  function buildLayerHTML(arr, depth) {
    var html = '';
    var indent = 8 + depth * 16;
    (arr || []).forEach(function (item) {
      var isContainer = item.type === 'group' || item.type === 'section';
      if (isContainer) {
        var isOpen = item.open !== false;
        html += '<div class="container-item ' + item.type + '" data-id="' + esc(item.id) + '"'
              + ' style="padding-left:' + indent + 'px" draggable="true">'
              + '<span class="toggle">' + (isOpen ? '▾' : '▸') + '</span>'
              + ' <span class="container-name">' + esc(item.name) + '</span>'
              + ((!item.children || item.children.length === 0) ? '<span class="delete-btn">&#x2715;</span>' : '')
              + '</div>';
        if (isOpen && item.children && item.children.length) {
          html += buildLayerHTML(item.children, depth + 1);
        }
      } else {
        var svgIcons = {
          Point:      '<circle cx="8" cy="8" r="5" fill="CLR"/>',
          LineString: '<line x1="2" y1="14" x2="14" y2="2" stroke="CLR" stroke-width="2.5" stroke-linecap="round"/>',
          Polygon:    '<polygon points="8,2 14,6 12,13 4,13 2,6" fill="none" stroke="CLR" stroke-width="2" stroke-linejoin="round"/>',
          fill:       '<rect x="3" y="3" width="10" height="10" rx="1" fill="CLR" opacity="0.85"/>',
          line:       '<line x1="2" y1="13" x2="14" y2="3" stroke="CLR" stroke-width="2.5" stroke-linecap="round"/>'
        };
        var iconSvg = svgIcons[item.type] || '<rect x="3" y="3" width="10" height="10" rx="2" fill="CLR"/>';
        var svgStr  = '<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">'
                    + iconSvg.replace(/CLR/g, item.color || '#888') + '</svg>';
        html += '<div class="layer-item' + (item.id === activeLayerId ? ' active' : '') + '"'
              + ' data-id="' + esc(item.id) + '" style="padding-left:' + indent + 'px" draggable="true">'
              + '<input type="checkbox" class="layer-visibility"' + (item.visible ? ' checked' : '') + ' title="Toggle visibility"/>'
              + '<div class="layer-swatch">' + svgStr + '</div>'
              + '<span class="layer-name" title="Double-click to rename">' + esc(item.name) + '</span>'
              + '</div>';
        (item.featureIds || []).forEach(function (fid) {
          var meta = features[fid];
          if (!meta) return;
          var cls = 'feature-item' + (fid === selectedDrawId ? ' active' : '') + (fid === hoveredDrawId ? ' hover' : '');
          html += '<div class="' + cls + '" data-id="' + fid + '"'
                + ' style="padding-left:' + (indent + 20) + 'px">'
                + '<span class="feature-item-label">' + esc(meta.label || ('Untitled ' + (item.type || 'Feature'))) + '</span>'
                + '</div>';
        });
      }
    });
    return html;
  }

  function attachLayerListeners() {
    var el = document.getElementById('layer-list');

    el.querySelectorAll('[draggable]').forEach(function (div) {
      div.addEventListener('dragstart', function (e) {
        dragId = div.dataset.id;
        e.dataTransfer.effectAllowed = 'move';
        setTimeout(function () { div.classList.add('dragging'); }, 0);
      });
      div.addEventListener('dragend', function () {
        div.classList.remove('dragging');
        dragId = null;
        clearDragIndicator();
      });
    });

    el.querySelectorAll('.container-item').forEach(function (div) {
      var id = div.dataset.id;

      var toggle = div.querySelector('.toggle');
      if (toggle) {
        toggle.addEventListener('click', function (e) {
          e.stopPropagation();
          var found = findItem(id);
          if (found) found.item.open = found.item.open === false;
          renderLayerList();
        });
      }

      var del = div.querySelector('.delete-btn');
      if (del) {
        del.addEventListener('click', function (e) {
          e.stopPropagation();
          var found = findItem(id);
          if (found) found.arr.splice(found.idx, 1);
          renderLayerList();
          scheduleSave();
        });
      }

      var nameEl = div.querySelector('.container-name');
      if (nameEl) {
        nameEl.addEventListener('dblclick', function (e) {
          e.stopPropagation();
          nameEl.contentEditable = 'true';
          nameEl.focus();
          var range = document.createRange();
          range.selectNodeContents(nameEl);
          window.getSelection().removeAllRanges();
          window.getSelection().addRange(range);
        });
        nameEl.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') { e.preventDefault(); nameEl.blur(); }
          if (e.key === 'Escape') {
            var found = findItem(id);
            if (found) nameEl.textContent = found.item.name;
            nameEl.blur();
          }
        });
        nameEl.addEventListener('blur', function () {
          nameEl.contentEditable = 'false';
          var found = findItem(id);
          if (found) {
            var newName = nameEl.textContent.trim();
            if (newName && newName !== found.item.name) { found.item.name = newName; scheduleSave(); }
            else nameEl.textContent = found.item.name;
          }
        });
      }
    });

    el.querySelectorAll('.layer-item').forEach(function (div) {
      var id = div.dataset.id;

      var cb = div.querySelector('.layer-visibility');
      cb.addEventListener('click', function (e) {
        e.stopPropagation();
        dbg('checkbox click id=' + id + ' checked=' + e.target.checked, 'vis');
      });
      cb.addEventListener('change', function () {
        dbg('checkbox change id=' + id + ' visible=' + this.checked, 'vis');
        toggleLayerVisibility(id, this.checked);
      });

      var nameEl = div.querySelector('.layer-name');
      nameEl.addEventListener('dblclick', function (e) {
        e.stopPropagation();
        nameEl.contentEditable = 'true';
        nameEl.focus();
        var range = document.createRange();
        range.selectNodeContents(nameEl);
        window.getSelection().removeAllRanges();
        window.getSelection().addRange(range);
      });
      nameEl.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); nameEl.blur(); }
        if (e.key === 'Escape') {
          var layer = findLayer(id);
          if (layer) nameEl.textContent = layer.name;
          nameEl.blur();
        }
      });
      nameEl.addEventListener('blur', function () {
        nameEl.contentEditable = 'false';
        var layer = findLayer(id);
        if (layer) {
          var newName = nameEl.textContent.trim();
          if (newName && newName !== layer.name) { layer.name = newName; scheduleSave(); }
          else nameEl.textContent = layer.name;
        }
      });

      div.addEventListener('click', function () {
        dbg('layer click id=' + id, 'click');
        if (id !== activeLayerId) setActiveLayer(id);
      });
    });

    el.querySelectorAll('.feature-item').forEach(function (fDiv) {
      var fid = fDiv.dataset.id;
      fDiv.addEventListener('click', function (e) {
        e.stopPropagation();
        dbg('feature click fid=' + fid, 'feat');
        var meta = features[fid];
        if (meta) setActiveLayer(meta.layerId);
        draw.changeMode('simple_select', { featureIds: [fid] });
        openFeaturePanel(fid);
        var feat = draw.get(fid);
        if (feat) {
          if (feat.geometry.type === 'Point') {
            map.flyTo({ center: feat.geometry.coordinates, zoom: Math.max(map.getZoom(), 14), duration: 600 });
          } else {
            var bbox = turf.bbox(feat);
            map.fitBounds([[bbox[0], bbox[1]], [bbox[2], bbox[3]]], { padding: 80, duration: 600 });
          }
        }
      });
      fDiv.addEventListener('mouseenter', function () {
        var feat = draw.get(fid);
        if (feat && map.getSource('hover-highlight')) {
          map.getSource('hover-highlight').setData({ type: 'FeatureCollection', features: [feat] });
        }
      });
      fDiv.addEventListener('mouseleave', function () {
        if (map.getSource('hover-highlight')) {
          map.getSource('hover-highlight').setData({ type: 'FeatureCollection', features: [] });
        }
      });
    });
  }

  function renderLayerList() {
    var el = document.getElementById('layer-list');
    el.innerHTML = buildLayerHTML(layers, 0);
    attachLayerListeners();
    renderAttrTable();
    syncDrawDisplay();
  }

  function renderAttrTable() {
    var panel = document.getElementById('attr-panel');
    if (panel.classList.contains('hidden')) return;

    var layer = findLayer(activeLayerId);
    document.getElementById('attr-panel-layer-name').textContent = layer ? layer.name : '';

    var table = document.getElementById('attr-table');
    table.innerHTML = '';

    if (!layer) return;

    var thead = document.createElement('thead');
    var hrow  = document.createElement('tr');
    var cols  = ['Label'].concat(attrExpanded ? ['Type', 'Notes'] : []);
    cols.forEach(function (col) {
      var th = document.createElement('th');
      th.textContent = col;
      hrow.appendChild(th);
    });
    thead.appendChild(hrow);
    table.appendChild(thead);

    var tbody = document.createElement('tbody');
    (layer.featureIds || []).forEach(function (fid) {
      var meta = features[fid];
      if (!meta) return;

      var tr = document.createElement('tr');
      tr.dataset.id = fid;
      if (fid === selectedDrawId) tr.classList.add('active');

      var tdLabel = document.createElement('td');
      tdLabel.textContent = meta.label || ('Untitled ' + (layer.type || 'Feature'));
      tr.appendChild(tdLabel);

      if (attrExpanded) {
        var feat    = draw.get(fid);
        var tdType  = document.createElement('td');
        tdType.textContent = feat ? feat.geometry.type : (layer.type || '');
        var tdNotes = document.createElement('td');
        tdNotes.textContent = meta.notes || '';
        tr.appendChild(tdType);
        tr.appendChild(tdNotes);
      }

      tr.addEventListener('click', function () {
        draw.changeMode('simple_select', { featureIds: [fid] });
        openFeaturePanel(fid);
        var feat = draw.get(fid);
        if (feat) {
          if (feat.geometry.type === 'Point') {
            map.flyTo({ center: feat.geometry.coordinates, zoom: Math.max(map.getZoom(), 14), duration: 600 });
          } else {
            var bbox = turf.bbox(feat);
            map.fitBounds([[bbox[0], bbox[1]], [bbox[2], bbox[3]]], { padding: 80, duration: 600 });
          }
        }
      });

      tr.addEventListener('mouseenter', function () {
        hoveredDrawId = fid;
        updateSidebarHover();
        var feat = draw.get(fid);
        if (feat && map.getSource('hover-highlight')) {
          map.getSource('hover-highlight').setData({ type: 'FeatureCollection', features: [feat] });
        }
      });

      tr.addEventListener('mouseleave', function () {
        hoveredDrawId = null;
        updateSidebarHover();
        if (map.getSource('hover-highlight')) {
          map.getSource('hover-highlight').setData({ type: 'FeatureCollection', features: [] });
        }
      });

      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
  }

  function toggleLayerVisibility(layerId, visible) {
    var layer = findLayer(layerId);
    if (!layer) return;
    layer.visible = visible;
    dbg('toggleLayerVisibility id=' + layerId + ' visible=' + visible + ' isTileset=' + isTileset(layer), 'vis');
    if (isTileset(layer)) {
      var srcId = 'ext-' + layerId;
      var vis = visible ? 'visible' : 'none';
      if (map.getLayer(srcId + '-fill')) map.setLayoutProperty(srcId + '-fill', 'visibility', vis);
      if (map.getLayer(srcId + '-line')) map.setLayoutProperty(srcId + '-line', 'visibility', vis);
      dbg('  tileset map layers updated vis=' + vis, 'vis');
    } else {
      syncDrawDisplay();
      dbg('  draw layer syncDrawDisplay called featureIds=' + JSON.stringify(layer.featureIds), 'vis');
    }
    scheduleSave();
  }

  // ── Feature panel ────────────────────────────────────────────────────────────
  function openFeaturePanel(drawId) {
    selectedDrawId = drawId;
    var meta = features[drawId];
    if (!meta) return;
    var layer = findLayer(meta.layerId);

    document.getElementById('feature-panel-layer-name').textContent = layer ? layer.name : '';
    document.getElementById('feature-label').value = meta.label || '';
    document.getElementById('feature-notes').value = meta.notes || '';
    document.getElementById('feature-panel').classList.remove('hidden');
    updateMeasurements(drawId);
    renderLayerList();
  }

  function closeFeaturePanel() {
    selectedDrawId = null;
    document.getElementById('feature-panel').classList.add('hidden');
    document.getElementById('feature-measurements').innerHTML = '';
    renderLayerList();
  }

  function updateMeasurements(drawId) {
    var el   = document.getElementById('feature-measurements');
    var feat = draw.get(drawId);
    if (!feat) { el.innerHTML = ''; return; }

    var rows = [];
    var type = feat.geometry.type;

    if (type === 'Polygon') {
      var sqm     = turf.area(feat);
      var ha      = sqm / 10000;
      var acre    = sqm / 4046.856;
      var km2     = sqm / 1e6;
      var perimKm = turf.length(turf.polygonToLine(feat), { units: 'kilometers' });
      var perimMi = perimKm * 0.621371;
      var perimM  = perimKm * 1000;
      var perimFt = perimM * 3.28084;

      rows.push(['Area',      ha >= 100 ? fmt(km2, 2) + ' km²' : fmt(ha, 2) + ' ha']);
      rows.push(['',          fmt(acre, 1) + ' acres']);
      rows.push(['Perimeter', fmt(perimKm, 2) + ' km / ' + fmt(perimMi, 2) + ' mi']);
      rows.push(['',          fmt(perimM, 0) + ' m / ' + fmt(perimFt, 0) + ' ft']);

    } else if (type === 'LineString') {
      var km = turf.length(feat, { units: 'kilometers' });
      var mi = km * 0.621371;
      var m  = km * 1000;
      var ft = m * 3.28084;

      rows.push(['Length', fmt(km, 3) + ' km / ' + fmt(mi, 3) + ' mi']);
      rows.push(['',       fmt(m, 0)  + ' m / '  + fmt(ft, 0) + ' ft']);

    } else if (type === 'Point') {
      var c = feat.geometry.coordinates;
      rows.push(['Lon', fmt(c[0], 5)]);
      rows.push(['Lat', fmt(c[1], 5)]);
    }

    el.innerHTML = rows.map(function (r) {
      return '<div class="measurement-row">' +
        '<span class="measurement-label">' + r[0] + '</span>' +
        '<span class="measurement-value">' + r[1] + '</span>' +
        '</div>';
    }).join('');
  }

  document.getElementById('feature-panel-close').addEventListener('click', function () {
    draw.changeMode('simple_select');
    closeFeaturePanel();
  });

  document.getElementById('feature-label').addEventListener('input', function () {
    if (!selectedDrawId || !features[selectedDrawId]) return;
    features[selectedDrawId].label = this.value;
    scheduleSave();
  });

  document.getElementById('feature-notes').addEventListener('input', function () {
    if (!selectedDrawId || !features[selectedDrawId]) return;
    features[selectedDrawId].notes = this.value;
    scheduleSave();
  });

  document.getElementById('delete-feature-btn').addEventListener('click', function () {
    if (!selectedDrawId) return;
    draw.delete(selectedDrawId);
    removeFeatureFromState(selectedDrawId);
    closeFeaturePanel();
    renderLayerList();
  });

  // ── Add Layer / Group / Section ───────────────────────────────────────────────
  var _pendingAddType = null;
  var _addBtns = ['add-layer-btn', 'add-group-btn', 'add-section-btn', 'add-tileset-btn'].map(function (id) {
    return document.getElementById(id);
  });
  var _addInput = document.getElementById('add-input');

  function openAddInput(type) {
    _pendingAddType = type;
    _addBtns.forEach(function (b) { b.style.display = 'none'; });
    _addInput.style.display = '';
    _addInput.value = '';
    _addInput.focus();
  }

  function closeAddInput() {
    _addInput.style.display = 'none';
    _addBtns.forEach(function (b) { b.style.display = ''; });
    _pendingAddType = null;
  }

  _addInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      var name = _addInput.value.trim();
      if (name && _pendingAddType) {
        if (_pendingAddType === 'layer') {
          createLayer(null, name);
        } else if (_pendingAddType === 'group') {
          layers.push({ id: 'group-' + Date.now() + '-' + Math.random().toString(36).slice(2), name: name, type: 'group', open: true, children: [] });
          renderLayerList(); scheduleSave();
        } else if (_pendingAddType === 'section') {
          layers.push({ id: 'section-' + Date.now() + '-' + Math.random().toString(36).slice(2), name: name, type: 'section', open: true, children: [] });
          renderLayerList(); scheduleSave();
        } else if (_pendingAddType === 'tileset') {
          var tsColor = LAYER_COLORS[flatLayers().length % LAYER_COLORS.length];
          var tsLayer = {
            id: 'layer-' + Date.now() + '-' + Math.random().toString(36).slice(2),
            name: name, type: 'fill', visible: true, color: tsColor, featureIds: [],
            source: { type: 'vector', url: '' }, 'source-layer': '',
            paint: { 'fill-color': tsColor, 'fill-opacity': 0.5, 'fill-outline-color': '#000000' }
          };
          layers.push(tsLayer);
          setActiveLayer(tsLayer.id);
          scheduleSave();
        }
      }
      closeAddInput();
    }
    if (e.key === 'Escape') closeAddInput();
  });

  document.getElementById('add-layer-btn').addEventListener('click',   function () { openAddInput('layer'); });
  document.getElementById('add-group-btn').addEventListener('click',   function () { openAddInput('group'); });
  document.getElementById('add-section-btn').addEventListener('click', function () { openAddInput('section'); });
  document.getElementById('add-tileset-btn').addEventListener('click', function () { openAddInput('tileset'); });

  // ── Project name ─────────────────────────────────────────────────────────────
  document.getElementById('project-name').addEventListener('blur', function () {
    // name saved on next save
  });

  // ── Autosave ──────────────────────────────────────────────────────────────────
  var _saveTimer = null;
  function scheduleSave() {
    clearTimeout(_saveTimer);
    _saveTimer = setTimeout(saveProject, 1000);
  }

  async function saveProject() {
    var name = document.getElementById('project-name').textContent.trim() || 'Untitled Map';
    var allFeatures = draw.getAll().features;

    var payload = {
      user_id: userId,
      name: name,
      layers_data: layers,
      features_data: allFeatures.map(function (f) {
        var meta = features[f.id] || {};
        return { ...f, properties: { ...f.properties, label: meta.label, notes: meta.notes, layerId: meta.layerId } };
      })
    };

    var result;
    if (projectId) {
      result = await db.from('map_projects_testing').update(payload).eq('id', projectId).select().single();
    } else {
      result = await db.from('map_projects_testing').insert(payload).select().single();
    }

    if (result.error) {
      showToast('Save failed: ' + result.error.message);
      return;
    }

    projectId = result.data.id;
    var url = new URL(location.href);
    url.searchParams.set('id', projectId);
    history.replaceState(null, '', url);
    showToast('Saved — ' + location.href);
  }

  // ── Load ─────────────────────────────────────────────────────────────────────
  async function loadProject(id) {
    var result = await db.from('map_projects_testing').select('*').eq('id', id).single();
    if (result.error || !result.data) { showToast('Project not found'); return; }

    var data = result.data;
    projectId = data.id;
    document.getElementById('project-name').textContent = data.name || 'Untitled Map';

    layers = data.layers_data || [];
    var savedFeatures = data.features_data || [];

    features = {};
    savedFeatures.forEach(function (f) {
      features[f.id] = {
        label: f.properties.label || '',
        notes: f.properties.notes || '',
        layerId: f.properties.layerId || ''
      };
    });

    draw.set({ type: 'FeatureCollection', features: savedFeatures });
    var fl = flatLayers(); if (fl.length) activeLayerId = fl[fl.length - 1].id;
    renderLayerList();
    function resyncTilesets() {
      Object.keys((map.getStyle() || {}).sources || {}).forEach(function (srcId) {
        if (srcId.indexOf('ext-') === 0) removeTilesetFromMap(srcId.slice(4));
      });
      syncTilesetLayers();
    }
    if (map.getSource(_DRAW_SRC)) resyncTilesets(); else map.once('style.load', resyncTilesets);
    showToast('Project loaded');
  }

  // ── Undo / Redo ──────────────────────────────────────────────────────────────
  function pushUndo(undoFn, redoFn) {
    undoStack.push({ undo: undoFn, redo: redoFn });
    redoStack = [];
    updateToolbar();
  }

  function performUndo() {
    if (!undoStack.length) return;
    var action = undoStack.pop();
    _suppressUndo = true;
    action.undo();
    _suppressUndo = false;
    redoStack.push(action);
    updateToolbar();
  }

  function performRedo() {
    if (!redoStack.length) return;
    var action = redoStack.pop();
    _suppressUndo = true;
    action.redo();
    _suppressUndo = false;
    undoStack.push(action);
    updateToolbar();
  }

  function _setGeometry(id, geom) {
    draw.delete([id]);
    draw.add({ type: 'Feature', id: id, geometry: geom, properties: {} });
  }

  function updateToolbar() {
    var selected = draw.getSelected().features;
    var allPolys = selected.length > 0 && selected.every(function (f) {
      return f.geometry.type === 'Polygon';
    });
    var oneOnly  = selected.length === 1;
    var onePoly  = oneOnly && allPolys;

    document.getElementById('btn-undo').disabled  = !undoStack.length;
    document.getElementById('btn-redo').disabled  = !redoStack.length;
    document.getElementById('btn-copy').disabled  = !oneOnly || splitMode;
    document.getElementById('btn-paste').disabled = !clipboard || splitMode;
    document.getElementById('btn-merge').disabled = selected.length < 2 || !allPolys || splitMode;
    document.getElementById('btn-split').disabled = !onePoly || splitMode;
  }

  // ── Copy / Paste ─────────────────────────────────────────────────────────────
  function doCopy() {
    var f = draw.getSelected().features[0];
    if (!f) return;
    clipboard = {
      geometry: JSON.parse(JSON.stringify(f.geometry)),
      meta:     JSON.parse(JSON.stringify(features[f.id] || {}))
    };
    updateToolbar();
    showToast('Copied');
  }

  function doPaste() {
    if (!clipboard) return;
    var geom     = JSON.parse(JSON.stringify(clipboard.geometry));
    var geomType = geom.type.replace('Multi', '');

    var activeLayer = findLayer(activeLayerId);
    var typeLayer;
    if (activeLayer && (activeLayer.type === null || activeLayer.type === geomType || activeLayer.type === geom.type)) {
      typeLayer = activeLayer;
      if (activeLayer.type === null) activeLayer.type = geomType;
    } else {
      typeLayer = flatLayers().find(function (l) { return l.type === geomType || l.type === geom.type; });
      if (!typeLayer) typeLayer = createLayer(geomType);
    }

    var layerId = typeLayer.id;
    var ids     = draw.add({ type: 'Feature', geometry: geom, properties: {} });
    var id      = ids[0];

    features[id] = { label: clipboard.meta.label || '', notes: clipboard.meta.notes || '', layerId: layerId };
    typeLayer.featureIds.push(id);
    draw.changeMode('simple_select', { featureIds: ids });
    renderLayerList();
    scheduleSave();

    pushUndo(
      function () {
        _suppressUndo = true;
        draw.delete([id]);
        removeFeatureFromState(id);
        renderLayerList();
        scheduleSave();
        _suppressUndo = false;
      },
      function () {
        _suppressUndo = true;
        draw.add({ type: 'Feature', id: id, geometry: JSON.parse(JSON.stringify(geom)), properties: {} });
        var layer = findLayer(layerId);
        if (layer && layer.featureIds.indexOf(id) === -1) {
          features[id] = { label: clipboard.meta.label || '', notes: clipboard.meta.notes || '', layerId: layerId };
          layer.featureIds.push(id);
        }
        renderLayerList();
        scheduleSave();
        _suppressUndo = false;
      }
    );
    showToast('Pasted — drag to move');
    updateToolbar();
  }

  // ── Merge ────────────────────────────────────────────────────────────────────
  function doMerge() {
    var selected = draw.getSelected().features;
    if (selected.length < 2) return;

    var result = turf.feature(selected[0].geometry);
    for (var i = 1; i < selected.length; i++) {
      result = turf.union(result, turf.feature(selected[i].geometry));
      if (!result) { showToast('Merge failed — invalid geometry', true); return; }
    }
    if (result.geometry.type === 'MultiPolygon') {
      showToast('Merge failed — polygons must touch or overlap', true);
      return;
    }

    var originals = selected.map(function (f) {
      return {
        id:   f.id,
        geom: JSON.parse(JSON.stringify(f.geometry)),
        meta: JSON.parse(JSON.stringify(features[f.id] || {}))
      };
    });

    var layerId = originals[0].meta.layerId;
    var layer   = findLayer(layerId);

    _suppressUndo = true;
    draw.delete(originals.map(function (o) { return o.id; }));
    originals.forEach(function (o) { removeFeatureFromState(o.id); });
    var newIds     = draw.add(result);
    var mergedId   = newIds[0];
    var mergedGeom = JSON.parse(JSON.stringify(result.geometry));
    features[mergedId] = { label: originals[0].meta.label || '', notes: '', layerId: layerId };
    if (layer && layer.featureIds.indexOf(mergedId) === -1) layer.featureIds.push(mergedId);
    draw.changeMode('simple_select', { featureIds: newIds });
    _suppressUndo = false;

    renderLayerList();
    scheduleSave();

    pushUndo(
      function () {
        _suppressUndo = true;
        draw.delete([mergedId]);
        removeFeatureFromState(mergedId);
        originals.forEach(function (o) {
          draw.add({ type: 'Feature', id: o.id, geometry: JSON.parse(JSON.stringify(o.geom)), properties: {} });
          features[o.id] = o.meta;
          var l = findLayer(o.meta.layerId);
          if (l && l.featureIds.indexOf(o.id) === -1) l.featureIds.push(o.id);
        });
        renderLayerList();
        scheduleSave();
        _suppressUndo = false;
      },
      function () {
        _suppressUndo = true;
        originals.forEach(function (o) {
          draw.delete([o.id]);
          removeFeatureFromState(o.id);
        });
        draw.add({ type: 'Feature', id: mergedId, geometry: JSON.parse(JSON.stringify(mergedGeom)), properties: {} });
        features[mergedId] = { label: originals[0].meta.label || '', notes: '', layerId: layerId };
        var l = findLayer(layerId);
        if (l && l.featureIds.indexOf(mergedId) === -1) l.featureIds.push(mergedId);
        renderLayerList();
        scheduleSave();
        _suppressUndo = false;
      }
    );
    showToast('Merged ' + selected.length + ' polygons');
    updateToolbar();
  }

  // ── Split ────────────────────────────────────────────────────────────────────
  function enterSplitMode() {
    var selected = draw.getSelected().features;
    if (selected.length !== 1) return;
    splitTarget = selected[0].id;
    splitMode   = true;
    draw.changeMode('draw_line_string');
    document.getElementById('btn-split').style.display        = 'none';
    document.getElementById('btn-cancel-split').style.display = 'inline-block';
    document.getElementById('btn-cancel-split').classList.add('active');
    showToast('Draw a line through the polygon to split it');
    updateToolbar();
  }

  function cancelSplitMode() {
    splitMode   = false;
    splitTarget = null;
    draw.changeMode('simple_select');
    document.getElementById('btn-split').style.display        = 'inline-block';
    document.getElementById('btn-cancel-split').style.display = 'none';
    document.getElementById('btn-cancel-split').classList.remove('active');
    updateToolbar();
  }

  function doSplit(lineFeature) {
    var allFeats = draw.getAll().features;
    var polygon  = allFeats.find(function (f) { return f.id === splitTarget; });
    if (!polygon) { cancelSplitMode(); return; }

    var origId   = splitTarget;
    var origGeom = JSON.parse(JSON.stringify(polygon.geometry));
    var origMeta = JSON.parse(JSON.stringify(features[origId] || {}));
    var halves   = splitPolygonWithLine(polygon, lineFeature);

    _suppressUndo = true;
    draw.delete([lineFeature.id]);
    _suppressUndo = false;

    if (halves.length < 2) {
      showToast('Split failed — line must cross the polygon completely', true);
      cancelSplitMode();
      return;
    }

    var layerId = origMeta.layerId;
    var layer   = findLayer(layerId);

    _suppressUndo = true;
    draw.delete([origId]);
    removeFeatureFromState(origId);
    var newIds = [];
    halves.forEach(function (h) { newIds = newIds.concat(draw.add(h)); });
    newIds.forEach(function (nid) {
      features[nid] = { label: origMeta.label || '', notes: origMeta.notes || '', layerId: layerId };
      if (layer && layer.featureIds.indexOf(nid) === -1) layer.featureIds.push(nid);
    });
    draw.changeMode('simple_select', { featureIds: newIds });
    _suppressUndo = false;

    var halfData = halves.map(function (h, i) {
      return { id: newIds[i], geom: JSON.parse(JSON.stringify(h.geometry)) };
    });

    splitMode   = false;
    splitTarget = null;
    document.getElementById('btn-split').style.display        = 'inline-block';
    document.getElementById('btn-cancel-split').style.display = 'none';
    document.getElementById('btn-cancel-split').classList.remove('active');

    renderLayerList();
    scheduleSave();

    pushUndo(
      function () {
        _suppressUndo = true;
        halfData.forEach(function (d) {
          draw.delete([d.id]);
          removeFeatureFromState(d.id);
        });
        draw.add({ type: 'Feature', id: origId, geometry: JSON.parse(JSON.stringify(origGeom)), properties: {} });
        features[origId] = origMeta;
        if (layer && layer.featureIds.indexOf(origId) === -1) layer.featureIds.push(origId);
        renderLayerList();
        scheduleSave();
        _suppressUndo = false;
      },
      function () {
        _suppressUndo = true;
        draw.delete([origId]);
        removeFeatureFromState(origId);
        halfData.forEach(function (d) {
          draw.add({ type: 'Feature', id: d.id, geometry: JSON.parse(JSON.stringify(d.geom)), properties: {} });
          features[d.id] = { label: origMeta.label || '', notes: origMeta.notes || '', layerId: layerId };
          if (layer && layer.featureIds.indexOf(d.id) === -1) layer.featureIds.push(d.id);
        });
        renderLayerList();
        scheduleSave();
        _suppressUndo = false;
      }
    );
    showToast('Split into ' + halfData.length + ' polygons');
    updateToolbar();
  }

  function splitPolygonWithLine(polygon, lineFeature) {
    var coords = lineFeature.geometry.coordinates;
    var p1 = coords[0];
    var p2 = coords[coords.length - 1];

    var dx = p2[0] - p1[0], dy = p2[1] - p1[1];
    var len = Math.sqrt(dx * dx + dy * dy);
    if (len === 0) return [];

    var nx = dx / len, ny = dy / len;
    var px = -ny,      py = nx;

    // far must exceed the polygon's extent so the half-planes cover it fully.
    // 2.0 degrees (original value) only works for city-scale polygons.
    var bbox = turf.bbox(turf.feature(polygon.geometry));
    var far  = Math.sqrt(Math.pow(bbox[2] - bbox[0], 2) + Math.pow(bbox[3] - bbox[1], 2)) * 2 + 1;

    var eA = [p1[0] - nx * far, p1[1] - ny * far];
    var eB = [p2[0] + nx * far, p2[1] + ny * far];

    var leftHalf = turf.polygon([[
      eA, eB,
      [eB[0] + px * far, eB[1] + py * far],
      [eA[0] + px * far, eA[1] + py * far],
      eA
    ]]);
    var rightHalf = turf.polygon([[
      eA, eB,
      [eB[0] - px * far, eB[1] - py * far],
      [eA[0] - px * far, eA[1] - py * far],
      eA
    ]]);

    var poly   = turf.feature(polygon.geometry);
    var piece1 = turf.intersect(poly, leftHalf);
    var piece2 = turf.intersect(poly, rightHalf);

    return [piece1, piece2].filter(Boolean);
  }

  // ── Active measure tool ──────────────────────────────────────────────────────
  function enterMeasureMode(type) {
    measureMode   = true;
    measureType   = type;
    measurePoints = [];
    measureDone   = false;
    map.doubleClickZoom.disable();
    map.getCanvas().style.cursor = 'crosshair';
    document.getElementById('btn-measure-dist').classList.toggle('active', type === 'distance');
    document.getElementById('btn-measure-area').classList.toggle('active', type === 'area');
    document.getElementById('btn-measure-clear').style.display = 'inline-block';
    refreshMeasureSource(null);
    updateMeasureDisplay(null);
  }

  function exitMeasureMode() {
    measureMode   = false;
    measurePoints = [];
    measureDone   = false;
    map.doubleClickZoom.enable();
    map.getCanvas().style.cursor = '';
    document.getElementById('btn-measure-dist').classList.remove('active');
    document.getElementById('btn-measure-area').classList.remove('active');
    document.getElementById('btn-measure-clear').style.display = 'none';
    if (map.getSource('measure-source')) {
      map.getSource('measure-source').setData({ type: 'FeatureCollection', features: [] });
    }
    document.getElementById('measure-display').classList.add('hidden');
  }

  function refreshMeasureSource(rubberCoord) {
    var features = measurePoints.map(function (p) {
      return { type: 'Feature', geometry: { type: 'Point', coordinates: p }, properties: {} };
    });
    if (measureType === 'distance') {
      var lineCoords = measurePoints.slice();
      if (rubberCoord && !measureDone) lineCoords.push(rubberCoord);
      if (lineCoords.length >= 2) {
        features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: lineCoords }, properties: {} });
      }
    } else {
      var polyPts = measurePoints.slice();
      if (rubberCoord && !measureDone) polyPts.push(rubberCoord);
      if (polyPts.length >= 3) {
        features.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [polyPts.concat([polyPts[0]])] }, properties: {} });
      } else if (polyPts.length === 2) {
        features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: polyPts }, properties: {} });
      }
    }
    if (map.getSource('measure-source')) {
      map.getSource('measure-source').setData({ type: 'FeatureCollection', features: features });
    }
  }

  function updateMeasureDisplay(rubberCoord) {
    var el = document.getElementById('measure-display');
    if (!measureMode) { el.classList.add('hidden'); return; }

    var hint = measureDone
      ? '<span class="measure-hint"> — Esc to clear</span>'
      : '<span class="measure-hint"> — double-click to finish, Esc to clear</span>';

    if (measurePoints.length === 0) {
      el.innerHTML = (measureType === 'distance' ? 'Click to measure distance' : 'Click to measure area') + hint;
      el.classList.remove('hidden');
      return;
    }

    if (measureType === 'distance') {
      var coords = measurePoints.slice();
      if (rubberCoord && !measureDone) coords.push(rubberCoord);
      var totalKm = 0;
      for (var i = 1; i < coords.length; i++) {
        totalKm += turf.length(turf.lineString([coords[i - 1], coords[i]]), { units: 'kilometers' });
      }
      var totalMi = totalKm * 0.621371;
      var totalM  = totalKm * 1000;
      var totalFt = totalM  * 3.28084;
      el.innerHTML =
        fmt(totalKm, 3) + ' km &nbsp;/&nbsp; ' + fmt(totalMi, 3) + ' mi' +
        '<br>' + fmt(totalM, 0) + ' m &nbsp;/&nbsp; ' + fmt(totalFt, 0) + ' ft' + hint;

    } else {
      var polyPts = measurePoints.slice();
      if (rubberCoord && !measureDone) polyPts.push(rubberCoord);
      if (polyPts.length < 3) {
        el.innerHTML = 'Keep clicking to define the area' + hint;
        el.classList.remove('hidden');
        return;
      }
      var closed  = polyPts.concat([polyPts[0]]);
      var sqm     = turf.area(turf.polygon([closed]));
      var ha      = sqm / 10000;
      var km2     = sqm / 1e6;
      var acre    = sqm / 4046.856;
      var sqft    = sqm * 10.7639;
      var perimKm = turf.length(turf.lineString(closed), { units: 'kilometers' });
      var perimMi = perimKm * 0.621371;
      el.innerHTML =
        (ha >= 100 ? fmt(km2, 2) + ' km²' : fmt(ha, 2) + ' ha') +
        ' &nbsp;/&nbsp; ' + fmt(acre, 1) + ' acres' +
        '<br>' + fmt(sqm, 0) + ' m² &nbsp;/&nbsp; ' + fmt(sqft, 0) + ' ft²' +
        '<br>Perimeter: ' + fmt(perimKm, 2) + ' km &nbsp;/&nbsp; ' + fmt(perimMi, 2) + ' mi' + hint;
    }
    el.classList.remove('hidden');
  }

  // ── Keyboard shortcuts ───────────────────────────────────────────────────────
  document.addEventListener('keydown', function (e) {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    var mod = e.ctrlKey || e.metaKey;
    if (mod && e.key === 'z' && !e.shiftKey)                        { e.preventDefault(); performUndo(); }
    if (mod && (e.key === 'y' || (e.key === 'z' && e.shiftKey)))    { e.preventDefault(); performRedo(); }
    if (mod && e.key === 'c')                                        { e.preventDefault(); doCopy(); }
    if (mod && e.key === 'v')                                        { e.preventDefault(); doPaste(); }
    if (e.key === 'Escape' && splitMode)                             cancelSplitMode();
    if (e.key === 'Escape' && measureMode)                           exitMeasureMode();
  });

  // ── Toolbar buttons ──────────────────────────────────────────────────────────
  document.getElementById('btn-undo').addEventListener('click',         performUndo);
  document.getElementById('btn-redo').addEventListener('click',         performRedo);
  document.getElementById('btn-copy').addEventListener('click',         doCopy);
  document.getElementById('btn-paste').addEventListener('click',        doPaste);
  document.getElementById('btn-merge').addEventListener('click',        doMerge);
  document.getElementById('btn-split').addEventListener('click',        enterSplitMode);
  document.getElementById('btn-cancel-split').addEventListener('click', cancelSplitMode);
  document.getElementById('btn-measure-dist').addEventListener('click', function () {
    if (measureMode && measureType === 'distance') exitMeasureMode(); else enterMeasureMode('distance');
  });
  document.getElementById('btn-measure-area').addEventListener('click', function () {
    if (measureMode && measureType === 'area') exitMeasureMode(); else enterMeasureMode('area');
  });
  document.getElementById('btn-measure-clear').addEventListener('click', exitMeasureMode);

  // ── Attribute table ──────────────────────────────────────────────────────────
  document.getElementById('btn-attr-table').addEventListener('click', function () {
    var panel = document.getElementById('attr-panel');
    var open  = panel.classList.toggle('hidden') === false;
    this.classList.toggle('active', !panel.classList.contains('hidden'));
    if (!panel.classList.contains('hidden')) renderAttrTable();
  });

  document.getElementById('btn-attr-expand').addEventListener('click', function () {
    attrExpanded = !attrExpanded;
    this.textContent = attrExpanded ? 'Collapse' : 'Expand';
    document.getElementById('attr-panel').classList.toggle('expanded', attrExpanded);
    renderAttrTable();
  });

  document.getElementById('attr-panel-close').addEventListener('click', function () {
    document.getElementById('attr-panel').classList.add('hidden');
    document.getElementById('btn-attr-table').classList.remove('active');
  });

  // ── Basemap switcher ─────────────────────────────────────────────────────────
  var basemapSelect = document.getElementById('basemap-select');
  BASEMAPS.forEach(function (b) {
    var opt = document.createElement('option');
    opt.value = b.style;
    opt.textContent = b.label;
    basemapSelect.appendChild(opt);
  });
  basemapSelect.addEventListener('change', function () {
    map.setStyle(this.value);
  });

  // ── Layer-list drag (container-level) ────────────────────────────────────────
  function initLayerListDrag() {
    var list = document.getElementById('layer-list');

    list.addEventListener('dragover', function (e) {
      e.preventDefault();
      if (dragId === null) return;

      var els = Array.from(list.querySelectorAll('[draggable]:not(.dragging)'));
      var cursor = e.clientY;
      var newInsert = null;
      var newInto   = null;

      for (var i = 0; i < els.length; i++) {
        var r = els[i].getBoundingClientRect();
        var isContainer = els[i].classList.contains('container-item');
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
      scheduleSave();
    });
  }

  function clearDragIndicator() {
    document.querySelectorAll('#layer-list .drop-before').forEach(function (el) { el.classList.remove('drop-before'); });
    document.querySelectorAll('#layer-list .drop-into').forEach(function (el) { el.classList.remove('drop-into'); });
    var list = document.getElementById('layer-list');
    if (list) list.classList.remove('drop-after-last');
  }

  initLayerListDrag();

  // ── Draw display / live update ────────────────────────────────────────────────
  function syncDrawDisplay() {
    if (!map || !map.getSource(_DRAW_SRC)) return;
    var raw = draw.getAll();
    var feats = [];
    raw.features.forEach(function (f) {
      var meta  = features[f.id];
      var layer = meta ? findLayer(meta.layerId) : null;
      if (layer && layer.visible === false) return;
      var p = (layer && layer.paint) || {};
      feats.push({
        type: 'Feature', id: f.id, geometry: f.geometry,
        properties: {
          _id: f.id,
          _c: p['fill-color']         || (layer && layer.color) || '#888888',
          _o: p['fill-outline-color'] || '#000000',
          _a: p['fill-opacity'] !== undefined ? p['fill-opacity'] : 0.5
        }
      });
    });
    map.getSource(_DRAW_SRC).setData({ type: 'FeatureCollection', features: feats });
  }

  function liveUpdateDraw() { syncDrawDisplay(); }

  // ── Style panel ───────────────────────────────────────────────────────────────
  function openEditor() {
    if (!_layer) {
      document.getElementById('no-selection').style.display = '';
      document.getElementById('draw-editor').style.display  = 'none';
      return;
    }
    document.getElementById('no-selection').style.display  = 'none';
    document.getElementById('draw-editor').style.display   = '';
    document.getElementById('draw-layer-name').textContent = _layer.name;
    document.getElementById('draw-type-badge').textContent = _layer.type || 'draw';
    if (_activeTab === 'form') { renderForm(); syncJSON(); }
    else                       { syncJSON(); }
  }

  function renderForm() {
    if (!_layer) return;
    var l = _layer;
    var html = '';
    html += fSection('Basic', [
      fRow('Name',       fText('f-name',       l.name  || '')),
      fRow('Icon Color', fColor('f-icon-color', l.color || '#888888')),
    ]);
    if (l.type === 'fill') {
      html += fSection('Style', [
        fRow('Fill Color',    fColor('f-fill-color',   paintVal(l, 'fill-color',         '#888888'))),
        fRow('Outline Color', fColor('f-fill-outline', paintVal(l, 'fill-outline-color', '#000000'))),
        fRow('Opacity',       fRange('f-fill-opacity', paintVal(l, 'fill-opacity',        0.5), 0, 1, 0.05)),
      ]);
      html += fSection('Source', [
        fRow('Mapbox URL',   fText('f-src-url',   (l.source && l.source.url)  || '')),
        fRow('Source Layer', fText('f-src-layer', l['source-layer'] || '')),
      ]);
    } else if (l.type === 'line') {
      html += fSection('Style', [
        fRow('Color',   fColor('f-line-color',   paintVal(l, 'line-color',  '#888888'))),
        fRow('Opacity', fRange('f-line-opacity', paintVal(l, 'line-opacity', 1), 0, 1, 0.05)),
        fRow('Width',   fRange('f-line-width',   paintVal(l, 'line-width',   2), 0.5, 20, 0.5)),
      ]);
      html += fSection('Source', [
        fRow('Mapbox URL',   fText('f-src-url',   (l.source && l.source.url)  || '')),
        fRow('Source Layer', fText('f-src-layer', l['source-layer'] || '')),
      ]);
    } else {
      html += fSection('Style', [
        fRow('Fill Color',    fColor('f-fill-color',   paintVal(l, 'fill-color',         '#888888'))),
        fRow('Outline Color', fColor('f-fill-outline', paintVal(l, 'fill-outline-color', '#000000'))),
        fRow('Opacity',       fRange('f-fill-opacity', paintVal(l, 'fill-opacity',        0.5), 0, 1, 0.05)),
      ]);
    }
    document.getElementById('tab-form').innerHTML = html;
    bindForm();
  }

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
  }

  function collect() {
    if (!_layer) return;
    var el;
    if ((el = document.getElementById('f-name')))           _layer.name  = el.value;
    if ((el = document.getElementById('f-icon-color-txt'))) _layer.color = el.value;
    if (!_layer.paint) _layer.paint = {};
    // draw / fill tileset
    if ((el = document.getElementById('f-fill-color-txt')))   _layer.paint['fill-color']         = el.value;
    if ((el = document.getElementById('f-fill-outline-txt'))) _layer.paint['fill-outline-color']  = el.value;
    if ((el = document.getElementById('f-fill-opacity')))     _layer.paint['fill-opacity']        = parseFloat(el.value);
    // line tileset
    if ((el = document.getElementById('f-line-color-txt')))   _layer.paint['line-color']          = el.value;
    if ((el = document.getElementById('f-line-opacity')))     _layer.paint['line-opacity']        = parseFloat(el.value);
    if ((el = document.getElementById('f-line-width')))       _layer.paint['line-width']          = parseFloat(el.value);
    // source fields
    if (_layer.source) {
      if ((el = document.getElementById('f-src-url')))   _layer.source.url = el.value;
    }
    if ((el = document.getElementById('f-src-layer'))) _layer['source-layer'] = el.value;
    syncJSON();
    liveUpdateDraw();
    if (isTileset(_layer)) liveUpdateTileset();
    scheduleSave();
  }

  function syncJSON() {
    if (_activeTab === 'json') return;
    var ta = document.getElementById('json-editor');
    if (ta && _layer) ta.value = JSON.stringify(_layer, null, 2);
  }

  function initTabs() {
    document.querySelectorAll('.tab-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var to = this.dataset.tab;
        if (to === _activeTab) return;
        if (_activeTab === 'json' && to === 'form') {
          var ta = document.getElementById('json-editor');
          try {
            var parsed = JSON.parse(ta.value);
            if (_layer) {
              if (parsed.name  !== undefined) _layer.name  = parsed.name;
              if (parsed.color !== undefined) _layer.color = parsed.color;
              if (parsed.paint !== undefined) _layer.paint = parsed.paint;
            }
            ta.classList.remove('json-error');
          } catch (e) { ta.classList.add('json-error'); return; }
        }
        _activeTab = to;
        document.querySelectorAll('.tab-btn').forEach(function (b) {
          b.classList.toggle('active', b.dataset.tab === to);
        });
        document.getElementById('tab-form').style.display = to === 'form' ? '' : 'none';
        document.getElementById('tab-json').style.display  = to === 'json' ? '' : 'none';
        if (to === 'form') { renderForm(); syncJSON(); }
        if (to === 'json') { document.getElementById('json-editor').value = JSON.stringify(_layer, null, 2); }
      });
    });
  }

  // ── Form builders ─────────────────────────────────────────────────────────────
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
  function paintVal(layer, prop, def) {
    return (layer.paint && layer.paint[prop] !== undefined) ? layer.paint[prop] : def;
  }

  initTabs();

  // ── Toast ────────────────────────────────────────────────────────────────────
  var _toastTimer = null;
  function showToast(msg, isError) {
    var el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.toggle('error', !!isError);
    el.classList.remove('hidden');
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(function () { el.classList.add('hidden'); }, isError ? 4000 : 3000);
  }

})();
