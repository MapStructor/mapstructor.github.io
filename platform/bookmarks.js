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
  // datasets bookmark exactly like maps (owner 8/11) — same module, second backend triple:
  // table dataset_bookmarks · column dataset_id · localStorage msDsBookmarks
  var KINDS = {
    map:     { table: 'map_bookmarks',     col: 'project_id', ls: LS_KEY },
    dataset: { table: 'dataset_bookmarks', col: 'dataset_id', ls: 'msDsBookmarks' }
  };

  // reuse auth.js's client (always loaded first on every page that includes us) — one client,
  // one session. Fallback builds our own only if a page ever includes us without auth.js.
  var db = (window.MapAuth && MapAuth.db)
    || ((window.supabase && window.supabase.createClient) ? window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY) : null);

  function localList(kind) {
    try { var a = JSON.parse(localStorage.getItem(KINDS[kind].ls) || '[]'); return Array.isArray(a) ? a : []; }
    catch (e) { return []; }
  }
  function localSave(kind, a) { try { localStorage.setItem(KINDS[kind].ls, JSON.stringify(a)); } catch (e) {} }

  // real user = DB backend; anonymous or logged-out = localStorage
  function realUser() {
    if (!window.MapAuth || !db) return Promise.resolve(null);
    return Promise.resolve(MapAuth.currentUser()).then(function (u) {
      return (MapAuth.isReal && MapAuth.isReal(u)) ? u : null;
    }).catch(function () { return null; });
  }

  // one-time carry-in: local bookmarks become account rows on real login (ignore dup conflicts)
  var carried = {};
  function carryIn(kind, u) {
    if (carried[kind]) return Promise.resolve();
    var K = KINDS[kind], ids = localList(kind);
    if (!ids.length) { carried[kind] = true; return Promise.resolve(); }
    carried[kind] = true;
    var onC = 'user_id,' + K.col;
    var rows = ids.map(function (id) { var o = { user_id: u.id }; o[K.col] = id; return o; });
    return db.from(K.table).upsert(rows, { onConflict: onC, ignoreDuplicates: true })
      .then(function (r) {
        // rows referencing DELETED targets violate the FK — fall back to one-by-one, drop the dead
        if (r.error) return Promise.all(rows.map(function (row) { return db.from(K.table).upsert(row, { onConflict: onC, ignoreDuplicates: true }); }));
      })
      .then(function () { localSave(kind, []); })
      .catch(function () {});
  }

  /* One fetch per kind per page, not one per QUESTION. `hasKind` is a membership test and it was
     implemented as `listKind` — a full table read — so every widget asking "is this one
     bookmarked?" pulled the whole list again. Measured 8/22 in a single editor boot: FOUR reads of
     map_bookmarks, all identical.
     Caching the PROMISE rather than the result also collapses concurrent askers, which is what
     boot actually does — several widgets asking at once, before any answer has arrived.
     Correctness rests on `toggleKind` being the only thing in this module that changes a
     bookmark; it invalidates, so the cache cannot outlive the truth. Another TAB can still make it
     stale, exactly as the uncached version could between its own read and use. */
  var _listCache = {};
  function invalidateKind(kind) { delete _listCache[kind]; }
  function listKind(kind, opts) {
    if (!(opts && opts.fresh) && _listCache[kind]) return _listCache[kind];
    var p = listKindUncached(kind);
    _listCache[kind] = p;
    /* A failed fetch must not be remembered as the answer — drop it so the next ask retries. */
    p.catch(function () { if (_listCache[kind] === p) delete _listCache[kind]; });
    return p;
  }
  function listKindUncached(kind) {
    var K = KINDS[kind];
    return realUser().then(function (u) {
      if (!u) return localList(kind);
      return carryIn(kind, u).then(function () {
        return db.from(K.table).select(K.col).order('created_at', { ascending: false });
      }).then(function (r) {
        return (r && !r.error && r.data) ? r.data.map(function (x) { return x[K.col]; }) : [];
      });
    });
  }
  function hasKind(kind, id) { return listKind(kind).then(function (ids) { return ids.indexOf(id) > -1; }); }
  function toggleKind(kind, id) {
    var K = KINDS[kind];
    invalidateKind(kind);   // whatever happens below, the cached list is about to be wrong
    return realUser().then(function (u) {
      if (!u) {
        var a = localList(kind), i = a.indexOf(id);
        if (i > -1) a.splice(i, 1); else a.unshift(id);
        localSave(kind, a);
        return i === -1;
      }
      return hasKind(kind, id).then(function (on) {
        /* invalidate AGAIN after the write: hasKind above repopulated the cache with the state
           from BEFORE this toggle, so leaving it would hand the next reader the old answer —
           a cache that is only cleared before the read it triggers is not cleared at all. */
        var after = function (v) { invalidateKind(kind); return v; };
        if (on) return db.from(K.table).delete().eq('user_id', u.id).eq(K.col, id).then(function () { return after(false); });
        var row = { user_id: u.id }; row[K.col] = id;
        return db.from(K.table).insert(row).then(function (r) { return after(!r.error); });
      });
    });
  }
  // the original map-only names stay as-is — every existing caller keeps working
  function list() { return listKind('map'); }
  function has(id) { return hasKind('map', id); }
  function toggle(id) { return toggleKind('map', id); }

  // ── the ★ itself: paint one element as a live bookmark toggle ─────────────
  function starKind(kind, el, id) {
    var word = kind === 'dataset' ? 'dataset' : 'map';
    function paint(on) {
      el.textContent = on ? '★' : '☆';
      el.title = on ? 'Bookmarked — click to remove' : 'Bookmark this ' + word;
      el.style.color = on ? '#b0691d' : '#888';
    }
    el.style.cursor = 'pointer';
    el.setAttribute('aria-label', 'Bookmark this ' + word);
    paint(false);
    hasKind(kind, id).then(paint);
    el.addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      toggleKind(kind, id).then(function (on) {
        paint(on);
        // let any list of bookmarks on the page redraw itself immediately (dashboard's
        // Bookmarks strip) — starring your own map should show up without a refresh (8/6)
        try { window.dispatchEvent(new CustomEvent('ms-bookmarks-changed', { detail: { kind: kind, projectId: id, on: on } })); } catch (e2) {}
      });
    });
    return el;
  }
  function star(el, projectId) { return starKind('map', el, projectId); }

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
    var iv = setInterval(function () {
      if (mountTopbarStar()) { clearInterval(iv); return; }
      if (++tries > 40) {
        clearInterval(iv);
        // 10 seconds of trying, then the star simply is not there and nothing says why.
        if (window.MSGuard) MSGuard.cliff("bookmark-star-giveup", tries, 40,
          "the ★ bookmark button never mounted — the top bar was not ready in 10s, so the button is missing");
      }
    }, 250);
  }

  window.MSBookmarks = {
    list: list, has: has, toggle: toggle, star: star,
    listDatasets: function () { return listKind('dataset'); },
    hasDataset: function (id) { return hasKind('dataset', id); },
    toggleDataset: function (id) { return toggleKind('dataset', id); },
    starDataset: function (el, id) { return starKind('dataset', el, id); }
  };
})();
