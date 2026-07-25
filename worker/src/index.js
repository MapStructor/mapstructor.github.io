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

   Not yet built (TODO markers below): ownership check on uploads, per-key rate limit,
   private-map read gating, AI proxy, tile-job dispatch. */

var ALLOW_ORIGIN = "*";   // tighten to the site origins at custom-domain time

function cors(extra) {
  var h = {
    "Access-Control-Allow-Origin": ALLOW_ORIGIN,
    "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
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
    if (req.method === "PUT" && url.pathname.startsWith("/upload/")) {
      var ukey = decodeURIComponent(url.pathname.slice(8));
      if (!ukey || ukey.includes("..")) return new Response("bad key", { status: 400, headers: cors() });

      var user = await supabaseUser(env, req);
      if (!user || !user.id) return new Response("auth required", { status: 401, headers: cors() });

      // TODO(ownership): keys are <projectId>/<layerId>.<ext> — verify user owns
      // <projectId> via a PostgREST lookup before accepting. Skeleton accepts any
      // authenticated user; do NOT deploy beyond testing without this check.
      // TODO(rate-limit): per-user upload counter (Workers KV or Durable Object),
      // far above human speed — the R2 write-meter guard from the decisions doc.

      var len = parseInt(req.headers.get("Content-Length") || "0", 10);
      if (len > MAX_UPLOAD_BYTES) return new Response("too large — multipart path not built yet", { status: 413, headers: cors() });

      await env.TILES.put(ukey, req.body, {
        httpMetadata: { contentType: req.headers.get("Content-Type") || "application/octet-stream" },
        customMetadata: { uploadedBy: user.id, at: new Date().toISOString() }
      });
      return new Response(JSON.stringify({ ok: true, key: ukey }),
        { headers: cors({ "Content-Type": "application/json" }) });
    }

    return new Response("not found", { status: 404, headers: cors() });
  }
};
