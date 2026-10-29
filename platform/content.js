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
  /* ── the map's own settings the content pages need (10/27) ──────────────────────────────
     raw_config.about (the map's About text, same as the map header's ABOUT) and
     raw_config.vetting = { pill, tip, help } — the owner's "Unvetted by human" notice: `pill` is
     the words on every entry that no human has vetted (an entry with body.vetted === true shows
     none), `tip` its tooltip, `help` where "Help Us Vet!" leads. A frozen copy carries the same
     under window.__msContent.map.raw_config. */
  var _proj = {};
  async function project(projectId) {
    if (bundle()) { var bm = bundle().map || {}; return { id: bm.id, name: bm.name, raw_config: bm.raw_config || {} }; }
    if (_proj[projectId]) return _proj[projectId];
    var d = db(); if (!d) return { id: projectId, name: null, raw_config: {} };
    var r = await d.from('projects').select('id, name, raw_config').eq('id', projectId).maybeSingle();
    var p = (!r.error && r.data) ? { id: r.data.id, name: r.data.name, raw_config: r.data.raw_config || {} } : { id: projectId, name: null, raw_config: {} };
    _proj[projectId] = p;
    return p;
  }
  // what this map calls its resource pages — "Resource", "Encyclopedia", … (raw_config.resourceName,
  // owner 10/27). The address stays /resource; only the word people see changes.
  async function resourceName(projectId) {
    var p = await project(projectId), n = p.raw_config && p.raw_config.resourceName;
    return (typeof n === 'string' && n.trim()) ? n.trim() : 'Resource';
  }
  async function vetting(projectId) {
    var p = await project(projectId), v = p.raw_config && p.raw_config.vetting;
    if (!v || typeof v !== 'object' || !v.pill) return null;
    // help = a web address, or "entry:<slug>" = a page of this map's own encyclopedia (resolves
    // to the right address on the platform, in a copy and on the public site alike)
    var help = v.help ? String(v.help) : '';
    if (/^entry:/i.test(help)) help = entryUrl(projectId, help.slice(6).trim());
    return { pill: String(v.pill), tip: v.tip ? String(v.tip) : '', help: help, about: (p.raw_config && p.raw_config.about) || '' };
  }
  function vetPill(vet, e) {
    if (!vet || !vet.pill) return '';
    if (e && e.body && e.body.vetted === true) return '';
    return '<span class="ms-ct-pill ms-ct-vet"' + (vet.tip ? ' title="' + esc(vet.tip) + '"' : '') + '>' + esc(vet.pill) + '</span>';
  }
  // the bar at the top of the encyclopedia and entry pages: "Help Us Vet!" (when it has somewhere
  // to go) and About (when the map has an About text) — one definition for both pages
  function topBar(vet) {
    if (!vet) return '';
    var h = '';
    if (vet.help) h += '<a class="ms-ct-vetbtn" href="' + esc(vet.help) + '">Help Us Vet!</a>';   // same tab — pages of the resource never open new tabs (owner 10/27)
    if (vet.about) h += '<button type="button" class="ms-ct-aboutbtn" onclick="var a=this.parentNode.nextElementSibling;if(a){a.style.display=a.style.display===\'none\'?\'\':\'none\';}">About</button>';
    if (!h) return '';
    return '<div class="ms-ct-topbar">' + h + '</div>' + (vet.about ? '<div class="ms-ct-about" style="display:none;">' + safeHtml(vet.about) + '</div>' : '');
  }
  /* 10/28 (owner: "Have the buttons be on top and in the header, all 3"): the same two buttons as
     header buttons — the page puts them in its <nav> beside Map, wearing the Map button's look
     (class ms-ct-hbtn, styled by the page), and the About text in a panel the page places. */
  function headerButtons(vet) {
    if (!vet) return { buttons: '', about: '' };
    var h = '';
    if (vet.help) h += '<a class="ms-ct-hbtn ms-ct-hvet" href="' + esc(vet.help) + '">Help Us Vet!</a>';
    if (vet.about) h += '<button type="button" class="ms-ct-hbtn ms-ct-habout" onclick="var a=document.getElementById(\'ms-ct-about\');if(a){a.style.display=a.style.display===\'none\'?\'\':\'none\';}">About</button>';
    return { buttons: h, about: vet.about ? '<div class="ms-ct-about" id="ms-ct-about" style="display:none;">' + safeHtml(vet.about) + '</div>' : '' };
  }
  /* back/forward lands where the reader left (owner 10/28): the page renders after load, so the
     browser's own restoration fires on an empty page. Remember the position per address, put it
     back once the content is there; a #fragment on a fresh visit scrolls to its element. */
  function restoreScroll() {
    try { history.scrollRestoration = 'manual'; } catch (e) {}
    var key = 'ms-scroll:' + location.pathname + location.search;
    var nav = (performance.getEntriesByType && performance.getEntriesByType('navigation')[0]) || null;
    var back = !!nav && (nav.type === 'back_forward' || nav.type === 'reload');
    var saved = null; try { saved = sessionStorage.getItem(key); } catch (e) {}
    if (back && saved != null) window.scrollTo(0, +saved);
    else if (location.hash) { var el = null; try { el = document.getElementById(decodeURIComponent(location.hash.slice(1))); } catch (e) {} if (el) el.scrollIntoView(); }
    var t = null;
    window.addEventListener('scroll', function () { if (t) return; t = setTimeout(function () { t = null; try { sessionStorage.setItem(key, String(window.scrollY)); } catch (e) {} }, 150); }, { passive: true });
    window.addEventListener('pagehide', function () { try { sessionStorage.setItem(key, String(window.scrollY)); } catch (e) {} });
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

  /* ── VERBATIM DOCUMENT CONTENT (10/28, the owner's Personal Home Protection v72 hand-off) ──
     An imported document's articles and sections are stored as their original HTML, untouched
     except that internal links carry the "ms://" scheme: "ms://entry/<slug>#frag" is another
     page of this resource, "ms://index#frag" something the index shows inline. They resolve
     here, to the right address on the platform, in a copy and on the public site alike. The
     document's own stylesheet rides along as the page entry `resource-style` (scoped to
     .ms-v70 by the import) and its two behaviours — the collapsible subnational tables and the
     country directory's search box — are re-created by delegation (the stored HTML keeps the
     document's on* attributes; safeHtml removes them, these handlers put the behaviour back). */
  function resolveMs(html, projectId) {
    return String(html == null ? '' : html)
      .replace(/href="ms:\/\/entry\/([^"#]+)(#[^"]*)?"/g, function (all, slug, frag) { return 'href="' + esc(entryUrl(projectId, decodeURIComponent(slug))) + (frag || '') + '"'; })
      .replace(/href="ms:\/\/index(#[^"]*)?"/g, function (all, frag) { return 'href="' + esc(indexUrl(projectId)) + (frag || '') + '"'; });
  }
  function v70Html(html, projectId) { return '<div class="ms-v70">' + resolveMs(safeHtml(html), projectId) + '</div>'; }
  async function pageEntries(projectId) {
    var ts = await types(projectId), pt = ts.filter(function (t) { return t.slug === 'page'; })[0];
    return pt ? await entriesForType(pt.id) : [];
  }
  // the document's stylesheet, once per page
  async function v70Style(projectId) {
    if (document.getElementById('ms-v70-css')) return true;
    var st = (await pageEntries(projectId)).filter(function (e) { return e.slug === 'resource-style' && e.body && typeof e.body.css === 'string'; })[0];
    if (!st) return false;
    var s = document.createElement('style'); s.id = 'ms-v70-css'; s.textContent = st.body.css; document.head.appendChild(s);
    document.body.classList.add('ms-wide');   // the document is laid out 1180px wide; the resource pages follow
    v70Behaviours();
    return true;
  }
  var _beh = false;
  function v70Behaviours() {
    if (_beh) return; _beh = true;
    document.addEventListener('click', function (ev) {
      var btn = ev.target && ev.target.closest ? ev.target.closest('.ms-v70 button.subnational-toggle') : null; if (!btn) return;
      var block = btn.previousElementSibling; if (!block) return;
      var collapsed = block.classList.toggle('is-collapsed');
      btn.setAttribute('aria-expanded', String(!collapsed));
      btn.textContent = collapsed ? ('See more — show all ' + btn.dataset.total + ' jurisdictions') : ('See less — show first ' + btn.dataset.preview + ' jurisdictions');
    });
    document.addEventListener('input', function (ev) {
      var inp = ev.target; if (!inp || inp.id !== 'country-directory-search') return;
      var term = (inp.value || '').trim().toLocaleLowerCase(), visible = 0;
      document.querySelectorAll('#country-directory-grid .directory-entry').forEach(function (el) { var show = (el.dataset.search || '').indexOf(term) > -1; el.hidden = !show; if (show) visible++; });
      document.querySelectorAll('.ms-v70-dirgroup').forEach(function (g) { g.hidden = !g.querySelector('.directory-entry:not([hidden])'); });
      var c = document.getElementById('country-directory-count'), total = document.querySelectorAll('#country-directory-grid .directory-entry').length;
      if (c) c.textContent = term ? ('Showing ' + visible + ' of ' + total + ' linked entries.') : ('Showing all ' + total + ' linked country/jurisdiction entries.');
    });
  }
  /* the index of a map that carries a document: the front matter (its map figure first — the
     owner wants the image at the top), then every section in the document's order (inline, or a
     link to its own page), the reader-key block in place, then the supplementary files. null when
     the map has no such pages (the index then lists entries A–Z as before). */
  async function v70Index(projectId) {
    var pages = (await pageEntries(projectId)).filter(function (e) { return e.body && /^(front|section|extra)$/.test(e.body.kind || ''); });
    if (!pages.length) return null;
    pages.sort(function (a, b) { return (a.body.order || 0) - (b.body.order || 0); });
    var out = '';
    pages.forEach(function (e) {
      var b = e.body;
      if (b.index_hidden) return;   // a section the index does not show (the four category lists — the directory covers them)
      if (b.kind === 'front') {
        var h = String(b.body || ''), m = h.match(/<figure class="top-world-map"[\s\S]*?<\/figure>/);
        if (m) {
          // the caption, one sentence per line (owner 10/28: "This needs line breaks") — the text is untouched
          var fig = m[0].replace(/<figcaption>([\s\S]*?)<\/figcaption>/, function (all, cap) {
            // the owner's own caption text when there is one (10/28): blank line = paragraph, "*" = bullet;
            // otherwise the document's caption, broken at sentences and colour clauses
            if (typeof b.caption_text === 'string' && b.caption_text.trim()) {   // paragraphs and bullet lists, spaced by style — no <br>
              var html = '', list = false;
              b.caption_text.split(/\r?\n/).forEach(function (ln) {
                ln = ln.trim();
                if (!ln) { if (list) { html += '</ul>'; list = false; } return; }
                if (ln.charAt(0) === '*') { if (!list) { html += '<ul class="ms-v70-caplist">'; list = true; } html += '<li>' + esc(ln.slice(1).trim()) + '</li>'; return; }
                if (list) { html += '</ul>'; list = false; }
                html += '<p>' + esc(ln) + '</p>';
              });
              if (list) html += '</ul>';
              return '<figcaption data-ms-generated="1">' + html + '</figcaption>';
            }
            return '<figcaption>' + cap.replace(/\. (?=[A-Z“"])/g, '. <br>').replace(/; (?=[a-z“"])/g, '; <br>') + '</figcaption>';
          });
          // under the figure: the lines printed inside the image, then the headline numbers — one per line
          var lines = (Array.isArray(b.notice) ? b.notice.map(function (s) { return esc(s); }) : [])
            .concat(Array.isArray(b.stats) ? b.stats.map(function (s) { return '<strong>' + esc(String(s.n)) + '</strong> ' + esc(s.label); }) : []);
          if (lines.length) fig += '<div class="ms-v70-stats" data-ms-generated="1">' + lines.map(function (l) { return '<div>' + l + '</div>'; }).join('') + '</div>';
          h = fig + h.replace(m[0], '');
        }
        out += resolveMs(safeHtml(h), projectId);
      } else if (b.kind === 'extra') out += resolveMs(safeHtml(b.body || ''), projectId);
      else if (b.teaser && typeof b.teaser_html === 'string') {   // the opening paragraphs, verbatim (+ the numbers), then the link to the whole page
        out += withStats(resolveMs(safeHtml(b.teaser_html), projectId), b) + '<p class="ms-v70-open-p"><a class="ms-v70-open" href="' + esc(entryUrl(projectId, e.slug)) + '">Read the full page →</a></p></section>';
      }
      // inline on the index WITHOUT the generated country lists — the directory above already lists
      // every country by status (owner 10/28: "You've already given these as sections above");
      // the section's own page keeps its list
      else if (b.inline) out += withStats(resolveMs(safeHtml(String(b.body || '').replace(/<ul class="ms-v70-articles" data-ms-generated="1">[\s\S]*?<\/ul>/g, '')), projectId), b);
      else out += '<section class="ms-v70-card" id="' + esc(b.section_id || e.slug) + '"><h2>' + esc(e.title) + '</h2><p><a class="ms-v70-open" href="' + esc(entryUrl(projectId, e.slug)) + '">Open this chapter →</a></p></section>';
    });
    var p = await project(projectId), files = p.raw_config && p.raw_config.resourceFiles;
    if (Array.isArray(files) && files.length) {
      out += '<section class="ms-v70-supp" id="supplementary"><h2>Supplementary</h2><ul>' + files.map(function (f) {
        return '<li><a href="' + esc(f.url) + '" target="_blank" rel="noopener">' + esc(f.label || f.url) + '</a>' + (f.bytes ? ' <span class="ms-ct-dim">' + (f.bytes >= 1048576 ? (f.bytes / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(f.bytes / 1024)) + ' KB') + '</span>' : '') + '</li>';
      }).join('') + '</ul></section>';
    }
    return '<div class="ms-v70">' + out + '</div>';
  }
  /* a section's headline numbers (owner 10/28: "Include the number of items in the top of the
     bibliography, the number of countries, the number of languages. Use line breaks."): stored by
     the import as body.stats = [{label, n}] and printed right under the section's heading, one per
     line, marked generated so the gate leaves it out of the verbatim compare. */
  function withStats(html, b) {
    var st = b && Array.isArray(b.stats) && b.stats.length ? b.stats : null; if (!st) return html;
    var block = '<div class="ms-v70-stats" data-ms-generated="1">' + st.map(function (s) { return '<div><strong>' + esc(String(s.n)) + '</strong> ' + esc(s.label) + '</div>'; }).join('') + '</div>';
    var m = html.match(/<\/h2>/); if (!m) return block + html;
    return html.slice(0, m.index + 5) + block + html.slice(m.index + 5);
  }
  /* the document's country directory is one A–Z grid; the owner (10/28) wants it "divided into
     sections based on status". Done on the rendered DOM, after the verbatim HTML is in place: the
     entries keep their markup and order, grouped under one heading per status (the words are the
     document's own status labels). The grid element keeps its id, so the search box still finds
     and filters every entry; a group whose entries are all filtered out hides with them. */
  var DIR_ORDER = ['cat-both', 'cat-creditors', 'cat-neither', 'cat-pending', 'cat-subnational-variation'];
  function groupDirectory(root) {
    var grid = (root || document).querySelector('#country-directory-grid'); if (!grid || grid.getAttribute('data-ms-grouped')) return;
    var entries = Array.prototype.slice.call(grid.querySelectorAll('.directory-entry')); if (!entries.length) return;
    var groups = {}, order = [];
    entries.forEach(function (el) {
      var cat = Array.prototype.filter.call(el.classList, function (c) { return /^cat-/.test(c); })[0] || 'cat-other';
      if (!groups[cat]) { groups[cat] = { els: [], label: ((el.querySelector('.map-status') || {}).textContent || cat.replace(/^cat-/, '')).trim() }; order.push(cat); }
      groups[cat].els.push(el);
    });
    order.sort(function (a, b) { var ia = DIR_ORDER.indexOf(a), ib = DIR_ORDER.indexOf(b); return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib); });
    grid.innerHTML = ''; grid.className = 'ms-v70-dirgroups'; grid.setAttribute('data-ms-grouped', '1');
    order.forEach(function (cat) {
      var g = groups[cat];
      var wrap = document.createElement('div'); wrap.className = 'ms-v70-dirgroup ' + cat;
      var h = document.createElement('h3'); h.className = 'ms-v70-dirh'; h.textContent = g.label + ' · ' + g.els.length; wrap.appendChild(h);
      var inner = document.createElement('div'); inner.className = 'country-directory-grid';
      g.els.forEach(function (el) { inner.appendChild(el); });
      wrap.appendChild(inner); grid.appendChild(wrap);
    });
  }

  // the info panel: title, enum pills, summary, the panel-facing fields, then Read more
  function renderPanel(type, e, projectId, vet) {
    var fields = (type && type.fields) || [];
    var pills = fields.filter(function (f) { return f.kind === 'enum' && showOn(f, 'panel') && e.body && e.body[f.key] != null; })
      .map(function (f) { return pill(f, e.body[f.key]); }).concat([vetPill(vet, e)]).filter(Boolean).join(' ');
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
      .map(function (f) { return pill(f, e.body[f.key]); }).concat([vetPill(ctx.vet, e)]).filter(Boolean).join(' ');
    var crumbs = '<p class="ms-ct-crumbs"><a href="' + esc(indexUrl(projectId)) + '">' + esc((ctx && ctx.indexLabel) || 'Resource') + '</a>' +
      (ctx && ctx.parent ? ' › <a href="' + esc(entryUrl(projectId, ctx.parent.slug)) + '">' + esc(ctx.parent.title) + '</a>' : '') + '</p>';
    var kids = (ctx && ctx.children && ctx.children.length ? '<section class="ms-ct-sec"><h2>' + esc(ctx.childrenLabel || 'Within') + '</h2><ul class="ms-ct-kids">' +
      ctx.children.map(function (c) { return '<li><a href="' + esc(entryUrl(projectId, c.slug)) + '">' + esc(c.title) + '</a>' + (c.summary ? ' <span class="ms-ct-dim">— ' + esc(c.summary) + '</span>' : '') + '</li>'; }).join('') + '</ul></section>' : '');
    // a VERBATIM article (body.article) or document section (body.kind section/front/extra): the
    // stored HTML as it is — its own heading is the title, no footnote rewriting, nothing summarised
    if (e.body && typeof e.body.article === 'string') {
      return '<article class="ms-ct-article ms-ct-verbatim">' + crumbs + (pills ? '<div class="ms-ct-pills">' + pills + '</div>' : '') + v70Html(e.body.article, projectId) + kids + '</article>';
    }
    if (e.body && /^(section|front|extra)$/.test(e.body.kind || '') && typeof e.body.body === 'string') {
      return '<article class="ms-ct-article ms-ct-verbatim">' + crumbs + '<div class="ms-v70">' + withStats(resolveMs(safeHtml(e.body.body), projectId), e.body) + '</div>' + '</article>';
    }
    var sourcesField = fields.filter(function (f) { return f.kind === 'richtext' && showOn(f, 'page') && /^sources?$/i.test(f.key); })[0];
    var parts = fields.filter(function (f) { return f.kind !== 'enum' && showOn(f, 'page'); }).map(function (f) {
      var h = valueHtml(f, e.body && e.body[f.key], ctx); if (!h) return '';
      return '<section class="ms-ct-sec"><h2>' + esc(f.label || f.key) + '</h2>' + h + '</section>';
    }).join('') + ctx.fn.html(sourcesField ? (sourcesField.label || sourcesField.key) : 'Sources');
    return '<article class="ms-ct-article">' +
      '<p class="ms-ct-crumbs"><a href="' + esc(indexUrl(projectId)) + '">' + esc((ctx && ctx.indexLabel) || 'Resource') + '</a>' +
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
      // the vetting notice (10/27): amber so it reads as a status, not one of the data's own pills; the tooltip explains
      '.ms-ct-pill.ms-ct-vet{background:#fff4d6;border-color:#d9a21b;color:#7a5a00;cursor:help}' +
      // in the INFO PANEL the pills read in black (text + border) over their tint: a panel that
      // wears the feature's colour made a green pill vanish into a green frame (owner 10/28)
      '.ms-ct-panel .ms-ct-pill{color:#000!important;border-color:#000!important}' +
      '.ms-ct-topbar{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin:0 0 14px}' +
      '.ms-ct-vetbtn{display:inline-block;text-decoration:none;font:800 15px/1.2 "Source Sans Pro",Arial,sans-serif;letter-spacing:.02em;padding:11px 20px;border-radius:9px;background:#d9a21b;color:#2a1f00;box-shadow:0 2px 0 #a67a0b}' +
      '.ms-ct-vetbtn:hover{background:#e8b22b}' +
      '.ms-ct-aboutbtn{font:700 13px/1.2 "Source Sans Pro",Arial,sans-serif;padding:10px 16px;border-radius:9px;border:1px solid rgba(124,92,191,.35);background:#fff;color:#6246a8;cursor:pointer}' +
      '.ms-ct-about{background:#fff;border:1px solid rgba(124,92,191,.18);border-radius:12px;padding:16px 18px;margin:0 0 16px;font-size:15px;line-height:1.55;color:#2b2540}' +
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
      '.ms-ct-fn{margin:4px 0 0 22px;padding:0;font-size:14px;line-height:1.5}.ms-ct-fn li{margin:5px 0;overflow-wrap:anywhere}.ms-ct-fn li:target{background:#f3f1f8}.ms-ct-fn a{color:#5b43a8}.ms-ct-fn .ms-ct-dim{font-size:12.5px;margin-left:4px}.ms-ct-fnback{text-decoration:none;margin-left:6px;color:#9a94b3}.ms-ct-fnback:hover{color:#5b43a8}' +
      // verbatim document pages (10/28): the page follows the document's 1180 px layout; the
      // chapter cards and the supplementary list are the resource's own, kept quiet
      'body.ms-wide main{max-width:1240px}.ms-ct-verbatim{max-width:none;padding-top:12px}' +
      '.ms-v70 .ms-v70-articles{list-style:none;padding:0;margin:12px 0 4px;columns:3;column-gap:24px}.ms-v70 .ms-v70-articles li{break-inside:avoid;padding:5px 0;border-bottom:1px solid #ece9e2}.ms-v70 .ms-v70-articles a{font-weight:650;text-decoration:none}' +
      '@media(max-width:800px){.ms-v70 .ms-v70-articles{columns:1}}' +
      '.ms-v70 .ms-v70-card{border-left:5px solid #7c5cbf}.ms-v70 .ms-v70-open{font-weight:700;text-decoration:none}.ms-v70 .ms-v70-open-p{margin:14px 0 4px}' +
      // breathing room inside the document (owner 10/28: "add a style to add space … and after section
      // headers"): the page's global margin reset reached the document's paragraphs
      '.ms-v70 p{margin:0 0 .9em}.ms-v70 h2{margin-bottom:16px!important}.ms-v70 h3{margin-bottom:12px}.ms-v70 h4,.ms-v70 h5{margin:1em 0 .5em}' +
      '.ms-v70 ul,.ms-v70 ol{margin:.4em 0 1em}.ms-v70 li{margin:.3em 0}.ms-v70 table{margin:.7em 0 1.1em}.ms-v70 details{margin:.9em 0}.ms-v70 figcaption p{margin:0 0 .6em}' +
      '.ms-v70 .ms-v70-caplist{margin:.2em 0 .8em;padding-left:1.4rem}.ms-v70 .ms-v70-caplist li{margin:.2em 0}.ms-v70 .ms-v70-stats div{margin:.15em 0}' +
      '.ms-v70 .ms-v70-stats{font-size:1.05rem;line-height:1.7;margin:10px 0 16px;padding:12px 16px;background:#f6f4ef;border-left:4px solid #b58a3a;border-radius:10px}' +
      '.ms-v70 .ms-v70-dirgroup{margin:14px 0 6px}.ms-v70 .ms-v70-dirh{font-size:1.05rem!important;margin:14px 0 6px!important;padding:0 0 4px!important;border-bottom:1px solid #dbe2e1}' +
      '.ms-v70 .ms-v70-dirgroup.cat-both .ms-v70-dirh{color:#277f5b}.ms-v70 .ms-v70-dirgroup.cat-creditors .ms-v70-dirh{color:#3978c5}.ms-v70 .ms-v70-dirgroup.cat-neither .ms-v70-dirh{color:#bd6155}.ms-v70 .ms-v70-dirgroup.cat-pending .ms-v70-dirh{color:#84898c}.ms-v70 .ms-v70-dirgroup.cat-subnational-variation .ms-v70-dirh{color:#8c6e37}' +
      '.ms-v70 .ms-v70-supp ul{padding-left:1.3rem}.ms-v70 .ms-v70-supp li{margin:.4rem 0}';
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
    var vet = null; try { vet = await vetting(projectId); } catch (eV) {}
    return { html: hits.map(function (e) { return renderPanel(type, e, projectId, vet); }).join('<hr class="ms-ct-sep"/>'), title: hits.length === 1 ? hits[0].title : (props[keyProp] + ' — ' + hits.length + ' entries') };
  }

  window.MSContent = {
    mapId: mapId, types: types, entriesForType: entriesForType, entryBySlug: entryBySlug, entriesForKey: entriesForKey, invalidate: invalidate,
    project: project, vetting: vetting, vetPill: vetPill, topBar: topBar, headerButtons: headerButtons, restoreScroll: restoreScroll, groupDirectory: groupDirectory, resourceName: resourceName,
    linksOf: linksOf, entriesById: entriesById, fieldOf: fieldOf, enumLabel: enumLabel, enumColor: enumColor,
    renderPanel: renderPanel, renderPage: renderPage, panelFor: panelFor, entryUrl: entryUrl, indexUrl: indexUrl, css: css, esc: esc, safeHtml: safeHtml,
    v70: { style: v70Style, index: v70Index, html: v70Html, resolve: resolveMs, behaviours: v70Behaviours }
  };
})();
