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
     GeoPackage  — NOT yet: needs a SQLite engine in the browser (sql.js). Recorded, not built.

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

  window.MSGeoExport = { toWkb: toWkb, toWkt: toWkt, toGeoParquet: toGeoParquet, toCsv: toCsv, toKml: toKml, toShapefileZip: toShapefileZip, columns: columns };
})();
