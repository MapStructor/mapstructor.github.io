// contentEditor.js — the Articles panel of the editor (content system step 5, 10/21): the type
// builder and the article form, in the editor's own chrome. Everything here writes the three
// content tables through the signed-in editor's client, under the map's own rules (RLS:
// ms_project_editor) — no service key, no server.
//
//   MSContentEditor.open({ db, projectId, layers(), bindLayer(layerDbId, typeId, key), onChange(), status(), toast() })
//
// WHAT IT HOLDS
//   Types     — one per kind of article ("Country", "Article"); name, plural, slug, and the ORDERED
//               list of fields (key / label / kind / where it shows / enum options with labels and
//               colours). A type may be bound to a layer: pick the layer and the feature property
//               that carries the article's key → clicking a feature opens its article (the same
//               panel.entries binding the layer panel's selects write).
//   Articles  — one per thing: title, slug (the page address), key (feature-backed types), summary
//               (the info panel's text), status, one control per field of the type, and links to
//               other articles (rel + target). "Create article" is the owner's phrase.
//
// The reader (platform/content.js) caches; every save here calls onChange() so the editor
// invalidates it and the next click shows the new text. The panel never leaves anything the
// person did not ask for: a type is deleted only after a confirm that names how many articles go.
(function () {
  'use strict';
  if (window.MSContentEditor) return;
  var O = null;   // the open() options
  var S = { types: [], entries: [], typeId: null, editType: null, editEntry: null, filter: '' };
  var KINDS = ['text', 'richtext', 'enum', 'number', 'date', 'url', 'list', 'link', 'image'];
  var SHOWS = [['both', 'panel + page'], ['panel', 'info panel only'], ['page', 'page only']];
  function esc(s) { return String(s == null ? '' : s).replace(/[<>&"]/g, function (c) { return ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]; }); }
  function slugify(s) { return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80); }
  function status(m) { try { if (O && O.status) O.status(m); } catch (e) {} }
  function toast(m) { try { if (O && O.toast) O.toast(m); } catch (e) {} }
  function changed() { try { if (O && O.onChange) O.onChange(); } catch (e) {} }
  function $(id) { return document.getElementById(id); }

  function css() {
    if ($('ms-ce-css')) return;
    var s = document.createElement('style'); s.id = 'ms-ce-css';
    s.textContent =
      '#editor-articles-panel{position:fixed;top:130px;left:534px;width:560px;max-height:calc(100vh - 200px);overflow-y:auto;overflow-x:hidden;background:#f8f8f8;border:1px solid #bbbbbb;border-radius:8px;box-shadow:0 3px 14px rgba(0,0,0,0.2);padding:0;font-size:13px;z-index:4470;display:none;font-family:Source Sans Pro,Arial,sans-serif;color:#222;}' +
      '#editor-articles-panel .ce-head{position:sticky;top:0;z-index:5;padding:10px 12px;background:#fff;border-bottom:1px solid #e2e0ea;border-radius:8px 8px 0 0;display:flex;justify-content:space-between;align-items:center;gap:8px;}' +
      '#editor-articles-panel .ce-body{padding:12px;}' +
      '.ce-sec{font-size:22px;font-weight:800;letter-spacing:.07em;color:#7c5cbf;margin:0 0 8px;text-transform:uppercase;border-bottom:2px solid #ede9f7;padding-bottom:4px;text-align:center;}' +
      '.ce-sectop{margin-top:14px;padding:10px 12px 12px;border:3px solid #e5e0f3;border-radius:10px;background:#fbfaff;box-shadow:0 0 3px 4px rgba(124,92,191,0.09);}' +
      '.ce-sectop:first-child{margin-top:0}' +
      '.ce-lbl{display:block;font-size:11px;color:#555;margin:6px 0 2px;}' +
      '.ce-in{width:100%;box-sizing:border-box;padding:5px 6px;border:1px solid #bbb;border-radius:4px;font-size:12px;font-family:inherit;background:#fff;}' +
      'textarea.ce-in{min-height:58px;resize:vertical;line-height:1.4}' +
      '.ce-btn{padding:6px 10px;border:1px solid #bbb;border-radius:4px;background:#f2f2f2;color:#222;cursor:pointer;font-size:12px;font-family:inherit;}' +
      '.ce-btn:hover{background:#e8e8e8}.ce-btn.pri{background:#7c5cbf;border-color:#6a4caf;color:#fff;font-weight:700}.ce-btn.pri:hover{background:#6a4caf}.ce-btn.danger{color:#a3262c}' +
      '.ce-btn.sm{padding:2px 7px;font-size:11px}' +
      '.ce-note{font-size:10.5px;color:#888;margin-top:3px;}' +
      '.ce-row{display:flex;gap:6px;align-items:center;margin:3px 0;}.ce-row>*{min-width:0}' +
      '.ce-list{margin:0;padding:0;list-style:none}.ce-list li{display:flex;gap:8px;align-items:center;padding:6px 4px;border-bottom:1px solid #eeebf5;font-size:12.5px}.ce-list li:last-child{border-bottom:0}' +
      '.ce-list .t{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.ce-list b{color:#2b2540}.ce-dim{color:#777;font-size:11px}' +
      '.ce-pill{display:inline-block;padding:1px 7px;border:1px solid #c9c2e2;border-radius:999px;background:#f3f1f8;color:#4a3f66;font-size:10.5px;font-weight:700;margin-left:4px}' +
      '.ce-fields{width:100%;border-collapse:collapse;font-size:12px}.ce-fields th{text-align:left;font-size:10.5px;color:#777;font-weight:600;padding:2px 3px}.ce-fields td{padding:2px 3px;vertical-align:top}.ce-fields .ce-in{padding:3px 5px}' +
      '.ce-grid2{display:grid;grid-template-columns:1fr 1fr;gap:0 10px}' +
      '#ce-close:hover{background:#e9e5f5;border-color:#c9c2e2;color:#3d3857}';
    document.head.appendChild(s);
  }
  function inject() {
    if ($('editor-articles-panel')) return;
    css();
    var p = document.createElement('div'); p.id = 'editor-articles-panel';
    p.innerHTML =
      '<div class="ce-head"><b style="font-size:14px;">📚 Articles</b><span class="ce-dim" id="ce-count"></span>' +
      '<button id="ce-close" title="Close this panel" style="flex:0 0 auto;display:inline-flex;align-items:center;gap:4px;padding:3px 9px 3px 7px;border:1px solid #d7d3e4;border-radius:6px;background:#f4f2fa;color:#544f6e;font:600 12px Source Sans Pro,Arial,sans-serif;cursor:pointer;line-height:1;"><span style="font-size:15px;line-height:1;">&times;</span> Close</button></div>' +
      '<div class="ce-body"><div id="ce-types" class="ce-sectop"></div><div id="ce-entries" class="ce-sectop"></div></div>';
    document.body.appendChild(p);
    $('ce-close').addEventListener('click', close);
    p.addEventListener('click', onClick);
    p.addEventListener('change', onChange);
    p.addEventListener('input', onInput);
  }
  function close() { var p = $('editor-articles-panel'); if (p) p.style.display = 'none'; }

  // ── data ──────────────────────────────────────────────────────────────────
  async function load() {
    var t = await O.db.from('content_types').select('id, slug, name, name_plural, fields, layer_id, feature_key').eq('project_id', O.projectId).order('name');
    S.types = t.error ? [] : (t.data || []);
    var out = [], last = null;
    for (;;) {   // every article of the map, drafts included (the editor sees everything)
      var q = O.db.from('entries').select('id, type_id, slug, title, key, summary, body, status, updated_at').eq('project_id', O.projectId).order('slug').limit(1000);
      if (last) q = q.gt('slug', last);
      var r = await q; if (r.error || !r.data || !r.data.length) break;
      out = out.concat(r.data); last = r.data[r.data.length - 1].slug;
      if (r.data.length < 1000) break;
    }
    S.entries = out;
    if (S.typeId && !S.types.some(function (x) { return x.id === S.typeId; })) S.typeId = null;
    if (!S.typeId && S.types.length) S.typeId = S.types[0].id;
    var c = $('ce-count'); if (c) c.textContent = S.types.length + ' type' + (S.types.length === 1 ? '' : 's') + ' · ' + S.entries.length + ' article' + (S.entries.length === 1 ? '' : 's');
  }
  function typeById(id) { return S.types.filter(function (t) { return t.id === id; })[0] || null; }

  // ── types ─────────────────────────────────────────────────────────────────
  function renderTypes() {
    var el = $('ce-types'); if (!el) return;
    if (S.editType) { el.innerHTML = typeForm(S.editType); return; }
    var layers = O.layers ? O.layers() : [];
    var layerName = function (id) { var l = layers.filter(function (x) { return x.id === id; })[0]; return l ? l.label : '(a layer no longer on this map)'; };
    el.innerHTML = '<div class="ce-sec">Types</div>' +
      (S.types.length ? '<ul class="ce-list">' + S.types.map(function (t) {
        var n = S.entries.filter(function (e) { return e.type_id === t.id; }).length;
        return '<li><span class="t"><b>' + esc(t.name) + '</b>' + (t.name_plural ? ' <span class="ce-dim">/ ' + esc(t.name_plural) + '</span>' : '') +
          '<span class="ce-pill">' + (t.fields || []).length + ' field' + ((t.fields || []).length === 1 ? '' : 's') + '</span><span class="ce-pill">' + n + ' article' + (n === 1 ? '' : 's') + '</span>' +
          (t.layer_id ? '<br><span class="ce-dim">on layer <b>' + esc(layerName(t.layer_id)) + '</b> by <b>' + esc(t.feature_key || 'label') + '</b></span>' : '<br><span class="ce-dim">not bound to a layer</span>') + '</span>' +
          '<button class="ce-btn sm" data-act="edit-type" data-id="' + t.id + '">Edit</button></li>';
      }).join('') + '</ul>' : '<div class="ce-note" style="font-size:12px;margin:4px 0 8px;">No types yet. A type is a kind of article — its fields are what every article of that kind holds.</div>') +
      '<div class="ce-row" style="margin-top:8px;"><button class="ce-btn pri" data-act="new-type">+ New type</button></div>';
  }
  function newType() { return { id: null, name: '', name_plural: '', slug: '', layer_id: '', feature_key: 'label', fields: [{ key: 'body', label: 'Text', kind: 'richtext', show: 'both' }] }; }
  function optLines(f) {   // enum options as editable lines: value | Label | #colour
    return (f.options || []).map(function (v) { var l = f.labels && f.labels[v], c = f.colors && f.colors[v]; return v + (l || c ? ' | ' + (l || '') : '') + (c ? ' | ' + c : ''); }).join('\n');
  }
  function typeForm(t) {
    var layers = O.layers ? O.layers() : [];
    return '<div class="ce-sec">' + (t.id ? 'Edit type' : 'New type') + '</div>' +
      '<div class="ce-grid2"><div><label class="ce-lbl">Name (one)</label><input id="ce-t-name" class="ce-in" value="' + esc(t.name) + '" placeholder="Country" /></div>' +
      '<div><label class="ce-lbl">Plural</label><input id="ce-t-plural" class="ce-in" value="' + esc(t.name_plural || '') + '" placeholder="Countries" /></div></div>' +
      '<label class="ce-lbl">Slug (in addresses; letters, digits, dashes)</label><input id="ce-t-slug" class="ce-in" value="' + esc(t.slug) + '" placeholder="country" ' + (t.id ? 'readonly title="The slug of a saved type stays"' : '') + ' />' +
      '<div class="ce-grid2"><div><label class="ce-lbl">Bound to a layer (click a feature → its article)</label><select id="ce-t-layer" class="ce-in"><option value="">— not bound —</option>' +
        layers.map(function (l) { return '<option value="' + l.id + '"' + (l.id === t.layer_id ? ' selected' : '') + '>' + esc(l.label) + '</option>'; }).join('') + '</select></div>' +
      '<div><label class="ce-lbl">Feature property holding the article key</label><input id="ce-t-key" class="ce-in" value="' + esc(t.feature_key || 'label') + '" placeholder="label" /></div></div>' +
      '<div class="ce-note">Binding writes the layer\'s info panel setting (Articles, this type, this key) — the same thing the layer panel\'s selects set.</div>' +
      '<label class="ce-lbl" style="margin-top:8px;">Fields (in order)</label>' +
      '<table class="ce-fields"><thead><tr><th>key</th><th>label</th><th>kind</th><th>shows</th><th></th></tr></thead><tbody id="ce-t-fields">' +
      (t.fields || []).map(function (f, i) { return fieldRow(f, i); }).join('') + '</tbody></table>' +
      '<div class="ce-row" style="margin-top:4px;"><button class="ce-btn sm" data-act="add-field">+ Add field</button><span class="ce-note" style="margin:0;">kinds: text · richtext (HTML) · enum (one of a list) · number · date · url · list (one per line) · link (another article\'s slug) · image (URL)</span></div>' +
      '<div class="ce-row" style="margin-top:10px;justify-content:space-between;"><div class="ce-row"><button class="ce-btn pri" data-act="save-type">Save type</button><button class="ce-btn" data-act="cancel-type">Cancel</button></div>' +
      (t.id ? '<button class="ce-btn danger" data-act="delete-type" data-id="' + t.id + '">Delete type…</button>' : '') + '</div>' +
      '<div id="ce-t-msg" class="ce-note"></div>';
  }
  function fieldRow(f, i) {
    var kindSel = '<select class="ce-in" data-f="kind" data-i="' + i + '">' + KINDS.map(function (k) { return '<option' + (k === f.kind ? ' selected' : '') + '>' + k + '</option>'; }).join('') + '</select>';
    var showSel = '<select class="ce-in" data-f="show" data-i="' + i + '">' + SHOWS.map(function (s) { return '<option value="' + s[0] + '"' + (s[0] === (f.show || 'both') ? ' selected' : '') + '>' + s[1] + '</option>'; }).join('') + '</select>';
    return '<tr data-i="' + i + '"><td style="width:22%"><input class="ce-in" data-f="key" data-i="' + i + '" value="' + esc(f.key) + '" placeholder="key" /></td>' +
      '<td style="width:30%"><input class="ce-in" data-f="label" data-i="' + i + '" value="' + esc(f.label || '') + '" placeholder="Label" /></td>' +
      '<td style="width:18%">' + kindSel + '</td><td style="width:22%">' + showSel + '</td>' +
      '<td style="white-space:nowrap"><button class="ce-btn sm" data-act="field-up" data-i="' + i + '" title="Move up">↑</button><button class="ce-btn sm" data-act="field-down" data-i="' + i + '" title="Move down">↓</button><button class="ce-btn sm danger" data-act="field-del" data-i="' + i + '" title="Remove">✕</button></td></tr>' +
      (f.kind === 'enum' ? '<tr data-i="' + i + '"><td colspan="5"><textarea class="ce-in" data-f="options" data-i="' + i + '" placeholder="one option per line:  value | Label | #colour   (label and colour optional)" style="min-height:48px;font-size:11.5px;">' + esc(optLines(f)) + '</textarea></td></tr>' : '');
  }
  function readTypeForm() {
    var t = S.editType;
    t.name = ($('ce-t-name').value || '').trim(); t.name_plural = ($('ce-t-plural').value || '').trim();
    t.slug = slugify($('ce-t-slug').value || t.name); t.layer_id = $('ce-t-layer').value || ''; t.feature_key = ($('ce-t-key').value || 'label').trim() || 'label';
    var rows = {};
    Array.prototype.forEach.call(document.querySelectorAll('#ce-t-fields [data-f]'), function (inp) {
      var i = inp.getAttribute('data-i'), f = inp.getAttribute('data-f'); rows[i] = rows[i] || {}; rows[i][f] = inp.value;
    });
    t.fields = Object.keys(rows).sort(function (a, b) { return a - b; }).map(function (i) {
      var r = rows[i], f = { key: slugify(r.key).replace(/-/g, '_'), label: (r.label || '').trim(), kind: r.kind || 'text', show: r.show || 'both' };
      if (f.kind === 'enum') {
        f.options = []; f.labels = {}; f.colors = {};
        (r.options || '').split(/\r?\n/).forEach(function (line) {
          var parts = line.split('|').map(function (x) { return x.trim(); }); if (!parts[0]) return;
          f.options.push(parts[0]); if (parts[1]) f.labels[parts[0]] = parts[1]; if (parts[2] && /^#[0-9a-f]{3,8}$/i.test(parts[2])) f.colors[parts[0]] = parts[2];
        });
        if (!Object.keys(f.labels).length) delete f.labels; if (!Object.keys(f.colors).length) delete f.colors;
      }
      return f;
    }).filter(function (f) { return f.key; });
    return t;
  }
  async function saveType() {
    var t = readTypeForm(), msg = $('ce-t-msg');
    if (!t.name) { msg.textContent = 'A type needs a name.'; return; }
    if (!t.slug) { msg.textContent = 'A type needs a slug.'; return; }
    var keys = {}; for (var i = 0; i < t.fields.length; i++) { if (keys[t.fields[i].key]) { msg.textContent = 'Two fields share the key “' + t.fields[i].key + '”.'; return; } keys[t.fields[i].key] = 1; }
    status('Saving…'); msg.textContent = '';
    var row = { name: t.name, name_plural: t.name_plural || null, fields: t.fields, layer_id: t.layer_id || null, feature_key: t.layer_id ? t.feature_key : null };
    var r;
    if (t.id) r = await O.db.from('content_types').update(row).eq('id', t.id).select('id').single();
    else r = await O.db.from('content_types').insert(Object.assign({ project_id: O.projectId, slug: t.slug }, row)).select('id').single();
    if (r.error) { status('Save failed'); msg.textContent = 'Could not save: ' + r.error.message + (/duplicate|unique/i.test(r.error.message) ? ' — a type with this slug exists on this map.' : ''); return; }
    var id = (r.data && r.data.id) || t.id;
    if (t.layer_id && O.bindLayer) { try { await O.bindLayer(t.layer_id, id, t.feature_key); } catch (e) { toast('Type saved, but the layer binding failed: ' + (e && e.message)); } }
    S.editType = null; S.typeId = id;
    status('Type saved'); changed();
    await refresh();
  }
  async function deleteType(id) {
    var t = typeById(id); if (!t) return;
    var n = S.entries.filter(function (e) { return e.type_id === id; }).length;
    if (!window.confirm('Delete the type “' + t.name + '”' + (n ? ' and its ' + n + ' article' + (n === 1 ? '' : 's') : '') + '? This cannot be undone.')) return;
    status('Deleting…');
    var r = await O.db.from('content_types').delete().eq('id', id);
    if (r.error) { status('Delete failed'); toast('Could not delete: ' + r.error.message); return; }
    S.editType = null; if (S.typeId === id) S.typeId = null;
    status('Type deleted'); changed();
    await refresh();
  }

  // ── articles ──────────────────────────────────────────────────────────────
  function renderEntries() {
    var el = $('ce-entries'); if (!el) return;
    if (S.editEntry) { el.innerHTML = entryForm(S.editEntry); return; }
    var t = typeById(S.typeId);
    var list = S.entries.filter(function (e) { return (!S.typeId || e.type_id === S.typeId) && (!S.filter || (e.title + ' ' + (e.key || '') + ' ' + e.slug).toLowerCase().indexOf(S.filter) > -1); });
    el.innerHTML = '<div class="ce-sec">Articles</div>' +
      '<div class="ce-row"><select id="ce-e-type" class="ce-in" style="flex:1">' + (S.types.length ? S.types.map(function (x) { return '<option value="' + x.id + '"' + (x.id === S.typeId ? ' selected' : '') + '>' + esc(x.name_plural || x.name) + '</option>'; }).join('') : '<option value="">(make a type first)</option>') + '</select>' +
      '<input id="ce-e-filter" class="ce-in" style="flex:1" placeholder="Find by title, key or slug" value="' + esc(S.filter) + '" />' +
      '<button class="ce-btn pri" data-act="new-entry"' + (t ? '' : ' disabled') + '>+ Create article</button></div>' +
      (list.length ? '<ul class="ce-list" style="margin-top:6px;">' + list.slice(0, 400).map(function (e) {
        return '<li><span class="t"><b>' + esc(e.title) + '</b>' + (e.key ? ' <span class="ce-dim">key ' + esc(e.key) + '</span>' : '') + (e.status === 'draft' ? '<span class="ce-pill">draft</span>' : '') + '<br><span class="ce-dim">' + esc(e.slug) + (e.summary ? ' — ' + esc(e.summary.slice(0, 90)) + (e.summary.length > 90 ? '…' : '') : '') + '</span></span>' +
          '<button class="ce-btn sm" data-act="edit-entry" data-id="' + e.id + '">Edit</button></li>';
      }).join('') + '</ul>' + (list.length > 400 ? '<div class="ce-note">Showing 400 of ' + list.length + ' — narrow the search.</div>' : '')
        : '<div class="ce-note" style="font-size:12px;margin-top:8px;">' + (t ? 'No articles of this type yet.' : 'Make a type above, then write articles of it.') + '</div>');
  }
  function newEntry(typeId) { return { id: null, type_id: typeId, slug: '', title: '', key: '', summary: '', status: 'published', body: {}, links: [], _slugTouched: false }; }
  function fieldInput(f, v) {
    var id = 'ce-f-' + f.key, attrs = ' id="' + id + '" class="ce-in" data-field="' + esc(f.key) + '"';
    switch (f.kind) {
      case 'richtext': return '<textarea' + attrs + ' placeholder="HTML allowed: <p>, <strong>, <a href>…" style="min-height:90px;">' + esc(v == null ? '' : v) + '</textarea>';
      case 'list': return '<textarea' + attrs + ' placeholder="one item per line">' + esc(Array.isArray(v) ? v.join('\n') : (v == null ? '' : v)) + '</textarea>';
      case 'enum': return '<select' + attrs + '><option value="">—</option>' + (f.options || []).map(function (o) { return '<option value="' + esc(o) + '"' + (String(v) === String(o) ? ' selected' : '') + '>' + esc((f.labels && f.labels[o]) || o) + '</option>'; }).join('') + '</select>';
      case 'number': return '<input type="number" step="any"' + attrs + ' value="' + esc(v == null ? '' : v) + '" />';
      case 'date': return '<input type="date"' + attrs + ' value="' + esc(v == null ? '' : String(v).slice(0, 10)) + '" />';
      case 'link': return '<input' + attrs + ' list="ce-slugs" placeholder="slug of another article" value="' + esc(v == null ? '' : v) + '" />';
      case 'url': case 'image': return '<input' + attrs + ' placeholder="https://…" value="' + esc(v == null ? '' : v) + '" />';
      default: return '<input' + attrs + ' value="' + esc(v == null ? '' : v) + '" />';
    }
  }
  function entryForm(e) {
    var t = typeById(e.type_id) || { fields: [] };
    var slugs = '<datalist id="ce-slugs">' + S.entries.filter(function (x) { return x.id !== e.id; }).map(function (x) { return '<option value="' + esc(x.slug) + '">' + esc(x.title) + '</option>'; }).join('') + '</datalist>';
    var others = S.entries.filter(function (x) { return x.id !== e.id; });
    return '<div class="ce-sec">' + (e.id ? 'Edit article' : 'Create article') + ' <span style="font-size:12px;letter-spacing:0;text-transform:none;color:#777;font-weight:600;">· ' + esc(t.name || '') + '</span></div>' + slugs +
      '<label class="ce-lbl">Title</label><input id="ce-e-title" class="ce-in" value="' + esc(e.title) + '" placeholder="Germany" />' +
      '<div class="ce-grid2"><div><label class="ce-lbl">Slug (the page address)</label><input id="ce-e-slug" class="ce-in" value="' + esc(e.slug) + '" placeholder="germany" /></div>' +
      '<div><label class="ce-lbl">Key (the feature value it belongs to' + (t.layer_id ? ', from <b>' + esc(t.feature_key || 'label') + '</b>' : '') + ')</label><input id="ce-e-key" class="ce-in" value="' + esc(e.key || '') + '" placeholder="DE" /></div></div>' +
      '<label class="ce-lbl">Summary (what the info panel shows)</label><textarea id="ce-e-summary" class="ce-in">' + esc(e.summary || '') + '</textarea>' +
      (t.fields || []).map(function (f) { return '<label class="ce-lbl">' + esc(f.label || f.key) + ' <span class="ce-dim">' + f.kind + ' · ' + (f.show || 'both') + '</span></label>' + fieldInput(f, e.body ? e.body[f.key] : null); }).join('') +
      '<label class="ce-lbl" style="margin-top:8px;">Links to other articles</label>' +
      '<ul class="ce-list" id="ce-e-links">' + (e.links || []).map(function (l, i) { var tgt = S.entries.filter(function (x) { return x.id === l.to_id; })[0]; return '<li data-li="' + i + '"><span class="t"><b>' + esc(l.rel) + '</b> → ' + esc(tgt ? tgt.title : l.to_id) + '</span><button class="ce-btn sm danger" data-act="link-del" data-i="' + i + '">✕</button></li>'; }).join('') + '</ul>' +
      '<div class="ce-row"><input id="ce-l-rel" class="ce-in" style="width:110px;flex:0 0 auto" value="related" placeholder="rel" title="parent · related · see-also…" /><select id="ce-l-to" class="ce-in" style="flex:1"><option value="">— article —</option>' + others.slice(0, 2000).map(function (x) { return '<option value="' + x.id + '">' + esc(x.title) + (x.key ? ' (' + esc(x.key) + ')' : '') + '</option>'; }).join('') + '</select><button class="ce-btn sm" data-act="link-add">+ Link</button></div>' +
      '<div class="ce-grid2" style="margin-top:8px;"><div><label class="ce-lbl">Status</label><select id="ce-e-status" class="ce-in"><option value="published"' + (e.status !== 'draft' ? ' selected' : '') + '>published (visitors see it)</option><option value="draft"' + (e.status === 'draft' ? ' selected' : '') + '>draft (editors only)</option></select></div></div>' +
      '<div class="ce-row" style="margin-top:10px;justify-content:space-between;"><div class="ce-row"><button class="ce-btn pri" data-act="save-entry">' + (e.id ? 'Save article' : 'Create article') + '</button><button class="ce-btn" data-act="cancel-entry">Cancel</button></div>' +
      (e.id ? '<button class="ce-btn danger" data-act="delete-entry" data-id="' + e.id + '">Delete article…</button>' : '') + '</div>' +
      '<div id="ce-e-msg" class="ce-note"></div>';
  }
  function readEntryForm() {
    var e = S.editEntry, t = typeById(e.type_id) || { fields: [] };
    e.title = ($('ce-e-title').value || '').trim(); e.slug = slugify($('ce-e-slug').value || e.title); e.key = ($('ce-e-key').value || '').trim() || null;
    e.summary = ($('ce-e-summary').value || '').trim() || null; e.status = $('ce-e-status').value || 'published';
    var body = Object.assign({}, e.body || {});
    (t.fields || []).forEach(function (f) {
      var inp = $('ce-f-' + f.key); if (!inp) return; var v = inp.value;
      if (f.kind === 'list') v = v.split(/\r?\n/).map(function (x) { return x.trim(); }).filter(Boolean);
      else if (f.kind === 'number') v = v === '' ? null : Number(v);
      else v = (v == null ? '' : String(v).trim());
      if (v == null || v === '' || (Array.isArray(v) && !v.length)) delete body[f.key]; else body[f.key] = v;
    });
    e.body = body;
    return e;
  }
  async function saveEntry() {
    var e = readEntryForm(), msg = $('ce-e-msg');
    if (!e.title) { msg.textContent = 'An article needs a title.'; return; }
    if (!e.slug) { msg.textContent = 'An article needs a slug.'; return; }
    status('Saving…'); msg.textContent = '';
    var row = { type_id: e.type_id, slug: e.slug, title: e.title, key: e.key, summary: e.summary, body: e.body, status: e.status };
    var r;
    if (e.id) r = await O.db.from('entries').update(row).eq('id', e.id).select('id').single();
    else r = await O.db.from('entries').insert(row).select('id').single();   // project_id: the trigger fills it from the type
    if (r.error) { status('Save failed'); msg.textContent = 'Could not save: ' + r.error.message + (/duplicate|unique/i.test(r.error.message) ? ' — an article with this slug exists on this map.' : ''); return; }
    var id = (r.data && r.data.id) || e.id;
    // links: the form's list is the truth — rows not in it go, new ones come
    var cur = e.id ? ((await O.db.from('entry_links').select('id, to_id, rel, position').eq('from_id', id)).data || []) : [];
    var keep = {}; (e.links || []).forEach(function (l) { keep[l.to_id + '|' + l.rel] = l; });
    var gone = cur.filter(function (l) { return !keep[l.to_id + '|' + l.rel]; }).map(function (l) { return l.id; });
    if (gone.length) await O.db.from('entry_links').delete().in('id', gone);
    var have = {}; cur.forEach(function (l) { have[l.to_id + '|' + l.rel] = 1; });
    var add = (e.links || []).filter(function (l) { return !have[l.to_id + '|' + l.rel]; }).map(function (l, i) { return { from_id: id, to_id: l.to_id, rel: l.rel, position: i }; });
    if (add.length) { var la = await O.db.from('entry_links').insert(add); if (la.error) toast('Article saved; a link failed: ' + la.error.message); }
    S.editEntry = null;
    status(e.id ? 'Article saved' : 'Article created'); changed();
    await refresh();
  }
  async function deleteEntry(id) {
    var e = S.entries.filter(function (x) { return x.id === id; })[0]; if (!e) return;
    if (!window.confirm('Delete the article “' + e.title + '”? Links to it go too. This cannot be undone.')) return;
    status('Deleting…');
    var r = await O.db.from('entries').delete().eq('id', id);
    if (r.error) { status('Delete failed'); toast('Could not delete: ' + r.error.message); return; }
    S.editEntry = null; status('Article deleted'); changed();
    await refresh();
  }
  async function openEntry(id) {
    var e = S.entries.filter(function (x) { return x.id === id; })[0]; if (!e) return;
    var l = await O.db.from('entry_links').select('id, to_id, rel, position').eq('from_id', id).order('position');
    S.editEntry = Object.assign({}, e, { body: Object.assign({}, e.body || {}), links: (l.data || []).map(function (x) { return { to_id: x.to_id, rel: x.rel }; }), _slugTouched: true });
    S.editType = null; render();
  }

  // ── events ────────────────────────────────────────────────────────────────
  function onClick(ev) {
    var b = ev.target.closest ? ev.target.closest('[data-act]') : null; if (!b || b.disabled) return;
    var act = b.getAttribute('data-act'), id = b.getAttribute('data-id'), i = parseInt(b.getAttribute('data-i'), 10);
    if (act === 'new-type') { S.editType = newType(); S.editEntry = null; render(); }
    else if (act === 'edit-type') { var t = typeById(id); if (t) { S.editType = JSON.parse(JSON.stringify(t)); S.editType.layer_id = S.editType.layer_id || ''; S.editEntry = null; render(); } }
    else if (act === 'cancel-type') { S.editType = null; render(); }
    else if (act === 'save-type') saveType();
    else if (act === 'delete-type') deleteType(id);
    else if (act === 'add-field') { readTypeForm(); S.editType.fields.push({ key: '', label: '', kind: 'text', show: 'both' }); render(); setTimeout(function () { var r = document.querySelectorAll('#ce-t-fields input[data-f="key"]'); if (r.length) r[r.length - 1].focus(); }, 0); }
    else if (act === 'field-del') { readTypeForm(); S.editType.fields.splice(i, 1); render(); }
    else if (act === 'field-up' || act === 'field-down') { readTypeForm(); var fs = S.editType.fields, j = act === 'field-up' ? i - 1 : i + 1; if (j >= 0 && j < fs.length) { var tmp = fs[i]; fs[i] = fs[j]; fs[j] = tmp; } render(); }
    else if (act === 'new-entry') { if (!S.typeId) return; S.editEntry = newEntry(S.typeId); S.editType = null; render(); setTimeout(function () { var ti = $('ce-e-title'); if (ti) ti.focus(); }, 0); }
    else if (act === 'edit-entry') openEntry(id);
    else if (act === 'cancel-entry') { S.editEntry = null; render(); }
    else if (act === 'save-entry') saveEntry();
    else if (act === 'delete-entry') deleteEntry(id);
    else if (act === 'link-add') { readEntryForm(); var to = $('ce-l-to').value, rel = ($('ce-l-rel').value || 'related').trim() || 'related'; if (!to) return; if (!S.editEntry.links.some(function (l) { return l.to_id === to && l.rel === rel; })) S.editEntry.links.push({ to_id: to, rel: rel }); render(); }
    else if (act === 'link-del') { readEntryForm(); S.editEntry.links.splice(i, 1); render(); }
  }
  function onChange(ev) {
    var el = ev.target; if (!el || !el.id) { if (el && el.getAttribute && el.getAttribute('data-f') === 'kind') { readTypeForm(); render(); } return; }
    if (el.id === 'ce-e-type') { S.typeId = el.value || null; renderEntries(); }
    else if (el.id === 'ce-t-slug' && S.editType) S.editType._slugTouched = true;
    else if (el.id === 'ce-e-slug' && S.editEntry) S.editEntry._slugTouched = true;
  }
  function onInput(ev) {
    var el = ev.target; if (!el || !el.id) return;
    if (el.id === 'ce-e-filter') { S.filter = (el.value || '').trim().toLowerCase(); renderEntries(); var f = $('ce-e-filter'); if (f) { f.focus(); f.setSelectionRange(f.value.length, f.value.length); } }
    else if (el.id === 'ce-t-name' && S.editType && !S.editType.id && !S.editType._slugTouched) $('ce-t-slug').value = slugify(el.value);   // the slug follows the name until typed
    else if (el.id === 'ce-e-title' && S.editEntry && !S.editEntry.id && !S.editEntry._slugTouched) $('ce-e-slug').value = slugify(el.value);
  }
  function render() { renderTypes(); renderEntries(); }
  async function refresh() { try { await load(); } catch (e) { toast('Could not read this map\'s content: ' + (e && e.message)); } render(); }

  async function open(opts) {
    O = opts || O; if (!O || !O.db || !O.projectId) return;
    inject();
    var p = $('editor-articles-panel');
    if (p.style.display === 'block') { p.style.display = 'none'; return; }   // the button toggles
    p.style.display = 'block';
    $('ce-types').innerHTML = '<div class="ce-note" style="font-size:12px;">Loading…</div>'; $('ce-entries').innerHTML = '';
    await refresh();
  }
  window.MSContentEditor = { open: open, close: close, refresh: refresh, state: S };
})();
