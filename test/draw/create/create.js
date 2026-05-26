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
  var layers      = [];   // [{ id, name, type, color, visible, featureIds:[] }]
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
  var _dragState           = null;
  var _dragOverEl          = null;
  var drawLayerIds         = [];
  var _mapEventsRegistered = false;

  function fmt(n, dec) {
    return n.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
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

  draw = new MapboxDraw({
    displayControlsDefault: false,
    controls: { polygon: true, line_string: true, point: true, trash: true }
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
        var rendered = map.queryRenderedFeatures(e.point, { layers: drawLayerIds });
        var fid = rendered.length ? (rendered[0].id || (rendered[0].properties && rendered[0].properties.id)) : null;
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
      layers_data: [],
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
    var activeLayer = layers.find(function (l) { return l.id === activeLayerId; });
    var typeLayer;

    if (activeLayer && activeLayer.type === null) {
      activeLayer.type = geomType;
      typeLayer = activeLayer;
    } else if (activeLayer && activeLayer.type === geomType) {
      typeLayer = activeLayer;
    } else {
      typeLayer = layers.find(function (l) { return l.type === geomType; });
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
        var layer = layers.find(function (l) { return l.id === layerId; });
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
          var layer = layers.find(function (l) { return l.id === d.meta.layerId; });
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
  function createLayer(type) {
    var color = LAYER_COLORS[layers.length % LAYER_COLORS.length];
    var names = { Polygon: 'Polygons', LineString: 'Lines', Point: 'Points' };
    var layer = {
      id: 'layer-' + Date.now() + '-' + Math.random().toString(36).slice(2),
      name: type ? (names[type] || type) : 'New Layer',
      type: type || null,
      color: color,
      visible: true,
      featureIds: []
    };
    layers.push(layer);
    activeLayerId = layer.id;
    renderLayerList();
    return layer;
  }

  function setActiveLayer(id) {
    activeLayerId = id;
    renderLayerList();
  }

  function updateSidebarHover() {
    document.querySelectorAll('.feature-item').forEach(function (el) {
      el.classList.toggle('hover', el.dataset.id === hoveredDrawId);
    });
  }

  function removeFeatureFromState(drawId) {
    var meta = features[drawId];
    if (!meta) return;
    var layer = layers.find(function (l) { return l.id === meta.layerId; });
    if (layer) {
      layer.featureIds = layer.featureIds.filter(function (fid) { return fid !== drawId; });
    }
    delete features[drawId];
  }

  // ── Sidebar rendering ────────────────────────────────────────────────────────
  function setupDrag(el, type, li, fi) {
    el.draggable = true;

    el.addEventListener('dragstart', function (e) {
      _dragState = { type: type, li: li, fi: fi };
      e.dataTransfer.effectAllowed = 'move';
      setTimeout(function () { el.classList.add('dragging'); }, 0);
    });

    el.addEventListener('dragend', function () {
      el.classList.remove('dragging');
      if (_dragOverEl) { _dragOverEl.classList.remove('drag-over-top', 'drag-over-bottom'); _dragOverEl = null; }
      _dragState = null;
    });

    el.addEventListener('dragover', function (e) {
      if (!_dragState || _dragState.type !== type) return;
      e.preventDefault();
      if (_dragOverEl && _dragOverEl !== el) _dragOverEl.classList.remove('drag-over-top', 'drag-over-bottom');
      var rect   = el.getBoundingClientRect();
      var before = e.clientY < rect.top + rect.height / 2;
      el.classList.toggle('drag-over-top',    before);
      el.classList.toggle('drag-over-bottom', !before);
      _dragOverEl = el;
    });

    el.addEventListener('drop', function (e) {
      e.preventDefault();
      if (!_dragState || _dragState.type !== type) return;
      if (_dragOverEl) { _dragOverEl.classList.remove('drag-over-top', 'drag-over-bottom'); _dragOverEl = null; }
      var rect   = el.getBoundingClientRect();
      var before = e.clientY < rect.top + rect.height / 2;

      if (type === 'layer') {
        var from = _dragState.li, to = li;
        if (from === to) { _dragState = null; return; }
        var moved = layers.splice(from, 1)[0];
        var adj   = (from < to ? to - 1 : to) + (before ? 0 : 1);
        layers.splice(adj, 0, moved);
      } else {
        if (_dragState.li !== li) { _dragState = null; return; }
        var fids = layers[li].featureIds;
        var from = _dragState.fi, to = fi;
        if (from === to) { _dragState = null; return; }
        var movedId = fids.splice(from, 1)[0];
        var adj     = (from < to ? to - 1 : to) + (before ? 0 : 1);
        fids.splice(adj, 0, movedId);
      }

      _dragState = null;
      renderLayerList();
      scheduleSave();
    });
  }

  function renderLayerList() {
    var el = document.getElementById('layer-list');
    el.innerHTML = '';
    layers.forEach(function (layer, li) {
      var div = document.createElement('div');
      div.className = 'layer-item' + (layer.id === activeLayerId ? ' active' : '');
      div.dataset.id = layer.id;

      var chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.className = 'layer-visibility';
      chk.checked = layer.visible;
      chk.title = 'Toggle visibility';
      chk.addEventListener('change', function (e) {
        e.stopPropagation();
        toggleLayerVisibility(layer.id, chk.checked);
      });

      var swatch = document.createElement('div');
      swatch.className = 'layer-swatch';
      var svgIcons = {
        Point:      '<circle cx="8" cy="8" r="5" fill="COLOR"/>',
        LineString: '<line x1="2" y1="14" x2="14" y2="2" stroke="COLOR" stroke-width="2.5" stroke-linecap="round"/>',
        Polygon:    '<polygon points="8,2 14,6 12,13 4,13 2,6" fill="none" stroke="COLOR" stroke-width="2" stroke-linejoin="round"/>'
      };
      var iconSvg = svgIcons[layer.type] || '<rect x="3" y="3" width="10" height="10" rx="2" fill="COLOR"/>';
      swatch.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">' + iconSvg.replace(/COLOR/g, layer.color) + '</svg>';

      var name = document.createElement('span');
      name.className = 'layer-name';
      name.textContent = layer.name;
      name.title = 'Double-click to rename';

      name.addEventListener('dblclick', function (e) {
        e.stopPropagation();
        name.contentEditable = 'true';
        name.focus();
        // Select all text
        var range = document.createRange();
        range.selectNodeContents(name);
        window.getSelection().removeAllRanges();
        window.getSelection().addRange(range);
      });

      name.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); name.blur(); }
        if (e.key === 'Escape') { name.textContent = layer.name; name.blur(); }
      });

      name.addEventListener('blur', function () {
        name.contentEditable = 'false';
        var newName = name.textContent.trim();
        if (newName && newName !== layer.name) {
          layer.name = newName;
          scheduleSave();
        } else {
          name.textContent = layer.name;
        }
      });

      div.appendChild(chk);
      div.appendChild(swatch);
      div.appendChild(name);
      setupDrag(div, 'layer', li, -1);

      div.addEventListener('click', function () {
        if (layer.id !== activeLayerId) setActiveLayer(layer.id);
      });

      el.appendChild(div);

      // Feature rows beneath the layer
      layer.featureIds.forEach(function (fid, fi) {
        var meta = features[fid];
        if (!meta) return;

        var fDiv = document.createElement('div');
        fDiv.className = 'feature-item' +
          (fid === selectedDrawId ? ' active' : '') +
          (fid === hoveredDrawId ? ' hover' : '');
        fDiv.dataset.id = fid;

        var fName = document.createElement('span');
        fName.className = 'feature-item-label';
        fName.textContent = meta.label || ('Untitled ' + (layer.type || 'Feature'));

        fDiv.appendChild(fName);
        setupDrag(fDiv, 'feature', li, fi);

        fDiv.addEventListener('click', function (e) {
          e.stopPropagation();
          setActiveLayer(layer.id);
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

        el.appendChild(fDiv);
      });
    });
  }

  function toggleLayerVisibility(layerId, visible) {
    var layer = layers.find(function (l) { return l.id === layerId; });
    if (!layer) return;
    layer.visible = visible;
    layer.featureIds.forEach(function (fid) {
      var feature = draw.get(fid);
      if (!feature) return;
      if (visible) {
        draw.add(feature);
      } else {
        draw.delete(fid);
      }
    });
  }

  // ── Feature panel ────────────────────────────────────────────────────────────
  function openFeaturePanel(drawId) {
    selectedDrawId = drawId;
    var meta = features[drawId];
    if (!meta) return;
    var layer = layers.find(function (l) { return l.id === meta.layerId; });

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

  // ── Add Layer button ─────────────────────────────────────────────────────────
  document.getElementById('add-layer-btn').addEventListener('click', function () {
    createLayer(null);
  });

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
    if (layers.length) activeLayerId = layers[layers.length - 1].id;
    renderLayerList();
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

    var activeLayer = layers.find(function (l) { return l.id === activeLayerId; });
    var typeLayer;
    if (activeLayer && (activeLayer.type === null || activeLayer.type === geomType || activeLayer.type === geom.type)) {
      typeLayer = activeLayer;
      if (activeLayer.type === null) activeLayer.type = geomType;
    } else {
      typeLayer = layers.find(function (l) { return l.type === geomType || l.type === geom.type; });
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
        var layer = layers.find(function (l) { return l.id === layerId; });
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
    var layer   = layers.find(function (l) { return l.id === layerId; });

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
          var l = layers.find(function (l) { return l.id === o.meta.layerId; });
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
        var l = layers.find(function (l) { return l.id === layerId; });
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
    var layer   = layers.find(function (l) { return l.id === layerId; });

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
