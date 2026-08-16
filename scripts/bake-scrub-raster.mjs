/* bake-scrub-raster.mjs — bake the INSTANT-SCRUB raster in the cloud (8/16).

   WHY THIS EXISTS: dragging the timeline is meant to be instant. The design already delivers
   that — while the slider is held, rasterScrub.js hides the vector layers and a pre-baked
   raster answers every tick; on release the vectors return and the real filter applies. With
   NO raster the drag falls back to re-evaluating a per-feature opacity expression across the
   whole layer on every tick, which is exactly the lag the owner reported on AtlasHCB
   ("Not even close to instantaneous", 8/16 — 9.3M vertices, no raster).

   THE HOLE IT CLOSES: only the BROWSER tiler (platform/tilegen.js) ever baked that raster, and
   rebakeLayerTiles refuses to run on a `folded` layer ("folded (R2-backed) — re-baking from rows
   is disabled" → the panel's "Nothing to bake for this layer"). This script — the cloud tiler —
   never baked one at all. So every layer big enough to be folded in the cloud, i.e. precisely
   the layers that need the instant path most, came out the far side without it.

   WHY IT DRIVES A BROWSER INSTEAD OF REIMPLEMENTING: the raster is not one image. It is an
   INDEXED pyramid — pixel value = shape id, plus a LUT image holding each id's date stretches,
   baked at 2048/4096/8192 px for fills AND borders, with a 255-year byte codec and a reserved
   sentinel. Writing a second copy of that in Node would fork the format from its only reader
   (platform/rasterScrub.js) the first time either changed. So this runs the REAL tilegen.js in
   headless Chrome and keeps ONE definition — the same reason importFeatureCollection and the
   streaming importer share normalizeImportFC.

   SEAMS: tilegen's uploadPng calls db.storage.from(BUCKET).upload(path, blob). We hand it a stub
   whose upload POSTs the blob to a loopback sink, so the PNG lands on DISK and Node dual-writes
   it (Supabase + R2, delete-first) exactly like the archive. The service key never enters the page.

   FAILURE POLICY: a raster that would misbehave is refused at bake time (tilegen's own
   rasterUnfitReason — points, or starts spanning more than the 255-year window), and any error
   here is caught by the caller. NO RASTER IS CORRECT: the layer simply animates as a vector.
   A wrong raster is far worse than none (the 8/7 rule the loader depends on). */

import { createServer } from "node:http";
import { createReadStream, mkdirSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/* How long the in-page bake may take before we call it hung. Rasterizing survey-resolution
   polygons at four pyramid levels x two modes is minutes of honest work, not seconds. */
const RASTER_TIMEOUT_MS = Number(process.env.RASTER_TIMEOUT_MS || 45 * 60 * 1000);

/* The runner's Chrome. GitHub's ubuntu images ship google-chrome-stable; CHROME_PATH wins so a
   local run can point at its own binary. */
function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  for (const p of ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium-browser", "/usr/bin/chromium"]) {
    try { statSync(p); return p; } catch (e) {}
  }
  throw new Error("no Chrome found — set CHROME_PATH");
}

/* Loopback sink: serves the skinny GeoJSON to the page (same origin, so fetch just works) and
   catches every PNG the bake produces. Streaming the GeoJSON matters — a 370MB string handed
   across CDP is its own failure mode. */
function startSink(geojsonPath, outDir) {
  const pngs = [];
  const server = createServer((req, res) => {
    const u = new URL(req.url, "http://127.0.0.1");
    if (u.pathname === "/layer.geojson") {
      res.writeHead(200, { "Content-Type": "application/json" });
      createReadStream(geojsonPath).pipe(res);
      return;
    }
    if (u.pathname === "/__png" && req.method === "POST") {
      const storagePath = u.searchParams.get("path") || "";
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const buf = Buffer.concat(chunks);
        const file = join(outDir, storagePath.replace(/[\/]/g, "_"));
        writeFileSync(file, buf);
        pngs.push({ storagePath, file, bytes: buf.length });
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("ok");
      });
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<!doctype html><meta charset=utf-8><title>tiler</title>");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, pngs }));
  });
}

