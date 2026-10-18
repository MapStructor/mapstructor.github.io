/* customColumns.js — the LINKED TILESET CUSTOM COLUMNS TABLE (owner's vocabulary, 10/18).
   Loads on the viewer, the editor, a downloaded copy, and in node (the build scripts compile the
   same expressions this file does — one author).

   THREE KINDS OF COLUMN on a Linked / tiled layer:
     Linked Tileset Columns          what rides in the tiles: id, DayStart/DayEnd, label, and the
                                     one colour-by column a bake wrote in. The renderer can read
                                     only these.
     Linked Tileset Companion        the source's own attribute store (its rows, or its baked
     Columns Table                   sidecar) — every column, read-only from this map.
     Linked Tileset Custom           the columns THIS MAP adds: definitions on the layer row
     Columns Table                   (raw_config.customCols, typed, with per-value styling),
                                     values in layer_overlay keyed by a JOIN KEY.

   THE JOIN KEY (raw_config.customJoin): absent = the feature id, which every MapStructor-baked
   tileset carries; or the name of a column that IS in the tiles (ISO_A2_EH on an external
   tileset with no ids). Expressions key on it, so styling by a custom column works on ANY source
   type without re-baking: the style carries the key→value table (fine at thousands of keys; the
   scale options live in the todo under "equally fast").

   WHAT THE PANEL SEES (owner 10/18: everything is reflected in the panel): colorBy / outlineBy /
   lightenBy name a custom column; the column's DEFINITION holds each value's fill colour, outline
   colour + width, "lighter by" percent, label and hidden flag. compile() turns those settings +
   the values into the persisted paint and the layer's own filter, exactly the way the panel's
   colour-by already persists a match expression into layers.paint. */
