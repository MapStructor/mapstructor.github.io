/* editing.js — the ONLY editor-specific code, loaded dead-last in editor_temp.html.
   It adds editing chrome ON TOP of the viewer and never changes how the viewer
   renders. The engine renders the layer tree (generateLayersPanel); editing.js
   mutates the shared `layers` config and asks the engine to re-render, so the tree
   is always byte-identical to the viewer — only the editing chrome is added.

   Slice 1: anonymous sign-in (for saving), and the +Layer/+Group/+Section bar.
   New items are added to the in-memory config and re-rendered through the engine.
   Slice 2 will persist to the database. */
(function () {
  if (typeof platformProjectId === 'undefined' || !platformProjectId) return;

  var SUPABASE_URL = 'https://eqpxlwbjqiwfjlsuapvu.supabase.co';
  var SUPABASE_KEY = 'sb_publishable_ijLmSmMUeNBrgMGL8Aol4g_S5-xwUzD';
  var db = (window.supabase) ? window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY) : null;
  var userId = null;

  // Anonymous sign-in — only needed for saving; never blocks the UI.
  if (db) {
    db.auth.getSession().then(function (r) {
      if (r.data.session) { userId = r.data.session.user.id; }
      else db.auth.signInAnonymously().then(function (r2) { if (r2.data.session) userId = r2.data.session.user.id; });
    });
  }

  // Re-render the tree through the ENGINE so edited/added items look native.
  function rerender() {
    if (typeof generateLayersPanel === 'function') generateLayersPanel();
  }

  function uid() { return 'new-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

  // Build an engine-shaped node (the fields generateLayers needs to render it).
  function makeNode(type, name) {
    var id = uid();
    if (type === 'section') {
      return { type: 'section', id: id, label: name, caretId: 'caret-' + id, containerId: 'cont-' + id, children: [] };
    }
    if (type === 'group') {
      return { type: 'group', id: id, label: name, caretId: 'caret-' + id, containerId: 'cont-' + id,
               itemSelector: '.' + id + '_item', children: [], checked: true };
    }
    // A new (empty) layer — drawing/styling arrives in a later slice.
    return { id: id, label: name, containerId: 'cont-' + id, className: id, topLayerClass: id,
             iconType: 'square', iconColor: '#4a9eff', isSolid: true, checked: true };
  }

  function addItem(type) {
    var name = window.prompt('Name for the new ' + type + ':', '');
    if (!name) return;
    if (typeof layers === 'undefined') return;
    layers.push(makeNode(type, name));
    rerender();
    // Slice 2: persist to layer_sections / layer_groups / layers + project_layers.
  }

  // Additive chrome: an add bar inserted right after the layer tree. It is a
  // sibling of #layers-panel-content, so the engine's re-render (which replaces
  // only #layers-panel-content's contents) never removes it.
  function injectChrome() {
    var panel = document.getElementById('layers-panel-content');
    if (!panel || document.getElementById('editor-add-bar')) return;

    var style = document.createElement('style');
    style.textContent =
      '#editor-add-bar{display:flex;gap:6px;padding:8px 6px;}' +
      '#editor-add-bar button{flex:1;padding:6px 0;border:none;border-radius:4px;cursor:pointer;' +
        'font-size:12px;font-weight:600;background:#eef1f5;color:#23374d;}' +
      '#editor-add-bar button:hover{background:#dfe6ed;}';
    document.head.appendChild(style);

    var bar = document.createElement('div');
    bar.id = 'editor-add-bar';
    bar.innerHTML =
      '<button data-type="layer">+ Layer</button>' +
      '<button data-type="group">+ Group</button>' +
      '<button data-type="section">+ Section</button>';
    panel.parentNode.insertBefore(bar, panel.nextSibling);
    bar.querySelectorAll('button').forEach(function (b) {
      b.addEventListener('click', function () { addItem(b.getAttribute('data-type')); });
    });
  }

  // The engine renders the tree during boot (projectLoader re-runs it once the DB
  // config arrives). Wait for the panel, then add our chrome.
  (function whenReady() {
    if (document.getElementById('layers-panel-content')) injectChrome();
    else setTimeout(whenReady, 150);
  })();
})();
