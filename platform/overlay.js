// MapStructor — added-columns overlay (Map Portal step 5b, plan §1: the Linked mode's "columns
// you add yourself"). A Linked placement follows its source's geometry + columns read-only; this
// module gives its owner columns of their OWN: the column list lives on the placement row
// (raw_config.overlayCols), the values in layer_overlay keyed (placement layer id, SOURCE feature
// id — stable across the source's re-bakes, the fold contract).
//
// After the map boots, values merge into the rendered GeoJSON sources by feature id — so popups,
// the attribute surfaces and color-by-column read them like any baked-in property. Runs on viewer
// AND editor; RLS makes readers of the map see values and only its editors write them.
// Editing UI (add-column + cell editing) is the next slice — MSOverlay.set() is its write path.
(function () {
  'use strict';
  if (window.MSOverlay) return;
  var db = null;
  function client() { db = db || (window.MapAuth && MapAuth.db); return db; }
  var cache = {};   // layerDbId → { featureId: fields } — re-applies survive hydration overwrites

  async function load(layerDbId) {
    var out = {}, last = null;
    for (;;) {
      var q = client().from('layer_overlay').select('feature_id, fields').eq('layer_id', layerDbId).order('feature_id').limit(1000);
      if (last != null) q = q.gt('feature_id', last);
      var r = await q;
      if (r.error || !r.data || !r.data.length) break;
      r.data.forEach(function (x) { out[String(x.feature_id)] = x.fields || {}; });
      last = r.data[r.data.length - 1].feature_id;
      if (r.data.length < 1000) break;
    }
    cache[layerDbId] = out;
    return out;
  }

  // merge one cell (empty value clears the key; an emptied row is left as {} — harmless)
  async function set(layerDbId, featureId, key, value) {
    var cur = await client().from('layer_overlay').select('fields').eq('layer_id', layerDbId).eq('feature_id', featureId).maybeSingle();
    var f = (cur.data && cur.data.fields) || {};
    if (value === null || value === '') delete f[key]; else f[key] = value;
    var r = await client().from('layer_overlay').upsert({ layer_id: layerDbId, feature_id: featureId, fields: f, updated_at: new Date().toISOString() }, { onConflict: 'layer_id,feature_id' });
    if (!r.error && cache[layerDbId]) cache[layerDbId][String(featureId)] = f;
    return r;
  }

  // ── merging into the live maps ────────────────────────────────────────────
  function mergeMap(m, nodeId, values) {
    if (!m || !m.getStyle || !m.getSource) return 0;
    var touched = 0, style;
    try { style = m.getStyle(); } catch (e) { return 0; }
    Object.keys((style && style.sources) || {}).forEach(function (k) {
      if (k !== nodeId && k.indexOf(nodeId + '-') !== 0) return;
      var src = m.getSource(k);
      if (!src || src.type !== 'geojson' || !src._data || !src._data.features) return;
      var hit = false;
      src._data.features.forEach(function (f) {
        var fid = f.id != null ? f.id : (f.properties || {}).feature_id;
        var v = fid != null ? values[String(fid)] : null;
        if (v && Object.keys(v).length) { f.properties = f.properties || {}; Object.assign(f.properties, v); hit = true; }
      });
      if (hit) { try { src.setData(src._data); touched++; } catch (e) {} }
    });
    return touched;
  }
  // SOURCE-DRIVEN discovery — no dependency on the engine's layer-tree global (which is scoped,
  // not reliably on window): read the maps' geojson source keys, strip the -left/-right side
  // suffix to get slugs, and ask the DB once which of those slugs carry overlayCols.
  function geoSlugs() {
    var out = {};
    [window.beforeMap, window.afterMap].forEach(function (m) {
      if (!m || !m.getStyle) return;
      var style; try { style = m.getStyle(); } catch (e) { return; }
      Object.keys((style && style.sources) || {}).forEach(function (k) {
        var src = m.getSource(k);
        if (src && src.type === 'geojson') out[k.replace(/-(left|right)$/, '')] = true;
      });
    });
    return Object.keys(out);
  }
  var known = null;   // [{id, slug}] — the overlay-bearing layers on this page, found once
  async function refreshAll() {
    if (!client()) return 0;
    if (!known) {
      var slugs = geoSlugs();
      if (!slugs.length) return 0;
      var r = await client().from('layers').select('id,slug,raw_config').in('slug', slugs);
      if (r.error) return 0;
      known = (r.data || []).filter(function (x) { return x.raw_config && x.raw_config.overlayCols && x.raw_config.overlayCols.length; })
        .map(function (x) { return { id: x.id, slug: x.slug }; });
    }
    var n = 0;
    for (var i = 0; i < known.length; i++) {
      var row = known[i];
      var values = cache[row.id] || await load(row.id);
      if (!Object.keys(values).length) continue;
      n += mergeMap(window.beforeMap, row.slug, values) + mergeMap(window.afterMap, row.slug, values);
    }
    return n;
  }

  // boot: wait for the maps, then merge — and re-merge a few times, because deferred hydration
  // REPLACES source data after boot and would silently drop the overlay
  var tries = 0;
  var iv = setInterval(function () {
    tries++;
    if ((window.beforeMap || window.afterMap) && client()) {
      refreshAll();
      if (tries > 10) clearInterval(iv);   // ~6 merges over the first minute, all idempotent
    }
    if (tries > 40) clearInterval(iv);
  }, 6000);
  setTimeout(function () { if (client()) refreshAll(); }, 4000);

  window.MSOverlay = { load: load, set: set, refreshAll: refreshAll };
})();
