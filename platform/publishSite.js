/* publishSite.js — "Update the public site": push this map's standalone copy to /maps/<slug>/.
 *
 * WHAT THIS IS. A map can have a permanent public address — mapstructor.com/maps/<slug>/ — that is
 * NOT the platform. It is the exact folder the "⬇ Download whole project" button produces, sitting
 * on Cloudflare's CDN. It reads no database, runs no editor code, needs no login, and carries no
 * token. That is the whole point: **the public copy cannot be broken by anything we do to the
 * platform.** A client's visitors keep seeing their map through a deploy, an outage, or a bad
 * afternoon in the editor.
 *
 * ONE BUILDER, NOT TWO. The copy is built by `MSDownload.buildZip({ returnZip: true })` — the same
 * function behind the download button, stopped one step earlier. A second builder would drift from
 * the first, and the drift would only ever show up on somebody's live site.
 *
 * WHY DELTA UPLOADS. A full copy is ~107 files and ~80 MB, mostly vendored fonts and engine code
 * that are byte-identical on every publish. Re-uploading them would make the button slow AND spend
 * R2 Class A writes — the one meter in the stack with no hard ceiling (see decisions doc, "R2 — the
 * one meter without a hard cap"). So each file is hashed and only genuinely-changed files are sent.
 * A content update is typically a handful of small files.
 *
 * THE SAFETY MODEL is `scripts/showcase-update.mjs`'s, kept compatible on purpose so the CLI's
 * `--revert` works on a publish this made:
 *   · every file about to be OVERWRITTEN is copied to maps/<slug>/_prev/<rel> FIRST. Files that
 *     aren't touched need no backup — that is what makes the delta version's revert still complete.
 *   · index.html is read back THROUGH THE PUBLIC ROUTE and compared byte-for-byte. A copy that
 *     can't be read the way a visitor reads it did not publish.
 *   · _manifest.json is written LAST, after that verify. A half-dead upload therefore leaves the
 *     OLD manifest describing what _prev holds, so revert still knows what to undo.
 *
 * AUTHORITY. Writes go through the Worker, which checks that the caller owns the project bound to
 * this slug (projects.raw_config.showcaseSlug). The client never holds an R2 credential.
 */
