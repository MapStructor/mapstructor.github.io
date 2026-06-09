function generateMapHTML(map) {
  return `
    <div class="layer-list-row">
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

document.getElementById('base-maps-section').innerHTML = baseMaps.map(generateMapHTML).join('');

document.getElementById('zoom-buttons-section').innerHTML =
  '<center>' +
  zoomButtons.map(function(b) {
    return '<button onclick="zoomtobounds(\'' + b.target + '\')" class="zoom-labels">' +
      '&nbsp; &nbsp; <i class="fa ' + b.icon + '"></i> &nbsp; <b>' + b.label + '</b> &nbsp; &nbsp; &nbsp;' +
      '</button>';
  }).join('<br /><br />') +
  '</center>';

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
