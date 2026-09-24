# Floating Algae Atlas

A public web dashboard for browsing daily floating-algae masks (Caribbean Sea) stored as
shapefiles in a Cloudflare R2 bucket.

- **Timeline** across the top: one bar per day, with height showing bloom area. Click or drag to pick a day, or press play to animate.
- **Map** (MapLibre GL): dark or satellite basemap, with the day's mask drawn in green.
- **Side panel**: place search, area/patch stats, and a per-month bloom-area chart (click a bar to jump to that day).
- **Download** any day's mask as GeoJSON.

Stack: Vue 3 · Vite · TypeScript · MapLibre GL · shpjs · Cloudflare Workers + R2.

## How it works

```
browser ──► Cloudflare Worker (worker/index.ts) ──► R2 bucket "floating-algal-dashboard"
             GET /api/summary          → <prefix>summary.json, or a listing of day folders
             GET /api/mask/<date>.shp  → <prefix><date>/<date>.shp
```

The Worker reads R2 through a binding (`MASKS` in `wrangler.jsonc`), so no R2 keys are ever
exposed to the browser. The browser parses the `.shp` with `shpjs` and computes the area.

### Expected bucket layout

```
floating-algal-dashboard/
  caribbea-sea-masks/            ← MASK_PREFIX in wrangler.jsonc
    summary.json                 ← optional, from scripts/build-summary.mjs
    2025-01-01/2025-01-01.shp    (+ .dbf .shx .prj .cpg)
    2025-01-02/2025-01-02.shp
    ...
```

## Daily area summary

The timeline and chart need every day's area. Rather than downloading every mask, compute it once:

```bash
npm run summary -- E:/post_processing/CARIBBEAN_SEA/DAILY_MASKS data/summary.json "Caribbean Sea"
```

Upload `data/summary.json` to `<MASK_PREFIX>summary.json` in the bucket. Re-run it when you add days.
Without it, the dashboard still works: the timeline lists the day folders, and each day's area
is measured when you open it.

## Development

```bash
npm install
npm run dev          # http://localhost:5173
```

By default `npm run dev` uses a **local simulated** R2 bucket. Fill it from your local masks:

```bash
npm run seed:local -- E:/post_processing/CARIBBEAN_SEA/DAILY_MASKS data/summary.json
```

To develop against the **real** bucket instead, run `npx wrangler login` once and add
`"remote": true` to the `r2_buckets` entry in `wrangler.jsonc`.

## Deploy

```bash
npx wrangler login   # once
npm run deploy
```

This publishes the site and the API as the Worker `floating-algal-dashboard` on your
Cloudflare account, bound to the R2 bucket of the same name.
