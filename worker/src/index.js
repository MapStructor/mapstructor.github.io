/* MapStructor Worker — skeleton (2026-07-25, pre-credentials; reviewable, not deployed).
   The ONE Worker from the architecture doc. Current routes:

     GET  /health                     — liveness probe
     GET  /r2/<key>                   — read an object from R2 with Range support.
                                        For PRIVATE-map tiles and pre-custom-domain testing.
                                        PUBLIC tiles must NOT route through here at scale —
                                        they go straight to the R2 custom domain so the
                                        Worker request quota (100k/day free) is never in
                                        the viewer path. See README decision #1.
     PUT  /upload/<key>               — authenticated upload into R2 (streams the body).
                                        This is the write chokepoint from the decisions doc:
                                        every browser write passes here, so a runaway loop
                                        is rate-limitable in exactly one place.
                                        tiles/<pid>/… keys require OWNERSHIP of <pid> (7/27).
     DELETE /upload/<key>             — authenticated delete (same ownership rule). Exists for
                                        the dual-write invariant: publishes DELETE the R2 copy
                                        before re-uploading, so R2 always holds the CURRENT
                                        archive or nothing (stale-R2 can never shadow Supabase).
     POST /fold                       — The Fold (C3, 7/29): dispatch the retile/fold GitHub
                                        Action for a layer the caller owns. The GitHub token
                                        lives here as the GITHUB_DISPATCH_TOKEN secret — the
                                        browser never sees it. Body: {projectId, layerId,
                                        mode: retile|fold-rows|fold-raw, rawKey?, maxZoom?}.

   Not yet built (TODO markers below): per-key rate limit, private-map read gating,
   AI proxy. */

var ALLOW_ORIGIN = "*";   // tighten to the site origins at custom-domain time

// The one admin account. Non-tiles upload keys (site/, maps/, archives/ — the public web
// surfaces) accept ONLY this user; without the gate any signed-up account could overwrite
// the landing page or a showcase. Not a secret — it's an identity, verified via the token.
var ADMIN_EMAIL = "nittyjee@gmail.com";

function cors(extra) {
  var h = {
    "Access-Control-Allow-Origin": ALLOW_ORIGIN,
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, Range",
    "Access-Control-Expose-Headers": "ETag, Content-Range, Accept-Ranges"
  };
  for (var k in (extra || {})) h[k] = extra[k];
  return h;
}

/* Validate a Supabase user token by asking Supabase who it is. Returns the user
   object or null. (HS256 local verification would need the JWT secret in the
   Worker; calling /auth/v1/user keeps secrets out and is one fast request.) */
async function supabaseUser(env, req) {
  var auth = req.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) return null;
  try {
    var r = await fetch(env.SUPABASE_URL + "/auth/v1/user", {
      headers: { Authorization: auth, apikey: env.SUPABASE_ANON_KEY }
    });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { return null; }
}

var MAX_UPLOAD_BYTES = 95 * 1024 * 1024;   // Worker request-body ceiling is ~100 MB;
// bigger archives use multipart via presigned S3 URLs — a later addition (README #3).

/* ── write-rate guard (launch item 8, 2026-07-30) ──────────────────────────────
   R2 is the one meter in the stack with NO hard spend ceiling — Class A writes are
   $4.50/million — and every browser write funnels through this Worker, so this is the
   one place a runaway loop can be caught. The exposure is a loop, not organic growth:
   a human editing hard makes a handful of writes a minute; a bug makes thousands.

   TWO TIERS, and the order matters. The shared Postgres counter (rateCheckShared) is the
   real one; the isolate Map below is only the fallback for when that RPC isn't installed.
   Do not "simplify" by dropping the shared counter: measured 7/30, 900 rapid writes ALL
   passed the isolate counter, because Cloudflare spread them across isolates and each one
   saw a fraction of the traffic. An isolate counter cannot rate-limit a real client.
   (KV can't either — ~1k writes/day on the free tier; Durable Objects need the paid plan.)

   A trip leaves a JSON breadcrumb in R2 under alerts/ (who, what, how much) — written
   once per window so the alert itself can't become the write storm. */
/* SERVICE GUARD (2026-07-31) — the second half of "the bill can never run away". The rate guard
   below stops a fast loop; this stops slow, legitimate-looking growth past the free tiers. The
   ceiling itself lives in Postgres (sql/setup/service-guard-setup.sql) so the database trigger
   and this Worker enforce the SAME number, and the owner can change it without a deploy.
   Cached for 60s per isolate: a cap that costs a database round-trip on every upload would be a
   tax on the normal path, and a minute of lag cannot meaningfully overshoot a multi-GB ceiling. */
