(function () {

var items = [
  { id: 1, type: 'harddrive', name: 'Macintosh HD', open: true, children: [
    { id: 2, type: 'folder', name: 'Roads', open: true, children: [
      { id: 3, type: 'file', name: 'roads.geojson' },
      { id: 4, type: 'file', name: 'highways.geojson' },
      { id: 5, type: 'file', name: 'railroads.geojson' },
    ]},
    { id: 6, type: 'file', name: 'buildings.geojson' },
    { id: 7, type: 'file', name: 'building_footprints.geojson' },
  ]},
  { id: 8, type: 'harddrive', name: 'External Drive', open: true, children: [
    { id: 9, type: 'folder', name: 'Water', open: true, children: [
      { id: 10, type: 'file', name: 'rivers.geojson' },
      { id: 11, type: 'file', name: 'lakes.geojson' },
    ]},
    { id: 12, type: 'file', name: 'parcels.geojson' },
  ]},
  { id: 13, type: 'file', name: 'landmarks.geojson' },
  { id: 14, type: 'file', name: 'points_of_interest.geojson' },
  { id: 15, type: 'file', name: 'boundaries.geojson' },
];

var nextId        = 100;
var dragId        = null;
var insertBeforeId = null;
var dropIntoId    = null;

// ── Render ────────────────────────────────────────────────────────────────────
function render() {
  document.getElementById('list').innerHTML = buildHTML(items, 0);
  attachItemListeners();
}

function buildHTML(arr, depth) {
  var html   = '';
  var indent = 12 + depth * 16;
  arr.forEach(function (item) {
    var isContainer = item.type === 'harddrive' || item.type === 'folder';
    html += '<div class="row ' + item.type + '" data-id="' + item.id + '"'
          + ' style="padding-left:' + indent + 'px" draggable="true">';
    if (isContainer) html += '<span class="toggle">' + (item.open ? '▾' : '▸') + '</span> ';
    html += esc(item.name);
    if (item.type === 'file' || (isContainer && item.children.length === 0)) html += '<span class="delete-btn">&#x2715;</span>';
    html += '</div>';
    if (isContainer && item.open && item.children && item.children.length) {
      html += buildHTML(item.children, depth + 1);
    }
  });
  return html;
}

// ── Per-item listeners (re-attached each render) ───────────────────────────────
function attachItemListeners() {
  document.querySelectorAll('.row').forEach(function (el) {
    var id = +el.dataset.id;

    el.addEventListener('dragstart', function (e) {
      dragId = id;
      e.dataTransfer.effectAllowed = 'move';
      setTimeout(function () { el.classList.add('dragging'); }, 0);
    });

    el.addEventListener('dragend', function () {
      dragId = null;
      el.classList.remove('dragging');
      clearIndicator();
    });

    var del = el.querySelector('.delete-btn');
    if (del) {
      del.addEventListener('click', function (e) {
        e.stopPropagation();
        var found = findItem(id);
        if (found) found.arr.splice(found.idx, 1);
        render();
      });
    }

    var toggle = el.querySelector('.toggle');
    if (toggle) {
      toggle.addEventListener('click', function (e) {
        e.stopPropagation();
        var found = findItem(id);
        if (found) found.item.open = !found.item.open;
        render();
      });
    }
  });
}

// ── Container listeners (set up once) ────────────────────────────────────────
function init() {
  var list = document.getElementById('list');

  list.addEventListener('dragover', function (e) {
    e.preventDefault();
    if (dragId === null) return;

    var els    = Array.from(list.querySelectorAll('.row:not(.dragging)'));
    var cursor = e.clientY;
    var newInsert  = null;
    var newInto    = null;

    for (var i = 0; i < els.length; i++) {
      var r = els[i].getBoundingClientRect();
      var isContainer = els[i].classList.contains('folder') || els[i].classList.contains('harddrive');
      var mid = r.top + r.height / 2;

      if (cursor < mid) {
        // top half — for containers, bottom part of top half = drop into
        if (isContainer && cursor >= r.top + r.height * 0.35) {
          newInto = +els[i].dataset.id;
        } else {
          newInsert = +els[i].dataset.id;
        }
        break;
      } else if (isContainer && cursor < r.bottom) {
        // bottom half of a container = drop into
        newInto = +els[i].dataset.id;
        break;
      }
      // bottom half of a file: continue to next item
    }

    if (newInsert === insertBeforeId && newInto === dropIntoId) return;
    insertBeforeId = newInsert;
    dropIntoId     = newInto;
    clearIndicator();

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
    if (!list.contains(e.relatedTarget)) { clearIndicator(); insertBeforeId = null; dropIntoId = null; }
  });

  list.addEventListener('drop', function (e) {
    e.preventDefault();
    clearIndicator();
    if (dragId === null) return;
    if (dropIntoId !== null) {
      moveItemInto(dragId, dropIntoId);
    } else {
      moveItemBefore(dragId, insertBeforeId);
    }
    insertBeforeId = null;
    dropIntoId = null;
  });

  var fileBtn    = document.getElementById('add-file-btn');
  var folderBtn  = document.getElementById('add-folder-btn');
  var hdBtn      = document.getElementById('add-hd-btn');
  var input      = document.getElementById('add-input');
  var pendingType = null;
  var allBtns    = [fileBtn, folderBtn, hdBtn];

  function openAddInput(type) {
    pendingType = type;
    allBtns.forEach(function (b) { b.style.display = 'none'; });
    input.style.display = '';
    input.value = '';
    input.focus();
  }

  function closeAddInput() {
    input.style.display = 'none';
    allBtns.forEach(function (b) { b.style.display = ''; });
    pendingType = null;
  }

  fileBtn.addEventListener('click', function () { openAddInput('file'); });
  folderBtn.addEventListener('click', function () { openAddInput('folder'); });
  hdBtn.addEventListener('click', function () { openAddInput('harddrive'); });

  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      var name = input.value.trim();
      if (name && pendingType) {
        var item = { id: nextId++, type: pendingType, name: name };
        if (pendingType !== 'file') { item.children = []; item.open = true; }
        items.push(item);
        render();
      }
      closeAddInput();
    }
    if (e.key === 'Escape') closeAddInput();
  });

  render();
}

