



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
	

	function getDate() {
		var sliderVal = moment($("#date").text()).unix();
		return parseInt(moment.unix(sliderVal).format("YYYYMMDD"));
	}

	var initialLoadDone = false;

	beforeMap.on("style.load", function() {
		addLayersToMap(beforeMap, "left", getDate());
		refreshLayers();
	});

	afterMap.on("style.load", function() {
		addLayersToMap(afterMap, "right", getDate());
		refreshLayers();
		if (!initialLoadDone) {
			initialLoadDone = true;
			addEvents();
			registerInfoPanelClicks();
		}
	});
	
	
	// Error Handling
    beforeMap.on("error", function (e) {
      if (e && e.error !== "Error") console.log(e);
    });

    afterMap.on("error", function (e) {
      if (e && e.error !== "Error") console.log(e);
    });

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
    if (beforeMap.getLayer(leftId))  beforeMap.setFilter(leftId,  dateFilter);
    if (afterMap.getLayer(rightId))  afterMap.setFilter(rightId,  dateFilter);
    // companion layers (stroke outline, hover highlight) get a date filter at ADD time —
    // they must follow the slider too, or outlines freeze at the boot date
    ["-stroke-", "-highlighted-"].forEach(sfx => {
      const l = layer.id + sfx + "left", r = layer.id + sfx + "right";
      if (beforeMap.getLayer(l)) beforeMap.setFilter(l, dateFilter);
      if (afterMap.getLayer(r)) afterMap.setFilter(r, dateFilter);
    });
  });
  
 } //end function changeDate

/////////////////////////////
//   ZOOM LABELS
/////////////////////////////






// Generic Layer Toggler
$(document).on('change', '.layer-list-row input[type="checkbox"]', function() {
    refreshLayers();
});