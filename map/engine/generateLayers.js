function renderGroupNode(groupNode) {
  let r = "";
  r += renderLayerRow(groupNode, groupNode.label);
  groupNode.children.forEach(child => {
    r += renderGroupLayerItem(child, groupNode.label, groupNode.collapsed);
  });
  return r;
}

function renderLayerRow(layerData, groupName) {
  const iconClass = layerData.collapsed ? "fa-plus-square" : "fa-minus-square";
  const html = `
      <div class="layer-list-row">
        <input
          type="checkbox"
          class="group_items"
          id="${layerData.id || "group_items"}"
          name="${layerData.name || "group_items"}"
          ${layerData.checked ? 'checked="checked"' : ""}
        />
        <i
          class="fas ${iconClass} compress-expand-icon"
          id="${layerData.caretId || "group-layer-caret"}"
          onclick="itemsCompressExpand('${layerData.itemSelector || ""}','#${layerData.caretId || ""}')"
        ></i>
        <label for="${layerData.id || "group_items"}">
          ${layerData.label || ""}
          <div class="dummy-label-layer-space"></div>
        </label>
        <div class="layer-buttons-block">
          <div class="layer-buttons-list">
            <i
              class="fa fa-crosshairs zoom-to-layer"
              onclick="zoomToLayer('${groupName}')"
              title="Zoom to Layer"
            ></i>
            <i
              class="fa fa-info-circle layer-info trigger-popup"
              id="${layerData.infoId || "group-info"}"
              title="Layer Info"
            ></i>
          </div>
        </div>
      </div>
    `;
  return html;
}

function renderGroupLayerItem(layerData, groupName, isGroupCollapsed) {
  const style = isGroupCollapsed ? 'style="display: none;"' : '';
  const html = `
      <div class="layer-list-row ${layerData.topLayerClass}_item" ${style}>
        &nbsp; &nbsp; &nbsp;
        <input
          type="checkbox"
          class="${layerData.className}"
          id="${layerData.id}"
          name="${layerData.name}"
          ${layerData.checked ? 'checked="checked"' : ""}
        />
        <label for="${layerData.id}">
          <i class="${layerData.isSolid ? "fas" : "far"} fa-${layerData.iconType || "slash"} ${["square", "circle", "comment-dots"].includes(layerData.iconType) ? "" : "slash-icon"}" style="color: ${layerData.iconColor || "#ff0000"}"></i>
          ${layerData.label || ""}
        </label>
      </div>
    `;
  return html;
}

function renderSingleLayer(layerData) {
  const html = `
      <div class="layer-list-row ${layerData.topLayerClass}_item">
        <input
          type="checkbox"
          class="${layerData.className}"
          id="${layerData.id}"
          name="${layerData.name}"
          ${layerData.checked ? 'checked="checked"' : ""}
        />
        <label for="${layerData.id}">
          <i class="${layerData.isSolid ? "fas" : "far"} fa-${layerData.iconType || "slash"} ${["square", "circle", "comment-dots"].includes(layerData.iconType) ? "" : "slash-icon"}" style="color: ${layerData.iconColor || "#ff0000"}"></i>
          ${layerData.label}
        </label>
        <div class="layer-buttons-block">
          <div class="layer-buttons-list">
            <i
              class="fa fa-crosshairs zoom-to-layer"
              onclick="zoomToLayer('${layerData.label}')"
              title="Zoom to Layer"
            ></i>
            <i
              class="fa fa-info-circle layer-info trigger-popup"
              id="${layerData.infoId}"
              title="Layer Info"
            ></i>
          </div>
        </div>
      </div>
    `;
  return html;
}

function setupGroupListeners(groupNode) {
  const groupCheckbox = $(`#${groupNode.id}`);
  if (groupCheckbox.length === 0) return;

  const childIds = groupNode.children.map(c => `#${c.id}`).join(", ");
  const $childCheckboxes = $(childIds);

  groupCheckbox.on('change', function () {
    const isChecked = $(this).is(':checked');
    $childCheckboxes.prop('checked', isChecked);
    if (typeof refreshLayers === 'function') refreshLayers();
  });

  $childCheckboxes.on('change', function () {
    const total = $childCheckboxes.length;
    const checked = $childCheckboxes.filter(':checked').length;
    groupCheckbox.prop('checked', total === checked);
  });
}

function buildContainerHTML(node) {
  if (node.type === "section") {
    var childHTML = node.children.map(buildContainerHTML).join('');
    return (
      '<div id="' + node.id + '">' +
        '<div class="layer-list-row" style="display:flex;justify-content:center;align-items:center">' +
          '<i class="fas fa-minus-square compress-expand-icon" id="' + node.caretId + '" style="margin-right:5px"' +
            ' onclick="sectionCompressExpand(\'#' + node.containerId + '\',\'#' + node.caretId + '\')"></i>' +
          '<label style="font-weight:bold;margin-bottom:0">' + node.label + '</label>' +
        '</div>' +
        '<div id="' + node.containerId + '">' + childHTML + '</div>' +
      '</div>'
    );
  } else if (node.containerId) {
    return '<div id="' + node.containerId + '"></div>';
  }
  return '';
}

function processNode(node) {
  if (node.type === "section") {
    node.children.forEach(child => processNode(child));
  } else if (node.type === "group") {
    $(`#${node.containerId}`).html(renderGroupNode(node));
    setupGroupListeners(node);
  } else if (node.containerId) {
    $(`#${node.containerId}`).html(renderSingleLayer(node));
  }
}

try {
  if (typeof layers !== 'undefined') {
    document.getElementById('layers-panel-content').innerHTML =
      layers.map(buildContainerHTML).join('');
    layers.forEach(node => processNode(node));
  }
} catch(error) {
  console.log(error);
}