(function () {
  var WORKER = "https://mapstructor-worker.mapstructor.workers.dev";
  var PUBLIC = "https://mapstructor.com/";

  function db() { return (window.MapAuth && MapAuth.db) || window.__msDb || null; }

  async function token() {
    var d = db(); if (!d) return null;
    try { var s = await d.auth.getSession(); return (s.data && s.data.session && s.data.session.access_token) || null; }
    catch (e) { return null; }
  }

  /* The slug bound to this project, or null when it has no public site. Read fresh rather than
     cached: the binding is set out-of-band (by me, per client) and a stale null would silently
     skip the publish and look like nothing happened. */
  async function slugFor(projectId) {
    var d = db(); if (!d || !projectId) return null;
    try {
      var r = await d.from("projects").select("raw_config").eq("id", projectId).single();
      var s = r.data && r.data.raw_config && r.data.raw_config.showcaseSlug;
      return (typeof s === "string" && /^[a-z0-9_-]+$/i.test(s)) ? s : null;
    } catch (e) { return null; }
  }

  async function sha256(bytes) {
    var h = await crypto.subtle.digest("SHA-256", bytes);
    return Array.prototype.map.call(new Uint8Array(h), function (b) { return ("0" + b.toString(16)).slice(-2); }).join("");
  }

  var MIME = {
    html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8",
    json: "application/json", geojson: "application/geo+json", png: "image/png", jpg: "image/jpeg",
    jpeg: "image/jpeg", gif: "image/gif", svg: "image/svg+xml", webp: "image/webp", ico: "image/x-icon",
    woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", eot: "application/vnd.ms-fontobject",
    pmtiles: "application/octet-stream", py: "text/x-python", bat: "text/plain"
  };
  function mime(rel) { return MIME[(rel.split(".").pop() || "").toLowerCase()] || "application/octet-stream"; }

  /* Flatten the built zip into the exact key layout /maps/<slug>/ serves.
     TWO rewrites happen here and nowhere else:
       · `map/…` becomes the showcase ROOT, matching showcase-update.mjs's `--dir out/map`.
       · the logo moves from the zip's root `images/` INTO the slug folder, and index.html's
         `../images/` references are rewritten to `images/`. Left alone, every showcase would
         resolve its logo to the SHARED /maps/images/ — so two clients with differently-branded
         logos of the same filename would overwrite each other's. Found before it happened; the
         railways showcase only survives it by using the stock logo. */
  async function flatten(zip) {
    var out = [], names = Object.keys(zip.files);
    for (var i = 0; i < names.length; i++) {
      var n = names[i], f = zip.files[n];
      if (f.dir) continue;
      var rel = null;
      if (n.indexOf("map/") === 0) rel = n.slice(4);
      else if (n.indexOf("images/") === 0) rel = n;            // → maps/<slug>/images/…
      else continue;                                           // start-map.bat, serve-map.py, other_data/ — not web surface
      var bytes = await f.async("uint8array");
      if (rel === "index.html") {
        var txt = new TextDecoder().decode(bytes).replace(/\.\.\/images\//g, "images/");
        bytes = new TextEncoder().encode(txt);
      }
      out.push({ rel: rel, bytes: bytes });
    }
    return out;
  }

  /* EVERY read-back here must bypass Cloudflare's edge cache, and `cache: "no-store"` DOESN'T do
     that — it only governs the browser's own cache. The Worker serves /maps/* with
     `Cache-Control: public, max-age=300`, so for five minutes after any publish the edge will hand
     back the PREVIOUS bytes. That breaks all three reads, each in its own way:
       · the manifest — a stale one makes a genuinely-changed file look unchanged, so it is never
         uploaded and the live site keeps serving the old copy with nothing reporting a problem;
       · the _prev save — would archive a stale version, so revert would restore the wrong thing;
       · the verify — would compare against the old page and fail a publish that actually worked.
     Cloudflare keys its cache on the FULL URL, so a unique query string is a fresh fetch, while
     the Worker derives the R2 key from the path alone and ignores it. */
  function fresh(u) { return u + (u.indexOf("?") > -1 ? "&" : "?") + "_ms=" + Date.now() + "." + Math.random().toString(36).slice(2, 7); }

  async function fetchManifest(slug) {
    try {
      var r = await fetch(fresh(PUBLIC + "maps/" + slug + "/_manifest.json"), { cache: "no-store" });
      return r.ok ? await r.json() : null;
    } catch (e) { return null; }
  }

  async function put(key, body, type, tok) {
    var r = await fetch(WORKER + "/upload/" + key, {
      method: "PUT", body: body,
      headers: { Authorization: "Bearer " + tok, "Content-Type": type }
    });
    if (!r.ok) throw new Error("upload " + key + " → HTTP " + r.status + " " + (await r.text()).slice(0, 120));
    return true;
  }

  /* ── the run ─────────────────────────────────────────────────────────────── */

  async function run(projectId, say) {
    say = say || function () {};
    var slug = await slugFor(projectId);
    if (!slug) return { skipped: true };                      // no public site bound — nothing to do, not an error

    var tok = await token();
    if (!tok) throw new Error("not signed in");
    if (!window.MSDownload || !window.MSDownload.buildZip) throw new Error("the exporter isn't loaded on this page");

    /* REFUSE TO PUBLISH A HALF-LOADED PAGE (8/26, found by publishing one).
       The export takes the map's title from #header-text-value and SILENTLY falls back to "map"
       when that element hasn't been filled in yet. Publish before the page finishes loading and
       you get a complete-looking copy whose title is "Map" and whose About link is gone — live, on
       a client's public address, with nothing reporting a problem.
       A manual download with a wrong title is a nuisance; a published site with one is the client's
       page title, so the check belongs here. The exporter already refuses an EMPTY map; this is the
       same refusal for a map that is present but not yet dressed. */
    var hdr = document.getElementById("header-text-value");
    if (!hdr || !(hdr.textContent || "").trim()) {
      throw new Error("the page hasn't finished loading (the map's title isn't on screen yet) — " +
        "wait a moment and Publish again. Nothing was changed.");
    }

    say("Building the public copy…");
    var variant = window.MSDownload.detectVariant();
    var zip = await window.MSDownload.buildZip({
      returnZip: true, rawData: false, format: "geojson", variant: variant,
      embed: variant === "maplibre"                            // data travels inside the copy — it must work with no platform behind it
    });
    var files = await flatten(zip);
    if (!files.length) throw new Error("the build produced no files");
    var idx = files.filter(function (f) { return f.rel === "index.html"; })[0];
    if (!idx) throw new Error("the build produced no index.html");

    say("Checking what changed…");
    var man = await fetchManifest(slug);
    var known = (man && man.hashes) || null;
    var hashes = {}, changed = [];
    for (var i = 0; i < files.length; i++) {
      var h = await sha256(files[i].bytes);
      hashes[files[i].rel] = h;
      /* No hashes in the manifest means the last publish came from the CLI, which doesn't record
         them. Upload everything rather than guess — a wrong "unchanged" leaves a stale file live
         forever, and nothing downstream would ever notice. */
      if (!known || known[files[i].rel] !== h) changed.push(files[i]);
    }
    if (!changed.length) { say("Already up to date."); return { slug: slug, uploaded: 0, url: PUBLIC + "maps/" + slug + "/" }; }

    /* _prev BEFORE any overwrite. Only files this publish will actually replace need saving —
       untouched files are still their own backup. Read through the public route (they are public
       objects) and write back through the Worker. */
    var liveFiles = (man && man.files) || [];
    var overwriting = changed.filter(function (f) { return liveFiles.indexOf(f.rel) > -1; });
    for (var p = 0; p < overwriting.length; p++) {
      say("Saving the current version… (" + (p + 1) + "/" + overwriting.length + ")");
      var pr = await fetch(fresh(PUBLIC + "maps/" + slug + "/" + overwriting[p].rel), { cache: "no-store" });
      if (!pr.ok) continue;                                    // already missing live — nothing to preserve
      await put("maps/" + slug + "/_prev/" + overwriting[p].rel, await pr.arrayBuffer(), mime(overwriting[p].rel), tok);
    }

    for (var u = 0; u < changed.length; u++) {
      say("Uploading… (" + (u + 1) + "/" + changed.length + ")");
      await put("maps/" + slug + "/" + changed[u].rel, changed[u].bytes, mime(changed[u].rel), tok);
    }

    /* VERIFY through the route a visitor uses, byte-for-byte. tiles.mapstructor.com is the raw R2
       domain and serves exact keys only, so a check there would pass while the page people actually
       open failed (found 8/25). */
    say("Checking the live page…");
    var vr = await fetch(fresh(PUBLIC + "maps/" + slug + "/index.html"), { cache: "no-store" });
    var vb = vr.ok ? new Uint8Array(await vr.arrayBuffer()) : null;
    var same = vb && vb.length === idx.bytes.length && vb.every(function (b, k) { return b === idx.bytes[k]; });
    if (!same) {
      throw new Error("the live page didn't come back matching what was uploaded — the previous version's " +
        "record is untouched, so `showcase-update.mjs --revert --slug " + slug + "` restores it");
    }

    var allFiles = files.map(function (f) { return f.rel; });
    await put("maps/" + slug + "/_manifest.json", JSON.stringify({
      at: new Date().toISOString(), files: allFiles,
      added: changed.filter(function (f) { return liveFiles.indexOf(f.rel) < 0; }).map(function (f) { return f.rel; }),
      prevHolds: overwriting.map(function (f) { return f.rel; }),
      hashes: hashes
    }, null, 2), "application/json", tok);

    say("Public site updated.");
    return { slug: slug, uploaded: changed.length, url: PUBLIC + "maps/" + slug + "/" };
  }

  window.MSPublishSite = { run: run, slugFor: slugFor };
})();
