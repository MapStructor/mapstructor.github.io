function generateMapHTML(map, idx) {
  return `
    <div class="layer-list-row" data-map-idx="${idx == null ? '' : idx}">
      <input class="${map.id}" type="radio" name="ltoggle" value="${map.id}" ${map.lChecked ? 'checked="checked"' : ''}/>
      <input class="${map.id}" type="radio" name="rtoggle" value="${map.id}" ${map.rChecked ? 'checked="checked"' : ''}/>
      &nbsp;
      <label for="${map.id}">${map.name}<div class="dummy-label-layer-space"></div></label>
      <div class="layer-buttons-block">
        <div class="layer-buttons-list">
          ${map.zoomFunction ? `<i class="fa fa-crosshairs zoom-to-layer" onclick="${map.zoomFunction}" title="Zoom to Layer"></i>` : ''}
          ${map.infoId ? `<i class="fa fa-info-circle layer-info trigger-popup" id="${map.infoId}" title="Layer Info"></i>` : ''}
          ${msBasemapInfoFor(map) ? `<i class="fa fa-info-circle layer-info map-info-btn" data-mapinfo-idx="${idx}" title="About this basemap" style="cursor:pointer;"></i>` : ''}
        </div>
      </div>
    </div>
  `;
}

function generateBaseMapsPanel() {
  var secs = (typeof mapSections !== 'undefined' && mapSections) ? mapSections : [];
  var btns = (typeof zoomButtons !== 'undefined' && zoomButtons) ? zoomButtons : [];
  var escMs = function (s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); };
  var mapsFor = function (test) { return baseMaps.map(function (m, i) { return test(m) ? generateMapHTML(m, i) : ''; }).join(''); };
  var btnsFor = function (test) { return btns.map(function (b, i) { return test(b) ? generateZoomButtonHTML(b, i) : ''; }).join(''); };
  var top = function (x) { return !x.section || !secs.some(function (s) { return s.id === x.section; }); };
  var html = mapsFor(top) + btnsFor(top);
  secs.forEach(function (s) {
    html += '<p class="title map-section-title" data-mapsection="' + escMs(s.id) + '">' + escMs(s.name) + '</p>';
    html += mapsFor(function (m) { return m.section === s.id; }) + btnsFor(function (b) { return b.section === s.id; });
  });
  document.getElementById('base-maps-section').innerHTML = html;
  var zb = document.getElementById('zoom-buttons-section'); if (zb) zb.innerHTML = '';
}

// Match the ORIGINAL zoom-button look exactly (centered .zoom-labels button, icon + bold label, nbsp padding) —
// only wrapped in a div for editability (data-zbtn-idx) + the original <br><br> spacing as a margin.
function generateZoomButtonHTML(btn, idx) {
  return '<div class="zoom-btn-row" data-zbtn-idx="' + idx + '" style="position:relative;text-align:center;margin:16px 0;"><center>' +
    '<button onclick="mapstructorZoomButton(' + idx + ')" class="zoom-labels">' +
    '&nbsp; &nbsp; <i class="fa ' + (btn.icon || '') + '"></i> &nbsp; <b>' + (btn.label == null ? '' : btn.label) + '</b> &nbsp; &nbsp; &nbsp;' +
    '</button></center></div>';
}

// ── Basemap info (9/1, owner: "Add info buttons, with sources.") ──
// Every basemap row can carry an ℹ. Its text comes from the entry's own `info` (edited in the
// editor's Edit-map panel, saved into raw_config.baseMaps) or, for the four free defaults, from
// this built-in table — so every existing map shows sourced write-ups with no config surgery.
// ENGINE-level deliberately: editor, viewer and exported copies render the same ℹ from one place.
var MS_BASEMAP_INFO = {
  "free-satellite": "Esri World Imagery — satellite and aerial photography assembled from many providers (Maxar, Earthstar Geographics, USDA, USGS and others). No labels; imagery dates vary by area.\nSource: Esri ArcGIS Online (World_Imagery) — arcgis.com",
  "free-streets": "OpenFreeMap “Liberty” — a full street map rendered from OpenStreetMap, the collaborative world map maintained by millions of contributors.\nSources: openfreemap.org · openstreetmap.org — © OpenStreetMap contributors",
  "free-clean": "Esri Light Gray Canvas — a quiet, label-free base designed to put your own data in front. Detail fades past zoom 16.\nSources: Esri ArcGIS Online (World_Light_Gray_Base), with OpenStreetMap and other community data — arcgis.com",
  "free-terrain": "OpenTopoMap — a topographic map with contour lines and hillshading, rendered from OpenStreetMap data and SRTM elevation.\nSources: opentopomap.org · openstreetmap.org — © OpenStreetMap contributors; elevation: SRTM"
};
try { window.MS_BASEMAP_INFO = MS_BASEMAP_INFO; } catch (e) {}

