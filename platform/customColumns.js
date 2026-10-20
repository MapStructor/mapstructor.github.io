/* customColumns.js — the LINKED TILESET CUSTOM COLUMNS TABLE (owner's vocabulary, 10/18): the
   columns THIS MAP adds to a layer whose data is not its own (a Linked mirror, a tileset).

   Three kinds of column on such a layer:
     Linked Tileset Columns           what rides in the tiles: id, DayStart/DayEnd, label, one
                                      colour-by column. The renderer can read only these.
     Linked Tileset Companion         the source's own attribute store (its rows, or its baked
     Columns Table                    sidecar) — every column, read-only from this map.
     Linked Tileset Custom            this map's own columns: the LIST on the layer row
     Columns Table                    (raw_config.customCols = [{key}]), the VALUES in
                                      layer_overlay keyed by a join key.

   THE JOIN KEY (raw_config.customJoin): absent = the feature id, which every MapStructor-baked
   tileset carries; or the name of a column that IS in the tiles (ISO_A2_EH on an external
   tileset with no ids). Data (10/19 rebuild, steps 2–7) + the expressions a custom column
   drives (steps 9–12): fill colour, no-fill, outline colour/width, hide-by-value. */
(function (root) {
  "use strict";
  if (root.MSCustomCols) return;

  function defsOf(node) { return (node && Array.isArray(node.customCols)) ? node.customCols : []; }
  function defOf(node, key) { var d = defsOf(node); for (var i = 0; i < d.length; i++) if (d[i] && d[i].key === key) return d[i]; return null; }
  function joinOf(node) { var j = node && node.customJoin; return (typeof j === "string" && j.trim()) ? j.trim() : null; }
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

  /* ── values: Supabase, or a standalone copy's frozen values ─────────────── */
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
  function seed(layerId, values) { cache[layerId] = values || {}; }
  async function set(layerId, key, col, value) {
    var d = db(); if (!d) return { error: { message: "no database" } };
    key = String(key);
    var cur = (cache[layerId] && cache[layerId][key]) || null;
    if (!cur) { var q = await d.from("layer_overlay").select("fields").eq("layer_id", layerId).eq("key", key).maybeSingle(); cur = (q.data && q.data.fields) || {}; }
    var f = Object.assign({}, cur);
    if (value === null || value === "" || value === undefined) delete f[col]; else f[col] = value;
    cache[layerId] = cache[layerId] || {};
    if (!Object.keys(f).length) {   // the last value cleared → no row at all (nothing left behind)
      var rd = await d.from("layer_overlay").delete().eq("layer_id", layerId).eq("key", key);
      if (!rd.error) delete cache[layerId][key];
      return rd;
    }
    var row = { layer_id: layerId, key: key, fields: f, updated_at: new Date().toISOString() };
    if (/^\d+$/.test(key)) row.feature_id = Number(key);
    var r = await d.from("layer_overlay").upsert(row, { onConflict: "layer_id,key" });
    if (!r.error) cache[layerId][key] = f;
    return r;
  }
  // many rows at once: rows = { key: { col: value } } merged into what is there (null clears a col)
  async function setMany(layerId, rows) {
    var d = db(); if (!d) return { error: { message: "no database" } };
    var have = await load(layerId, true), batch = [], gone = [], now = new Date().toISOString();
    Object.keys(rows || {}).forEach(function (k) {
      var f = Object.assign({}, have[k] || {}), patch = rows[k] || {};
      Object.keys(patch).forEach(function (c) { if (patch[c] == null || patch[c] === "") delete f[c]; else f[c] = patch[c]; });
      if (!Object.keys(f).length) { gone.push(String(k)); delete have[k]; return; }   // emptied rows are deleted, not kept as {}
      var row = { layer_id: layerId, key: String(k), fields: f, updated_at: now };
      if (/^\d+$/.test(String(k))) row.feature_id = Number(k);
      batch.push(row); have[k] = f;
    });
    for (var i = 0; i < batch.length; i += 500) {
      var r = await d.from("layer_overlay").upsert(batch.slice(i, i + 500), { onConflict: "layer_id,key" });
      if (r.error) return r;
    }
    for (var j = 0; j < gone.length; j += 500) {
      var rg = await d.from("layer_overlay").delete().eq("layer_id", layerId).in("key", gone.slice(j, j + 500));
      if (rg.error) return rg;
    }
    cache[layerId] = have;
    return { error: null, count: batch.length + gone.length };
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

  /* ── the styling a custom column drives (steps 9 + 11; one author for the editor AND the build scripts) ──
     The column is not in the tiles, so the expressions key on the join column: ["id"] for the
     feature id, ["to-string",["get",<col>]] for a natural key. */
  function keyLiteral(node, k) { return joinOf(node) ? String(k) : Number(k); }
  var NO_FILL = "rgba(0,0,0,0)";
  // one match on the join key: `pick(value)` gives each feature's literal (null = not in the match)
  function matchExpr(node, values, prop, pick, fallback) {
    var join = joinOf(node);
    var e = ["match", join ? ["to-string", ["get", join]] : ["id"]];
    Object.keys(values || {}).forEach(function (k) {
      var v = values[k] ? values[k][prop] : null; if (v == null || v === "") return;
      var lit = pick(String(v)); if (lit == null) return;
      e.push(keyLiteral(node, k), lit);
    });
    if (e.length <= 2) return fallback;
    e.push(fallback);
    return e;
  }
  // fill colour: one pair per feature whose value has a colour in the mapping; `fallback` for the
  // rest. A value in `nofill` (step 10, 10/20) draws NO fill — the feature is there (hover, click,
  // outline) but see-through; the mapping keeps its colour for the pills and the legend.
  function colorExpr(node, values, prop, mapping, fallback, nofill) {
    nofill = nofill || [];
    return matchExpr(node, values, prop, function (v) {
      if (nofill.indexOf(v) > -1) return NO_FILL;
      return (mapping && mapping[v]) || null;
    }, fallback);
  }
  // outline by column (step 10): `mapping[value] = {color, width}`; the layer's own outline colour
  // and width are the fallbacks for features without a value
  function outlineExprs(node, values, prop, mapping, fallbackColor, fallbackWidth) {
    return {
      color: matchExpr(node, values, prop, function (v) { var m = mapping && mapping[v]; return (m && m.color) || null; }, fallbackColor),
      width: matchExpr(node, values, prop, function (v) { var m = mapping && mapping[v]; return (m && typeof m.width === "number") ? m.width : null; }, fallbackWidth)
    };
  }
  // the layer's OWN filter from hidden values (legacy syntax — the engine ANDs it with its legacy
  // date filter): hidden values exclude their features; "(no value)" hidden = an allow-list
  function hideFilter(node, values, prop, hidden, hideNoValue) {
    hidden = hidden || [];
    if (!hidden.length && !hideNoValue) return null;
    var join = joinOf(node), key = join || "$id", hid = [], shown = [];
    Object.keys(values || {}).forEach(function (k) {
      var v = values[k] ? values[k][prop] : null; if (v == null || v === "") return;
      (hidden.indexOf(String(v)) > -1 ? hid : shown).push(keyLiteral(node, k));
    });
    if (hideNoValue) return ["in", key].concat(shown);
    return hid.length ? ["!in", key].concat(hid) : null;
  }

  var api = { defsOf: defsOf, defOf: defOf, joinOf: joinOf, rowKey: rowKey, featureKey: featureKey, distinctValues: distinctValues,
    load: load, cached: cached, seed: seed, set: set, setMany: setMany, dropColumn: dropColumn,
    colorExpr: colorExpr, outlineExprs: outlineExprs, hideFilter: hideFilter, NO_FILL: NO_FILL };
  root.MSCustomCols = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
