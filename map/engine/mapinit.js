



//ACCESS TOKEN

//Restricted Token (defined in js/lists/restrictedToken.js)
mapboxgl.accessToken =
	(typeof mapboxToken !== 'undefined') ? mapboxToken :
	(typeof restrictedToken !== 'undefined') ? restrictedToken : "";


var beforeMap;
var afterMap;
var map;

// Platform projects (?id=<uuid>) load their config asynchronously;
// platform/projectLoader.js calls initMaps() once it arrives.
function initMaps() {

	const beforeMapConfig = {
		container: "before",
		style: mapConfig.style,
		center: mapConfig.center,
		hash: true,
		zoom: mapConfig.zoom,
		attributionControl: true,
		projection: "mercator",
	};

	const afterMapConfig  = {
		container: "after",
		style: mapConfig.style,
		center: mapConfig.center,
		hash: true,
		zoom: mapConfig.zoom,
		attributionControl: true,
		projection: "mercator",
	};
	
	//ADD MAP CONTAINER
	
	beforeMap = new mapboxgl.Map(beforeMapConfig);
    afterMap = new mapboxgl.Map(afterMapConfig);

    map = new mapboxgl.Compare(beforeMap, afterMap, "#comparison-container", {
      // Set this to enable comparing two maps by mouse movement:
      // mousemove: true
    });
	
	//ADD NAVIGATION CONTROLS (ZOOM IN AND OUT)


	var nav_left = new mapboxgl.NavigationControl();
	beforeMap.addControl(nav_left, "bottom-right");
	var nav_right = new mapboxgl.NavigationControl();
	afterMap.addControl(nav_right, "bottom-right");

	setupInfoPanels();
	

	// The boot date, and it must not depend on a race. Layers take their date filter at ADD time
	// (addLayersToMap(map, side, getDate())), and this used to read the TEXT of #date — which
	// $(document).ready writes. In a STANDALONE export every script and the basemap style are
	// local, so style.load beats document.ready: #date was still "", moment("") is invalid, and
	// every layer was added with date = NaN. addMapLayer treats a falsy date as "no filter", so
	// the map opened showing ALL data while the slider read 1872, and nothing ever re-applied
	// (8/17 — shipped in the railways showcase). Ask the SLIDER first, fall back to the text, and
	// last to sliderMiddle, which exists from script-eval time and needs no DOM at all.
	function getDate() {
		var t = $("#date").text(), v = t ? moment(t).unix() : null;   // #date tracks every drag — still the truth
		if ((v == null || isNaN(v)) && typeof sliderMiddle === "number") v = Math.round(sliderMiddle);
		if (v == null || isNaN(v)) return null;   // null, never NaN — callers test truthiness
		return parseInt(moment.unix(v).format("YYYYMMDD"));
	}

	var initialLoadDone = false;

	// Re-add data layers whenever a style loads. DEFERRED one tick: on a non-diffable basemap
	// switch (inline free styles) mapbox-gl can still be swapping style objects when style.load
	// fires — synchronous adds land in the DYING style and vanish (the "Clean basemap hides all
	// data" bug, 7/18). The idle self-heal then re-adds ANYTHING still missing — every data
	// layer AND its label layer (labels vanished while data survived when only the first data
	// layer was checked) — retrying up to 3 idles. addMapLayer is idempotent, so re-running the
	// whole pass is safe.
	function readdSide(map, side) {
		map.__msBooted = true;   // generateMaps.applyStyle: post-boot switches apply immediately
		function add() {
			// a second setStyle can land between style.load and this deferred tick (boot auto-switch)
			// — the add then hits a mid-load style and throws "Style is not done loading"; swallow it,
			// the idle self-heal below re-adds once the winning style settles
			try {
				addLayersToMap(map, side, getDate());
				// the saved stacking order is re-applied here because THIS is the path a reload and a
				// basemap switch both take — without it the stack silently reverts to tree order (8/18)
				try { if (window.MSLayerOrder) MSLayerOrder.apply(map, side); } catch (eLO) {}
				if (typeof msRaiseLabelLayers === "function") msRaiseLabelLayers(map, layers);
				refreshLayers();
			} catch (e) {}
		}
		function healthy() {
			try {
				return flatLayers(layers).every(function (l) {
					if (!map.getLayer(l.id + "-" + side)) return false;
					var t = l.source && l.source.type;
					var wantsLabel = l.labels && l.labels.field &&
						(t === "geojson" || (t === "vector" && l.type === "line"));   // mirror msLabelLayerFor's support test
					return !wantsLabel || !!map.getLayer(l.id + "-label-" + side);
				});
			} catch (e) { return true; }
		}
		setTimeout(add, 0);
		var heals = 0;
		function heal() {
			try { if (!healthy()) { add(); if (++heals < 3) map.once("idle", heal); } } catch (e) {}
		}
		map.once("idle", heal);
	}
	beforeMap.on("style.load", function() {
		readdSide(beforeMap, "left");
	});

	afterMap.on("style.load", function() {
		readdSide(afterMap, "right");
		if (!initialLoadDone) {
			initialLoadDone = true;
			addEvents();
			registerInfoPanelClicks();
		}
	});
	
	
	// Error Handling — tokenless maps (free basemaps, empty accessToken) fire a benign
	// "valid Mapbox access token required" event by design; only that exact case is skipped,
	// and only while the token really is empty. Everything else still logs.
    function msMapError(e) {
      var msg = String((e && e.error && e.error.message) || "");
      if (!mapboxgl.accessToken && /valid Mapbox access token/i.test(msg)) return;
      if (e && e.error !== "Error") console.log(e);
    }
    beforeMap.on("error", msMapError);
    afterMap.on("error", msMapError);

	setupMapSwitching();
}

