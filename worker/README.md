# MapStructor Worker (scaffold — not deployed)

The single Cloudflare Worker from the architecture doc. Today: R2 gated reads +
authenticated uploads (the write chokepoint). Later: AI chatbot proxy, usage
metrics, tile-job dispatch.

## Deploy (once the Cloudflare account exists)

1. `npm i -g wrangler` (or `npx wrangler`), then `wrangler login`.
2. Dashboard → R2 → create bucket **mapstructor-tiles** (name must match `wrangler.toml`).
3. `wrangler secret put SUPABASE_URL` → `https://eqpxlwbjqiwfjlsuapvu.supabase.co`
   `wrangler secret put SUPABASE_ANON_KEY` → the publishable (anon) key.
4. `cd worker && wrangler deploy` → serves at `mapstructor-worker.<account>.workers.dev`.
5. Smoke test: `GET /health` → `{ ok: true }`; `PUT /upload/test/x.txt` with a user
   token → object appears in the bucket; `GET /r2/test/x.txt` returns it (Range works).

## Architecture rules encoded here

- **Public tile reads never route through the Worker.** They go to the R2 **custom
  domain** (direct bucket serving, no request quota). The Worker's `/r2/` route is
  only for private-map gating and pre-domain testing — the free plan's 100k
  requests/day would be eaten instantly by public tile traffic.
- **All browser writes go through `/upload/`** — the one rate-limitable chokepoint
  that contains R2's uncapped write meter (see decisions doc, "R2 — the one meter
  without a hard cap").

## Decisions wanted before this goes live

1. **Upload path: Worker-proxied PUT (built) vs presigned S3 URLs.** Proxied is
   simpler, streams, and is the chokepoint — but bodies cap at ~100 MB. Presigned
   multipart lifts the cap at the cost of S3 signing code and a second write path.
   Recommendation: proxied now, presigned added only for the giant-archive case.
2. **Custom domain.** Direct-from-bucket serving needs the hostname on Cloudflare
   DNS. Options: move mapstructor.com nameservers from GoDaddy to Cloudflare
   (recommended — also free CDN/SSL for the site later), or start on the free
   `workers.dev` + `r2.dev` hostnames (note: r2.dev is rate-limited, fine for
   testing only, not production tiles).
3. **Private-map read gating** (TODO in code): visibility lookup per key, cached.
   Ship the public mirror first, gate before any private map's tiles move to R2.
4. **Bucket layout.** Proposed: `tiles/<projectId>/<layerId>.pmtiles`,
   `sidecars/<projectId>/<layerId>.attr.parquet`, `snapshots/<projectId>.json`,
   `geoparquet/<projectId>/<layerId>.parquet`, `backups/…` — one bucket, prefixes
   per artifact type, so one binding and one token cover everything.
