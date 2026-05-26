/*
  MERGE — MULTIPOLYGON BEHAVIOUR
  ─────────────────────────────────────────────────────────────────────────────
  turf.union returns a MultiPolygon when the source polygons don't touch or
  overlap. This means merging two non-adjacent polygons produces one draw
  feature with multiple separate rings — valid GeoJSON, but a single object.

  This is intentionally left allowed. Non-contiguous territories are a real
  case in historical mapping (countries with detached regions, island chains,
  exclaves, etc.) and a MultiPolygon is the correct representation.

  If revisiting:
    - Block non-adjacent merges — detect MultiPolygon result and show an
      error ("Polygons must touch or overlap to merge")
    - Allow but warn — merge succeeds but a toast flags it as non-contiguous
    - Allow silently (current behaviour) — trust the user knew what they did

  Downstream concern: selection, attributes, split, and export all need to
  handle MultiPolygon features gracefully if this stays allowed.

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
  var splitMode         = false;
  var splitTarget       = null;
  var _suppressUndo     = false;
  var _selectedSnapshot = {};
  var undoStack         = [];
  var redoStack         = [];

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
  map.on('load', function () {
    // Highlight source — used for both sidebar→map and map→sidebar hover
    map.addSource('hover-highlight', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] }
    });
    // Insert below draw layers so the feature itself stays unchanged
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

    // Map → sidebar hover
    var drawLayerIds = map.getStyle().layers
      .filter(function (l) { return l.id.indexOf('gl-draw') > -1; })
      .map(function (l) { return l.id; });

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
  function renderLayerList() {
    var el = document.getElementById('layer-list');
    el.innerHTML = '';
    layers.forEach(function (layer) {
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

      var count = document.createElement('span');
      count.className = 'layer-count';
      count.textContent = layer.featureIds.length || '';

      div.appendChild(chk);
      div.appendChild(swatch);
      div.appendChild(name);
      div.appendChild(count);

      div.addEventListener('click', function () {
        if (layer.id !== activeLayerId) setActiveLayer(layer.id);
      });

      el.appendChild(div);

      // Feature rows beneath the layer
      layer.featureIds.forEach(function (fid) {
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

        fDiv.addEventListener('click', function (e) {
          e.stopPropagation();
          setActiveLayer(layer.id);
          draw.changeMode('simple_select', { featureIds: [fid] });
          openFeaturePanel(fid);
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
    renderLayerList();
  }

  function closeFeaturePanel() {
    selectedDrawId = null;
    document.getElementById('feature-panel').classList.add('hidden');
    renderLayerList();
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
    var name = prompt('Layer name:');
    if (!name) return;
    var layer = createLayer(null);
    layer.name = name;
    renderLayerList();
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
    var selected  = draw.getSelected().features;
    var allPolys  = selected.length > 0 && selected.every(function (f) {
      return f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon';
    });
    var oneOnly   = selected.length === 1;
    var onePoly   = oneOnly && allPolys;

    document.getElementById('btn-undo').disabled  = !undoStack.length;
    document.getElementById('btn-redo').disabled  = !redoStack.length;
    document.getElementById('btn-copy').disabled  = !oneOnly || splitMode;
    document.getElementById('btn-paste').disabled = !clipboard || splitMode;
    var isMultiPoly = oneOnly && selected[0].geometry.type === 'MultiPolygon';
    document.getElementById('btn-merge').disabled    = selected.length < 2 || !allPolys || splitMode;
    document.getElementById('btn-split').disabled    = !onePoly || splitMode;
    document.getElementById('btn-separate').disabled = !isMultiPoly || splitMode;
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

  // ── Keyboard shortcuts ───────────────────────────────────────────────────────
  document.addEventListener('keydown', function (e) {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    var mod = e.ctrlKey || e.metaKey;
    if (mod && e.key === 'z' && !e.shiftKey)                        { e.preventDefault(); performUndo(); }
    if (mod && (e.key === 'y' || (e.key === 'z' && e.shiftKey)))    { e.preventDefault(); performRedo(); }
    if (mod && e.key === 'c')                                        { e.preventDefault(); doCopy(); }
    if (mod && e.key === 'v')                                        { e.preventDefault(); doPaste(); }
    if (e.key === 'Escape' && splitMode)                             cancelSplitMode();
  });

  // ── Separate Parts ───────────────────────────────────────────────────────────
  function doSeparate() {
    var f = draw.getSelected().features[0];
    if (!f || f.geometry.type !== 'MultiPolygon') return;

    var origId   = f.id;
    var origGeom = JSON.parse(JSON.stringify(f.geometry));
    var origMeta = JSON.parse(JSON.stringify(features[origId] || {}));
    var layerId  = origMeta.layerId;
    var layer    = layers.find(function (l) { return l.id === layerId; });

    _suppressUndo = true;
    draw.delete([origId]);
    removeFeatureFromState(origId);

    var newIds = [];
    f.geometry.coordinates.forEach(function (polyCoords) {
      var ids = draw.add({ type: 'Feature', geometry: { type: 'Polygon', coordinates: polyCoords }, properties: {} });
      var nid = ids[0];
      features[nid] = { label: origMeta.label || '', notes: origMeta.notes || '', layerId: layerId };
      if (layer && layer.featureIds.indexOf(nid) === -1) layer.featureIds.push(nid);
      newIds.push(nid);
    });
    draw.changeMode('simple_select', { featureIds: newIds });
    _suppressUndo = false;

    renderLayerList();
    scheduleSave();

    pushUndo(
      function () {
        _suppressUndo = true;
        newIds.forEach(function (nid) { draw.delete([nid]); removeFeatureFromState(nid); });
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
        newIds.forEach(function (nid, i) {
          draw.add({ type: 'Feature', id: nid, geometry: { type: 'Polygon', coordinates: origGeom.coordinates[i] }, properties: {} });
          features[nid] = { label: origMeta.label || '', notes: origMeta.notes || '', layerId: layerId };
          if (layer && layer.featureIds.indexOf(nid) === -1) layer.featureIds.push(nid);
        });
        renderLayerList();
        scheduleSave();
        _suppressUndo = false;
      }
    );
    showToast('Separated into ' + newIds.length + ' polygons');
    updateToolbar();
  }

  // ── Toolbar buttons ──────────────────────────────────────────────────────────
  document.getElementById('btn-undo').addEventListener('click',         performUndo);
  document.getElementById('btn-redo').addEventListener('click',         performRedo);
  document.getElementById('btn-copy').addEventListener('click',         doCopy);
  document.getElementById('btn-paste').addEventListener('click',        doPaste);
  document.getElementById('btn-merge').addEventListener('click',        doMerge);
  document.getElementById('btn-split').addEventListener('click',        enterSplitMode);
  document.getElementById('btn-cancel-split').addEventListener('click', cancelSplitMode);
  document.getElementById('btn-separate').addEventListener('click',     doSeparate);

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
