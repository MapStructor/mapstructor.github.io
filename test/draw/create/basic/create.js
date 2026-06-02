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
    updateDrawControls();

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
    var geomType = feature.geometry.type;

    var activeLayer = layers.find(function (l) { return l.id === activeLayerId; });
    var typeLayer;

    if (activeLayer && activeLayer.type === null) {
      // Active typeless layer claims this type
      activeLayer.type = geomType;
      typeLayer = activeLayer;
      updateDrawControls();
    } else if (activeLayer && activeLayer.type === geomType) {
      // Active layer already matches — use it directly
      typeLayer = activeLayer;
    } else {
      // Active layer is wrong type or missing — find or auto-create
      typeLayer = layers.find(function (l) { return l.type === geomType; });
      if (!typeLayer) {
        typeLayer = createLayer(geomType);
      } else {
        draw.delete(feature.id);
        showToast('Select the correct layer in the sidebar first', true);
        return;
      }
    }

    features[feature.id] = { label: '', notes: '', layerId: typeLayer.id };
    typeLayer.featureIds.push(feature.id);
    renderLayerList();
    openFeaturePanel(feature.id);
    scheduleSave();
  });

  map.on('draw.update', function (e) {
    scheduleSave();
  });

  map.on('draw.delete', function (e) {
    e.features.forEach(function (f) {
      removeFeatureFromState(f.id);
    });
    closeFeaturePanel();
    renderLayerList();
    scheduleSave();
  });

  map.on('draw.selectionchange', function (e) {
    if (e.features.length === 0) {
      closeFeaturePanel();
    } else {
      openFeaturePanel(e.features[0].id);
    }
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
    updateDrawControls();
    return layer;
  }

  function setActiveLayer(id) {
    activeLayerId = id;
    renderLayerList();
    updateDrawControls();
  }

  function updateSidebarHover() {
    document.querySelectorAll('.feature-item').forEach(function (el) {
      el.classList.toggle('hover', el.dataset.id === hoveredDrawId);
    });
  }

  function updateDrawControls() {
    var layer = layers.find(function (l) { return l.id === activeLayerId; });
    var type = layer ? layer.type : null; // null = no active layer or typeless

    var allDrawBtns = document.querySelectorAll('.mapbox-gl-draw_ctrl-draw-btn');
    console.log('draw btns:', Array.from(allDrawBtns).map(function(b) { return b.className; }));

    var buttons = {
      Polygon:    document.querySelector('.mapbox-gl-draw_polygon'),
      LineString: document.querySelector('.mapbox-gl-draw_line_string') || document.querySelector('.mapbox-gl-draw_line'),
      Point:      document.querySelector('.mapbox-gl-draw_point')
    };

    Object.keys(buttons).forEach(function (geomType) {
      var btn = buttons[geomType];
      if (!btn) return;
      var enabled = !type || type === geomType; // typeless = all enabled
      btn.style.opacity = enabled ? '' : '0.3';
      btn.style.pointerEvents = enabled ? '' : 'none';
      btn.style.cursor = enabled ? '' : 'not-allowed';
      btn.style.boxShadow = (type && enabled) ? 'inset 0 0 0 2px #4a9eff' : '';
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
