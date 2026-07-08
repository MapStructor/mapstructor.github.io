function generateMapHTML(map, idx) {
  return `
    <div class="layer-list-row" data-map-idx="${idx == null ? '' : idx}">
      <input class="${map.id}" type="radio" name="ltoggle" value="${map.id}" ${map.lChecked ? 'checked="checked"' : ''}/>
      <input class="${map.id}" type="radio" name="rtoggle" value="${map.id}" ${map.rChecked ? 'checked="checked"' : ''}/>
      &nbsp;
      <label for="${map.id}">${map.name}<div class="dummy-label-layer-space"></div></label>
      <div class="layer-buttons-block">
        <div class="layer-buttons-list">
          ${map.zoomFunction ? `<i class="fa fa-crosshairs zoom-to-layer" onclick="${map.zoomFunction}" title="Zoom to Layer"></i>` : ''}
          ${map.infoId ? `<i class="fa fa-info-circle layer-info trigger-popup" id="${map.infoId}" title="Layer Info"></i>` : ''}
        </div>
      </div>
    </div>
  `;
}

function generateBaseMapsPanel() {
  var secs = (typeof mapSections !== 'undefined' && mapSections) ? mapSections : [];
  var btns = (typeof zoomButtons !== 'undefined' && zoomButtons) ? zoomButtons : [];
  var escMs = function (s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); };
  var mapsFor = function (test) { return baseMaps.map(function (m, i) { return test(m) ? generateMapHTML(m, i) : ''; }).join(''); };
  var btnsFor = function (test) { return btns.map(function (b, i) { return test(b) ? generateZoomButtonHTML(b, i) : ''; }).join(''); };
  var top = function (x) { return !x.section || !secs.some(function (s) { return s.id === x.section; }); };
  var html = mapsFor(top) + btnsFor(top);
  secs.forEach(function (s) {
    html += '<p class="title map-section-title" data-mapsection="' + escMs(s.id) + '">' + escMs(s.name) + '</p>';
    html += mapsFor(function (m) { return m.section === s.id; }) + btnsFor(function (b) { return b.section === s.id; });
  });
  document.getElementById('base-maps-section').innerHTML = html;
  var zb = document.getElementById('zoom-buttons-section'); if (zb) zb.innerHTML = '';
}

// Match the ORIGINAL zoom-button look exactly (centered .zoom-labels button, icon + bold label, nbsp padding) —
// only wrapped in a div for editability (data-zbtn-idx) + the original <br><br> spacing as a margin.
function generateZoomButtonHTML(btn, idx) {
  return '<div class="zoom-btn-row" data-zbtn-idx="' + idx + '" style="position:relative;text-align:center;margin:16px 0;"><center>' +
    '<button onclick="mapstructorZoomButton(' + idx + ')" class="zoom-labels">' +
    '&nbsp; &nbsp; <i class="fa ' + (btn.icon || '') + '"></i> &nbsp; <b>' + (btn.label == null ? '' : btn.label) + '</b> &nbsp; &nbsp; &nbsp;' +
    '</button></center></div>';
}

