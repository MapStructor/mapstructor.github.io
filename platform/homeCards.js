// homeCards.js — front-page "Maps" grid manager. The grid seeds from config.js (PROJECTS) so the page
// always renders even with the DB unreachable; a saved list in site_content (HOME_CARDS_KEY, stored as
// JSON — deliberately NOT a data-edit region, pageEditor would inject the raw JSON into the page as HTML)
// overrides it for every visitor. The site owner gets an "✎ Edit maps" button: add / edit / hide /
// drag-reorder cards, thumbnail by URL or upload (reuses the public feature-images bucket). Cards are
// soft-HIDDEN, never deleted — visitors just don't see them; manage mode shows them dimmed.
(function () {
  var ADMIN_EMAILS = ['nittyjee@gmail.com'];   // same owner gate as pageEditor (client seam; RLS at lockdown)
  var SB_URL = 'https://eqpxlwbjqiwfjlsuapvu.supabase.co';
  var SB_KEY = 'sb_publishable_ijLmSmMUeNBrgMGL8Aol4g_S5-xwUzD';
  var KEY = 'home-projects-json';
  var BUCKET = 'feature-images';               // existing public bucket (anon-insert RLS) — thumbs go under site/
  var LOGO = 'images/nittygrittymapping_logo.png';

  function db() { return (window.MapAuth && MapAuth.db) || (window.supabase && supabase.createClient(SB_URL, SB_KEY)) || null; }
  function esc(s) { return String(s == null ? '' : s).replace(/[<>&"]/g, function (c) { return ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]; }); }
  // only http(s)/relative URLs survive into cards (no javascript: etc.)
  function safeUrl(u) { u = String(u == null ? '' : u).trim(); if (!u) return ''; return /^\s*(javascript|data|vbscript):/i.test(u) ? '' : u; }

  var cards = null;          // working list: [{title, thumb, github, live, badge, hidden}]
  var savedSnapshot = null;  // for Cancel
  var managing = false;
  var dragIdx = null;

  function container() { return document.getElementById('cards'); }

  function ensureCss() {
    if (document.getElementById('hc-css')) return;
    var s = document.createElement('style'); s.id = 'hc-css';
    s.textContent =
      '#hc-edit-btn{display:inline-block;margin-left:10px;vertical-align:middle;background:#efeaf8;color:#4a3f66;border:1px solid #d9cff1;border-radius:16px;padding:3px 12px;font:600 12px "Source Sans Pro",Arial,sans-serif;cursor:pointer;}' +
      '#hc-edit-btn:hover{background:#e5dcf6;}' +
      '.hc-dim{opacity:.45;}' +
      '.hc-ctl{position:absolute;top:6px;right:6px;display:flex;gap:4px;z-index:3;}' +
      '.hc-ctl button{border:none;border-radius:6px;background:rgba(255,255,255,.95);box-shadow:0 1px 4px rgba(0,0,0,.25);width:26px;height:24px;cursor:pointer;font-size:12px;line-height:1;}' +
      '.hc-card-wrap{position:relative;}' +
      '.hc-card-wrap.hc-drop{outline:2px dashed #7c5cbf;outline-offset:2px;border-radius:12px;}' +
      '.hc-add{display:flex;align-items:center;justify-content:center;min-height:160px;border:2px dashed #cdc6e0;border-radius:12px;color:#7c5cbf;font:600 15px "Source Sans Pro",Arial,sans-serif;cursor:pointer;background:#faf9fd;}' +
      '.hc-add:hover{background:#f3effc;}' +
      '#hc-bar{position:fixed;left:50%;bottom:20px;transform:translateX(-50%);z-index:99999;display:flex;gap:8px;align-items:center;background:#fff;border:1px solid #ccc;border-radius:10px;padding:8px 10px;box-shadow:0 3px 16px rgba(0,0,0,.25);font-family:"Source Sans Pro",Arial,sans-serif;font-size:13px;}' +
      '#hc-bar .hc-hint{color:#6b6680;margin-right:4px;}' +
      '#hc-bar button{height:28px;border-radius:6px;cursor:pointer;padding:0 12px;border:1px solid #ddd;background:#fff;}' +
      '#hc-bar .hc-save{border:none;background:#2d7a2d;color:#fff;font-weight:700;}' +
      '#hc-overlay{position:fixed;inset:0;background:rgba(30,27,46,.45);z-index:100000;display:flex;align-items:center;justify-content:center;}' +
      '#hc-form{background:#fff;border-radius:12px;box-shadow:0 10px 40px rgba(0,0,0,.35);width:420px;max-width:92vw;padding:20px 22px;font-family:"Source Sans Pro",Arial,sans-serif;}' +
      '#hc-form h3{margin:0 0 14px;font-size:17px;}' +
      '#hc-form label{display:block;font-size:12px;font-weight:700;color:#6b6680;margin:10px 0 3px;}' +
      '#hc-form input[type=text]{width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #cdc6e0;border-radius:8px;font-size:14px;}' +
      '#hc-form .hc-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:16px;}' +
      '#hc-form .hc-actions button{height:30px;border-radius:6px;cursor:pointer;padding:0 14px;border:1px solid #ddd;background:#fff;}' +
      '#hc-form .hc-ok{border:none;background:#7c5cbf;color:#fff;font-weight:700;}' +
      '#hc-upload-status{font-size:12px;color:#6b6680;margin-left:8px;}';
    document.head.appendChild(s);
  }

  function seedFromConfig() {
    var list = (typeof PROJECTS !== 'undefined' && PROJECTS) ? PROJECTS : [];
    return list.map(function (p) { return { title: p.title || '', thumb: p.thumb || '', github: p.github || '', live: p.live || '', badge: p.badge || '', hidden: !!p.hidden }; });
  }

  function render() {
    var c = container(); if (!c || !cards) return;
    c.innerHTML = '';
    cards.forEach(function (p, i) {
      if (p.hidden && !managing) return;   // soft-hidden: skipped for visitors, dimmed for the owner
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
         [p.hidden ? '🙈' : '👁', p.hidden ? 'Hidden — click to show' : 'Shown — click to hide', function () { cards[i].hidden = !cards[i].hidden; render(); }]]
          .forEach(function (spec) {
            var b = document.createElement('button'); b.textContent = spec[0]; b.title = spec[1];
            b.addEventListener('click', function (e) { e.stopPropagation(); spec[2](); });
            ctl.appendChild(b);
          });
        wrap.appendChild(ctl);
        wrap.draggable = true;
        wrap.addEventListener('dragstart', function () { dragIdx = i; });
        wrap.addEventListener('dragover', function (e) { if (dragIdx == null || dragIdx === i) return; e.preventDefault(); wrap.classList.add('hc-drop'); });
        wrap.addEventListener('dragleave', function () { wrap.classList.remove('hc-drop'); });
        wrap.addEventListener('drop', function (e) {
          e.preventDefault(); wrap.classList.remove('hc-drop');
          if (dragIdx == null || dragIdx === i) return;
          var moved = cards.splice(dragIdx, 1)[0];
          cards.splice(i, 0, moved); dragIdx = null; render();
        });
      }
      c.appendChild(wrap);
    });
    if (managing) {
      var add = document.createElement('div');
      add.className = 'hc-add'; add.id = 'hc-add-tile'; add.textContent = '+ Add map';
      add.addEventListener('click', function () { openForm(null); });
      c.appendChild(add);
    }
  }

  // ---- add/edit form ----
  function openForm(idx) {
    var p = idx == null ? { title: '', thumb: '', github: '', live: '', badge: '' } : cards[idx];
    var ov = document.createElement('div'); ov.id = 'hc-overlay';
    ov.innerHTML = '<div id="hc-form"><h3>' + (idx == null ? 'Add map' : 'Edit map') + '</h3>'
      + '<label>Title</label><input type="text" id="hcf-title">'
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
      var next = { title: title, thumb: safeUrl(g('hcf-thumb').value), github: safeUrl(g('hcf-github').value), live: safeUrl(g('hcf-live').value), badge: (g('hcf-badge').value || '').trim(), hidden: idx == null ? false : !!cards[idx].hidden };
      if (idx == null) cards.push(next); else cards[idx] = next;
      close(); render();
    });
    g('hcf-title').focus();
  }

  // ---- manage mode ----
  function enterManage() {
    if (managing) return;
    if (!cards) cards = seedFromConfig();
    savedSnapshot = JSON.parse(JSON.stringify(cards));
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
    bar.innerHTML = '<span class="hc-hint">Drag to reorder · ✎ edit · 👁 hide</span>';
    var save = document.createElement('button'); save.className = 'hc-save'; save.textContent = 'Save maps';
    var cancel = document.createElement('button'); cancel.textContent = 'Cancel';
    save.addEventListener('click', saveAll);
    cancel.addEventListener('click', function () { cards = savedSnapshot; exitManage(); });
    bar.appendChild(save); bar.appendChild(cancel);
    document.body.appendChild(bar);
  }
  async function saveAll() {
    var d = db(); if (!d) { window.alert('No database connection.'); return; }
    try {
      var r = await d.from('site_content').upsert({ key: KEY, html: JSON.stringify({ v: 1, cards: cards }) });
      if (r.error) { window.alert('Save failed: ' + r.error.message + (/relation|does not exist|schema cache/i.test(r.error.message) ? '\n\n(The site_content table isn’t created yet — run mapstructor_docs/site-content-setup.sql.)' : '')); return; }
      exitManage();
    } catch (e) { window.alert('Save error: ' + (e && e.message)); }
  }

  // ---- boot: saved list for everyone, edit button for the owner ----
  async function loadSaved() {
    var d = db(); if (!d) return;
    try {
      var r = await d.from('site_content').select('html').eq('key', KEY).maybeSingle();
      if (r.data && r.data.html) {
        var parsed = JSON.parse(r.data.html);
        if (parsed && Object.prototype.toString.call(parsed.cards) === '[object Array]') {
          cards = parsed.cards;
          render();   // replaces the config.js-seeded grid with the saved one
        }
      }
    } catch (e) {}   // bad row / no table → the static config.js render stays
  }
  async function maybeShowButton() {
    try {
      var force = location.search.indexOf('peadmin=1') > -1;
      var u = window.MapAuth ? await MapAuth.currentUser() : null;
      if (!force && (!u || !u.email || ADMIN_EMAILS.indexOf(u.email) === -1)) return;
      if (document.getElementById('hc-edit-btn')) return;
      var label = document.querySelector('.row-label');
      if (!label || !container()) return;
      var b = document.createElement('button');
      b.id = 'hc-edit-btn'; b.textContent = '✎ Edit maps';
      b.addEventListener('click', enterManage);
      label.appendChild(b);
    } catch (e) {}
  }

  function start() { ensureCss(); loadSaved().then(maybeShowButton); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();

  // small seam for tests + console pokes
  window.MSHomeCards = {
    getCards: function () { return cards; },
    setCards: function (list) { cards = list; render(); },
    enterManage: enterManage,
    managing: function () { return managing; }
  };
})();
