/* tilegen.js — browser-side "tile factory": GeoJSON → vector tiles → a PMTiles v3 archive →
   Supabase Storage. Nothing server-side, nothing metered, nothing anyone can be charged for.

   WHY: big GeoJSON layers lag (the renderer re-parses/re-buckets the whole dataset); tiles are
   pre-cut + simplified per zoom, so only the viewport loads. Layers past the thresholds below
   auto-convert on import, and every converted layer is re-generated ("sewn up") at publish so
   viewers always see fresh tiles. The features table stays the editable source of truth.

   Pipeline: geojson-vt (tile cutting, ISC) + vt-pbf (MVT encoding, MIT) via jsDelivr ESM →
   gzip via CompressionStream → PMTiles v3 archive assembled here (same layout the repo's
   python reader mapdiag/pmtiles_tile_server.py parses — Hilbert tile ids, delta-varint
   directories, gzip-compressed everything) → storage bucket `tiles/{projectId}/{layerId}.pmtiles`.

   Consumers: the site renders converted layers through map/pmt-sw.js (a service worker that
   range-reads the archive and answers /map/pmt/{pid}/{lid}/{z}/{x}/{y}.pbf); MapLibre-variant
   downloads embed the archive file itself (raw_config.pmtiles rides onto the node). */

(function () {
  "use strict";
  if (window.MSTileGen) return;   // idempotent — double-loading must not reset state (upload seam)

  var GEOJSON_VT_ESM = "https://cdn.jsdelivr.net/npm/geojson-vt@3.2.1/+esm";
  var VT_PBF_ESM = "https://cdn.jsdelivr.net/npm/vt-pbf@3.1.3/+esm";
  var SUPABASE_URL = "https://eqpxlwbjqiwfjlsuapvu.supabase.co";
  var BUCKET = "tiles";
  var LAYER_NAME = "features";   // the one source-layer name every generated archive uses
  function nfmt(n) { try { return Number(n).toLocaleString("en-US"); } catch (e) { return String(n); } }

  // ── the maximums (geometry-aware): past any of these, a layer auto-converts ──
  // points are cheap (Google My Maps caps layers at 2,000); lines/polygons carry whole
  // geometries per feature (the buildings-lag case), so they convert much sooner.
  var LIMITS = { pointFeatures: 2000, otherFeatures: 500, rawBytes: 4 * 1024 * 1024 };

  function needsTiles(featureCount, geomKind, rawBytes) {
    if (rawBytes != null && rawBytes > LIMITS.rawBytes) return true;
    var cap = (geomKind === "circle" || geomKind === "Point") ? LIMITS.pointFeatures : LIMITS.otherFeatures;
    return featureCount > cap;
  }

  /* ── PMTiles v3 writer ─────────────────────────────────────────────────── */

  function varint(n, out) {
    while (n > 127) { out.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); }
    out.push(n);
  }

  // cumulative pyramid base + Hilbert index — the exact mirror of the proven python reader
  function zxyToTileId(z, x, y) {
    var acc = 0;
    for (var i = 0; i < z; i++) acc += Math.pow(4, i);
    var n = Math.pow(2, z), rx, ry, d = 0, s = n / 2, t;
    while (s > 0) {
      rx = (x & s) > 0 ? 1 : 0;
      ry = (y & s) > 0 ? 1 : 0;
      d += s * s * ((3 * rx) ^ ry);
      if (ry === 0) {
        if (rx === 1) { x = s - 1 - x; y = s - 1 - y; }
        t = x; x = y; y = t;
      }
      s = Math.floor(s / 2);
    }
    return acc + d;
  }

  // entries: [{id, offset, length, run}] sorted by id, offsets contiguous where laid down in order
  function serializeDirectory(entries) {
    var out = [];
    varint(entries.length, out);
    var prev = 0;
    entries.forEach(function (e) { varint(e.id - prev, out); prev = e.id; });
    entries.forEach(function (e) { varint(e.run, out); });
    entries.forEach(function (e) { varint(e.length, out); });
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i], p = entries[i - 1];
      if (i > 0 && p.offset + p.length === e.offset) varint(0, out);
      else varint(e.offset + 1, out);
    }
    return new Uint8Array(out);
  }

  async function gz(u8) {
    var resp = new Response(new Blob([u8]).stream().pipeThrough(new CompressionStream("gzip")));
    return new Uint8Array(await resp.arrayBuffer());
  }

  function w64(dv, off, n) {
    dv.setUint32(off, n % 4294967296, true);
    dv.setUint32(off + 4, Math.floor(n / 4294967296), true);
  }

  function concat(parts) {
    var len = parts.reduce(function (a, p) { return a + p.length; }, 0);
    var out = new Uint8Array(len), o = 0;
    parts.forEach(function (p) { out.set(p, o); o += p.length; });
    return out;
  }

  function boundsOf(fc) {
    var b = [Infinity, Infinity, -Infinity, -Infinity];
    function walk(c) {
      if (!c || !c.length) return;
      if (typeof c[0] === "number") {
        if (c[0] < b[0]) b[0] = c[0]; if (c[1] < b[1]) b[1] = c[1];
        if (c[0] > b[2]) b[2] = c[0]; if (c[1] > b[3]) b[3] = c[1];
      } else c.forEach(walk);
    }
    (fc.features || []).forEach(function (f) { if (f.geometry && f.geometry.coordinates) walk(f.geometry.coordinates); });
    return isFinite(b[0]) ? b : [-180, -85, 180, 85];
  }

  // ── tippecanoe-style tile diet (7/16) ────────────────────────────────────
  // Two zoom-aware, visually-lossless reductions per tile, applied before encoding:
  //  1. SUB-PIXEL DROP — a line/polygon whose whole bounding box is smaller than dropPx
  //     on a 512px-rendered tile cannot be seen; drop it (tippecanoe's tiny-feature drop).
  //     Inherently zoom-aware: at high zooms almost nothing is sub-pixel.
  //  2. DUPLICATE MERGE — after skinny props + per-zoom simplification, stacked/parallel
  //     features often collapse to IDENTICAL geometry with identical days; one survives
  //     (tippecanoe's coalesce). Points are never dropped or merged.
  var DIET = { dropPx: 0.75, unitsPerPx: 4096 / 512 };   // tweakable (speedlab knob)
  function dietFeatures(feats) {
    var out = [], seen = {}, minD = DIET.dropPx * DIET.unitsPerPx, minD2 = minD * minD;
    for (var i = 0; i < feats.length; i++) {
      var f = feats[i];
      if (f.type !== 1) {   // 1 = point
        var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, g = f.geometry;
        for (var r = 0; r < g.length; r++) for (var p = 0; p < g[r].length; p++) {
          var pt = g[r][p];
          if (pt[0] < x0) x0 = pt[0]; if (pt[0] > x1) x1 = pt[0];
          if (pt[1] < y0) y0 = pt[1]; if (pt[1] > y1) y1 = pt[1];
        }
        var dx = x1 - x0, dy = y1 - y0;
        if (dx * dx + dy * dy < minD2) continue;
        var key = f.type + "|" + (f.tags && f.tags.DayStart) + "|" + (f.tags && f.tags.DayEnd) + "|" + JSON.stringify(g);
        if (seen[key]) continue;
        seen[key] = 1;
      }
      out.push(f);
    }
    return out;
  }

  // fc → PMTiles v3 archive (Uint8Array). Feature ids are preserved into the tiles (feature-state
  // hover/selection and the editor's tile↔DB lookups need them).
  async function buildArchive(fc, opts) {
    opts = opts || {};
    var maxZoom = opts.maxZoom != null ? opts.maxZoom : 15;
    var status = opts.status || function () {};

    status("Loading tile libraries…");
    var mods = await Promise.all([import(GEOJSON_VT_ESM), import(VT_PBF_ESM)]);
    var geojsonvt = mods[0].default || mods[0];
    var vtpbf = mods[1].default || mods[1];
    var fromGeojsonVt = vtpbf.fromGeojsonVt || (vtpbf.default && vtpbf.default.fromGeojsonVt);
    if (!fromGeojsonVt) throw new Error("vt-pbf did not expose fromGeojsonVt");

    status("Cutting tiles…");
    var index = geojsonvt(fc, { maxZoom: maxZoom, indexMaxZoom: 5, buffer: 64, extent: 4096, tolerance: 3 });

    // walk the pyramid LEVEL BY LEVEL under a tile BUDGET. maxZoom 15 on a continent-wide layer
    // meant ~900k tiles (the 891,784-tile killed-page incident, 7/15) — many minutes of gzip for
    // detail the renderer can synthesize anyway. When the next level would blow the budget, the
    // archive stops at the current zoom and the map OVERZOOMS from there (source_maxzoom is
    // stamped by convertLayer so the renderer knows to). IMPORTANT: descend on every NON-NULL
    // tile, not on non-empty features — geojson-vt simplifies sub-pixel geometries away at low
    // zooms while deeper tiles still carry them. null = truly no data below.
    var TILE_BUDGET = opts.tileBudget != null ? opts.tileBudget : 24000;
    var raw = [];   // {id, bytes}
    var dietDropped = 0;
    var level = [[0, 0, 0]], z = 0;
    while (level.length && z <= maxZoom) {
      var keep = [], next = [];
      for (var li = 0; li < level.length; li++) {
        var x = level[li][1], y = level[li][2];
        var t = index.getTile(z, x, y);
        if (!t) continue;
        if (t.features && t.features.length) {
          // diet into a COPY ({features:…} is all vt-pbf reads) — geojson-vt still owns `t`,
          // and children are derived from it, so it must never be mutated
          var kept = dietFeatures(t.features);
          dietDropped += t.features.length - kept.length;
          if (kept.length) keep.push([x, y, { features: kept }]);
        }
        if (z < maxZoom) next.push([z + 1, 2 * x, 2 * y], [z + 1, 2 * x + 1, 2 * y], [z + 1, 2 * x, 2 * y + 1], [z + 1, 2 * x + 1, 2 * y + 1]);
      }
      if (raw.length && raw.length + keep.length > TILE_BUDGET) {
        maxZoom = z - 1;   // achieved zoom — recorded in the header + source_maxzoom
        status("Tile budget reached — archive stops at z" + maxZoom + " (" + nfmt(raw.length) + " tiles); deeper zooms overzoom.");
        break;
      }
      for (var ki = 0; ki < keep.length; ki++) {
        var layers = {}; layers[LAYER_NAME] = keep[ki][2];
        raw.push({ id: zxyToTileId(z, keep[ki][0], keep[ki][1]), bytes: fromGeojsonVt(layers, { version: 2, extent: 4096 }) });
      }
      status("Cutting tiles… z" + z + " (" + nfmt(raw.length) + " tiles)");
      level = next; z++;
    }
    if (!raw.length) throw new Error("no tiles produced");
    if (dietDropped) status("Tile diet: " + nfmt(dietDropped) + " sub-pixel/duplicate copies dropped across tiles (nothing visible changes).");   // no silent caps
    raw.sort(function (a, b) { return a.id - b.id; });

    status("Compressing " + nfmt(raw.length) + " tiles…");
    var entries = [], dataParts = [], off = 0;
    for (var i = 0; i < raw.length; i++) {
      var g = await gz(raw[i].bytes);
      entries.push({ id: raw[i].id, offset: off, length: g.length, run: 1 });
      dataParts.push(g); off += g.length;
      if (i % 200 === 0) status("Compressing tiles… " + nfmt(i) + "/" + nfmt(raw.length));
    }
    var tileData = concat(dataParts);

    // directories: root-only while it stays small; leaf directories otherwise (the spec caps
    // header+root at the first 16,384 bytes — readers fetch exactly that much up front)
    var rootBytes, leafBytes = new Uint8Array(0);
    if (entries.length <= 1200) {
      rootBytes = await gz(serializeDirectory(entries));
    }
    if (!rootBytes || rootBytes.length > 16257) {
      var CHUNK = 2048, rootEntries = [], leafParts = [], lo = 0;
      for (var s = 0; s < entries.length; s += CHUNK) {
        var chunk = entries.slice(s, s + CHUNK);
        var ser = await gz(serializeDirectory(chunk));
        rootEntries.push({ id: chunk[0].id, offset: lo, length: ser.length, run: 0 });
        leafParts.push(ser); lo += ser.length;
      }
      leafBytes = concat(leafParts);
      rootBytes = await gz(serializeDirectory(rootEntries));
    }

    var meta = { name: opts.name || "layer", format: "pbf",
      vector_layers: [{ id: LAYER_NAME, fields: {} }] };
    var metaBytes = await gz(new TextEncoder().encode(JSON.stringify(meta)));

    var b = boundsOf(fc);
    var header = new Uint8Array(127);
    var dv = new DataView(header.buffer);
    header.set([0x50, 0x4d, 0x54, 0x69, 0x6c, 0x65, 0x73], 0);   // "PMTiles"
    header[7] = 3;
    var rootOff = 127;
    var metaOff = rootOff + rootBytes.length;
    var leafOff = metaOff + metaBytes.length;
    var dataOff = leafOff + leafBytes.length;
    w64(dv, 8, rootOff); w64(dv, 16, rootBytes.length);
    w64(dv, 24, metaOff); w64(dv, 32, metaBytes.length);
    w64(dv, 40, leafOff); w64(dv, 48, leafBytes.length);
    w64(dv, 56, dataOff); w64(dv, 64, tileData.length);
    w64(dv, 72, entries.length);   // addressed tiles
    w64(dv, 80, entries.length);   // tile entries
    w64(dv, 88, entries.length);   // tile contents (no dedup)
    header[96] = 1;                // clustered (laid down in tileId order)
    header[97] = 2;                // internal compression: gzip
    header[98] = 2;                // tile compression: gzip
    header[99] = 1;                // tile type: MVT
    header[100] = 0; header[101] = maxZoom;
    dv.setInt32(102, Math.round(b[0] * 1e7), true);
    dv.setInt32(106, Math.round(b[1] * 1e7), true);
    dv.setInt32(110, Math.round(b[2] * 1e7), true);
    dv.setInt32(114, Math.round(b[3] * 1e7), true);
    header[118] = Math.min(maxZoom, 10);
    dv.setInt32(119, Math.round((b[0] + b[2]) / 2 * 1e7), true);
    dv.setInt32(123, Math.round((b[1] + b[3]) / 2 * 1e7), true);

    return { bytes: concat([header, rootBytes, metaBytes, leafBytes, tileData]), maxZoom: maxZoom };   // maxZoom = ACHIEVED zoom (may be budget-capped)
  }

  /* ── EXPERIMENTAL instant-scrub raster bake (7/16) ─────────────────────────
     A tiny PNG beside the archive: pixel R = build year − 1799, G = end year − 1799
     (255 = never ends), alpha 0 = no feature. Cohorts draw latest-start FIRST so overlaps
     keep the earliest build year. Powers platform/rasterScrub.js (instant timeline preview
     while dragging). Guarded at the call site — a bake failure never breaks conversion.
     REMOVE together with rasterScrub.js (this block + its call in convertLayer). */
  async function bakeYearsRaster(db, projectId, layerDbId, fc) {
    var b = boundsOf(fc);
    var my = function (lat) { return Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)); };
    var aspect = (my(b[3]) - my(b[1])) / ((b[2] - b[0]) * Math.PI / 180);
    if (!isFinite(aspect) || aspect <= 0) throw new Error("degenerate bounds for raster");
    // cohorts once — shared across every pyramid level
    var cohorts = {};
    (fc.features || []).forEach(function (f) {
      var p = f.properties || {};
      var ys = p.DayStart ? Math.floor(p.DayStart / 10000) : 0;
      var ye = (p.DayEnd && p.DayEnd !== 99999999) ? Math.floor(p.DayEnd / 10000) : 9999;
      var r = ys <= 1800 ? 1 : Math.min(255, Math.max(1, ys - 1799));
      var g = ye >= 2054 ? 255 : Math.min(255, Math.max(1, ye - 1799));
      var k = r + "," + g;
      (cohorts[k] = cohorts[k] || []).push(f.geometry);
    });
    var keys = Object.keys(cohorts).sort(function (a, b2) { return (+b2.split(",")[0]) - (+a.split(",")[0]); });   // latest start first, earliest ON TOP

    // PYRAMID (7/16): each level is a FRESH crisp bake at its own resolution (never downscale —
    // that blends pixel values into wrong years). Strokes thin as resolution rises so screen
    // thickness stays steady. bakeCanvas draws the (ox,oy,cw,ch) WINDOW of the full W×H image —
    // whole-image levels pass the full window; the finest level bakes as 2×2 QUADRANT tiles
    // (one 16384-wide texture would blow VRAM; quads load individually, only where you look).
    function bakeCanvas(W, H, ox, oy, cw, ch) {
      var px = function (lon) { return (lon - b[0]) / (b[2] - b[0]) * W - ox; };
      var py = function (lat) { return (my(b[3]) - my(lat)) / (my(b[3]) - my(b[1])) * H - oy; };
      var cv = document.createElement("canvas"); cv.width = cw; cv.height = ch;
      var ctx = cv.getContext("2d", { willReadFrequently: true });
      // finer strokes on finer levels — zoomed-in lines were reading too fat (user 7/16)
      ctx.lineWidth = W >= 16384 ? 1.8 : W >= 8192 ? 2.0 : W >= 4096 ? 2.5 : 3.0;
      ctx.lineCap = "round"; ctx.lineJoin = "round";
      keys.forEach(function (k) {
        var rg = k.split(",");
        ctx.strokeStyle = ctx.fillStyle = "rgb(" + rg[0] + "," + rg[1] + ",0)";
        var pts = [];
        var line = function (c) { for (var i = 0; i < c.length; i++) { var X = px(c[i][0]), Y = py(c[i][1]); if (i === 0) ctx.moveTo(X, Y); else ctx.lineTo(X, Y); } };
        ctx.beginPath();
        var strokes = false, fills = false;
        cohorts[k].forEach(function walkG(g) {
          if (!g) return;
          if (g.type === "GeometryCollection") return (g.geometries || []).forEach(walkG);
          if (g.type === "LineString") { line(g.coordinates); strokes = true; }
          else if (g.type === "MultiLineString") { g.coordinates.forEach(line); strokes = true; }
          else if (g.type === "Polygon") { g.coordinates.forEach(function (rg2) { line(rg2); ctx.closePath(); }); fills = true; }
          else if (g.type === "MultiPolygon") { g.coordinates.forEach(function (po) { po.forEach(function (rg2) { line(rg2); ctx.closePath(); }); }); fills = true; }
          else if (g.type === "Point") pts.push(g.coordinates);
          else if (g.type === "MultiPoint") g.coordinates.forEach(function (c) { pts.push(c); });
        });
        if (fills) ctx.fill();
        if (strokes || fills) ctx.stroke();
        pts.forEach(function (c) { ctx.fillRect(px(c[0]) - 2.5, py(c[1]) - 2.5, 5, 5); });
      });
      // kill anti-aliased fringes so every surviving pixel carries exact-ish years
      var im = ctx.getImageData(0, 0, cw, ch), d = im.data, inked = 0;
      for (var i = 0; i < d.length; i += 4) {
        if (d[i + 3] >= 140) { d[i + 2] = 0; d[i + 3] = 255; inked++; }
        else { d[i] = 0; d[i + 1] = 0; d[i + 2] = 0; d[i + 3] = 0; }
      }
      ctx.putImageData(im, 0, 0);
      return { cv: cv, inked: inked };
    }
    async function uploadPng(cv, suffix) {
      var blob = await new Promise(function (res) { cv.toBlob(res, "image/png"); });
      if (!blob) return null;
      var path = projectId + "/" + layerDbId + ".years" + suffix + ".png";
      var r2 = await db.storage.from(BUCKET).upload(path, blob, { upsert: false, contentType: "image/png" });   // never upsert (the 7/15 trap)
      if (r2.error && /exist|duplicate/i.test(r2.error.message || "")) {
        await db.storage.from(BUCKET).remove([path]);
        r2 = await db.storage.from(BUCKET).upload(path, blob, { upsert: false, contentType: "image/png" });
      }
      if (r2.error) throw new Error(r2.error.message);
      return { url: SUPABASE_URL + "/storage/v1/object/public/" + BUCKET + "/" + path, bytes: blob.size };
    }

    var levels = [], total = 0, widths = [2048, 4096, 8192];
    for (var wi = 0; wi < widths.length; wi++) {
      var W = widths[wi], H = Math.round(W * aspect);
      if (H < 8 || W * H > 80e6) continue;   // VRAM/canvas guard per texture
      var res = bakeCanvas(W, H, 0, 0, W, H);
      if (!res.inked) continue;
      var up = await uploadPng(res.cv, String(W));
      if (!up) continue;
      levels.push({ url: up.url, width: W, height: H, bytes: up.bytes });
      total += up.bytes;
    }
    // finest level: 16384-wide image baked as 2×2 QUADRANTS (empty quads skipped) — each quad is
    // its own texture with its own lon/lat bounds, loaded only when the viewport touches it
    var W4 = 16384, H4 = Math.round(W4 * aspect);
    if (H4 >= 16 && (W4 / 2) * Math.ceil(H4 / 2) <= 80e6) {
      var myT = my(b[3]), myB = my(b[1]);
      var lonAt = function (f) { return b[0] + f * (b[2] - b[0]); };
      var latAt = function (f) { return (2 * Math.atan(Math.exp(myT - f * (myT - myB))) - Math.PI / 2) * 180 / Math.PI; };
      var qtiles = [], ch0 = Math.round(H4 / 2);
      for (var qy = 0; qy < 2; qy++) {
        for (var qx = 0; qx < 2; qx++) {
          var oy = qy === 0 ? 0 : ch0, chq = qy === 0 ? ch0 : (H4 - ch0);
          var rq = bakeCanvas(W4, H4, qx * (W4 / 2), oy, W4 / 2, chq);
          if (!rq.inked) continue;
          var upq = await uploadPng(rq.cv, W4 + "-" + qx + qy);
          if (!upq) continue;
          qtiles.push({ url: upq.url, bytes: upq.bytes,
            bounds: [lonAt(qx * 0.5), latAt((oy + chq) / H4), lonAt((qx + 1) * 0.5), latAt(oy / H4)] });
          total += upq.bytes;
        }
      }
      if (qtiles.length) levels.push({ width: W4, height: H4, tiles: qtiles });
    }
    if (!levels.length) throw new Error("no raster levels baked");
    return { levels: levels, bounds: b, yearBase: 1799, bytes: total, bakedAt: new Date().toISOString(),
             url: levels[0].url, width: levels[0].width, height: levels[0].height };   // legacy single-image fields
  }

  /* ── storage + layer stamping ──────────────────────────────────────────── */

  function publicUrl(projectId, layerId) {
    return SUPABASE_URL + "/storage/v1/object/public/" + BUCKET + "/" + projectId + "/" + layerId + ".pmtiles";
  }

  // test seam: the E2E injects a service-key uploader; real sessions use the signed-in client
  // (needs the storage policies from mapstructor_docs/sql/setup/tilegen-setup.sql — authenticated INSERT/UPDATE on `tiles`)
  var uploadFn = null;
  async function upload(db, projectId, layerId, bytes) {
    if (uploadFn) return uploadFn(projectId, layerId, bytes);
    var path = projectId + "/" + layerId + ".pmtiles";
    var blob = new Blob([bytes], { type: "application/octet-stream" });
    // NEVER upsert:true — storage's upsert path needs SELECT visibility on storage.objects and
    // fails as a bogus "violates row-level security" (the 7/15 all-day mystery: plain insert 200,
    // upsert 403 with identical, correct policies). Plain insert; on "already exists" delete+retry.
    var r = await db.storage.from(BUCKET).upload(path, blob, { upsert: false });
    if (r.error && /exist|duplicate/i.test(r.error.message || "")) {
      await db.storage.from(BUCKET).remove([path]);
      r = await db.storage.from(BUCKET).upload(path, blob, { upsert: false });
    }
    if (r.error) throw new Error("tile upload failed: " + r.error.message);
  }

  // features (geojson Feature[] with .id = features.feature_id) → archive → storage → the layers
  // row re-pointed at the tile route. The features rows are untouched (still the editable truth).
  async function convertLayer(db, projectId, layerDbId, features, o) {
    o = o || {};
    var status = o.status || function () {};
    var geomKind = o.geomKind || "fill";
    var maxZoom = (geomKind === "circle" || geomKind === "Point") ? 13 : 15;
    var fc = { type: "FeatureCollection", features: features };
    var built = await buildArchive(fc, { maxZoom: maxZoom, tileBudget: o.tileBudget, name: o.name || "layer", status: status });
    var bytes = built.bytes;
    var mb = (bytes.length / 1048576).toFixed(1);
    status("Uploading tiles (" + mb + " MB)…");
    await upload(db, projectId, layerDbId, bytes);
    status("Pointing the layer at its tiles…");
    var cur = await db.from("layers").select("raw_config, source_type").eq("id", layerDbId).single();
    if (cur.error) throw new Error(cur.error.message);
    var rc = (cur.data && cur.data.raw_config) || {};
    rc.pmtiles = publicUrl(projectId, layerDbId);            // download-embed hint (rides onto the node)
    rc.convertedFrom = rc.convertedFrom || cur.data.source_type || "geojson-supabase";
    rc.tilesGeneratedAt = new Date().toISOString();
    rc.tilesBytes = bytes.length;                            // size on record — surfaces in status/answers
    // Dirty-tracking stamps (7/21): Publish skips layers whose data hasn't changed since this bake.
    // count catches adds/deletes; max feature id catches add+delete pairs that leave the count equal;
    // features.updated_at (trigger-set on UPDATE, verified 7/21) catches edits.
    rc.tilesFeatureCount = (features && features.length) || 0;
    try { rc.tilesMaxFid = (features || []).reduce(function (m, f) { var v = Number(f && f.id); return v > m ? v : m; }, 0) || null; } catch (eMx) {}
    // EXPERIMENTAL instant-scrub raster — guarded; remove together with platform/rasterScrub.js
    try {
      status("Baking instant-scrub raster…");
      rc.rasterYears = await bakeYearsRaster(db, projectId, layerDbId, fc);
      status("Instant-scrub raster ready (" + Math.round(rc.rasterYears.bytes / 1024) + " KB).");
    } catch (eR) { console.warn("raster bake skipped:", eR && eR.message); }
    var upd = await db.from("layers").update({
      source_type: "vector-tiles-url",
      source_url: "pmt/" + projectId + "/" + layerDbId + "/{z}/{x}/{y}.pbf",   // site-relative; the pmt service worker answers it
      source_layer: LAYER_NAME,
      source_maxzoom: built.maxZoom,                         // the renderer OVERZOOMS past the archive's real depth (budget-capped archives depend on this)
      raw_config: rc
    }).eq("id", layerDbId);
    if (upd.error) throw new Error(upd.error.message);
    status("Tiles ready — " + mb + " MB, up to z" + built.maxZoom + ".");
    return { tilesUrl: rc.pmtiles, bytes: bytes.length, maxZoom: built.maxZoom };
  }

  // Re-bake ONE already-tiled layer from its CURRENT features. Shared by Publish's sew-up AND by the
  // Timeline-dates tool's auto-rebake (7/20) — so setting dates on a tileset takes effect on the very
  // next load without a full Publish. Returns 1 if it re-baked, 0 if the layer isn't tile-backed.
  // 7/21: `force` skips the tile-backed gate — the panel's universal bake button uses it to FIRST-TIME
  // convert a live geojson layer to tiles through this same proven path.
  async function sewUpLayer(db, projectId, L, statusFn, force) {
    var status = statusFn || function () {};
    if (!L) return 0;
    if (!(L.raw_config && L.raw_config.pmtiles) && !force) return 0;   // only layers that already live as tiles (unless forced)
    status("Regenerating tiles: " + (L.name || "layer") + "…");
    // LABELS IN SKINNY TILES (7/16): `label` always rides along, plus the column the layer's
    // map-labels config points at (fetched surgically via the JSON arrow — never all of custom_fields).
    var lblField = (L.raw_config && L.raw_config.labels && L.raw_config.labels.field) || null;
    if (lblField === "label") lblField = null;
    var sel = "feature_id, geom, start_date, end_date, label" + (lblField ? ", lblv:custom_fields->>" + lblField : "");
    var feats = [], from = 0;
    for (;;) {
      var r = await db.from("features").select(sel).eq("layer_id", L.id).order("feature_id").range(from, from + 999);
      if (r.error || !r.data || !r.data.length) break;
      r.data.forEach(function (f) {
        // SKINNY TILES (7/16): id + timeline days ONLY. The days MUST stay baked — the slider filter
        // can only act on data physically inside the tile. Dateless features get always-visible bounds.
        var props = {
          DayStart: f.start_date ? +String(f.start_date).slice(0, 10).replace(/-/g, "") || 0 : 0,
          DayEnd: f.end_date ? +String(f.end_date).slice(0, 10).replace(/-/g, "") || 99999999 : 99999999
        };
        if (f.label != null && f.label !== "") props.label = f.label;
        if (lblField && f.lblv != null && f.lblv !== "") props[lblField] = f.lblv;
        feats.push({ type: "Feature", id: f.feature_id, properties: props, geometry: f.geom });
      });
      if (r.data.length < 1000) break;
      from += 1000;
    }
    if (!feats.length) return 0;
    await convertLayer(db, projectId, L.id, feats, { name: L.name, geomKind: L.type, status: status });
    return 1;
  }
  // 7/21 dirty check: is this layer's data UNCHANGED since its last bake? Any doubt → false (re-bake;
  // correctness over speed). Uses the stamps convertLayer records: count (adds/deletes), max feature id
  // (add+delete pairs), and features.updated_at — trigger-set on UPDATE (verified 7/21) — for edits.
  // 2-minute slack on the timestamp compare absorbs client/server clock skew, biased toward re-baking.
  async function layerTilesClean(db, L) {
    try {
      var rc = (L && L.raw_config) || {};
      if (!rc.tilesGeneratedAt || rc.tilesFeatureCount == null) return false;   // pre-7/21 bake — no stamps, bake once to gain them
      var cq = await db.from("features").select("feature_id", { count: "exact", head: true }).eq("layer_id", L.id);
      if (((cq && cq.count) || 0) !== rc.tilesFeatureCount) return false;
      if (rc.tilesMaxFid != null) {
        var mf = await db.from("features").select("feature_id").eq("layer_id", L.id).order("feature_id", { ascending: false }).limit(1);
        var mfid = mf.data && mf.data[0] && mf.data[0].feature_id;
        if (mfid != null && Number(mfid) !== Number(rc.tilesMaxFid)) return false;
      }
      var nu = await db.from("features").select("updated_at").eq("layer_id", L.id).not("updated_at", "is", null).order("updated_at", { ascending: false }).limit(1);
      var newest = nu.data && nu.data[0] && nu.data[0].updated_at;
      if (newest && new Date(newest).getTime() > new Date(rc.tilesGeneratedAt).getTime() - 120000) return false;
      return true;
    } catch (e) { return false; }
  }
  // publish-time "sew up": re-generate every converted layer whose data CHANGED since its last bake
  // (unchanged layers skip — Publish used to re-bake everything and was "really heavy"). Returns how
  // many layers were regenerated.
  async function sewUpProject(db, projectId, statusFn) {
    var status = statusFn || function () {};
    var pl = await db.from("project_layers").select("layer_id, layers(id, name, type, source_type, raw_config)").eq("project_id", projectId);
    if (pl.error || !pl.data) return 0;
    var todo = pl.data.map(function (r) { return r.layers; }).filter(function (l) { return l && l.raw_config && l.raw_config.pmtiles; });
    var done = 0, skipped = 0;
    for (var i = 0; i < todo.length; i++) {
      if (await layerTilesClean(db, todo[i])) { skipped++; status("“" + (todo[i].name || "layer") + "” unchanged — tiles already current, skipping."); continue; }
      if (await sewUpLayer(db, projectId, todo[i], status)) done++;
    }
    if (skipped) status(skipped + " unchanged layer" + (skipped === 1 ? "" : "s") + " skipped; " + done + " re-baked.");
    return done;
  }

  window.MSTileGen = {
    LIMITS: LIMITS,
    DIET: DIET,   // { dropPx } — live-tweakable (speedlab)
    bakeYearsRaster: bakeYearsRaster,   // exposed for rebake harnesses + the future speedlab tiler playground
    needsTiles: needsTiles,
    buildArchive: buildArchive,
    convertLayer: convertLayer,
    sewUpLayer: sewUpLayer,
    sewUpProject: sewUpProject,
    layerTilesClean: layerTilesClean,
    zxyToTileId: zxyToTileId,
    publicUrl: publicUrl,
    _setUploadFn: function (fn) { uploadFn = fn; }
  };
})();