if (typeof platformProjectId === 'undefined' || !platformProjectId) initMaps();


function zoomtobounds(boundsName) {
  const bounds = boundsList[boundsName];
  if (!bounds) return;
  beforeMap.fitBounds(bounds, { bearing: 0 });
  afterMap.fitBounds(bounds, { bearing: 0 });
}
/*

#13.63/42.03112/-93.63661


*/

// Zoom to Layer Function — a custom zoom target wins; without one, DEFAULT to the
// features' full extent (computed from the geojson already in memory — one cheap pass).
function layerExtent(node) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  function coords(g, cb) {
    if (!g) return;
    if (g.type === "GeometryCollection") { (g.geometries || []).forEach(x => coords(x, cb)); return; }
    (function walk(c) { if (!c || !c.length) return; if (typeof c[0] === "number") cb(c[0], c[1]); else c.forEach(walk); })(g.coordinates || []);
  }
  function grow(w, s, e2, n2) { if (w < x0) x0 = w; if (s < y0) y0 = s; if (e2 > x1) x1 = e2; if (n2 > y1) y1 = n2; }
  (function scan(n) {
    if (!n) return;
    if (n.children) { n.children.forEach(scan); return; }
    const feats = n.source && n.source.type === "geojson" && n.source.data && n.source.data.features;
    if (feats && feats.length) feats.forEach(f => coords(f.geometry, (lng, lat) => grow(lng, lat, lng, lat)));
    else if (n.source && n.source.bounds) { const b = n.source.bounds; grow(b[0], b[1], b[2], b[3]); }
    else {
      // tilesets: the config has no bounds, but the LIVE map source carries them once its tilejson loads
      try {
        const s = (typeof beforeMap !== "undefined" && beforeMap && beforeMap.getSource) ? beforeMap.getSource(n.id + "-left") : null;
        if (s && s.bounds) grow(s.bounds[0], s.bounds[1], s.bounds[2], s.bounds[3]);
        else if (typeof beforeMap !== "undefined" && beforeMap && beforeMap.querySourceFeatures) {
          // worker / PMTiles {z}/{x}/{y} sources have no tilejson bounds — fall back to the extent of
          // the currently-loaded features (all that's queryable client-side without a tilejson)
          const opts = n["source-layer"] ? { sourceLayer: n["source-layer"] } : {};
          beforeMap.querySourceFeatures(n.id + "-left", opts).forEach(f => coords(f.geometry, (lng, lat) => grow(lng, lat, lng, lat)));
        }
      } catch (e) {}
    }
  })(node);
  return isFinite(x0) ? [[x0, y0], [x1, y1]] : null;
}
function zoomToLayer(label, _retry) {
  const layer = findLayer(layers, label);
  if (!layer) return;
  if (layer.zoomCenter) {
    const zoomLeft = layer.zoomLevelLeft ?? layer.zoomLevel;
    const zoomRight = layer.zoomLevelRight ?? layer.zoomLevel;
    beforeMap.flyTo({center: layer.zoomCenter, zoom: zoomLeft, bearing: 0});
    afterMap.flyTo({center: layer.zoomCenter, zoom: zoomRight, bearing: 0});
    return;
  }
  const b = layerExtent(layer);
  // right after boot a tileset's tilejson (or a deferred layer's features) may not have arrived
  // yet — keep trying briefly instead of silently doing nothing
  if (!b) { if ((_retry || 0) < 15) setTimeout(function () { zoomToLayer(label, (_retry || 0) + 1); }, 300); return; }
  beforeMap.fitBounds(b, { padding: 60, bearing: 0, maxZoom: 17 });
  afterMap.fitBounds(b, { padding: 60, bearing: 0, maxZoom: 17 });
}




