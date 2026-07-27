// MapStructor — the thin site-wide top bar. One consistent strip across ALL pages (front page,
// dashboard, map viewer/editor, …): home link on the left, page actions in the middle-left slot
// (the editor moves its Publish/View/Preview/Copy/Settings + Editing-mode badge here), and the
// signed-in user (or Login) on the right. Pages just include this script; contents fill lazily.
(function () {
  'use strict';
  if (window.__msTopbarBuilt) return;
  window.__msTopbarBuilt = true;

  // ── Parallel-dev window identity (LOCAL ONLY — never shows on the real domain) ──
  // A loud fixed badge so you always know which window/worktree a browser tab belongs to:
  //   localhost:8000 → green "WINDOW A · master"   ·   localhost:8001 → orange "WINDOW B · dev-B"
  // Port is the source of truth (A serves 8000, B serves 8001). Any other localhost port = grey "?".
  // Safe to commit: gated to localhost, so production (mapstructor.com / github.io) shows nothing.
  try {
    var _h = location.hostname, _p = location.port;
    if (_h === 'localhost' || _h === '127.0.0.1') {
      var win = _p === '8001' ? { t: 'WINDOW B · dev-B', bg: '#d9822b', fg: '#fff' }
              : _p === '8000' ? { t: 'WINDOW A · master', bg: '#2e7d32', fg: '#fff' }
              : { t: 'WINDOW ? · :' + (_p || '80'), bg: '#555', fg: '#fff' };
      var mk = function () {
        if (document.getElementById('ms-window-badge')) return;
        var d = document.createElement('div');
        d.id = 'ms-window-badge';
        d.textContent = win.t;
        d.title = 'Which parallel-dev window this tab is served from (local only). ' + location.origin;
        d.style.cssText = 'position:fixed;left:50%;top:0;transform:translateX(-50%);z-index:2147483647;' +
          'background:' + win.bg + ';color:' + win.fg + ';font:700 12px/1 "Source Sans Pro",Arial,sans-serif;' +
          'letter-spacing:.4px;padding:5px 14px;border-radius:0 0 8px 8px;box-shadow:0 2px 8px rgba(0,0,0,.3);' +
          'pointer-events:none;user-select:none;';
        (document.body || document.documentElement).appendChild(d);
        // also stamp the tab title so it shows even when the tab isn't focused
        try { if (win.t.indexOf('WINDOW B') === 0 && document.title.indexOf('🅱') !== 0) document.title = '🅱 ' + document.title; } catch (e) {}
      };
      if (document.body) mk(); else document.addEventListener('DOMContentLoaded', mk);
    }
  } catch (e) {}

  var css =
    '#ms-topbar{height:40px;box-sizing:border-box;display:flex;justify-content:space-between;align-items:center;gap:10px;padding:0 12px;background:#f7f7f7;border-bottom:1px solid #ddd;font:600 13px/1 "Source Sans Pro",Arial,sans-serif;color:#444;position:sticky;top:0;z-index:1200;}' +   // sticky: stays on top when content pages scroll (map pages don't scroll — unaffected)
    '#ms-topbar-left,#ms-topbar-right{display:flex;align-items:center;gap:8px;white-space:nowrap;min-width:0;}' +
    '#ms-topbar a{text-decoration:none;color:#444;}' +
    // Hide the page's own <nav> from FIRST paint (this script is in <head>, before <body>). absorbNav then
    // moves its links into the bar. Prevents the brief "two headers" flash (page nav + bar) on load.
    'body > nav{display:none !important;}' +
    // every item in the bar renders at ONE standard size, regardless of where it came from
    '#ms-topbar-left > *, #ms-topbar-right > *{font-size:13px !important;line-height:1 !important;padding:6px 13px !important;border-radius:6px !important;box-sizing:border-box !important;height:28px !important;display:inline-flex !important;align-items:center !important;font-family:"Source Sans Pro",Arial,sans-serif !important;font-weight:600 !important;}' +
    // ...but never as an EMPTY pill: the !important display above beats a chip\'s inline display:none,
    // so a not-yet-filled account chip painted as a blank bordered box. Empty = hidden until it has text.
    '#ms-topbar-right > *:empty{display:none !important;}' +
    '#ms-topbar .ms-tb-home{gap:7px;font-size:14px !important;font-weight:700 !important;letter-spacing:.3px;color:#b0691d;padding:6px 4px !important;border:none !important;}' +
    '#ms-topbar .ms-tb-logo{height:24px;width:auto;display:block;flex-shrink:0;}' +
    '#ms-topbar .ms-tb-home:hover{color:#8a5216;}';
  var st = document.createElement('style');
  st.textContent = css;
  document.head.appendChild(st);

  var bar = document.createElement('div');
  bar.id = 'ms-topbar';
  var isMapPage = location.pathname.indexOf('/map/') > -1;
  bar.innerHTML =
    '<div id="ms-topbar-left"><a class="ms-tb-home" href="' + (isMapPage ? '../index.html' : 'index.html') + '" title="MapStructor home"><img class="ms-tb-logo" src="' + (isMapPage ? '../images/logo-transparent.png' : 'images/logo-transparent.png') + '" alt=""/>MapStructor</a></div>' +
    '<div id="ms-topbar-right"></div>';

  // Absorb the page's own <nav> into the bar: right-side links move into the right slot (one
  // header per page — nothing renders stacked under or covered by this bar). The page's own
  // brand, Home and Login links drop (the bar has its own home link + account chip).
  function absorbNav() {
    var nav = document.querySelector('body > nav');
    if (!nav || nav.getAttribute('data-ms-absorbed')) return;
    nav.setAttribute('data-ms-absorbed', '1');
    var right = bar.querySelector('#ms-topbar-right');
    var links = nav.querySelectorAll('.nav-right > *');
    if (!links.length) links = nav.querySelectorAll('a:not(.brand)');
    Array.prototype.slice.call(links).forEach(function (el) {
      var href = (el.getAttribute && el.getAttribute('href')) || '';
      if (el.id === 'nav-auth' || href === 'index.html') return;   // duplicates of the bar's own chip / home link
      if (el.id === 'nav-user') {   // the page renders its own account chip (dashboard) — suppress the bar's
        window.__msTopbarUserByPage = true;
        var c = bar.querySelector('#ms-topbar-user'); if (c) c.remove();
      }
      right.insertBefore(el, right.querySelector('#ms-topbar-user'));
    });
    nav.style.display = 'none';
  }

  function mount() {
    if (document.body && !document.getElementById('ms-topbar')) document.body.insertBefore(bar, document.body.firstChild);
    if (document.body) absorbNav();
  }
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);

  // right side: the signed-in user everywhere (email → dashboard) or Login — when the page has MapAuth.
  // The editor supplies its own chip (it moves #editor-nav-user here); skip on that page.
  function wireUser() {
    // NOTE: query the bar itself, not the document — before DOMContentLoaded the bar isn't mounted
    // yet, so a document-wide lookup missed chips already added and stacked duplicates ("3 Logins").
    if (!window.MapAuth || bar.querySelector('#ms-topbar-user') || window.__msTopbarUserByPage) return;
    var right = bar.querySelector('#ms-topbar-right');
    var a = document.createElement('a');
    a.id = 'ms-topbar-user';
    a.style.cssText = 'display:none;padding:3px 10px;border:1px solid #ccc;border-radius:5px;background:#fff;';
    right.appendChild(a);
    var refresh = function () {
      Promise.resolve(MapAuth.currentUser()).then(function (u) {
        if (MapAuth.isReal && MapAuth.isReal(u)) {
          a.textContent = u.email; a.href = (isMapPage ? '../' : '') + 'dashboard.html'; a.title = 'Your maps & account'; a.onclick = null;
        } else {
          a.textContent = 'Login'; a.href = '#'; a.title = 'Log in / register';
          a.onclick = function (e) { e.preventDefault(); if (MapAuth.openAuthModal) MapAuth.openAuthModal('login'); };
        }
        a.style.display = 'inline-block';
        var pageChip = document.getElementById('nav-auth'); if (pageChip) pageChip.style.display = 'none';   // the bar's chip replaces the page's own
      }).catch(function () {});
    };
    refresh();
    try { if (MapAuth.onChange) MapAuth.onChange(refresh); } catch (e) {}
  }
  // MapAuth may load after us — try now, then poll briefly
  wireUser();
  var tries = 0;
  var iv = setInterval(function () { wireUser(); if (bar.querySelector('#ms-topbar-user') || window.__msTopbarUserByPage || ++tries > 40) clearInterval(iv); }, 250);
})();