// Combined bounds of the map's VISIBLE (checked) layers: geojson layers from their own feature data,
// vector tilesets from their tilejson bounds; in the editor, small drawn layers live in MapboxDraw
// (window._msDraw — optional, editor-only). Every source is individually guarded, so a missing piece
// just contributes nothing. Returns [minX, minY, maxX, maxY] or null (caller falls back to the default view).
function mapstructorLayersBounds() {
  var bb = null;
  function extend(b) {
    if (!b || b.length !== 4 || !isFinite(b[0]) || !isFinite(b[1]) || !isFinite(b[2]) || !isFinite(b[3])) return;
    if (!bb) bb = b.slice();
    else { bb[0] = Math.min(bb[0], b[0]); bb[1] = Math.min(bb[1], b[1]); bb[2] = Math.max(bb[2], b[2]); bb[3] = Math.max(bb[3], b[3]); }
  }
  try {
    (function walk(arr) {
      (arr || []).forEach(function (n) {
        try {
          if (n.children) { walk(n.children); return; }
          var cb = document.getElementById(n.toggleElement || n.id);
          if (cb ? !cb.checked : n.checked === false) return;   // only layers currently toggled ON
          if (n.source && n.source.type === 'geojson' && n.source.data && n.source.data.features && n.source.data.features.length) {
            if (typeof turf !== 'undefined') extend(turf.bbox(n.source.data));
          } else if (typeof beforeMap !== 'undefined' && beforeMap && beforeMap.getSource) {
            var s = beforeMap.getSource(n.id + '-left'); if (s && s.bounds) extend(s.bounds);   // tilesets: tilejson bounds
          }
        } catch (e) {}
      });
    })(typeof layers !== 'undefined' ? layers : []);
  } catch (e) {}
  try { if (window._msDraw && window._msDraw.getAll && typeof turf !== 'undefined') { var fc = window._msDraw.getAll(); if (fc.features.length) extend(turf.bbox(fc)); } } catch (e) {}
  return bb;
}

// A zoom button opens a URL in a new tab, flies to a captured view, zooms to the visible layers'
// combined extent (target "Layers" — falls back to the default view when there's nothing to measure),
// or (legacy) zooms to a bounds key.
function mapstructorZoomButton(idx) {
  var b = (typeof zoomButtons !== 'undefined') ? zoomButtons[idx] : null; if (!b) return;
  if (b.url) { window.open(b.url, '_blank'); return; }
  if (b.zoomCenter && typeof beforeMap !== 'undefined' && beforeMap) {
    beforeMap.flyTo({ center: b.zoomCenter, zoom: b.zoomLevel != null ? b.zoomLevel : beforeMap.getZoom(), bearing: 0 });
    if (typeof afterMap !== 'undefined' && afterMap) afterMap.flyTo({ center: b.zoomCenter, zoom: b.zoomLevel != null ? b.zoomLevel : afterMap.getZoom(), bearing: 0 });
    return;
  }
  if (b.target === 'Layers') {
    var bb = mapstructorLayersBounds();
    [typeof beforeMap !== 'undefined' ? beforeMap : null, typeof afterMap !== 'undefined' ? afterMap : null].forEach(function (m) {
      if (!m) return;
      try {
        if (bb) m.fitBounds([[bb[0], bb[1]], [bb[2], bb[3]]], { padding: 60, maxZoom: 16, bearing: 0 });
        else if (typeof mapConfig !== 'undefined') m.flyTo({ center: mapConfig.center, zoom: mapConfig.zoom, bearing: 0 });   // nothing drawn/visible yet → the default area
      } catch (e) {}
    });
    return;
  }
  if (b.target && typeof zoomtobounds === 'function') zoomtobounds(b.target);
}

// Platform projects (?id=<uuid>) load their config asynchronously;
// platform/projectLoader.js calls generateBaseMapsPanel() once it arrives.
if (typeof platformProjectId === 'undefined' || !platformProjectId) generateBaseMapsPanel();

// Called from mapinit.js after maps are initialized
function setupMapSwitching() {
  var rightInputs = document.getElementsByName("rtoggle");
  var leftInputs = document.getElementsByName("ltoggle");

  function switchRightLayer(layer) {
    var id = (typeof layer.className === "undefined") ? layer.target.className : layer.className;
    afterMap.setStyle("mapbox://styles/" + siteConfig.mapboxUsername + "/" + id);
  }

  function switchLeftLayer(layer) {
    var id = (typeof layer.className === "undefined") ? layer.target.className : layer.className;
    beforeMap.setStyle("mapbox://styles/" + siteConfig.mapboxUsername + "/" + id);
  }

  for (var i = 0; i < rightInputs.length; i++) {
    if (rightInputs[i].checked) switchRightLayer(rightInputs[i]);
    rightInputs[i].onchange = switchRightLayer;
  }

  for (var i = 0; i < leftInputs.length; i++) {
    if (leftInputs[i].checked) switchLeftLayer(leftInputs[i]);
    leftInputs[i].onchange = switchLeftLayer;
  }
}
