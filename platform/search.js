/* search.js — place search + "find my location". TOKENLESS since 7/14: the Mapbox Geocoder
   (metered API, needed a real token) is replaced by Photon (photon.komoot.io — free & open,
   OpenStreetMap data, no key; fair-use rate limits are far above an editor search box).
   Same behaviors: attaches to beforeMap; mapbox-gl-compare keeps afterMap in sync, so a
   search/locate flies BOTH swipe sides. Polls for beforeMap since the engine creates it
   asynchronously. GeolocateControl is pure browser API — it never needed a token. */
(function () {
  var PHOTON = "https://photon.komoot.io/api/";

  function ensureCss() {
    if (document.getElementById("ms-search-css")) return;
    var s = document.createElement("style"); s.id = "ms-search-css";
    s.textContent =
      ".ms-search{position:relative;margin:10px 0 0 10px;pointer-events:auto;font-family:'Source Sans Pro',Arial,sans-serif;}" +
      ".ms-search input{width:240px;padding:7px 10px;border:none;border-radius:5px;box-shadow:0 0 0 2px rgba(0,0,0,.1);font-size:13px;outline:none;background:#fff;color:#333;}" +
      ".ms-search-list{position:absolute;top:34px;left:0;right:0;background:#fff;border-radius:5px;box-shadow:0 4px 14px rgba(0,0,0,.25);overflow:hidden;z-index:30;display:none;}" +
      ".ms-search-list div{padding:7px 10px;font-size:12.5px;color:#333;cursor:pointer;border-top:1px solid #f2f2f2;}" +
      ".ms-search-list div:first-child{border-top:none;}" +
      ".ms-search-list div:hover,.ms-search-list div.sel{background:#eef4fb;}" +
      ".ms-search-list small{color:#999;display:block;font-size:10.5px;}";
    document.head.appendChild(s);
  }

  function label(f) {
    var p = f.properties || {};
    var main = p.name || [p.street, p.housenumber].filter(Boolean).join(" ") || p.city || "…";
    var rest = [p.city, p.state, p.country].filter(function (x) { return x && x !== main; }).join(", ");
    return { main: main, rest: rest };
  }

  function add() {
    if (typeof mapboxgl === "undefined" || typeof beforeMap === "undefined" || !beforeMap) { setTimeout(add, 500); return; }
    if (beforeMap._searchAdded) return;
    beforeMap._searchAdded = true;
    try {
      ensureCss();
      var holder = beforeMap.getContainer().querySelector(".mapboxgl-ctrl-top-left") ||
                   beforeMap.getContainer().querySelector(".maplibregl-ctrl-top-left");
      var box = document.createElement("div");
      box.className = "ms-search";
      box.innerHTML = "<input type=\"text\" placeholder=\"Search for a place…\" autocomplete=\"off\" spellcheck=\"false\" />" +
        "<div class=\"ms-search-list\"></div>";
      (holder || beforeMap.getContainer()).appendChild(box);

      var input = box.querySelector("input"), list = box.querySelector(".ms-search-list");
      var results = [], sel = -1, timer = null, seq = 0;

      function render() {
        if (!results.length) { list.style.display = "none"; list.innerHTML = ""; return; }
        list.innerHTML = results.map(function (f, i) {
          var l = label(f);
          return "<div data-i=\"" + i + "\" class=\"" + (i === sel ? "sel" : "") + "\">" + l.main +
            (l.rest ? "<small>" + l.rest + "</small>" : "") + "</div>";
        }).join("");
        list.style.display = "block";
      }
      function go(f) {
        if (!f || !f.geometry) return;
        var c = f.geometry.coordinates;
        var ext = f.properties && f.properties.extent;   // [minLon, maxLat, maxLon, minLat]
        list.style.display = "none";
        input.value = label(f).main;
        try {
          if (ext && ext.length === 4) beforeMap.fitBounds([[ext[0], ext[3]], [ext[2], ext[1]]], { padding: 60, maxZoom: 16, speed: 1.6 });
          else beforeMap.flyTo({ center: c, zoom: 14, speed: 1.6 });
        } catch (e) {}
      }
      function search(q) {
        var my = ++seq;
        var ctr = beforeMap.getCenter();
        fetch(PHOTON + "?q=" + encodeURIComponent(q) + "&limit=5&lat=" + ctr.lat.toFixed(4) + "&lon=" + ctr.lng.toFixed(4))
          .then(function (r) { return r.json(); })
          .then(function (j) { if (my !== seq) return; results = (j && j.features) || []; sel = -1; render(); })
          .catch(function () { if (my === seq) { results = []; render(); } });
      }
      input.addEventListener("input", function () {
        clearTimeout(timer);
        var q = input.value.trim();
        if (q.length < 3) { results = []; render(); return; }
        timer = setTimeout(function () { search(q); }, 300);
      });
      input.addEventListener("keydown", function (e) {
        if (e.key === "ArrowDown") { sel = Math.min(sel + 1, results.length - 1); render(); e.preventDefault(); }
        else if (e.key === "ArrowUp") { sel = Math.max(sel - 1, 0); render(); e.preventDefault(); }
        else if (e.key === "Enter") { go(results[sel >= 0 ? sel : 0]); e.preventDefault(); }
        else if (e.key === "Escape") { results = []; render(); input.blur(); }
      });
      list.addEventListener("mousedown", function (e) {
        var d = e.target.closest("[data-i]");
        if (d) { go(results[+d.getAttribute("data-i")]); e.preventDefault(); }
      });
      document.addEventListener("mousedown", function (e) { if (!box.contains(e.target)) { list.style.display = "none"; } });

      beforeMap.addControl(new mapboxgl.GeolocateControl({
        positionOptions: { enableHighAccuracy: true },
        trackUserLocation: false
      }), "top-left");
    } catch (e) { console.warn("search: init failed", e); }
  }
  add();
})();
