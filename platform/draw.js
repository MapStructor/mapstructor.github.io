/*
  Mapstructor editor — draw tool.
  Ported from test/draw/create/v3/create.js (the reference build).

  Differences from v3:
  - No map creation: attaches to the engine's `beforeMap` (left map). The global
    `map` is the mapboxgl.Compare instance, so this IIFE shadows it with
    `var map = beforeMap` and the v3 code runs unchanged against the left map.
  - Persistence targets the new relational schema (projects / layers /
    project_layers / layer_sections / layer_groups / features) instead of the
    old map_projects_testing jsonb columns.
  - Cut for later build-order steps (the v3 code remains the reference):
    attribute table (step 9), upload (step 10), tileset add button,
    measure / merge / split / copy-paste, basemap switcher (template has one).
*/
(function () {

  // ── Config ──────────────────────────────────────────────────────────────────
  var SUPABASE_URL = 'https://eqpxlwbjqiwfjlsuapvu.supabase.co';
  var SUPABASE_KEY = 'sb_publishable_ijLmSmMUeNBrgMGL8Aol4g_S5-xwUzD';

  // Layer colours — cycle through these for new layers
  var LAYER_COLORS = ['#4a9eff','#ff6b4a','#4aff9e','#ff4adb','#ffe04a','#4af0ff','#ff9e4a'];

  // Tree leaf type ⇄ DB layers.type (Mapbox GL layer type)
  var TYPE_TO_DB = { Polygon: 'fill', LineString: 'line', Point: 'circle' };
  var DB_TO_TYPE = { fill: 'Polygon', line: 'LineString', circle: 'Point' };

  // ── State ───────────────────────────────────────────────────────────────────
  var db   = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
  var map  = beforeMap;   // shadows the global Compare instance — draw lives on the left map
  var draw = null;
  var projectId = null;
  var userId    = null;
  var layers    = [];   // editor tree (shadows the template's layersList global)
  var features  = {};   // { drawId: { label, notes, layerId, dbId, dirty } }
  var activeLayerId  = null;
  var selectedDrawId = null;
  var hoveredDrawId  = null;

  var _suppressUndo     = false;
  var _selectedSnapshot = {};
  var undoStack         = [];
  var redoStack         = [];
  var dragId         = null;
  var insertBeforeId = null;
  var dropIntoId     = null;
  var drawLayerIds         = [];
  var _mapEventsRegistered = false;

  // Persistence bookkeeping — what we believe exists in the DB right now
  var _persistedFeatureDbIds = {};   // { dbId: true }
  var _persistedSectionIds   = [];
  var _persistedGroupIds     = [];

  // ── Style panel state ──────────────────────────────────────────────────────
  var _DRAW_SRC    = 'draw-src';
  var _DRAW_FILL   = 'draw-fill';
  var _DRAW_LINE   = 'draw-line';
  var _DRAW_CIRCLE = 'draw-circle';
  var _origLayer = null;
  var _layer     = null;
  var _activeTab = 'form';

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

  // ── Init ────────────────────────────────────────────────────────────────────
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
  map.addControl(draw, 'top-right');

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

    if (!_mapEventsRegistered) {
      _mapEventsRegistered = true;

      map.on('mousemove', function (e) {
        var hoverLayers = [_DRAW_FILL, _DRAW_LINE, _DRAW_CIRCLE].filter(function (id) { return !!map.getLayer(id); });
        var rendered = hoverLayers.length ? map.queryRenderedFeatures(e.point, { layers: hoverLayers }) : [];
        var fid = rendered.length ? (rendered[0].properties && rendered[0].properties._id) || rendered[0].id || null : null;
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
      afterAuth();
    } else {
      db.auth.signInAnonymously().then(function (res2) {
        if (res2.data.session) userId = res2.data.session.user.id;
        afterAuth();
      });
    }
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
    var result = await db.from('projects').insert({
      user_id: userId,
      name: 'Untitled Map'
    }).select('id').single();
    if (result.error) { showToast('Could not initialize project: ' + result.error.message, true); return; }
    projectId = result.data.id;
    var url = new URL(location.href);
    url.searchParams.set('id', projectId);
    history.replaceState(null, '', url);
  }

  // ── Draw events ─────────────────────────────────────────────────────────────
  map.on('draw.create', function (e) {
    var feature = e.features[0];

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

    features[id] = { label: '', notes: '', layerId: layerId, dbId: null, dirty: true };
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
          features[id] = { label: '', notes: '', layerId: layerId, dbId: null, dirty: true };
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
      if (features[id]) features[id].dirty = true;
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
          features[d.id].dirty = true;
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
      source_type: 'geojson-supabase',
      color: color,
      visible: true,
      featureIds: [],
      dbId: null,
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
    _origLayer = id ? findLayer(id) : null;
    _layer = _origLayer;
    openEditor();
    syncDrawDisplay();
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
              + '<span class="toggle">' + (isOpen ? '&#9662;' : '&#9656;') + '</span>'
              + ' <span class="container-name">' + esc(item.name) + '</span>'
              + ((!item.children || item.children.length === 0) ? '<span class="delete-btn">&#x2715;</span>' : '')
              + '</div>';
        if (isOpen && item.children && item.children.length) {
          html += buildLayerHTML(item.children, depth + 1);
        }
      } else if (item.source_type && item.source_type !== 'geojson-supabase') {
        // Tileset layer — render the viewer's native row (engine icon + label +
        // zoom-to + info), reusing the .layer-item/.layer-visibility/.layer-name
        // hooks so the editor's existing listeners (toggle, select, rename) apply.
        var faIcon   = item.iconType || 'square';
        var faStyle  = item.isSolid ? 'fas' : 'far';
        var slashCls = ['square', 'circle', 'comment-dots'].indexOf(faIcon) === -1 ? 'slash-icon' : '';
        var tileName = item.label || item.name || '';
        html += '<div class="layer-item' + (item.id === activeLayerId ? ' active' : '') + '"'
              + ' data-id="' + esc(item.id) + '" style="padding-left:' + indent + 'px" draggable="true">'
              + '<input type="checkbox" class="layer-visibility"' + (item.visible ? ' checked' : '') + ' title="Toggle visibility"/>'
              + '<i class="' + faStyle + ' fa-' + esc(faIcon) + ' ' + slashCls + '" style="color:' + esc(item.iconColor || item.color || '#888') + ';width:16px;text-align:center"></i>'
              + '<span class="layer-name" title="Double-click to rename">' + esc(tileName) + '</span>'
              + '<div class="layer-buttons-block"><div class="layer-buttons-list">'
              +   '<i class="fa fa-crosshairs zoom-to-layer" title="Zoom to Layer" onclick="zoomToLayer(\'' + esc(tileName) + '\')"></i>'
              + (item.infoId ? '<i class="fa fa-info-circle layer-info trigger-popup" id="' + esc(item.infoId) + '" title="Layer Info"></i>' : '')
              + '</div></div>'
              + '</div>';
      } else {
        var svgIcons = {
          Point:      '<circle cx="8" cy="8" r="5" fill="CLR"/>',
          LineString: '<line x1="2" y1="14" x2="14" y2="2" stroke="CLR" stroke-width="2.5" stroke-linecap="round"/>',
          Polygon:    '<polygon points="8,2 14,6 12,13 4,13 2,6" fill="none" stroke="CLR" stroke-width="2" stroke-linejoin="round"/>'
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
    var el = document.getElementById('layers-panel-content');

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
      cb.addEventListener('click', function (e) { e.stopPropagation(); });
      cb.addEventListener('change', function () { toggleLayerVisibility(id, this.checked); });

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
        if (id !== activeLayerId) setActiveLayer(id);
      });
    });

    el.querySelectorAll('.feature-item').forEach(function (fDiv) {
      var fid = fDiv.dataset.id;
      fDiv.addEventListener('click', function (e) {
        e.stopPropagation();
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
    var el = document.getElementById('layers-panel-content');
    el.innerHTML = buildLayerHTML(layers, 0);
    attachLayerListeners();
    syncDrawDisplay();
  }

  function toggleLayerVisibility(layerId, visible) {
    var layer = findLayer(layerId);
    if (!layer) return;
    layer.visible = visible;
    if (layer.source_type && layer.source_type !== 'geojson-supabase') setTilesetVisibility(layer, visible);
    else syncDrawDisplay();
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
    features[selectedDrawId].dirty = true;
    scheduleSave();
  });

  document.getElementById('feature-notes').addEventListener('input', function () {
    if (!selectedDrawId || !features[selectedDrawId]) return;
    features[selectedDrawId].notes = this.value;
    features[selectedDrawId].dirty = true;
    scheduleSave();
  });

  document.getElementById('delete-feature-btn').addEventListener('click', function () {
    if (!selectedDrawId) return;
    draw.delete(selectedDrawId);
    removeFeatureFromState(selectedDrawId);
    closeFeaturePanel();
    renderLayerList();
    scheduleSave();
  });

  // ── Add Layer / Group / Section ───────────────────────────────────────────────
  var _pendingAddType = null;
  var _addBtns = ['add-layer-btn', 'add-group-btn', 'add-section-btn'].map(function (id) {
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
          scheduleSave();
        } else if (_pendingAddType === 'group') {
          layers.push({ id: 'group-' + Date.now() + '-' + Math.random().toString(36).slice(2), name: name, type: 'group', open: true, children: [] });
          renderLayerList(); scheduleSave();
        } else if (_pendingAddType === 'section') {
          layers.push({ id: 'section-' + Date.now() + '-' + Math.random().toString(36).slice(2), name: name, type: 'section', open: true, children: [] });
          renderLayerList(); scheduleSave();
        }
      }
      closeAddInput();
    }
    if (e.key === 'Escape') closeAddInput();
  });

  document.getElementById('add-layer-btn').addEventListener('click',   function () { openAddInput('layer'); });
  document.getElementById('add-group-btn').addEventListener('click',   function () { openAddInput('group'); });
  document.getElementById('add-section-btn').addEventListener('click', function () { openAddInput('section'); });

  // ── Project name ─────────────────────────────────────────────────────────────
  document.getElementById('project-name').addEventListener('blur', function () {
    scheduleSave();
  });
  document.getElementById('project-name').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); this.blur(); }
  });

  // ── Autosave (relational schema) ─────────────────────────────────────────────
  var _saveTimer   = null;
  var _saving      = false;
  var _savePending = false;

  function scheduleSave() {
    clearTimeout(_saveTimer);
    _saveTimer = setTimeout(saveProject, 1200);
  }

  async function saveProject() {
    if (!projectId) return;
    if (_saving) { _savePending = true; return; }
    _saving = true;
    try {
      await doSave();
      setSaveStatus('Saved');
    } catch (err) {
      setSaveStatus('');
      showToast('Save failed: ' + err.message, true);
    }
    _saving = false;
    if (_savePending) { _savePending = false; scheduleSave(); }
  }

  function setSaveStatus(msg) {
    var el = document.getElementById('save-status');
    if (el) {
      el.textContent = msg;
      if (msg) setTimeout(function () { el.textContent = ''; }, 2000);
    }
  }

  function fail(res, what) {
    if (res.error) throw new Error(what + ': ' + res.error.message);
    return res;
  }

  async function doSave() {
    // 1. Project name
    var name = document.getElementById('project-name').textContent.trim() || 'Untitled Map';
    fail(await db.from('projects')
      .update({ name: name, updated_at: new Date().toISOString() })
      .eq('id', projectId), 'project');

    // 2. Ensure a layers row for every leaf layer
    var leaves = flatLayers();
    for (var i = 0; i < leaves.length; i++) {
      var l = leaves[i];
      var srcType = l.source_type || 'geojson-supabase';
      var isDrawn = srcType === 'geojson-supabase';
      var row = {
        name:        l.name,
        color:       l.color || null,
        // Drawn layers store the Mapbox-GL geometry type (Polygon→fill, …);
        // tileset layers keep the source type they were loaded with, untouched.
        type:        isDrawn ? (TYPE_TO_DB[l.type] || null) : (l.type || null),
        source_type: srcType,
        paint:       l.paint || null,
        user_id:     userId,
        updated_at:  new Date().toISOString()
      };
      if (!l.dbId) {
        var ins = fail(await db.from('layers').insert(row).select('id').single(), 'layer insert');
        l.dbId = ins.data.id;
      } else {
        fail(await db.from('layers').update(row).eq('id', l.dbId), 'layer update');
      }
    }

    // 3. Rewrite structure (sections, groups, project_layers) from the tree
    fail(await db.from('project_layers').delete().eq('project_id', projectId), 'project_layers clear');
    if (_persistedGroupIds.length)
      fail(await db.from('layer_groups').delete().in('id', _persistedGroupIds), 'groups clear');
    if (_persistedSectionIds.length)
      fail(await db.from('layer_sections').delete().in('id', _persistedSectionIds), 'sections clear');

    var sortCounter   = 0;
    var newSectionIds = [];
    var newGroupIds   = [];
    var plRows        = [];

    async function walk(arr, sectionDbId, groupDbId) {
      for (var i = 0; i < arr.length; i++) {
        var item = arr[i];
        var order = sortCounter++;
        if (item.type === 'section') {
          var sres = fail(await db.from('layer_sections')
            .insert({ project_id: projectId, name: item.name, sort_order: order })
            .select('id').single(), 'section insert');
          newSectionIds.push(sres.data.id);
          await walk(item.children || [], sres.data.id, null);
        } else if (item.type === 'group') {
          var gres = fail(await db.from('layer_groups')
            .insert({ section_id: sectionDbId, name: item.name, sort_order: order })
            .select('id').single(), 'group insert');
          newGroupIds.push(gres.data.id);
          await walk(item.children || [], sectionDbId, gres.data.id);
        } else {
          plRows.push({
            project_id: projectId,
            layer_id:   item.dbId,
            sort_order: order,
            section_id: sectionDbId,
            group_id:   groupDbId
          });
        }
      }
    }
    await walk(layers, null, null);
    if (plRows.length)
      fail(await db.from('project_layers').insert(plRows), 'project_layers insert');
    _persistedSectionIds = newSectionIds;
    _persistedGroupIds   = newGroupIds;

    // 4. Features — insert new, update dirty, delete removed
    var currentDbIds = {};
    var drawIds = Object.keys(features);
    for (var j = 0; j < drawIds.length; j++) {
      var fid   = drawIds[j];
      var meta  = features[fid];
      var layer = findLayer(meta.layerId);
      var feat  = draw.get(fid);
      if (!layer || !layer.dbId || !feat) continue;

      if (!meta.dbId) {
        var fres = fail(await db.from('features').insert({
          layer_id:    layer.dbId,
          geom:        JSON.stringify(feat.geometry),
          label:       meta.label || null,
          description: meta.notes || null
        }).select('feature_id').single(), 'feature insert');
        meta.dbId  = fres.data.feature_id;
        meta.dirty = false;
      } else if (meta.dirty) {
        fail(await db.from('features').update({
          layer_id:    layer.dbId,
          geom:        JSON.stringify(feat.geometry),
          label:       meta.label || null,
          description: meta.notes || null,
          updated_at:  new Date().toISOString()
        }).eq('feature_id', meta.dbId), 'feature update');
        meta.dirty = false;
      }
      currentDbIds[meta.dbId] = true;
    }

    var toDelete = Object.keys(_persistedFeatureDbIds).filter(function (dbid) {
      return !currentDbIds[dbid];
    });
    if (toDelete.length)
      fail(await db.from('features').delete().in('feature_id', toDelete), 'feature delete');
    _persistedFeatureDbIds = currentDbIds;
  }

  // ── Load ─────────────────────────────────────────────────────────────────────
  async function loadProject(id) {
    var pres = await db.from('projects').select('id, name, center_lng, center_lat, zoom').eq('id', id).single();
    if (pres.error || !pres.data) { showToast('Project not found', true); return; }
    projectId = pres.data.id;
    document.getElementById('project-name').textContent = pres.data.name || 'Untitled Map';

    // The maps were created at parse time with the template's default view, and
    // `hash: true` writes a URL hash before this async load runs — so a hash is
    // effectively always present and can't gate this. Always jump to the
    // project's saved view (mirrors the viewer's projectLoader).
    if (pres.data.center_lng != null && pres.data.zoom != null) {
      var _view = { center: [pres.data.center_lng, pres.data.center_lat], zoom: pres.data.zoom };
      [beforeMap, afterMap].forEach(function (m) { if (m) m.jumpTo(_view); });
    }

    try {
      // Structure
      var sres = fail(await db.from('layer_sections').select('*')
        .eq('project_id', projectId).order('sort_order'), 'sections load');
      var plres = fail(await db.from('project_layers').select('*, layers(*)')
        .eq('project_id', projectId).order('sort_order'), 'layers load');

      var sectionIds = sres.data.map(function (s) { return s.id; });
      var plGroupIds = plres.data.map(function (pl) { return pl.group_id; }).filter(Boolean);
      var groupIdSet = {};
      var allGroupIds = [];
      plGroupIds.forEach(function (gid) { if (!groupIdSet[gid]) { groupIdSet[gid] = true; allGroupIds.push(gid); } });

      var gdata = [];
      if (sectionIds.length) {
        var gres = fail(await db.from('layer_groups').select('*')
          .in('section_id', sectionIds).order('sort_order'), 'groups load');
        gdata = gres.data;
      }
      // Top-level groups (no section) are only recoverable through project_layers
      var missingGroupIds = allGroupIds.filter(function (gid) {
        return !gdata.some(function (g) { return g.id === gid; });
      });
      if (missingGroupIds.length) {
        var gres2 = fail(await db.from('layer_groups').select('*')
          .in('id', missingGroupIds).order('sort_order'), 'groups load 2');
        gdata = gdata.concat(gres2.data);
      }

      // Rebuild the tree: every item carries its global sort_order, then each
      // level is sorted by it (save walks the tree with one global counter).
      layers = [];
      var sectionNodes = {};
      var groupNodes   = {};

      sres.data.forEach(function (s) {
        var node = { id: 'section-' + s.id, name: s.name, type: 'section', open: true, children: [], _sort: s.sort_order || 0 };
        sectionNodes[s.id] = node;
        layers.push(node);
      });
      gdata.forEach(function (g) {
        var node = { id: 'group-' + g.id, name: g.name, type: 'group', open: true, children: [], _sort: g.sort_order || 0 };
        groupNodes[g.id] = node;
        if (g.section_id && sectionNodes[g.section_id]) sectionNodes[g.section_id].children.push(node);
        else layers.push(node);
      });

      var layerNodesByDbId = {};
      plres.data.forEach(function (pl) {
        var lrow = pl.layers;
        if (!lrow) return;
        var isDrawn = lrow.source_type === 'geojson-supabase';
        // Engine-shaped display/render fields (source, source-layer, paint,
        // highlight, zoomCenter, infoId, panel, …raw_config) — the same shape the
        // viewer uses — so the unified tree and the engine's addMapLayer render
        // tileset layers with full fidelity. Mirror of the seeder/viewer adapter.
        var node = ConfigLoader.leafFromRow(
          lrow, typeof renderRegistry !== 'undefined' ? renderRegistry : {}
        );
        // Editor identity + edit state, kept distinct from the engine's id=slug
        // scheme: the tree keys on 'layer-'+dbId and carries dbId for persistence,
        // name for inline rename, and type in the draw model's vocabulary.
        node.id          = 'layer-' + lrow.id;
        node.dbId        = lrow.id;
        node.name        = lrow.name;
        node.source_type = lrow.source_type;
        node.type        = isDrawn ? (DB_TO_TYPE[lrow.type] || null) : (lrow.type || null);
        node.color       = lrow.color || '#888888';
        node.visible     = true;
        node.featureIds  = [];
        node._sort       = pl.sort_order || 0;
        if (isDrawn && !node.paint) {
          node.paint = { 'fill-color': node.color, 'fill-outline-color': '#000000', 'fill-opacity': 0.5 };
        }
        layerNodesByDbId[lrow.id] = node;
        if (pl.group_id && groupNodes[pl.group_id])          groupNodes[pl.group_id].children.push(node);
        else if (pl.section_id && sectionNodes[pl.section_id]) sectionNodes[pl.section_id].children.push(node);
        else layers.push(node);
      });

      function sortTree(arr) {
        arr.sort(function (a, b) { return (a._sort || 0) - (b._sort || 0); });
        arr.forEach(function (n) { if (n.children) sortTree(n.children); });
      }
      sortTree(layers);

      _persistedSectionIds = sectionIds;
      _persistedGroupIds   = allGroupIds.concat(gdata.map(function (g) { return g.id; })).filter(function (gid, i, a) {
        return a.indexOf(gid) === i;
      });

      // Features
      _persistedFeatureDbIds = {};
      var layerDbIds = Object.keys(layerNodesByDbId);
      var drawFeats  = [];
      if (layerDbIds.length) {
        var fres = fail(await db.from('features')
          .select('feature_id, layer_id, label, description, geom')
          .in('layer_id', layerDbIds), 'features load');
        fres.data.forEach(function (f) {
          if (!f.geom) return;
          var drawId = 'db-' + f.feature_id;
          var node   = layerNodesByDbId[f.layer_id];
          if (!node) return;
          features[drawId] = { label: f.label || '', notes: f.description || '', layerId: node.id, dbId: f.feature_id, dirty: false };
          node.featureIds.push(drawId);
          _persistedFeatureDbIds[f.feature_id] = true;
          drawFeats.push({ type: 'Feature', id: drawId, geometry: f.geom, properties: {} });
        });
      }
      draw.set({ type: 'FeatureCollection', features: drawFeats });

      var fl = flatLayers();
      if (fl.length) setActiveLayer(fl[fl.length - 1].id); else renderLayerList();
      if (map.getSource(_DRAW_SRC)) syncDrawDisplay(); else map.once('style.load', syncDrawDisplay);
      paintTilesets();
    } catch (err) {
      showToast('Load failed: ' + err.message, true);
      renderLayerList();
    }
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
    if (features[id]) features[id].dirty = true;
    syncDrawDisplay();
    scheduleSave();
  }

  function updateToolbar() {
    document.getElementById('btn-undo').disabled = !undoStack.length;
    document.getElementById('btn-redo').disabled = !redoStack.length;
  }

  // ── Keyboard shortcuts ───────────────────────────────────────────────────────
  document.addEventListener('keydown', function (e) {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;
    var mod = e.ctrlKey || e.metaKey;
    if (mod && e.key === 'z' && !e.shiftKey)                     { e.preventDefault(); performUndo(); }
    if (mod && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) { e.preventDefault(); performRedo(); }
  });

  // ── Toolbar buttons ──────────────────────────────────────────────────────────
  document.getElementById('btn-undo').addEventListener('click', performUndo);
  document.getElementById('btn-redo').addEventListener('click', performRedo);

  // ── Layer-list drag (container-level) ────────────────────────────────────────
  function initLayerListDrag() {
    var list = document.getElementById('layers-panel-content');

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
    document.querySelectorAll('#layers-panel-content .drop-before').forEach(function (el) { el.classList.remove('drop-before'); });
    document.querySelectorAll('#layers-panel-content .drop-into').forEach(function (el) { el.classList.remove('drop-into'); });
    var list = document.getElementById('layers-panel-content');
    if (list) list.classList.remove('drop-after-last');
  }

  // ── Engine map-layer shim + tileset painting ─────────────────────────────────
  // The engine's addLayersToMap (run on every style.load) iterates *all* leaves,
  // including drawn ones — which have no map source and a geometry-name type, so
  // mapboxgl.addLayer would throw. Wrap the engine's global addMapLayer to skip
  // drawn/sourceless layers, never double-add, and swallow per-layer errors, so
  // both the engine's style.load pass and paintTilesets() are safe + idempotent.
  if (typeof window.addMapLayer === 'function' && !window._addMapLayerWrapped) {
    var _engineAddMapLayer = window.addMapLayer;
    window.addMapLayer = function (m, layerConfig, date) {
      if (!layerConfig || !layerConfig.source) return;            // drawn / sourceless
      if (layerConfig.source_type === 'geojson-supabase') return; // drawn
      if (m && m.getLayer && m.getLayer(layerConfig.id)) return;  // already present
      try { return _engineAddMapLayer(m, layerConfig, date); }
      catch (e) { console.warn('addMapLayer skipped', layerConfig && layerConfig.id, e && e.message); }
    };
    window._addMapLayerWrapped = true;
  }

  // Paint tileset (non-drawn) layers onto both swipe maps. Unfiltered by date —
  // the editor previews all features; timeline filtering is a later concern.
  // NB: we add from the editor's LOCAL `layers` tree, not via the engine's
  // addLayersToMap — that reads the GLOBAL `layers` (the empty template array)
  // which draw.js shadows, so it would paint nothing. Re-add on every style.load
  // so basemap switches (which rebuild the style from scratch) repaint.
  function paintTilesets() {
    if (typeof addMapLayer !== 'function') return;
    [[beforeMap, 'left'], [afterMap, 'right']].forEach(function (pair) {
      var m = pair[0], side = pair[1];
      if (!m) return;
      var add = function () {
        flatLayers().forEach(function (l) {
          if (!l.source || l.source_type === 'geojson-supabase') return;
          addMapLayer(m, Object.assign({}, l, { id: l.id + '-' + side }));
        });
      };
      if (m.isStyleLoaded()) add();
      m.on('style.load', add);
      // The left map's basemap setStyle can resolve before this runs and never
      // re-fire style.load — `idle` (fires whenever rendering settles, incl. after
      // a basemap rebuild) is the reliable catch-all; the shim's dup-guard makes
      // repeated calls cheap and safe.
      m.on('idle', add);
    });
  }

  // Toggle a tileset layer's visibility on both maps (drawn layers instead go
  // through syncDrawDisplay).
  function setTilesetVisibility(layer, visible) {
    [[beforeMap, 'left'], [afterMap, 'right']].forEach(function (pair) {
      var m = pair[0], id = layer.id + '-' + pair[1];
      if (m && m.getLayer(id)) m.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
    });
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

  // ── Style panel ───────────────────────────────────────────────────────────────
  function openEditor() {
    var panel = document.getElementById('draw-panel');
    if (!_layer) {
      panel.classList.add('hidden');
      return;
    }
    panel.classList.remove('hidden');
    document.getElementById('draw-layer-name').textContent = _layer.name;
    document.getElementById('draw-type-badge').textContent = _layer.type || 'draw';
    if (_activeTab === 'form') { renderForm(); syncJSON(); }
    else                       { document.getElementById('json-editor').value = JSON.stringify(_layer, null, 2); }
  }

  document.getElementById('draw-panel-close').addEventListener('click', function () {
    setActiveLayer(null);
  });

  function renderForm() {
    if (!_layer) return;
    var l = _layer;
    var html = '';
    html += fSection('Basic', [
      fRow('Name',       fText('f-name',       l.name  || '')),
      fRow('Icon Color', fColor('f-icon-color', l.color || '#888888')),
    ]);
    html += fSection('Style', [
      fRow('Fill Color',    fColor('f-fill-color',   paintVal(l, 'fill-color',         '#888888'))),
      fRow('Outline Color', fColor('f-fill-outline', paintVal(l, 'fill-outline-color', '#000000'))),
      fRow('Opacity',       fRange('f-fill-opacity', paintVal(l, 'fill-opacity',        0.5), 0, 1, 0.05)),
    ]);
    document.getElementById('tab-form').innerHTML = html;
  }

  document.getElementById('tab-form').addEventListener('input', function (e) {
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

  function collect() {
    if (!_layer) return;
    var el;
    if ((el = document.getElementById('f-name')))           _layer.name  = el.value;
    if ((el = document.getElementById('f-icon-color-txt'))) _layer.color = el.value;
    if (!_layer.paint) _layer.paint = {};
    if ((el = document.getElementById('f-fill-color-txt')))   _layer.paint['fill-color']         = el.value;
    if ((el = document.getElementById('f-fill-outline-txt'))) _layer.paint['fill-outline-color']  = el.value;
    if ((el = document.getElementById('f-fill-opacity')))     _layer.paint['fill-opacity']        = parseFloat(el.value);
    document.getElementById('draw-layer-name').textContent = _layer.name;
    syncJSON();
    syncDrawDisplay();
    renderLayerList();
    scheduleSave();
  }

  function syncJSON() {
    if (_activeTab === 'json') return;
    var ta = document.getElementById('json-editor');
    if (ta && _layer) ta.value = JSON.stringify(_layer, null, 2);
  }

  function initTabs() {
    document.querySelectorAll('#draw-panel .tab-btn').forEach(function (btn) {
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
            syncDrawDisplay();
            renderLayerList();
            scheduleSave();
          } catch (err) { ta.classList.add('json-error'); return; }
        }
        _activeTab = to;
        document.querySelectorAll('#draw-panel .tab-btn').forEach(function (b) {
          b.classList.toggle('active', b.dataset.tab === to);
        });
        document.getElementById('tab-form').style.display = to === 'form' ? '' : 'none';
        document.getElementById('tab-json').style.display = to === 'json' ? '' : 'none';
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