function msBasemapInfoFor(m) { return (m && (m.info || MS_BASEMAP_INFO[m.id])) || ""; }

function msShowBasemapInfo(idx, anchor) {
  var m = (typeof baseMaps !== "undefined" && baseMaps) ? baseMaps[idx] : null;
  var text = msBasemapInfoFor(m); if (!text) return;
  var old = document.getElementById("ms-basemap-info"); if (old) old.remove();
  var pop = document.createElement("div");
  pop.id = "ms-basemap-info";   // z 6340 = the info tier's overlay band (info always over edit chrome)
  pop.style.cssText = "position:fixed;z-index:6340;max-width:320px;background:#ffffff;border:1px solid #bbbbbb;border-radius:8px;box-shadow:0 4px 18px rgba(0,0,0,0.25);padding:12px 14px;font:13px/1.5 'Source Sans Pro',Arial,sans-serif;color:#333333;";
  var head = document.createElement("div");
  head.style.cssText = "display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;gap:10px;";
  var ttl = document.createElement("b"); ttl.textContent = (m.name || m.id || "Basemap"); head.appendChild(ttl);
  var x = document.createElement("span"); x.textContent = "×";
  x.style.cssText = "cursor:pointer;color:#888888;font-size:16px;line-height:1;";
  x.addEventListener("click", function () { pop.remove(); });
  head.appendChild(x); pop.appendChild(head);
  // info is USER text (per-map, editable) — built with textContent only; bare domains/URLs
  // become safe links so the sources are one click away
  String(text).split(/\n/).forEach(function (line) {
    var p = document.createElement("div");
    if (line === "") { p.style.height = "6px"; pop.appendChild(p); return; }
    line.split(/(\bhttps?:\/\/[^\s]+|\b[a-z0-9][a-z0-9-]*\.(?:org|com|net)\b[^\s,)]*)/i).forEach(function (part, i) {
      if (!part) return;
      if (i % 2) {
        var a = document.createElement("a");
        a.href = /^https?:/i.test(part) ? part : "https://" + part;
        a.target = "_blank"; a.rel = "noopener"; a.textContent = part; a.style.color = "#5b458f";
        p.appendChild(a);
      } else p.appendChild(document.createTextNode(part));
    });
    pop.appendChild(p);
  });
  document.body.appendChild(pop);
  var r = anchor.getBoundingClientRect();
  var top = Math.min(r.top, window.innerHeight - pop.offsetHeight - 12);
  var left = Math.min(r.right + 8, window.innerWidth - pop.offsetWidth - 12);
  pop.style.top = Math.max(8, top) + "px"; pop.style.left = Math.max(8, left) + "px";
}
// One delegated listener (capture, so the editor's row-click can't swallow the ℹ), wired once —
// generateBaseMapsPanel rebuilds the rows' innerHTML freely without re-wiring anything.
(function msWireBasemapInfo() {
  if (window.__msBasemapInfoWired) return; window.__msBasemapInfoWired = true;
  document.addEventListener("click", function (ev) {
    var btn = ev.target && ev.target.closest ? ev.target.closest(".map-info-btn") : null;
    if (btn) {
      ev.stopPropagation(); ev.preventDefault();
      msShowBasemapInfo(+btn.getAttribute("data-mapinfo-idx"), btn);
      return;
    }
    var pop = document.getElementById("ms-basemap-info");
    if (pop && !pop.contains(ev.target)) pop.remove();
  }, true);
})();

