/* groupView.js — "treat as one" for the VIEWER (7/18).
   Layers with raw_config.groupBy behave as ONE thing in view mode: hovering any
   piece glows the whole family (finger cursor), clicking pins/unpins the glow.
   Same universal filter-twin design as the editor: a twin highlight layer on the
   layer's OWN source whose FILTER declares membership — the renderer evaluates it
   per frame, so the glow is never stale, partial, or viewport-limited.
   The editor page has its richer integrated version (editing.js) — this file
   no-ops there (window.__msEditorAttr). Family variants/counts come from
   ms_layer_key_counts once per layer; until they load, exact-value matching. */
(function () {
  function boot() {
    if (window.__msEditorAttr) return;   // editor owns group interaction on its page
    if (typeof beforeMap === 'undefined' || !beforeMap || typeof layers === 'undefined' || !beforeMap.getStyle) { setTimeout(boot, 400); return; }
    try { if (!beforeMap.isStyleLoaded()) { setTimeout(boot, 400); return; } } catch (e) { setTimeout(boot, 400); return; }

    var norm = window.msGroupNorm || function (x) { return String(x == null ? '' : x).trim().toLowerCase(); };
    var FILTER_NONE = ['in', '__ms_none__', 'x'];
    var GLOW = {
      line: { type: 'line', paint: { 'line-color': '#ff9d2e', 'line-width': 4.5, 'line-opacity': 0.55 } },
      fill: { type: 'fill', paint: { 'fill-color': '#ffd54d', 'fill-opacity': 0.3 } },
      circle: { type: 'circle', paint: { 'circle-color': '#ffd54d', 'circle-opacity': 0.4, 'circle-radius': 8, 'circle-stroke-color': '#ff9d2e', 'circle-stroke-width': 1.5 } }
    };
    var fam = {}, active = null, hoverVal = null, lock = false;

    function eachMap(cb) {
      [['left', beforeMap], ['right', (typeof afterMap !== 'undefined' ? afterMap : null)]].forEach(function (pr) { if (pr[1]) cb(pr[1], pr[0]); });
    }
    function groupedNodes() {
      var out = [];
      (function w(a) { (a || []).forEach(function (n) { if (n && n.groupBy) out.push(n); if (n && n.children) w(n.children); }); })(layers);
      return out;
    }
    function ensureTwin(node) {
      var spec = GLOW[node.type] || GLOW.line;
      eachMap(function (m, side) {
        var gid = node.id + '-group-hl-' + side;
        try {
          if (m.getLayer(gid) || !m.getSource(node.id + '-' + side)) return;
          var cfg = { id: gid, type: spec.type, source: node.id + '-' + side, paint: spec.paint, filter: FILTER_NONE };
          if (node['source-layer']) cfg['source-layer'] = node['source-layer'];
          m.addLayer(cfg);
          if (typeof msRaiseLabelLayers === 'function') msRaiseLabelLayers(m, layers);
        } catch (e) {}
      });
    }
    function loadFamilies(node) {
      var lid = node._layerDbId;
      var db = (window.MapAuth && MapAuth.db) || null;
      if (!lid || !db || fam[lid]) return;
      fam[lid] = { loaded: false, byFamily: {} };
      try {
        db.rpc('ms_layer_key_counts', { p_layer: lid, p_key: node.groupBy }).then(function (r) {
          var st = fam[lid]; st.loaded = true;
          ((r && r.data) || []).forEach(function (c) {
            var f0 = norm(c.k); if (!f0) return;
            var f = st.byFamily[f0] || (st.byFamily[f0] = { variants: [], count: 0 });
            f.variants.push(c.k); f.count += c.n;
          });
          if (active && active.node._layerDbId === lid) applyFilter();
        });
      } catch (e) { fam[lid].loaded = true; }
    }
    function familyFor(node, raw) {
      var st = node._layerDbId && fam[node._layerDbId];
      return (st && st.byFamily[norm(raw)]) || { variants: [String(raw)], count: null };
    }
    function applyFilter() {
      eachMap(function (m, side) {
        groupedNodes().forEach(function (n) {
          var gid = n.id + '-group-hl-' + side;
          if (!m.getLayer(gid)) return;
          var filt = FILTER_NONE;
          if (active && active.node.id === n.id) {
            var inClause = ['in', n.groupBy === 'label' ? 'label' : n.groupBy].concat(familyFor(n, active.raw).variants);
            var base = null; try { base = m.getFilter(n.id + '-' + side) || null; } catch (e) {}
            if (base && base[0] === 'all') base = ['all'].concat(base.slice(1).filter(function (c) { return !(Array.isArray(c) && c[0] === '!in' && c[1] === '$id'); }));
            else if (base && base[0] === '!in' && base[1] === '$id') base = null;
            filt = !base ? inClause : (base[0] === 'all' ? base.concat([inClause]) : ['all', base, inClause]);
          }
          try { m.setFilter(gid, filt); } catch (e2) {}
        });
      });
    }
    function setActive(node, raw) {
      active = (node && raw != null && norm(raw)) ? { node: node, raw: raw } : null;
      if (active) { ensureTwin(node); loadFamilies(node); }
      applyFilter();
    }
    // nearest-hit (render order lies at crossings — pick by true screen distance)
    function dSeg(p, a, b) {
      var dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
      if (!l2) { var ex = p.x - a.x, ey = p.y - a.y; return Math.sqrt(ex * ex + ey * ey); }
      var t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
      var qx = a.x + t * dx - p.x, qy = a.y + t * dy - p.y;
      return Math.sqrt(qx * qx + qy * qy);
    }
    function dFeat(f, pt) {
      try {
        var g = f.geometry; if (!g) return 1e9;
        var lines;
        if (g.type === 'LineString') lines = [g.coordinates];
        else if (g.type === 'MultiLineString') lines = g.coordinates;
        else if (g.type === 'Polygon') lines = g.coordinates;
        else if (g.type === 'MultiPolygon') { lines = []; g.coordinates.forEach(function (pg) { lines = lines.concat(pg); }); }
        else if (g.type === 'Point') { var P0 = beforeMap.project({ lng: g.coordinates[0], lat: g.coordinates[1] }); var ex = pt.x - P0.x, ey = pt.y - P0.y; return Math.sqrt(ex * ex + ey * ey); }
        else return 1e9;
        var bd = 1e9;
        for (var li = 0; li < lines.length; li++) {
          var c = lines[li], prev = null;
          for (var i = 0; i < c.length; i++) {
            var P = beforeMap.project({ lng: c[i][0], lat: c[i][1] });
            if (prev) { var d = dSeg(pt, prev, P); if (d < bd) bd = d; }
            prev = P;
          }
        }
        return bd;
      } catch (e) { return 1e9; }
    }
    function valueAt(pt) {
      var bx = 8, lids = [];
      groupedNodes().forEach(function (n) { if (beforeMap.getLayer(n.id + '-left')) lids.push(n.id + '-left'); });
      if (!lids.length) return null;
      var fs; try { fs = beforeMap.queryRenderedFeatures([[pt.x - bx, pt.y - bx], [pt.x + bx, pt.y + bx]], { layers: lids }) || []; } catch (e) { return null; }
      var best = null, bd = 1e9;
      for (var i = 0; i < fs.length; i++) {
        var n2 = null, slug = String(fs[i].layer.id).replace(/-(left|right)$/, '');
        groupedNodes().forEach(function (n) { if (n.id === slug) n2 = n; });
        if (!n2) continue;
        var vv = (n2.groupBy === 'label') ? (fs[i].properties || {}).label : (fs[i].properties || {})[n2.groupBy];
        if (!norm(vv)) continue;
        var d = dFeat(fs[i], pt);
        if (d < bd) { bd = d; best = { node: n2, raw: vv, val: norm(vv) }; }
      }
      return best;
    }
    function setCursor(on) {
      eachMap(function (m) {
        try {
          var c = m.getCanvas();
          if (on) { if (c.style.cursor !== 'pointer') c.style.cursor = 'pointer'; }
          else if (c.style.cursor === 'pointer') c.style.cursor = '';
        } catch (e) {}
      });
    }
    function pillHtml(node, raw) {
      var val = String(raw == null ? '' : raw).trim(); if (!val) return null;
      var col = (node && node.iconColor) || '#3bb2d0', bg = col;
      try { if (typeof hexToRgba === 'function' && col[0] === '#') bg = hexToRgba(col, 0.5); } catch (e) {}
      return '<div style="background-color:' + bg + ';border:solid ' + col + ' 2px;padding:5px;">' + val.replace(/[<>&]/g, function (c) { return ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]; }) + '</div>';
    }
    eachMap(function (m) {
      var pop = (typeof mapboxgl !== 'undefined' && mapboxgl.Popup) ? new mapboxgl.Popup({ closeButton: false, closeOnClick: false }) : null;
      m.on('mousemove', function (e) {
        var gv = valueAt(e.point);
        setCursor(!!gv);
        // the bubble rides the glow (gated by the layer's popup setting)
        if (pop) {
          var show = gv && (gv.node._uiHover != null ? gv.node._uiHover : !!gv.node.popupStyle);
          var html = show ? pillHtml(gv.node, gv.raw) : null;
          if (html) { pop.setLngLat(e.lngLat).setHTML(html); if (!pop.isOpen()) pop.addTo(m); }
          else if (pop.isOpen()) pop.remove();
        }
        if (lock) return;
        if (!gv) { if (hoverVal != null) { hoverVal = null; setActive(null, null); } return; }
        if (gv.val === hoverVal) return;
        hoverVal = gv.val;
        setActive(gv.node, gv.raw);
      });
      m.on('click', function (e) {
        var gv = valueAt(e.point);
        if (!gv) { lock = false; hoverVal = null; setActive(null, null); return; }
        lock = true;
        setActive(gv.node, gv.raw);
      });
      m.on('idle', function () { if (active) applyFilter(); });   // keep date-filter composition current
    });
  }
  boot();
})();
