/* projectLoader.js — boots the viewer from a Supabase project (Chunk A).

   map/index.html sets `platformProjectId` from the ?id=<uuid> query param.
   When it is set, the engine skips its three parse-time boot steps — each is
   exposed as a function instead (generateLayersPanel in generateLayers.js,
   generateBaseMapsPanel in generateMaps.js, initMaps in mapinit.js). This
   file fetches the project bundle, synthesizes the engine config through
   ConfigLoader (the exact shape layersList.js would have provided), installs
   it, and runs those same three boot steps. The engine never knows the config
   came from a database.

   The static lists declare their globals with `const`, so they cannot be
   reassigned from another script — instead they are emptied and refilled in
   place, which also keeps every engine reference to the same binding live.

   On any failure (Supabase unreachable, bad id, missing ConfigLoader) the
   static config is booted untouched, so the page still works. */

var PlatformProjectLoader = true;

/* Feature: header on/off. HIDDEN BY DEFAULT — shown only when raw_config.features.header === true.
   Shared by the viewer (applied at boot below) and the editor (Settings → "Show header" calls this
   live). With the header hidden its essentials move to a larger, centered section at the top of the
   sidebar: the logo, the map title, and an About link (About is hidden from visitors when the About
   modal has no content — the editor always shows it so the owner can fill it in). */
window.msApplyHeaderFeature = function (visible, projectName) {
  var css = document.getElementById("ms-noheader-css");
  if (!css) {
    css = document.createElement("style"); css.id = "ms-noheader-css";
    css.textContent =
      "body.ms-no-header .header{display:none;}" +
      "body.ms-no-header .map{top:40px;}" +                                                        // was 120 = 40 top bar + 80 header
      "body.ms-no-header #studioMenu{top:42px;height:calc(100% - 131px);max-height:calc(100% - 131px);}" +
      "body.ms-no-header #view-hide-layer-panel{top:48px;}" +
      "body.ms-no-header #rightInfoBar{top:42px;max-height:calc(100% - 208px);}" +
      // title + About, centered; darker/prominent divider above LAYERS. No logo here — the logo belongs to
      // the header only (maps with a header); the sidebar section is title + About.
      "#sidebar-brand{display:none;flex-direction:column;align-items:center;text-align:center;gap:5px;padding:12px 12px 15px;border-bottom:2px solid #23374d;margin-bottom:10px;}" +
      "body.ms-no-header #sidebar-brand{display:flex;}" +
      "#sidebar-brand .sb-title{font-weight:700;font-size:31px;color:#23374d;line-height:1.2;max-width:100%;cursor:text;outline:none;}" +
      "#sidebar-brand .sb-title:hover{outline:1px dashed #ccc;outline-offset:3px;border-radius:3px;}" +
      "#sidebar-brand .sb-title:focus{outline:2px solid #7c5cbf;outline-offset:3px;border-radius:3px;}" +
      "#sidebar-brand a#about-info{display:block;font-size:21px;color:#2b6ce8;cursor:pointer;text-decoration:none;}" +
      "#sidebar-brand a#about-info:hover{text-decoration:underline;}";
    document.head.appendChild(css);
  }
  var brand = document.getElementById("sidebar-brand");
  if (!brand) {
    brand = document.createElement("div"); brand.id = "sidebar-brand";
    brand.innerHTML = "<div class=\"sb-title\"></div>" +
      "<a id=\"about-info\" class=\"trigger-popup\" title=\"About this map\">About</a>";   // centered column: title, About
    var menu = document.getElementById("studioMenu");
    if (menu) menu.insertBefore(brand, menu.firstChild);
  }
  try {
    var t = projectName || (document.getElementById("header-text-value") || {}).textContent || "";
    brand.querySelector(".sb-title").textContent = t;
  } catch (e) {}
  try { if (window.msMakeSidebarTitleEditable) window.msMakeSidebarTitleEditable(); } catch (e) {}   // editor-only: click the sidebar title to rename (like the header)
  try {   // visitors only see About when it has content; the editor keeps it so the owner can fill it
    var hasAbout = !!(window.modal_content_html && window.modal_content_html["about"]);
    var isEditor = /editor\.html/i.test(location.pathname);
    brand.querySelector("#about-info").style.display = (hasAbout || isEditor) ? "block" : "none";
  } catch (e) {}
  document.body.classList.toggle("ms-no-header", visible === false);
  // custom map buttons render differently per header state (header row vs floating) — re-render on toggle
  try { if (window.msRenderMapButtons) window.msRenderMapButtons(); } catch (e) {}
  setTimeout(function () {   // the map containers changed height — re-measure both swipe sides + re-seat any header-relative chrome (editor tool dock, save callout)
    try { if (typeof beforeMap !== "undefined" && beforeMap) beforeMap.resize(); if (typeof afterMap !== "undefined" && afterMap) afterMap.resize(); } catch (e) {}
    try { window.dispatchEvent(new Event("resize")); } catch (e) {}
  }, 80);
};

