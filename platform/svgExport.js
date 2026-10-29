/* svgExport.js — "Export an SVG" (owner 10/27, after seeing the published copy fall back to Mercator:
   "maybe we need to publish an svg version"). A still picture of the map's own layers as one SVG
   file: every visible layer's features drawn through a real cartographic projection — Equal Earth
   (d3-geo has it natively; MapLibre does not), or Mercator — with each feature in its own colour
   (colour-by column, per-feature ms_color, or the layer's colour), outline and opacity, and the
   timeline respected (only what shows at the slider's date, unless the timeline is hidden).
   No basemap, no labels, no panning: a figure for an article, a poster, the resource page.

   Lazy-loaded from More → SVG. d3-geo (+ d3-array it depends on) load from cdnjs on first use.
   MSSvgExport.build(opts) returns the SVG text (the gate reads it); open() shows the form. */
(function () {
  'use strict';
  if (window.MSSvgExport) return;
  var D3_ARRAY = 'https://cdn.jsdelivr.net/npm/d3-array@3.2.4/dist/d3-array.min.js';   // d3-geo's one dependency
  var D3_GEO = 'https://cdn.jsdelivr.net/npm/d3-geo@3.1.1/dist/d3-geo.min.js';
  var _d3 = null;
  function loadOnce(src) {
    return new Promise(function (res, rej) {
      if (document.querySelector('script[data-ms-src="' + src + '"]')) return res();
      var s = document.createElement('script'); s.src = src; s.async = true; s.setAttribute('data-ms-src', src);
      s.onload = function () { res(); }; s.onerror = function () { rej(new Error('could not load ' + src)); };
      document.head.appendChild(s);
    });
  }
  async function d3() {
    if (_d3) return _d3;
    await loadOnce(D3_ARRAY); await loadOnce(D3_GEO);
    if (!window.d3 || !window.d3.geoEqualEarth) throw new Error('d3-geo did not load');
    _d3 = window.d3; return _d3;
  }
  function db() { return (window.MapAuth && MapAuth.db) || null; }
  function pid() { return (typeof platformProjectId !== 'undefined' && platformProjectId) || window.platformProjectId || null; }
  function esc(s) { return String(s == null ? '' : s).replace(/[<>&"]/g, function (c) { return ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]; }); }
  function isHex(c) { return typeof c === 'string' && /^#[0-9a-f]{3,8}$/i.test(c); }
  function num(v, fb) { return typeof v === 'number' && isFinite(v) ? v : fb; }
  function dayInt(s) { if (!s) return null; var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s)); return m ? +(m[1] + m[2] + m[3]) : null; }

  // the map's leaves in DRAW order (first in the list draws on top, so the list is walked backwards)
  function leaves() {
    var out = [];
    (function walk(arr) { (arr || []).forEach(function (n) { if (!n) return; if (n.children) { walk(n.children); return; } if (n.type === 'fill' || n.type === 'line' || n.type === 'circle') out.push(n); }); })(typeof layers !== 'undefined' ? layers : []);
    return out.reverse();
  }
  function nodeLid(n) { return (window.slugToLayerDbId && window.slugToLayerDbId[n.id]) || n._layerDbId || n.tableId || null; }

  async function featuresOf(n, lid, status) {
    if (!window._msQuery || !_msQuery.fetchLayerFC) throw new Error('the query window is not loaded');
    var src = n._msFromLayer || n.instanceOf || null;   // a Linked layer / instance draws its source's data
    var fc = await _msQuery.fetchLayerFC(src || lid, status);
    return (fc && fc.features) || [];
  }
  // one feature's colour: per-feature ms_color, the colour-by column (own or this map's), else the layer's
  function colourOf(n, lid, f, vals) {
    var p = f.properties || {};
    if (isHex(p.ms_color)) return p.ms_color;
    var cb = n.colorBy;
    if (cb && cb.prop && cb.mapping) {
      var v = null;
      if (cb.custom && vals) { var k = window.MSCustomCols ? MSCustomCols.featureKey(n, f) : (f.id != null ? f.id : p.feature_id); var row = k != null ? vals[String(k)] : null; v = row ? row[cb.prop] : null; }
      else v = p[cb.prop];
      if (v != null && cb.mapping[String(v)]) return cb.mapping[String(v)];
      if (cb.hideNoValue && (v == null || v === '')) return null;   // hidden by the "no value" tick
    }
    return isHex(n.iconColor) ? n.iconColor : '#3bb2d0';
  }
  function styleOf(n) {
    var p = n.paint || {};
    var op = num(p[n.type + '-opacity'], null); if (op == null) op = num(n.styleBaseOp, 1);
    return {
      opacity: op,
      outline: isHex(p['fill-outline-color']) ? p['fill-outline-color'] : (n.type === 'fill' ? '#222' : null),
      outlineWidth: num(p['line-width'], n.type === 'fill' ? 0.5 : 1.5),
      radius: num(p['circle-radius'], 4),
      strokeColor: isHex(p['circle-stroke-color']) ? p['circle-stroke-color'] : '#fff'
    };
  }
  function dateFilter(n) {
    if (window.__msTimelineHidden || n.timelineIgnore) return null;
    var d = window.__msDate; if (!d || !window.moment) return null;
    return +window.moment.unix(d).format('YYYYMMDD');
  }
  function showsAt(f, day) {
    if (day == null) return true;
    var p = f.properties || {}, s = dayInt(p.start_date), e = dayInt(p.end_date);
    if (s != null && s > day) return false;
    if (e != null && e < day) return false;
    return true;
  }

  /* build(opts) → svg text. opts: { projection: 'equalEarth'|'mercator', extent: 'world'|'data',
     width: px, graticule: bool, sphere: bool, background: css colour|null, status: fn } */
  async function build(opts) {
    opts = opts || {}; var status = opts.status || function () {};
    var D = await d3();
    var proj = opts.projection === 'mercator' ? 'mercator' : 'equalEarth';
    var extent = opts.extent || (proj === 'equalEarth' ? 'world' : 'data');
    var W = Math.max(200, Math.min(8000, Math.round(num(opts.width, 1600))));
    var ls = leaves().filter(function (n) { return n.checked !== false; });
    if (!ls.length) throw new Error('no visible point, line or polygon layers to draw');
    // gather every layer's data first (the extent needs all of it)
    var packs = [];
    for (var i = 0; i < ls.length; i++) {
      var n = ls[i], lid = nodeLid(n); if (!lid) continue;
      status('Reading “' + (n.label || 'layer') + '”…');
      var feats = await featuresOf(n, lid, status);
      var day = dateFilter(n);
      feats = feats.filter(function (f) { return f.geometry && showsAt(f, day); });
      var vals = null;
      if (n.colorBy && n.colorBy.custom && window.MSCustomCols) { try { vals = MSCustomCols.cached(lid) || await MSCustomCols.load(lid); } catch (e) {} }
      packs.push({ n: n, lid: lid, feats: feats, vals: vals, style: styleOf(n) });
    }
    var all = { type: 'FeatureCollection', features: [] };
    packs.forEach(function (p) { p.feats.forEach(function (f) { all.features.push(f); }); });
    if (!all.features.length) throw new Error('nothing to draw at the current timeline date');
    status('Projecting ' + all.features.length.toLocaleString('en-US') + ' features…');
    var projection = proj === 'mercator' ? D.geoMercator() : D.geoEqualEarth();
    var H;
    if (extent === 'world') {
      var sphere = { type: 'Sphere' };
      H = Math.round(W / (proj === 'equalEarth' ? 2.05 : 1));
      if (proj === 'mercator') { projection.fitSize([W, H], { type: 'Polygon', coordinates: [[[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]]] }); }
      else projection.fitSize([W, H], sphere);
    } else {
      projection.fitWidth(W, all);
      var b = D.geoPath(projection).bounds(all);
      H = Math.max(100, Math.round(b[1][1] - b[0][1])) + 2;
      projection.fitSize([W, H], all);
    }
    var path = D.geoPath(projection);
    var out = ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '">'];
    if (opts.background) out.push('<rect width="' + W + '" height="' + H + '" fill="' + esc(opts.background) + '"/>');
    if (opts.sphere !== false && proj === 'equalEarth') out.push('<path d="' + path({ type: 'Sphere' }) + '" fill="#f4f6f8" stroke="#99a" stroke-width="1"/>');
    if (opts.graticule) out.push('<path d="' + path(D.geoGraticule10()) + '" fill="none" stroke="#c9ccd6" stroke-width="0.5"/>');
    packs.forEach(function (p) {
      var n = p.n, st = p.style;
      out.push('<g id="' + esc(n.id) + '" data-layer="' + esc(n.label || '') + '" opacity="' + st.opacity + '">');
      p.feats.forEach(function (f) {
        var c = colourOf(n, p.lid, f, p.vals); if (!c) return;
        if (isHex(f.properties && f.properties.ms_linecolor)) st = Object.assign({}, st, { outline: f.properties.ms_linecolor });
        if (n.type === 'circle') {
          var g = f.geometry, pts = g.type === 'Point' ? [g.coordinates] : (g.type === 'MultiPoint' ? g.coordinates : []);
          pts.forEach(function (pt) { var xy = projection(pt); if (!xy) return; out.push('<circle cx="' + xy[0].toFixed(1) + '" cy="' + xy[1].toFixed(1) + '" r="' + st.radius + '" fill="' + c + '" stroke="' + st.strokeColor + '" stroke-width="0.5"/>'); });
          return;
        }
        var d = path(f.geometry); if (!d) return;
        if (n.type === 'line') out.push('<path d="' + d + '" fill="none" stroke="' + c + '" stroke-width="' + st.outlineWidth + '" stroke-linejoin="round" stroke-linecap="round"/>');
        else out.push('<path d="' + d + '" fill="' + c + '"' + (st.outline ? ' stroke="' + st.outline + '" stroke-width="' + st.outlineWidth + '"' : '') + '/>');
      });
      out.push('</g>');
    });
    out.push('</svg>');
    status('SVG ready — ' + all.features.length.toLocaleString('en-US') + ' features, ' + W + ' × ' + H + '.');
    return out.join('\n');
  }

  function open() {
    var f = document.getElementById('editor-add-form'); if (!f) return;
    var hasEE = !!(typeof mapConfig !== 'undefined' && mapConfig && mapConfig.projection === 'equalEarth');
    f.innerHTML = '<div class="esec"><div class="esec-h">Export an SVG</div>' +
      '<div class="mss-note" style="margin:0 0 6px;">A still picture of this map\'s own layers in a real projection — for an article, a poster or the resource page. No basemap, no labels.</div>' +
      '<label class="mss-lbl">Projection</label><select id="svg-proj" class="mss-in"><option value="equalEarth"' + (hasEE ? ' selected' : '') + '>Equal Earth (whole world)</option><option value="mercator"' + (hasEE ? '' : ' selected') + '>Mercator</option></select>' +
      '<label class="mss-lbl" style="margin-top:6px;">Frame</label><select id="svg-extent" class="mss-in"><option value="world">The whole world</option><option value="data"' + (hasEE ? '' : ' selected') + '>Just the data</option></select>' +
      '<label class="mss-lbl" style="margin-top:6px;">Width (px)</label><input id="svg-w" type="number" class="mss-in" value="1600" min="200" max="8000">' +
      '<label class="mss-check" style="margin-top:6px;"><input id="svg-grat" type="checkbox" style="vertical-align:middle;margin:0 5px 0 0;" checked>Graticule</label>' +
      '<label class="mss-check"><input id="svg-bg" type="checkbox" style="vertical-align:middle;margin:0 5px 0 0;">White background</label>' +
      '<div class="erow" style="margin-top:8px;"><button id="svg-go">Build and download</button></div>' +
      '<div id="svg-status" class="mss-note" style="margin-top:6px;"></div>' +
      '<div class="mss-note">Draws what the map shows now: visible layers, each feature in its own colour, and only what the timeline currently shows. Big layers take a while and make a big file.</div></div>';
    var st = document.getElementById('svg-status');
    document.getElementById('svg-go').addEventListener('click', async function () {
      var btn = this; btn.disabled = true;
      try {
        var svg = await build({ projection: document.getElementById('svg-proj').value, extent: document.getElementById('svg-extent').value, width: +document.getElementById('svg-w').value, graticule: document.getElementById('svg-grat').checked, background: document.getElementById('svg-bg').checked ? '#ffffff' : null, status: function (m) { st.textContent = m; } });
        var name = ((typeof window.msProjectName === 'function' && window.msProjectName()) || document.title || 'map').replace(/[^\w\- ]+/g, '').trim() || 'map';
        var blob = new Blob([svg], { type: 'image/svg+xml' }), url = URL.createObjectURL(blob);
        var a = document.createElement('a'); a.href = url; a.download = name + '.svg'; document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
        st.textContent += ' Downloaded ' + name + '.svg (' + (blob.size / 1048576).toFixed(1) + ' MB).';
      } catch (e) { st.textContent = 'SVG failed: ' + ((e && e.message) || e); }
      finally { btn.disabled = false; }
    });
  }
  window.MSSvgExport = { open: open, build: build };
})();