// on Map events
//var urlHash = window.location.hash;





// TIME LAYER FILTERING

function changeDate(unixDate) {
  var date = parseInt(moment.unix(unixDate).format("YYYYMMDD"));
  var dateFilter = ["all", ["<=", "DayStart", date], [">=", "DayEnd", date]];
  

  //LAYERS FOR FILTERING
  flatLayers(layers).forEach(layer => {
    const leftId  = layer.id + "-left";
    const rightId = layer.id + "-right";
    // 7/21: timelineIgnore — this layer always shows EVERYTHING (e.g. a linked instance used as an
    // "all data at once" view of end-dated data). Clear any date filter instead of applying one.
    const lf = layer.timelineIgnore ? null : dateFilter;
    if (beforeMap.getLayer(leftId))  beforeMap.setFilter(leftId,  lf);
    if (afterMap.getLayer(rightId))  afterMap.setFilter(rightId,  lf);
    // companion layers (stroke outline, hover highlight) get a date filter at ADD time —
    // they must follow the slider too, or outlines freeze at the boot date
    ["-stroke-", "-highlighted-"].forEach(sfx => {
      const l = layer.id + sfx + "left", r = layer.id + sfx + "right";
      if (beforeMap.getLayer(l)) beforeMap.setFilter(l, lf);
      if (afterMap.getLayer(r)) afterMap.setFilter(r, lf);
    });
    // 7/21: LABELS follow the slider too — coalesce keeps dateless anchors (group/point anchors carry
    // no Day props) always visible, while tile-riding labels hide with their features
    const lblF = layer.timelineIgnore ? null
      : ["all", ["<=", ["coalesce", ["get", "DayStart"], 0], date], [">=", ["coalesce", ["get", "DayEnd"], 99999999], date]];
    ["-label-"].forEach(sfx => {
      const l = layer.id + sfx + "left", r = layer.id + sfx + "right";
      if (beforeMap.getLayer(l)) beforeMap.setFilter(l, lblF);
      if (afterMap.getLayer(r)) afterMap.setFilter(r, lblF);
    });
  });
  
 } //end function changeDate

