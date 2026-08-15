// MapStructor — SERVER-SIDE DATASET FREEZE (8/14).
//
// Why this exists: the freeze used to run entirely in the browser tab — the owner clicked
// register+freeze, closed the laptop, and woke to a registered dataset with no frozen copy
// (registration is one server-side RPC and commits instantly; the freeze was a multi-minute
// client job that died with the tab). This function is the click-and-forget version: the
// browser POSTs {dataset_id}, gets a job id back immediately, and can go away. Progress is
// written to public.freeze_jobs (the UI polls it; the poll survives refresh and even another
// device).
//
// STREAMING BY DESIGN: rows are read keyset-page by page and fed straight through fflate's
// streaming zip into a /tmp spool file, then uploaded in 6MB TUS chunks. Peak memory is one
// page of rows + the compressor window — flat, whatever the dataset size. The ceiling is the
// /tmp quota (~512MB of ZIP, i.e. multi-GB raw GeoJSON), not RAM.
//
// The zip's SHAPE must stay byte-compatible with the client freeze in platform/datasets.js
// snapshot() (which remains as the fallback path): <name>.geojson + README.txt, same property
// order, dataset_id stamped on every feature, stored at datasets/<id>/<name>.geojson.zip in
// the tiles bucket, recorded via ms_dataset_snapshot.
//
// Deploy: SUPABASE_ACCESS_TOKEN=<pat> npx supabase functions deploy freeze-dataset \
//           --project-ref eqpxlwbjqiwfjlsuapvu --no-verify-jwt
// (--no-verify-jwt because CORS preflights carry no JWT; auth is done in-function below.)

import { createClient } from "npm:@supabase/supabase-js@2";
import { Zip, ZipDeflate, strToU8 } from "npm:fflate@0.8.2";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

const SB = Deno.env.get("SUPABASE_URL")!;
const SVC = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const db = createClient(SB, SVC, { auth: { persistSession: false } });
const BUCKET = "tiles";
const PAGE = 1000;
const TUS_CHUNK = 6 * 1024 * 1024; // Supabase TUS requires exactly 6MB chunks (except the last)

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  let datasetId: string;
  try {
    const b = await req.json();
    datasetId = String(b.dataset_id || "");
  } catch {
    return json({ error: "body must be JSON with dataset_id" }, 400);
  }
  if (!/^[0-9a-f-]{36}$/.test(datasetId)) return json({ error: "dataset_id must be a uuid" }, 400);

  // in-function auth: the caller must be signed in AND own the dataset (creator or origin-layer
  // owner). The gateway's JWT check is off so preflights work; this is the real gate.
  const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: userData, error: uerr } = await db.auth.getUser(jwt);
  if (uerr || !userData?.user) return json({ error: "not signed in" }, 401);
  const uid = userData.user.id;

  const { data: ds, error: derr } = await db.from("datasets").select("*").eq("id", datasetId).single();
  if (derr || !ds) return json({ error: "no such dataset" }, 404);
  let allowed = ds.created_by === uid;
  if (!allowed && ds.origin_layer_id) {
    const { data: lay } = await db.from("layers").select("user_id").eq("id", ds.origin_layer_id).single();
    allowed = !!lay && lay.user_id === uid;
  }
  if (!allowed) return json({ error: "not your dataset" }, 403);
  if (!ds.origin_layer_id) return json({ error: "dataset has no origin layer to read" }, 409);

  // one job at a time per dataset — a second click while one runs would race the storage object.
  // "Running" means UPDATED WITHIN 45s: a live job writes progress every page/chunk; a quiet row
  // is a dead worker. The runtime CULLS young workers (~8.6s post-boot, seen in function_logs)
  // and the cull does not spare waitUntil work or even a held-open request — so stalls are a
  // fact of life here, the client retries once, and stale rows are marked superseded below.
  const CUTOFF = new Date(Date.now() - 45 * 1000).toISOString();
  const { data: running } = await db.from("freeze_jobs").select("id").eq("dataset_id", datasetId)
    .in("status", ["queued", "running"]).gte("updated_at", CUTOFF).limit(1);
  if (running && running.length) return json({ job: running[0].id, note: "already running" }, 202);
  await db.from("freeze_jobs").update({ status: "error", error: "worker died mid-job — superseded by a retry", updated_at: new Date().toISOString() })
    .eq("dataset_id", datasetId).in("status", ["queued", "running"]).lt("updated_at", CUTOFF);

  const { data: job, error: jerr } = await db.from("freeze_jobs")
    .insert({ dataset_id: datasetId, status: "queued", phase: "Starting…", created_by: uid })
    .select("id").single();
  if (jerr || !job) return json({ error: "could not create job: " + (jerr?.message || "?") }, 500);

  const work = runFreeze(job.id, ds).catch(async (e) => {
    // a superseded job dies SILENTLY — its row already says why, and overwriting it would
    // clobber the marker the replacement job wrote
    if (e instanceof Superseded) { await cleanupTmp(ds.id, job.id); return; }
    await jset(job.id, { status: "error", error: String(e?.message || e) });
    await cleanupTmp(ds.id, job.id);
  });
  // BELT AND BRACES (8/14, after ~50% early isolate deaths at "Counting…"): waitUntil ALONE was
  // not honored reliably — the worker could die seconds after the response returned. So the
  // request now stays OPEN for the duration of the work (an in-flight request is never culled),
  // AND waitUntil stays registered so the work survives a client disconnect (tab death — the
  // whole point of the server freeze; proven by an abort-at-3s test). The client does NOT wait
  // for this response: it discovers the job row by polling freeze_jobs directly.
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) EdgeRuntime.waitUntil(work);
  await work;
  return json({ job: job.id }, 200);
});

