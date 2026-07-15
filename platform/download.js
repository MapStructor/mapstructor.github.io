/* download.js — "⬇ Download whole project": a self-contained static export of the CURRENT map.

   Sidebar button (under the zoom buttons, viewer AND editor) → dialog → zip:

     start-map.bat            one double-click: python http.server + browser
     images/<logo>            the map's header logo (or the default), referenced as ../images/ from map/
     map/index.html           the VIEWER shell, transformed for standalone (see transformIndexHtml)
     map/engine/*             byte-copies of the running engine (+ vendored jquery-ui)
     map/project/renderRegistry.js   platform copy + a reattach appendix (panel.render functions)
     map/project/labels.js           platform copy (dependency-free label renderer)
     map/project/lists/*.js          GENERATED from the page's live runtime config — the serializer half
                                     ("C3.5 writer") of configLoader.js; same globals the engine reads
     map/project/secrets/mapbox-token.js   only when the page ran on a token other than restrictedToken
     other_data/*.geojson     raw exports of the drawn/geojson layers (dialog checkbox)

   The download is STANDALONE BY DESIGN: it depends on nothing MapStructor and never updates.
   Everything is serialized from the page's RUNTIME state, so what you see is exactly what you get —
   viewer = the published snapshot, editor = the live working state.

   TWO VARIANTS, decided by the map's own layers (either/or, 7/14):
     mapbox   — any mapbox:// layer source present. The zip runs mapbox-gl (pinned engine version),
                carries the token file, and streams every layer from its existing URL. Unchanged v1.
     maplibre — no mapbox:// sources. The zip runs MapLibre (vendored, free, NO token anywhere);
                worker/pmtiles layers can be EMBEDDED as .pmtiles files (offline data); the engine's
                hardcoded mapbox://styles/* basemaps are served free equivalents through a protocol
                handler (satellite → Esri World Imagery, everything else → OpenFreeMap liberty).
                Proven in test/maplibre-download-spike (engine.css alias block, Noto fonts, ranges).
   Both variants ship serve-map.py (python's stock http.server ignores Range headers, which .pmtiles
   reads require). Remaining CDN libraries stay CDN until C3 vendors them. */

