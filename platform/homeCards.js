// homeCards.js — front-page maps grid, now organized into CATEGORIES (Featured / History /
// Conservation / More maps by default; the owner can rename, reorder, add, and delete them).
// The grid seeds from config.js (PROJECTS) so the page always renders even with the DB down; a
// saved layout in site_content (KEY, JSON — deliberately NOT a data-edit region, pageEditor would
// inject raw JSON as HTML) overrides it for every visitor. The owner gets an "✎ Edit maps" button:
// add / edit / hide / drag-reorder cards within a category, plus manage the categories themselves.
// Cards are soft-HIDDEN, never deleted; empty categories are hidden from visitors, shown to the owner.
(function () {
  var ADMIN_EMAILS = ['nittyjee@gmail.com'];   // same owner gate as pageEditor (client seam; RLS at lockdown)
  var SB_URL = 'https://eqpxlwbjqiwfjlsuapvu.supabase.co';
  var SB_KEY = 'sb_publishable_ijLmSmMUeNBrgMGL8Aol4g_S5-xwUzD';
  var KEY = 'home-projects-json';
  var BUCKET = 'feature-images';               // existing public bucket (anon-insert RLS) — thumbs go under site/
  var LOGO = 'images/nittygrittymapping_logo.png';
  var DEFAULT_CATEGORIES = ['Featured', 'History', 'Conservation', 'More maps'];
  var SEED_CATEGORY = 'More maps';             // where the config.js seed + un-categorized cards land

  function db() { return (window.MapAuth && MapAuth.db) || (window.supabase && supabase.createClient(SB_URL, SB_KEY)) || null; }
  function esc(s) { return String(s == null ? '' : s).replace(/[<>&"]/g, function (c) { return ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]; }); }
  // only http(s)/relative URLs survive into cards (no javascript: etc.)
  function safeUrl(u) { u = String(u == null ? '' : u).trim(); if (!u) return ''; return /^\s*(javascript|data|vbscript):/i.test(u) ? '' : u; }

  var state = null;          // { categories:[name,…], cards:[{title,thumb,github,live,badge,hidden,category}] }
  var savedSnapshot = null;  // for Cancel
  var managing = false;
  var dragIdx = null;        // index into state.cards being dragged

  function container() { return document.getElementById('card-rows'); }
  function toolbar() { return document.getElementById('maps-toolbar'); }

  function ensureCss() {
    if (document.getElementById('hc-css')) return;
    var s = document.createElement('style'); s.id = 'hc-css';
    s.textContent =
      '#hc-edit-btn{display:inline-block;background:#efeaf8;color:#4a3f66;border:1px solid #d9cff1;border-radius:16px;padding:4px 14px;font:600 12px "Source Sans Pro",Arial,sans-serif;cursor:pointer;}' +
      '#hc-edit-btn:hover{background:#e5dcf6;}' +
      '.hc-dim{opacity:.45;}' +
      '.hc-cathead{display:flex;align-items:center;gap:6px;margin-bottom:16px;}' +
      '.hc-catname{font:700 11px "Source Sans Pro",Arial,sans-serif;letter-spacing:.1em;text-transform:uppercase;color:#7c5cbf;border:1px solid #ddd6ef;border-radius:6px;padding:4px 8px;background:#faf9fd;min-width:160px;}' +
      '.hc-cathead button{border:1px solid #ddd;border-radius:6px;background:#fff;width:26px;height:24px;cursor:pointer;font-size:12px;line-height:1;color:#555;}' +
      '.hc-cathead button:hover{background:#f2f2f2;}' +
      '.hc-catdel:hover{background:#fbe9e7;border-color:#e0a99f;}' +
      '.hc-ctl{position:absolute;top:6px;right:6px;display:flex;gap:4px;z-index:3;}' +
      '.hc-ctl button{border:none;border-radius:6px;background:rgba(255,255,255,.95);box-shadow:0 1px 4px rgba(0,0,0,.25);width:26px;height:24px;cursor:pointer;font-size:12px;line-height:1;}' +
      '.hc-card-wrap{position:relative;}' +
      '.hc-card-wrap.hc-drop{outline:2px dashed #7c5cbf;outline-offset:2px;border-radius:12px;}' +
      '.hc-add{display:flex;align-items:center;justify-content:center;min-height:160px;border:2px dashed #cdc6e0;border-radius:12px;color:#7c5cbf;font:600 15px "Source Sans Pro",Arial,sans-serif;cursor:pointer;background:#faf9fd;}' +
      '.hc-add:hover{background:#f3effc;}' +
      '.hc-cat-empty{color:#b8b0d4;font:italic 13px "Source Sans Pro",Arial,sans-serif;padding:6px 2px;}' +
      '#hc-bar{position:fixed;left:50%;bottom:20px;transform:translateX(-50%);z-index:99999;display:flex;gap:8px;align-items:center;background:#fff;border:1px solid #ccc;border-radius:10px;padding:8px 10px;box-shadow:0 3px 16px rgba(0,0,0,.25);font-family:"Source Sans Pro",Arial,sans-serif;font-size:13px;}' +
      '#hc-bar .hc-hint{color:#6b6680;margin-right:4px;}' +
      '#hc-bar button{height:28px;border-radius:6px;cursor:pointer;padding:0 12px;border:1px solid #ddd;background:#fff;}' +
      '#hc-bar .hc-addcat{border-color:#d9cff1;background:#efeaf8;color:#4a3f66;font-weight:600;}' +
      '#hc-bar .hc-save{border:none;background:#2d7a2d;color:#fff;font-weight:700;}' +
      '#hc-overlay{position:fixed;inset:0;background:rgba(30,27,46,.45);z-index:100000;display:flex;align-items:center;justify-content:center;}' +
      '#hc-form{background:#fff;border-radius:12px;box-shadow:0 10px 40px rgba(0,0,0,.35);width:420px;max-width:92vw;padding:20px 22px;font-family:"Source Sans Pro",Arial,sans-serif;}' +
      '#hc-form h3{margin:0 0 14px;font-size:17px;}' +
      '#hc-form label{display:block;font-size:12px;font-weight:700;color:#6b6680;margin:10px 0 3px;}' +
      '#hc-form input[type=text],#hc-form select{width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #cdc6e0;border-radius:8px;font-size:14px;background:#fff;}' +
      '#hc-form .hc-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:16px;}' +
      '#hc-form .hc-actions button{height:30px;border-radius:6px;cursor:pointer;padding:0 14px;border:1px solid #ddd;background:#fff;}' +
      '#hc-form .hc-ok{border:none;background:#7c5cbf;color:#fff;font-weight:700;}' +
      '#hc-upload-status{font-size:12px;color:#6b6680;margin-left:8px;}';
    document.head.appendChild(s);
  }

  // ---- state helpers ----
  function seedFromConfig() {
    var list = (typeof PROJECTS !== 'undefined' && PROJECTS) ? PROJECTS : [];
    return {
      categories: DEFAULT_CATEGORIES.slice(),
      cards: list.map(function (p) { return { title: p.title || '', thumb: p.thumb || '', github: p.github || '', live: p.live || '', badge: p.badge || '', hidden: !!p.hidden, category: SEED_CATEGORY }; })
    };
  }
  // accept v1 ({cards:[…]} with no categories) and v2 ({categories, cards}); guarantee a valid shape
  function normalize(raw) {
    var cats = (raw && Object.prototype.toString.call(raw.categories) === '[object Array]' && raw.categories.length) ? raw.categories.slice() : DEFAULT_CATEGORIES.slice();
    var cards = (raw && Object.prototype.toString.call(raw.cards) === '[object Array]') ? raw.cards.slice() : [];
    cards = cards.map(function (c) {
      c = c || {};
      var cat = c.category && cats.indexOf(c.category) > -1 ? c.category : (cats.indexOf(SEED_CATEGORY) > -1 ? SEED_CATEGORY : cats[cats.length - 1]);
      return { title: c.title || '', thumb: c.thumb || '', github: c.github || '', live: c.live || '', badge: c.badge || '', hidden: !!c.hidden, category: cat };
    });
    return { categories: cats, cards: cards };
  }

  // ---- render ----
  function render() {
    var c = container(); if (!c || !state) return;
    c.innerHTML = '';
    state.categories.forEach(function (catName, catPos) {
      var inCat = [];
      state.cards.forEach(function (p, i) { if (p.category === catName) inCat.push({ p: p, i: i }); });
      var visibleCount = inCat.filter(function (x) { return !x.p.hidden; }).length;
      if (!managing && visibleCount === 0) return;   // visitors don't see empty categories

      var row = document.createElement('div'); row.className = 'row';
      // header — plain label for visitors; editable name + reorder/delete for the owner
      if (managing) {
        var head = document.createElement('div'); head.className = 'hc-cathead';
        var nameIn = document.createElement('input'); nameIn.className = 'hc-catname'; nameIn.value = catName; nameIn.title = 'Rename this category';
        nameIn.addEventListener('change', function () { renameCategory(catName, nameIn.value); });
        var up = ctlBtn('↑', 'Move category up', function () { moveCategory(catPos, -1); });
        var down = ctlBtn('↓', 'Move category down', function () { moveCategory(catPos, 1); });
        var del = ctlBtn('🗑', 'Delete category (its maps move to the first category)', function () { deleteCategory(catName); });
        del.className = 'hc-catdel';
        head.appendChild(nameIn); head.appendChild(up); head.appendChild(down); head.appendChild(del);
        row.appendChild(head);
      } else {
        var label = document.createElement('div'); label.className = 'row-label'; label.textContent = catName;
        row.appendChild(label);
      }

      var grid = document.createElement('div'); grid.className = 'cards';
      inCat.forEach(function (entry) {
        if (entry.p.hidden && !managing) return;
        grid.appendChild(cardEl(entry.p, entry.i, catName));
      });
      if (managing) {
        var add = document.createElement('div'); add.className = 'hc-add'; add.textContent = '+ Add map';
        add.addEventListener('click', function () { openForm(null, catName); });
        grid.appendChild(add);
      }
      row.appendChild(grid);
      c.appendChild(row);
    });
  }

  function ctlBtn(txt, title, fn) {
    var b = document.createElement('button'); b.textContent = txt; b.title = title;
    b.addEventListener('click', function (e) { e.stopPropagation(); fn(); });
    return b;
  }

  function cardEl(p, i, catName) {
    var isLogo = !p.thumb;
    var thumbSrc = safeUrl(p.thumb) || LOGO;
    var imgStyle = isLogo ? ' style="object-fit:contain;padding:18px;box-sizing:border-box;background:#f3f0fa;"' : '';
    var wrap = document.createElement('div');
    wrap.className = 'hc-card-wrap' + (p.hidden ? ' hc-dim' : '');
    var card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = '<div class="card-thumb"><img src="' + esc(thumbSrc) + '" alt="' + esc(p.title) + '"' + imgStyle + '>'
      + (p.badge ? '<span class="card-badge">' + esc(p.badge) + '</span>' : '') + '</div>'
      + '<div class="card-info"><div class="card-title">' + esc(p.title) + '</div></div>';
    if (!managing) card.addEventListener('click', function () { if (window.openProjectModal) window.openProjectModal(p); });
    wrap.appendChild(card);
    if (managing) {
      var ctl = document.createElement('div'); ctl.className = 'hc-ctl';
      [['✎', 'Edit this card', function () { openForm(i); }],
       [p.hidden ? '🙈' : '👁', p.hidden ? 'Hidden — click to show' : 'Shown — click to hide', function () { state.cards[i].hidden = !state.cards[i].hidden; render(); }]]
        .forEach(function (spec) {
          var b = document.createElement('button'); b.textContent = spec[0]; b.title = spec[1];
          b.addEventListener('click', function (e) { e.stopPropagation(); spec[2](); });
          ctl.appendChild(b);
        });
      wrap.appendChild(ctl);
      wrap.draggable = true;
      wrap.addEventListener('dragstart', function () { dragIdx = i; });
      wrap.addEventListener('dragover', function (e) { if (dragIdx == null || dragIdx === i || state.cards[dragIdx].category !== catName) return; e.preventDefault(); wrap.classList.add('hc-drop'); });
      wrap.addEventListener('dragleave', function () { wrap.classList.remove('hc-drop'); });
      wrap.addEventListener('drop', function (e) {
        e.preventDefault(); wrap.classList.remove('hc-drop');
        if (dragIdx == null || dragIdx === i || state.cards[dragIdx].category !== catName) return;   // reorder within a category only
        var moved = state.cards.splice(dragIdx, 1)[0];
        var target = state.cards.indexOf(p);
        state.cards.splice(target, 0, moved); dragIdx = null; render();
      });
    }
    return wrap;
  }

  // ---- category management ----
  function renameCategory(oldName, newNameRaw) {
    var newName = (newNameRaw || '').trim(); if (!newName || newName === oldName) { render(); return; }
    if (state.categories.indexOf(newName) > -1) { window.alert('A category named “' + newName + '” already exists.'); render(); return; }
    var pos = state.categories.indexOf(oldName); if (pos > -1) state.categories[pos] = newName;
    state.cards.forEach(function (c) { if (c.category === oldName) c.category = newName; });
    render();
  }
  function moveCategory(pos, dir) {
    var to = pos + dir; if (to < 0 || to >= state.categories.length) return;
    var m = state.categories.splice(pos, 1)[0]; state.categories.splice(to, 0, m); render();
  }
  function deleteCategory(name) {
    if (state.categories.length <= 1) { window.alert('Keep at least one category.'); return; }
    var inCat = state.cards.filter(function (c) { return c.category === name; }).length;
    if (inCat && !window.confirm('Delete “' + name + '”? Its ' + inCat + ' map(s) move to the first category.')) return;
    var pos = state.categories.indexOf(name); state.categories.splice(pos, 1);
    var fallback = state.categories[0];
    state.cards.forEach(function (c) { if (c.category === name) c.category = fallback; });
    render();
  }
  function addCategory() {
    var name = (window.prompt('New category name:') || '').trim(); if (!name) return;
    if (state.categories.indexOf(name) > -1) { window.alert('That category already exists.'); return; }
    state.categories.push(name); render();
  }

  // ---- add/edit card form ----
  function openForm(idx, presetCategory) {
    var p = idx == null ? { title: '', thumb: '', github: '', live: '', badge: '', category: presetCategory || state.categories[0] } : state.cards[idx];
    var ov = document.createElement('div'); ov.id = 'hc-overlay';
    var catOpts = state.categories.map(function (c) { return '<option value="' + esc(c) + '"' + (c === p.category ? ' selected' : '') + '>' + esc(c) + '</option>'; }).join('');
    ov.innerHTML = '<div id="hc-form"><h3>' + (idx == null ? 'Add map' : 'Edit map') + '</h3>'
      + '<label>Title</label><input type="text" id="hcf-title">'
      + '<label>Category</label><select id="hcf-category">' + catOpts + '</select>'
      + '<label>Thumbnail (image URL)</label><input type="text" id="hcf-thumb" placeholder="https://… or images/…">'
      + '<div style="margin-top:6px;"><button type="button" id="hcf-upload">Upload image…</button><input type="file" id="hcf-file" accept="image/*" style="display:none;"><span id="hc-upload-status"></span></div>'
      + '<label>GitHub link</label><input type="text" id="hcf-github" placeholder="https://github.com/…">'
      + '<label>Live map link</label><input type="text" id="hcf-live" placeholder="https://…">'
      + '<label>Badge (optional, e.g. an account name)</label><input type="text" id="hcf-badge">'
      + '<div class="hc-actions"><button type="button" id="hcf-cancel">Cancel</button><button type="button" class="hc-ok" id="hcf-ok">' + (idx == null ? 'Add' : 'Apply') + '</button></div></div>';
    document.body.appendChild(ov);
    function g(id) { return document.getElementById(id); }
    g('hcf-title').value = p.title || ''; g('hcf-thumb').value = p.thumb || '';
    g('hcf-github').value = p.github || ''; g('hcf-live').value = p.live || ''; g('hcf-badge').value = p.badge || '';
    function close() { if (ov.parentNode) ov.parentNode.removeChild(ov); }
    ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
    g('hcf-cancel').addEventListener('click', close);
    g('hcf-upload').addEventListener('click', function () { g('hcf-file').click(); });
    g('hcf-file').addEventListener('change', async function () {
      var f = this.files && this.files[0]; if (!f) return;
      var st = g('hc-upload-status'); st.textContent = 'Uploading…';
      try {
        var d = db(); if (!d) throw new Error('no client');
        var key = 'site/' + Date.now() + '-' + String(f.name || 'thumb').replace(/[^a-zA-Z0-9._-]/g, '_');
        var up = await d.storage.from(BUCKET).upload(key, f, { upsert: true, contentType: f.type });
        if (up.error) throw new Error(up.error.message);
        var pub = d.storage.from(BUCKET).getPublicUrl(key);
        var url = (pub && pub.data && pub.data.publicUrl) || '';
        if (!url) throw new Error('no public URL');
        g('hcf-thumb').value = url; st.textContent = 'Uploaded ✓';
      } catch (e) { st.textContent = 'Upload failed — is the "' + BUCKET + '" bucket set up?'; }
    });
    g('hcf-ok').addEventListener('click', function () {
      var title = (g('hcf-title').value || '').trim();
      if (!title) { g('hcf-title').style.borderColor = '#b4453a'; g('hcf-title').focus(); return; }
      var next = { title: title, thumb: safeUrl(g('hcf-thumb').value), github: safeUrl(g('hcf-github').value), live: safeUrl(g('hcf-live').value), badge: (g('hcf-badge').value || '').trim(), category: g('hcf-category').value, hidden: idx == null ? false : !!state.cards[idx].hidden };
      if (idx == null) state.cards.push(next); else state.cards[idx] = next;
      close(); render();
    });
    g('hcf-title').focus();
  }

  // ---- manage mode ----
  function enterManage() {
    if (managing) return;
    if (!state) state = seedFromConfig();
    savedSnapshot = JSON.parse(JSON.stringify(state));
    managing = true; render(); showBar();
    var b = document.getElementById('hc-edit-btn'); if (b) b.style.display = 'none';
  }
  function exitManage() {
    managing = false; dragIdx = null; render();
    var bar = document.getElementById('hc-bar'); if (bar) bar.parentNode.removeChild(bar);
    var b = document.getElementById('hc-edit-btn'); if (b) b.style.display = '';
  }
  function showBar() {
    if (document.getElementById('hc-bar')) return;
    var bar = document.createElement('div'); bar.id = 'hc-bar';
    bar.innerHTML = '<span class="hc-hint">Drag cards to reorder · ✎ edit · 👁 hide · rename/reorder categories above</span>';
    var addcat = document.createElement('button'); addcat.className = 'hc-addcat'; addcat.textContent = '+ Add category';
    var save = document.createElement('button'); save.className = 'hc-save'; save.textContent = 'Save maps';
    var cancel = document.createElement('button'); cancel.textContent = 'Cancel';
    addcat.addEventListener('click', addCategory);
    save.addEventListener('click', saveAll);
    cancel.addEventListener('click', function () { state = savedSnapshot; exitManage(); });
    bar.appendChild(addcat); bar.appendChild(save); bar.appendChild(cancel);
    document.body.appendChild(bar);
  }
  async function saveAll() {
    var d = db(); if (!d) { window.alert('No database connection.'); return; }
    try {
      var r = await d.from('site_content').upsert({ key: KEY, html: JSON.stringify({ v: 2, categories: state.categories, cards: state.cards }) });
      if (r.error) { window.alert('Save failed: ' + r.error.message + (/relation|does not exist|schema cache/i.test(r.error.message) ? '\n\n(The site_content table isn’t created yet — run mapstructor_docs/site-content-setup.sql.)' : '')); return; }
      exitManage();
    } catch (e) { window.alert('Save error: ' + (e && e.message)); }
  }

  // ---- boot: saved layout for everyone, edit button for the owner ----
  async function loadSaved() {
    var d = db(); if (!d) return;
    try {
      var r = await d.from('site_content').select('html').eq('key', KEY).maybeSingle();
      if (r.data && r.data.html) {
        var parsed = JSON.parse(r.data.html);
        if (parsed && (parsed.cards || parsed.categories)) { state = normalize(parsed); render(); }
      }
    } catch (e) {}   // bad row / no table → the config.js seed render stays
  }
  async function maybeShowButton() {
    try {
      var force = location.search.indexOf('peadmin=1') > -1;
      var u = window.MapAuth ? await MapAuth.currentUser() : null;
      if (!force && (!u || !u.email || ADMIN_EMAILS.indexOf(u.email) === -1)) return;
      if (document.getElementById('hc-edit-btn')) return;
      var host = toolbar() || document.querySelector('.row-label');
      if (!host || !container()) return;
      var b = document.createElement('button');
      b.id = 'hc-edit-btn'; b.textContent = '✎ Edit maps';
      b.addEventListener('click', enterManage);
      host.appendChild(b);
    } catch (e) {}
  }

  function start() {
    ensureCss();
    state = seedFromConfig(); render();   // synchronous first paint from config.js (works even if the DB is down)
    loadSaved().then(maybeShowButton);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();

  // small seam for tests + console pokes
  window.MSHomeCards = {
    getState: function () { return state; },
    setState: function (s) { state = normalize(s); render(); },
    save: saveAll,
    enterManage: enterManage,
    managing: function () { return managing; }
  };
})();
