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

   Not yet built (TODO markers below): per-key rate limit, private-map read gating,
   AI proxy, tile-job dispatch. */

var ALLOW_ORIGIN = "*";   // tighten to the site origins at custom-domain time

// The one admin account. Non-tiles upload keys (site/, maps/, archives/ — the public web
// surfaces) accept ONLY this user; without the gate any signed-up account could overwrite
// the landing page or a showcase. Not a secret — it's an identity, verified via the token.
var ADMIN_EMAIL = "nittyjee@gmail.com";

function cors(extra) {
  var h = {
    "Access-Control-Allow-Origin": ALLOW_ORIGIN,
    "Access-Control-Allow-Methods": "GET, PUT, DELETE, OPTIONS",
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

export default {
  async fetch(req, env) {
    var url = new URL(req.url);

    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors() });

    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ ok: true, at: new Date().toISOString() }),
        { headers: cors({ "Content-Type": "application/json" }) });
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

    /* ── writes (the chokepoint) ───────────────────────────────────────── */
    if ((req.method === "PUT" || req.method === "DELETE") && url.pathname.startsWith("/upload/")) {
      var ukey = decodeURIComponent(url.pathname.slice(8));
      if (!ukey || ukey.includes("..")) return new Response("bad key", { status: 400, headers: cors() });

      var user = await supabaseUser(env, req);
      if (!user || !user.id) return new Response("auth required", { status: 401, headers: cors() });

      // OWNERSHIP (7/27): tiles/<projectId>/<file> and snapshots/<projectId>.json — the
      // caller must own <projectId>. Checked with the CALLER'S OWN token (RLS lets anyone
      // SELECT public projects, so visibility isn't enough — compare user_id).
      var tm = ukey.match(/^tiles\/([0-9a-f-]{36})\//) || ukey.match(/^snapshots\/([0-9a-f-]{36})\.json$/);
      if (tm) {
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
        // site/, maps/, archives/, anything else = the public web surfaces — admin only
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
