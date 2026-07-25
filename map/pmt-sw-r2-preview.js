/* pmt-sw-r2-preview.js — PREVIEW of the dual-source tile service worker (R2 first, Supabase
   Storage fallback). NOT registered anywhere yet: projectLoader still registers pmt-sw.js.
   To go live: set R2_BASE below, then either copy this file over pmt-sw.js or point the
   registration here. Identical to pmt-sw.js except archive-URL resolution.

   Source model:
   - R2_BASE = null  → behaves exactly like today (Supabase Storage only).
   - R2_BASE set     → each layer's archive is tried on R2 first; any failure (404 during the
     migration window, network error, bad archive) falls back to Supabase Storage. The winning
     source is remembered per layer so steady-state tiles never double-probe; a later failure
     of the remembered source clears the memo and re-probes both.
   All ETag staleness / retry-once semantics are unchanged and apply per-URL. */

var SUPABASE_URL = "https://eqpxlwbjqiwfjlsuapvu.supabase.co";
var BUCKET = "tiles";

/* R2 public read base — the R2 custom domain (or Worker /r2 route for private maps).
   Example: "https://tiles.mapstructor.com". Keys under it mirror the Supabase layout:
   <base>/<projectId>/<layerId>.pmtiles. null = R2 disabled (today's behavior). */
var R2_BASE = null;

self.addEventListener("install", function () { self.skipWaiting(); });
self.addEventListener("activate", function (e) { e.waitUntil(self.clients.claim()); });

/* ── PMTiles v3 reading (unchanged from pmt-sw.js) ──────────────────────── */

function readVarints(u8) {
  var out = [], shift = 0, val = 0;
  for (var i = 0; i < u8.length; i++) {
    var b = u8[i];
    val += (b & 0x7f) * Math.pow(2, shift);   // multiplicative — safe past 32 bits
    if (b & 0x80) { shift += 7; }
    else { out.push(val); shift = 0; val = 0; }
  }
  return out;
}

function parseDirectory(u8) {
  var v = readVarints(u8);
  var n = v[0], entries = [], tid = 0;
  for (var i = 0; i < n; i++) {
    tid += v[1 + i];
    var run = v[1 + n + i], len = v[1 + 2 * n + i], off = v[1 + 3 * n + i];
    var offset = (off === 0 && i > 0) ? (entries[i - 1].offset + entries[i - 1].length) : (off - 1);
    entries.push({ id: tid, offset: offset, length: len, run: run });
  }
  return entries;
}

function zxyToTileId(z, x, y) {
  var acc = 0;
  for (var i = 0; i < z; i++) acc += Math.pow(4, i);
  var n = Math.pow(2, z), rx, ry, d = 0, s = n / 2, t;
  while (s > 0) {
    rx = (x & s) > 0 ? 1 : 0;
    ry = (y & s) > 0 ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);
    if (ry === 0) {
      if (rx === 1) { x = s - 1 - x; y = s - 1 - y; }
      t = x; x = y; y = t;
    }
    s = Math.floor(s / 2);
  }
  return acc + d;
}

function findEntry(entries, tid) {
  var lo = 0, hi = entries.length - 1;
  while (lo <= hi) {
    var mid = (lo + hi) >> 1;
    if (tid < entries[mid].id) hi = mid - 1;
    else lo = mid + 1;
  }
  if (hi < 0) return null;
  var e = entries[hi];
  if (e.run === 0) return { leaf: e };
  if (tid < e.id + e.run) return { tile: e };
  return null;
}

async function gunzip(buf) {
  var ds = new DecompressionStream("gzip");
  var resp = new Response(new Blob([buf]).stream().pipeThrough(ds));
  return new Uint8Array(await resp.arrayBuffer());
}

// url → { header:{…}, root:[entries], leaves:{ "off,len": [entries] }, etag, checkedAt }
// STALENESS (7/16): regenerating an archive (publish sew-up, date re-bakes) changes every byte
// offset — a cached directory over the new file serves garbage and the layer goes BLANK. So:
// range reads bypass the HTTP cache (no mixed-version bytes), every read carries the archive's
// ETag and a mismatch drops the cache + retries, and cached archives re-validate via HEAD at
// most once a minute.
var archives = {};

var _lastRangeEtag = null;   // etag of the most recent range response (captured for openArchive)
async function rangeRead(url, offset, length, expectEtag) {
  var r = await fetch(url, { headers: { Range: "bytes=" + offset + "-" + (offset + length - 1) }, cache: "no-store" });
  if (!(r.status === 206 || r.status === 200)) throw new Error("range read " + r.status);
  var tag = r.headers.get("etag");
  _lastRangeEtag = tag || _lastRangeEtag;
  if (expectEtag && tag && tag !== expectEtag) throw new Error("archive-changed");
  var buf = new Uint8Array(await r.arrayBuffer());
  // a 200 (no range support) returns the whole object — slice what was asked for
  if (r.status === 200 && buf.length > length) buf = buf.slice(offset, offset + length);
  return buf;
}

