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

// A zoom button opens a URL in a new tab, flies to a captured view, or (legacy) zooms to a bounds key.
function mapstructorZoomButton(idx) {
  var b = (typeof zoomButtons !== 'undefined') ? zoomButtons[idx] : null; if (!b) return;
  if (b.url) { window.open(b.url, '_blank'); return; }
  if (b.zoomCenter && typeof beforeMap !== 'undefined' && beforeMap) {
    beforeMap.flyTo({ center: b.zoomCenter, zoom: b.zoomLevel != null ? b.zoomLevel : beforeMap.getZoom(), bearing: 0 });
    if (typeof afterMap !== 'undefined' && afterMap) afterMap.flyTo({ center: b.zoomCenter, zoom: b.zoomLevel != null ? b.zoomLevel : afterMap.getZoom(), bearing: 0 });
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