// ── Custom map buttons (8/27, owner: "I need to add a button for the encyclopedia that opens in a
// separate tab"). mapConfig.customButtons = [{label, url}] renders as pill buttons in the map's
// upper-right, each opening its URL in a new tab. This lives in the ENGINE deliberately: the editor,
// the viewer and the exported standalone copy all render the same buttons from one implementation —
// the export freezes mapConfig, so the copy inherits them with no export-side code at all.
// Body-level FIXED, not inside a map container: the swipe compare plugin clips each map's container
// at the divider, so anything mounted inside one is sliced in half (the master-tool-panel lesson).
// Idempotent — projectLoader and the settings panel call it again whenever the list changes.
function msRenderMapButtons() {
  var old = document.getElementById('ms-map-buttons'); if (old) old.remove();
  document.querySelectorAll('.ms-custom-mapbtn').forEach(function (e) { e.remove(); });
  var btns = (typeof mapConfig !== 'undefined' && mapConfig && mapConfig.customButtons) || [];
  btns = btns.filter(function (b) { return b && b.label && b.url; });
  if (!btns.length) return;
  /* HEADER VISIBLE → these are header buttons, full stop (8/27, owner: "needs to have same styling
     as About button" — v1 floated its own pill over the header and sat ON the About button). The
     About button is a `.header-btn` in #header-right-buttons; a custom button becomes the exact
     same thing in the exact same row, so it can never collide with or diverge from it. */
  var headerRow = document.getElementById('header-right-buttons');
  var headerVisible = headerRow && !document.body.classList.contains('ms-no-header');
  if (headerVisible) {
    btns.forEach(function (b) {
      var a = document.createElement('a');
      a.className = 'header-btn ms-custom-mapbtn';
      a.href = b.url; a.target = '_blank'; a.rel = 'noopener'; a.title = b.url;
      a.textContent = b.label + ' ↗';
      headerRow.insertBefore(a, headerRow.firstChild);   // custom buttons first, About keeps the end
    });
    return;
  }
  // header hidden → float over the map's upper-right, wearing the SAME header-btn look
  // (body-level fixed: the swipe compare plugin clips each map container at the divider)
  var wrap = document.createElement('div');
  wrap.id = 'ms-map-buttons';
  var top = document.getElementById('ms-topbar') ? 52 : 12;   // clear the site-wide top bar when present
  wrap.style.cssText = 'position:fixed;top:' + top + 'px;right:14px;z-index:1100;display:flex;gap:6px;';
  btns.forEach(function (b) {
    var a = document.createElement('a');
    a.href = b.url; a.target = '_blank'; a.rel = 'noopener'; a.title = b.url;
    a.textContent = b.label + ' ↗';
    // .header-btn's own recipe, inlined (the class's float/margins assume the header row)
    a.style.cssText = 'display:inline-block;color:black;text-align:center;padding:10px;text-decoration:none;' +
      'font-size:15px;line-height:25px;border-radius:4px;border:solid black;font-weight:bold;' +
      'font-family:Arial;background:rgba(255,255,255,0.95);cursor:pointer;';
    wrap.appendChild(a);
  });
  document.body.appendChild(wrap);
}
try { window.msRenderMapButtons = msRenderMapButtons; } catch (e) {}
// at boot: static copies carry customButtons inline in mapData.js; platform pages re-call after config load
try { setTimeout(msRenderMapButtons, 300); } catch (e) {}   // cliff-ok: a beat for the topbar to mount; re-called on config load anyway

// Combined bounds of the map's VISIBLE (checked) layers: geojson layers from their own feature data,
// vector tilesets from their tilejson bounds; in the editor, small drawn layers live in MapboxDraw
// (window._msDraw — optional, editor-only). Every source is individually guarded, so a missing piece
// just contributes nothing. Returns [minX, minY, maxX, maxY] or null (caller falls back to the default view).
function mapstructorLayersBounds() {
  var bb = null;
  function extend(b) {
    if (!b || b.length !== 4 || !isFinite(b[0]) || !isFinite(b[1]) || !isFinite(b[2]) || !isFinite(b[3])) return;
    if (!bb) bb = b.slice();
    else { bb[0] = Math.min(bb[0], b[0]); bb[1] = Math.min(bb[1], b[1]); bb[2] = Math.max(bb[2], b[2]); bb[3] = Math.max(bb[3], b[3]); }
  }
  try {
    (function walk(arr) {
      (arr || []).forEach(function (n) {
        try {
          if (n.children) { walk(n.children); return; }
          var cb = document.getElementById(n.toggleElement || n.id);
          if (cb ? !cb.checked : n.checked === false) return;   // only layers currently toggled ON
          if (n.source && n.source.type === 'geojson' && n.source.data && n.source.data.features && n.source.data.features.length) {
            if (typeof turf !== 'undefined') extend(turf.bbox(n.source.data));
          } else if (typeof beforeMap !== 'undefined' && beforeMap && beforeMap.getSource) {
            var s = beforeMap.getSource(n.id + '-left'); if (s && s.bounds) extend(s.bounds);   // tilesets: tilejson bounds
          }
        } catch (e) {}
      });
    })(typeof layers !== 'undefined' ? layers : []);
  } catch (e) {}
  try { if (window._msDraw && window._msDraw.getAll && typeof turf !== 'undefined') { var fc = window._msDraw.getAll(); if (fc.features.length) extend(turf.bbox(fc)); } } catch (e) {}
  return bb;
}

