/* geoExport.js — a FeatureCollection → every GIS format the download offers (10/6).

   Owner: "The GIS data should be an additional option, not by default, with parquet being the
   default, but offering all GIS formats." The platform runs in the browser and DuckDB-WASM's
   spatial extension LOADS but its GDAL writers cannot write a file there (measured 10/6:
   GPKG "file is not a database", Shapefile "no such file", KML 1 byte — test/formats/lab.html),
   so each format is written here, in plain JS, at download-build time:

     GeoParquet  — WKB geometry column + the `geo` file metadata, through DuckDB's parquet writer
                   (the one engine the platform already vendors; no spatial extension needed)
     GeoJSON     — JSON.stringify, the caller's job
     CSV         — one row per feature, attributes as columns, geometry as WKT in the last column
     KML         — Placemark per feature with ExtendedData (Google Earth and friends)
     Shapefile   — @mapbox/shp-write (loaded from a CDN on first use): a zip of .shp/.shx/.dbf/.prj,
                   one set per geometry type, which is how shapefiles are handed around anyway
     GeoPackage  — sql.js (SQLite compiled to WASM, loaded from a CDN on first use) builds the
                   .gpkg in memory: the three required gpkg_* tables plus one feature table whose
                   geometry is the GeoPackage binary header (magic, flags, SRS 4326, XY envelope)
                   followed by the same WKB as above (10/7, owner: "Yep").

   Loaded on demand by download.js (like bigtable.js). Nothing here touches the network except the
   shapefile library fetch. */
