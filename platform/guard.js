/* guard.js — the client half of the service guard (2026-07-31, rev b).
 *
 * TWO JOBS, both on map pages only:
 *   1. Count this map load. Mapbox bills per map load and gives no API to read the count back,
 *      so we keep our own tally of the same event — see sql/setup/service-guard-v2.sql.
 *   2. Honour a FREEZE. Storage caps stop writes, which does nothing about map loads; the only
 *      way to stop that spend is to stop the map.
 *
 * REV B — WHY THE FIRST VERSION DIDN'T ACTUALLY WORK. It painted a "paused" screen over the page
 * and called window.stop(). Measured on the live site: the map still initialised behind it and
 * still fired 5 POSTs to events.mapbox.com — the billable event. A freeze that shows a notice
 * while the meter keeps running is worse than none, because it looks safe.
 *
 * So the freeze is now enforced where the money is: mapboxgl.Map / maplibregl.Map are wrapped, and
 * while frozen NO MAP IS CONSTRUCTED. No map, no map load, nothing to bill. Note what this
 * deliberately does NOT do: it never blocks or fakes the telemetry request itself. Suppressing
 * Mapbox's meter for a map we DO show would be dodging the bill; refusing to show the map is the
 * honest version of the same stop.
 *
 * TIMING. The verdict is an RPC (~200-600ms) and the engine builds its map around ~1.2s, so the
 * answer normally lands first. To close the gap on a slow connection a freeze is remembered in
 * localStorage for 5 minutes, which blocks instantly on any later load. If that memory turns out
 * to be stale (the owner thawed), the live answer corrects it with one reload.
 *
 * FAILS OPEN, deliberately. If the guard can't be reached the map loads normally. A monitor that
 * can take the site down when IT breaks is worse than the risk it monitors — and the ceiling it
 * protects is a monthly one, so a few unmeasured loads cost nothing.
 *
 * The freeze screen shows the owner a Thaw button; everyone else gets the plain notice. */
