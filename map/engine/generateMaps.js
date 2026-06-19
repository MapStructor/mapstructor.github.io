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
  var escMs = function (s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); };
  var rowsFor = function (test) { return baseMaps.map(function (m, i) { return test(m) ? generateMapHTML(m, i) : ''; }).join(''); };
  var mapsHtml = rowsFor(function (m) { return !m.section || !secs.some(function (s) { return s.id === m.section; }); });
  secs.forEach(function (s) {
    mapsHtml += '<p class="title map-section-title" data-mapsection="' + escMs(s.id) + '">' + escMs(s.name) + '</p>';
    mapsHtml += rowsFor(function (m) { return m.section === s.id; });
  });
  document.getElementById('base-maps-section').innerHTML = mapsHtml;

  document.getElementById('zoom-buttons-section').innerHTML =
    '<center>' +
    zoomButtons.map(function(b) {
      return '<button onclick="zoomtobounds(\'' + b.target + '\')" class="zoom-labels">' +
        '&nbsp; &nbsp; <i class="fa ' + b.icon + '"></i> &nbsp; <b>' + b.label + '</b> &nbsp; &nbsp; &nbsp;' +
        '</button>';
    }).join('<br /><br />') +
    '</center>';
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