/* THE SECOND CEILING, and why it is deliberately a DIFFERENT number in a DIFFERENT place.
   Everything above trusts one source: a row in Postgres. That is fine against runaway software,
   and useless against anyone who reaches the database — they would simply raise the cap. So this
   ceiling is hard-coded here, in a repo that deploys separately, and the guard takes the LOWER of
   the two. It is set well above any honest month's usage: it is not a budget, it is a backstop
   for the case where the first ceiling has been tampered with or answers nonsense. Changing it
   takes a deploy, on purpose — that is what makes it worth having. */
var HARD_R2_BYTES = 9 * 1024 * 1024 * 1024;        // R2's free tier is 10 GB
var HARD_DB_BYTES = 7 * 1024 * 1024 * 1024;        // the Supabase Pro plan is 8 GB

var _svc = { at: 0, locked: false, reason: null };

async function serviceLocked(env) {
  var now = Date.now();
  if (now - _svc.at < 60000) return _svc;
  try {
    var r = await fetch(env.SUPABASE_URL + "/rest/v1/rpc/ms_service_state", {
      method: "POST",
      headers: { apikey: env.SUPABASE_ANON_KEY, "Content-Type": "application/json" },
      body: "{}"
    });
    if (r.ok) {
      var rows = await r.json();
      var row = Array.isArray(rows) ? rows[0] : rows;
      if (row && typeof row.locked === "boolean") {
        var locked = row.locked, reason = row.reason;
        // the backstop: measured usage past OUR number stops writes even if the database's own
        // cap says otherwise, and even if its `locked` flag has been cleared
        if (Number(row.r2_bytes) >= HARD_R2_BYTES) { locked = true; reason = "file-storage backstop reached"; }
        if (Number(row.db_bytes) >= HARD_DB_BYTES) { locked = true; reason = "database backstop reached"; }
        _svc = { at: now, locked: locked, reason: reason };
      }
      else _svc = { at: now, locked: false, reason: null };
    } else if (r.status === 404) {
      _svc = { at: now + 3600000, locked: false, reason: null };   // SQL not run yet — stop asking for an hour
    }
  } catch (e) { /* never fail a write because the guard couldn't be reached */ }
  return _svc;
}

var WRITE_LIMIT_PER_MIN = 600;
var _rate = new Map();   // userId → { n, windowStart, alerted }
var _rpcMissing = false;   // remembered per isolate: don't re-probe a function that isn't installed

/* The SHARED counter (sql/setup/rate-guard-setup.sql). Measured 7/30: 900 rapid writes all
   passed the isolate counter below, because Cloudflare spread them across isolates and each
   saw only its slice. This one asks Postgres, so every isolate counts into the same bucket.
   Called with the CALLER'S token — the function reads auth.uid() itself, so nobody can count
   on someone else's behalf. Returns null when unavailable, and the caller falls back. */
async function rateCheckShared(env, req, limit) {
  if (_rpcMissing || !env.SUPABASE_URL) return null;
  try {
    var r = await fetch(env.SUPABASE_URL + "/rest/v1/rpc/ms_rate_bump", {
      method: "POST",
      headers: {
        apikey: env.SUPABASE_ANON_KEY,
        Authorization: req.headers.get("Authorization"),
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ p_limit: limit })
    });
    if (r.status === 404) { _rpcMissing = true; return null; }   // SQL not run yet
    if (!r.ok) return null;
    var rows = await r.json();
    var row = Array.isArray(rows) ? rows[0] : rows;
    if (!row || typeof row.n !== "number") return null;
    return { over: !!row.over, count: row.n, first: row.n === limit + 1, window: Math.floor(Date.now() / 60000) };
  } catch (e) { return null; }   // the guard must never take the write path down with it
}

function rateCheck(userId, limit) {
  var now = Date.now(), w = Math.floor(now / 60000);
  var e = _rate.get(userId);
  if (!e || e.window !== w) { e = { window: w, n: 0, alerted: false }; _rate.set(userId, e); }
  e.n++;
  if (_rate.size > 5000) {   // prune stale windows — the map must not grow without bound
    for (var k of _rate.keys()) { var v = _rate.get(k); if (v.window < w - 1) _rate.delete(k); }
  }
  return { over: e.n > limit, count: e.n, first: e.n === limit + 1, window: w };
}

