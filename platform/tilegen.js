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

    // walk the tile pyramid. IMPORTANT: descend on every NON-NULL tile, not on non-empty features —
    // geojson-vt simplifies sub-pixel geometries away at low zooms (a city-scale layer's z0..z8
    // tiles can be feature-empty) while deeper tiles still carry them. null = truly no data below.
    var raw = [];   // {id, bytes}
    var stack = [[0, 0, 0]];
    while (stack.length) {
      var zxy = stack.pop(), z = zxy[0], x = zxy[1], y = zxy[2];
      var t = index.getTile(z, x, y);
      if (!t) continue;
      if (t.features && t.features.length) {
        var layers = {}; layers[LAYER_NAME] = t;
        raw.push({ id: zxyToTileId(z, x, y), bytes: fromGeojsonVt(layers, { version: 2, extent: 4096 }) });
      }
      if (z < maxZoom) stack.push([z + 1, 2 * x, 2 * y], [z + 1, 2 * x + 1, 2 * y], [z + 1, 2 * x, 2 * y + 1], [z + 1, 2 * x + 1, 2 * y + 1]);
    }
    if (!raw.length) throw new Error("no tiles produced");
    raw.sort(function (a, b) { return a.id - b.id; });

    status("Compressing " + raw.length + " tiles…");
    var entries = [], dataParts = [], off = 0;
    for (var i = 0; i < raw.length; i++) {
      var g = await gz(raw[i].bytes);
      entries.push({ id: raw[i].id, offset: off, length: g.length, run: 1 });
      dataParts.push(g); off += g.length;
      if (i % 200 === 0) status("Compressing tiles… " + i + "/" + raw.length);
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

    return concat([header, rootBytes, metaBytes, leafBytes, tileData]);
  }

  /* ── storage + layer stamping ──────────────────────────────────────────── */

  function publicUrl(projectId, layerId) {
    return SUPABASE_URL + "/storage/v1/object/public/" + BUCKET + "/" + projectId + "/" + layerId + ".pmtiles";
  }

  // test seam: the E2E injects a service-key uploader; real sessions use the signed-in client
  // (needs the storage policies from tilegen-setup.sql — authenticated INSERT/UPDATE on `tiles`)
  var uploadFn = null;
  async function upload(db, projectId, layerId, bytes) {
    if (uploadFn) return uploadFn(projectId, layerId, bytes);
    var path = projectId + "/" + layerId + ".pmtiles";
    var r = await db.storage.from(BUCKET).upload(path, new Blob([bytes], { type: "application/octet-stream" }), { upsert: true });
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
    var bytes = await buildArchive(fc, { maxZoom: maxZoom, name: o.name || "layer", status: status });
    status("Uploading tiles (" + Math.round(bytes.length / 1024) + " KB)…");
    await upload(db, projectId, layerDbId, bytes);
    status("Pointing the layer at its tiles…");
    var cur = await db.from("layers").select("raw_config, source_type").eq("id", layerDbId).single();
    if (cur.error) throw new Error(cur.error.message);
    var rc = (cur.data && cur.data.raw_config) || {};
    rc.pmtiles = publicUrl(projectId, layerDbId);            // download-embed hint (rides onto the node)
    rc.convertedFrom = rc.convertedFrom || cur.data.source_type || "geojson-supabase";
    rc.tilesGeneratedAt = new Date().toISOString();
    var upd = await db.from("layers").update({
      source_type: "vector-tiles-url",
      source_url: "pmt/" + projectId + "/" + layerDbId + "/{z}/{x}/{y}.pbf",   // site-relative; the pmt service worker answers it
      source_layer: LAYER_NAME,
      raw_config: rc
    }).eq("id", layerDbId);
    if (upd.error) throw new Error(upd.error.message);
    return { tilesUrl: rc.pmtiles, bytes: bytes.length };
  }

  // publish-time "sew up": re-generate every converted layer from its CURRENT features, so the
  // published snapshot always ships fresh tiles. Returns how many layers were regenerated.
  async function sewUpProject(db, projectId, statusFn) {
    var status = statusFn || function () {};
    var pl = await db.from("project_layers").select("layer_id, layers(id, name, type, source_type, raw_config)").eq("project_id", projectId);
    if (pl.error || !pl.data) return 0;
    var todo = pl.data.map(function (r) { return r.layers; }).filter(function (l) {
      return l && l.raw_config && l.raw_config.pmtiles;   // only layers that already live as tiles
    });
    var done = 0;
    for (var i = 0; i < todo.length; i++) {
      var L = todo[i];
      status("Regenerating tiles: " + (L.name || "layer") + "…");
      var feats = [], from = 0;
      for (;;) {
        var r = await db.from("features").select("feature_id, geom, label, description, start_date, end_date, custom_fields").eq("layer_id", L.id).order("feature_id").range(from, from + 999);
        if (r.error || !r.data || !r.data.length) break;
        r.data.forEach(function (f) {
          var props = { label: f.label, description: f.description };
          if (f.start_date) props.start_date = f.start_date;
          if (f.end_date) props.end_date = f.end_date;
          Object.keys(f.custom_fields || {}).forEach(function (k) { props[k] = f.custom_fields[k]; });
          feats.push({ type: "Feature", id: f.feature_id, properties: props, geometry: f.geom });
        });
        if (r.data.length < 1000) break;
        from += 1000;
      }
      if (!feats.length) continue;
      await convertLayer(db, projectId, L.id, feats, { name: L.name, geomKind: L.type, status: status });
      done++;
    }
    return done;
  }

  window.MSTileGen = {
    LIMITS: LIMITS,
    needsTiles: needsTiles,
    buildArchive: buildArchive,
    convertLayer: convertLayer,
    sewUpProject: sewUpProject,
    zxyToTileId: zxyToTileId,
    publicUrl: publicUrl,
    _setUploadFn: function (fn) { uploadFn = fn; }
  };
})();