// A zoom button opens a URL in a new tab, flies to a captured view, zooms to the visible layers'
// combined extent (target "Layers" — falls back to the default view when there's nothing to measure),
// or (legacy) zooms to a bounds key.
function mapstructorZoomButton(idx) {
  var b = (typeof zoomButtons !== 'undefined') ? zoomButtons[idx] : null; if (!b) return;
  if (b.url) { window.open(b.url, '_blank'); return; }
  if (b.zoomCenter && typeof beforeMap !== 'undefined' && beforeMap) {
    beforeMap.flyTo({ center: b.zoomCenter, zoom: b.zoomLevel != null ? b.zoomLevel : beforeMap.getZoom(), bearing: 0 });
    if (typeof afterMap !== 'undefined' && afterMap) afterMap.flyTo({ center: b.zoomCenter, zoom: b.zoomLevel != null ? b.zoomLevel : afterMap.getZoom(), bearing: 0 });
    return;
  }
  if (b.target === 'Layers') {
    (function attempt(n) {
      var bb = mapstructorLayersBounds();
      // sources are still loading for the first seconds after boot (tilejson bounds, deferred
      // features) — retry briefly before falling back to the default view
      if (!bb && n < 15) { setTimeout(function () { attempt(n + 1); }, 300); return; }
      [typeof beforeMap !== 'undefined' ? beforeMap : null, typeof afterMap !== 'undefined' ? afterMap : null].forEach(function (m) {
        if (!m) return;
        try {
          if (bb) m.fitBounds([[bb[0], bb[1]], [bb[2], bb[3]]], { padding: 60, maxZoom: 16, bearing: 0 });
          else if (typeof mapConfig !== 'undefined') m.flyTo({ center: mapConfig.center, zoom: mapConfig.zoom, bearing: 0 });   // nothing drawn/visible yet → the default area
        } catch (e) {}
      });
    })(0);
    return;
  }
  if (b.target && typeof zoomtobounds === 'function') zoomtobounds(b.target);
}

// Platform projects (?id=<uuid>) load their config asynchronously;
// platform/projectLoader.js calls generateBaseMapsPanel() once it arrives.
if (typeof platformProjectId === 'undefined' || !platformProjectId) generateBaseMapsPanel();

// A basemap entry may carry `styleUrl` — a full style: an https URL or an inline style object
// (free basemaps: Esri satellite / OpenFreeMap). Entries without one resolve from their id —
// widened 9/1 (owner: "It should allow things more widely"), so a map's basemap needs no Mapbox
// account at all:
//   https://…/style.json          → used directly (OpenFreeMap, MapTiler, any hosted style)
//   https://…/{z}/{x}/{y}.png     → wrapped as a raster style, WITH the free glyph server injected
//                                    so map labels render on it (labels are never tied to a basemap)
//   mapbox://styles/user/id       → used directly (token required)
//   anything else                 → classic mapbox://styles/<site user>/<id> (token required)
function basemapStyle(id) {
  try {
    var maps = (typeof baseMaps !== "undefined" && baseMaps) ? baseMaps : [];
    for (var i = 0; i < maps.length; i++) {
      if (maps[i].id === id && maps[i].styleUrl) return maps[i].styleUrl;
    }
  } catch (e) {}
  if (/^https?:\/\//i.test(id)) {
    if (id.indexOf("{z}") !== -1) {
      return {
        version: 8,
        name: "Custom tiles",
        glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
        sources: { custom: { type: "raster", tileSize: 256, tiles: [id] } },
        layers: [{ id: "custom-raster", type: "raster", source: "custom" }]
      };
    }
    return id;
  }
  if (id.indexOf("mapbox://") === 0) return id;
  return "mapbox://styles/" + siteConfig.mapboxUsername + "/" + id;
}