async function noteRateTrip(env, user, hit, req, url) {
  try {
    await env.TILES.put("alerts/write-rate/" + user.id + "-" + hit.window + ".json",
      JSON.stringify({
        at: new Date().toISOString(), user: user.id, email: user.email || null,
        writes_this_minute: hit.count, limit: WRITE_LIMIT_PER_MIN,
        method: req.method, path: url.pathname.slice(0, 200),
        ip: req.headers.get("CF-Connecting-IP") || null
      }),
      { httpMetadata: { contentType: "application/json" } });
  } catch (e) { /* the guard must never fail the request path */ }
  console.warn("write-rate guard tripped: user " + user.id + " at " + hit.count + "/min on " + url.pathname);
}

export default {
  async fetch(req, env) {
    var url = new URL(req.url);

    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors() });

    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ ok: true, at: new Date().toISOString() }),
        { headers: cors({ "Content-Type": "application/json" }) });
    }

    /* ── AHM Drupal encyclopedia pass-through (2026-07-28) ─────────────── */
    // The domain pivot pointed the apex at this Worker, which buried the Drupal
    // still living on the old GoDaddy box at /ames/* (box 23.229.233.102, port 80
    // only — 443 is dead there). Proxy the path through so EVERY stored
    // encyclopediaBase URL keeps working unchanged (AHM1 + AHM2 + any map).
    // cf.resolveOverride escapes the zone loop; it requires the same-zone gray
    // A record  origin.mapstructor.com → 23.229.233.102  (DNS only).
    if (url.pathname.startsWith("/ames/")) {
      if (req.method !== "GET" && req.method !== "HEAD") {
        return new Response("read-only through this proxy", { status: 405, headers: cors() });
      }
      try {
        var enc = await fetch("http://mapstructor.com" + url.pathname + url.search, {
          method: req.method,
          cf: { resolveOverride: "origin.mapstructor.com", cacheTtl: 300, cacheEverything: true }
        });
        var encH = new Headers(enc.headers);
        encH.set("Access-Control-Allow-Origin", "*");     // set (not append) — never doubles Drupal's own ACAO
        encH.delete("Set-Cookie");                        // public content only — never relay origin sessions
        return new Response(enc.body, { status: enc.status, headers: encH });
      } catch (e) {
        return new Response("encyclopedia origin unreachable", { status: 502, headers: cors() });
      }
    }

    /* ── showcase static serving ───────────────────────────────────────── */
    // /maps/* = frozen public showcases stored in R2 under the same prefix
    // (e.g. /maps/railways/). At domain-flip time a route sends
    // mapstructor.com/maps/* here while the rest of the site serves from Pages.
    // REVERT RULE (owner requirement): every showcase deploy ships a dated zip
    // to archives/ — and once the mapstructor-showcases repo exists, git is the
    // source of truth with an auto-sync Action. Never overwrite without one.
    if (req.method === "GET" && url.pathname.startsWith("/maps/")) {
      var mpath = decodeURIComponent(url.pathname.slice(1));   // "maps/railways/..."
      if (mpath.includes("..")) return new Response("bad path", { status: 400, headers: cors() });
      if (mpath.endsWith("/")) mpath += "index.html";
      var last = mpath.split("/").pop();
      if (!last.includes(".")) {
        // extensionless directory hit — redirect to the slash form so relative URLs resolve
        return new Response(null, { status: 301, headers: cors({ "Location": url.pathname + "/" }) });
      }
      var srange = req.headers.get("Range"), sobj;
      if (srange) {
        var sm = srange.match(/bytes=(\d+)-(\d+)?/);
        if (!sm) return new Response("bad range", { status: 416, headers: cors() });
        var soff = parseInt(sm[1], 10);
        sobj = await env.TILES.get(mpath, { range: sm[2] ? { offset: soff, length: parseInt(sm[2], 10) - soff + 1 } : { offset: soff } });
      } else {
        sobj = await env.TILES.get(mpath);
      }
      if (!sobj) return new Response("not found", { status: 404, headers: cors() });
      var sh = cors({ "Accept-Ranges": "bytes", "Cache-Control": "public, max-age=300" });
      if (sobj.httpMetadata && sobj.httpMetadata.contentType) sh["Content-Type"] = sobj.httpMetadata.contentType;
      sh["ETag"] = sobj.httpEtag;
      if (srange && sobj.range) {
        var send = sobj.range.offset + (sobj.range.length != null ? sobj.range.length : sobj.size - sobj.range.offset) - 1;
        sh["Content-Range"] = "bytes " + sobj.range.offset + "-" + send + "/" + sobj.size;
        return new Response(sobj.body, { status: 206, headers: sh });
      }
      return new Response(sobj.body, { headers: sh });
    }

    /* ── reads ─────────────────────────────────────────────────────────── */
    if (req.method === "GET" && url.pathname.startsWith("/r2/")) {
      var key = decodeURIComponent(url.pathname.slice(4));
      if (!key || key.includes("..")) return new Response("bad key", { status: 400, headers: cors() });

      // TODO(private-maps): look up the key's project visibility (cached) and require
      // a valid session for non-public projects. Until then this route mirrors the
      // public bucket — same exposure as today's public Supabase Storage bucket.

      var range = req.headers.get("Range");
      var obj;
      if (range) {
        var m = range.match(/bytes=(\d+)-(\d+)?/);
        if (!m) return new Response("bad range", { status: 416, headers: cors() });
        var offset = parseInt(m[1], 10);
        var opts = { range: m[2] ? { offset: offset, length: parseInt(m[2], 10) - offset + 1 } : { offset: offset } };
        obj = await env.TILES.get(key, opts);
      } else {
        obj = await env.TILES.get(key);
      }
      if (!obj) return new Response("not found", { status: 404, headers: cors() });

      var headers = cors({
        "ETag": obj.httpEtag,
        "Accept-Ranges": "bytes",
        "Cache-Control": "public, max-age=60"
      });
      obj.writeHttpMetadata(new Headers());   // content-type lives in object metadata if set
      if (obj.httpMetadata && obj.httpMetadata.contentType) headers["Content-Type"] = obj.httpMetadata.contentType;
      if (range && obj.range) {
        var end = obj.range.offset + (obj.range.length != null ? obj.range.length : obj.size - obj.range.offset) - 1;
        headers["Content-Range"] = "bytes " + obj.range.offset + "-" + end + "/" + obj.size;
        return new Response(obj.body, { status: 206, headers: headers });
      }
      return new Response(obj.body, { headers: headers });
    }

    /* ── Invitation email: tell someone they were given edit access ──────────
       Before this (8/27), sharing a map by email did NOTHING the invited person could see — the
       address landed in editAccess and they found out only if the owner told them out of band.
       The Worker sends it because the Resend key must never reach a browser; and it sends ONLY
       for a map the caller may edit and ONLY to an address actually ON that map's edit list —
       both checks together are what keep this from being an open relay with our sender on it. */
    if (req.method === "POST" && url.pathname === "/invite-email") {
      var iuser = await supabaseUser(env, req);
      if (!iuser || !iuser.id) return new Response(JSON.stringify({ error: "sign in first" }), { status: 401, headers: cors({ "Content-Type": "application/json" }) });
      if (!env.RESEND_API_KEY) return new Response(JSON.stringify({ error: "email sending is not configured" }), { status: 503, headers: cors({ "Content-Type": "application/json" }) });
      var ibody = await req.json().catch(function () { return {}; });
      var ipid = String(ibody.projectId || "");
      var ito = String(ibody.email || "").toLowerCase().trim();
      if (!/^[0-9a-f-]{36}$/.test(ipid) || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(ito)) {
        return new Response(JSON.stringify({ error: "projectId and a valid email are required" }), { status: 400, headers: cors({ "Content-Type": "application/json" }) });
      }
      var iAuth = { Authorization: req.headers.get("Authorization"), apikey: env.SUPABASE_ANON_KEY, "Content-Type": "application/json" };
      var iok = false;
      try {
        var ier = await fetch(env.SUPABASE_URL + "/rest/v1/rpc/ms_project_editor", { method: "POST", headers: iAuth, body: JSON.stringify({ pid: ipid }) });
        iok = ier.ok && (await ier.json()) === true;
      } catch (e) { iok = false; }
      if (!iok) return new Response(JSON.stringify({ error: "that isn't a map you can edit" }), { status: 403, headers: cors({ "Content-Type": "application/json" }) });
      var ipr = await fetch(env.SUPABASE_URL + "/rest/v1/projects?id=eq." + ipid + "&select=name,raw_config", { headers: iAuth });
      var iprj = (ipr.ok ? await ipr.json() : [])[0];
      var iea = (iprj && iprj.raw_config && iprj.raw_config.editAccess) || {};
      var ionList = (iea.emails || []).some(function (e2) { return String(e2).toLowerCase() === ito; });
      if (!iprj || !ionList) return new Response(JSON.stringify({ error: "that address is not on this map's edit list — add it first" }), { status: 400, headers: cors({ "Content-Type": "application/json" }) });
      var iname = iprj.name || "a map";
      var ilink = "https://mapstructor.com/map/editor.html?id=" + ipid;
      var ires = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: "Bearer " + env.RESEND_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: "MapStructor <noreply@send.mapstructor.com>",
          to: [ito],
          reply_to: iuser.email || undefined,
          subject: (iuser.email || "Someone") + " invited you to edit “" + iname + "”",
          html: "<p>" + (iuser.email || "Someone") + " gave you edit access to the map <b>" + iname.replace(/</g, "&lt;") + "</b> on MapStructor.</p>" +
                "<p><a href=\"" + ilink + "\" style=\"display:inline-block;padding:10px 18px;background:#7c5cbf;color:#fff;border-radius:8px;text-decoration:none;font-weight:700;\">Open the map</a></p>" +
                "<p style=\"color:#6b6680;font-size:13px;\">Sign in with this email address (" + ito + ") — create the account if you don’t have one yet — and the map will be editable.</p>"
        })
      });
      if (!ires.ok) return new Response(JSON.stringify({ error: "the email service refused: " + (await ires.text()).slice(0, 160) }), { status: 502, headers: cors({ "Content-Type": "application/json" }) });
      return new Response(JSON.stringify({ ok: true, sent: ito }), { headers: cors({ "Content-Type": "application/json" }) });
    }

    /* ── Encyclopedia articles: create one, or find one by its address ──────
       WHY THIS IS HERE AND NOT IN THE BROWSER. Linking a place to its article used
       to mean typing a CMS node id into a box. Nobody knows a node id — the site's
       own addresses are names, so there is nowhere to read one. So the map needs to
       ask the CMS to make the article and hand back the id.

       Doing that from the page would put a content-creating key in page source.
       Instead: the browser calls here with its ordinary Supabase login, the Worker
       checks that person may edit that map, and only then does the Worker — which
       holds the CMS key — talk to the CMS. Same shape as /fold and the showcase
       writes, and the same rule the project's plan set for CMS writes long before
       there was a CMS to write to.

       The CMS base URL is not taken from the request. It is read from the LAYER
       the caller named, using the caller's own token, so a valid login cannot be
       pointed at somebody else's CMS. */
    if ((req.method === "POST" && url.pathname === "/article") ||
        (req.method === "GET" && url.pathname === "/article/resolve")) {
      var auser = await supabaseUser(env, req);
      if (!auser || !auser.id) return new Response(JSON.stringify({ error: "sign in first" }), { status: 401, headers: cors({ "Content-Type": "application/json" }) });

      var q = url.searchParams;
      var body = req.method === "POST" ? await req.json().catch(function () { return {}; }) : {};
      var pid = String(body.projectId || q.get("projectId") || "");
      var lid = String(body.layerId || q.get("layerId") || "");
      if (!/^[0-9a-f-]{36}$/.test(pid) || !/^[0-9a-f-]{36}$/.test(lid)) {
        return new Response(JSON.stringify({ error: "projectId and layerId are required" }), { status: 400, headers: cors({ "Content-Type": "application/json" }) });
      }

      // May this person edit this map? Ask the database's own predicate rather than
      // re-implementing it here — owner OR invited editor, one source of truth.
      var okEdit = false;
      try {
        var er = await fetch(env.SUPABASE_URL + "/rest/v1/rpc/ms_project_editor", {
          method: "POST",
          headers: { Authorization: req.headers.get("Authorization"), apikey: env.SUPABASE_ANON_KEY, "Content-Type": "application/json" },
          body: JSON.stringify({ pid: pid })
        });
        okEdit = er.ok && (await er.json()) === true;
      } catch (e) { okEdit = false; }
      if (!okEdit) return new Response(JSON.stringify({ error: "that isn't a map you can edit" }), { status: 403, headers: cors({ "Content-Type": "application/json" }) });

      // The CMS this layer is connected to, read with the caller's token.
      var cmsBase = "";
      try {
        var lr = await fetch(env.SUPABASE_URL + "/rest/v1/layers?id=eq." + lid + "&select=content_base_url", {
          headers: { Authorization: req.headers.get("Authorization"), apikey: env.SUPABASE_ANON_KEY }
        });
        var lrows = lr.ok ? await lr.json() : [];
        cmsBase = (lrows[0] && lrows[0].content_base_url) || "";
      } catch (e) { cmsBase = ""; }
      if (!cmsBase) return new Response(JSON.stringify({ error: "this layer isn't connected to an encyclopedia yet" }), { status: 400, headers: cors({ "Content-Type": "application/json" }) });

      var host = "";
      try { host = new URL(cmsBase).host; } catch (e) { host = ""; }
      var keys = {};
      try { keys = JSON.parse(env.CMS_KEYS || "{}"); } catch (e) { keys = {}; }
      var cmsKey = keys[host];
      /* A CMS we hold no key for is refused rather than called without one. Calling it
         anyway would leak the map's titles to whatever host a layer happens to name. */
      if (!cmsKey) return new Response(JSON.stringify({ error: "no writing key is configured for " + (host || "that encyclopedia") }), { status: 503, headers: cors({ "Content-Type": "application/json" }) });

      var base = cmsBase.replace(/\/+$/, "");
      try {
        var upstream;
        if (req.method === "POST") {
          upstream = await fetch(base + "/ms/article", {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-MS-Key": cmsKey },
            body: JSON.stringify({ title: String(body.title || ""), text: String(body.text || "") })
          });
        } else {
          upstream = await fetch(base + "/ms/resolve?url=" + encodeURIComponent(q.get("url") || ""), {
            headers: { "X-MS-Key": cmsKey }
          });
        }
        var text = await upstream.text();
        return new Response(text, { status: upstream.status, headers: cors({ "Content-Type": "application/json" }) });
      } catch (e) {
        return new Response(JSON.stringify({ error: "the encyclopedia did not answer" }), { status: 502, headers: cors({ "Content-Type": "application/json" }) });
      }
    }

    /* ── The Fold: dispatch the retile/fold Action (C3, 7/29) ──────────── */
    // The import client can't hold a GitHub token; this is the one place that can.
    // Ownership is checked exactly like /upload (caller's own token → projects.user_id),
    // then the workflow_dispatch fires with the Worker-held PAT. 503 until the
    // GITHUB_DISPATCH_TOKEN secret is set (clients fall back to a normal row import).
    if (req.method === "POST" && url.pathname === "/fold") {
      var fuser = await supabaseUser(env, req);
      if (!fuser || !fuser.id) return new Response("auth required", { status: 401, headers: cors() });
      var fsvc = await serviceLocked(env);
      if (fsvc.locked) return new Response("service paused: " + (fsvc.reason || ""), { status: 503, headers: cors() });
      // a fold dispatch costs a whole GitHub runner — hold it to the same ceiling
      var fhit = await rateCheckShared(env, req, WRITE_LIMIT_PER_MIN) || rateCheck(fuser.id, WRITE_LIMIT_PER_MIN);
      if (fhit.over) {
        if (fhit.first) await noteRateTrip(env, fuser, fhit, req, url);
        return new Response("write rate limit", { status: 429, headers: cors({ "Retry-After": "60" }) });
      }
      var fb = null;
      try { fb = await req.json(); } catch (e) { return new Response("bad json", { status: 400, headers: cors() }); }
      var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      var fMode = fb && fb.mode ? String(fb.mode) : "fold-raw";
      if (!fb || !UUID.test(fb.projectId || "") || !UUID.test(fb.layerId || "") ||
          ["retile", "fold-rows", "fold-raw", "fold-merge"].indexOf(fMode) < 0) {
        return new Response("bad request", { status: 400, headers: cors() });
      }
      var fRawKey = fb.rawKey ? String(fb.rawKey) : "";
      // fold-raw sources must live under the caller's own project prefix (no path games)
      if (fMode === "fold-raw" && fRawKey.indexOf("tiles/" + fb.projectId + "/") !== 0) {
        return new Response("rawKey must be under tiles/<projectId>/", { status: 400, headers: cors() });
      }
      try {
        var fpr = await fetch(env.SUPABASE_URL + "/rest/v1/projects?id=eq." + fb.projectId + "&select=user_id", {
          headers: { Authorization: req.headers.get("Authorization"), apikey: env.SUPABASE_ANON_KEY }
        });
        var frows = fpr.ok ? await fpr.json() : [];
        if (!frows.length || frows[0].user_id !== fuser.id) {
          return new Response("not your project", { status: 403, headers: cors() });
        }
      } catch (e) { return new Response("ownership check failed", { status: 503, headers: cors() }); }
      if (!env.GITHUB_DISPATCH_TOKEN) return new Response("fold dispatch not configured", { status: 503, headers: cors() });
      var gh = await fetch("https://api.github.com/repos/MapStructor/mapstructor.github.io/actions/workflows/retile-tippecanoe.yml/dispatches", {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + env.GITHUB_DISPATCH_TOKEN,
          "Accept": "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "mapstructor-worker",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          ref: "master",
          inputs: { project_id: fb.projectId, layer_id: fb.layerId, mode: fMode, raw_key: fRawKey, max_zoom: fb.maxZoom ? String(fb.maxZoom) : "" }
        })
      });
      if (gh.status === 204) {
        return new Response(JSON.stringify({ ok: true, dispatched: fMode }), { status: 202, headers: cors({ "Content-Type": "application/json" }) });
      }
      return new Response("dispatch failed: " + gh.status + " " + (await gh.text()).slice(0, 200), { status: 502, headers: cors() });
    }

    /* ── writes (the chokepoint) ───────────────────────────────────────── */
    if ((req.method === "PUT" || req.method === "DELETE") && url.pathname.startsWith("/upload/")) {
      var ukey = decodeURIComponent(url.pathname.slice(8));
      if (!ukey || ukey.includes("..")) return new Response("bad key", { status: 400, headers: cors() });

      var user = await supabaseUser(env, req);
      if (!user || !user.id) return new Response("auth required", { status: 401, headers: cors() });

      // service guard — the ceiling on the whole platform, not this one user
      if (req.method === "PUT") {
        var svc = await serviceLocked(env);
        if (svc.locked) {
          return new Response("MapStructor isn't accepting new data right now (" + (svc.reason || "paused") +
            "). Existing maps are unaffected — they can still be viewed, edited and downloaded.",
            { status: 503, headers: cors({ "Retry-After": "3600" }) });
        }
      }

      // write-rate guard — shared counter when it's installed, isolate counter otherwise
      var hit = await rateCheckShared(env, req, WRITE_LIMIT_PER_MIN) || rateCheck(user.id, WRITE_LIMIT_PER_MIN);
      if (hit.over) {
        if (hit.first) await noteRateTrip(env, user, hit, req, url);
        return new Response("write rate limit — " + hit.count + " writes this minute (limit " +
          WRITE_LIMIT_PER_MIN + "). If this wasn't you, something is looping.",
          { status: 429, headers: cors({ "Retry-After": "60" }) });
      }

      // OWNERSHIP (7/27): tiles/<projectId>/<file> and snapshots/<projectId>.json — the
      // caller must own <projectId>. Checked with the CALLER'S OWN token (RLS lets anyone
      // SELECT public projects, so visibility isn't enough — compare user_id).
      var tm = ukey.match(/^tiles\/([0-9a-f-]{36})\//) || ukey.match(/^snapshots\/([0-9a-f-]{36})\.json$/);
      /* SHOWCASE WRITES (8/26). maps/<slug>/… was admin-only, which meant only the platform owner
         could refresh a client's public map. A client updating their OWN public map is the entire
         point of the feature, so the rule becomes: you may write maps/<slug>/ when you own the
         project BOUND to that slug.

         The binding is projects.raw_config.showcaseSlug, resolved here with the CALLER'S OWN token.
         A client cannot claim someone else's slug by asking, because writing showcaseSlug onto a
         project is itself an owner-only update under RLS. Three guards, each for a specific way
         this could go wrong:
           · the slug charset is pinned to [a-z0-9_-], so `..` can never form a path escape;
           · a slug resolving to ZERO rows is REFUSED, not treated as unowned-and-therefore-free —
             the empty-result-reads-as-permission trap that made the features view public;
           · admin still passes through the old branch, so first publishes from the CLI are
             unaffected. */
      var sm2 = ukey.match(/^maps\/([a-z0-9_-]+)\//i);
      if (sm2 && (user.email || "").toLowerCase() !== ADMIN_EMAIL) {
        /* AN INVITED EDITOR MAY PUBLISH (8/27). This compared user_id and refused everyone else, so
           the one person a map had been shared with — the client, on their own map — got
           "that showcase slug is not bound to a map you own" when they pressed Publish. In front of
           the room. An editor who may change the map is exactly the person who should be able to
           put it live; anything else means every update routes through the owner forever.
           The rule is the DATABASE'S OWN predicate, the same one /article already asks, so "who may
           edit this map" has one definition and cannot drift between two routes. Both guards stay:
           a slug resolving to ZERO rows is still REFUSED rather than treated as unclaimed, and the
           slug charset still forbids `..`. */
        try {
          var sq = await fetch(env.SUPABASE_URL +
            "/rest/v1/projects?select=id&raw_config->>showcaseSlug=eq." + encodeURIComponent(sm2[1]), {
            headers: { Authorization: req.headers.get("Authorization"), apikey: env.SUPABASE_ANON_KEY }
          });
          var srows = sq.ok ? await sq.json() : [];
          if (!srows.length) {
            return new Response("that showcase slug is not bound to any map you can see", { status: 403, headers: cors() });
          }
          var mayPublish = false;
          for (var si = 0; si < srows.length && !mayPublish; si++) {
            var pr2 = await fetch(env.SUPABASE_URL + "/rest/v1/rpc/ms_project_editor", {
              method: "POST",
              headers: { Authorization: req.headers.get("Authorization"), apikey: env.SUPABASE_ANON_KEY, "Content-Type": "application/json" },
              body: JSON.stringify({ pid: srows[si].id })
            });
            mayPublish = pr2.ok && (await pr2.json()) === true;
          }
          if (!mayPublish) {
            return new Response("that showcase belongs to a map you cannot edit", { status: 403, headers: cors() });
          }
        } catch (e) { return new Response("ownership check failed", { status: 503, headers: cors() }); }
      } else if (tm) {
        try {
          var pr = await fetch(env.SUPABASE_URL + "/rest/v1/projects?id=eq." + tm[1] + "&select=user_id", {
            headers: { Authorization: req.headers.get("Authorization"), apikey: env.SUPABASE_ANON_KEY }
          });
          var rows = pr.ok ? await pr.json() : [];
          if (!rows.length || rows[0].user_id !== user.id) {
            return new Response("not your project", { status: 403, headers: cors() });
          }
        } catch (e) { return new Response("ownership check failed", { status: 503, headers: cors() }); }
      } else if ((user.email || "").toLowerCase() !== ADMIN_EMAIL) {
        // site/, archives/, anything else = the public web surfaces — admin only
        return new Response("admin only", { status: 403, headers: cors() });
      }
      // TODO(rate-limit): per-user upload counter (Workers KV or Durable Object),
      // far above human speed — the R2 write-meter guard from the decisions doc.

      if (req.method === "DELETE") {
        await env.TILES.delete(ukey);
        return new Response(JSON.stringify({ ok: true, deleted: ukey }),
          { headers: cors({ "Content-Type": "application/json" }) });
      }

      var len = parseInt(req.headers.get("Content-Length") || "0", 10);
      if (len > MAX_UPLOAD_BYTES) return new Response("too large — multipart path not built yet", { status: 413, headers: cors() });

      await env.TILES.put(ukey, req.body, {
        httpMetadata: { contentType: req.headers.get("Content-Type") || "application/octet-stream" },
        customMetadata: { uploadedBy: user.id, at: new Date().toISOString() }
      });
      return new Response(JSON.stringify({ ok: true, key: ukey }),
        { headers: cors({ "Content-Type": "application/json" }) });
    }

    /* ── apex coming-soon (interim, until the GitHub Pages swap) ───────── */
    // Routes mapstructor.com/* and www.mapstructor.com/* land here for any path
    // not handled above. Serve the coming-soon page from R2 site/index.html.
    // The old makeamap WordPress page is archived (CLAUDE_OUTPUTS zip) and its
    // origin DNS is untouched — deleting the zone routes restores it instantly.
    var host = url.hostname;
    if (req.method === "GET" && (host === "mapstructor.com" || host === "www.mapstructor.com")) {
      var spath = decodeURIComponent(url.pathname);
      if (spath.includes("..")) return new Response("bad path", { status: 400, headers: cors() });
      var skey = "site" + (spath === "/" ? "/index.html" : spath);
      var cs = await env.TILES.get(skey);
      if (!cs && !skey.split("/").pop().includes(".")) cs = await env.TILES.get("site/index.html");   // unknown routes → landing page
      if (cs) {
        var csh = cors({ "Cache-Control": "public, max-age=300" });
        if (cs.httpMetadata && cs.httpMetadata.contentType) csh["Content-Type"] = cs.httpMetadata.contentType;
        return new Response(cs.body, { headers: csh });
      }
    }

    return new Response("not found", { status: 404, headers: cors() });
  }
};
