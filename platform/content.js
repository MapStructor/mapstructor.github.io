// content.js — the content system's READER (step 3, 10/16): a map's content types and entries,
// rendered the same way on three surfaces — the info panel (click a feature), the entry page
// (map/entry.html, "Read more") and the encyclopedia index (map/encyclopedia.html).
//
// Where the data lives: content_types / entries / entry_links (sql/setup/content-system-setup.sql),
// read with the page's own Supabase client (anonymous readers see what the map shows). A
// published copy or a download can hand the same data over statically as window.__msContent
// = { types:[…], entries:[…], links:[…] } — checked first, so the three surfaces work offline.
//
// A FEATURE-BACKED type binds a layer property to entries.key: panel.entries = { type, key } on
// a layer says "look the clicked feature's <key> property up in this type". One feature may
// match several entries (the UK polygon: England & Wales / Scotland / Northern Ireland) and an
// entry may claim several codes (body.keys — Bosnia's entities over Natural Earth's cantons).
//
// Rendering is driven by the type's `fields` ([{key,label,kind,options,labels,colors,show}]):
//   kind text | richtext | enum | number | date | url | list | link | image
//   show panel | page | both        (hide-if-empty everywhere — an empty field prints nothing)
// Enum fields may carry labels {value: text} and colors {value: hex}; the map's fill colour and
// the pills read the SAME colors, which is what "colour from the data" means here.
(function () {
  'use strict';
  if (window.MSContent) return;
  var SB_URL = 'https://eqpxlwbjqiwfjlsuapvu.supabase.co';
  var SB_KEY = 'sb_publishable_ijLmSmMUeNBrgMGL8Aol4g_S5-xwUzD';
  function db() { return (window.MapAuth && MapAuth.db) || (window.supabase && supabase.createClient(SB_URL, SB_KEY)) || null; }
  function esc(s) { return String(s == null ? '' : s).replace(/[<>&"]/g, function (c) { return ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]; }); }
  function safeHtml(h) { return String(h == null ? '' : h).replace(/<script[\s\S]*?<\/script>/gi, '').replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '').replace(/javascript:/gi, ''); }
  function mapId() { try { var id = (new URLSearchParams(location.search).get('id') || '').trim(); return /^[0-9a-f-]{36}$/i.test(id) ? id : null; } catch (e) { return null; } }

  // ── data ──────────────────────────────────────────────────────────────────
  var cache = { types: null, entriesByType: {}, links: null };
  function bundle() { return window.__msContent || null; }
  function invalidate() { cache.types = null; cache.entriesByType = {}; cache.links = null; }   // the editor saved a type or an entry: the next click reads fresh

  async function types(projectId) {
    if (bundle()) return bundle().types || [];
    if (cache.types) return cache.types;
    var d = db(); if (!d) return [];
    var r = await d.from('content_types').select('id, slug, name, name_plural, fields, layer_id, feature_key').eq('project_id', projectId).order('name');
    cache.types = r.error ? [] : (r.data || []);
    return cache.types;
  }
  async function entriesForType(typeId) {
    if (bundle()) return (bundle().entries || []).filter(function (e) { return e.type_id === typeId; });
    if (cache.entriesByType[typeId]) return cache.entriesByType[typeId];
    var d = db(); if (!d) return [];
    var out = [], last = null;
    for (;;) {
      var q = d.from('entries').select('id, type_id, slug, title, key, summary, body, status').eq('type_id', typeId).eq('status', 'published').order('slug').limit(1000);
      if (last) q = q.gt('slug', last);
      var r = await q; if (r.error || !r.data || !r.data.length) break;
      out = out.concat(r.data); last = r.data[r.data.length - 1].slug;
      if (r.data.length < 1000) break;
    }
    cache.entriesByType[typeId] = out;
    return out;
  }
  async function entryBySlug(projectId, slug) {
    if (bundle()) return (bundle().entries || []).find(function (e) { return e.slug === slug; }) || null;
    var d = db(); if (!d) return null;
    var r = await d.from('entries').select('id, type_id, slug, title, key, summary, body, status').eq('project_id', projectId).eq('slug', slug).maybeSingle();
    return r.error ? null : r.data;
  }
  // every entry whose key — or body.keys list — carries this value
  async function entriesForKey(typeId, value) {
    if (value == null || value === '') return [];
    var v = String(value);
    return (await entriesForType(typeId)).filter(function (e) {
      if (e.key != null && String(e.key) === v) return true;
      var ks = e.body && e.body.keys;
      return Array.isArray(ks) && ks.some(function (k) { return String(k) === v; });
    });
  }
  async function linksOf(projectId, entryId) {
    var rows;
    if (bundle()) rows = (bundle().links || []).filter(function (l) { return l.from_id === entryId || l.to_id === entryId; });
    else {
      var d = db(); if (!d) return { out: [], in: [] };
      var r = await d.from('entry_links').select('from_id, to_id, rel, position').eq('project_id', projectId).or('from_id.eq.' + entryId + ',to_id.eq.' + entryId);
      rows = r.error ? [] : (r.data || []);
    }
    return { out: rows.filter(function (l) { return l.from_id === entryId; }), in: rows.filter(function (l) { return l.to_id === entryId; }) };
  }
  async function entriesById(projectId, ids) {
    if (!ids.length) return {};
    var out = {};
    if (bundle()) { (bundle().entries || []).forEach(function (e) { if (ids.indexOf(e.id) > -1) out[e.id] = e; }); return out; }
    var d = db(); if (!d) return out;
    var r = await d.from('entries').select('id, type_id, slug, title, key, summary').eq('project_id', projectId).in('id', ids);
    (r.error ? [] : (r.data || [])).forEach(function (e) { out[e.id] = e; });
    return out;
  }

  // ── rendering ─────────────────────────────────────────────────────────────
  function fieldOf(type, key) { return ((type && type.fields) || []).filter(function (f) { return f.key === key; })[0] || null; }
  function enumLabel(f, v) { return (f && f.labels && f.labels[String(v)]) || String(v); }
  function enumColor(f, v) { return (f && f.colors && f.colors[String(v)]) || null; }
  function pill(f, v) {
    var c = enumColor(f, v);
    return '<span class="ms-ct-pill"' + (c ? ' style="background:' + esc(c) + '1f;border-color:' + esc(c) + ';color:' + esc(c) + '"' : '') + '>' + esc(enumLabel(f, v)) + '</span>';
  }
  /* ── citations as footnotes (10/21) ─────────────────────────────────────────
     On the entry page every web link inside an entry's text (richtext and list fields) becomes a
     numbered note at the foot of the page: the link text stays in the sentence with a superscript
     number, the address lives once in the "Sources" list — the same address always gets the same
     number. A <p class="sources"> block inside a richtext (the import keeps the document's own
     sources line inside the evidence) is folded into the notes rather than printed twice, and a
     Sources field that is nothing but links is shown AS the notes list instead of as a section of
     its own. Links to other entries (relative addresses) are not citations and stay as they are.
     The info panel keeps inline links — there is no foot to a panel. */
  function footnotes() {
    var list = [], byHref = {}, seq = 0, cited = {};
    function ref(href, text) {
      var n = byHref[href];
      if (!n) { n = list.length + 1; byHref[href] = n; list.push({ n: n, href: href, text: text, host: (href.match(/^https?:\/\/([^\/?#]+)/i) || [])[1] || '' }); }
      return n;
    }
    var A = /<a\b([^>]*?)href=(?:"([^"]*)"|'([^']*)')([^>]*)>([\s\S]*?)<\/a>/gi;
    // register every web link; `print` false = fold silently (the block is dropped from the page)
    function fold(html, print) {
      return String(html == null ? '' : html).replace(A, function (all, pre, h1, h2, post, inner) {
        var href = h1 != null ? h1 : h2;
        if (!/^https?:\/\//i.test(href || '')) return all;
        var text = inner.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() || href;
        var n = ref(href, text);
        if (!print) return text;
        seq++; cited[n] = true;
        return text + '<sup class="ms-ct-fnref"><a href="#ms-fn-' + n + '" id="ms-fnref-' + seq + '" data-fn="' + n + '">' + n + '</a></sup>';
      });
    }
    function rich(html) {   // a richtext value for the page: the document's own sources lines fold into the notes
      var h = String(html == null ? '' : html).replace(/<p\b[^>]*class=(?:"[^"]*\bsources\b[^"]*"|'[^']*\bsources\b[^']*')[^>]*>([\s\S]*?)<\/p>/gi, function (all, inner) { fold(inner, false); return ''; });
      return fold(h, true);
    }
    // true when a value is only a list of links (a "Sources: a; b." line) — the notes carry it
    function linksOnly(html) {
      var h = String(html == null ? '' : html);
      if (!A.test(h)) { A.lastIndex = 0; return false; }
      A.lastIndex = 0;
      var rest = h.replace(A, '').replace(/<[^>]+>/g, '').replace(/&nbsp;|&amp;|&#\d+;/g, ' ').replace(/\bsources?\s*:?/i, '').replace(/[\s;:,.·—–-]+/g, '');
      return rest === '';
    }
    function html(label) {
      if (!list.length) return '';
      return '<section class="ms-ct-sec ms-ct-notes"><h2>' + esc(label || 'Sources') + '</h2><ol class="ms-ct-fn">' + list.map(function (it) {
        return '<li id="ms-fn-' + it.n + '"><a href="' + esc(it.href) + '" target="_blank" rel="noopener">' + esc(it.text) + '</a>' +
          (it.host && it.host.toLowerCase() !== it.text.toLowerCase() ? ' <span class="ms-ct-dim">' + esc(it.host.replace(/^www\./, '')) + '</span>' : '') +
          (cited[it.n] ? ' <a class="ms-ct-fnback" href="#" data-fn="' + it.n + '" title="Back to the text">↩</a>' : '') + '</li>';   // ↩ only where the text cites the note (a sources line alone has nowhere to go back to)
      }).join('') + '</ol></section>';
    }
    return { fold: fold, rich: rich, linksOnly: linksOnly, html: html, count: function () { return list.length; } };
  }
  function valueHtml(f, v, ctx) {
    if (v == null || v === '' || (Array.isArray(v) && !v.length)) return '';
    var fn = ctx && ctx.fn;
    switch (f.kind) {
      case 'enum': return pill(f, v);
      case 'list': return '<ul class="ms-ct-list">' + (Array.isArray(v) ? v : [v]).map(function (x) { return '<li>' + (fn ? fn.fold(safeHtml(x), true) : safeHtml(x)) + '</li>'; }).join('') + '</ul>';
      case 'richtext': {
        if (fn && fn.linksOnly(v)) { fn.fold(safeHtml(v), false); return ''; }   // a bare sources line = the notes list, not a section
        var rh = fn ? fn.rich(safeHtml(v)) : safeHtml(v);
        return /\S/.test(rh.replace(/<[^>]+>/g, '')) ? '<div class="ms-ct-rich">' + rh + '</div>' : '';
      }
      case 'url': return '<a href="' + esc(v) + '" target="_blank" rel="noopener">' + esc(v) + '</a>';
      case 'image': return '<img class="ms-ct-img" src="' + esc(v) + '" alt="">';
      case 'link': return ctx && ctx.linkHtml ? ctx.linkHtml(v) : esc(v);
      default: return '<p>' + esc(v) + '</p>';
    }
  }
  function showOn(f, surface) { var s = f.show || 'both'; return s === 'both' || s === surface; }
  function entryUrl(projectId, slug) { return (window.__msContentBase || 'entry.html?id=' + encodeURIComponent(projectId) + '&entry=') + encodeURIComponent(slug); }
  function indexUrl(projectId) { return window.__msContentIndex || ('encyclopedia.html?id=' + encodeURIComponent(projectId)); }

  // the info panel: title, enum pills, summary, the panel-facing fields, then Read more
  function renderPanel(type, e, projectId) {
    var fields = (type && type.fields) || [];
    var pills = fields.filter(function (f) { return f.kind === 'enum' && showOn(f, 'panel') && e.body && e.body[f.key] != null; })
      .map(function (f) { return pill(f, e.body[f.key]); }).join(' ');
    var rest = fields.filter(function (f) { return f.kind !== 'enum' && f.kind !== 'link' && showOn(f, 'panel'); })
      .map(function (f) { var h = valueHtml(f, e.body && e.body[f.key]); return h ? '<div class="ms-ct-field"><div class="ms-ct-lbl">' + esc(f.label || f.key) + '</div>' + h + '</div>' : ''; }).join('');
    return '<div class="ms-ct-panel">' +
      '<h3>' + esc(e.title) + '</h3>' +
      (pills ? '<div class="ms-ct-pills">' + pills + '</div>' : '') +
      (e.summary ? '<hr/><p class="ms-ct-summary">' + esc(e.summary) + '</p>' : '') +
      rest +
      '<p class="ms-ct-more"><a href="' + esc(entryUrl(projectId, e.slug)) + '" target="_blank" rel="noopener">Read more →</a></p>' +
      '</div>';
  }
  // the full page body (entry.html): everything the type shows on the page
  function renderPage(type, e, projectId, ctx) {
    var fields = (type && type.fields) || [];
    ctx = ctx || {};
    ctx.fn = footnotes();   // the page's citations, numbered in reading order (fields in the type's order)
    var pills = fields.filter(function (f) { return f.kind === 'enum' && showOn(f, 'page') && e.body && e.body[f.key] != null; })
      .map(function (f) { return pill(f, e.body[f.key]); }).join(' ');
    var sourcesField = fields.filter(function (f) { return f.kind === 'richtext' && showOn(f, 'page') && /^sources?$/i.test(f.key); })[0];
    var parts = fields.filter(function (f) { return f.kind !== 'enum' && showOn(f, 'page'); }).map(function (f) {
      var h = valueHtml(f, e.body && e.body[f.key], ctx); if (!h) return '';
      return '<section class="ms-ct-sec"><h2>' + esc(f.label || f.key) + '</h2>' + h + '</section>';
    }).join('') + ctx.fn.html(sourcesField ? (sourcesField.label || sourcesField.key) : 'Sources');
    return '<article class="ms-ct-article">' +
      '<p class="ms-ct-crumbs"><a href="' + esc(indexUrl(projectId)) + '">' + esc((ctx && ctx.indexLabel) || 'Encyclopedia') + '</a>' +
      (ctx && ctx.parent ? ' › <a href="' + esc(entryUrl(projectId, ctx.parent.slug)) + '">' + esc(ctx.parent.title) + '</a>' : '') + '</p>' +
      '<h1>' + esc(e.title) + '</h1>' +
      (pills ? '<div class="ms-ct-pills">' + pills + '</div>' : '') +
      (e.summary ? '<p class="ms-ct-summary ms-ct-lead">' + esc(e.summary) + '</p>' : '') +
      parts +
      (ctx && ctx.children && ctx.children.length ? '<section class="ms-ct-sec"><h2>' + esc(ctx.childrenLabel || 'Within') + '</h2><ul class="ms-ct-kids">' +
        ctx.children.map(function (c) { return '<li><a href="' + esc(entryUrl(projectId, c.slug)) + '">' + esc(c.title) + '</a>' + (c.summary ? ' <span class="ms-ct-dim">— ' + esc(c.summary) + '</span>' : '') + '</li>'; }).join('') + '</ul></section>' : '') +
      '</article>';
  }
  function css() {
    if (document.getElementById('ms-ct-css')) return;
    var s = document.createElement('style'); s.id = 'ms-ct-css';
    s.textContent =
      '.ms-ct-pills{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0 8px}' +
      '.ms-ct-pill{display:inline-block;padding:3px 9px;border:1px solid #9a94b3;border-radius:999px;background:#f3f1f8;color:#4a3f66;font:700 11px/1.3 "Source Sans Pro",Arial,sans-serif;letter-spacing:.03em}' +
      '.ms-ct-summary{font-size:14px;line-height:1.5}.ms-ct-lead{font-size:18px;line-height:1.5;color:#2b2540}' +
      '.ms-ct-field{margin:8px 0}.ms-ct-lbl{font:700 11px "Source Sans Pro",Arial,sans-serif;letter-spacing:.08em;text-transform:uppercase;color:#7c5cbf;margin-bottom:2px}' +
      '.ms-ct-list{margin:4px 0 4px 18px;padding:0;font-size:13px;line-height:1.45}.ms-ct-list li{margin:5px 0}' +
      '.ms-ct-rich{font-size:14px;line-height:1.55;overflow-wrap:anywhere}.ms-ct-rich a{color:#5b43a8}' +
      '.ms-ct-more{margin:10px 0 2px;font-weight:700}.ms-ct-more a{color:#5b43a8;text-decoration:none}.ms-ct-more a:hover{text-decoration:underline}' +
      '.ms-ct-article{max-width:820px;margin:0 auto;padding:24px 16px 60px;font-family:"Source Sans Pro",Arial,sans-serif;color:#2b2540}' +
      '.ms-ct-article h1{font-size:32px;line-height:1.15;margin:6px 0 10px;letter-spacing:-.01em}.ms-ct-article h2{font-size:15px;letter-spacing:.08em;text-transform:uppercase;color:#7c5cbf;margin:26px 0 8px;border-bottom:1px solid #e6e2f1;padding-bottom:6px}' +
      '.ms-ct-crumbs{font-size:13px;color:#6b6680}.ms-ct-crumbs a{color:#5b43a8;text-decoration:none}' +
      '.ms-ct-sec .ms-ct-list{font-size:15px}.ms-ct-sec .ms-ct-rich{font-size:15px}' +
      '.ms-ct-kids{list-style:none;padding:0;margin:0}.ms-ct-kids li{padding:7px 0;border-bottom:1px solid #f0edf7;font-size:15px}.ms-ct-kids a{color:#5b43a8;font-weight:700;text-decoration:none}.ms-ct-dim{color:#6b6680}' +
      '.ms-ct-fnref{font-size:.72em;line-height:0;vertical-align:super;margin-left:1px}.ms-ct-fnref a{color:#5b43a8;text-decoration:none;font-weight:700;padding:0 1px}.ms-ct-fnref a:hover{text-decoration:underline}' +
      '.ms-ct-fn{margin:4px 0 0 22px;padding:0;font-size:14px;line-height:1.5}.ms-ct-fn li{margin:5px 0;overflow-wrap:anywhere}.ms-ct-fn li:target{background:#f3f1f8}.ms-ct-fn a{color:#5b43a8}.ms-ct-fn .ms-ct-dim{font-size:12.5px;margin-left:4px}.ms-ct-fnback{text-decoration:none;margin-left:6px;color:#9a94b3}.ms-ct-fnback:hover{color:#5b43a8}';
    document.head.appendChild(s);
    // the ↩ of a note goes back to the FIRST place in the text that cites it
    document.addEventListener('click', function (ev) {
      var a = ev.target && ev.target.closest ? ev.target.closest('a.ms-ct-fnback') : null; if (!a) return;
      ev.preventDefault();
      var ref = document.querySelector('sup.ms-ct-fnref a[data-fn="' + a.getAttribute('data-fn') + '"]');
      if (ref) { ref.scrollIntoView({ block: 'center' }); try { ref.focus(); } catch (e) {} }
    });
  }

  // ── the info-panel hook (engine/infoPanel.js, mode "entries") ─────────────
  // Resolves the clicked feature to its entries and returns { html, title } or null.
  async function panelFor(layer, props) {
    var cfg = layer && layer.panel && layer.panel.entries; if (!cfg || !cfg.type) return null;
    var projectId = cfg.project || mapId(); if (!projectId) return null;
    var keyProp = cfg.key || 'label';
    var v = props ? props[keyProp] : null;
    var hits = await entriesForKey(cfg.type, v);
    if (!hits.length) return null;
    var ts = await types(projectId);
    var type = ts.filter(function (t) { return t.id === cfg.type; })[0] || null;
    css();
    hits.sort(function (a, b) { return a.title.localeCompare(b.title); });
    return { html: hits.map(function (e) { return renderPanel(type, e, projectId); }).join('<hr class="ms-ct-sep"/>'), title: hits.length === 1 ? hits[0].title : (props[keyProp] + ' — ' + hits.length + ' entries') };
  }

  window.MSContent = {
    mapId: mapId, types: types, entriesForType: entriesForType, entryBySlug: entryBySlug, entriesForKey: entriesForKey, invalidate: invalidate,
    linksOf: linksOf, entriesById: entriesById, fieldOf: fieldOf, enumLabel: enumLabel, enumColor: enumColor,
    renderPanel: renderPanel, renderPage: renderPage, panelFor: panelFor, entryUrl: entryUrl, indexUrl: indexUrl, css: css, esc: esc, safeHtml: safeHtml
  };
})();