// ── Atomic basemap swap (9/8) ────────────────────────────────────────────────
// The design flaw this ends: the basemap and the user's data layers lived in ONE style object,
// so switching basemaps threw the whole style away — data included — and re-added the data
// afterwards from config, behind deferred ticks and heal timers (mapinit readdSide). Every
// "my points vanished when I switched basemaps" was that rebuild losing the race or rebuilding
// from config that didn't know about this session's work; a layer created after boot that isn't
// in the tree was simply gone for good (proven by basemap-race-gate 9/8: 4 of 4 switches).
//
// The fix makes the swap carry the data instead of destroying it: resolve the NEW basemap to
// style JSON, lift the CURRENT style's runtime-added sources and layers into it verbatim — live
// drawn features, current filters, current visibility — and hand setStyle the merged style in
// one call. The map is never, at any instant, without its data layers, and nothing needs to be
// rebuilt. readdSide still runs on style.load and finds everything present (addMapLayer is
// idempotent), so it becomes a verifier; the heal timers stay only as the net under the
// fallback below.
//
// "The basemap's own layers" are the id/source sets captured from each applied style's JSON
// (map.__msBaseIds; boot capture in readdSide). Excluded from carry: mapbox-draw's gl-draw-*
// (draw re-adds its own on style.load; a carried copy would collide) and `custom` layers
// (deck.gl etc. can't round-trip through style JSON; their owners re-attach them).
// Fallback: a style we can't resolve to JSON (fetch failure, mapbox:// with no token) takes the
// old full-swap path unchanged and clears __msBaseIds so the next style.load re-captures.
var msStyleJsonCache = {};
function msResolveStyleJson(want) {
  if (want && typeof want === "object") return Promise.resolve(want);
  var url = String(want || "");
  if (url.indexOf("mapbox://styles/") === 0) {
    if (!(typeof mapboxgl !== "undefined" && mapboxgl.accessToken)) return Promise.resolve(null);
    url = "https://api.mapbox.com/styles/v1/" + url.slice("mapbox://styles/".length) +
          "?access_token=" + encodeURIComponent(mapboxgl.accessToken);
  }
  if (!/^https?:\/\//i.test(url)) return Promise.resolve(null);
  if (msStyleJsonCache[url]) return Promise.resolve(msStyleJsonCache[url]);
  return fetch(url).then(function (r) { return r.ok ? r.json() : null; })
    .then(function (j) { if (j && j.layers) msStyleJsonCache[url] = j; return msStyleJsonCache[url] || null; })
    .catch(function () { return null; });
}
function msCaptureBaseIds(map) {
  try {
    var st = map.getStyle(), L = {}, S = {};
    (st.layers || []).forEach(function (l) { if (l && l.type !== "custom" && !/^gl-draw/.test(l.id)) L[l.id] = 1; });
    Object.keys(st.sources || {}).forEach(function (k) { if (!/^mapbox-gl-draw/.test(k)) S[k] = 1; });
    map.__msBaseIds = { layers: L, sources: S };
  } catch (e) {}
}
try { window.msCaptureBaseIds = msCaptureBaseIds; } catch (e) {}
function msMergedSwap(map, want) {
  msResolveStyleJson(want).then(function (next) {
    if (map.__msWantStyle !== want) return;   // LAST CLICK WINS: a newer choice superseded this one
    function plain() { map.__msBaseIds = null; try { map.setStyle(want, { diff: false }); } catch (e) {} }
    var cur = null; try { cur = map.getStyle(); } catch (e) {}
    var base = map.__msBaseIds;
    if (!next || !next.layers || !cur || !cur.layers || !base) { plain(); return; }
    var nextSrc = next.sources || {};
    var ourSources = {}, ourLayers = [];
    Object.keys(cur.sources || {}).forEach(function (k) {
      if (base.sources[k] || nextSrc[k] || /^mapbox-gl-draw/.test(k)) return;
      ourSources[k] = cur.sources[k];
    });
    (cur.layers || []).forEach(function (l) {
      if (!l || base.layers[l.id] || l.type === "custom" || /^gl-draw/.test(l.id)) return;
      ourLayers.push(l);
    });
    // the incoming basemap's own ids — recorded BEFORE the swap, so the style.load capture
    // never runs against a style that already contains data layers
    var L = {}, S = {};
    next.layers.forEach(function (l) { if (l) L[l.id] = 1; });
    Object.keys(nextSrc).forEach(function (k) { S[k] = 1; });
    map.__msBaseIds = { layers: L, sources: S };
    var merged = {};
    Object.keys(next).forEach(function (k) { merged[k] = next[k]; });
    merged.sources = {};
    Object.keys(nextSrc).forEach(function (k) { merged.sources[k] = nextSrc[k]; });
    Object.keys(ourSources).forEach(function (k) { merged.sources[k] = ourSources[k]; });
    merged.layers = next.layers.concat(ourLayers);
    // A style with no sprite/glyphs of its own (the raster basemap wrappers) inherits the current
    // ones: sprite and font URLs then MATCH across the swap, which is what lets the diff below
    // actually take the diff path — measured 9/8: without this, every free-basemap pair fell back
    // to a full rebuild and labels blanked for 7-12 frames. Raster basemaps render no symbols, so
    // the inherited sprite is never drawn by them; it exists to keep the URLs equal.
    if (!merged.sprite && cur.sprite) merged.sprite = cur.sprite;
    if (!merged.glyphs && cur.glyphs) merged.glyphs = cur.glyphs;
    // diff:true (9/8, owner: labels blink on switch): since the merged style CONTAINS the data
    // layers, the diff engine sees them unchanged and never touches them — so their labels keep
    // their rendered glyphs instead of re-rasterizing through a full swap. The 7/18 danger
    // ("diff strips runtime layers") only existed because the incoming style LACKED the data;
    // it can't strip what the style declares. When a swap isn't diffable (sprite/glyph changes),
    // mapbox-gl falls back to a full rebuild of the SAME merged style internally — behavior
    // then equals the previous diff:false path. mapbox-draw's gl-draw layers are deliberately
    // not carried: draw re-adds them itself when its source goes missing (styledata listener).
    try { map.setStyle(merged, { diff: true }); } catch (e) { plain(); }
  });
}

// THE one entry point for changing a map's basemap — viewer radios (setupMapSwitching below) and
// the editor's onMapRadio both call this, so there is exactly one swap implementation. The editor
// used to run its own `map.setStyle(style)` copy, which still had both traps the engine fixed on
// 7/18: default diff (strips runtime data layers WITHOUT firing style.load — nothing ever re-adds)
// and the isStyleLoaded() deferral (queues the click on a style.load that never comes). That copy
// was the owner's "points disappeared when switching basemaps".
function msApplyBasemap(map, id) {
  if (!map) return;
  map.__msWantStyle = basemapStyle(id);
  function go() { try { msMergedSwap(map, map.__msWantStyle); } catch (e) { try { map.setStyle(map.__msWantStyle, { diff: false }); } catch (e2) {} } }
  if (map.__msBooted) go();
  else if (!map.__msPendingStyle) {
    map.__msPendingStyle = true;
    map.once("style.load", function () { map.__msPendingStyle = false; go(); });
  }
}
try { window.msApplyBasemap = msApplyBasemap; } catch (e) {}

// Called from mapinit.js after maps are initialized
function setupMapSwitching() {
  var rightInputs = document.getElementsByName("rtoggle");
  var leftInputs = document.getElementsByName("ltoggle");

  // Apply a basemap to a map (rebuilt 7/18 — the toggle bugs all lived here):
  //  - LAST CLICK WINS: the DESIRED style is stored on the map and go() always applies that,
  //    so a stale deferred closure can never land an old basemap over a newer choice.
  //  - diff:false forces a full swap, so style.load ALWAYS fires and the engine re-add
  //    (mapinit readdSide) always runs. A diffed switch can strip runtime-added data layers
  //    WITHOUT firing style.load ("features disappear"), or partially fail and leave the
  //    basemap looking unchanged.
  //  - The old isStyleLoaded() gate returned false during ANY churn (tile loads, label
  //    recomputes), queueing the click on a style.load that never came ("basemap doesn't
  //    change"). Only the INITIAL load needs deferring (boot flash-then-white bug, 7/15) —
  //    after boot (__msBooted, set by readdSide) apply immediately.
  function applyStyle(map, id) { msApplyBasemap(map, id); }
  function idOf(layer) { return (typeof layer.className === "undefined") ? layer.target.className : layer.className; }
  function switchRightLayer(layer) { applyStyle(afterMap, idOf(layer)); }
  function switchLeftLayer(layer) { applyStyle(beforeMap, idOf(layer)); }

  // Boot: both maps start on mapConfig.style. Only switch a side whose checked basemap DIFFERS from
  // that (so the left side, already correct, isn't needlessly rebuilt), and always after style.load.
  for (var i = 0; i < rightInputs.length; i++) {
    if (rightInputs[i].checked && basemapStyle(rightInputs[i].value) !== mapConfig.style) switchRightLayer(rightInputs[i]);
    rightInputs[i].onchange = switchRightLayer;
  }
  for (var j = 0; j < leftInputs.length; j++) {
    if (leftInputs[j].checked && basemapStyle(leftInputs[j].value) !== mapConfig.style) switchLeftLayer(leftInputs[j]);
    leftInputs[j].onchange = switchLeftLayer;
  }
}