(function (root) {
  "use strict";
  if (root.MSCustomCols) return;

  var NONE = "rgba(0,0,0,0)";
  function defsOf(node) { return (node && Array.isArray(node.customCols)) ? node.customCols : []; }
  function defOf(node, key) { var d = defsOf(node); for (var i = 0; i < d.length; i++) if (d[i] && d[i].key === key) return d[i]; return null; }
  function joinOf(node) { var j = node && node.customJoin; return (typeof j === "string" && j.trim()) ? j.trim() : null; }
  // the expression that reads a feature's join key — ["id"] for id-joined layers
  function keyExpr(node) { var j = joinOf(node); return j ? ["to-string", ["get", j]] : ["id"]; }
  // a key as the match label the renderer compares against: ids are numbers in the tiles
  function keyLiteral(node, k) { if (joinOf(node)) return String(k); var n = Number(k); return isNaN(n) ? String(k) : n; }
  // the key of a features-table row / a rendered feature
  function rowKey(node, row) {
    var j = joinOf(node);
    if (!j) return row && row.feature_id != null ? String(row.feature_id) : null;
    var cf = row && row.custom_fields; var v = cf && cf[j] != null ? cf[j] : (row ? row[j] : null);
    return v == null ? null : String(v);
  }
  function featureKey(node, f) {
    var j = joinOf(node);
    if (!j) return f && f.id != null ? String(f.id) : null;
    var v = f && f.properties ? f.properties[j] : null;
    return v == null ? null : String(v);
  }

  /* ── colour helpers ─────────────────────────────────────────────────────── */
  function hexOf(c) { var s = String(c == null ? "" : c).trim(); if (/^#[0-9a-fA-F]{6}$/.test(s)) return s.toLowerCase(); if (/^[0-9a-fA-F]{6}$/.test(s)) return ("#" + s).toLowerCase(); return null; }
  function isNone(c) { var s = String(c == null ? "" : c).trim().toLowerCase().replace(/\s+/g, ""); return s === "none" || s === "transparent" || s === NONE; }
  // mix a hex colour toward white by pct (0–100): 0 = the colour, 100 = white
  function lighten(c, pct) {
    var h = hexOf(c); if (!h) return c;
    var t = Math.max(0, Math.min(100, Number(pct) || 0)) / 100;
    var r = parseInt(h.slice(1, 3), 16), g = parseInt(h.slice(3, 5), 16), b = parseInt(h.slice(5, 7), 16);
    function mix(x) { return Math.round(x + (255 - x) * t); }
    function two(x) { var s = x.toString(16); return s.length < 2 ? "0" + s : s; }
    return "#" + two(mix(r)) + two(mix(g)) + two(mix(b));
  }
  function colorValue(c, fallback) { if (c == null || c === "") return fallback; if (isNone(c)) return NONE; return hexOf(c) || c; }

  /* ── definitions ────────────────────────────────────────────────────────── */
  // def = { key, label?, type: 'category'|'text'|'number', values: [{ v, label?, color?, lineColor?, lineWidth?, lighten?, hidden? }], noValue: { label?, color?, lineColor?, lineWidth?, lighten?, hidden? } }
  function valueDef(def, v) {
    if (!def) return null;
    if (v == null || v === "") return def.noValue || null;
    var vs = def.values || [];
    for (var i = 0; i < vs.length; i++) if (vs[i] && String(vs[i].v) === String(v)) return vs[i];
    return null;
  }
  function normDef(d) {
    var out = { key: String(d.key || "").trim(), label: d.label || null, type: d.type || "category", values: [], noValue: d.noValue || {} };
    (d.values || []).forEach(function (x) { if (x && x.v != null && String(x.v) !== "") out.values.push(x); });
    return out;
  }

  /* ── compile: settings + values → paint keys + own filter ───────────────── */
  // values: { key: { col: value } } — every custom value the layer has
  // base:   { color, outline, width } — the panel's single colour / outline colour / outline width
  //         (used where a feature has no custom value and the definition sets nothing)
  // Returns { paint: {...only the keys the settings drive...}, filter: legacy|null, keys: n, hidden: n }
  function compile(node, values, base) {
    values = values || {}; base = base || {};
    var out = { paint: {}, filter: null, keys: 0, hidden: 0 };
    var cb = node && node.colorBy && node.colorBy.custom ? node.colorBy : null;
    var cdef = cb ? defOf(node, cb.prop) : null;
    var lb = node && node.lightenBy && node.lightenBy.prop ? node.lightenBy : null;
    var ldef = lb ? defOf(node, lb.prop) : null;
    var ob = node && node.outlineBy && node.outlineBy.prop ? node.outlineBy : null;
    var odef = ob ? defOf(node, ob.prop) : null;
    var fillKey = (node && node.type === "line") ? "line-color" : (node && node.type === "circle") ? "circle-color" : "fill-color";
    var kx = keyExpr(node);
    var keys = Object.keys(values);
    out.keys = keys.length;

    // fill colour by a custom column (+ lighter by another): one match over every key with a value
    if (cdef) {
      var noV = cdef.noValue || {};
      var fallbackColor = colorValue(noV.color, base.color || "#3bb2d0");
      var e = ["match", kx];
      keys.forEach(function (k) {
        var v = values[k] ? values[k][cdef.key] : null;
        var vd = valueDef(cdef, v);
        var c = vd && vd.color != null && vd.color !== "" ? colorValue(vd.color, fallbackColor) : (v == null || v === "" ? fallbackColor : (cb.mapping && cb.mapping[String(v)]) || fallbackColor);
        if (ldef && c !== NONE) {
          var lv = values[k] ? values[k][ldef.key] : null;
          var ld = valueDef(ldef, lv);
          if (ld && ld.lighten != null && ld.lighten !== "") c = lighten(c, ld.lighten);
        }
        e.push(keyLiteral(node, k), c);
      });
      if (e.length > 2) { e.push(fallbackColor); out.paint[fillKey] = e; }
      else out.paint[fillKey] = fallbackColor;
    }
    // outline colour + width by a custom column (fills: the stroke companion reads line-width;
    // the native 1px outline reads fill-outline-color — both are written)
    if (odef) {
      var onV = odef.noValue || {};
      var oFallback = colorValue(onV.color || onV.lineColor, base.outline || "#000000");
      var wFallback = (onV.lineWidth != null && onV.lineWidth !== "") ? Number(onV.lineWidth) : (base.width != null ? base.width : 0.5);
      var ec = ["match", kx], ew = ["match", kx];
      keys.forEach(function (k) {
        var v = values[k] ? values[k][odef.key] : null;
        var vd = valueDef(odef, v); if (!vd) return;
        var lc = (vd.lineColor != null && vd.lineColor !== "") ? colorValue(vd.lineColor, oFallback) : ((vd.color != null && vd.color !== "") ? colorValue(vd.color, oFallback) : null);
        var lw = (vd.lineWidth != null && vd.lineWidth !== "") ? Number(vd.lineWidth) : null;
        if (lc != null) ec.push(keyLiteral(node, k), lc);
        if (lw != null) ew.push(keyLiteral(node, k), lw);
      });
      if (node && node.type === "fill") {
        out.paint["fill-outline-color"] = ec.length > 2 ? ec.concat([oFallback]) : oFallback;
        out.paint["line-width"] = ew.length > 2 ? ew.concat([wFallback]) : wFallback;
      } else if (node && node.type === "line") {
        if (!cdef) out.paint["line-color"] = ec.length > 2 ? ec.concat([oFallback]) : oFallback;
        out.paint["line-width"] = ew.length > 2 ? ew.concat([wFallback]) : wFallback;
      } else {
        out.paint["circle-stroke-color"] = ec.length > 2 ? ec.concat([oFallback]) : oFallback;
        out.paint["circle-stroke-width"] = ew.length > 2 ? ew.concat([wFallback]) : wFallback;
      }
    }
    // hidden values: a value flagged hidden in ANY custom column's definition hides the feature
    // (no draw, no hover, no popup — a filter, not opacity). "No value" hidden = allow-list.
    var defs = defsOf(node), hiddenKeys = {}, anyNoValueHidden = false, hasAny = false;
    defs.forEach(function (d) { if (d && d.noValue && d.noValue.hidden) anyNoValueHidden = true; });
    keys.forEach(function (k) {
      var row = values[k] || {}, hide = false, has = false;
      defs.forEach(function (d) {
        if (!d) return;
        var v = row[d.key];
        if (v != null && v !== "") has = true;
        var vd = valueDef(d, v);
        if (vd && vd.hidden) hide = true;
        else if ((v == null || v === "") && d.noValue && d.noValue.hidden) hide = true;
      });
      if (has) hasAny = true;
      if (hide) hiddenKeys[k] = 1;
    });
    var prop = joinOf(node) || "$id";
    if (anyNoValueHidden) {
      var allow = keys.filter(function (k) { return !hiddenKeys[k]; }).map(function (k) { return keyLiteral(node, k); });
      out.filter = ["in", prop].concat(allow);
      out.hidden = -1;   // allow-list: everything not listed is hidden
    } else {
      var hk = Object.keys(hiddenKeys);
      if (hk.length) { out.filter = ["!in", prop].concat(hk.map(function (k) { return keyLiteral(node, k); })); out.hidden = hk.length; }
    }
    out.hasAny = hasAny;
    return out;
  }

  // the style-rows / legend toggles on a custom colour-by: hidden categories → opacity 0, by key
  function hiddenOpacityExpr(node, values, hiddenCats, base) {
    var cb = node && node.colorBy; if (!cb || !cb.custom || !hiddenCats || !hiddenCats.length) return base;
    var e = ["match", keyExpr(node)], n = 0;
    Object.keys(values || {}).forEach(function (k) {
      var v = values[k] ? values[k][cb.prop] : null;
      if (v != null && hiddenCats.indexOf(String(v)) > -1) { e.push(keyLiteral(node, k), 0); n++; }
    });
    if (!n) return base;
    e.push(base);
    return e;
  }

  // the custom value of a rendered feature (popups, pills): { col: value } or null
  function valuesFor(node, values, feature) {
    var k = featureKey(node, feature); if (k == null) return null;
    return (values && values[k]) || null;
  }

  // freeze custom columns into a FeatureCollection's properties (downloads: other_data/ exports)
  function mergeIntoFc(node, values, fc) {
    if (!fc || !fc.features || !values) return 0;
    var n = 0;
    fc.features.forEach(function (f) {
      var k = featureKey(node, f); if (k == null) return;
      var v = values[k]; if (!v) return;
      f.properties = f.properties || {};
      Object.keys(v).forEach(function (c) { if (v[c] != null && v[c] !== "") { f.properties[c] = v[c]; n++; } });
    });
    return n;
  }

  /* ── values: the browser half (Supabase, or a standalone copy's frozen values) ── */
  var cache = {};   // layer db id → { key: fields }
  function db() { return (root.MapAuth && root.MapAuth.db) || null; }
  async function load(layerId, force) {
    if (!layerId) return {};
    if (cache[layerId] && !force) return cache[layerId];
    var out = {}, d = db();
    if (!d) return cache[layerId] = out;
    var last = null;
    for (;;) {
      var q = d.from("layer_overlay").select("key, fields").eq("layer_id", layerId).order("key").limit(1000);
      if (last != null) q = q.gt("key", last);
      var r = await q;
      if (r.error || !r.data || !r.data.length) break;
      r.data.forEach(function (x) { out[String(x.key)] = x.fields || {}; });
      last = r.data[r.data.length - 1].key;
      if (r.data.length < 1000) break;
    }
    cache[layerId] = out;
    return out;
  }
  function cached(layerId) { return cache[layerId] || null; }
  function seed(layerId, values) { cache[layerId] = values || {}; }   // a standalone copy stamps node.customValues
  async function set(layerId, key, col, value) {
    var d = db(); if (!d) return { error: { message: "no database" } };
    key = String(key);
    var cur = (cache[layerId] && cache[layerId][key]) || null;
    if (!cur) { var q = await d.from("layer_overlay").select("fields").eq("layer_id", layerId).eq("key", key).maybeSingle(); cur = (q.data && q.data.fields) || {}; }
    var f = Object.assign({}, cur);
    if (value === null || value === "" || value === undefined) delete f[col]; else f[col] = value;
    var row = { layer_id: layerId, key: key, fields: f, updated_at: new Date().toISOString() };
    if (/^\d+$/.test(key)) row.feature_id = Number(key);
    var r = await d.from("layer_overlay").upsert(row, { onConflict: "layer_id,key" });
    if (!r.error) { cache[layerId] = cache[layerId] || {}; cache[layerId][key] = f; }
    return r;
  }
  // many rows at once: rows = { key: { col: value } } merged into what is there (null clears a col)
  async function setMany(layerId, rows) {
    var d = db(); if (!d) return { error: { message: "no database" } };
    var have = await load(layerId, true), batch = [], now = new Date().toISOString();
    Object.keys(rows || {}).forEach(function (k) {
      var f = Object.assign({}, have[k] || {}), patch = rows[k] || {};
      Object.keys(patch).forEach(function (c) { if (patch[c] == null || patch[c] === "") delete f[c]; else f[c] = patch[c]; });
      var row = { layer_id: layerId, key: String(k), fields: f, updated_at: now };
      if (/^\d+$/.test(String(k))) row.feature_id = Number(k);
      batch.push(row); have[k] = f;
    });
    for (var i = 0; i < batch.length; i += 500) {
      var r = await d.from("layer_overlay").upsert(batch.slice(i, i + 500), { onConflict: "layer_id,key" });
      if (r.error) return r;
    }
    cache[layerId] = have;
    return { error: null, count: batch.length };
  }
  async function dropColumn(layerId, col) {
    var have = await load(layerId, true), patch = {};
    Object.keys(have).forEach(function (k) { if (have[k] && have[k][col] !== undefined) { patch[k] = {}; patch[k][col] = null; } });
    if (!Object.keys(patch).length) return { error: null, count: 0 };
    return setMany(layerId, patch);
  }
  function distinctValues(values, col) {
    var seen = {}, out = [];
    Object.keys(values || {}).forEach(function (k) { var v = values[k] ? values[k][col] : null; if (v == null || v === "") return; var s = String(v); if (!seen[s]) { seen[s] = 1; out.push(s); } });
    return out.sort();
  }

  var api = {
    NONE: NONE,
    defsOf: defsOf, defOf: defOf, joinOf: joinOf, keyExpr: keyExpr, keyLiteral: keyLiteral, rowKey: rowKey, featureKey: featureKey,
    valueDef: valueDef, normDef: normDef, lighten: lighten, hexOf: hexOf, isNone: isNone, colorValue: colorValue,
    compile: compile, hiddenOpacityExpr: hiddenOpacityExpr, valuesFor: valuesFor, mergeIntoFc: mergeIntoFc, distinctValues: distinctValues,
    load: load, cached: cached, seed: seed, set: set, setMany: setMany, dropColumn: dropColumn
  };
  root.MSCustomCols = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