// ── FAST SCRUB (7/16): while the slider is being DRAGGED, date-visibility runs through PAINT
// (opacity case-expressions). setFilter forces the worker to re-process every visible tile per
// tick — the scrub lag on big tilesets; paint updates skip re-layout entirely. On release the
// slider calls endDatePaint() (restores the stored paint) + changeDate() (the real setFilter),
// so at rest hit-testing, clicks and hovers behave exactly as before. NOTE: this changes no
// loading — tiles always contain every feature; only WHERE the hide happens moves (GPU paint
// stage instead of worker re-layout).
var _dpBase = {};   // "<layerId>|<paintKey>" → the layer's own paint value, saved at first wrap
// Layers whose date FILTER was dropped for the current drag. The paint case can only HIDE —
// a feature excluded by the filter is not rendered at all, so no opacity can show it. With the
// filter frozen at the drag-start date, dragging BACKWARD animated (paint hides live) while
// dragging FORWARD showed nothing until mouse-up, when everything new popped in at once
// ("pay attention to what happens when you release, and how Santa Fe appears" — owner 8/7,
// after a full day of this reading as "animation is not working"). Dropping the filter costs
// one re-layout at the first tick of a drag; the per-tick work stays pure paint. changeDate
// rebuilds every filter at release, so nothing here needs restoring by hand.
var _dpFilterDropped = {};
function _dpDropFilter(m, id) {
  if (_dpFilterDropped[id]) return;
  _dpFilterDropped[id] = 1;
  try { if (m.getLayer(id)) m.setFilter(id, null); } catch (e) {}
}
var _DP_KEYS = { fill: ["fill-opacity"], line: ["line-opacity"], circle: ["circle-opacity", "circle-stroke-opacity"] };
// A `-highlighted-` companion draws every feature of its layer and paints all of them transparent
// unless that feature is hovered or SELECTED. During a slider drag the pointer is on the slider, so
// nothing can become hovered — only an existing selection can be visible on it. With no selection
// there is nothing on that layer for anyone to see, and wrapping its paint every tick is pure waste:
// measured 8/21, 280 of the 714 style calls in a one-second drag, on two different maps.
// When we cannot tell (no selection store on the page), we keep painting — unchanged behaviour.
var _hlCouldShow = true;
function _highlightCouldShow() {
  try {
    if (window.MSSel && typeof MSSel.count === "function") {
      if (MSSel.count() > 0) return true;
      if (document.querySelector(".mapboxgl-popup")) return true;   // an open popup means a live selection
      return false;
    }
  } catch (e) {}
  return true;
}
function _dpTargets() {
  var t = [];
  // 8/17 SWAP: a faster renderer (deck.gl, or the baked raster) may be drawing the drag for some
  // layers — it hides their vector and lists them in __msScrubOwned. Touching their paint here
  // would re-process tiles for something nobody can see, which is exactly the cost the swap
  // removes. Layers it does NOT cover (geojson, mapbox-hosted tilesets) still scrub through this
  // paint path, unchanged. Empty/absent set = this function behaves as it always did.
  var owned = window.__msScrubOwned || null;
  flatLayers(layers).forEach(function (layer) {
    if (layer.timelineIgnore) return;   // 7/21: always-show layers never dim during a scrub either
    if (owned && owned[layer.id]) return;
    // a layer switched OFF in the sidebar is visibility:none — wrapping its paint per tick is pure
    // waste (measured 8/17: 740 setPaintProperty calls per drag on invisible layers alone)
    try { var cb0 = document.getElementById(layer.toggleElement || layer.id); if (cb0 && cb0.type === "checkbox" && !cb0.checked) return; } catch (e0) {}
    var kind = _DP_KEYS[layer.type] ? layer.type : null;
    if (kind) {
      t.push([beforeMap, layer.id + "-left", kind], [afterMap, layer.id + "-right", kind]);
      if (_hlCouldShow) t.push([beforeMap, layer.id + "-highlighted-left", kind], [afterMap, layer.id + "-highlighted-right", kind]);
    }
    t.push([beforeMap, layer.id + "-stroke-left", "line"], [afterMap, layer.id + "-stroke-right", "line"]);
  });
  return t;
}
function paintDate(unixDate) {
  // decided ONCE per drag (first tick, while _dpBase is still empty): a selection cannot appear
  // mid-drag, because the pointer is holding the slider
  if (!Object.keys(_dpBase).length) _hlCouldShow = _highlightCouldShow();
  var day = parseInt(moment.unix(unixDate).format("YYYYMMDD"));
  var ok = ["all", ["<=", ["coalesce", ["get", "DayStart"], 0], day], [">=", ["coalesce", ["get", "DayEnd"], 99999999], day]];
  _dpTargets().forEach(function (tg) {
    var m = tg[0], id = tg[1];
    if (!m || !m.getLayer(id)) return;
    _dpDropFilter(m, id);   // paint owns visibility for the whole drag — both directions
    _DP_KEYS[tg[2]].forEach(function (key) {
      var ck = id + "|" + key;
      if (!(ck in _dpBase)) {
        var base = m.getPaintProperty(id, key);
        _dpBase[ck] = base == null ? 1 : base;
      }
      // layers whose base opacity is a top-level zoom curve can't nest inside `case` — the throw
      // is caught and that layer simply stays unfiltered until release (changeDate corrects it)
      try { m.setPaintProperty(id, key, ["case", ok, _dpBase[ck], 0]); } catch (e) {}
    });
  });
}
function endDatePaint() {
  Object.keys(_dpBase).forEach(function (ck) {
    var i = ck.lastIndexOf("|"), id = ck.slice(0, i), key = ck.slice(i + 1);
    [beforeMap, afterMap].forEach(function (m) {
      try { if (m && m.getLayer(id)) m.setPaintProperty(id, key, _dpBase[ck]); } catch (e) {}
    });
  });
  _dpBase = {};
  _dpFilterDropped = {};   // changeDate (called right after) rebuilds every filter at the release date
}

/////////////////////////////
//   ZOOM LABELS
/////////////////////////////






// Generic Layer Toggler
$(document).on('change', '.layer-list-row input[type="checkbox"]', function() {
    refreshLayers();
});