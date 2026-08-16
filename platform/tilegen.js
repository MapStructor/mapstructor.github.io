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
  var DIET = { dropPx: 0.75, unitsPerPx: 4096 / 512, disabled: false, tolerance: null };   // tweakable (speedlab knobs; disabled=true → zero reductions)
  function dietFeatures(feats) {
    if (DIET.disabled) return feats;   // "literally no reductions" test/override (7/23)
    var out = [], seen = {}, minD = DIET.dropPx * DIET.unitsPerPx, minD2 = minD * minD;
    for (var i = 0; i < feats.length; i++) {
      var f = feats[i];
      if (f.type !== 1) {   // 1 = point
        // SUB-PIXEL DROP applies to POLYGONS ONLY (type 3). Networks like NTAD arrive as
        // thousands of SHORT LINE SEGMENTS chained into routes — dropping "invisible" segments
        // punches holes in the chain and whole corridors render as dashes/nothing (7/23).
        // Lines rely on geojson-vt's own simplification instead; dedup still applies to both.
        if (f.type === 3) {
          // RING REPAIR (8/9) — a tile carries a MultiPolygon as ONE FLAT LIST of rings; which are
          // outers and which are holes is re-derived by the renderer from each ring's SIGNED AREA,
          // seeded by the first ring with non-zero area. Simplification can flip the winding of a
          // ring it has reduced to a few near-collinear points, and when such a ring comes first
          // the whole feature inverts. Madagascar's 51-unit mainland was classified as a hole
          // inside a 0.0005-unit speck at z<=3 and triangulated to nothing — the island rendered
          // as bare basemap with only its -stroke- coastline drawn, since a line layer never
          // classifies rings (owner 8/9: "Madagascar's vector color is gone").
          //   1. drop rings too small to cover a pixel — the same sub-pixel rule this function has
          //      always applied to whole polygons, now applied per RING, so it is the consistent
          //      behaviour rather than a new one. These are invisible at this zoom (kept at deeper
          //      zooms, where the pyramid re-cuts them) and are precisely the rings whose winding
          //      survives simplification unreliably. A hole is always smaller than its own outer
          //      ring, so an outer and its holes are dropped together, never split.
          //      (A conservative variant — drop only zero-area rings — was written and then backed
          //      out. It was justified by ghost ink appearing to rise 100/109/115/115 →
          //      133/133/128/137 after this change, which a re-run on the SAME artifacts showed to
          //      be run-to-run variance of the metric, not this code: fade-probe's drag lands on a
          //      slightly different date each run. See the metric-variance note in the test book.)
          //   2. repair what is left: a hole can never enclose more area than the outer ring it
          //      sits in, so any ring classified as a hole while being LARGER than its outer is a
          //      mis-wound outer — reverse it. Correct geometry can never satisfy that test, so
          //      this cannot fire on good data. It is on its own sufficient for the Madagascar
          //      case: speck(+flipped), speck(-), mainland(-) walks to three outers.
          var g0 = f.geometry, ar = [], keep = [], k, q, s, a;
          for (k = 0; k < g0.length; k++) {
            var rg = g0[k];
            for (a = 0, q = 0, s = rg.length - 1; q < rg.length; s = q++) a += rg[s][0] * rg[q][1] - rg[q][0] * rg[s][1];
            a /= 2;
            if (Math.abs(a) >= minD2) { keep.push(rg); ar.push(a); }
          }
          if (!keep.length) continue;
          var ccw = null, outerA = 0, fixed = false;
          for (k = 0; k < keep.length; k++) {
            if (ccw === null) { ccw = ar[k] < 0; outerA = Math.abs(ar[k]); continue; }
            if ((ar[k] < 0) === ccw) { outerA = Math.abs(ar[k]); continue; }   // a new outer ring
            if (Math.abs(ar[k]) > outerA) { keep[k] = keep[k].slice().reverse(); ar[k] = -ar[k]; outerA = Math.abs(ar[k]); fixed = true; }
          }
          // geojson-vt still owns `f` and derives child tiles from it — never mutate, copy instead
          if (fixed || keep.length !== g0.length) f = { id: f.id, type: f.type, tags: f.tags, geometry: keep };

          var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
          g0 = f.geometry;
          for (var r = 0; r < g0.length; r++) for (var p = 0; p < g0[r].length; p++) {
            var pt = g0[r][p];
            if (pt[0] < x0) x0 = pt[0]; if (pt[0] > x1) x1 = pt[0];
            if (pt[1] < y0) y0 = pt[1]; if (pt[1] > y1) y1 = pt[1];
          }
          var dx = x1 - x0, dy = y1 - y0;
          if (dx * dx + dy * dy < minD2) continue;
        }
        var key = f.type + "|" + (f.tags && f.tags.DayStart) + "|" + (f.tags && f.tags.DayEnd) + "|" + JSON.stringify(f.geometry);
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
    // tolerance: geojson-vt DROPS lines shorter than this many tile units per zoom — at 3 that's
    // ~300 m at z6, which punched visible holes in segment-chained networks (NTAD 7/23). Lines
    // get 1 (only sub-100 m pieces drop at far zooms — invisible under a 1px stroke); other
    // geometry keeps 3. DIET.tolerance overrides both (speedlab knob).
    var tol = DIET.tolerance != null ? DIET.tolerance : (opts.lineLayer ? 1 : 3);
    var index = geojsonvt(fc, { maxZoom: maxZoom, indexMaxZoom: 5, buffer: 64, extent: 4096, tolerance: tol });

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

  /* ── EXPERIMENTAL instant-scrub raster bake (7/16 · INDEXED rebuild 8/9) ──
     A tiny PNG beside the archive. Each pixel now stores an ID, not a date range:
     id = R*65536 + G*256 + B (0 = empty, alpha 0), and that id indexes a shared LOOKUP
     texture holding the pixel's FULL list of time stretches — up to 8, each texel
     (start−1799, end−1799, startMonth<<4 | endMonth, 255), an alpha-0 texel meaning
     "stop reading". Stretches are MONTH-precise (8/9b) at no extra bytes: the month pair
     rides in the byte that was reserved for a colour index, which moved into alpha.

     WHY (the ghost-border bug, measured ~3000 px of mid-drag-only ink): the old bake put
     ONE interval in the pixel — R = min start, G = max end across every era covering it.
     That cannot say "on, off, on". A Poland border pixel covered by Poland-1918-1939 and
     Poland-1945-2019 collapsed to 1918–2019 and drew straight through the 1939–1945
     partition, so mid-drag showed borders the released vector does not. An id + stretch
     list says it exactly: two stretches with a real gap between them.

     HOW the ids are built: features are grouped by shapeSig (identical geometry = one
     SHAPE, carrying its own list of [start,end] stretches, merged only where they overlap
     or touch). Every pyramid level is stamped in horizontal STRIPS: for each shape whose
     bbox meets the strip, draw it alone on a cleared scratch canvas and fold its index into
     every pixel it inks. Folding is a trie step — (currentId, shapeIndex) → newId — so a
     pixel's id IS its exact shape set, with no per-pixel slot cap and no key strings, and
     a new id's stretch list is its parent's merged with the shape's. One id space is shared
     by the fill and border pyramids, so one LUT serves both.

     The index pyramid occupies the SAME config slots as the old union pyramid
     (rasterYears.levels / rasterYears.borders.levels, same {url,width,height,bytes} and
     {tiles:[…]} shapes), so level-picking, prefetch, quadrant logic and download embedding
     are untouched; rasterYears.indexed = true + rasterYears.lut tell the reader to use the
     indexed shader. Configs WITHOUT `indexed` still render through the untouched legacy
     path — old bakes keep working. Guarded at the call site — a bake failure never breaks
     conversion. REMOVE together with rasterScrub.js (this block + its call in
     convertLayer). */
  // Why a layer gets NO instant-scrub raster (8/7, owner's 2,000-point gazetteer at z4.8:
  // "I move to one end, a bunch disappear, and then upon release, reappear"):
  //   · POINTS. The raster is a fixed-resolution PNG of the world — sparse dots merge or vanish
  //     at its pixel grid, so scrubbing visibly loses points that pop back on release. And points
  //     are the cheapest thing the vector paint path animates; the raster solves a problem point
  //     layers don't have.
  //   · A SPAN WIDER THAN 255 YEARS. One byte per year means the codec holds a 255-year window.
  //     The window's BASE now follows the data (8/13): the reader has always taken cfg.yearBase,
  //     so pre-1800 data simply bakes with a lower base — Steamboat (1787) was refused outright
  //     by the old fixed-1799 floor and vanished mid-drag ("These layers are not baking").
  //     What still cannot bake honestly is data whose real span EXCEEDS the window (the owner's
  //     1111-1810 gazetteer): during a drag the shader would show an empty or wrong map for most
  //     of the timeline, corrected only at release — the honest answer there stays no raster.
  function rasterYearBase(fc) {
    // −2 not −1 (8/13): start byte 1 is RESERVED as the "since forever" sentinel for dateless
    // features (yearsV2), so the oldest real start must land on byte 2.
    var yb = 1799;
    (fc.features || []).forEach(function (f) {
      var d = f.properties && f.properties.DayStart;
      if (d) { var y = Math.floor(d / 10000); if (y > 0 && y - 2 < yb) yb = y - 2; }
    });
    return yb;
  }
  function rasterUnfitReason(geomKind, fc) {
    if (geomKind === "circle" || geomKind === "Point") return "point layers animate directly";
    // Only STARTS must truly fit the 255-year window — a start outside it paints features into
    // years they didn't exist in. ENDS have always clamped silently to the ceiling (the old codec
    // capped them at 2054): an end on the ceiling reads "still alive at every reachable year",
    // which is exact until the slider passes base+255 — and stray far-future end dates exist in
    // real data (Steamboat carries an end year of 2101; refusing on ends killed its raster, 8/13).
    var minYs = Infinity, maxYs = -Infinity;
    (fc.features || []).forEach(function (f) {
      var d = f.properties && f.properties.DayStart;
      if (d) { var y = Math.floor(d / 10000); if (y > 0) { if (y < minYs) minYs = y; if (y > maxYs) maxYs = y; } }
    });
    if (isFinite(minYs) && maxYs - Math.min(1799, minYs - 2) > 255) {
      return "starts span " + minYs + "–" + maxYs + ", wider than the raster's 255-year window";
    }
    return null;
  }
  async function bakeYearsRaster(db, projectId, layerDbId, fc) {
    var t0 = Date.now();
    var b = boundsOf(fc);
    var my = function (lat) { return Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)); };
    var aspect = (my(b[3]) - my(b[1])) / ((b[2] - b[0]) * Math.PI / 180);
    if (!isFinite(aspect) || aspect <= 0) throw new Error("degenerate bounds for raster");

    /* ── 1 · SHAPES · one entry per distinct geometry, carrying its own stretch LIST ──────
       Most eras are attribute-only changes that reuse identical geometry (CShapes: 710 eras,
       far fewer distinct outlines), so shapeSig groups them. What changed 8/9: the group keeps
       EVERY [start,end] instead of collapsing to min/max. Stretches merge only where they
       overlap or TOUCH (next.start <= cur.end + 1) — Poland 1918-1939 + 1939-1945 become one
       1918–1945 stretch, while 1918-1939 + 1945-2019 stay two, which is precisely the gap the
       old union threw away.

       MONTHS, NOT YEARS (8/9b): stretches are carried as a MONTH INDEX — (year − 1799) * 12 +
       month — from here through the merge and into the LUT. A whole-year stretch made every
       border that MOVED mid-year show its before AND after position for the whole of that year:
       ghost ink measured 1880 px at 1920 (Trianon, 4 Jun) and 2114 px at 1945 (Oder-Neisse,
       8 May), while 1939 — whose changes fall on 1 Sep, a clean year boundary in the data —
       already scored 110. Months are the finest unit that can matter: the reader's own clock is
       the slider's `yearOf` = getUTCFullYear() + getUTCMonth()/12, so a day-precise stretch
       would decode to the same picture. And it is free — the month pair rides in the LUT texel's
       already-reserved B byte, so the bake is the same number of bytes. */
    /* shapeSig is a cheap BUCKET KEY, never the merge decision (8/9 fix). It was both, and eras
       whose outlines differ only in the interior collide on it: Libya 1919-1925 and 1925-1934
       are both Polygon|532 points|first=last=15.3574,32.0298 — the 1925 boundary change with
       Egypt moved vertices without adding any. The two folded into one shape, the smaller
       geometry won, and eastern Libya went unstamped for that era: its pixels carried stretches
       1899->Dec 1925 and Jul 1934->2019 with a nine-year hole, so the border vanished mid-drag
       (owner 8/9, "a weird anomaly with Libya"). Measured on this layer: 153 signature groups,
       149 genuinely identical, 4 false merges folding 5 eras into a wrong geometry — Estonia,
       Tanzania, Libya, Brunei. Coordinates are now compared exactly WITHIN a bucket, which costs
       one deep compare per collision (buckets here hold at most 3) and cannot be fooled. */
    function shapeSig(g) {
      var n = 0, first = null, last = null;
      (function walk(c) {
        if (!c) return;
        if (typeof c[0] === "number") { n++; if (!first) first = c; last = c; return; }
        for (var i = 0; i < c.length; i++) walk(c[i]);
      })(g && g.coordinates);
      var fx = first ? first[0].toFixed(4) + "," + first[1].toFixed(4) : "";
      var lx = last ? last[0].toFixed(4) + "," + last[1].toFixed(4) : "";
      return (g && g.type) + "|" + n + "|" + fx + "|" + lx;
    }
    function sameCoords(a, b) {
      if (a === b) return true;
      if (!a || !b || a.length !== b.length) return false;
      var an = typeof a[0] === "number", bn = typeof b[0] === "number";
      if (an || bn) return an && bn && a[0] === b[0] && a[1] === b[1];
      for (var i = 0; i < a.length; i++) if (!sameCoords(a[i], b[i])) return false;
      return true;
    }
    // MONTHS everywhere below: +1 now means "the next month", so eras that abut across a year
    // boundary (…ends Aug 1939, next starts Sep 1939) still merge into one stretch, and eras
    // separated by a real gap still stay two.
    function mergeSpans(list) {
      var a = list.slice().sort(function (x, y) { return (x[0] - y[0]) || (x[1] - y[1]); }), out = [];
      for (var i = 0; i < a.length; i++) {
        var cur = out.length ? out[out.length - 1] : null;
        // same-COLOUR spans merge as before; a colour change keeps its own stretch — that is
        // the whole point (each stretch paints in its own palette colour). Same-time overlaps
        // of different colours both survive; the reader paints the earlier-starting one.
        if (cur && a[i][0] <= cur[1] + 1 && (a[i][2] || 0) === (cur[2] || 0)) { if (a[i][1] > cur[1]) cur[1] = a[i][1]; }
        else out.push([a[i][0], a[i][1], a[i][2] || 0]);
      }
      return out;
    }
    // DayStart/DayEnd are YYYYMMDD integers. An UNKNOWN or malformed month resolves in the
    // direction that never shortens an era — January for a start, December for an end — which is
    // the same instinct as the reader's "an era ending in month M lives through all of M".
    // YB (8/13): the codec's year base follows the data down below 1799 when needed — the reader
    // has always decoded years as uBase + byte (cfg.yearBase), so old bakes are untouched.
    var YB = rasterYearBase(fc);
    var MIDX = function (y, mo) { return (y - YB) * 12 + mo; };
    var monOf = function (d, dflt) { var mo = Math.floor(d / 100) % 100 - 1; return (mo >= 0 && mo <= 11) ? mo : dflt; };
    var OPEN = MIDX(9999, 11);        // DayEnd 99999999 — the open-ended sentinel, clamped at write time

    /* ── PER-ERA COLOURS (8/14, owner: "I don't want one color, I want all the colors!!") ──
       Each era bakes with the colour the VECTOR would paint it — the feature's ms_color
       override first, else the active colour-by category, else the layer colour. Spans become
       [start, end, colourIdx]; the LUT's long-reserved alpha byte finally earns its keep
       (255 − index, 0 stays the stop marker) and cfg.palette ships index → hex for the reader.
       Fully backward compatible: an OLD reader treats any alpha > 0 as "in use" and paints its
       single uCol; a bake with no colour-by writes index 0 everywhere and looks exactly as
       before. Colours are frozen at BAKE time — restyling then Re-baking refreshes them, which
       is the same contract as the label bake. */
    var palBase = "#4a9eff", cbProp = null, cbMap = null;
    try {
      var lrw = await db.from("layers").select("color, raw_config").eq("id", layerDbId).single();
      if (lrw.data) {
        if (lrw.data.color && /^#[0-9a-f]{6}$/i.test(String(lrw.data.color).trim())) palBase = String(lrw.data.color).trim();
        var cb0 = lrw.data.raw_config && lrw.data.raw_config.colorBy;
        if (cb0 && cb0.prop && cb0.mapping) { cbProp = cb0.prop; cbMap = cb0.mapping; }
      }
    } catch (ePal) {}
    var palette = [palBase.toLowerCase()], palIdx = {};
    palIdx[palette[0]] = 0;
    var palOverflow = 0;
    function normHex(v) {
      var s = String(v == null ? "" : v).trim();
      if (/^[0-9a-f]{6}$/i.test(s)) s = "#" + s;
      return /^#[0-9a-f]{6}$/i.test(s) ? s.toLowerCase() : null;
    }
    function colorIdxOf(p) {
      var v = normHex(p.ms_color);   // per-feature override outranks the category, like the vector
      if (!v && cbMap && cbProp != null && p[cbProp] != null) v = normHex(cbMap[String(p[cbProp])]);
      if (!v) return 0;
      if (palIdx[v] != null) return palIdx[v];
      if (palette.length >= 250) { palOverflow++; return 0; }   // palette full — overflow paints the layer colour
      palIdx[v] = palette.length; palette.push(v);
      return palIdx[v];
    }

    var bySig = {}, shapes = [];
    (fc.features || []).forEach(function (f) {
      if (!f || !f.geometry) return;
      var p = f.properties || {};
      var ys = p.DayStart ? MIDX(Math.floor(p.DayStart / 10000), monOf(p.DayStart, 0)) : MIDX(0, 0);
      var ye = (p.DayEnd && p.DayEnd !== 99999999) ? MIDX(Math.floor(p.DayEnd / 10000), monOf(p.DayEnd, 11)) : OPEN;
      var sig = shapeSig(f.geometry);
      var bucket = bySig[sig] || (bySig[sig] = []);
      var e = null;
      for (var bi = 0; bi < bucket.length; bi++) {
        if (bucket[bi].g.type === f.geometry.type && sameCoords(bucket[bi].g.coordinates, f.geometry.coordinates)) { e = bucket[bi]; break; }
      }
      if (!e) { e = { g: f.geometry, spans: [] }; bucket.push(e); shapes.push(e); }
      e.spans.push([ys, ye, colorIdxOf(p)]);
    });
    shapes.forEach(function (s) {
      s.spans = mergeSpans(s.spans);
      var bb = [Infinity, Infinity, -Infinity, -Infinity], poly = false;
      (function walkG(g) {
        if (!g) return;
        if (g.type === "GeometryCollection") return (g.geometries || []).forEach(walkG);
        if (g.type === "Polygon" || g.type === "MultiPolygon") poly = true;
        (function walk(c) {
          if (!c || !c.length) return;
          if (typeof c[0] === "number") {
            if (c[0] < bb[0]) bb[0] = c[0]; if (c[1] < bb[1]) bb[1] = c[1];
            if (c[0] > bb[2]) bb[2] = c[0]; if (c[1] > bb[3]) bb[3] = c[1];
          } else for (var i = 0; i < c.length; i++) walk(c[i]);
        })(g.coordinates);
      })(s.g);
      s.bb = bb; s.poly = poly;
    });
    // lat outside the layer's own bounds cannot happen (bounds come from this data), but a shape
    // bbox is still clamped so the mercator projection never sees ±90
    shapes.forEach(function (s) {
      if (s.bb[1] < b[1]) s.bb[1] = b[1]; if (s.bb[3] > b[3]) s.bb[3] = b[3];
      if (s.bb[0] < b[0]) s.bb[0] = b[0]; if (s.bb[2] > b[2]) s.bb[2] = b[2];
    });

    /* ── 2 · the ID space · a TRIE over shape sets ────────────────────────────────────────
       Stamping visits shapes in ascending index order, so a pixel's set is built incrementally
       and one transition table (currentId, shapeIndex) → newId is enough to name it: identical
       sets always walk the same path, so they always land on the same id. Each node stores the
       merged stretch list of its whole set (parent's list merged with the shape's) — that list
       IS the pixel's timeline, and the LUT is just these nodes written out. One trie serves the
       fill AND border pyramids, so ids are global and a single LUT decodes both. */
    var SPAN = Math.max(4096, shapes.length + 1);
    var nodes = [null];              // id 0 = "no shape here" (never written)
    var trans = new Map();
    var MAXID = 16777215;            // the packing's ceiling: R*65536 + G*256 + B
    function stepId(prev, si) {
      var k = prev * SPAN + si, got = trans.get(k);
      if (got !== undefined) return got;
      var id = nodes.length;
      if (id > MAXID) throw new Error("instant-scrub raster: more than 16.7M distinct shape sets");
      nodes.push({ spans: mergeSpans((prev ? nodes[prev].spans : []).concat(shapes[si].spans)) });
      trans.set(k, id);
      return id;
    }

    /* ── 3 · STAMPING · shape indices → pixels, in horizontal strips ──────────────────────
       Each level is a FRESH crisp bake at its own resolution (never downscale — that blends
       ids into nonsense). bakeIndexCanvas fills the (ox,oy,cw,ch) WINDOW of the full W×H image;
       whole-image levels pass the full window, the finest level bakes as 2×2 QUADRANTS (one
       16384-wide texture would blow VRAM; quads load individually, only where you look).
       STRIPS bound memory: one Uint32Array of cw × 512 ids (≈17 MB at 8192 wide) plus a scratch
       canvas the same size, instead of a whole-image id buffer. Work is proportional to the SUM
       OF SHAPE BBOX AREAS, not shapes × image: a shape is only cleared, drawn and read back
       inside its own bbox ∩ strip.
       bordersOnly (8/8, option B): a COMPANION pyramid of just the polygon RINGS — mid-drag the
       reader lays it over the flat fill so contiguous features stay distinguishable ("shapes are
       defined by their outlines"). Rings only: no fill, no points, and no plain LineStrings
       (those ARE the layer and already live in the fill raster). */
    var STRIP = 512;
    function bakeIndexCanvas(W, H, ox, oy, cw, ch, bordersOnly) {
      var px = function (lon) { return (lon - b[0]) / (b[2] - b[0]) * W - ox; };
      var py = function (lat) { return (my(b[3]) - my(lat)) / (my(b[3]) - my(b[1])) * H - oy; };
      var out = document.createElement("canvas"); out.width = cw; out.height = ch;
      var octx = out.getContext("2d", { willReadFrequently: true });
      var sh = Math.min(STRIP, ch);
      var scv = document.createElement("canvas"); scv.width = cw; scv.height = sh;
      var sctx = scv.getContext("2d", { willReadFrequently: true });
      // finer strokes on finer levels — zoomed-in lines were reading too fat (user 7/16).
      // Border pyramid bakes THINNER (8/8): stacked-era rings sit a pixel or two apart, so fat
      // strokes merge into bands mid-timeline ("lines get thicker toward the middle").
      sctx.lineWidth = bordersOnly
        ? (W >= 16384 ? 1.5 : W >= 8192 ? 1.6 : W >= 4096 ? 1.8 : 2.0)
        : (W >= 16384 ? 1.8 : W >= 8192 ? 2.0 : W >= 4096 ? 2.5 : 3.0);
      sctx.lineCap = "round"; sctx.lineJoin = "round";
      sctx.strokeStyle = sctx.fillStyle = "#ffffff";
      var pad = Math.ceil(sctx.lineWidth) + 3;
      // FILLS keep the hard 140 cut — their interiors are fully opaque, so 140 only trims the
      // anti-aliased fringe. BORDERS are all fringe: 120 with the 5× restroke below keeps a thin
      // line's core and drops the un-saturable halo. Unlike the union bake, nothing here BLENDS —
      // each shape is drawn alone on cleared pixels — so the floor is a pure coverage test.
      var KEEP = bordersOnly ? 120 : 140;
      var cur = new Uint32Array(cw * sh);
      var inked = 0;
      for (var y0 = 0; y0 < ch; y0 += STRIP) {
        var hgt = Math.min(STRIP, ch - y0);
        cur.fill(0);
        for (var si = 0; si < shapes.length; si++) {
          var S = shapes[si];
          if (bordersOnly && !S.poly) continue;
          var bx0 = Math.floor(px(S.bb[0])) - pad, bx1 = Math.ceil(px(S.bb[2])) + pad;
          var by0 = Math.floor(py(S.bb[3])) - pad, by1 = Math.ceil(py(S.bb[1])) + pad;
          if (bx0 < 0) bx0 = 0;
          if (bx1 > cw) bx1 = cw;
          if (by0 < y0) by0 = y0;
          if (by1 > y0 + hgt) by1 = y0 + hgt;
          if (bx1 <= bx0 || by1 <= by0) continue;
          var rw = bx1 - bx0, rh = by1 - by0;
          sctx.setTransform(1, 0, 0, 1, 0, -y0);    // draw in WINDOW coords, land in strip rows
          sctx.clearRect(bx0, by0, rw, rh);         // only this shape's own footprint — the rest of
          // the scratch canvas may hold older ink, but no shape is ever read outside its own bbox
          drawShape(sctx, S.g, px, py, bordersOnly);
          sctx.setTransform(1, 0, 0, 1, 0, 0);
          var d = sctx.getImageData(bx0, by0 - y0, rw, rh).data;
          for (var yy = 0; yy < rh; yy++) {
            var row = (by0 - y0 + yy) * cw + bx0, di = yy * rw * 4 + 3;
            for (var xx = 0; xx < rw; xx++, di += 4) {
              if (d[di] >= KEEP) { var pI = row + xx; cur[pI] = stepId(cur[pI], si); }
            }
          }
        }
        var oim = octx.createImageData(cw, hgt), od = oim.data;   // starts all-zero = empty pixels
        for (var i = 0, n = cw * hgt; i < n; i++) {
          var id = cur[i];
          if (!id) continue;
          var o4 = i * 4;
          od[o4] = (id >>> 16) & 255; od[o4 + 1] = (id >>> 8) & 255; od[o4 + 2] = id & 255; od[o4 + 3] = 255;
          inked++;
        }
        octx.putImageData(oim, 0, y0);
      }
      return { cv: out, inked: inked };
    }
    // one shape, alone, on cleared pixels — no compositing tricks, so nothing can blend two
    // shapes' encodings into a third that means neither (the 8/8 partial-alpha trap)
    function drawShape(ctx, g, px, py, bordersOnly) {
      var pts = [], strokes = false, fills = false;
      var line = function (c) { for (var i = 0; i < c.length; i++) { var X = px(c[i][0]), Y = py(c[i][1]); if (i === 0) ctx.moveTo(X, Y); else ctx.lineTo(X, Y); } };
      ctx.beginPath();
      (function walkG(gg) {
        if (!gg) return;
        if (gg.type === "GeometryCollection") return (gg.geometries || []).forEach(walkG);
        if (gg.type === "LineString") { if (!bordersOnly) { line(gg.coordinates); strokes = true; } }
        else if (gg.type === "MultiLineString") { if (!bordersOnly) { gg.coordinates.forEach(line); strokes = true; } }
        else if (gg.type === "Polygon") { gg.coordinates.forEach(function (r) { line(r); ctx.closePath(); }); fills = true; }
        else if (gg.type === "MultiPolygon") { gg.coordinates.forEach(function (po) { po.forEach(function (r) { line(r); ctx.closePath(); }); }); fills = true; }
        else if (gg.type === "Point") { if (!bordersOnly) pts.push(gg.coordinates); }
        else if (gg.type === "MultiPoint") { if (!bordersOnly) gg.coordinates.forEach(function (c) { pts.push(c); }); }
      })(g);
      if (fills && !bordersOnly) ctx.fill();
      // BORDERS RESTROKE (8/8): one anti-aliased pass leaves a thin line's texels at partial
      // alpha, under the keep floor, and the line renders DOTTED. Restroking drives the core
      // opaque so it survives; the faint halo stays below and is dropped.
      if (strokes || fills) { var reps = bordersOnly ? 5 : 1; for (var rp = 0; rp < reps; rp++) ctx.stroke(); }
      if (!bordersOnly) pts.forEach(function (c) { ctx.fillRect(px(c[0]) - 2.5, py(c[1]) - 2.5, 5, 5); });
    }

    /* ── 4 · the LOOKUP texture · 256 timelines per row × 8 stretch columns ──────────────
       Texel for stretch c of id i sits at x = (i % 256) * 8 + c, y = floor(i / 256) and holds
       (start−1799, end−1799, months, 255) where `months` packs TWO 4-bit fields, startMonth<<4 |
       endMonth, each 0–11 (8/9b — see "MONTHS, NOT YEARS" above). An alpha-0 texel still means
       "stop reading"; the colour index reserved for future categorical painting moved out of B
       and into A as 255 − alpha (so today's reserved 0 is the byte 255 already written).

       WHY 255 − index AND NOT index + 1: a 2D canvas backing store is PREMULTIPLIED, and this
       LUT reaches the GPU as putImageData → toBlob(PNG) → texImage2D. Measured in this Chrome:
       the texel (120,146,83, alpha 1) comes back (0,255,0) — at alpha 1 the only representable
       channel values are 0 and 255, so a low-alpha texel loses its year bytes entirely and every
       era decodes to nonsense. Counting the colour index DOWN from 255 keeps the alpha byte high,
       where the round trip is exact, and leaves 0 free as the stop marker. Written LAST, once,
       after both pyramids: the ids are global. */
    var lutCapped = 0;
    function buildLut() {
      var n = nodes.length, rows = Math.max(1, Math.ceil(n / 256));
      var cv = document.createElement("canvas"); cv.width = 2048; cv.height = rows;
      var ctx = cv.getContext("2d", { willReadFrequently: true });
      var im = ctx.createImageData(2048, rows), d = im.data;
      for (var id = 1; id < n; id++) {
        var sp = nodes[id].spans;
        if (sp.length > 8) {          // keep the 8 LONGEST — dropping the briefest stretch is the
          lutCapped++;                // smallest possible visual error, and it is logged
          sp = sp.slice().sort(function (a, c) { return (c[1] - c[0]) - (a[1] - a[0]); }).slice(0, 8)
                 .sort(function (a, c) { return a[0] - c[0]; });
        }
        var row = Math.floor(id / 256), colBase = (id % 256) * 8;
        for (var c2 = 0; c2 < sp.length; c2++) {
          var i4 = (row * 2048 + colBase + c2) * 4;
          // month index → year byte + month nibble. SENTINELS (8/13, yearsV2): a DATELESS start
          // (span begins at MIDX(0,0)) writes byte 1 = "since forever" — real starts live in
          // bytes 2..255 (rasterYearBase leaves byte 2 for the oldest real year). End byte 255 =
          // open-ended / beyond the window. The reader treats both as ±infinity, so a dateless
          // feature (e.g. Current Rail Network) is PERMANENT instead of clamping to the floor
          // and vanishing when the slider goes below it.
          var dateless = sp[c2][0] <= MIDX(0, 0);
          var sY = YB + Math.floor(sp[c2][0] / 12), sM = sp[c2][0] - (sY - YB) * 12;
          var eY = YB + Math.floor(sp[c2][1] / 12), eM = sp[c2][1] - (eY - YB) * 12;
          if (sY <= YB + 2) { sY = YB + 2; sM = 0; }          // base+2 is the floor for REAL dates
          if (sY > YB + 255) { sY = YB + 255; sM = 11; }
          if (eY >= YB + 255) { eY = YB + 255; eM = 11; }     // …and base+255 the ceiling (open-ended lands here)
          if (eY < YB + 2) { eY = YB + 2; eM = 0; }
          d[i4] = dateless ? 1 : (sY - YB);   // 1 = sentinel, 2..255 = real
          d[i4 + 1] = eY - YB;
          d[i4 + 2] = (sM << 4) | eM; // two 4-bit month fields, 0-11 each
          d[i4 + 3] = 255 - (sp[c2][2] || 0);   // in use · colour index = 255 − alpha (the reserved byte, live 8/14)
        }
      }
      ctx.putImageData(im, 0, 0);
      return { cv: cv, rows: rows };
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

    // the whole pyramid, once per mode — fills (sfx "") and borders (sfx "b" → .yearsb2048.png …)
    async function bakePyramid(bordersOnly, sfx) {
      var lvls = [], bytes = 0, widths = [2048, 4096, 8192];
      for (var wi = 0; wi < widths.length; wi++) {
        var W = widths[wi], H = Math.round(W * aspect);
        if (H < 8 || W * H > 80e6) continue;   // VRAM/canvas guard per texture
        var res = bakeIndexCanvas(W, H, 0, 0, W, H, bordersOnly);
        if (!res.inked) continue;
        var up = await uploadPng(res.cv, sfx + String(W));
        if (!up) continue;
        lvls.push({ url: up.url, width: W, height: H, bytes: up.bytes });
        bytes += up.bytes;
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
            var rq = bakeIndexCanvas(W4, H4, qx * (W4 / 2), oy, W4 / 2, chq, bordersOnly);
            if (!rq.inked) continue;
            var upq = await uploadPng(rq.cv, sfx + W4 + "-" + qx + qy);
            if (!upq) continue;
            qtiles.push({ url: upq.url, bytes: upq.bytes,
              bounds: [lonAt(qx * 0.5), latAt((oy + chq) / H4), lonAt((qx + 1) * 0.5), latAt(oy / H4)] });
            bytes += upq.bytes;
          }
        }
        if (qtiles.length) lvls.push({ width: W4, height: H4, tiles: qtiles });
      }
      return { levels: lvls, bytes: bytes };
    }

    var fillP = await bakePyramid(false, "");
    if (!fillP.levels.length) throw new Error("no raster levels baked");
    var out = { levels: fillP.levels, bounds: b, yearBase: YB, yearsV2: true, bytes: fillP.bytes, bakedAt: new Date().toISOString(),
                url: fillP.levels[0].url, width: fillP.levels[0].width, height: fillP.levels[0].height };   // legacy single-image fields
    // companion BORDER raster (option B, 8/8): polygon layers only — mid-drag borders are the only
    // way to tell contiguous features apart. Best-effort: a border-bake failure never voids the fill bake.
    var hasPolys = shapes.some(function (s) { return s.poly; });
    if (hasPolys) {
      try {
        var bp = await bakePyramid(true, "b");
        if (bp.levels.length) { out.borders = { levels: bp.levels, bytes: bp.bytes }; out.bytes += bp.bytes; }
      } catch (e) { console.warn("tilegen: border raster bake failed (fill raster unaffected)", e); }
    }
    // the LUT ships last and alone — its ids are shared by both pyramids above
    var L = buildLut();
    var upL = await uploadPng(L.cv, "lut");
    if (!upL) throw new Error("instant-scrub raster: lookup table upload failed");
    out.indexed = true;
    out.lut = { url: upL.url, width: 2048, height: L.rows, bytes: upL.bytes };
    out.bytes += upL.bytes;
    out.ids = nodes.length - 1;          // distinct shape sets — the LUT's real size on record
    out.shapes = shapes.length;
    out.lutCapped = lutCapped;           // ids whose timeline needed more than 8 stretches
    out.palette = palette;               // index → hex; the reader paints each stretch in its own colour (8/14)
    out.bakeMs = Date.now() - t0;
    if (lutCapped) console.warn("tilegen: " + lutCapped + " of " + out.ids + " pixel timelines held more than 8 stretches — kept the 8 longest");
    if (palOverflow) console.warn("tilegen: raster palette full (250) — " + palOverflow + " era colours fell back to the layer colour");
    console.log("tilegen: indexed instant-scrub raster — " + out.shapes + " shapes, " + out.ids + " ids, LUT " + L.rows + " rows, " + palette.length + " colours, " + Math.round(out.bakeMs / 1000) + "s");
    return out;
  }

  /* ── storage + layer stamping ──────────────────────────────────────────── */

  function publicUrl(projectId, layerId) {
    return SUPABASE_URL + "/storage/v1/object/public/" + BUCKET + "/" + projectId + "/" + layerId + ".pmtiles";
  }

  // test seam: the E2E injects a service-key uploader; real sessions use the signed-in client
  // (needs the storage policies from mapstructor_docs/sql/setup/tilegen-setup.sql — authenticated INSERT/UPDATE on `tiles`)
  var uploadFn = null;
  var WORKER_BASE = "https://mapstructor-worker.mapstructor.workers.dev";
  async function upload(db, projectId, layerId, bytes) {
    if (uploadFn) return uploadFn(projectId, layerId, bytes);
    var path = projectId + "/" + layerId + ".pmtiles";
    var blob = new Blob([bytes], { type: "application/octet-stream" });

    // R2 DUAL-WRITE (7/27 — tiles serve from tiles.mapstructor.com first, Supabase fallback).
    // Invariant: R2 holds the CURRENT archive or NOTHING — a stale R2 copy would shadow the
    // fresh Supabase one (success never fails over). So: DELETE the R2 key BEFORE the Supabase
    // upload; re-PUT after it succeeds. Both R2 legs are best-effort (Supabase stays the
    // publish gate); the Worker enforces ownership of <projectId>.
    var token = null;
    try { token = (await db.auth.getSession()).data.session.access_token; } catch (e) {}
    if (token) try {
      await fetch(WORKER_BASE + "/upload/tiles/" + path, { method: "DELETE", headers: { Authorization: "Bearer " + token } });
    } catch (e) { console.warn("tilegen: R2 pre-delete failed (fallback still correct)", e); }

    // NEVER upsert:true — storage's upsert path needs SELECT visibility on storage.objects and
    // fails as a bogus "violates row-level security" (the 7/15 all-day mystery: plain insert 200,
    // upsert 403 with identical, correct policies). Plain insert; on "already exists" delete+retry.
    var r = await db.storage.from(BUCKET).upload(path, blob, { upsert: false });
    if (r.error && /exist|duplicate/i.test(r.error.message || "")) {
      await db.storage.from(BUCKET).remove([path]);
      r = await db.storage.from(BUCKET).upload(path, blob, { upsert: false });
    }
    if (r.error) throw new Error("tile upload failed: " + r.error.message);

    if (token) try {
      var rw = await fetch(WORKER_BASE + "/upload/tiles/" + path, {
        method: "PUT", body: blob,
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/octet-stream" }
      });
      if (!rw.ok) console.warn("tilegen: R2 mirror write " + rw.status + " — viewers fall back to Supabase for this layer");
    } catch (e) { console.warn("tilegen: R2 mirror write failed — viewers fall back to Supabase for this layer", e); }
  }

  // features (geojson Feature[] with .id = features.feature_id) → archive → storage → the layers
  // row re-pointed at the tile route. The features rows are untouched (still the editable truth).
  async function convertLayer(db, projectId, layerDbId, features, o) {
    o = o || {};
    var status = o.status || function () {};
    var geomKind = o.geomKind || "fill";
    var maxZoom = (geomKind === "circle" || geomKind === "Point") ? 13 : 15;
    var fc = { type: "FeatureCollection", features: features };
    var built = await buildArchive(fc, { maxZoom: maxZoom, tileBudget: o.tileBudget, name: o.name || "layer", status: status, lineLayer: (o.geomKind === "line" || o.geomKind === "LineString") });
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
    // WHICH label column this archive actually carries (8/7). A tileset label can only say what the
    // tiler wrote, so the editor needs to know whether the column the user just picked is in here —
    // null means "only the always-present `label`". Without this it cannot tell a stale archive from
    // a current one and either re-bakes needlessly or shows blank labels.
    rc.tilesLabelField = o.labelField || null;
    try { rc.tilesMaxFid = (features || []).reduce(function (m, f) { var v = Number(f && f.id); return v > m ? v : m; }, 0) || null; } catch (eMx) {}
    // EXPERIMENTAL instant-scrub raster — guarded; remove together with platform/rasterScrub.js
    // A bake that would MISBEHAVE is refused HERE, at bake time — the loader never second-guesses
    // a raster that exists (8/7 rule), so existence is the whole contract, and a re-bake through
    // this code is what clears a stamp that should never have been made. No raster simply means
    // the vector animates itself, which is correct — a wrong raster is far worse than none.
    try {
      var ryNew = null, ryWhy = rasterUnfitReason(geomKind, fc);
      if (!ryWhy) {
        status("Baking instant-scrub raster…");
        ryNew = await bakeYearsRaster(db, projectId, layerDbId, fc);
      } else {
        status("Instant-scrub raster skipped — " + ryWhy + ".");
      }
      if (ryNew) { rc.rasterYears = ryNew; status("Instant-scrub raster ready (" + Math.round(ryNew.bytes / 1024) + " KB)."); }
      else delete rc.rasterYears;   // clear any stale/unfit bake — this layer scrubs as a vector
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
    // tell the RUNNING scrub the bake landed (8/13, "I rebaked, it all went black"): its items
    // and textures otherwise keep pointing at the artifacts this bake just replaced/deleted,
    // and the session scrubs from stale state until a page reload
    try { if (window.MSRasterScrub && window.MSRasterScrub.reload) window.MSRasterScrub.reload(); } catch (eRS) {}
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
    // the colour-by column rides along too (8/13 — tileset color-by on every geometry): the
    // paint match reads it from tile properties, exactly like the label column
    var cbField = (L.raw_config && L.raw_config.colorBy && L.raw_config.colorBy.prop) || null;
    if (cbField === "label" || cbField === lblField) cbField = null;
    var sel = "feature_id, geom, start_date, end_date, label" + (lblField ? ", lblv:custom_fields->>" + lblField : "") + (cbField ? ", cbv:custom_fields->>" + cbField : "");
    // POINTER COPIES (8/13, "These layers are not baking"): a portal-added/copied layer renders
    // the SOURCE's tiles and owns no rows, so baking from L.id found nothing and reported
    // "Nothing to bake". Bake from the layer's DATA ROOT instead (ms_layer_data_root — the same
    // lineage resolver the datasets system uses), writing the tiles under THIS layer's own keys,
    // so a re-baked copy becomes self-sufficient.
    var dataLid = L.id;
    try {
      var probe = await db.from("features").select("feature_id").eq("layer_id", L.id).limit(1);
      if (!probe.error && (!probe.data || !probe.data.length)) {
        var rt = await db.rpc("ms_layer_data_root", { p_layer: L.id });
        if (!rt.error && rt.data && rt.data !== L.id) { dataLid = rt.data; status("“" + (L.name || "layer") + "” is a copy — baking from its source's rows…"); }
      }
    } catch (eRoot) {}
    // KEYSET pagination (feature_id > last) — OFFSET paging hit the DB statement timeout at depth
    // and SILENTLY truncated big layers (NTAD 7/23: baked 214k of 302,771 and called it success).
    // Errors now retry once, then ABORT LOUDLY — a partial archive must never look like a bake.
    // ADAPTIVE page size (8/13): heavy geometry (CShapes ~70KB/row) blows the statement timeout at
    // limit(1000) — shrink the bite on failure instead of aborting; abort only at the floor.
    var feats = [], lastFid = null, retried = false, pageSz = 1000;
    for (;;) {
      var q = db.from("features").select(sel).eq("layer_id", dataLid).order("feature_id").limit(pageSz);
      if (lastFid != null) q = q.gt("feature_id", lastFid);
      var r = await q;
      if (r.error) {
        if (pageSz > 25) { pageSz = Math.max(25, Math.floor(pageSz / 4)); status("Heavy rows — retrying in pages of " + pageSz + "…"); continue; }
        if (!retried) { retried = true; status("Row fetch hiccup — retrying…"); await new Promise(function (rs) { setTimeout(rs, 1500); }); continue; }
        status("⚠ Tile bake ABORTED for “" + (L.name || "layer") + "” — row fetch failed at " + feats.length.toLocaleString() + " rows (" + r.error.message + "). The existing archive is kept; try again.");
        throw new Error("bake aborted: feature fetch failed at " + feats.length + " (" + r.error.message + ")");
      }
      retried = false;
      if (!r.data || !r.data.length) break;
      lastFid = r.data[r.data.length - 1].feature_id;
      r.data.forEach(function (f) {
        // SKINNY TILES (7/16): id + timeline days ONLY. The days MUST stay baked — the slider filter
        // can only act on data physically inside the tile. Dateless features get always-visible bounds.
        var props = {
          DayStart: f.start_date ? +String(f.start_date).slice(0, 10).replace(/-/g, "") || 0 : 0,
          DayEnd: f.end_date ? +String(f.end_date).slice(0, 10).replace(/-/g, "") || 99999999 : 99999999
        };
        if (f.label != null && f.label !== "") props.label = f.label;
        if (lblField && f.lblv != null && f.lblv !== "") props[lblField] = f.lblv;
        if (cbField && f.cbv != null && f.cbv !== "") props[cbField] = f.cbv;
        feats.push({ type: "Feature", id: f.feature_id, properties: props, geometry: f.geom });
      });
      if (feats.length % 25000 < 1000) status("Fetching rows… " + feats.length.toLocaleString());
      if (r.data.length < pageSz) break;
    }
    if (!feats.length) return 0;
    await convertLayer(db, projectId, L.id, feats, { name: L.name, geomKind: L.type, status: status, labelField: lblField });
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
      // 7/23 speedup: TWO queries not three — the count rides along with the max-fid row (adds,
      // deletes, and add+delete pairs all covered), then one newest-updated_at row for edits.
      // COUNT-TIMEOUT TOLERANCE (7/23 eve): exact counts time out on 300k layers; a timeout must
      // NOT read as "dirty" — that silently re-baked the tippecanoe archive with the browser
      // tiler. On timeout, judge by max-fid + updated_at alone (both cheap + index-backed).
      // pointer copies own no rows — cleanliness is judged against the DATA ROOT's rows (8/13),
      // otherwise 0 ≠ tilesFeatureCount read as "dirty" and every Publish re-baked every copy
      var lid = L.id;
      if (rc.tilesFeatureCount > 0) {
        var p0 = await db.from("features").select("feature_id").eq("layer_id", lid).limit(1);
        if (!p0.error && (!p0.data || !p0.data.length)) {
          var rt = await db.rpc("ms_layer_data_root", { p_layer: lid });
          if (!rt.error && rt.data) lid = rt.data;
        }
      }
      var cnt = null, mfid = null;
      var mf = await db.from("features").select("feature_id", { count: "exact" }).eq("layer_id", lid).order("feature_id", { ascending: false }).limit(1);
      if (!mf.error) { cnt = mf.count; mfid = mf.data && mf.data[0] && mf.data[0].feature_id; }
      else {
        var mf2 = await db.from("features").select("feature_id").eq("layer_id", lid).order("feature_id", { ascending: false }).limit(1);
        mfid = mf2.data && mf2.data[0] && mf2.data[0].feature_id;
      }
      if (cnt != null && cnt !== rc.tilesFeatureCount) return false;
      if (rc.tilesMaxFid != null && mfid != null && Number(mfid) !== Number(rc.tilesMaxFid)) return false;
      if (cnt == null && mfid == null) return false;   // could verify NOTHING — doubt still re-bakes
      var nu = await db.from("features").select("updated_at").eq("layer_id", lid).not("updated_at", "is", null).order("updated_at", { ascending: false }).limit(1);
      var newest = nu.data && nu.data[0] && nu.data[0].updated_at;
      if (newest && new Date(newest).getTime() > new Date(rc.tilesGeneratedAt).getTime() - 120000) return false;
      return true;
    } catch (e) { return false; }
  }
  // publish-time "sew up": re-generate every converted layer whose data CHANGED since its last bake
  // (unchanged layers skip — Publish used to re-bake everything and was "really heavy"). Returns how
  // many layers were regenerated. 7/23: the clean checks for ALL layers run CONCURRENTLY up front
  // (pool of 4 — Supabase throttles bigger bursts) so Publish no longer crawls layer-by-layer just
  // to discover nothing changed; only actually-dirty layers then bake, one at a time.
  async function sewUpProject(db, projectId, statusFn) {
    var status = statusFn || function () {};
    var pl = await db.from("project_layers").select("layer_id, layers(*)").eq("project_id", projectId);   // * so fold_state rides along pre/post C0
    if (pl.error || !pl.data) return 0;
    // FOLDED layers are excluded: their rows are gone by design, so a "dirty" verdict here would
    // re-bake from zero rows. Re-folding them is Publish's job once deltas exist (fold-plan C5).
    var todo = pl.data.map(function (r) { return r.layers; }).filter(function (l) { return l && l.raw_config && l.raw_config.pmtiles && l.fold_state !== "folded"; });
    if (!todo.length) return 0;
    status("Checking " + todo.length + " tiled layer" + (todo.length === 1 ? "" : "s") + " for changes…");
    var clean = new Array(todo.length), next = 0;
    async function worker() {
      for (;;) { var i = next++; if (i >= todo.length) return; clean[i] = await layerTilesClean(db, todo[i]); }
    }
    await Promise.all([worker(), worker(), worker(), worker()]);
    var done = 0, skipped = 0;
    for (var i = 0; i < todo.length; i++) {
      if (clean[i]) { skipped++; continue; }
      if (await sewUpLayer(db, projectId, todo[i], status)) done++;
    }
    status(skipped ? (skipped + " unchanged layer" + (skipped === 1 ? "" : "s") + " skipped; " + done + " re-baked.") : (done + " layer" + (done === 1 ? "" : "s") + " re-baked."));
    return done;
  }

  window.MSTileGen = {
    LIMITS: LIMITS,
    DIET: DIET,   // { dropPx } — live-tweakable (speedlab)
    bakeYearsRaster: bakeYearsRaster,   // exposed for rebake harnesses + the future speedlab tiler playground
    // exposed 8/16 so the CLOUD tiler asks THIS rule whether a layer may have a raster, instead of
    // carrying its own copy that would drift (scripts/bake-scrub-raster.mjs drives this file
    // headlessly — the format has exactly one definition and exactly one reader)
    rasterUnfitReason: rasterUnfitReason,
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