(function () {
  "use strict";
  if (window.MSGeoExport) return;

  var SHPWRITE_URLS = ["https://cdn.jsdelivr.net/npm/@mapbox/shp-write@0.4.3/shpwrite.js", "https://unpkg.com/@mapbox/shp-write@0.4.3/shpwrite.js"];

  /* ── WKB (little-endian, 2D) ──────────────────────────────────────────── */
  var WKB_TYPE = { Point: 1, LineString: 2, Polygon: 3, MultiPoint: 4, MultiLineString: 5, MultiPolygon: 6, GeometryCollection: 7 };
  function wkbSize(g) {
    var t = g.type, c = g.coordinates;
    if (t === "Point") return 1 + 4 + 16;
    if (t === "LineString") return 1 + 4 + 4 + 16 * c.length;
    if (t === "Polygon") { var s = 1 + 4 + 4; for (var i = 0; i < c.length; i++) s += 4 + 16 * c[i].length; return s; }
    if (t === "MultiPoint" || t === "MultiLineString" || t === "MultiPolygon") {
      var inner = t.slice(5), s2 = 1 + 4 + 4;
      for (var j = 0; j < c.length; j++) s2 += wkbSize({ type: inner, coordinates: c[j] });
      return s2;
    }
    if (t === "GeometryCollection") { var s3 = 1 + 4 + 4; (g.geometries || []).forEach(function (x) { s3 += wkbSize(x); }); return s3; }
    throw new Error("unsupported geometry " + t);
  }
  function wkbWrite(g, dv, o) {
    var t = g.type, c = g.coordinates;
    dv.setUint8(o, 1); dv.setUint32(o + 1, WKB_TYPE[t], true); o += 5;
    function pt(p) { dv.setFloat64(o, p[0], true); dv.setFloat64(o + 8, p[1], true); o += 16; }
    function ring(r) { dv.setUint32(o, r.length, true); o += 4; r.forEach(pt); }
    if (t === "Point") pt(c);
    else if (t === "LineString") ring(c);
    else if (t === "Polygon") { dv.setUint32(o, c.length, true); o += 4; c.forEach(ring); }
    else if (t === "MultiPoint" || t === "MultiLineString" || t === "MultiPolygon") {
      var inner = t.slice(5);
      dv.setUint32(o, c.length, true); o += 4;
      c.forEach(function (part) { o = wkbWrite({ type: inner, coordinates: part }, dv, o); });
    } else if (t === "GeometryCollection") {
      var gs = g.geometries || [];
      dv.setUint32(o, gs.length, true); o += 4;
      gs.forEach(function (x) { o = wkbWrite(x, dv, o); });
    }
    return o;
  }
  function toWkb(g) {
    if (!g || !g.type) return null;
    var buf = new ArrayBuffer(wkbSize(g)), dv = new DataView(buf);
    wkbWrite(g, dv, 0);
    return new Uint8Array(buf);
  }

  /* ── WKT ────────────────────────────────────────────────────────────────── */
  function wktCoords(c) { return c.map(function (p) { return p[0] + " " + p[1]; }).join(", "); }
  function toWkt(g) {
    if (!g || !g.type) return "";
    var t = g.type, c = g.coordinates;
    if (t === "Point") return "POINT (" + c[0] + " " + c[1] + ")";
    if (t === "LineString") return "LINESTRING (" + wktCoords(c) + ")";
    if (t === "Polygon") return "POLYGON (" + c.map(function (r) { return "(" + wktCoords(r) + ")"; }).join(", ") + ")";
    if (t === "MultiPoint") return "MULTIPOINT (" + c.map(function (p) { return "(" + p[0] + " " + p[1] + ")"; }).join(", ") + ")";
    if (t === "MultiLineString") return "MULTILINESTRING (" + c.map(function (l) { return "(" + wktCoords(l) + ")"; }).join(", ") + ")";
    if (t === "MultiPolygon") return "MULTIPOLYGON (" + c.map(function (pg) { return "(" + pg.map(function (r) { return "(" + wktCoords(r) + ")"; }).join(", ") + ")"; }).join(", ") + ")";
    if (t === "GeometryCollection") return "GEOMETRYCOLLECTION (" + (g.geometries || []).map(toWkt).join(", ") + ")";
    return "";
  }

  /* ── columns: every property key, typed by a full scan (DOUBLE only if every value is a number) ── */
  function columns(fc) {
    var keys = [], seen = {}, num = {}, other = {};
    (fc.features || []).forEach(function (f) {
      var p = f.properties || {};
      for (var k in p) {
        if (!seen[k]) { seen[k] = 1; keys.push(k); }
        var v = p[k]; if (v == null || v === "") continue;
        if (typeof v === "number" && isFinite(v)) num[k] = true; else other[k] = true;
      }
    });
    var types = {};
    keys.forEach(function (k) { types[k] = (num[k] && !other[k]) ? "DOUBLE" : "VARCHAR"; });
    return { keys: keys, types: types };
  }
  function cell(v) { return v == null ? null : (typeof v === "object" ? JSON.stringify(v) : v); }
  function fid(f, i) { return f.id != null ? f.id : ((f.properties || {}).feature_id != null ? f.properties.feature_id : i + 1); }

  /* ── GeoParquet ─────────────────────────────────────────────────────────── */
  function b64(u8) { var s = ""; for (var i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); }
  function sq(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }
  function qi(s) { return '"' + String(s).replace(/"/g, '""') + '"'; }
  async function toGeoParquet(fc, tag) {
    if (!window.MSBigTable || !MSBigTable.ensureEngine) throw new Error("bigtable.js (DuckDB) is not loaded");
    var e = await MSBigTable.ensureEngine();
    var col = columns(fc), feats = fc.features || [];
    var gtypes = {}, bbox = [Infinity, Infinity, -Infinity, -Infinity];
    var rows = new Array(feats.length);
    for (var i = 0; i < feats.length; i++) {
      var f = feats[i], p = f.properties || {}, o = { feature_id: String(fid(f, i)) };
      for (var j = 0; j < col.keys.length; j++) {
        var k = col.keys[j], v = cell(p[k]);
        o["p_" + j] = v == null ? null : (col.types[k] === "DOUBLE" ? v : String(v));
      }
      var g = f.geometry;
      if (g && g.type) {
        gtypes[g.type] = 1;
        o.wkb = b64(toWkb(g));
        (function walk(c) { if (typeof c[0] === "number") { if (c[0] < bbox[0]) bbox[0] = c[0]; if (c[1] < bbox[1]) bbox[1] = c[1]; if (c[0] > bbox[2]) bbox[2] = c[0]; if (c[1] > bbox[3]) bbox[3] = c[1]; } else c.forEach(walk); })(g.coordinates || []);
      } else o.wkb = null;
      rows[i] = o;
    }
    var name = "gx_" + String(tag || "x").replace(/[^A-Za-z0-9_-]/g, "_");
    var jname = name + ".json", pname = name + ".parquet";
    var cols = ["'feature_id': 'VARCHAR'"].concat(col.keys.map(function (k, j) { return sq("p_" + j) + ": " + sq(col.types[k]); })).concat(["'wkb': 'VARCHAR'"]).join(", ");
    var sel = ["feature_id"].concat(col.keys.map(function (k, j) { return qi("p_" + j) + " AS " + qi(k); })).concat(["from_base64(wkb)::BLOB AS geometry"]).join(", ");
    await e.adb.registerFileText(jname, JSON.stringify(rows));
    rows = null;
    var geo = { version: "1.0.0", primary_column: "geometry", columns: { geometry: { encoding: "WKB", geometry_types: Object.keys(gtypes), crs: null } } };
    if (isFinite(bbox[0])) geo.columns.geometry.bbox = bbox;
    try {
      await e.conn.query("CREATE OR REPLACE TABLE gx_t AS SELECT " + sel + " FROM read_json(" + sq(jname) + ", format='array', columns={" + cols + "})");
      var kv = ", KV_METADATA {'geo': " + sq(JSON.stringify(geo)) + "}";
      try { await e.conn.query("COPY gx_t TO " + sq(pname) + " (FORMAT PARQUET, COMPRESSION ZSTD" + kv + ")"); }
      catch (ez) { await e.conn.query("COPY gx_t TO " + sq(pname) + " (FORMAT PARQUET" + kv + ")"); }
      return await e.adb.copyFileToBuffer(pname);
    } finally {
      try { await e.conn.query("DROP TABLE IF EXISTS gx_t"); } catch (e1) {}
      try { await e.adb.dropFile(jname); } catch (e2) {}
      try { await e.adb.dropFile(pname); } catch (e3) {}
    }
  }

  /* ── CSV (attributes + WKT) ─────────────────────────────────────────────── */
  function csvCell(v) {
    if (v == null) return "";
    var s = typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function toCsv(fc) {
    var col = columns(fc), out = [["feature_id"].concat(col.keys).concat(["wkt"]).map(csvCell).join(",")];
    (fc.features || []).forEach(function (f, i) {
      var p = f.properties || {};
      out.push([fid(f, i)].concat(col.keys.map(function (k) { return p[k]; })).concat([toWkt(f.geometry)]).map(csvCell).join(","));
    });
    return "﻿" + out.join("\r\n") + "\r\n";   // BOM: Excel reads UTF-8 only when told
  }

  /* ── KML 2.2 ────────────────────────────────────────────────────────────── */
  function x(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
  function kmlCoords(c) { return c.map(function (p) { return p[0] + "," + p[1] + (p.length > 2 ? "," + p[2] : ""); }).join(" "); }
  function kmlGeom(g) {
    if (!g || !g.type) return "";
    var t = g.type, c = g.coordinates;
    if (t === "Point") return "<Point><coordinates>" + kmlCoords([c]) + "</coordinates></Point>";
    if (t === "LineString") return "<LineString><coordinates>" + kmlCoords(c) + "</coordinates></LineString>";
    if (t === "Polygon") return "<Polygon>" + c.map(function (r, i) { return "<" + (i ? "innerBoundaryIs" : "outerBoundaryIs") + "><LinearRing><coordinates>" + kmlCoords(r) + "</coordinates></LinearRing></" + (i ? "innerBoundaryIs" : "outerBoundaryIs") + ">"; }).join("") + "</Polygon>";
    if (t === "MultiPoint" || t === "MultiLineString" || t === "MultiPolygon") { var inner = t.slice(5); return "<MultiGeometry>" + c.map(function (part) { return kmlGeom({ type: inner, coordinates: part }); }).join("") + "</MultiGeometry>"; }
    if (t === "GeometryCollection") return "<MultiGeometry>" + (g.geometries || []).map(kmlGeom).join("") + "</MultiGeometry>";
    return "";
  }
  function toKml(fc, docName) {
    var out = ['<?xml version="1.0" encoding="UTF-8"?>', '<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>' + x(docName || "layer") + "</name>"];
    (fc.features || []).forEach(function (f, i) {
      var p = f.properties || {}, name = p.label != null ? p.label : (p.name != null ? p.name : (p.title != null ? p.title : fid(f, i)));
      var ext = Object.keys(p).map(function (k) { return '<Data name="' + x(k) + '"><value>' + x(cell(p[k])) + "</value></Data>"; }).join("");
      out.push("<Placemark><name>" + x(name) + "</name>" + (p.description != null ? "<description>" + x(p.description) + "</description>" : "") +
        "<ExtendedData>" + ext + "</ExtendedData>" + kmlGeom(f.geometry) + "</Placemark>");
    });
    out.push("</Document></kml>");
    return out.join("\n");
  }

  /* ── Shapefile (zip of .shp/.shx/.dbf/.prj) ─────────────────────────────── */
  var _shp = null;
  function ensureShpWrite() {
    if (window.shpwrite) return Promise.resolve(window.shpwrite);
    if (_shp) return _shp;
    _shp = new Promise(function (res, rej) {
      var i = 0;
      (function next() {
        if (i >= SHPWRITE_URLS.length) { _shp = null; return rej(new Error("shp-write could not be loaded")); }
        var s = document.createElement("script"); s.src = SHPWRITE_URLS[i++];
        s.onload = function () { window.shpwrite ? res(window.shpwrite) : next(); };
        s.onerror = next;
        document.head.appendChild(s);
      })();
    });
    return _shp;
  }
  async function toShapefileZip(fc, name) {
    var lib = await ensureShpWrite();
    // dBase wants flat, primitive attributes with short names; shapefiles hold one geometry type
    // each, which the library handles by writing one set per type into the zip
    var flat = { type: "FeatureCollection", features: (fc.features || []).map(function (f, i) {
      var p = f.properties || {}, q = { feature_id: fid(f, i) };
      Object.keys(p).forEach(function (k) { var v = cell(p[k]); q[k] = v == null ? "" : v; });
      return { type: "Feature", properties: q, geometry: f.geometry };
    }) };
    var r = lib.zip(flat, { outputType: "arraybuffer", compression: "STORE", folder: name || "layer" });
    return (r && typeof r.then === "function") ? await r : r;
  }

  /* ── GeoPackage (sql.js) ────────────────────────────────────────────────── */
  var SQLJS_URLS = ["https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/", "https://cdn.jsdelivr.net/npm/sql.js@1.10.3/dist/"];
  var _sql = null;
  function ensureSqlJs() {
    if (_sql) return _sql;
    _sql = new Promise(function (res, rej) {
      var i = 0;
      (function next() {
        if (i >= SQLJS_URLS.length) { _sql = null; return rej(new Error("sql.js could not be loaded")); }
        var base = SQLJS_URLS[i++], s = document.createElement("script"); s.src = base + "sql-wasm.js";
        s.onload = function () {
          if (!window.initSqlJs) return next();
          window.initSqlJs({ locateFile: function (f) { return base + f; } }).then(res, next);
        };
        s.onerror = next;
        document.head.appendChild(s);
      })();
    });
    return _sql;
  }
  var WGS84_WKT = 'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563,AUTHORITY["EPSG","7030"]],AUTHORITY["EPSG","6326"]],PRIMEM["Greenwich",0,AUTHORITY["EPSG","8901"]],UNIT["degree",0.0174532925199433,AUTHORITY["EPSG","9122"]],AUTHORITY["EPSG","4326"]]';
  function gpkgBlob(g) {   // GeoPackage binary: "GP", version 0, flags (LE, XY envelope), srs_id, envelope, WKB
    var wkb = toWkb(g);
    var b = [Infinity, Infinity, -Infinity, -Infinity];
    (function walk(c) { if (typeof c[0] === "number") { if (c[0] < b[0]) b[0] = c[0]; if (c[1] < b[1]) b[1] = c[1]; if (c[0] > b[2]) b[2] = c[0]; if (c[1] > b[3]) b[3] = c[1]; } else c.forEach(walk); })(g.coordinates || []);
    var hasEnv = isFinite(b[0]), head = 8 + (hasEnv ? 32 : 0);
    var out = new Uint8Array(head + wkb.length), dv = new DataView(out.buffer);
    out[0] = 0x47; out[1] = 0x50; out[2] = 0; out[3] = hasEnv ? 0x03 : 0x01;   // flags: bit0 = little-endian, bits1-3 = envelope indicator (1 = XY)
    dv.setInt32(4, 4326, true);
    if (hasEnv) { dv.setFloat64(8, b[0], true); dv.setFloat64(16, b[2], true); dv.setFloat64(24, b[1], true); dv.setFloat64(32, b[3], true); }   // minx, maxx, miny, maxy
    out.set(wkb, head);
    return out;
  }
  function gpkgTypeName(gtypes) {
    var ks = Object.keys(gtypes);
    return ks.length === 1 ? ks[0].toUpperCase() : "GEOMETRY";
  }
  async function toGeoPackage(fc, name) {
    var SQL = await ensureSqlJs();
    var db = new SQL.Database();
    var col = columns(fc), feats = fc.features || [];
    var table = String(name || "layer").replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "layer";
    if (/^[0-9]/.test(table)) table = "t_" + table;
    // column names: SQLite identifiers, deduped, never colliding with fid/geom
    var names = [], seen = { fid: 1, geom: 1 };
    col.keys.forEach(function (k) {
      var n = String(k).replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "col";
      if (/^[0-9]/.test(n)) n = "c_" + n;
      var base = n, i = 2; while (seen[n.toLowerCase()]) n = base + "_" + (i++);
      seen[n.toLowerCase()] = 1; names.push(n);
    });
    var gtypes = {}, bb = [Infinity, Infinity, -Infinity, -Infinity];
    feats.forEach(function (f) {
      var g = f.geometry; if (!g || !g.type) return; gtypes[g.type] = 1;
      (function walk(c) { if (typeof c[0] === "number") { if (c[0] < bb[0]) bb[0] = c[0]; if (c[1] < bb[1]) bb[1] = c[1]; if (c[0] > bb[2]) bb[2] = c[0]; if (c[1] > bb[3]) bb[3] = c[1]; } else c.forEach(walk); })(g.coordinates || []);
    });
    db.run("PRAGMA application_id = 1196444487; PRAGMA user_version = 10300;");
    db.run("CREATE TABLE gpkg_spatial_ref_sys (srs_name TEXT NOT NULL, srs_id INTEGER NOT NULL PRIMARY KEY, organization TEXT NOT NULL, organization_coordsys_id INTEGER NOT NULL, definition TEXT NOT NULL, description TEXT)");
    db.run("INSERT INTO gpkg_spatial_ref_sys VALUES ('Undefined cartesian SRS', -1, 'NONE', -1, 'undefined', 'undefined cartesian coordinate reference system'), ('Undefined geographic SRS', 0, 'NONE', 0, 'undefined', 'undefined geographic coordinate reference system'), ('WGS 84 geodetic', 4326, 'EPSG', 4326, ?, 'longitude/latitude coordinates in decimal degrees on the WGS 84 spheroid')", [WGS84_WKT]);
    db.run("CREATE TABLE gpkg_contents (table_name TEXT NOT NULL PRIMARY KEY, data_type TEXT NOT NULL, identifier TEXT UNIQUE, description TEXT DEFAULT '', last_change DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), min_x DOUBLE, min_y DOUBLE, max_x DOUBLE, max_y DOUBLE, srs_id INTEGER, CONSTRAINT fk_gc_r_srs_id FOREIGN KEY (srs_id) REFERENCES gpkg_spatial_ref_sys(srs_id))");
    db.run("CREATE TABLE gpkg_geometry_columns (table_name TEXT NOT NULL, column_name TEXT NOT NULL, geometry_type_name TEXT NOT NULL, srs_id INTEGER NOT NULL, z TINYINT NOT NULL, m TINYINT NOT NULL, CONSTRAINT pk_geom_cols PRIMARY KEY (table_name, column_name), CONSTRAINT uk_gc_table_name UNIQUE (table_name), CONSTRAINT fk_gc_tn FOREIGN KEY (table_name) REFERENCES gpkg_contents(table_name), CONSTRAINT fk_gc_srs FOREIGN KEY (srs_id) REFERENCES gpkg_spatial_ref_sys (srs_id))");
    var defs = names.map(function (n, j) { return qi(n) + " " + (col.types[col.keys[j]] === "DOUBLE" ? "REAL" : "TEXT"); });
    db.run("CREATE TABLE " + qi(table) + " (fid INTEGER PRIMARY KEY AUTOINCREMENT, geom BLOB" + (defs.length ? ", " + defs.join(", ") : "") + ")");
    db.run("INSERT INTO gpkg_contents (table_name, data_type, identifier, min_x, min_y, max_x, max_y, srs_id) VALUES (?, 'features', ?, ?, ?, ?, ?, 4326)",
      [table, table, isFinite(bb[0]) ? bb[0] : null, isFinite(bb[1]) ? bb[1] : null, isFinite(bb[2]) ? bb[2] : null, isFinite(bb[3]) ? bb[3] : null]);
    db.run("INSERT INTO gpkg_geometry_columns VALUES (?, 'geom', ?, 4326, 0, 0)", [table, gpkgTypeName(gtypes)]);
    var ins = db.prepare("INSERT INTO " + qi(table) + " (geom" + names.map(function (n) { return ", " + qi(n); }).join("") + ") VALUES (?" + names.map(function () { return ", ?"; }).join("") + ")");
    db.run("BEGIN");
    for (var i = 0; i < feats.length; i++) {
      var f = feats[i], p = f.properties || {};
      var vals = [f.geometry && f.geometry.type ? gpkgBlob(f.geometry) : null];
      col.keys.forEach(function (k) { var v = cell(p[k]); vals.push(v == null ? null : (col.types[k] === "DOUBLE" ? v : String(v))); });
      ins.run(vals);
    }
    db.run("COMMIT");
    ins.free();
    var bytes = db.export();
    db.close();
    return bytes;
  }

  window.MSGeoExport = { toWkb: toWkb, toWkt: toWkt, toGeoParquet: toGeoParquet, toCsv: toCsv, toKml: toKml, toShapefileZip: toShapefileZip, toGeoPackage: toGeoPackage, columns: columns };
})();