(function () {
  if (!/\/map\//.test(location.pathname)) return;              // map pages only
  if (/[?&]guard=off/.test(location.search)) return;           // escape hatch for debugging

  var CACHE = "ms_guard_frozen";
  var CACHE_TTL = 5 * 60 * 1000;
  var RELOADED = "ms_guard_corrected";

  var frozen = false;          // best current answer; the gate reads this synchronously
  var known = false;           // has the live answer landed?
  var fromCache = false;
  var built = [];              // maps we let through, so a late verdict can still take them down

  // ── remembered freeze: blocks before a single byte of map data moves ──────
  try {
    var c = JSON.parse(localStorage.getItem(CACHE) || "null");
    if (c && c.at && (Date.now() - c.at) < CACHE_TTL) { frozen = true; fromCache = true; }
  } catch (e) {}

  // ── the gate ─────────────────────────────────────────────────────────────
  function gate(lib) {
    if (!lib || typeof lib.Map !== "function" || lib.Map.__msGated) return;
    var Real = lib.Map;
    function Gated() {
      if (frozen) { showFreeze(null); throw new Error("ms_guard_frozen — maps are paused"); }
      var m = Reflect.construct(Real, arguments, Gated);
      built.push(m);
      return m;
    }
    Gated.prototype = Real.prototype;
    Gated.__msGated = true;
    try { Object.keys(Real).forEach(function (k) { Gated[k] = Real[k]; }); } catch (e) {}
    try { lib.Map = Gated; } catch (e) {}
  }
  gate(window.mapboxgl);
  gate(window.maplibregl);

  // a library that loads after us (MapLibre pages) gets gated the moment it defines itself
  ["mapboxgl", "maplibregl"].forEach(function (name) {
    if (window[name]) return;
    try {
      Object.defineProperty(window, name, {
        configurable: true,
        get: function () { return this["__ms_" + name]; },
        set: function (v) {
          this["__ms_" + name] = v;
          gate(v);
          Object.defineProperty(window, name, { value: v, writable: true, configurable: true });
        }
      });
    } catch (e) {}
  });

  function creds() {
    // reuse whatever auth.js already resolved rather than duplicating the URL/key anywhere
    try {
      if (window.MapAuth && MapAuth.db) {
        var u = MapAuth.db.supabaseUrl || (MapAuth.db.rest && MapAuth.db.rest.url);
        var k = MapAuth.db.supabaseKey || (MapAuth.db.rest && MapAuth.db.rest.headers && MapAuth.db.rest.headers.apikey);
        if (u && k) return { url: String(u).replace(/\/rest\/v1\/?$/, ""), key: k };
      }
    } catch (e) {}
    return null;
  }

  async function rpc(name, body) {
    var c = creds(); if (!c) return null;
    try {
      var r = await fetch(c.url + "/rest/v1/rpc/" + name, {
        method: "POST",
        headers: { apikey: c.key, Authorization: "Bearer " + c.key, "Content-Type": "application/json" },
        body: JSON.stringify(body || {})
      });
      if (!r.ok) return null;
      var t = await r.text();
      return t ? JSON.parse(t) : true;
    } catch (e) { return null; }
  }

  // owner actions need the USER's token, not the anon key
  async function rpcAsUser(name, body) {
    try {
      var s = await MapAuth.db.auth.getSession();
      var tok = s && s.data && s.data.session && s.data.session.access_token;
      var c = creds(); if (!tok || !c) return null;
      var r = await fetch(c.url + "/rest/v1/rpc/" + name, {
        method: "POST",
        headers: { apikey: c.key, Authorization: "Bearer " + tok, "Content-Type": "application/json" },
        body: JSON.stringify(body || {})
      });
      return r.ok;
    } catch (e) { return null; }
  }

  function showFreeze(reason, isOwner) {
    if (document.getElementById("ms-frozen")) {
      if (isOwner) addThaw();
      return;
    }
    var d = document.createElement("div");
    d.id = "ms-frozen";
    d.style.cssText = "position:fixed;inset:0;z-index:2147483647;background:#f7f5fb;display:flex;" +
      "align-items:center;justify-content:center;padding:28px;font-family:'Segoe UI',system-ui,Arial,sans-serif;";
    d.innerHTML =
      '<div style="max-width:460px;text-align:center;">' +
        '<div style="font-size:40px;">⏸</div>' +
        '<h2 style="margin:12px 0 8px;color:#2a2438;font-size:22px;">Maps are paused</h2>' +
        '<p style="color:#5b5470;font-size:15px;line-height:1.6;margin:0 0 6px;">' +
          'MapStructor has reached a limit its owner set, so maps aren’t loading right now. ' +
          'Nothing is lost — every map and everything in it is safe.</p>' +
        '<p id="ms-frozen-why" style="color:#8b84a3;font-size:13px;">' +
          (reason ? String(reason).replace(/[<>&]/g, "") : "") + '</p>' +
        '<div id="ms-frozen-owner"></div>' +
      '</div>';
    (document.body || document.documentElement).appendChild(d);
    if (isOwner) addThaw();
  }

  function addThaw() {
    var host = document.getElementById("ms-frozen-owner");
    if (!host || document.getElementById("ms-thaw")) return;
    host.innerHTML =
      '<button id="ms-thaw" style="margin-top:16px;padding:10px 22px;border:none;border-radius:9px;' +
      'background:#7c5cbf;color:#fff;font-weight:700;font-size:14px;cursor:pointer;font-family:inherit;">Thaw — resume maps</button>' +
      '<p style="color:#b3adc4;font-size:12px;margin-top:10px;">You’re seeing this button because you’re signed in as the owner.</p>';
    document.getElementById("ms-thaw").addEventListener("click", async function (ev) {
      var b = ev.currentTarget;
      b.disabled = true; b.textContent = "Thawing…";
      await rpcAsUser("ms_service_thaw");
      try { localStorage.removeItem(CACHE); } catch (e) {}
      location.reload();
    });
  }

  function setReason(txt) {
    var el = document.getElementById("ms-frozen-why");
    if (el && txt) el.textContent = String(txt);
  }

  (async function () {
    // the freeze we remembered takes effect NOW; the screen goes up before anything renders
    if (frozen) showFreeze(null);

    for (var i = 0; i < 50 && !(window.MapAuth && MapAuth.db); i++) await new Promise(function (r) { setTimeout(r, 100); });
    if (!(window.MapAuth && MapAuth.db)) return;                // fail open

    var st = await rpc("ms_service_state");
    var row = Array.isArray(st) ? st[0] : st;
    if (!row) return;                                           // fail open
    known = true;

    if (row.frozen) {
      frozen = true;
      try { localStorage.setItem(CACHE, JSON.stringify({ at: Date.now() })); } catch (e) {}
      var owner = false;
      try { var u = await MapAuth.currentUser(); owner = !!(window.msIsAdminEmail && window.msIsAdminEmail(u && u.email)); } catch (e) {}   // A30: one list, in auth.js
      showFreeze(row.reason, owner);
      setReason(row.reason);
      // a verdict that arrived after the map was built still has to stop the meter running on
      built.splice(0).forEach(function (m) { try { m.remove(); } catch (e) {} });
      try { window.stop(); } catch (e) {}
      return;                                                   // do NOT count a load we refused
    }

    // not frozen. If we blocked on a stale memory, correct it — once.
    frozen = false;
    try { localStorage.removeItem(CACHE); } catch (e) {}
    if (fromCache) {
      var already = false;
      try { already = sessionStorage.getItem(RELOADED) === "1"; } catch (e) {}
      if (!already) {
        try { sessionStorage.setItem(RELOADED, "1"); } catch (e) {}
        location.reload();
        return;
      }
    }
    try { sessionStorage.removeItem(RELOADED); } catch (e) {}
    rpc("ms_map_load");                                         // fire and forget
  })();
})();
