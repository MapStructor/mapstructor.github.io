/* LAYER ORDER — an explicit, saved stacking order, independent of the sidebar tree.
 *
 * WHY THIS EXISTS (owner 8/18, "it is fundamental… now that I'm actually making complex maps"):
 * draw order used to be an ACCIDENT of tree position. The engine adds layers by walking the
 * flattened tree, each with no beforeId, so every layer landed on top of the previous one — which
 * means the layer at the BOTTOM of the sidebar drew on TOP of the map, and a layer added during a
 * session sat on top only until the next reload or basemap switch rebuilt the stack from the tree.
 * Two different orders, neither of them chosen. This module makes the order a real, saved thing.
 *
 * THE MODEL
 *   • `raw_config.layerOrder` is an array of node ids, **index 0 = topmost on the map**. That
 *     matches how the panel reads (top of the list is top of the map) and is the REVERSE of the
 *     sidebar, which is exactly the confusion the panel exists to end.
 *   • A layer not in the stored array is NEW, and new layers go on top — so a fresh import lands
 *     where you can see it without anyone having to save an order first.
 *   • Sidebar drags no longer touch stacking (owner: "No, at least not for now").
 *   • Labels ride above everything by default (`raw_config.labelsOnTop !== false`), because that is
 *     what nearly every map wants and it is the case that made the bake cover its own labels.
 *
 * A "layer" is up to four map layers — base, -stroke-, -highlighted-, -label- — so ordering moves
 * each set as a BLOCK, preserving the internal order that makes outlines and hover work.
 *
 * Applying is cheap: map.moveLayer() reorders in place with no re-add, so no source reloads, no
 * tiles refetch, and the map never flashes.
 */
