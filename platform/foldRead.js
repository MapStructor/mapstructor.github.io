/* foldRead.js — read ONE feature out of a folded layer's GeoParquet archive, over HTTP ranges.
 *
 * WHY THIS FILE EXISTS. Owner 10/3: "I thought this was in the architecture from the beginning.
 * We need to make this universal, at a fundamental level, and where bugs would not be possible
 * with it." Until now, opening one feature of a folded layer fetched the layer's WHOLE GeoJSON
 * archive — 350 MB on the Atlas layer — because the only read the editor knew was "download the
 * file and look inside". The 9/29 duplicate-delta bug was a symptom of exactly that: an operation
 * slow enough that people repeat it.
 *
 * MEASURED before this was written (10/3, the real Atlas artifact, EXPLAIN ANALYZE HTTP stats):
 *   whole GeoJSON archive . 350.1 MB  + ~10.6 s of JSON.parse
 *   this module, old bake .  77.8 MB  (one row group — DuckDB must read the whole geom column)
 *   this module, new bake .   0.8 MB  (2 MB row groups, feature_id-ordered → zone-map skipping)
 * The bake half lives in scripts/fold-parquet.py; artifacts upgrade as layers re-publish.
 *
 * THE SEAM. This is the ONE place the platform reads a single folded feature. It either returns
 * the feature in the exact shape the GeoJSON archive would have given ({id, properties,
 * geometry}), returns null after a query that RAN and found nothing, or THROWS — and a throw is
 * the caller's signal to fall back to the whole-archive path, which stays alive as the proven
 * slow road. No caller can accidentally fetch the archive "for speed", because fetching the
 * archive is not something this module can express.
 *
 * VERIFIED against the vendored engine (10/3, headless, the real artifact): DuckDB-WASM 1.32.0
 * reads the GEOMETRY column as plain Binary WKB — no spatial extension exists in the browser
 * build, so the WKB→GeoJSON conversion is done here, in ~90 lines, and the gate compares its
 * output coordinate-for-coordinate against the GeoJSON archive's.
 *
 * Self-contained like msdBadge.js: one <script>, uses MSBigTable's engine (one 34 MB WASM for
 * the whole app, never two). Deleting this file and its script tag reverts the editor to the
 * whole-archive path with nothing left behind.
 */
