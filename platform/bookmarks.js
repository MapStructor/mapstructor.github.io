// MapStructor — map bookmarks (Map Portal component 1, plan step 2).
// One module, two backends: a REAL signed-in user's bookmarks live in the map_bookmarks table
// (portal-bookmarks-setup.sql); everyone else's live in localStorage. On the first real login the
// localStorage list is carried into the account and cleared — bookmarks survive registration.
// The ★ injects itself into the shared #ms-topbar on map pages (viewer + editor both load the
// topbar), so no other file needs edits to grow a star. Portal cards call MSBookmarks.star(...).
(function () {
  'use strict';
  if (window.MSBookmarks) return;

  var SUPABASE_URL = 'https://eqpxlwbjqiwfjlsuapvu.supabase.co';
  var SUPABASE_KEY = 'sb_publishable_ijLmSmMUeNBrgMGL8Aol4g_S5-xwUzD';
  var LS_KEY = 'msBookmarks';

  // reuse auth.js's client (always loaded first on every page that includes us) — one client,
  // one session. Fallback builds our own only if a page ever includes us without auth.js.
  var db = (window.MapAuth && MapAuth.db)
    || ((window.supabase && window.supabase.createClient) ? window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY) : null);

  function localList() {
    try { var a = JSON.parse(localStorage.getItem(LS_KEY) || '[]'); return Array.isArray(a) ? a : []; }
    catch (e) { return []; }
  }
  function localSave(a) { try { localStorage.setItem(LS_KEY, JSON.stringify(a)); } catch (e) {} }

  // real user = DB backend; anonymous or logged-out = localStorage
  function realUser() {
    if (!window.MapAuth || !db) return Promise.resolve(null);
    return Promise.resolve(MapAuth.currentUser()).then(function (u) {
      return (MapAuth.isReal && MapAuth.isReal(u)) ? u : null;
    }).catch(function () { return null; });
  }

  // one-time carry-in: local bookmarks become account rows on real login (ignore dup conflicts)
  var carried = false;
  function carryIn(u) {
    if (carried) return Promise.resolve();
    var ids = localList();
    if (!ids.length) { carried = true; return Promise.resolve(); }
    carried = true;
    var rows = ids.map(function (id) { return { user_id: u.id, project_id: id }; });
    return db.from('map_bookmarks').upsert(rows, { onConflict: 'user_id,project_id', ignoreDuplicates: true })
      .then(function (r) {
        // rows referencing DELETED maps violate the FK — fall back to one-by-one, drop the dead
        if (r.error) return Promise.all(rows.map(function (row) { return db.from('map_bookmarks').upsert(row, { onConflict: 'user_id,project_id', ignoreDuplicates: true }); }));
      })
      .then(function () { localSave([]); })
      .catch(function () {});
  }

  function list() {
    return realUser().then(function (u) {
      if (!u) return localList();
      return carryIn(u).then(function () {
        return db.from('map_bookmarks').select('project_id').order('created_at', { ascending: false });
      }).then(function (r) {
        return (r && !r.error && r.data) ? r.data.map(function (x) { return x.project_id; }) : [];
      });
    });
  }
  function has(id) { return list().then(function (ids) { return ids.indexOf(id) > -1; }); }
  function toggle(id) {
    return realUser().then(function (u) {
      if (!u) {
        var a = localList(), i = a.indexOf(id);
        if (i > -1) a.splice(i, 1); else a.unshift(id);
        localSave(a);
        return i === -1;
      }
      return has(id).then(function (on) {
        if (on) return db.from('map_bookmarks').delete().eq('user_id', u.id).eq('project_id', id).then(function () { return false; });
        return db.from('map_bookmarks').insert({ user_id: u.id, project_id: id }).then(function (r) { return !r.error; });
      });
    });
  }

  // ── the ★ itself: paint one element as a live bookmark toggle ─────────────
  function star(el, projectId) {
    function paint(on) {
      el.textContent = on ? '★' : '☆';
      el.title = on ? 'Bookmarked — click to remove' : 'Bookmark this map';
      el.style.color = on ? '#b0691d' : '#888';
    }
    el.style.cursor = 'pointer';
    el.setAttribute('aria-label', 'Bookmark this map');
    paint(false);
    has(projectId).then(paint);
    el.addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      toggle(projectId).then(function (on) {
        paint(on);
        // let any list of bookmarks on the page redraw itself immediately (dashboard's
        // Bookmarks strip) — starring your own map should show up without a refresh (8/6)
        try { window.dispatchEvent(new CustomEvent('ms-bookmarks-changed', { detail: { projectId: projectId, on: on } })); } catch (e2) {}
      });
    });
    return el;
  }

  // ── topbar injection on map pages (viewer + editor share #ms-topbar) ──────
  function mountTopbarStar() {
    if (location.pathname.indexOf('/map/') === -1) return true;     // only map pages get the header ★
    var pid = new URLSearchParams(location.search).get('id');
    if (!pid) return true;                                          // no map open (blank editor) — nothing to bookmark
    var right = document.querySelector('#ms-topbar-right');
    if (!right) return false;                                       // topbar not mounted yet — poll again
    if (document.getElementById('ms-bookmark-star')) return true;
    var b = document.createElement('a');
    b.id = 'ms-bookmark-star';
    b.href = '#';
    b.style.cssText = 'font-size:17px !important;padding:6px 8px !important;border:none !important;background:none !important;text-decoration:none;';
    right.insertBefore(b, right.firstChild);
    star(b, pid);
    // login/logout swaps the backend — repaint from the right one
    try { if (window.MapAuth && MapAuth.onChange) MapAuth.onChange(function () { has(pid).then(function (on) { b.textContent = on ? '★' : '☆'; }); }); } catch (e) {}
    return true;
  }
  var tries = 0;
  if (!mountTopbarStar()) {
    var iv = setInterval(function () { if (mountTopbarStar() || ++tries > 40) clearInterval(iv); }, 250);
  }

  window.MSBookmarks = { list: list, has: has, toggle: toggle, star: star };
})();