async function jset(jobId: string, patch: Record<string, unknown>) {
  await db.from("freeze_jobs").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", jobId);
}

// SUPERSESSION (8/14, found by gate run 3): a "stalled" worker can be merely PAUSED — it woke
// after the client's retry started a second job and the two raced on the same storage object
// (409 mid-chunk). A superseded job's row is flipped to error by the new job's request handler;
// every checkpoint below re-reads its own status and aborts if it is no longer the live job.
class Superseded extends Error {}
async function assertAlive(jobId: string) {
  const { data } = await db.from("freeze_jobs").select("status").eq("id", jobId).single();
  if (!data || data.status !== "running") throw new Superseded("superseded");
}

async function writeAllTo(f: Deno.FsFile, u8: Uint8Array) {
  let n = 0;
  while (n < u8.length) n += await f.write(u8.subarray(n));
}

async function runFreeze(jobId: string, ds: Record<string, any>) {
  const datasetId = ds.id as string;
  const layerId = ds.origin_layer_id as string;
  console.log("[freeze]", jobId, "start");
  await jset(jobId, { status: "running", phase: "Counting features…" });
  console.log("[freeze]", jobId, "counting");
  const { count } = await db.from("features").select("feature_id", { count: "exact", head: true }).eq("layer_id", layerId);
  const total = count || 0;
  console.log("[freeze]", jobId, "counted", total);

  const base = (String(ds.name || "dataset").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "")) || "dataset";
  const tmp = `/tmp/freeze-${jobId}.zip`;
  const spool = await Deno.open(tmp, { write: true, create: true, truncate: true });

  // streaming zip → spool. ondata is synchronous; chunks queue and are flushed with awaited
  // writes after every push, so memory holds at most one page's compressed output.
  const q: Uint8Array[] = [];
  let zipErr: Error | null = null;
  const zip = new Zip((err, dat) => { if (err) zipErr = err; else if (dat && dat.length) q.push(dat); });
  const flush = async () => { if (zipErr) throw zipErr; while (q.length) await writeAllTo(spool, q.shift()!); };

  const gj = new ZipDeflate(base + ".geojson", { level: 6 });
  zip.add(gj);
  gj.push(strToU8('{"type":"FeatureCollection","features":['), false);

  const bbox = [Infinity, Infinity, -Infinity, -Infinity];
  const types: Record<string, 1> = {};
  let read = 0;
  {
    // keyset + adaptive paging — the same discipline as the client (heavy geometry rows can
    // blow a page outright; the cursor retries smaller, floor 25)
    let last: number | null = null, size = PAGE;
    const minSize = 25;
    for (;;) {
      let qy = db.from("features")
        .select("feature_id, geom, label, description, start_date, end_date, image_url, custom_fields")
        .eq("layer_id", layerId);
      if (last !== null) qy = qy.gt("feature_id", last);
      const r = await qy.order("feature_id").limit(size);
      if (r.error) {
        if (size <= minSize) throw new Error("reading features: " + r.error.message);
        size = Math.max(minSize, Math.floor(size / 4));
        await jset(jobId, { phase: `Heavy rows — retrying in pages of ${size}…` });
        continue;
      }
      const rows = r.data || [];
      if (rows.length) last = rows[rows.length - 1].feature_id;
      let buf = "";
      for (const f of rows) {
        const g = typeof f.geom === "string" ? JSON.parse(f.geom) : f.geom;
        if (!g) continue;
        types[g.type] = 1;
        (function walk(c: any) {
          if (!c) return;
          if (typeof c[0] === "number") {
            if (c[0] < bbox[0]) bbox[0] = c[0];
            if (c[1] < bbox[1]) bbox[1] = c[1];
            if (c[0] > bbox[2]) bbox[2] = c[0];
            if (c[1] > bbox[3]) bbox[3] = c[1];
            return;
          }
          for (let i = 0; i < c.length; i++) walk(c[i]);
        })(g.coordinates);
        // property order mirrors the client snapshot() exactly — the zips must stay interchangeable
        const props: Record<string, unknown> = {};
        if (f.custom_fields && typeof f.custom_fields === "object") for (const k of Object.keys(f.custom_fields)) props[k] = f.custom_fields[k];
        if (f.label != null && f.label !== "") props.label = f.label;
        if (f.description) props.description = f.description;
        if (f.start_date) props.start_date = String(f.start_date).slice(0, 10);
        if (f.end_date) props.end_date = String(f.end_date).slice(0, 10);
        if (f.image_url) props.image_url = f.image_url;
        props.dataset_id = datasetId;
        buf += (read ? "," : "") + JSON.stringify({ type: "Feature", id: f.feature_id, geometry: g, properties: props });
        read++;
      }
      if (buf) gj.push(strToU8(buf), false);
      await flush();
      await jset(jobId, { rows_read: read, phase: `Reading features… ${read.toLocaleString()}${total ? " / " + total.toLocaleString() : ""}` });
      await assertAlive(jobId);
      if (rows.length < size) break;
    }
  }
  gj.push(strToU8("]}"), true);

  await jset(jobId, { phase: "Building the read-only copy…" });
  const readme = new ZipDeflate("README.txt", { level: 6 });
  zip.add(readme);
  readme.push(strToU8([
    "MapStructor read-only dataset copy",
    "",
    "Dataset:      " + (ds.name || ""),
    "Dataset id:   " + datasetId,
    "Source:       " + (ds.source || "(not recorded)"),
    "Link:         " + (ds.link || "(not recorded)"),
    "Licence:      " + (ds.licence || "unknown"),
    "Attribution:  " + (ds.attribution_text || "(none recorded)"),
    "Features:     " + read,
    "Frozen at:    " + new Date().toISOString(),
    "",
    (ds.more_info || ""),
    "",
    "Every feature carries a dataset_id property. That id is what ties this file back to its",
    "entry in the MapStructor catalogue, and to the terms above.",
  ].join("\n")), true);
  zip.end();
  await flush();
  spool.close();

  const size = (await Deno.stat(tmp)).size;
  const path = `datasets/${datasetId}/${base}.geojson.zip`;
  // upload to a PER-JOB temp object, then move into the final path — two jobs can never write
  // the same object, so a zombie predecessor cannot 409 this upload (gate run 3's race)
  const tmpObj = tmpObjPath(datasetId, jobId);
  await jset(jobId, { bytes_total: size, phase: `Storing it (${fmtBytes(size)})…` });
  await assertAlive(jobId);
  await tusUpload(tmp, size, tmpObj, async (sent) => {
    await jset(jobId, { bytes_uploaded: sent, phase: `Storing it… ${fmtBytes(sent)} / ${fmtBytes(size)}` });
    await assertAlive(jobId);
  });
  await assertAlive(jobId);
  // delete-then-move, never upsert (the storage upsert path needs SELECT visibility on
  // storage.objects and fails as a bogus RLS error — the tilegen-setup.sql trap)
  await db.storage.from(BUCKET).remove([path]).catch(() => {});
  const mv = await db.storage.from(BUCKET).move(tmpObj, path);
  if (mv.error) throw new Error("placing the copy: " + mv.error.message);

  // direct row update, NOT ms_dataset_snapshot: that RPC gates on ms_dataset_admin(), which
  // reads the caller's JWT claims — the service role has none, so the RPC refuses it ("not
  // permitted" AFTER a complete upload, found by the first server-mode gate). The ownership
  // gate for this job already ran at request time; same fields, same keep-if-null semantics.
  const patch: Record<string, unknown> = {
    snapshot_key: path, snapshot_bytes: size, snapshot_format: "geojson.zip",
    snapshot_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  };
  if (isFinite(bbox[0])) patch.bbox = bbox;
  const gt = Object.keys(types);
  if (gt.length) patch.geom_types = gt;
  const rec = await db.from("datasets").update(patch).eq("id", datasetId);
  if (rec.error) throw new Error("recording the copy: " + rec.error.message);

  await jset(jobId, { status: "done", phase: "Done", snapshot_key: path, bytes_uploaded: size, rows_read: read });
  console.log("[freeze]", jobId, "done", size);
  await Deno.remove(tmp).catch(() => {});
}

