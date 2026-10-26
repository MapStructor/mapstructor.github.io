// legend.js — the on-map legend, ONE renderer for the editor, the viewer and standalone copies
// (10/25; before this the legend lived in editing.js alone, so visitors never saw it).
//
// A layer joins the legend with `legend: true` (the panel's "Show legend on the map"). What it
// shows comes from the layer's colour-by mapping (value → colour); a single-colour layer shows its
// one swatch. `legendOpts` (raw_config, written by the layer panel) customises it:
//
//   legendOpts = {
//     group: true,            hierarchy — a value "Parent: Child" is one cell of its parent's row
//     sep: ":",               what splits parent from child
//     children: [{ value: "Confirmed", label: "Dark" }, …],   the columns, in order, with the
//                             label shown over them; empty = every child seen, named as in the data
//     extra: [{ color: "#00ffff", label: "Human Verified (currently none)" }]   hand-made entries
//   }
//
// Grouped, a layer reads as the owner sketched it:
//        Dark   Medium   Light
//        [■]    [■]      [■]     Government and Creditors
//        [■]    [■]      [■]     Creditors only
//        [■]                     Not a country              (a value with no child)
//        [■]                     Human Verified (currently none)   (an extra entry)
(function () {
  'use strict';
  if (window.MSLegend) return;
  var MAX_FLAT = 12;
  function esc(s) { return String(s == null ? '' : s).replace(/[<>&"]/g, function (c) { return ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]; }); }
  // 10/25 (owner's second round): title / subtitle text, a parent FIELD (a column whose value is
  // each colour value's parent, pre-resolved by the editor into `parents` = {value: parent} so the
  // viewer and the copies need no data), hideTitle, hideChildren (no column-header row), no "Legend" heading.
  function opts(node) { var o = (node && node.legendOpts) || {}; return { group: !!o.group, sep: (o.sep != null && String(o.sep) !== '') ? String(o.sep) : ':', children: Array.isArray(o.children) ? o.children.filter(function (c) { return c && c.value != null && String(c.value) !== ''; }) : [], extra: Array.isArray(o.extra) ? o.extra.filter(function (x) { return x && (x.label || x.color); }) : [], title: (o.title != null) ? String(o.title) : '', subtitle: (o.subtitle != null) ? String(o.subtitle) : '', hideTitle: !!o.hideTitle, hideChildren: !!o.hideChildren, parentField: o.parentField || '', parents: (o.parents && typeof o.parents === 'object') ? o.parents : null }; }
  // (hideParents, 10/25 first cut, was the wrong thing — the owner meant the CHILD names, the column
  // headers; it is ignored now. hideTitle hides the layer's title line.)
  // "Parent: Child" → [parent, child]; with a parent field: the field's value is the parent and the
  // child is what is left of the value once the parent text (and a separator) is taken off
  function splitValue(v, o) {
    var s = String(v), sep = o.sep;
    if (o.parentField && o.parents && o.parents[s] != null && String(o.parents[s]) !== '') {
      var par = String(o.parents[s]), rest = s;
      if (rest.toLowerCase().indexOf(par.toLowerCase()) === 0) rest = rest.slice(par.length);
      rest = rest.replace(/^[\s:;,\-–—|/]+|[\s:;,\-–—|/]+$/g, '');
      return [par, rest || null];
    }
    var i = s.indexOf(sep);
    if (i < 0) return [s, null];
    var parent = s.slice(0, i).trim(), child = s.slice(i + sep.length).trim();
    return parent && child ? [parent, child] : [s, null];
  }
  // the colour-by values in the owner's order: colorBy.order (the ↑↓ arrows) first, then any value
  // the order list does not know yet, alphabetically — one rule for the legend, the panel's list
  // and the sidebar's style rows (editing.js / viewerTable.js call this)
  function orderedValues(cb) {
    if (!cb || !cb.mapping) return [];
    var ks = Object.keys(cb.mapping), order = Array.isArray(cb.order) ? cb.order.filter(function (v) { return ks.indexOf(v) > -1; }) : [];
    var rest = ks.filter(function (k) { return order.indexOf(k) < 0; }).sort(function (a, b) { return String(a).localeCompare(String(b)); });
    return order.concat(rest);
  }
  // the legend's model for one layer: { cols: [labels] | null, rows: [{ cells: [color|null…] | null, color, label }] }
  function model(node) {
    var cb = node && node.colorBy, o = opts(node), rows = [], cols = null;
    if (cb && cb.mode === 'presence') rows = [{ color: cb.present || '#3bb2d0', label: 'Labeled' }, { color: cb.absent || '#cccccc', label: 'Unlabeled' }];
    else if (cb && cb.mapping) {
      // values hidden in the PANEL (Color by → hide) are not in the legend; the sidebar's style
      // category ticks are a viewer's own toggles and leave the legend alone (owner 10/25)
      var hiddenVals = Array.isArray(cb.hidden) ? cb.hidden : [];
      var ks = orderedValues(cb).filter(function (k) { return hiddenVals.indexOf(k) < 0; });
      if (o.group) {
        var parents = [], byParent = {}, seenChildren = [];
        ks.forEach(function (k) {
          var pc = splitValue(k, o);
          if (pc[1] == null) { rows.push({ color: cb.mapping[k], label: (k === ' ' || k === '') ? '(blank)' : k, single: true }); return; }
          if (!byParent[pc[0]]) { byParent[pc[0]] = {}; parents.push(pc[0]); }
          byParent[pc[0]][pc[1]] = cb.mapping[k];
          if (seenChildren.indexOf(pc[1]) < 0) seenChildren.push(pc[1]);
        });
        // ORDER = the Color by list's order (colorBy.order, set with the ↑↓ arrows in the panel; the
        // stored mapping's own key order is not stable — jsonb keeps keys by length, then text).
        // Parents and children follow the first value that names them in that order.
        var children = o.children.length ? o.children : seenChildren.map(function (c) { return { value: c, label: c }; });
        if (parents.length) {
          cols = children.map(function (c) { return c.label || c.value; });
          var grouped = parents.map(function (p) { return { cells: children.map(function (c) { var v = byParent[p][c.value]; return v == null ? null : v; }), label: p }; });
          rows = grouped.concat(rows);   // parents first, the childless values after them
        }
      } else {
        rows = ks.slice(0, MAX_FLAT).map(function (k) { return { color: cb.mapping[k], label: (k === ' ' || k === '') ? '(blank)' : k }; });
        if (ks.length > MAX_FLAT) rows.push({ color: 'transparent', label: '… +' + (ks.length - MAX_FLAT) + ' more' });
      }
    } else {
      var key = (node && node.type === 'line') ? 'line-color' : ((node && node.type === 'circle') ? 'circle-color' : 'fill-color');
      var col = (node && node.paint && typeof node.paint[key] === 'string' && node.paint[key]) || (node && node.iconColor) || '#3bb2d0';
      rows = [{ color: col, label: (node && node.label) || 'Layer' }];
    }
    o.extra.forEach(function (x) { rows.push({ color: x.color || '#00ffff', label: x.label || '', extra: true }); });
    return { cols: cols, rows: rows };
  }
  // the flat list the editor's older callers expect ([{label,color}])
  function itemsFor(node) {
    var m = model(node), out = [];
    m.rows.forEach(function (r) {
      if (r.cells) r.cells.forEach(function (c, i) { if (c != null) out.push({ label: r.label + ' — ' + m.cols[i], color: c }); });
      else out.push({ label: r.label, color: r.color });
    });
    return out;
  }
  var SW = function (c, dashed) { return '<span class="ms-lg-sw" style="background:' + esc(c == null ? 'transparent' : c) + (c == null ? ';border-style:dashed;opacity:.45' : '') + '"></span>'; };
  function layerHtml(node) {
    var m = model(node), o = opts(node), n = m.cols ? m.cols.length : 1;
    var title = o.title !== '' ? o.title : (node.label || 'Layer');
    // the column width follows the child names: wide enough for the longest header while the
    // headers show, and just the swatch (side by side) once they are hidden (owner 10/25)
    var showHead = !!(m.cols && !o.hideChildren);
    var longest = showHead ? Math.max.apply(null, m.cols.map(function (c) { return String(c).length; }).concat([0])) : 0;
    var cw = showHead ? Math.max(28, Math.min(90, Math.round(longest * 6.4 + 8))) : 28;
    var CELL = function (inner, extra) { return '<span class="ms-lg-cell" style="flex:0 0 ' + cw + 'px"' + (extra || '') + '>' + inner + '</span>'; };
    var h = '<div class="ms-lg-layer">' + (o.hideTitle ? '' : '<div class="ms-lg-title">' + esc(title) + '</div>') + (o.subtitle ? '<div class="ms-lg-sub">' + esc(o.subtitle) + '</div>' : '');
    if (showHead) h += '<div class="ms-lg-row ms-lg-head">' + m.cols.map(function (c) { return '<span class="ms-lg-cell ms-lg-col" style="flex:0 0 ' + cw + 'px" title="' + esc(c) + '">' + esc(c) + '</span>'; }).join('') + '<span class="ms-lg-lbl"></span></div>';
    m.rows.forEach(function (r) {
      // swatches sit at the RIGHT of their cell (owner 10/25), so the colours end against the names;
      // a single-value row puts its empty span first for the same reason — the swatch touches the name
      if (r.cells) h += '<div class="ms-lg-row ms-lg-parent">' + r.cells.map(function (c, i) { return CELL(SW(c), ' title="' + esc(m.cols[i]) + '"'); }).join('') + '<span class="ms-lg-lbl" title="' + esc(r.label) + '">' + esc(r.label) + '</span></div>';
      else h += '<div class="ms-lg-row' + (r.extra ? ' ms-lg-extra' : '') + '">' + (m.cols && n > 1 ? '<span class="ms-lg-cell ms-lg-span" style="flex:0 0 ' + ((n - 1) * cw) + 'px"></span>' : '') + CELL(SW(r.color)) + '<span class="ms-lg-lbl" title="' + esc(r.label) + '">' + esc(r.label) + '</span></div>';
    });
    return h + '</div>';
  }
  function css() {
    if (document.getElementById('ms-legend-css')) return;
    var s = document.createElement('style'); s.id = 'ms-legend-css';
    s.textContent =
      '#ms-legend{position:fixed;z-index:3980;bottom:80px;max-width:300px;max-height:42vh;overflow:auto;background:rgba(255,255,255,0.95);border:1px solid #c9bfe8;border-radius:6px;box-shadow:0 2px 10px rgba(0,0,0,0.15);padding:8px 11px;font-family:"Source Sans Pro",Arial,sans-serif;font-size:12px;color:#2b3a4a;}' +
      '#ms-legend .ms-lg-layer{margin-bottom:7px}#ms-legend .ms-lg-layer:last-child{margin-bottom:0}#ms-legend .ms-lg-title{font-weight:700;margin-bottom:7px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}#ms-legend .ms-lg-sub{font-size:11px;color:#6b6680;margin:-6px 0 8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
      '#ms-legend .ms-lg-row{display:flex;align-items:center;gap:0;margin:1px 0;min-height:16px}#ms-legend .ms-lg-cell{flex:0 0 50px;display:flex;justify-content:flex-end;align-items:center;padding-right:4px;box-sizing:border-box}' +
      '#ms-legend .ms-lg-sw{display:inline-block;width:22px;height:13px;border:1px solid #999999;border-radius:2px}' +
      '#ms-legend .ms-lg-lbl{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding-left:4px}' +
      '#ms-legend .ms-lg-head .ms-lg-col{font-size:10px;font-weight:700;color:#5b43a8;letter-spacing:.03em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;justify-content:flex-end;text-align:right}' +
      '#ms-legend .ms-lg-extra .ms-lg-lbl{font-style:italic}';
    document.head.appendChild(s);
  }
  // is this layer on? the editor tracks node.checked; the viewer's truth is the sidebar checkbox
  function isOn(n) {
    var el = document.getElementById(n.toggleElement || n.id);
    if (el && el.type === 'checkbox') return !!el.checked;
    return n.checked !== false;
  }
  function render(tree) {
    tree = tree || (typeof layers !== 'undefined' ? layers : null); if (!tree) return;
    css();
    var box = document.getElementById('ms-legend');
    if (!box) { box = document.createElement('div'); box.id = 'ms-legend'; document.body.appendChild(box); }
    var on = [];
    (function walk(arr) { (arr || []).forEach(function (n) { if (!n) return; if (n.legend && isOn(n)) on.push(n); if (n.children) walk(n.children); }); })(tree);
    if (!on.length) { box.style.display = 'none'; return; }
    box.style.display = 'block';
    box.innerHTML = on.map(layerHtml).join('');   // no "Legend" heading (owner 10/25) — the layer's title is the heading
    place(true);
  }
  /* WHERE IT SITS (owner 10/25): always just right of the layer sidebar, never over it, and it
     follows the sidebar when that slides shut (#studioMenu animates its margin to -337px / -111%).
     The sidebar's live right edge is the one truth — read it, not a constant — and re-read it on a
     short clock while the box is showing, since the slide is a 500 ms animation with no event. */
  var _lastLeft = null, _placeT = null;
  function place(force) {
    var box = document.getElementById('ms-legend'); if (!box || box.style.display === 'none') return;
    var sb = document.getElementById('studioMenu'), r = sb ? sb.getBoundingClientRect() : null;
    var open = !!(r && r.width > 0 && r.right > 8 && getComputedStyle(sb).display !== 'none');
    var left = open ? Math.round(r.right + 8) : 12;
    if (force || left !== _lastLeft) { box.style.left = left + 'px'; _lastLeft = left; }
    box.style.maxWidth = Math.max(160, Math.min(320, window.innerWidth - left - 12)) + 'px';
    if (!_placeT) _placeT = setInterval(function () { var b2 = document.getElementById('ms-legend'); if (!b2 || b2.style.display === 'none') { clearInterval(_placeT); _placeT = null; return; } place(false); }, 250);
  }
  window.addEventListener('resize', function () { place(true); });
  // the viewer: draw once the layer tree is on the page, and again whenever a sidebar checkbox moves
  var booted = false;
  function boot() {
    if (booted) return; booted = true;
    // the layer tree fills in after the snapshot arrives, so one early render finds nothing: keep
    // re-rendering (idempotent) through the first 20 s, then stop — the change listener takes over
    var tries = 0, t = setInterval(function () { tries++; try { if (typeof layers !== 'undefined' && layers && document.getElementById('layers-panel-content')) render(); } catch (e) {} if (tries > 40) clearInterval(t); }, 500);
    document.addEventListener('change', function (ev) { var el = ev.target; if (el && el.type === 'checkbox' && el.closest && el.closest('#layers-panel-content')) setTimeout(function () { render(); }, 0); });
  }
  window.MSLegend = { model: model, itemsFor: itemsFor, render: render, boot: boot, opts: opts, orderedValues: orderedValues };
  if (!window.__msRenderLegend) window.__msRenderLegend = function () { render(); };   // the editor overrides with its own wrapper
  if (typeof platformEditor === 'undefined' && !/editor\.html/.test(location.pathname)) boot();   // the viewer and standalone copies
})();
