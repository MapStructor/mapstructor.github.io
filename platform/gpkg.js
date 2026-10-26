/* platform/gpkg.js — read a GeoPackage IN THE BROWSER (owner 10/26: "we need to add gpkg").
   A GeoPackage is a SQLite database, so this loads sql.js (SQLite compiled to WebAssembly) on
   demand, reads the package's own catalogue (gpkg_contents / gpkg_geometry_columns /
   gpkg_spatial_ref_sys) and walks each feature table row by row, decoding the GeoPackage
   binary geometry (a small header in front of standard well-known binary) into GeoJSON.
   Every feature table becomes one part, {name, fc, srs}; the importer turns parts into layers
   exactly as it does KML folders. Projected tables carry their CRS as WKT in fc.__msPrj and the
   importer's one reprojection rule (normalizeImportFC → proj4) places them, same as a .prj.

   sql.js holds the WHOLE file in memory, so the importer only sends files under its browser
   ceiling here (editing.js GPKG_BROWSER_MAX_BYTES); bigger packages go to the cloud path, where
   GDAL reads them natively. Loaded lazily — nothing here runs until a .gpkg is picked. */
(function () {
  if (window.MSGpkg) return;
  var SQLJS_BASE = 'https://cdn.jsdelivr.net/npm/sql.js@1.12.0/dist/';
  var _sql = null;
  function loadSql() {
    if (_sql) return _sql;
    _sql = new Promise(function (resolve, reject) {
      var s = document.createElement('script'); s.src = SQLJS_BASE + 'sql-wasm.js'; s.async = true;
      s.onload = function () {
        try { window.initSqlJs({ locateFile: function (f) { return SQLJS_BASE + f; } }).then(resolve, reject); }
        catch (e) { reject(e); }
      };
      s.onerror = function () { reject(new Error('could not load sql.js from ' + SQLJS_BASE)); };
      document.head.appendChild(s);
    });
    return _sql;
  }

  /* ── GeoPackage binary → GeoJSON geometry ─────────────────────────────────────────────────
     Header (GeoPackage spec §2.1.3): "GP", version, flags (bit 0 = byte order, bits 1-3 =
     envelope size code, bit 4 = empty), srs_id (int32), optional envelope, then WKB. The WKB
     may be ISO (type + 1000/2000/3000 for Z/M/ZM) or EWKB (0x80000000 Z, 0x40000000 M,
     0x20000000 SRID). Z and M are read and dropped — the map is two-dimensional. */
  var ENVELOPE_BYTES = [0, 32, 48, 48, 64];
  function decodeGeometry(u8) {
    if (!u8 || u8.length < 8) return null;
    if (u8[0] !== 0x47 || u8[1] !== 0x50) return null;   // not "GP"
    var flags = u8[3];
    if (flags & 0x10) return null;                        // empty geometry
    var envCode = (flags >> 1) & 7;
    var envBytes = envCode < ENVELOPE_BYTES.length ? ENVELOPE_BYTES[envCode] : 0;
    var off = 8 + envBytes;
    var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    var r = readWkb(dv, off);
    return r ? r.geom : null;
  }
  function readWkb(dv, off) {
    var little = dv.getUint8(off) === 1; off += 1;
    var t = dv.getUint32(off, little); off += 4;
    var hasZ = false, hasM = false;
    if (t & 0x80000000) { hasZ = true; t &= ~0x80000000; }
    if (t & 0x40000000) { hasM = true; t &= ~0x40000000; }
    if (t & 0x20000000) { t &= ~0x20000000; off += 4; }   // EWKB SRID — skip it
    if (t >= 3000) { hasZ = true; hasM = true; t -= 3000; }
    else if (t >= 2000) { hasM = true; t -= 2000; }
    else if (t >= 1000) { hasZ = true; t -= 1000; }
    var dims = 2 + (hasZ ? 1 : 0) + (hasM ? 1 : 0);
    function pt() { var x = dv.getFloat64(off, little), y = dv.getFloat64(off + 8, little); off += 8 * dims; return [x, y]; }
    function ring() { var n = dv.getUint32(off, little); off += 4; var a = new Array(n); for (var i = 0; i < n; i++) a[i] = pt(); return a; }
    var geom;
    switch (t) {
      case 1: geom = { type: 'Point', coordinates: pt() }; break;
      case 2: geom = { type: 'LineString', coordinates: ring() }; break;
      case 3: { var nr = dv.getUint32(off, little); off += 4; var rings = []; for (var i = 0; i < nr; i++) rings.push(ring()); geom = { type: 'Polygon', coordinates: rings }; break; }
      case 4: case 5: case 6: case 7: {
        var n = dv.getUint32(off, little); off += 4; var parts = [];
        for (var j = 0; j < n; j++) { var sub = readWkb(dv, off); if (!sub) return null; off = sub.off; parts.push(sub.geom); }
        if (t === 7) geom = { type: 'GeometryCollection', geometries: parts };
        else geom = { type: t === 4 ? 'MultiPoint' : t === 5 ? 'MultiLineString' : 'MultiPolygon', coordinates: parts.map(function (g) { return g.coordinates; }) };
        break;
      }
      default: return null;   // curves, surfaces, TINs — not drawn here
    }
    return { geom: geom, off: off };
  }

  function q(db, sql, params) {
    var out = [], st = db.prepare(sql, params || []);
    try { while (st.step()) out.push(st.getAsObject()); } finally { st.free(); }
    return out;
  }
  function geographic4326(srs) {
    if (!srs) return true;
    if (String(srs.organization || '').toUpperCase() === 'EPSG' && Number(srs.organization_coordsys_id) === 4326) return true;
    return false;
  }

  /* readParts(file, {onProgress}) → [{name, table, fc, srs, count}]
     onProgress(text) is called per table so the importer's checklist can show it. */
  async function readParts(file, opts) {
    opts = opts || {};
    var SQL = await loadSql();
    var buf = new Uint8Array(await file.arrayBuffer());
    var db;
    try { db = new SQL.Database(buf); } catch (e) { throw new Error('not a readable GeoPackage (' + (e && e.message || e) + ')'); }
    try {
      var tables;
      try {
        tables = q(db, "SELECT c.table_name AS t, c.identifier AS label, c.srs_id AS srs, g.column_name AS gcol, g.geometry_type_name AS gtype " +
          "FROM gpkg_contents c JOIN gpkg_geometry_columns g ON g.table_name = c.table_name WHERE c.data_type = 'features' ORDER BY c.table_name");
      } catch (eCat) { throw new Error('no GeoPackage catalogue in this file (gpkg_contents)'); }
      if (!tables.length) throw new Error('this GeoPackage holds no feature tables (rasters or attributes only)');
      var parts = [];
      for (var i = 0; i < tables.length; i++) {
        var t = tables[i];
        var srs = null;
        try { srs = q(db, 'SELECT srs_id, organization, organization_coordsys_id, definition FROM gpkg_spatial_ref_sys WHERE srs_id = ?', [t.srs])[0] || null; } catch (eS) {}
        var total = 0; try { total = q(db, 'SELECT count(*) AS n FROM "' + String(t.t).replace(/"/g, '""') + '"')[0].n; } catch (eN) {}
        // the table's primary key (usually "fid") is SQLite's row number, not an attribute — the cloud path (GDAL) drops it too
        var pk = {}; try { q(db, 'PRAGMA table_info("' + String(t.t).replace(/"/g, '""') + '")').forEach(function (c) { if (c.pk) pk[c.name] = true; }); } catch (ePk) {}
        if (opts.onProgress) opts.onProgress('Reading table ' + (i + 1) + '/' + tables.length + ': ' + (t.label || t.t) + ' (' + Number(total).toLocaleString('en-US') + ' features)…');
        var feats = [], skipped = 0;
        var st = db.prepare('SELECT * FROM "' + String(t.t).replace(/"/g, '""') + '"');
        try {
          while (st.step()) {
            var row = st.getAsObject();
            var gb = row[t.gcol];
            var geom = (gb instanceof Uint8Array) ? decodeGeometry(gb) : null;
            if (!geom) { skipped++; continue; }
            var props = {};
            for (var k in row) {
              if (k === t.gcol || pk[k]) continue;
              var v = row[k];
              if (v instanceof Uint8Array) continue;   // other blobs are not attributes we can show
              props[k] = v;
            }
            feats.push({ type: 'Feature', geometry: geom, properties: props });
          }
        } finally { st.free(); }
        var fc = { type: 'FeatureCollection', features: feats };
        if (srs && !geographic4326(srs) && srs.definition && !/^undefined$/i.test(String(srs.definition).trim())) fc.__msPrj = String(srs.definition).trim();
        parts.push({ name: t.label || t.t, table: t.t, fc: fc, srs: srs, count: feats.length, skipped: skipped });
      }
      return parts;
    } finally { try { db.close(); } catch (e) {} }
  }

  window.MSGpkg = { readParts: readParts, decodeGeometry: decodeGeometry, SQLJS_BASE: SQLJS_BASE };
})();
