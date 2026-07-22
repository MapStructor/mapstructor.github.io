function renderGroupNode(groupNode) {
  let r = "";
  r += renderLayerRow(groupNode, groupNode.label);
  groupNode.children.forEach(child => {
    r += renderGroupLayerItem(child, groupNode.label, groupNode.collapsed);
  });
  return r;
}

// Row buttons — ▦ features/table FIRST (user 7/21), then ℹ info (only when that layer has info
// content), then ⌖ zoom. The EDITOR (window.__msEditorAttr) always shows ▦ on leaves; when the layer
// opted out of the view-mode list (raw_config.tableBtn === false, same convention as zoomBtn) the ▦
// keeps its table glyph but gets the amber strike-through (.ms-tbl-off, engine.css) so the owner sees
// the state — clicking it still opens the table. The VIEWER shows ▦ only when viewerTable.js is
// present (window.__msViewerAttr), the layer has DB rows behind it (drawn or converted — external
// tilesets have no rows), and it wasn't opted out.
function layerRowButtons(layerData, zoomName, isLeaf) {
  const infoKey = layerData.infoId || ((layerData.id || "") + "-info");
  const hasInfo = typeof window !== "undefined" && window.modal_content_html && window.modal_content_html[infoKey];
  const infoBtn = hasInfo ? `<i class="fa fa-info-circle layer-info trigger-popup" id="${infoKey}" title="Layer Info"></i>` : "";
  const zn = String(zoomName == null ? "" : zoomName).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  // zoomBtn === false (raw_config.zoomBtn, per layer/group) hides the row's ⌖ — default is shown
  const zoomBtn = layerData.zoomBtn === false ? "" : `<i class="fa fa-crosshairs zoom-to-layer" onclick="zoomToLayer('${zn}')" title="Zoom to Layer"></i>`;
  const tblOff = layerData.tableBtn === false;
  let tableBtn = "";
  if (isLeaf && typeof window !== "undefined") {
    if (window.__msEditorAttr) tableBtn = tblOff
      ? `<i class="fa fa-table attr-table-btn ms-tbl-off" title="Attribute table — hidden in view mode (still opens for you)"></i>`
      : `<i class="fa fa-table attr-table-btn" title="Attribute table"></i>`;
    else if (window.__msViewerAttr && !tblOff && (layerData._layerDbId || layerData._dataLayerId) &&
             (layerData.pmtiles || (layerData.source && layerData.source.type === "geojson")))
      tableBtn = `<i class="fa fa-table attr-table-btn" title="Features list"></i>`;
  }
  return `<div class="layer-buttons-block"><div class="layer-buttons-list">${tableBtn}${infoBtn}${zoomBtn}</div></div>`;
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
        ${layerRowButtons(layerData, groupName, false)}
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
          <i class="${layerData.isSolid ? "fas" : "far"} fa-${layerData.iconType || "slash"} ${["square", "circle", "comment-dots"].includes(layerData.iconType) ? "" : "slash-icon"}${layerData.colorBy ? " multicolor-icon" : ""}" style="color: ${layerData.iconColor || "#ff0000"}"></i>
          ${layerData.label || ""}
        </label>
        ${layerRowButtons(layerData, layerData.label, true)}
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
          <i class="${layerData.isSolid ? "fas" : "far"} fa-${layerData.iconType || "slash"} ${["square", "circle", "comment-dots"].includes(layerData.iconType) ? "" : "slash-icon"}${layerData.colorBy ? " multicolor-icon" : ""}" style="color: ${layerData.iconColor || "#ff0000"}"></i>
          ${layerData.label}
        </label>
        ${layerRowButtons(layerData, layerData.label, true)}
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
      '<div class="ms-section-block" id="' + node.id + '">' +
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

function generateLayersPanel() {
  try {
    if (typeof layers !== 'undefined') {
      document.getElementById('layers-panel-content').innerHTML =
        layers.map(buildContainerHTML).join('');
      layers.forEach(node => processNode(node));
    }
  } catch(error) {
    console.log(error);
  }
}

// Platform projects (?id=<uuid>) load their config asynchronously;
// platform/projectLoader.js calls generateLayersPanel() once it arrives.
if (typeof platformProjectId === 'undefined' || !platformProjectId) generateLayersPanel();