(async function () {
  if (typeof platformProjectId === "undefined" || !platformProjectId) return;

  // ── Fail-safe loading pill (7/21): a tiny NON-BLOCKING "Loading map…" chip while the map boots.
  // Designed so it can never get stuck or block anything: pointer-events:none (clicks pass straight
  // through), covers no UI (small, bottom-center), and REMOVES ITSELF unconditionally after 12s even
  // if every hide signal fails. Hides early on the first map 'idle' (tiles painted).
  var msPillGone = false, msPillEl = null;
  function msPillHide() {
    if (msPillGone) return; msPillGone = true;
    try { if (msPillEl) { msPillEl.style.opacity = "0"; setTimeout(function () { try { msPillEl.remove(); } catch (e) {} }, 350); } } catch (e) {}
  }
  try {
    msPillEl = document.createElement("div");
    msPillEl.id = "ms-load-pill";
    // Centered over the MAP AREA (7/21 — bottom placement hid behind the timeline bar). Safe by
    // construction: pointer-events:none (clicks pass through) + the 12s hard-cap removal below.
    msPillEl.setAttribute("style", "position:fixed;left:58%;top:42%;transform:translate(-50%,-50%);z-index:2147483000;pointer-events:none;background:rgba(23,26,33,0.85);color:#fff;padding:11px 20px;border-radius:999px;font:600 14.5px 'Source Sans Pro',Arial,sans-serif;letter-spacing:.2px;box-shadow:0 4px 18px rgba(0,0,0,.35);opacity:1;transition:opacity .3s;display:flex;align-items:center;gap:10px;");
    msPillEl.innerHTML = "<span style=\"width:12px;height:12px;border-radius:50%;border:2.5px solid rgba(255,255,255,.35);border-top-color:#fff;display:inline-block;animation:mspillspin .8s linear infinite;\"></span>Loading map…";
    var msPillKf = document.createElement("style"); msPillKf.textContent = "@keyframes mspillspin{to{transform:rotate(360deg)}}";
    document.head.appendChild(msPillKf);
    document.body.appendChild(msPillEl);
    setTimeout(msPillHide, 12000);   // HARD CAP — the pill cannot outlive this, no matter what breaks   // cliff-ok: the hard cap IS the intent
    var msPillN = 0, msPillT = setInterval(function () {   // the map object exists only later — poll cheaply until the cap
      msPillN++;
      if (msPillGone || msPillN > 40) { clearInterval(msPillT); return; }
      try {
        if (typeof beforeMap !== "undefined" && beforeMap && beforeMap.once) {
          clearInterval(msPillT);
          beforeMap.once("idle", msPillHide);
          if (beforeMap.loaded && beforeMap.loaded()) msPillHide();   // already painted before we attached
        }
      } catch (e) { clearInterval(msPillT); }
    }, 300);
  } catch (ePill) {}

  var SUPABASE_URL = "https://eqpxlwbjqiwfjlsuapvu.supabase.co";
  var SUPABASE_KEY = "sb_publishable_ijLmSmMUeNBrgMGL8Aol4g_S5-xwUzD";

  function replaceArray(target, items) {
    target.length = 0;
    items.forEach(function (item) { target.push(item); });
  }

  function replaceObject(target, source) {
    Object.keys(target).forEach(function (k) { delete target[k]; });
    Object.keys(source).forEach(function (k) { target[k] = source[k]; });
  }

  function showNotPublished() {
    // other features need to know this too — the download builder uses it to explain WHY there is
    // nothing to export instead of just reporting that there isn't
    try { window.__msNotPublished = true; } catch (e) {}
    var d = document.createElement("div");
    d.style.cssText = "position:fixed;top:64px;left:50%;transform:translateX(-50%);z-index:9999;background:#fff;border:1px solid #ddd;border-radius:8px;box-shadow:0 2px 12px rgba(0,0,0,.15);padding:11px 18px;font-family:Source Sans Pro,Arial,sans-serif;font-size:14px;color:#333;";
    d.innerHTML = "This map hasn’t been published yet. <a href=\"" + location.pathname + "?id=" + platformProjectId + "&preview=1" + location.hash + "\" style=\"color:#2d7a2d;font-weight:600;\">Preview the latest edits ↗</a>";
    document.body.appendChild(d);
  }

  // 'private' maps are for the OWNER only — visibility says WHO may see the map at all; publishing says
  // WHICH saved state they see. Resolved from the LIVE project row (never the snapshot, so flipping a map
  // private takes effect immediately). Maps from before the Share panel have no visibility key and resolve
  // to link/public (their actual old behavior); NEW maps are created private. Client-side gate until RLS.
  // ownerId null = we couldn't read the row at all. Since the RLS lockdown (7/30) that is the
  // NORMAL case for a private map seen by a stranger: the row is invisible, so the browser can't
  // tell "private and not yours" from "deleted". Say both, which is also the honest answer — the
  // database deliberately won't reveal which one it is.
  function showPrivateBlock(ownerId) {
    var d = document.createElement("div");
    d.id = "ms-private-block";
    d.style.cssText = "position:fixed;inset:0;z-index:100000;background:#faf9fd;display:flex;align-items:center;justify-content:center;font-family:'Source Sans Pro',Arial,sans-serif;";
    d.innerHTML = "<div style=\"text-align:center;max-width:360px;padding:30px;\">" +
      "<div style=\"font-size:42px;\">🔒</div>" +
      "<h2 style=\"margin:10px 0 6px;color:#1e1b2e;\">" + (ownerId ? "This map is private" : "This map isn’t available") + "</h2>" +
      "<p style=\"color:#6b6680;font-size:14px;margin:0 0 16px;\">" + (ownerId
        ? "Only its owner can view it. If this is your map, log in."
        : "It’s private, or it no longer exists. If it’s yours, log in to open it.") + "</p>" +
      "<button id=\"ms-private-login\" style=\"padding:9px 18px;border:none;border-radius:8px;background:#7c5cbf;color:#fff;font-weight:700;cursor:pointer;font-size:14px;\">Log in</button></div>";
    document.body.appendChild(d);
    var b = document.getElementById("ms-private-login");
    if (b) b.addEventListener("click", function () { try { MapAuth.openAuthModal("login"); } catch (e) {} });
    try { if (window.MapAuth && MapAuth.onChange) MapAuth.onChange(async function () { var u = await MapAuth.currentUser(); if (u && (!ownerId || u.id === ownerId)) location.reload(); }); } catch (e) {}
  }

  try {
    var db = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
    // ── visibility gate (viewer only — the editor page has its own ownership story) ──
    var projectGone = false;   // row confirmed absent → never boot from a lingering R2 snapshot
    if (!/editor\.html/i.test(location.pathname)) {
      try {
        var vg = await db.from("projects").select("user_id, is_public, raw_config").eq("id", platformProjectId).maybeSingle();
        var vrow = vg && vg.data;
        // A19 (8/6): link-visibility maps are no longer readable from the projects TABLE — they
        // come back one-at-a-time through ms_project_by_id, so holding the link still opens the
        // map while `select *` can no longer enumerate every link map on the platform. Falls
        // through silently when the migration isn't applied yet.
        if (!vrow) {
          try {
            var byId = await db.rpc("ms_project_by_id", { p_id: platformProjectId });
            if (!byId.error && byId.data && byId.data.length) vrow = byId.data[0];
          } catch (eById) {}
        }
        if (!vg.error && !vrow) {
          // Before RLS this meant "deleted" and the page just came up empty. Now it also means
          // "private, and you aren't the owner" — so a stranger following a private link used to
          // get a blank map with no explanation. Tell them, and reload if they log in.
          projectGone = true;
          showPrivateBlock(null);
          return;
        }
        if (vrow) {
          var vis = (vrow.raw_config && vrow.raw_config.visibility) || (vrow.is_public ? "public" : "link");
          if (vis === "private") {
            var u0 = null; try { u0 = window.MapAuth ? await MapAuth.currentUser() : null; } catch (e0) {}
            if (!(u0 && vrow.user_id && u0.id === vrow.user_id)) { showPrivateBlock(vrow.user_id); return; }
          }
        }
      } catch (eGate) {}
    }
    // The public viewer shows the PUBLISHED snapshot (project_snapshots, label='published') ONLY; the editor and
    // ?preview always load the LIVE working state. If nothing has been published yet, the viewer must NOT leak
    // unpublished edits — it boots an empty map at the project's view and shows a "not published" notice.
    var live = /editor\.html/i.test(location.pathname) || new URLSearchParams(location.search).has("preview");
    var bundle = null, notPublished = false;
    if (!live) {
      // R2-first (step ②·25, 7/27): publishes mirror the bundle to tiles.mapstructor.com —
      // read that copy before touching Postgres (free egress, no DB compute). Any failure →
      // the project_snapshots query below, exactly as before. no-store: a publish must show
      // on the very next load. Skipped when the project row is confirmed gone (ghost guard —
      // deletes don't clean R2 snapshots yet).
      if (!projectGone) try {
        var rs = await fetch("https://tiles.mapstructor.com/snapshots/" + platformProjectId + ".json", { cache: "no-store" });
        if (rs.ok) { bundle = await rs.json(); window.__msSnapshotSource = "r2"; }
      } catch (eR2) {}
      if (!bundle) try {
        var snap = await db.from("project_snapshots").select("state").eq("project_id", platformProjectId).eq("label", "published").order("created_at", { ascending: false }).limit(1).maybeSingle();
        if (snap.data && snap.data.state) { bundle = snap.data.state; window.__msSnapshotSource = "postgres"; }
      } catch (e) {}
      if (!bundle) {
        notPublished = true;
        try { var pr = await db.from("projects").select("*").eq("id", platformProjectId).maybeSingle(); bundle = { project: pr.data || {}, sections: [], groups: [], projectLayers: [], featuresByLayer: {} }; } catch (e) {}
      }
    }
    if (!bundle) bundle = await ConfigLoader.fetchProjectBundle(db, platformProjectId, { shared: true });   // boot
    var registry = typeof renderRegistry !== "undefined" ? renderRegistry : {};
    var projectLayers = ConfigLoader.synthesize(bundle, registry);

    var project = bundle.project;
    var raw = project.raw_config || {};

    replaceArray(layers, projectLayers);
    if (project.basemap_style != null) mapConfig.style = project.basemap_style;
    if (project.center_lng != null) mapConfig.center = [project.center_lng, project.center_lat];
    if (project.zoom != null) mapConfig.zoom = project.zoom;
    // basemaps: a map's own saved set wins; maps that never customized them get the FREE defaults
    // (Esri satellite / OpenFreeMap streets — no token, no billing) instead of the static Mapbox pair
    if (raw.baseMaps) replaceArray(baseMaps, raw.baseMaps);
    else if (window.ConfigLoader && ConfigLoader.freeBasemapDefaults) replaceArray(baseMaps, ConfigLoader.freeBasemapDefaults());
    // new FREE basemaps become available on EXISTING maps too (unchecked, never overriding a saved
    // set's selections) — e.g. "Clean (no labels)" so data reads with nothing competing
    try {
      if (window.ConfigLoader && ConfigLoader.freeBasemapDefaults) {
        ConfigLoader.freeBasemapDefaults().forEach(function (fb) {
          if (!baseMaps.some(function (b) { return b && (b.id === fb.id || b.name === fb.name); })) {
            baseMaps.push(Object.assign({}, fb, { lChecked: false, rChecked: false }));
          }
        });
      }
    } catch (e) {}
    if (raw.mapSections) replaceArray(mapSections, raw.mapSections);
    if (raw.boundsList) replaceObject(boundsList, raw.boundsList);
    if (raw.zoomButtons) replaceArray(zoomButtons, raw.zoomButtons.map(function (b) {
      // maps saved before 7/8 stored the OLD default button ("Zoom to World") — upgrade exactly that one
      // to the current default ("Zoom to Layers"); renamed/captured/link buttons are the user's, untouched.
      if (b && b.target === "World" && b.label === "Zoom to World" && !b.url && !b.zoomCenter) {
        var nb = { label: "Zoom to Layers", icon: "fa-layer-group", target: "Layers" };
        if (b.section) nb.section = b.section;
        return nb;
      }
      return b;
    }));
    if (raw.mapboxUsername) siteConfig.mapboxUsername = raw.mapboxUsername;
    // Explicit stacking order (8/18). Read BEFORE the maps build so the first paint is already
    // right; MSLayerOrder re-applies on every style.load from mapinit's readdSide.
    if (Array.isArray(raw.layerOrder)) window.__msLayerOrder = raw.layerOrder.slice();
    if (typeof raw.labelsOnTop === 'boolean') window.__msLabelsOnTop = raw.labelsOnTop;
    // Timeline range (raw_config.timeline {start, end|"today"}): the EDITOR applies it via editing.js
    // (applyTimelineRange), but the VIEWER never did — every published map showed the engine's default
    // years. Same math as the editor, retried until the engine's slider exists.
    if (raw.timeline && raw.timeline.start && raw.timeline.end) {
      (function () {
        var tl = raw.timeline;
        function applyTL() {
          try {
            var $ = window.$, m = window.moment; if (!$ || !m || !$("#slider").length) return false;
            var s = m(tl.start).unix(), e = (tl.end === "today") ? m().unix() : m(tl.end).unix();
            if (!s || !e || e <= s) return false;
            var mid = Math.round((s + e) / 2), step = (e - s) / 10;
            try { window.sliderStart = s; window.sliderEnd = e; window.sliderMiddle = mid; } catch (x) {}
            $("#slider").slider("option", { min: s, max: e, value: mid });
            $("#ruler-date1").text(m.unix(s + step).format("YYYY"));
            $("#ruler-date2").text(m.unix(s + step * 3).format("YYYY"));
            $("#ruler-date3").text(m.unix(mid).format("YYYY"));
            $("#ruler-date4").text(m.unix(s + step * 7).format("YYYY"));
            $("#ruler-date5").text(m.unix(s + step * 9).format("YYYY"));
            window.__msDate = mid;
            $("#date").text(m.unix(mid).format("DD MMM YYYY"));
            if (typeof changeDate === "function") changeDate(mid);
            return true;
          } catch (err) { return false; }
        }
        var tries = 0;
        var iv = setInterval(function () {
          if (applyTL()) { clearInterval(iv); return; }
          if (++tries > 25) {
            clearInterval(iv);
            // The map then shows the DEFAULT date range rather than the saved one, and looks fine.
            if (window.MSGuard) MSGuard.cliff("timeline-apply-giveup", tries, 25,
              "the saved timeline range was never applied — the slider was not ready in 10s, so the map is showing its default dates");
          }
        }, 400);
      })();
    }
    // Layer/group ℹ popups + the About modal, saved by the editor's in-place popup editing. The engine only
    // opens a modal when modal_header_text[id] is set — the editor loads these in loadProjectChrome(), but the
    // viewer never did, so saved info modals showed NOTHING in view. Load them here.
    try {
      window.modal_content_html = window.modal_content_html || {};
      window.modal_header_text = window.modal_header_text || {};
      // .trim(): an `about` of only whitespace registered an About modal that opened empty.
      if (raw.about != null && String(raw.about).trim() !== "") { window.modal_header_text["about"] = "About"; window.modal_content_html["about"] = raw.about; }
      Object.keys(raw.popups || {}).forEach(function (id) {
        var p = raw.popups[id];
        var h = (p && typeof p === "object") ? p.html : p;
        var ti = (p && typeof p === "object") ? p.title : "Info";
        window.modal_content_html[id] = h || "";
        window.modal_header_text[id] = ti || "Info";
      });
    } catch (e) {}
    // header chrome for the VIEWER: map name + a custom header logo/link (the editor sets these live via applyHeaderChrome;
    // the viewer doesn't load editing.js, so apply them here). Default logo (MapStructor) is the HTML default.
    // On a timeout to land after the engine's own header init (index.js).
    setTimeout(function () {
      try {
        var hv = document.getElementById("header-text-value"); if (hv && project.name) hv.textContent = project.name;
        var li = document.getElementById("logo-img-wide"); if (li && raw.headerLogo) li.src = raw.headerLogo;
        var ll = document.getElementById("logo-link"); if (ll && raw.headerLink != null) ll.setAttribute("href", raw.headerLink);
        // #16/#17: the VIEWER adds an owner-only "✎ Edit" link to the site-wide top bar; the generic
        // username chip comes from topbar.js itself. Public / logged-out visitors just see the bar.
        if (window.MapAuth && !document.getElementById("editor-publish-btn")) {
          var wireEdit = function () {
            var right = document.getElementById("ms-topbar-right");
            if (!right) return false;
            var refresh = async function () {
              var u = await MapAuth.currentUser();
              var own = MapAuth.isReal(u) && project && project.user_id && u.id === project.user_id;
              var l = document.getElementById("viewer-edit-link");
              if (own && !l) {
                l = document.createElement("a");
                l.id = "viewer-edit-link"; l.href = "editor.html" + location.search; l.title = "Edit this map";
                l.innerHTML = "&#9998; Edit";
                l.style.cssText = "padding:3px 10px;border:1px solid #ccc;border-radius:5px;background:#fff;color:#222;font-weight:600;";
                right.insertBefore(l, right.firstChild);
              } else if (!own && l) l.remove();
            };
            refresh();
            try { MapAuth.onChange(refresh); } catch (e2) {}
            return true;
          };
          if (!wireEdit()) { var _wet = 0, _wiv = setInterval(function () { if (wireEdit() || ++_wet > 25) clearInterval(_wiv); }, 300); }
        }
      } catch (e) {}
    }, 400);
    // Custom top-right map buttons (8/27): onto the GLOBAL mapConfig, which is also what the export
    // freezes — so publishing carries them to the standalone copy with no export-side code.
    try {
      if (typeof mapConfig !== "undefined") mapConfig.customButtons = raw.customButtons || [];
      if (window.msRenderMapButtons) window.msRenderMapButtons();
    } catch (e) {}
    // Feature: header is HIDDEN BY DEFAULT (the map pages set body.ms-no-header at parse so there's no
    // flash of the header on load). Resolve the real state NOW — header-on maps flip the moment the config
    // is known (not a late timeout), header-off maps just build the sidebar brand and stay hidden.
    try { msApplyHeaderFeature(!!(raw.features && raw.features.header === true), project.name); } catch (e) {}
    if (notPublished) showNotPublished();
  } catch (e) {
    console.warn("Platform project load failed — booting the static config:", e);
  }

  // ── basemap style resolution. NOTE (7/15): mapbox-gl-js v3 will NOT paint ANY tiles — even free
  // non-Mapbox basemaps — without a valid access token (it downloads them but renders blank white).
  // So we must NOT empty the token here (doing so whited out every free-basemap map). The token
  // stays as mapinit set it (restrictedToken / admin token). We DO still steer a legacy mapbox://
  // initial style to the checked FREE basemap, so free-basemap maps use free tiles (less Mapbox
  // usage) while keeping the token present for the license/paint. Real zero-token = MapLibre (B-track).
  try {
    if (typeof mapConfig.style === "string" && mapConfig.style.indexOf("mapbox://") === 0) {
      var lb = baseMaps.filter(function (b) { return b.lChecked && b.styleUrl; })[0];
      if (lb) mapConfig.style = lb.styleUrl;
    }
  } catch (eTok) {}

  // ── pmt service worker: serves auto-converted layers' tiles ("pmt/<pid>/<lid>/{z}/{x}/{y}.pbf")
  // straight from their .pmtiles archives in storage — no server anywhere. Registered only when
  // the map actually has such a layer; boot waits briefly so the first tile requests are caught.
  try {
    var msNeedsPmtSw = (function chk(a) {
      return (a || []).some(function (n) {
        if (n.children) return chk(n.children);
        var t = n.source && n.source.tiles && n.source.tiles[0];
        return !!(t && /\/pmt\//.test(String(t)));
      });
    })(layers);
    if (msNeedsPmtSw && "serviceWorker" in navigator) {
      var swReady = navigator.serviceWorker.register("pmt-sw.js").then(function () {
        return navigator.serviceWorker.ready;
      }).then(function () {
        // a just-installed worker doesn't control this page yet (first visit) — claim() in the
        // worker + a short settle beat cover it without a reload
        return new Promise(function (res) { setTimeout(res, 150); });
      });
      await Promise.race([swReady, new Promise(function (res) { setTimeout(res, 3000); })]);   // cliff-ok: losing the service worker costs caching, never correctness
      // ── HARD REFRESH LEAVES THE WORKER BYPASSED (8/7) ──────────────────────────────────
      // Ctrl+Shift+R loads the page with service-worker bypass for the page's WHOLE LIFETIME:
      // registration succeeds, `ready` resolves, claim() runs — and controller stays null, so
      // every pmt/ tile request goes to the raw file server and 404s. The map then draws every
      // layer EXCEPT the tiled ones, silently ("vectors not even appearing", owner 8/7 — after
      // being told to hard-refresh for the cache-buster, so we caused the very state we're
      // healing). Measured: normal load tile=200/590 features rendered; bypassed load tile=404/0.
      // One ordinary reload restores control, so do it ourselves, once, before anything renders.
      // The sessionStorage guard stops a loop where control never arrives (private mode, SW off):
      // in that case fall through and render what we can rather than reload forever.
      try {
        if (!navigator.serviceWorker.controller) {
          if (!sessionStorage.getItem("ms-sw-heal")) {
            sessionStorage.setItem("ms-sw-heal", "1");
            location.reload();
            await new Promise(function () {});   // stop boot — the reload owns this page now
          } else {
            console.warn("MapStructor: service worker not controlling this page — tiled layers may be blank this load.");
          }
        } else {
          sessionStorage.removeItem("ms-sw-heal");
        }
      } catch (eHeal) {}
    }
  } catch (eSw) {}

  // ── editing-only layers (7/21): raw_config.editorOnly → visible ONLY in the editor. Strip them from
  // the tree in VIEW mode before the panel renders — viewer, preview, and downloaded copies all boot
  // through here, so this one gate covers them all. The editor keeps them (and badges them in the sidebar).
  if (!/editor\.html/i.test(location.pathname)) {
    try {
      (function stripEO(arr) {
        for (var i = (arr || []).length - 1; i >= 0; i--) {
          var n = arr[i];
          if (n.children) {
            var had = n.children.length;
            stripEO(n.children);
            // a group/section whose layers were ALL editing-only strips with them (7/21 group support);
            // containers that were empty to begin with stay (the owner made them empty on purpose)
            if (had > 0 && n.children.length === 0) arr.splice(i, 1);
          }
          else if (n.editorOnly) arr.splice(i, 1);
        }
      })(layers);
    } catch (eEO) {}
  }

  generateLayersPanel();
  generateBaseMapsPanel();
  initMaps();

  // deferred: off-by-default drawn layers fetch their features AFTER the visible map is up (fast first
  // paint); they're hidden, so filling their sources late is invisible — but toggling them on just works.
  function deferredMaps() { return [typeof beforeMap !== "undefined" ? beforeMap : null, typeof afterMap !== "undefined" ? afterMap : null]; }
  /* WAIT FOR THE MAP TO GO QUIET FIRST (8/21). This fired at a flat 1,000 ms — which on a map with
     many large hidden layers lands exactly when the person is first looking at it and clicking
     things. Measured on the Ames State Map: five of these fetches at 11.2s, 10.9s, 9.7s, 7.1s and
     5.7s, every one of them pulling whole geometries for a layer that is switched OFF, ~45 seconds
     of request time competing with everything the person does.
     The sweep is still worth doing — its point is that toggling a hidden layer later is instant —
     but nothing about it is urgent, and the priority path below already covers the case where
     someone toggles one before the sweep reaches it. So: after the map's first idle, plus a
     breath. `once("idle")` fires when tiles have finished painting; the timeout is the belt for a
     map that never idles. */
  /* …AND ON THE EDITOR, ONLY WHAT editing.js DOES NOT OWN. `loadFeatures` splits drawn layers into
     onIds/offIds and loads both, so this sweep was fetching the same whole geometries a second
     time — each hidden layer appeared TWICE in the network log (configLoader "…content_id,
     image_url, custom_fields" vs editing.js "…content_id, custom_fields, image_url"), 11.0s and
     10.5s for one layer alone on the Ames State Map.
     Skipping the whole page was too broad, and it broke something: `_hydrateOne` returns
     immediately for any layer past MAX_DRAW (1500) — "large layers render via the ENGINE" — so
     editing.js loads the SMALL hidden layers and nothing loaded the large ones. A 1,600-feature
     layer that starts OFF then went `visibility: visible` over an EMPTY source, forever, until a
     reload. Caught 8/21 by late-layer-click-gate, which is the whole reason it exists.
     So: skip what editing.js publishes as its own (`window.__msDrawOwned`), sweep the rest. If the
     classification has not happened yet, wait for it rather than sweeping everything — an empty
     owned-set would silently restore the double fetch. */
  var IS_EDITOR = /editor\.html/i.test(location.pathname);
  function editorOwns(n) { var o = window.__msDrawOwned; return !!(o && n && o[n.id]); }
  var _sweepStarted = false;
  function startDeferredSweep() {
    if (_sweepStarted) return;
    _sweepStarted = true;
    runDeferredSweep(0);
  }
  function runDeferredSweep(attempt) {
    // cliff-ok: waiting for editing.js to classify, up to ~20s. Falling through instead of waiting
    // would sweep with an EMPTY owned-set, i.e. fetch every small layer a second time — the exact
    // regression this guard exists to prevent. After 10 tries something is wrong enough that one
    // duplicate sweep is better than a hidden layer that never loads.
    if (IS_EDITOR && !window.__msDrawOwned && attempt < 10) {
      setTimeout(function () { runDeferredSweep(attempt + 1); }, 2000); return;
    }
    try { ConfigLoader.hydrateDeferredFeatures(db, layers, deferredMaps(), IS_EDITOR ? editorOwns : null); } catch (e) {}
  }
  // cliff-ok: both waits below are deliberate and invisible by construction — the layers they load
  // are switched OFF, so nothing on screen is waiting for them. See the note above for why they are
  // not urgent. Restored 8/21 after a rewrite of that comment dropped the original marker.
  setTimeout(function () {
    var m0 = (typeof beforeMap !== "undefined") ? beforeMap : null;
    if (m0 && m0.once) { m0.once("idle", function () { setTimeout(startDeferredSweep, 2500); }); }   // cliff-ok: a breath after first idle; the layers are hidden, nothing waits on them
    setTimeout(startDeferredSweep, 12000);   // cliff-ok: never later than this, idle or not — the belt for a map that never idles
  }, 1000);
  // Toggling a still-deferred layer ON fetches ITS rows immediately (priority) instead of waiting for the
  // background sweep — small layers used to sit invisible behind the sweep's megabytes of polygon data,
  // so the checkbox felt dead. The row dims while its data is in flight. Editor page excluded: editing.js
  // hydrates per-layer into MapboxDraw itself (its small drawn layers' engine copies stay hidden there).
  if (!/editor\.html/i.test(location.pathname)) document.addEventListener("change", function (e) {
    try {
      var cb = e.target;
      if (!cb || cb.type !== "checkbox" || !cb.checked || !cb.closest("#studioMenu")) return;
      var flat = [];
      (function w(a) { (a || []).forEach(function (n) { flat.push(n); if (n.children) w(n.children); }); })(layers);
      var node = null;
      for (var i = 0; i < flat.length; i++) if (flat[i].id === cb.id) { node = flat[i]; break; }
      if (!node) return;
      var todo = node._deferred ? [node] : [];
      // a group/section checkbox cascades to children via prop('checked') — no change events fire for them
      (function kids(n) { (n.children || []).forEach(function (c) { if (c._deferred) todo.push(c); kids(c); }); })(node);
      todo.forEach(function (n) {
        var row = (n === node) ? cb.closest(".layer-list-row") : null;
        if (row) { row.style.transition = "opacity .2s"; row.style.opacity = "0.55"; }
        ConfigLoader.hydrateDeferredLayer(db, n, deferredMaps()).then(function () { if (row) row.style.opacity = ""; }, function () { if (row) row.style.opacity = ""; });
      });
    } catch (e2) {}
  });

  // ── Guarantee the drawn layers land on BOTH swipe maps ──
  // setupMapSwitching() (mapinit.js) setStyle()s each side to its basemap right after registering the
  // style.load re-add; on a split-basemap project the heavier side (e.g. satellite) can finish loading
  // out of step and that side ends up WITHOUT the drawn layers — the public viewer showed features only
  // on one side (the editor mirrors them, so it looked fine there). Re-add to any side that's missing
  // them, on a short retry and on every subsequent basemap switch. Idempotent: skips a side already set.
  (function guaranteeBothSides() {
    function curMap(n) { try { return n === "before" ? (typeof beforeMap !== "undefined" ? beforeMap : null) : (typeof afterMap !== "undefined" ? afterMap : null); } catch (e) { return null; } }
    function currentDate() {
      try {
        var flat = flatLayers(layers); if (!flat.length) return null;
        var probes = [[curMap("before"), "left"], [curMap("after"), "right"]];
        for (var i = 0; i < probes.length; i++) {
          var m = probes[i][0], sd = probes[i][1];
          if (m && m.getLayer && m.getLayer(flat[0].id + "-" + sd)) { var f = m.getFilter(flat[0].id + "-" + sd); if (f && f[1] && f[1][2] != null) return f[1][2]; }
        }
      } catch (e) {}
      return null;
    }
    function ensureSide(map, side) {
      try {
        if (!map || !map.isStyleLoaded || !map.isStyleLoaded()) return false;
        var flat = flatLayers(layers); if (!flat.length) return true;
        if (map.getSource(flat[0].id + "-" + side)) return true;   // already present
        flat.forEach(function (l) {   // clear any partial remnants, then add fresh
          ["", "-highlighted", "-stroke"].forEach(function (suf) { var lid = l.id + suf + "-" + side; try { if (map.getLayer(lid)) map.removeLayer(lid); } catch (e) {} });
          try { if (map.getSource(l.id + "-" + side)) map.removeSource(l.id + "-" + side); } catch (e) {}
        });
        addLayersToMap(map, side, currentDate());
        return !!map.getSource(flat[0].id + "-" + side);
      } catch (e) { return false; }
    }
    function both() { return ensureSide(curMap("before"), "left") & ensureSide(curMap("after"), "right"); }
    var tries = 0, iv = setInterval(function () {
      tries++;
      if (both()) { clearInterval(iv); return; }
      if (tries > 40) {
        clearInterval(iv);
        // 20s without both sides ready: the swipe comparison has a side with no data on it.
        if (window.MSGuard) MSGuard.cliff("swipe-sources-giveup", tries, 40,
          "one side of the swipe comparison never got its sources — that side of the map is empty");
      }
    }, 500);
    setTimeout(function () {   // re-ensure after user basemap switches (setStyle wipes custom layers)
      try {
        var bm = curMap("before"); if (bm) bm.on("style.load", function () { setTimeout(function () { ensureSide(bm, "left"); }, 60); });
        var am = curMap("after"); if (am) am.on("style.load", function () { setTimeout(function () { ensureSide(am, "right"); }, 60); });
      } catch (e) {}
    }, 1500);
  })();
})();