(function () {
  "use strict";

  // no project = already a static/standalone page — nothing to serialize, no button
  if (typeof platformProjectId === "undefined" || !platformProjectId) return;

  var SUPABASE_URL = "https://eqpxlwbjqiwfjlsuapvu.supabase.co";
  var SUPABASE_KEY = "sb_publishable_ijLmSmMUeNBrgMGL8Aol4g_S5-xwUzD";
  var JSZIP_URL = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";

  // MapLibre-variant pieces (pinned; vendored INTO the zip at build time)
  var MAPLIBRE_JS = "https://unpkg.com/maplibre-gl@5.24.0/dist/maplibre-gl.js";
  var MAPLIBRE_CSS = "https://unpkg.com/maplibre-gl@5.24.0/dist/maplibre-gl.css";
  var PMTILES_JS = "https://unpkg.com/pmtiles@3.2.1/dist/pmtiles.js";
  var COMPARE_JS = "https://api.mapbox.com/mapbox-gl-js/plugins/mapbox-gl-compare/v0.4.0/mapbox-gl-compare.js";
  var COMPARE_CSS = "https://api.mapbox.com/mapbox-gl-js/plugins/mapbox-gl-compare/v0.4.0/mapbox-gl-compare.css";

  // tiles-worker hosts whose backing .pmtiles archive is publicly fetchable — these layers can be
  // EMBEDDED (the archive file rides in the zip). A layer may also carry an explicit `pmtiles`
  // archive URL on its node (raw_config passthrough) — that always wins.
  var WORKER_ARCHIVES = [
    { match: /^https:\/\/ames-tiles\.mapstructor\.workers\.dev\/([^\/]+)\//,
      archive: function (m) { return "https://pub-411b8477c87c4a26b335ecde4062e140.r2.dev/" + m[1] + ".pmtiles"; } }
  ];

  // engine files byte-copied into the zip. google-analytics.js and handle-mobile-devices.js are
  // deliberately absent (GA is stripped; the mobile redirect targets a page the zip doesn't have).
  var ENGINE_FILES = [
    "engine/addLayers.js", "engine/addMapLayer.js", "engine/engine.css", "engine/eventsHandle.js",
    "engine/generateLayers.js", "engine/generateMaps.js", "engine/index.js", "engine/infoPanel.js",
    "engine/mapinit.js", "engine/refreshLayers.js", "engine/sliderpopups.js", "engine/utils.js",
    "engine/vendor/jquery.ui.touch-punch.min.js",
    "engine/vendor/jquery-ui-1.10.3.custom/js/jquery-ui-1.10.3.custom.min.js",
    "engine/vendor/jquery-ui-1.10.3.custom/css/ui-darkness/jquery-ui-1.10.3.custom.css",
    "engine/vendor/jquery-ui-1.10.3.custom/css/ui-darkness/images/ui-bg_glass_20_555555_1x400.png",
    "engine/vendor/jquery-ui-1.10.3.custom/css/ui-darkness/images/ui-bg_inset-soft_25_000000_1x100.png"
  ];

  var DEFAULT_LOGO = "../images/nittygrittymapping_logo.png";

  /* ── UI ─────────────────────────────────────────────────────────────────── */

  function ensureCss() {
    if (document.getElementById("msdl-css")) return;
    var s = document.createElement("style"); s.id = "msdl-css";
    s.textContent =
      "#ms-download-section{text-align:center;margin:4px 0 10px;}" +
      "#msdl-open{padding:7px 14px;border:1px solid #b9d0b9;border-radius:8px;background:#eef7ee;color:#2d5a2d;font-weight:700;font-size:13px;cursor:pointer;font-family:'Source Sans Pro',Arial,sans-serif;}" +
      "#msdl-open:hover{background:#e2f1e2;}" +
      "#msdl-overlay{position:fixed;inset:0;background:rgba(30,27,46,.45);z-index:100001;display:flex;align-items:center;justify-content:center;font-family:'Source Sans Pro',Arial,sans-serif;}" +
      "#msdl-panel{background:#fff;border-radius:12px;box-shadow:0 10px 40px rgba(0,0,0,.35);width:430px;max-width:92vw;padding:20px 22px;}" +
      "#msdl-panel h3{margin:0 0 4px;font-size:17px;color:#1e1b2e;}" +
      "#msdl-panel .msdl-sub{font-size:12px;color:#6b6680;margin:0 0 14px;line-height:1.5;}" +
      ".msdl-row{display:flex;gap:8px;align-items:center;margin-bottom:10px;font-size:13px;color:#1e1b2e;}" +
      ".msdl-row select{padding:4px 8px;border:1px solid #cdc6e0;border-radius:6px;font-size:12px;}" +
      "#msdl-build{margin-top:6px;padding:8px 16px;border:none;border-radius:8px;background:#7c5cbf;color:#fff;font-weight:700;font-size:14px;cursor:pointer;}" +
      "#msdl-build[disabled]{opacity:.55;cursor:default;}" +
      "#msdl-status{font-size:12px;margin-top:10px;min-height:15px;color:#6b6680;}" +
      "#msdl-note{font-size:11px;color:#9a93ad;margin-top:10px;border-top:1px solid #f0ecf8;padding-top:8px;line-height:1.5;}" +
      "#msdl-close{float:right;border:none;background:none;font-size:18px;color:#888;cursor:pointer;line-height:1;}";
    document.head.appendChild(s);
  }

  function injectButton() {
    if (document.getElementById("ms-download-section")) return true;
    var zb = document.getElementById("zoom-buttons-section");
    if (!zb || !zb.parentNode) return false;
    ensureCss();
    var d = document.createElement("div"); d.id = "ms-download-section";
    d.innerHTML = "<button id=\"msdl-open\" title=\"Download this map as a self-contained folder\">&#11015; Download whole project</button>";
    zb.parentNode.insertBefore(d, zb.nextSibling);   // sibling AFTER the zoom buttons — survives panel regenerations
    d.querySelector("#msdl-open").addEventListener("click", openDialog);
    return true;
  }

  function openDialog() {
    ensureCss();
    var old = document.getElementById("msdl-overlay"); if (old) old.remove();

    var variant = detectVariant();
    var archCount = variant === "maplibre" ? Object.keys(collectArchives()).length : 0;
    var embedRow = variant === "maplibre" && archCount > 0
      ? "<label class=\"msdl-row\"><input type=\"checkbox\" id=\"msdl-embed\" checked> Embed map data in the folder (.pmtiles — the data itself works offline and from any host)</label>"
      : "";
    var variantNote = variant === "maplibre"
      ? "This map uses no Mapbox layers, so the copy runs on <b>MapLibre</b> (free — no Mapbox token is included anywhere). Basemaps become free equivalents: satellite &rarr; Esri World Imagery, others &rarr; OpenFreeMap streets."
      : "This map contains <b>Mapbox layers</b>, so the copy runs on Mapbox GL with the token file inside the zip — a URL-restricted token must allow the domain the copy runs on (for local runs: <b>http://localhost</b>). Offline data embedding is available for maps without Mapbox layers.";

    var ov = document.createElement("div"); ov.id = "msdl-overlay";
    ov.innerHTML = "<div id=\"msdl-panel\">" +
      "<button id=\"msdl-close\" title=\"Close\">&times;</button>" +
      "<h3>Download whole project</h3>" +
      "<p class=\"msdl-sub\">A self-contained, static copy of this map — a folder you can open on any computer or upload to any web host. It depends on nothing from MapStructor and never updates.</p>" +
      "<label class=\"msdl-row\"><input type=\"checkbox\" id=\"msdl-rawdata\" checked> Include raw data (layer exports in <b>other_data/</b>)</label>" +
      "<div class=\"msdl-row\">Data format: <select id=\"msdl-format\"><option value=\"geojson\" selected>GeoJSON</option></select><span style=\"color:#9a93ad;font-size:11px;\">(more formats later)</span></div>" +
      embedRow +
      "<button id=\"msdl-build\">Build ZIP</button>" +
      "<div id=\"msdl-status\"></div>" +
      "<div id=\"msdl-note\">Run <b>start-map.bat</b> inside the unzipped folder (needs Python), or upload the folder to any static host and open <b>map/index.html</b>. " + variantNote + "</div>" +
      "</div>";
    document.body.appendChild(ov);
    function close() { ov.remove(); }
    ov.addEventListener("click", function (e) { if (e.target === ov) close(); });
    ov.querySelector("#msdl-close").addEventListener("click", close);
    document.addEventListener("keydown", function esc(e) { if (e.key === "Escape") { close(); document.removeEventListener("keydown", esc); } });
    ov.querySelector("#msdl-build").addEventListener("click", function () {
      var btn = this; btn.disabled = true;
      var embedEl = ov.querySelector("#msdl-embed");
      buildZip({
        rawData: !!ov.querySelector("#msdl-rawdata").checked,
        format: ov.querySelector("#msdl-format").value,
        variant: variant,
        embed: !!(embedEl && embedEl.checked)
      }).then(function () {
        btn.disabled = false; setStatus("Done — check your downloads folder.", "#2d7a2d");
      }, function (e) {
        console.error("download build failed", e);
        btn.disabled = false; setStatus("Failed: " + (e && e.message ? e.message : e), "#b4453a");
      });
    });
  }

  function setStatus(msg, color) {
    var el = document.getElementById("msdl-status");
    if (el) { el.textContent = msg; el.style.color = color || "#6b6680"; }
  }

  /* ── serialization helpers ──────────────────────────────────────────────── */

  // deep-copy a config value for the generated lists: drops functions, `_`-internal keys, and
  // platform-only panel keys (supabaseLookup — downloads are standalone by rule, 7/12).
  var SKIP_KEYS = { supabaseLookup: 1, render: 0 };   // panel.render is a function → dropped by the function rule
  function cleanValue(v, seen) {
    if (v == null || typeof v === "number" || typeof v === "boolean" || typeof v === "string") return v;
    if (typeof v === "function") return undefined;
    if (Array.isArray(v)) return v.map(function (x) { var c = cleanValue(x, seen); return c === undefined ? null : c; });
    if (typeof v === "object") {
      if (seen.has(v)) return undefined;   // defensive: editor code may hang extra refs off nodes
      seen.add(v);
      var o = {};
      Object.keys(v).forEach(function (k) {
        if (k.charAt(0) === "_" || SKIP_KEYS[k] === 1) return;
        var c = cleanValue(v[k], seen);
        if (c !== undefined) o[k] = c;
      });
      seen.delete(v);
      return o;
    }
    return undefined;
  }
  function js(v, indent) { return JSON.stringify(cleanValue(v, new WeakSet()), null, indent == null ? 2 : indent); }

  // the lists declare their globals with `const`/`let` — those are NOT window properties, but they
  // ARE visible to this script as bare identifiers (one shared global scope). Undeclared → fallback.
  function grab(fn, fallback) { try { var v = fn(); return v == null ? fallback : v; } catch (e) { return fallback; } }

  /* ── variant detection (either/or, decided by the map's own layers) ─────── */

  function walkLeaves(fn) {
    (function w(a) { (a || []).forEach(function (n) { if (n.children) { w(n.children); return; } fn(n); }); })(grab(function () { return layers; }, []));
  }

  // any mapbox:// LAYER source → the copy must run Mapbox GL (mapbox variant); none → MapLibre.
  // Basemap styles don't count: the maplibre variant serves them free equivalents.
  function detectVariant() {
    var mapbox = false;
    walkLeaves(function (n) {
      var u = (n.source && (n.source.url || (n.source.tiles && n.source.tiles[0]))) || "";
      if (String(u).indexOf("mapbox://") === 0) mapbox = true;
    });
    return mapbox ? "mapbox" : "maplibre";
  }

  function archiveFor(n) {
    if (n.pmtiles) return { name: (n.id || "data"), url: n.pmtiles };
    var u = (n.source && n.source.tiles && n.source.tiles[0]) || "";
    for (var i = 0; i < WORKER_ARCHIVES.length; i++) {
      var m = String(u).match(WORKER_ARCHIVES[i].match);
      if (m) return { name: m[1], url: WORKER_ARCHIVES[i].archive(m) };
    }
    return null;
  }

  // node.id → {name,url} for every layer whose archive we can fetch (names dedup to one file each)
  function collectArchives() {
    var by = {};
    walkLeaves(function (n) { var a = archiveFor(n); if (a) by[n.id] = a; });
    return by;
  }

  function projectName() {
    var el = document.getElementById("header-text-value");
    var t = el && el.textContent ? el.textContent.trim() : "";
    return t || "map";
  }

  function genHeader(name) {
    var sc = grab(function () { return siteConfig; }, {});
    var sm = grab(function () { return siteMeta; }, {});
    var meta = cleanValue(sm, new WeakSet()) || {};
    meta.title = name; meta.ogSiteName = name;
    // the zip has no mobile page and no MapStructor home — keep every link inside the folder
    var cfg = { mapboxUsername: sc.mapboxUsername || "mapbox", mobileRedirect: "./index.html", desktopRedirect: "./index.html" };
    var logoEl = document.getElementById("logo-link");
    var link = logoEl ? (logoEl.getAttribute("href") || "") : "";
    if (!link || link === "../index.html") link = "#";
    return "/* generated by MapStructor — Download whole project */\n" +
      "const siteAnalytics = { trackingId: \"\" };  // analytics are stripped from standalone exports\n\n" +
      "const siteConfig = " + js(cfg) + ";\n\n" +
      "const siteMeta = " + js(meta) + ";\n\n" +
      "const siteLogoLink = " + JSON.stringify(link) + ";\n" +
      "const siteHeaderText = " + JSON.stringify(name) + ";\n\n" +
      "const zoomButtons = " + js(grab(function () { return zoomButtons; }, [])) + ";\n\n" +
      "const headerButtons = " + js(grab(function () { return headerButtons; }, [])) + ";\n";
  }

  function genLayersList(embedById) {
    var data = cleanValue(grab(function () { return layers; }, []), new WeakSet()) || [];
    // embedded layers: the zip carries the archive itself — point the source at the local file
    // (relative pmtiles:// URL, resolved against map/index.html by the injected protocol handler)
    if (embedById) (function w(a) {
      (a || []).forEach(function (n) {
        if (n.children) { w(n.children); return; }
        var em = embedById[n.id];
        if (em) n.source = { type: "vector", url: "pmtiles://data/" + em.name + ".pmtiles" };
      });
    })(data);
    return "/* generated by MapStructor — the map's live config, frozen. panel.render functions are\n" +
      "   reattached from ../renderRegistry.js (see its appendix); everything else is data. */\n" +
      "const layers = " + JSON.stringify(data, null, 2) + ";\n";
  }

  function genMapData() {
    return "/* generated by MapStructor */\n" +
      "const baseMaps = " + js(grab(function () { return baseMaps; }, [])) + ";\n\n" +
      "const mapSections = " + js(grab(function () { return mapSections; }, [])) + ";\n\n" +
      "const mapConfig = " + js(grab(function () { return mapConfig; }, {})) + ";\n";
  }

  function genBounds() { return "const boundsList = " + js(grab(function () { return boundsList; }, {})) + ";\n"; }

  function genSliderDates() {
    var s = grab(function () { return sliderStart; }, null), e = grab(function () { return sliderEnd; }, null);
    var start = "01/01/1900", end = "01/01/2025";
    try { if (s && window.moment) start = moment.unix(s).format("MM/DD/YYYY"); } catch (x) {}
    try { if (e && window.moment) end = moment.unix(e).format("MM/DD/YYYY"); } catch (x) {}
    return "const sliderStartDate = " + JSON.stringify(start) + ";\nconst sliderEndDate   = " + JSON.stringify(end) + ";\n";
  }

  function genModalInfo() {
    var mh = grab(function () { return modal_header_text; }, {}), mc = grab(function () { return modal_content_html; }, {});
    var out = "var modal_header_text = [];\nvar modal_content_html = [];\n\n";
    Object.keys(mh).forEach(function (k) {
      out += "modal_header_text[" + JSON.stringify(k) + "] = " + JSON.stringify(String(mh[k])) + ";\n";
      out += "modal_content_html[" + JSON.stringify(k) + "] = " + JSON.stringify(String(mc[k] != null ? mc[k] : "")) + ";\n\n";
    });
    return out;
  }

  function genFeatures() {
    // header state is read off the live page — the single features key anything consumes today
    var headerOn = !document.body.classList.contains("ms-no-header");
    return "var features = " + js({ timeline: true, header: headerOn, sidebar: true, infoPanel: true }) + ";\n";
  }

  function genDisclaimer() { return "var showDisclaimer = " + (grab(function () { return showDisclaimer; }, false) === true) + ";\n"; }

  function genTestProject() { return "var useTestProject = false;\nvar testProjectPath = \"test_project\";\n"; }

  function genRestrictedToken(variant) {
    if (variant === "maplibre") {
      return "/* MapLibre copy — nothing here talks to Mapbox, so NO token is included. */\n" +
        "const restrictedToken = \"\";\n";
    }
    var t = grab(function () { return restrictedToken; }, (window.mapboxgl && mapboxgl.accessToken) || "");
    return "/* Mapbox public (pk.) token this map renders with. If it is URL-restricted, the copy only\n" +
      "   works on allowed domains — for local runs add http://localhost to the token's URL\n" +
      "   restrictions (Mapbox dashboard → Access tokens), or replace this with your own token. */\n" +
      "const restrictedToken = " + JSON.stringify(t) + ";\n";
  }

  /* ── index.html → standalone transform ──────────────────────────────────── */

  // MapLibre ≥3 dropped the mapboxgl-* class aliases; engine.css styles popups/controls by the
  // old names. Duplicate every selector containing .mapboxgl- with a .maplibregl- twin.
  function aliasMaplibreCss(css) {
    return css.replace(/([^{}]+)\{/g, function (full, sel) {
      if (sel.indexOf(".mapboxgl-") === -1 || sel.trim().charAt(0) === "@") return full;
      return sel + ", " + sel.trim().replace(/\.mapboxgl-/g, ".maplibregl-") + "{";
    });
  }

  // injected into the maplibre-variant index.html: local pmtiles archives + free basemap styles.
  // The engine hardcodes mapbox://styles/<user>/<id> (mapinit + setupMapSwitching) — the "mapbox"
  // protocol serves free equivalents so the engine never needs an edit.
  function genProtocolScript() {
    return "    <script>\n" +
      "      /* MapStructor standalone (MapLibre): local .pmtiles + free basemaps.\n" +
      "         satellite styles → Esri World Imagery; everything else → OpenFreeMap liberty. */\n" +
      "      (function () {\n" +
      "        var p = new pmtiles.Protocol();\n" +
      "        maplibregl.addProtocol(\"pmtiles\", p.tile.bind(p));\n" +
      "        var ESRI = { version: 8, name: \"Satellite (Esri)\",\n" +
      "          glyphs: \"https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf\",\n" +
      "          sources: { esri: { type: \"raster\", tileSize: 256, maxzoom: 19,\n" +
      "            tiles: [\"https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}\"],\n" +
      "            attribution: \"Esri, Maxar, Earthstar Geographics, and the GIS User Community\" } },\n" +
      "          layers: [{ id: \"esri-satellite\", type: \"raster\", source: \"esri\" }] };\n" +
      "        maplibregl.addProtocol(\"mapbox\", function (params) {\n" +
      "          var m = params.url.match(/^mapbox:\\/\\/styles\\/[^\\/]+\\/([^\\/?]+)/);\n" +
      "          if (!m) return Promise.reject(new Error(\"standalone: unsupported mapbox url \" + params.url));\n" +
      "          if (/satellite/i.test(m[1])) return Promise.resolve({ data: ESRI });\n" +
      "          return fetch(\"https://tiles.openfreemap.org/styles/liberty\").then(function (r) { return r.json(); }).then(function (j) { return { data: j }; });\n" +
      "        });\n" +
      "      })();\n" +
      "    </script>";
  }

  function transformIndexHtml(src, variant) {
    var html = src;

    if (variant === "maplibre") {
      // engine library swap: vendored MapLibre (+ pmtiles) with the shim BEFORE mapbox-gl-compare
      // loads (the plugin attaches Compare to whatever window.mapboxgl is at that moment)
      html = html.replace(/<script src="https:\/\/api\.mapbox\.com\/mapbox-gl-js\/v[\d.]+\/mapbox-gl\.js"><\/script>/,
        "<script src=\"vendor/maplibre-gl.js\"></script>\n" +
        "    <script src=\"vendor/pmtiles.js\"></script>\n" +
        "    <script>window.mapboxgl = maplibregl; /* standalone copy runs the engine on MapLibre */</script>\n" +
        genProtocolScript());
      // ([^>]|\n)*? keeps each match inside ONE tag — it can't cross a previous tag's closing >
      html = html.replace(/<link(?:[^>]|\n)*?mapbox-gl-js\/v[\d.]+\/mapbox-gl\.css(?:[^>]|\n)*?\/>/,
        "<link href=\"vendor/maplibre-gl.css\" rel=\"stylesheet\" />");
      // draw is an editor tool — the viewer never instantiates it; drop the includes entirely
      html = html.replace(/^[ \t]*<script src="https:\/\/api\.mapbox\.com\/mapbox-gl-js\/plugins\/mapbox-gl-draw\/[^"]*"><\/script>.*$\n?/m, "");
      html = html.replace(/<link(?:[^>]|\n)*?mapbox-gl-draw(?:[^>]|\n)*?\/>\n?/, "");
      // compare rides in the zip too — the copy makes NO requests to api.mapbox.com at all
      html = html.replace(/<script src="https:\/\/api\.mapbox\.com\/mapbox-gl-js\/plugins\/mapbox-gl-compare\/[^"]*"><\/script>/,
        "<script src=\"vendor/mapbox-gl-compare.js\"></script>");
      html = html.replace(/<link(?:[^>]|\n)*?mapbox-gl-compare(?:[^>]|\n)*?\/>/,
        "<link rel=\"stylesheet\" href=\"vendor/mapbox-gl-compare.css\" type=\"text/css\" />");
      // no token file ships in this variant — drop the optional secrets include (it would 404)
      html = html.replace(/^[ \t]*document\.write\('<script src="' \+ _project \+ '\/secrets\/mapbox-token\.js"><\\\/script>'\);.*$\n?/m, "");
    }

    // the zip carries no PWA manifest or icon set — drop those head links (both variants)
    html = html.replace(/^[ \t]*<link rel="manifest"[^>]*\/>\s*$\n?/m, "");
    html = html.replace(/^[ \t]*<link rel="apple-touch-icon"[^>]*\/>\s*$\n?/gm, "");

    // platform scripts: renderRegistry + labels become local project/ copies; the rest (auth, topbar,
    // loaders, init, search, share, pricing, download itself, editing) simply don't exist standalone
    html = html.replace(/^[ \t]*<script src="\.\.\/platform\/renderRegistry\.js[^"]*"[^>]*><\/script>.*$/m,
      "    <script src=\"project/renderRegistry.js\"></script>");
    html = html.replace(/^[ \t]*<script src="\.\.\/platform\/labels\.js[^"]*"[^>]*><\/script>.*$/m,
      "    <script src=\"project/labels.js\"></script>");
    html = html.replace(/^[ \t]*<script src="\.\.\/platform\/[^"]*"[^>]*><\/script>.*$\n?/gm, "");
    html = html.replace(/^[ \t]*<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js@2"><\/script>.*$\n?/gm, "");

    // Google Analytics: the include and the inline gtag bootstrap go away entirely
    html = html.replace(/^[ \t]*<script src="engine\/google-analytics\.js"[^>]*><\/script>.*$\n?/gm, "");
    html = html.replace(/<script>\s*window\.dataLayer=window\.dataLayer\|\|\[\];[\s\S]*?<\/script>/, "");

    // mobile redirect targets mobile.html, which the zip doesn't carry — a self-redirect would loop
    html = html.replace(/^[ \t]*<script src="engine\/handle-mobile-devices\.js"><\/script>.*$\n?/gm, "");

    // standalone layout: no 40px platform top bar; page scroll clamp + swipe-line pin + header stacking
    // (the deltas the platform pages get from platform css/fixes — applied at zip time so /map stays untouched)
    var standaloneCss =
      "\n    <style id=\"ms-standalone-css\">\n" +
      "      /* no platform top bar in a standalone copy — reclaim its 40px in both header states */\n" +
      "      body.ms-no-topbar .map{top:80px;}\n" +
      "      body.ms-no-topbar #studioMenu{top:82px;height:calc(100% - 171px);max-height:calc(100% - 171px);}\n" +
      "      body.ms-no-topbar #rightInfoBar{top:82px;max-height:calc(100% - 190px);}\n" +
      "      body.ms-no-topbar #view-hide-layer-panel{top:88px;}\n" +
      "      body.ms-no-topbar.ms-no-header .map{top:0;}\n" +
      "      body.ms-no-topbar.ms-no-header #studioMenu{top:2px;height:calc(100% - 91px);max-height:calc(100% - 91px);}\n" +
      "      body.ms-no-topbar.ms-no-header #view-hide-layer-panel{top:8px;}\n" +
      "      body.ms-no-topbar.ms-no-header #rightInfoBar{top:2px;max-height:calc(100% - 110px);}\n" +
      "      /* the page itself never scrolls; the swipe line spans the viewport (header/footer paint over its ends) */\n" +
      "      html,body{height:100%;overflow:hidden;}\n" +
      "      .mapboxgl-compare{top:0;bottom:0;height:auto;}\n" +
      "      .header{position:relative;z-index:200;}\n" +
      "      #footer{box-sizing:border-box;}\n" +
      "      /* header-off maps carry the map title + About at the top of the sidebar */\n" +
      "      #sidebar-brand{display:flex;flex-direction:column;align-items:center;text-align:center;gap:5px;padding:12px 12px 15px;border-bottom:2px solid #23374d;margin-bottom:10px;}\n" +
      "      #sidebar-brand .sb-title{font-weight:700;font-size:31px;color:#23374d;line-height:1.2;max-width:100%;}\n" +
      "      #sidebar-brand a#about-info{display:block;font-size:21px;color:#2b6ce8;cursor:pointer;text-decoration:none;}\n" +
      "      #sidebar-brand a#about-info:hover{text-decoration:underline;}\n" +
      "    </style>\n";
    html = html.replace(/<\/head>/, standaloneCss + "  </head>");

    // boot script: topbar class + the static features.header gate (+ sidebar brand for header-off maps)
    var bodyBoot =
      "<script>document.body.classList.add('ms-no-header');</script>\n" +
      "    <script>\n" +
      "      /* MapStructor standalone export — header on/off comes from project/lists/features.js */\n" +
      "      document.body.classList.add('ms-no-topbar');\n" +
      "      (function () {\n" +
      "        if (typeof features !== 'undefined' && features && features.header === true) {\n" +
      "          document.body.classList.remove('ms-no-header');\n" +
      "          return;\n" +
      "        }\n" +
      "        document.addEventListener('DOMContentLoaded', function () {\n" +
      "          var menu = document.getElementById('studioMenu'); if (!menu) return;\n" +
      "          var brand = document.createElement('div'); brand.id = 'sidebar-brand';\n" +
      "          brand.innerHTML = '<div class=\"sb-title\"></div><a id=\"about-info\" class=\"trigger-popup\" title=\"About this map\">About</a>';\n" +
      "          menu.insertBefore(brand, menu.firstChild);\n" +
      "          try { brand.querySelector('.sb-title').textContent = (typeof siteHeaderText !== 'undefined') ? siteHeaderText : ''; } catch (e) {}\n" +
      "          try { brand.querySelector('#about-info').style.display = (window.modal_content_html && window.modal_content_html['about']) ? 'block' : 'none'; } catch (e) {}\n" +
      "        });\n" +
      "      })();\n" +
      "    </script>";
    html = html.replace(/<script>document\.body\.classList\.add\('ms-no-header'\);<\/script>/, bodyBoot);

    // Standalone port of projectLoader's guaranteeBothSides(): setupMapSwitching() setStyle()s each
    // side to its checked basemap right after boot; on split-basemap maps the heavier side can finish
    // out of step and end up WITHOUT the custom layers (platform maps get this patch from
    // projectLoader at runtime — the copy has no projectLoader, so it rides in the page itself).
    var guardScript =
      "    <script>\n" +
      "      /* re-add custom layers to any swipe side that lost them in the boot style race;\n" +
      "         brief retry + re-ensure on every basemap switch (mirror of platform projectLoader) */\n" +
      "      (function () {\n" +
      "        function curMap(n) { try { return n === \"before\" ? (typeof beforeMap !== \"undefined\" ? beforeMap : null) : (typeof afterMap !== \"undefined\" ? afterMap : null); } catch (e) { return null; } }\n" +
      "        function currentDate() {\n" +
      "          try {\n" +
      "            var flat = flatLayers(layers); if (!flat.length) return null;\n" +
      "            var probes = [[curMap(\"before\"), \"left\"], [curMap(\"after\"), \"right\"]];\n" +
      "            for (var i = 0; i < probes.length; i++) {\n" +
      "              var m = probes[i][0], sd = probes[i][1];\n" +
      "              if (m && m.getLayer && m.getLayer(flat[0].id + \"-\" + sd)) { var f = m.getFilter(flat[0].id + \"-\" + sd); if (f && f[1] && f[1][2] != null) return f[1][2]; }\n" +
      "            }\n" +
      "          } catch (e) {}\n" +
      "          try { return parseInt(moment.unix(moment(jQuery(\"#date\").text()).unix()).format(\"YYYYMMDD\")); } catch (e) {}\n" +
      "          return null;\n" +
      "        }\n" +
      "        function ensureSide(map, side) {\n" +
      "          try {\n" +
      "            if (!map || !map.isStyleLoaded || !map.isStyleLoaded()) return false;\n" +
      "            var flat = flatLayers(layers); if (!flat.length) return true;\n" +
      "            if (map.getSource(flat[0].id + \"-\" + side)) return true;\n" +
      "            flat.forEach(function (l) {\n" +
      "              [\"\", \"-highlighted\", \"-stroke\"].forEach(function (suf) { var lid = l.id + suf + \"-\" + side; try { if (map.getLayer(lid)) map.removeLayer(lid); } catch (e) {} });\n" +
      "              try { if (map.getSource(l.id + \"-\" + side)) map.removeSource(l.id + \"-\" + side); } catch (e) {}\n" +
      "            });\n" +
      "            addLayersToMap(map, side, currentDate());\n" +
      "            return !!map.getSource(flat[0].id + \"-\" + side);\n" +
      "          } catch (e) { return false; }\n" +
      "        }\n" +
      "        function both() { return ensureSide(curMap(\"before\"), \"left\") & ensureSide(curMap(\"after\"), \"right\"); }\n" +
      "        var tries = 0, iv = setInterval(function () { tries++; if (both() || tries > 40) clearInterval(iv); }, 500);\n" +
      "        setTimeout(function () {\n" +
      "          try {\n" +
      "            var bm = curMap(\"before\"); if (bm) bm.on(\"style.load\", function () { setTimeout(function () { ensureSide(bm, \"left\"); }, 60); });\n" +
      "            var am = curMap(\"after\"); if (am) am.on(\"style.load\", function () { setTimeout(function () { ensureSide(am, \"right\"); }, 60); });\n" +
      "          } catch (e) {}\n" +
      "        }, 1500);\n" +
      "      })();\n" +
      "    </script>\n";
    html = html.replace(/<\/body>/, guardScript + "  </body>");

    return html;
  }

  /* ── start-map.bat ──────────────────────────────────────────────────────── */

  function genStartBat() {
    return [
      "@echo off",
      "rem MapStructor map — one double-click: serves this folder and opens the map.",
      "rem The map must be served over http:// (not opened as a file) for every layer to load.",
      "rem Port 8801 on purpose — 8000 is often taken by another local server.",
      "cd /d \"%~dp0\"",
      "set \"PY=\"",
      "where py >nul 2>nul && set \"PY=py\"",
      "if not defined PY where python >nul 2>nul && set \"PY=python\"",
      "if not defined PY where python3 >nul 2>nul && set \"PY=python3\"",
      "if not defined PY (",
      "  echo Python was not found. Install it from https://www.python.org/downloads/",
      "  echo ^(check \"Add python.exe to PATH\" during install^), then run this again.",
      "  pause",
      "  exit /b 1",
      ")",
      "start \"\" \"http://localhost:8801/map/index.html\"",
      "echo Serving this folder at http://localhost:8801 — keep this window open while using the map.",
      "echo If the browser opened before the server was ready, just refresh the page.",
      "echo If it says the address is in use, another server owns port 8801 — edit this file to another port.",
      "rem serve-map.py supports byte-range requests (embedded .pmtiles data needs them)",
      "if exist serve-map.py (%PY% serve-map.py 8801) else (%PY% -m http.server 8801)",
      ""
    ].join("\r\n");
  }

  /* ── build ──────────────────────────────────────────────────────────────── */

  function loadJSZip() {
    if (window.JSZip) return Promise.resolve(window.JSZip);
    return new Promise(function (res, rej) {
      var s = document.createElement("script");
      s.src = JSZIP_URL;
      s.onload = function () { window.JSZip ? res(window.JSZip) : rej(new Error("JSZip failed to initialize")); };
      s.onerror = function () { rej(new Error("could not load JSZip")); };
      document.head.appendChild(s);
    });
  }

  function fetchBin(path) {
    return fetch(path, { cache: "no-cache" }).then(function (r) {
      if (!r.ok) throw new Error("fetch " + path + " → " + r.status);
      return r.arrayBuffer();
    });
  }
  function fetchText(path) {
    return fetch(path, { cache: "no-cache" }).then(function (r) {
      if (!r.ok) throw new Error("fetch " + path + " → " + r.status);
      return r.text();
    });
  }

  // make sure every deferred (off-by-default, not-yet-fetched) drawn layer has its features in
  // memory before we freeze the config — the download must carry them, hidden or not
  function hydrateAll() {
    try {
      if (!window.ConfigLoader || !window.supabase || typeof layers === "undefined") return Promise.resolve();
      var db = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
      return Promise.resolve(ConfigLoader.hydrateDeferredFeatures(db, layers, [])).catch(function () {});
    } catch (e) { return Promise.resolve(); }
  }

  function extFromType(ct) {
    if (!ct) return "png";
    if (ct.indexOf("svg") >= 0) return "svg";
    if (ct.indexOf("jpeg") >= 0 || ct.indexOf("jpg") >= 0) return "jpg";
    if (ct.indexOf("gif") >= 0) return "gif";
    if (ct.indexOf("webp") >= 0) return "webp";
    return "png";
  }

  async function buildZip(opts) {
    setStatus("Preparing…");
    var JSZipLib = await loadJSZip();
    await hydrateAll();

    var zip = new JSZipLib();
    var name = projectName();
    var variant = opts.variant || detectVariant();
    var embedById = (variant === "maplibre" && opts.embed) ? collectArchives() : null;

    // 1. engine byte-copies (maplibre: engine.css gains the .maplibregl- selector aliases)
    setStatus("Copying the engine…");
    for (var i = 0; i < ENGINE_FILES.length; i++) {
      if (variant === "maplibre" && ENGINE_FILES[i] === "engine/engine.css") {
        zip.file("map/" + ENGINE_FILES[i], aliasMaplibreCss(await fetchText(ENGINE_FILES[i])));
      } else {
        zip.file("map/" + ENGINE_FILES[i], await fetchBin(ENGINE_FILES[i]));
      }
    }

    // 1b. maplibre variant: the renderer itself rides in the zip (free + version-frozen)
    if (variant === "maplibre") {
      setStatus("Vendoring MapLibre…");
      zip.file("map/vendor/maplibre-gl.js", await fetchBin(MAPLIBRE_JS));
      zip.file("map/vendor/maplibre-gl.css", await fetchBin(MAPLIBRE_CSS));
      zip.file("map/vendor/pmtiles.js", await fetchBin(PMTILES_JS));
      zip.file("map/vendor/mapbox-gl-compare.js", await fetchBin(COMPARE_JS));
      zip.file("map/vendor/mapbox-gl-compare.css", await fetchBin(COMPARE_CSS));
    }

    // 1c. embedded data — the .pmtiles archives themselves (dedup: many layers, one archive)
    if (embedById) {
      var archives = {};
      Object.keys(embedById).forEach(function (id) { archives[embedById[id].name] = embedById[id].url; });
      for (var an in archives) {
        setStatus("Embedding map data (" + an + ".pmtiles)…");
        zip.file("map/data/" + an + ".pmtiles", await fetchBin(archives[an]));
      }
    }

    // 2. platform pieces that ride INSIDE the project folder
    setStatus("Bundling renderers…");
    var rr = await fetchText("../platform/renderRegistry.js");
    rr += "\n\n/* ── standalone appendix (added by the download builder) ─────────────────\n" +
      "   Generated lists are pure data; reattach each layer's panel.render here —\n" +
      "   the same rules configLoader.js applies on the platform. */\n" +
      "(function () {\n" +
      "  function attach(a) {\n" +
      "    (a || []).forEach(function (n) {\n" +
      "      if (n.children) { attach(n.children); return; }\n" +
      "      if (n.panel && !n.panel.render) {\n" +
      "        var r = renderRegistry[n.id] || (n.panel.mode === \"notes\" ? renderRegistry._notes : renderRegistry._default);\n" +
      "        if (r) n.panel.render = r;\n" +
      "      }\n" +
      "    });\n" +
      "  }\n" +
      "  if (typeof layers !== \"undefined\") attach(layers);\n" +
      "})();\n";
    zip.file("map/project/renderRegistry.js", rr);
    var labelsTxt = await fetchText("../platform/labels.js");
    if (variant === "maplibre") {
      // free-style glyph servers carry Noto Sans, not Mapbox's DIN Pro
      labelsTxt = labelsTxt
        .replace("'DIN Pro Bold', 'Arial Unicode MS Bold'", "'Noto Sans Bold'")
        .replace("'DIN Pro Regular', 'Arial Unicode MS Regular'", "'Noto Sans Regular'");
    }
    zip.file("map/project/labels.js", labelsTxt);

    // 3. generated lists — the live config, frozen
    setStatus("Writing the project config…");
    zip.file("map/project/lists/test-project.js", genTestProject());
    zip.file("map/project/lists/header.js", genHeader(name));
    zip.file("map/project/lists/disclaimer.js", genDisclaimer());
    zip.file("map/project/lists/features.js", genFeatures());
    zip.file("map/project/lists/sliderDates.js", genSliderDates());
    zip.file("map/project/lists/layersList.js", genLayersList(embedById));
    zip.file("map/project/lists/modalinfo.js", genModalInfo());
    zip.file("map/project/lists/bounds.js", genBounds());
    zip.file("map/project/lists/mapData.js", genMapData());
    zip.file("map/project/lists/restrictedToken.js", genRestrictedToken(variant));
    // mapbox variant only: the page may be running on a token beyond the committed fallback
    // (dev secrets / owner token) — carry it, or the copy renders nothing the fallback token
    // isn't allowed to serve. The maplibre variant ships NO token anywhere, on principle.
    if (variant !== "maplibre") try {
      var eff = (window.mapboxgl && mapboxgl.accessToken) || "";
      if (eff && eff !== grab(function () { return restrictedToken; }, "")) {
        zip.file("map/project/secrets/mapbox-token.js",
          "/* The token this page was actually running on when downloaded. Loaded INSTEAD of\n" +
          "   lists/restrictedToken.js when present. URL-restricted tokens must allow the domain\n" +
          "   this copy runs on (http://localhost for local runs). */\n" +
          "const mapboxToken = " + JSON.stringify(eff) + ";\n");
      }
    } catch (e) {}

    // 4. the logo → images/ at the zip root (map/index.html references ../images/)
    setStatus("Fetching the logo…");
    var logoEl = document.getElementById("logo-img-wide");
    var logoSrc = (logoEl && logoEl.getAttribute("src")) || DEFAULT_LOGO;
    var faviconHref = DEFAULT_LOGO, logoImgSrc = DEFAULT_LOGO;
    try {
      var lr = await fetch(logoSrc, { cache: "no-cache" });
      if (!lr.ok) throw new Error("logo " + lr.status);
      var isDefault = logoSrc.indexOf("nittygrittymapping_logo.png") >= 0;
      var fname = isDefault ? "nittygrittymapping_logo.png" : ("logo." + extFromType(lr.headers.get("content-type") || ""));
      zip.file("images/" + fname, await lr.arrayBuffer());
      faviconHref = logoImgSrc = "../images/" + fname;
    } catch (e) {
      // unreachable logo (e.g. a cross-origin URL) — leave the copy pointing at it directly
      faviconHref = logoImgSrc = logoSrc;
      console.warn("download: logo not bundled, referencing it in place:", logoSrc, e);
    }

    // 5. the transformed viewer shell
    setStatus("Writing index.html…");
    var html = transformIndexHtml(await fetchText("index.html"), variant);
    html = html.replace(/href="\.\.\/images\/nittygrittymapping_logo\.png"/, "href=\"" + faviconHref + "\"");
    html = html.replace(/src="\.\.\/images\/nittygrittymapping_logo\.png"/, "src=\"" + logoImgSrc + "\"");
    zip.file("map/index.html", html);

    // 6. raw data exports
    if (opts.rawData) {
      setStatus("Exporting layer data…");
      var flat = [];
      (function w(a) { (a || []).forEach(function (n) { flat.push(n); if (n.children) w(n.children); }); })(grab(function () { return layers; }, []));
      flat.forEach(function (n) {
        if (n.outlineOf) return;   // outline twins borrow their parent's features — one export is enough
        var fc = n.source && n.source.type === "geojson" && n.source.data;
        if (fc && fc.features && fc.features.length) {
          zip.file("other_data/" + (n.id || "layer") + ".geojson", JSON.stringify(cleanValue(fc, new WeakSet())));
        }
      });
    }

    // 7. the launcher + its server (python's stock http.server ignores Range — .pmtiles needs 206s)
    zip.file("start-map.bat", genStartBat());
    zip.file("serve-map.py", await fetchText("../platform/serve-map.py"));

    setStatus("Zipping…");
    var blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
    var slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "map";
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = slug + "-download.zip";
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
  }

  /* ── boot ───────────────────────────────────────────────────────────────── */

  function boot() {
    if (injectButton()) return;
    var tries = 0;
    var iv = setInterval(function () { if (injectButton() || ++tries > 50) clearInterval(iv); }, 300);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