/**
 * Bake the instant-scrub raster for one layer.
 * @returns {Promise<{cfg:object, pngs:Array<{storagePath:string,file:string,bytes:number}>}|null>}
 *          null when the layer is legitimately unfit for a raster (caller keeps vector scrub).
 */
export async function bakeScrubRaster({ projectId, layerId, geojsonPath, geomKind, tilegenPath, outDir = "scrub-raster", log = console.log }) {
  let puppeteer;
  try { puppeteer = require("puppeteer-core"); }
  catch (e) { log("scrub raster skipped — puppeteer-core is not installed on this runner"); return null; }

  mkdirSync(outDir, { recursive: true });
  const sink = await startSink(geojsonPath, outDir);
  const t0 = Date.now();
  let browser = null, beat = null;
  try {
    browser = await puppeteer.launch({
      executablePath: chromePath(),
      headless: "new",
      // The FC is held as JS objects to rasterize it; survey-resolution polygons need the room
      // (the same ~96-bytes-per-coordinate arithmetic that drove the streaming importer).
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--use-gl=swiftshader", "--js-flags=--max-old-space-size=8192"],
      // Puppeteer's DEFAULT protocolTimeout is 180s, and it applies to the whole page.evaluate —
      // so the first full-scale run (AtlasHCB, 220 features / 9.3M vertices) died at exactly 3
      // minutes with "Runtime.callFunctionOn timed out" and silently produced no raster (8/16,
      // bake #60). A generous explicit ceiling instead of 0: a real hang still fails with a clear
      // message well inside the job's 120-minute cap, rather than burning the whole cap.
      protocolTimeout: RASTER_TIMEOUT_MS,
    });
    const page = await browser.newPage();
    page.on("console", (m) => { const t = m.text(); if (/tilegen|raster/i.test(t)) log("  [page] " + t.slice(0, 200)); });
    page.on("pageerror", (e) => log("  [page error] " + String(e).slice(0, 200)));
    await page.goto(`http://127.0.0.1:${sink.port}/blank`, { waitUntil: "domcontentloaded" });
    await page.addScriptTag({ path: tilegenPath });

    // A silent ten-minute step reads like a hang in a CI log — say what is happening while it works.
    beat = setInterval(() => log(`  … raster bake running ${Math.round((Date.now() - t0) / 1000)}s (${sink.pngs.length} images so far)`), 60000);
    const result = await page.evaluate(async (port, projectId, layerId, geomKind) => {
      if (!window.MSTileGen || !window.MSTileGen.bakeYearsRaster) return { error: "MSTileGen did not load" };
      const fc = await (await fetch("/layer.geojson")).json();
      // tilegen's OWN fitness rule — never a second copy of it here
      const why = window.MSTileGen.rasterUnfitReason ? window.MSTileGen.rasterUnfitReason(geomKind, fc) : null;
      if (why) return { unfit: why, features: (fc.features || []).length };
      // stub storage: every PNG goes to the loopback sink, so Node owns the real upload
      const db = {
        storage: {
          from: () => ({
            upload: async (path, blob) => {
              const r = await fetch("/__png?path=" + encodeURIComponent(path), { method: "POST", body: blob });
              return r.ok ? { error: null } : { error: { message: "sink rejected " + path } };
            },
            remove: async () => ({ error: null }),
          }),
        },
      };
      try {
        const cfg = await window.MSTileGen.bakeYearsRaster(db, projectId, layerId, fc);
        return { cfg, features: (fc.features || []).length };
      } catch (e) {
        return { error: String((e && e.message) || e) };
      }
    }, sink.port, projectId, layerId, geomKind);
    clearInterval(beat);

    if (result.unfit) { log(`scrub raster skipped — ${result.unfit}`); return null; }
    if (result.error) throw new Error(result.error);
    if (!result.cfg) throw new Error("bakeYearsRaster returned nothing");
    log(`scrub raster baked in ${((Date.now() - t0) / 1000).toFixed(0)}s · ${sink.pngs.length} images · ${(sink.pngs.reduce((s, p) => s + p.bytes, 0) / 1024).toFixed(0)} KB`);
    return { cfg: result.cfg, pngs: sink.pngs };
  } finally {
    if (beat) clearInterval(beat);
    if (browser) await browser.close().catch(() => {});
    sink.server.close();
  }
}