// manual TUS: create (known length), then exact-6MB PATCH chunks read straight off the spool
// file. Verified against this project's storage before this function was written: create 201,
// patch 204, public object lands. Falls back to a single streaming POST if create is refused.
async function tusUpload(tmp: string, size: number, path: string, onChunk: (sent: number) => Promise<void>) {
  const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
  const cr = await fetch(SB + "/storage/v1/upload/resumable", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + SVC, apikey: SVC, "Tus-Resumable": "1.0.0",
      "Upload-Length": String(size),
      "Upload-Metadata": `bucketName ${b64(BUCKET)},objectName ${b64(path)},contentType ${b64("application/zip")},cacheControl ${b64("3600")}`,
    },
  });
  if (cr.status !== 201) {
    // fallback: one streaming POST with known length (still flat memory — file stream body)
    const f = await Deno.open(tmp, { read: true });
    const up = await fetch(`${SB}/storage/v1/object/${BUCKET}/${path}`, {
      method: "POST",
      headers: { Authorization: "Bearer " + SVC, apikey: SVC, "Content-Type": "application/zip" },
      body: f.readable,
    });
    if (!up.ok) throw new Error("storing the copy: " + up.status + " " + (await up.text()).slice(0, 200));
    await onChunk(size);
    return;
  }
  let loc = cr.headers.get("location") || "";
  if (loc.startsWith("/")) loc = SB + loc;
  const f = await Deno.open(tmp, { read: true });
  try {
    let offset = 0;
    const buf = new Uint8Array(TUS_CHUNK);
    while (offset < size) {
      let filled = 0;
      while (filled < buf.length) {
        const n = await f.read(buf.subarray(filled));
        if (n === null) break;
        filled += n;
      }
      if (!filled) break;
      const pa = await fetch(loc, {
        method: "PATCH",
        headers: {
          Authorization: "Bearer " + SVC, apikey: SVC, "Tus-Resumable": "1.0.0",
          "Upload-Offset": String(offset), "Content-Type": "application/offset+octet-stream",
        },
        body: buf.subarray(0, filled),
      });
      if (pa.status !== 204) throw new Error("storing the copy (chunk at " + offset + "): " + pa.status + " " + (await pa.text()).slice(0, 200));
      offset += filled;
      await onChunk(offset);
    }
    if (offset !== size) throw new Error(`storing the copy: spool ended at ${offset} of ${size}`);
  } finally {
    f.close();
  }
}

function tmpObjPath(datasetId: string, jobId: string) {
  return `datasets/${datasetId}/.job-${jobId}.zip`;
}
async function cleanupTmp(datasetId: string, jobId: string) {
  await db.storage.from(BUCKET).remove([tmpObjPath(datasetId, jobId)]).catch(() => {});
  await Deno.remove(`/tmp/freeze-${jobId}.zip`).catch(() => {});
}

function fmtBytes(n: number) {
  if (n > 1024 * 1024 * 1024) return (n / (1024 * 1024 * 1024)).toFixed(1) + " GB";
  if (n > 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + " MB";
  if (n > 1024) return Math.round(n / 1024) + " KB";
  return n + " B";
}