function clearIndicator() {
  document.querySelectorAll('.drop-before').forEach(function (el) { el.classList.remove('drop-before'); });
  document.querySelectorAll('.drop-into').forEach(function (el) { el.classList.remove('drop-into'); });
  var list = document.getElementById('list');
  if (list) list.classList.remove('drop-after-last');
}

// ── Tree ops ──────────────────────────────────────────────────────────────────
function findItem(id, arr, parentType) {
  arr        = arr        || items;
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
  if (!cont) return;

  // Hard drives can't go inside anything
  if (from.item.type === 'harddrive') return;
  // Folders can't go inside another folder
  if (from.item.type === 'folder' && cont.item.type === 'folder') return;

  from.arr.splice(from.idx, 1);

  var cont2 = findItem(containerId);
  if (!cont2) { from.arr.splice(from.idx, 0, from.item); return; }

  cont2.item.children.push(from.item);
  cont2.item.open = true;
  render();
}

function moveItemBefore(fromId, toId) {
  var from = findItem(fromId);
  if (!from) return;

  // No-op: already in this position
  if (toId === null) {
    if (from.arr === items && from.idx === items.length - 1) return;
  } else {
    var check = findItem(toId);
    if (check && check.arr === from.arr && check.idx === from.idx + 1) return;
  }

  from.arr.splice(from.idx, 1);

  if (toId === null) {
    items.push(from.item);
    render();
    return;
  }

  var to = findItem(toId);
  if (!to) { from.arr.splice(from.idx, 0, from.item); return; }

  if (from.item.type === 'harddrive' && to.parentType !== null) {
    from.arr.splice(from.idx, 0, from.item); return;
  }
  if (from.item.type === 'folder' && to.parentType === 'folder') {
    from.arr.splice(from.idx, 0, from.item); return;
  }

  to.arr.splice(to.idx, 0, from.item);
  render();
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

init();

})();
