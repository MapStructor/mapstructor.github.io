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

  /* ── readSchema(file) → [{name, table, keys, geom}] WITHOUT reading the file (owner 10/27: the
     import must ask which columns hold the dates — for a 200 MB package too, which never enters
     this tab). SQLite keeps every CREATE TABLE statement in its schema b-tree starting at page 1,
     so the table names and column names are in the first page (or the few pages it points at).
     sql.js cannot open a prefix of a file (it validates every root page against the page count),
     so this walks the schema b-tree by hand: page header → cell pointers → record → the sql text.
     A CREATE TABLE statement always fits in one cell for a feature table (no overflow handling). */
  var GEOM_TYPES = /^(GEOMETRY|POINT|LINESTRING|POLYGON|MULTIPOINT|MULTILINESTRING|MULTIPOLYGON|GEOMETRYCOLLECTION|CURVE|SURFACE)/i;
  async function readSchema(file) {
    async function bytes(off, len) { return new Uint8Array(await file.slice(off, off + len).arrayBuffer()); }
    var hdr = await bytes(0, 100);
    if (String.fromCharCode.apply(null, hdr.subarray(0, 15)) !== 'SQLite format 3') throw new Error('not a SQLite file');
    var ps = (hdr[16] << 8) | hdr[17]; if (ps === 1) ps = 65536;
    var usable = ps - hdr[20];
    function varint(b, o) { var v = 0, i = 0; for (; i < 9; i++) { var c = b[o + i]; if (i < 8) { v = v * 128 + (c & 0x7f); if (!(c & 0x80)) { i++; break; } } else { v = v * 256 + c; i++; } } return [v, o + i]; }
    function u16(b, o) { return (b[o] << 8) | b[o + 1]; }
    function u32(b, o) { return ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3]; }
    var rows = [], dec = new TextDecoder();
    async function walk(no, depth) {
      if (depth > 8) return;
      var p = await bytes((no - 1) * ps, ps), h = no === 1 ? 100 : 0, type = p[h];
      var ncell = u16(p, h + 3), ptrs = h + (type === 5 || type === 2 ? 12 : 8);
      if (type === 5) { for (var i = 0; i < ncell; i++) await walk(u32(p, u16(p, ptrs + 2 * i)), depth + 1); await walk(u32(p, h + 8), depth + 1); return; }
      if (type !== 13) return;
      for (var c = 0; c < ncell; c++) {
        var off = u16(p, ptrs + 2 * c);
        var pl = varint(p, off), plen = pl[0]; var ro = varint(p, pl[1]); off = ro[1];
        var maxLocal = usable - 35, minLocal = Math.floor((usable - 12) * 32 / 255) - 23, local = plen;
        if (plen > maxLocal) { local = minLocal + ((plen - minLocal) % (usable - 4)); if (local > maxLocal) local = minLocal; }
        var rec = p.subarray(off, off + local);
        var hl = varint(rec, 0), hlen = hl[0], ho = hl[1], types = [];
        while (ho < hlen) { var tv = varint(rec, ho); types.push(tv[0]); ho = tv[1]; }
        var vo = hlen, vals = [];
        for (var t = 0; t < types.length; t++) {
          var st = types[t], len = 0, v = null;
          if (st >= 1 && st <= 6) { len = [1, 2, 3, 4, 6, 8][st - 1]; v = 0; for (var k = 0; k < Math.min(len, 6); k++) v = v * 256 + rec[vo + k]; }
          else if (st === 7) len = 8;
          else if (st === 8) v = 0; else if (st === 9) v = 1;
          else if (st >= 12) { len = Math.floor((st - 12) / 2); v = st % 2 ? dec.decode(rec.subarray(vo, vo + len)) : null; }
          vals.push(v); vo += len;
        }
        rows.push({ type: vals[0], name: vals[1], sql: vals[4] });
      }
    }
    await walk(1, 0);
    var out = [];
    rows.forEach(function (r) {
      if (r.type !== 'table' || !r.sql || /^(gpkg_|sqlite_|rtree_)/i.test(r.name || '')) return;
      var body = r.sql.slice(r.sql.indexOf('(') + 1, r.sql.lastIndexOf(')'));
      var parts = [], depth = 0, cur = '', inq = null;
      for (var i = 0; i < body.length; i++) {
        var ch = body[i];
        if (inq) { cur += ch; if (ch === inq) inq = null; continue; }
        if (ch === '"' || ch === "'" || ch === '`' || ch === '[') { inq = ch === '[' ? ']' : ch; cur += ch; continue; }
        if (ch === '(') depth++; if (ch === ')') depth--;
        if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; } else cur += ch;
      }
      if (cur.trim()) parts.push(cur);
      var cols = [], geoms = [];
      parts.forEach(function (pt) {
        var s = pt.trim(); if (/^(CONSTRAINT|PRIMARY|FOREIGN|UNIQUE|CHECK)\b/i.test(s)) return;
        var m = /^("([^"]*)"|'([^']*)'|`([^`]*)`|\[([^\]]*)\]|([A-Za-z_][\w$]*))\s*([\s\S]*)$/.exec(s); if (!m) return;
        var name = m[2] != null ? m[2] : m[3] != null ? m[3] : m[4] != null ? m[4] : m[5] != null ? m[5] : m[6], rest = m[7] || '';
        if (/PRIMARY\s+KEY/i.test(rest)) return;
        if (GEOM_TYPES.test(rest.trim())) geoms.push(name); else cols.push(name);
      });
      if (geoms.length) out.push({ name: r.name, table: r.name, keys: cols, geom: geoms[0] });
    });
    return out;
  }

  window.MSGpkg = { readParts: readParts, readSchema: readSchema, decodeGeometry: decodeGeometry, SQLJS_BASE: SQLJS_BASE };
})();