function u64(dv, off) { return dv.getUint32(off, true) + dv.getUint32(off + 4, true) * 4294967296; }

async function openArchive(url) {
  var cached = archives[url];
  if (cached) {
    if (Date.now() - cached.checkedAt > 60000) {   // re-validate at most once a minute
      cached.checkedAt = Date.now();
      try {
        var hr = await fetch(url, { method: "HEAD", cache: "no-store" });
        var tag = hr.headers.get("etag");
        if (tag && cached.etag && tag !== cached.etag) { delete archives[url]; cached = null; }
      } catch (e) {}
    }
    if (cached) return cached;
  }
  var head = await rangeRead(url, 0, 16384);
  var headEtag = _lastRangeEtag;
  if (!(head[0] === 0x50 && head[1] === 0x4d && head[7] === 3)) throw new Error("not a PMTiles v3 archive");
  var dv = new DataView(head.buffer, head.byteOffset);
  var h = {
    rootOff: u64(dv, 8), rootLen: u64(dv, 16),
    leafOff: u64(dv, 40), leafLen: u64(dv, 48),
    dataOff: u64(dv, 56),
    internalGz: head[97] === 2, tileGz: head[98] === 2
  };
  var rootRaw = head.slice(h.rootOff, h.rootOff + h.rootLen);
  if (rootRaw.length < h.rootLen) rootRaw = await rangeRead(url, h.rootOff, h.rootLen, headEtag);
  var root = parseDirectory(h.internalGz ? await gunzip(rootRaw) : rootRaw);
  archives[url] = { header: h, root: root, leaves: {}, etag: headEtag, checkedAt: Date.now() };
  return archives[url];
}

/* ── Dual-source resolution (the only new logic) ────────────────────────── */

// pid/lid → url that most recently served this layer successfully
var chosenSource = {};

function candidateUrls(pid, lid) {
  var key = pid + "/" + lid + ".pmtiles";
  var urls = [];
  if (R2_BASE) urls.push(R2_BASE.replace(/\/$/, "") + "/" + key);
  urls.push(SUPABASE_URL + "/storage/v1/object/public/" + BUCKET + "/" + key);
  return urls;
}

async function serveTileFrom(url, z, x, y, retried) {
  var a = await openArchive(url);
  var tid = zxyToTileId(z, x, y);
  var entries = a.root;
  for (var depth = 0; depth < 4; depth++) {
    var hit = findEntry(entries, tid);
    if (!hit) return new Response(null, { status: 204 });
    if (hit.tile) {
      var bytes = await rangeRead(url, a.header.dataOff + hit.tile.offset, hit.tile.length, a.etag);
      if (a.header.tileGz) bytes = await gunzip(bytes);   // synthetic responses aren't content-decoded by the browser — serve raw
      return new Response(bytes, { headers: { "Content-Type": "application/x-protobuf", "Cache-Control": "public, max-age=300" } });
    }
    var key = hit.leaf.offset + "," + hit.leaf.length;
    if (!a.leaves[key]) {
      var raw = await rangeRead(url, a.header.leafOff + hit.leaf.offset, hit.leaf.length, a.etag);
      a.leaves[key] = parseDirectory(a.header.internalGz ? await gunzip(raw) : raw);
    }
    entries = a.leaves[key];
  }
  return new Response(null, { status: 204 });
}

async function serveTile(pid, lid, z, x, y) {
  var memoKey = pid + "/" + lid;
  var urls = chosenSource[memoKey] ? [chosenSource[memoKey]] : candidateUrls(pid, lid);
  var lastErr = null;
  for (var i = 0; i < urls.length; i++) {
    var url = urls[i];
    try {
      var resp = await serveTileFrom(url, z, x, y);
      chosenSource[memoKey] = url;
      return resp;
    } catch (err) {
      // archive regenerated mid-session (etag mismatch) or a decode straddled versions — drop
      // the cached directories and retry ONCE against the fresh file before failing over
      try {
        delete archives[url];
        var resp2 = await serveTileFrom(url, z, x, y);
        chosenSource[memoKey] = url;
        return resp2;
      } catch (err2) { lastErr = err2; delete archives[url]; }
    }
  }
  // the remembered source died and there was no alternate in this pass — re-probe everything once
  if (chosenSource[memoKey]) {
    delete chosenSource[memoKey];
    return serveTile(pid, lid, z, x, y);
  }
  return new Response(String(lastErr), { status: 502 });
}

self.addEventListener("fetch", function (e) {
  var m = e.request.url.match(/\/pmt\/([^/]+)\/([^/]+)\/(\d+)\/(\d+)\/(\d+)\.pbf(?:\?.*)?$/);
  if (!m) return;   // not ours — the network handles it
  e.respondWith(serveTile(m[1], m[2], parseInt(m[3], 10), parseInt(m[4], 10), parseInt(m[5], 10)));
});