(function () {
  "use strict";
  var LO = {};
  window.MSLayerOrder = LO;

  var SIDES = { left: 1, right: 1 };
  function flat() {
    try {
      if (typeof flatLayers !== "function" || typeof layers === "undefined") return [];
      return flatLayers(layers) || [];
    } catch (e) { return []; }
  }
  function stored() { return Array.isArray(window.__msLayerOrder) ? window.__msLayerOrder.slice() : null; }
  LO.labelsOnTop = function () { return window.__msLabelsOnTop !== false; };

  /* The order actually in force: everything stored (minus layers that no longer exist), with any
     layer the stored order has never seen placed ON TOP, newest first. */
  LO.order = function () {
    var live = flat().map(function (n) { return n && n.id; }).filter(Boolean);
    var isLive = {}; live.forEach(function (id) { isLive[id] = 1; });
    var keep = (stored() || []).filter(function (id) { return isLive[id]; });
    var seen = {}; keep.forEach(function (id) { seen[id] = 1; });
    var fresh = live.filter(function (id) { return !seen[id]; }).reverse();   // last added = highest
    return fresh.concat(keep);
  };

  function nodeById(id) {
    var f = flat();
    for (var i = 0; i < f.length; i++) if (f[i] && f[i].id === id) return f[i];
    return null;
  }
  function moveOne(map, id) { try { if (map.getLayer(id)) map.moveLayer(id); } catch (e) {} }
  // bottom → top WITHIN the layer: fill, its outline, the hover highlight, then its label
  function moveBlock(map, nid, side) {
    moveOne(map, nid + "-" + side);
    moveOne(map, nid + "-stroke-" + side);
    moveOne(map, nid + "-highlighted-" + side);
    if (!LO.labelsOnTop()) moveOne(map, nid + "-label-" + side);
  }

  /* Reorder one map. Walks the wanted order BOTTOM-UP moving each block to the top, which lands
     the whole stack in the requested order in one pass and needs no beforeId arithmetic. */
  LO.apply = function (map, side) {
    if (!map || !map.getStyle || !SIDES[side]) return;
    try { if (!map.isStyleLoaded || !map.isStyleLoaded()) { /* still fine — moveLayer no-ops on missing ids */ } } catch (e) {}
    var ord = LO.order();
    for (var i = ord.length - 1; i >= 0; i--) moveBlock(map, ord[i], side);
    // labels last, so they sit above every data layer regardless of their owner's position
    if (LO.labelsOnTop()) for (var j = ord.length - 1; j >= 0; j--) moveOne(map, ord[j] + "-label-" + side);
    // the scrub bake positions itself from the layer it stands in for — re-place it after a move
    try { if (window.MSRasterScrub && MSRasterScrub.place) MSRasterScrub.place(); } catch (e) {}
  };
  LO.applyAll = function () {
    try { if (typeof beforeMap !== "undefined" && beforeMap) LO.apply(beforeMap, "left"); } catch (e) {}
    try { if (typeof afterMap !== "undefined" && afterMap) LO.apply(afterMap, "right"); } catch (e) {}
  };

  /* Persistence is injected by the editor (it owns the db handle and the project id); the viewer
     and standalone copies only ever READ an order, so they leave this unset. */
  LO.onSave = null;
  LO.set = function (ids, opts) {
    window.__msLayerOrder = ids.slice();
    LO.applyAll();
    if (LO.onSave && !(opts && opts.silent)) { try { LO.onSave(window.__msLayerOrder.slice()); } catch (e) {} }
  };
  // a newly added layer belongs on top, and stays there through reloads once written down
  LO.putOnTop = function (id) {
    if (!id) return;
    var cur = LO.order().filter(function (x) { return x !== id; });
    LO.set([id].concat(cur));
  };

  /* ── the panel ─────────────────────────────────────────────────────────────────────────────
     A FLAT list — stacking is global, and a tree cannot express it without lying. Rows drag with
     the pointer (jQuery UI sortable is not in this build, so the drag is hand-rolled: the row
     follows the cursor and the list re-flows live as it crosses each neighbour's midpoint). */
  function css() {
    if (document.getElementById("mslo-css")) return;
    var s = document.createElement("style"); s.id = "mslo-css";
    s.textContent =
      "#mslo-ov{position:fixed;inset:0;background:rgba(24,20,40,.45);z-index:100000;display:flex;align-items:center;justify-content:center;}" +
      "#mslo-panel{width:420px;max-width:94vw;max-height:82vh;display:flex;flex-direction:column;background:#fff;border-radius:10px;box-shadow:0 18px 50px rgba(0,0,0,.3);font:14px Source Sans Pro,Arial,sans-serif;}" +
      "#mslo-head{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:11px 13px;border-bottom:1px solid #e6e3ef;}" +
      "#mslo-head b{font-size:14px;}#mslo-head small{display:block;color:#6b6580;font-size:11px;font-weight:400;}" +
      "#mslo-close{cursor:pointer;font-size:20px;line-height:1;color:#6b6580;}" +
      "#mslo-list{overflow:auto;padding:8px;margin:0;list-style:none;}" +
      ".mslo-row{display:flex;align-items:center;gap:8px;padding:7px 9px;margin:3px 0;border:1px solid #e2e0ea;border-radius:6px;background:#fbfaff;cursor:grab;user-select:none;}" +
      ".mslo-row.mslo-hi{border-color:#a98cf0;background:#f3ecff;box-shadow:0 0 0 2px rgba(169,140,240,.25);}" +
      ".mslo-row.mslo-drag{opacity:.55;cursor:grabbing;}" +
      ".mslo-grip{color:#a29cba;font-size:13px;letter-spacing:1px;}" +
      ".mslo-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}" +
      ".mslo-sw{width:11px;height:11px;border-radius:3px;border:1px solid rgba(0,0,0,.18);flex:0 0 auto;}" +
      "#mslo-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 13px;border-top:1px solid #e6e3ef;}" +
      "#mslo-foot label{font-size:12px;color:#544f6e;}" +
      "#mslo-done{padding:5px 13px;border:1px solid #cdbff0;border-radius:6px;background:#f2ecff;color:#5b4b9a;font:600 12px Source Sans Pro,Arial,sans-serif;cursor:pointer;}" +
      "#mslo-note{padding:0 13px 9px;font-size:11px;color:#6b6580;}";
    document.head.appendChild(s);
  }

  LO.open = function (highlightId) {
    css();
    var old = document.getElementById("mslo-ov"); if (old) old.parentNode.removeChild(old);
    var ov = document.createElement("div"); ov.id = "mslo-ov";
    var rows = LO.order().map(function (id) {
      var n = nodeById(id) || {};
      return { id: id, label: (n.label || n.name || id), color: n.iconColor || (n.paint && (n.paint["line-color"] || n.paint["fill-color"] || n.paint["circle-color"])) || "#b9b3cd" };
    });
    ov.innerHTML =
      '<div id="mslo-panel">' +
        '<div id="mslo-head"><div><b>Layer order</b><small>Top of this list draws on top of the map</small></div><span id="mslo-close" title="Close">&times;</span></div>' +
        '<ul id="mslo-list">' +
          rows.map(function (r) {
            return '<li class="mslo-row' + (r.id === highlightId ? " mslo-hi" : "") + '" data-id="' + String(r.id).replace(/"/g, "&quot;") + '">' +
              '<span class="mslo-grip">⋮⋮</span>' +
              '<span class="mslo-sw" style="background:' + (typeof r.color === "string" ? r.color : "#b9b3cd") + '"></span>' +
              '<span class="mslo-name">' + String(r.label).replace(/</g, "&lt;") + "</span></li>";
          }).join("") +
        "</ul>" +
        '<div id="mslo-note">Drag a layer to move it above or below the others. This order is saved with the map and survives reloads, basemap switches and publishing.</div>' +
        '<div id="mslo-foot"><label><input type="checkbox" id="mslo-labels"' + (LO.labelsOnTop() ? " checked" : "") + ' style="vertical-align:middle;margin:0 5px 0 0;" />Keep labels above every layer</label>' +
        '<button id="mslo-done">Done</button></div>' +
      "</div>";
    document.body.appendChild(ov);
    try { window.__msModalLock = true; } catch (e) {}

    var list = ov.querySelector("#mslo-list");
    function commit() {
      var ids = [].slice.call(list.querySelectorAll(".mslo-row")).map(function (li) { return li.getAttribute("data-id"); });
      LO.set(ids);
    }
    var cleanup = function () {};   // assigned once the drag listeners exist (below)
    function close() {
      cleanup();
      try { window.__msModalLock = false; } catch (e) {}
      if (ov.parentNode) ov.parentNode.removeChild(ov);
    }
    ov.querySelector("#mslo-close").onclick = close;
    ov.querySelector("#mslo-done").onclick = close;
    ov.addEventListener("mousedown", function (e) { if (e.target === ov) close(); });
    ov.querySelector("#mslo-labels").onchange = function () {
      window.__msLabelsOnTop = !!this.checked;
      LO.applyAll();
      if (LO.onSave) { try { LO.onSave(LO.order().slice(), { labelsOnTop: !!this.checked }); } catch (e) {} }
    };

    /* hand-rolled drag: the row follows the pointer and the list re-flows as it passes each
       midpoint. POINTER events, not mouse — jquery.ui.touch-punch is in the build but it only
       patches jQuery UI widgets, and this list is not one, so a mouse-only drag left the panel
       readable but unusable on a tablet. Pointer events cover mouse, touch and pen in one path. */
    var dragging = null;
    var DOWN = window.PointerEvent ? "pointerdown" : "mousedown";
    var MOVE = window.PointerEvent ? "pointermove" : "mousemove";
    var UP = window.PointerEvent ? "pointerup" : "mouseup";
    list.addEventListener(DOWN, function (e) {
      var li = e.target.closest && e.target.closest(".mslo-row");
      if (!li) return;
      e.preventDefault();   // also stops touch scrolling from stealing the gesture
      dragging = li; li.classList.add("mslo-drag");
      try { if (e.pointerId != null && li.setPointerCapture) li.setPointerCapture(e.pointerId); } catch (e2) {}
    });
    document.addEventListener(MOVE, onMove);
    document.addEventListener(UP, onUp);
    if (window.PointerEvent) document.addEventListener("pointercancel", onUp);
    list.style.touchAction = "none";   // the list scrolls with the panel, not under a drag
    function onMove(e) {
      if (!dragging) return;
      var sibs = [].slice.call(list.querySelectorAll(".mslo-row"));
      for (var i = 0; i < sibs.length; i++) {
        if (sibs[i] === dragging) continue;
        var b = sibs[i].getBoundingClientRect(), mid = b.top + b.height / 2;
        if (e.clientY < mid && sibs[i].compareDocumentPosition(dragging) & Node.DOCUMENT_POSITION_FOLLOWING) { list.insertBefore(dragging, sibs[i]); break; }
        if (e.clientY > mid && sibs[i].compareDocumentPosition(dragging) & Node.DOCUMENT_POSITION_PRECEDING) { list.insertBefore(dragging, sibs[i].nextSibling); break; }
      }
    }
    function onUp() {
      if (!dragging) return;
      dragging.classList.remove("mslo-drag");
      dragging = null;
      commit();   // apply and save on release, so the map follows the list immediately
    }
    cleanup = function () {
      document.removeEventListener(MOVE, onMove); document.removeEventListener(UP, onUp);
      if (window.PointerEvent) document.removeEventListener("pointercancel", onUp);
    };
  };
})();
