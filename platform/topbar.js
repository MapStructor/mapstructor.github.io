// MapStructor — the thin site-wide top bar. One consistent strip across ALL pages (front page,
// dashboard, map viewer/editor, …): home link on the left, page actions in the middle-left slot
// (the editor moves its Publish/View/Preview/Copy/Settings + Editing-mode badge here), and the
// signed-in user (or Login) on the right. Pages just include this script; contents fill lazily.
(function () {
  'use strict';
  if (window.__msTopbarBuilt) return;
  window.__msTopbarBuilt = true;

  var css =
    '#ms-topbar{height:40px;box-sizing:border-box;display:flex;justify-content:space-between;align-items:center;gap:10px;padding:0 12px;background:#f7f7f7;border-bottom:1px solid #ddd;font:600 13px/1 "Source Sans Pro",Arial,sans-serif;color:#444;position:relative;z-index:1200;}' +
    '#ms-topbar-left,#ms-topbar-right{display:flex;align-items:center;gap:8px;white-space:nowrap;min-width:0;}' +
    '#ms-topbar a{text-decoration:none;color:#444;}' +
    // every item in the bar renders at ONE standard size, regardless of where it came from
    '#ms-topbar-left > *, #ms-topbar-right > *{font-size:13px !important;line-height:1 !important;padding:6px 13px !important;border-radius:6px !important;box-sizing:border-box !important;height:28px !important;display:inline-flex !important;align-items:center !important;font-family:"Source Sans Pro",Arial,sans-serif !important;font-weight:600 !important;}' +
    '#ms-topbar .ms-tb-home{font-size:14px !important;font-weight:700 !important;letter-spacing:.3px;color:#b0691d;padding:6px 4px !important;border:none !important;}' +
    '#ms-topbar .ms-tb-home:hover{color:#8a5216;}';
  var st = document.createElement('style');
  st.textContent = css;
  document.head.appendChild(st);

  var bar = document.createElement('div');
  bar.id = 'ms-topbar';
  var isMapPage = location.pathname.indexOf('/map/') > -1;
  bar.innerHTML =
    '<div id="ms-topbar-left"><a class="ms-tb-home" href="' + (isMapPage ? '../index.html' : 'index.html') + '" title="MapStructor home">MapStructor</a></div>' +
    '<div id="ms-topbar-right"></div>';

  function mount() { if (document.body && !document.getElementById('ms-topbar')) document.body.insertBefore(bar, document.body.firstChild); }
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);

  // right side: the signed-in user everywhere (email → dashboard) or Login — when the page has MapAuth.
  // The editor supplies its own chip (it moves #editor-nav-user here); skip on that page.
  function wireUser() {
    if (!window.MapAuth || document.getElementById('ms-topbar-user') || window.__msTopbarUserByPage) return;
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
  var iv = setInterval(function () { wireUser(); if (document.getElementById('ms-topbar-user') || window.__msTopbarUserByPage || ++tries > 40) clearInterval(iv); }, 250);
})();