(function () {
  'use strict';
  if (window.MSFoldRead) return;

  /* ── WKB → GeoJSON ────────────────────────────────────────────────────────
     ISO WKB, 2D, both byte orders, the seven standard types; EWKB SRID flags are skipped, Z/M
     throw (fold archives are baked from GeoJSON, which this platform stores 2D). Every throw is
     caught by feature() below and becomes "use the archive instead" — a wrong parse can lose
     speed, never geometry. */
  function wkbToGeoJSON(bytes) {
    var u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    var pos = 0;
    function need(n) { if (pos + n > u8.byteLength) throw new Error('WKB truncated at byte ' + pos); }
    function point(le) { need(16); var x = dv.getFloat64(pos, le), y = dv.getFloat64(pos + 8, le); pos += 16; return [x, y]; }
    function ring(le) { need(4); var n = dv.getUint32(pos, le); pos += 4; var out = new Array(n); for (var i = 0; i < n; i++) out[i] = point(le); return out; }
    function geom() {
      need(5);
      var le = dv.getUint8(pos) === 1; pos += 1;
      var t = dv.getUint32(pos, le); pos += 4;
      if (t & 0x80000000 || t & 0x40000000) throw new Error('WKB carries Z/M (EWKB flags)');
      if (t & 0x20000000) { t = (t & ~0x20000000) >>> 0; need(4); pos += 4; }   // EWKB SRID: skip it
      if (t > 7) throw new Error('WKB type ' + t + ' (Z/M or unknown)');        // ISO Z/M land at 1001+
      var i, n, out;
      switch (t) {
        case 1: return { type: 'Point', coordinates: point(le) };
        case 2: return { type: 'LineString', coordinates: ring(le) };
        case 3:
          need(4); n = dv.getUint32(pos, le); pos += 4; out = new Array(n);
          for (i = 0; i < n; i++) out[i] = ring(le);
          return { type: 'Polygon', coordinates: out };
        case 4: case 5: case 6: {
          need(4); n = dv.getUint32(pos, le); pos += 4; out = new Array(n);
          for (i = 0; i < n; i++) out[i] = geom().coordinates;   // each part has its own header
          return { type: ['MultiPoint', 'MultiLineString', 'MultiPolygon'][t - 4], coordinates: out };
        }
        case 7: {
          need(4); n = dv.getUint32(pos, le); pos += 4; out = new Array(n);
          for (i = 0; i < n; i++) out[i] = geom();
          return { type: 'GeometryCollection', geometries: out };
        }
        default: throw new Error('WKB type ' + t);
      }
    }
    var g = geom();
    return g;
  }

  /* ── the registered-archive cache ─────────────────────────────────────────
     One registration per (url, ver): the footer is read once and DuckDB range-reads from there.
     A new bake means a new ver means a new virtual file — stale layouts cannot be re-used. */
  var _open = {};   // url + '\n' + ver → Promise<{conn, name, fields, fidNumeric}>
  var _seq = 0;
  function openArchive(url, ver) {
    var key = url + '\n' + ver;
    if (_open[key]) return _open[key];
    _open[key] = (async function () {
      if (!window.MSBigTable || !MSBigTable.ensureEngine) throw new Error('MSBigTable engine unavailable');
      var e = await MSBigTable.ensureEngine();
      var name = 'foldgeo_' + (++_seq) + '.parquet';
      await e.adb.registerFileURL(name, url + '?v=' + encodeURIComponent(ver || '0'), e.duckdb.DuckDBDataProtocol.HTTP, false);
      /* The footer read is RACED for the same reason bigtable races its engine init: a fetch the
         worker never answers would wedge this MEMOIZED promise, and then every later click on the
         layer awaits the same dead object. 30 s is generous for a footer (a few hundred KB). */
      var head = await Promise.race([
        e.conn.query("SELECT * FROM read_parquet('" + name + "') LIMIT 0"),
        new Promise(function (_r, rej) { setTimeout(function () { rej(new Error('parquet footer read timed out')); }, 30000); })
      ]);
      var fields = head.schema.fields.map(function (f) { return { name: f.name, type: String(f.type) }; });
      var fid = null;
      fields.forEach(function (f) { if (f.name === 'feature_id') fid = f; });
      if (!fid) throw new Error('archive parquet has no feature_id column');
      /* The literal must match the COLUMN's type, not be CAST over it — a CAST on the column
         would blind the zone maps and every query would read every row group again. */
      return { conn: e.conn, name: name, fields: fields, fidNumeric: /int|float|double|decimal/i.test(fid.type) };
    })();
    _open[key].catch(function () { delete _open[key]; });   // a failed open may be retried
    return _open[key];
  }

  var GEOM_NAMES = { geom: 1, geometry: 1, wkb_geometry: 1 };
  var CF = 'c:';   // the attr sidecar's custom_fields prefix — one spelling, same as bigtable.js

  /* One feature, by its ARCHIVE id, in the GeoJSON archive's own shape:
     GEOMETRY from the geo parquet, ATTRIBUTES from the attr sidecar.
     Returns {id, properties, geometry} · null (the queries ran; the id is not in the artifacts) ·
     throws (anything else — the caller falls back to the whole archive).

     WHY TWO FILES. The geo parquet's non-geometry columns are GDAL's reading of the archive, and
     GDAL's reading is not faithful: measured 10/3, ST_Read turns the date string "1867-03-30"
     into DATE 1867-03-31 — every date in every existing geo parquet is one day late (the bake now
     passes DATE_AS_STRING=YES, but the shipped artifacts only heal on re-publish). The attr
     sidecar has no such translator: bigtable's bake String()-coerces every standard column, so
     what it stores is what the database row said, byte for byte — verified on the real Atlas
     artifact: sidecar '1867-03-30', geo parquet DATE 1867-03-31, archive '1867-03-30'. The one
     attribute the sidecar does not carry is image_url, which is never date-typed, so THAT one is
     taken from the geo parquet when present. A missing sidecar row is a THROW, not a partial
     answer — the fast road serves faithful answers or none. */
  async function feature(geoUrl, attrUrl, ver, featureId) {
    var geo = await openArchive(geoUrl, ver);
    var lit;
    if (geo.fidNumeric) {
      lit = String(featureId);
      if (!/^-?\d+(\.\d+)?$/.test(lit)) return null;   // a non-numeric id cannot be in a numeric column
    } else {
      lit = "'" + String(featureId).replace(/'/g, "''") + "'";
    }
    var geomCol = null, extraCols = [];
    geo.fields.forEach(function (f) {
      if (GEOM_NAMES[f.name] && /Binary/i.test(f.type)) geomCol = f.name;
      if (f.name === 'image_url') extraCols.push('"image_url"');
    });
    if (!geomCol) throw new Error('the geo parquet has no geometry column');
    var gq = await geo.conn.query('SELECT "feature_id", "' + geomCol + '"' + (extraCols.length ? ', ' + extraCols.join(', ') : '') +
      " FROM read_parquet('" + geo.name + "') WHERE feature_id = " + lit + ' LIMIT 1');
    var grows = gq.toArray();
    if (!grows.length) return null;
    var grow = grows[0].toJSON();
    var geomBytes = grow[geomCol];
    if (!geomBytes || !geomBytes.length) throw new Error('feature ' + featureId + ' has no geometry bytes in the parquet');

    var attr = await openArchive(attrUrl, ver);   // sidecar feature_id is VARCHAR by construction, but ask its schema anyway
    var alit = attr.fidNumeric ? String(Number(featureId)) : "'" + String(featureId).replace(/'/g, "''") + "'";
    var aq = await attr.conn.query("SELECT * FROM read_parquet('" + attr.name + "') WHERE feature_id = " + alit + ' LIMIT 1');
    var arows = aq.toArray();
    if (!arows.length) throw new Error('feature ' + featureId + ' is in the geo parquet but not the attr sidecar');
    var arow = arows[0].toJSON();
    var props = {};
    for (var i = 0; i < attr.fields.length; i++) {
      var f = attr.fields[i], v = arow[f.name];
      if (v == null) continue;                                     // the archive omits absent keys
      if (typeof v === 'bigint') v = Number(v);
      var key = f.name.indexOf(CF) === 0 ? f.name.slice(CF.length) : f.name;
      props[key] = v;                                              // archive props are flat: std + custom side by side
    }
    var iu = grow.image_url;
    if (iu != null && typeof iu === 'string' && props.image_url == null) props.image_url = iu;
    var id = grow.feature_id;
    if (typeof id === 'bigint') id = Number(id);
    return { id: id != null ? id : featureId, properties: props, geometry: wkbToGeoJSON(geomBytes) };
  }

  window.MSFoldRead = { feature: feature, wkbToGeoJSON: wkbToGeoJSON };
})();
