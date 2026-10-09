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
 * AUTHORITY. Writes go through the Worker, which asks the DATABASE whether the caller may edit the
 * project bound to this slug (projects.raw_config.showcaseSlug → ms_project_editor). Owner or
 * invited editor — the same predicate /article uses, so "who may edit this map" has one definition.
 * The client never holds an R2 credential.
 */
(function () {
  var WORKER = "https://mapstructor-worker.mapstructor.workers.dev";
  var PUBLIC = "https://mapstructor.com/";

  function db() { return (window.MapAuth && MapAuth.db) || window.__msDb || null; }

  /* One token reader for the whole platform (MapAuth.freshToken), which RENEWS an expiring session
     instead of concluding the person is signed out. This used to return null on any hiccup and the
     caller said "not signed in" — during a client demo, to someone who was signed in. */
  async function token() {
    if (typeof window.msFreshToken === "function") return await window.msFreshToken();
    var d = db(); if (!d) throw new Error("the sign-in system did not load on this page — reload and try again");
    var s = await d.auth.getSession();
    var t = (s.data && s.data.session && s.data.session.access_token) || null;
    if (!t) throw new Error("your sign-in could not be read — reload the page and sign in again");
    return t;
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

  /* WHEN THE MANIFEST CANNOT SAY WHAT CHANGED, ASK R2 (10/9). A CLI push records no hashes, and a
     stale manifest is distrusted entirely — either way this used to mean "send the whole copy".
     On the Railways showcase that is a 146 MB archive pulled down and pushed back through the
     Worker from a browser tab, and it died mid-flight ("Failed to fetch") on the 35th of 131 files,
     every time. R2 returns each object's MD5 as its ETag (single-part uploads — every object this
     and the CLI write), so one HEAD per file tells us whether the live copy already IS the built
     one. Multipart uploads carry a "-N" ETag that is not an MD5; those read as "changed", which is
     the safe direction. MD5 comes from SparkMD5 (CDN, loaded on first use — the Web Crypto API has
     no MD5 by design). */
  var SPARK_URLS = ["https://cdnjs.cloudflare.com/ajax/libs/spark-md5/3.0.2/spark-md5.min.js", "https://cdn.jsdelivr.net/npm/spark-md5@3.0.2/spark-md5.min.js"];
  var _spark = null;
  function ensureMd5() {
    if (window.SparkMD5) return Promise.resolve(window.SparkMD5);
    if (_spark) return _spark;
    _spark = new Promise(function (res, rej) {
      var i = 0;
      (function next() {
        if (i >= SPARK_URLS.length) { _spark = null; return rej(new Error("MD5 library could not be loaded")); }
        var s = document.createElement("script"); s.src = SPARK_URLS[i++];
        s.onload = function () { window.SparkMD5 ? res(window.SparkMD5) : next(); };
        s.onerror = next;
        document.head.appendChild(s);
      })();
    });
    return _spark;
  }
  function md5(bytes) { return window.SparkMD5.ArrayBuffer.hash(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)); }
  async function liveEtags(slug, rels, say) {
    var out = {}, next = 0, done = 0;
    async function worker() {
      for (;;) {
        var i = next++; if (i >= rels.length) return;
        try {
          // a ONE-BYTE ranged GET, not HEAD: the Worker route answers HEAD without the ETag but a
          // 206 carries the full object's ETag (and exposes it cross-origin) — measured 10/9
          var r = await fetch(fresh(PUBLIC + "maps/" + slug + "/" + rels[i]), { headers: { Range: "bytes=0-0" }, cache: "no-store" });
          if (r.ok) { var e = (r.headers.get("etag") || "").replace(/^W\//, "").replace(/"/g, ""); if (/^[0-9a-f]{32}$/i.test(e)) out[rels[i]] = e.toLowerCase(); }
          try { await r.arrayBuffer(); } catch (eB) {}   // drain the one byte so the connection is reused
        } catch (eH) { /* unreadable live file → treated as changed, which is the safe direction */ }
        done++; if (done % 20 === 0) say("Comparing with what's live… (" + done + "/" + rels.length + ")");
      }
    }
    await Promise.all([worker(), worker(), worker(), worker(), worker(), worker()]);
    return out;
  }

  var MIME = {
    html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8",
    json: "application/json", geojson: "application/geo+json", png: "image/png", jpg: "image/jpeg",
    jpeg: "image/jpeg", gif: "image/gif", svg: "image/svg+xml", webp: "image/webp", ico: "image/x-icon",
    woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", eot: "application/vnd.ms-fontobject",
    pmtiles: "application/octet-stream", py: "text/x-python", bat: "text/plain",
    // 10/9: the table engine ships as an ES MODULE + WASM. A browser refuses to import() a module
    // served as octet-stream, which is exactly how the first table-carrying publish went live:
    // ▦ present, "No list available" — DuckDB never loaded. These two types are load-bearing.
    mjs: "text/javascript; charset=utf-8", wasm: "application/wasm", parquet: "application/octet-stream"
  };
  function mime(rel) { return MIME[(rel.split(".").pop() || "").toLowerCase()] || "application/octet-stream"; }
  // extensions where a WRONG Content-Type breaks the page outright — those get their live type checked
  // on every publish, so a fix to this map re-sends them even though their bytes did not change
  var TYPE_SENSITIVE = { mjs: 1, wasm: 1, js: 1, css: 1, html: 1 };

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
    // cliff-ok: the Worker's refusals are one short sentence ("that showcase slug is not bound to a
    // map you own"); 400 chars is far past the longest of them, and truncating a reason is exactly
    // the failure that cost a day on 8/27 — so this is deliberately generous, not a data cap.
    if (!r.ok) throw new Error("upload " + key + " → HTTP " + r.status + " " + (await r.text()).slice(0, 400));
    return true;
  }

  /* Read index.html back through the route a VISITOR uses and say precisely how it differs.
     tiles.mapstructor.com is the raw R2 domain and serves exact keys only, so a check there would
     pass while the page people actually open failed (found 8/25). */
  async function verify(slug, want) {
    var r;
    try { r = await fetch(fresh(PUBLIC + "maps/" + slug + "/index.html"), { cache: "no-store" }); }
    catch (e) { return { ok: false, why: "the live page could not be fetched (" + ((e && e.message) || e) + ")" }; }
    if (!r.ok) return { ok: false, why: "the live page answered HTTP " + r.status };
    var got = new Uint8Array(await r.arrayBuffer());
    if (got.length !== want.length)
      return { ok: false, why: "the live page is " + got.length + " bytes and the copy sent is " + want.length };
    for (var i = 0; i < got.length; i++)
      if (got[i] !== want[i]) return { ok: false, why: "the live page differs from the copy sent, from byte " + i + " on" };
    return { ok: true };
  }

  /* ── the run ─────────────────────────────────────────────────────────────── */

  async function run(projectId, say) {
    say = say || function () {};
    var slug = await slugFor(projectId);
    if (!slug) return { skipped: true };                      // no public site bound — nothing to do, not an error

    var tok = await token();   // throws with the real reason, and renews an expiring session first
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

    /* REFUSE TO PUBLISH A MAP THAT DRAWS NOTHING (8/27, after doing it twice to a paying client).
       The exporter already refuses an EMPTY map — no layers at all. This map had three, so the
       refusal never fired, and the copy that went live was 4 KB of layer definitions with zero
       shapes in them: a basemap and a legend, at a client's public address, for hours. The cause
       was upstream (a deleted layer had quietly emptied another) but the publish had every chance
       to notice and said "Published ✓" instead.
       The test is deliberately narrow — refuse only when NOTHING would draw. A single empty layer
       among several is a normal work-in-progress state and stays allowed. */
    var ll = files.filter(function (f) { return f.rel === "project/lists/layersList.js"; })[0];
    if (ll) {
      try {
        var arr = JSON.parse(new TextDecoder().decode(ll.bytes).match(/const layers = ([\s\S]*);\s*$/)[1]);
        var drawn = 0, blank = [];
        (function walk(a) {
          (a || []).forEach(function (n) {
            if (n.children) { walk(n.children); return; }
            if (n.checked === false) return;                       // switched off on purpose
            var s = n.source || {};
            if (s.type !== "geojson") { drawn++; return; }          // tilesets carry their own data
            var fc = (s.data && s.data.features) || [];
            if (fc.length) drawn++; else blank.push(n.label || n.id);
          });
        })(arr);
        if (!drawn && blank.length) {
          throw new Error("this would publish a blank map — " + blank.join(", ") +
            (blank.length > 1 ? " are" : " is") + " switched on but " + (blank.length > 1 ? "have" : "has") +
            " no shapes, and nothing else would draw. Nothing was changed.");
        }
      } catch (e) {
        // A parse failure must not block a publish — but a real refusal above must not be swallowed
        // by this catch either, which is exactly the kind of guard that silently stops guarding.
        if (/would publish a blank map/.test(e.message || "")) throw e;
      }
    }

    say("Checking what changed…");
    var man = await fetchManifest(slug);
    var known = (man && man.hashes) || null;

    /* THE MANIFEST IS A CLAIM ABOUT WHAT IS LIVE, AND NOTHING USED TO CHECK IT (8/27).
       Anything that writes maps/<slug>/ without finishing the manifest desynchronises it — a CLI
       `showcase-update.mjs` push, a publish that died after uploading, a hand-fix. After that the
       delta logic reads the stale record, decides index.html is "unchanged", skips it — and the
       verify then compares the page it did NOT send against the page it built. It fails, the
       manifest stays stale, and it fails again on EVERY subsequent publish, forever, with a message
       that blames the upload. That is exactly what happened to Slater's map: live index.html was a
       CLI push (Content-Type `text/html`), the manifest still described the browser publish
       (`text/html; charset=utf-8`, preserved in _prev), and Publish could never succeed again.
       So: hash what is ACTUALLY live and compare it to what the manifest claims. Disagreement means
       the record cannot be trusted for any file, so send the whole copy — self-healing, one extra
       21 KB GET per publish. */
    if (known) {
      var lr = await fetch(fresh(PUBLIC + "maps/" + slug + "/index.html"), { cache: "no-store" });
      var liveHash = lr.ok ? await sha256(new Uint8Array(await lr.arrayBuffer())) : null;
      if (liveHash !== known["index.html"]) {
        known = null;
        say("The record of what's published was out of date — sending the whole copy…");
      }
    }

    /* No usable hashes (a CLI push, or a manifest that disagreed with the live page): ask R2 what is
       live, file by file, and compare MD5s — see liveEtags. Only a file whose live MD5 differs (or
       that is not live at all) is sent. A wrong "unchanged" would leave a stale file live forever,
       which is why the comparison is the object's own content hash and nothing looser. */
    var etags = null;
    if (!known) {
      say("Comparing with what's live…");
      try { await ensureMd5(); etags = await liveEtags(slug, files.map(function (f) { return f.rel; }), say); }
      catch (eE) { etags = null; say("Could not compare with the live copy — sending everything…"); }
    }
    var hashes = {}, changed = [];
    for (var i = 0; i < files.length; i++) {
      var h = await sha256(files[i].bytes);
      hashes[files[i].rel] = h;
      if (known) { if (known[files[i].rel] !== h) changed.push(files[i]); }
      else if (etags) { if (etags[files[i].rel] !== md5(files[i].bytes)) changed.push(files[i]); }
      else changed.push(files[i]);
    }
    /* Bytes equal but TYPE wrong → still changed. One ranged GET per type-sensitive file that
       would otherwise be skipped; the 206 carries the live Content-Type. */
    var inChanged = {}; changed.forEach(function (f) { inChanged[f.rel] = 1; });
    var toType = files.filter(function (f) { return !inChanged[f.rel] && TYPE_SENSITIVE[(f.rel.split(".").pop() || "").toLowerCase()]; });
    if (toType.length) {
      say("Checking file types on the live copy…");
      var tn = 0;
      async function typeWorker() {
        for (;;) {
          var ti = tn++; if (ti >= toType.length) return;
          try {
            var tr = await fetch(fresh(PUBLIC + "maps/" + slug + "/" + toType[ti].rel), { headers: { Range: "bytes=0-0" }, cache: "no-store" });
            var ct = (tr.headers.get("content-type") || "").toLowerCase().replace(/\s+/g, "");
            try { await tr.arrayBuffer(); } catch (eB2) {}
            if (tr.ok && ct !== mime(toType[ti].rel).toLowerCase().replace(/\s+/g, "")) { changed.push(toType[ti]); inChanged[toType[ti].rel] = 1; }
          } catch (eT) { /* unreadable → leave as unchanged; the byte check already passed */ }
        }
      }
      await Promise.all([typeWorker(), typeWorker(), typeWorker(), typeWorker(), typeWorker(), typeWorker()]);
    }
    say(changed.length + " of " + files.length + " files changed…");
    if (!changed.length) { say("Already up to date."); return { slug: slug, uploaded: 0, url: PUBLIC + "maps/" + slug + "/" }; }
    /* Whenever anything ships, index.html ships with it — it is the file the verify judges the whole
       publish by, so it must be one this run actually wrote. */
    if (!changed.some(function (f) { return f.rel === "index.html"; })) changed.push(idx);

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
    var v = await verify(slug, idx.bytes);
    if (!v.ok) {
      /* ONE REPAIR PASS before declaring failure. The old code had a single verdict for three
         different failures — a page that never arrived, a page of the wrong length, and a page that
         differs mid-body — and gave the same sentence for all of them, which is why the real cause
         took a day to find. Now: say which, re-send the page once, and look again. */
      say("The live page didn't match — re-sending it…");
      await put("maps/" + slug + "/index.html", idx.bytes, mime("index.html"), tok);
      v = await verify(slug, idx.bytes);
    }
    if (!v.ok) {
      throw new Error("the public site did not update — " + v.why + ". The previous version's record is " +
        "untouched, so `showcase-update.mjs --revert --slug " + slug + "` restores it.");
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
