/* guard.js — the client half of the service guard (2026-07-31).
 *
 * TWO JOBS, both on map pages only:
 *   1. Count this map load. Mapbox bills per map load and gives no API to read the count back,
 *      so we keep our own tally of the same event — see sql/setup/service-guard-v2.sql.
 *   2. Honour a FREEZE. Storage caps stop writes, which does nothing about map loads; the only
 *      way to stop that spend is to stop the map. So when the guard is frozen this refuses to
 *      initialise the map and says so, instead of quietly burning the meter.
 *
 * FAILS OPEN, deliberately. If the guard can't be reached the map loads normally. A monitor that
 * can take the site down when IT breaks is worse than the risk it monitors — and the ceiling it
 * protects is a monthly one, so a few unmeasured loads cost nothing.
 *
 * The freeze screen shows the owner a Thaw button; everyone else gets the plain notice. */
(function () {
  if (!/\/map\//.test(location.pathname)) return;              // map pages only
  if (/[?&]guard=off/.test(location.search)) return;           // escape hatch for debugging

  var SB = null, KEY = null;
  try { SB = window.MS_SUPABASE_URL || null; } catch (e) {}

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

  function freezeScreen(reason, isOwner) {
    if (document.getElementById("ms-frozen")) return;
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
        '<p style="color:#8b84a3;font-size:13px;">' + (reason ? String(reason).replace(/[<>&]/g, "") : "") + '</p>' +
        (isOwner ? '<button id="ms-thaw" style="margin-top:16px;padding:10px 22px;border:none;border-radius:9px;' +
          'background:#7c5cbf;color:#fff;font-weight:700;font-size:14px;cursor:pointer;font-family:inherit;">Thaw — resume maps</button>' +
          '<p style="color:#b3adc4;font-size:12px;margin-top:10px;">You’re seeing this button because you’re signed in as the owner.</p>' : '') +
      '</div>';
    (document.body || document.documentElement).appendChild(d);
    try { window.stop(); } catch (e) {}          // don't let the map keep initialising behind it
    var b = document.getElementById("ms-thaw");
    if (b) b.addEventListener("click", async function () {
      b.disabled = true; b.textContent = "Thawing…";
      await rpcAsUser("ms_service_thaw");
      location.reload();
    });
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

  (async function () {
    for (var i = 0; i < 50 && !(window.MapAuth && MapAuth.db); i++) await new Promise(function (r) { setTimeout(r, 100); });
    if (!(window.MapAuth && MapAuth.db)) return;                // fail open

    var st = await rpc("ms_service_state");
    var row = Array.isArray(st) ? st[0] : st;
    if (row && row.frozen) {
      var owner = false;
      try { var u = await MapAuth.currentUser(); owner = !!(u && String(u.email || "").toLowerCase() === "nittyjee@gmail.com"); } catch (e) {}
      freezeScreen(row.reason, owner);
      return;                                                   // do NOT count a load we refused
    }
    rpc("ms_map_load");                                         // fire and forget
  })();
})();
