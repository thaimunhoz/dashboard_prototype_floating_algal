# Floating Algae Atlas

A public web dashboard for browsing daily floating-algae masks (Caribbean Sea) stored as
shapefiles in a Cloudflare R2 bucket.

- **Welcome page** on every page load (reopen with the ⓘ button in the title).
- **Daily / Weekly / Monthly** switch. Daily shows each day's mask; weekly (ISO, Mon–Sun) and monthly show frequency composites: every ~500 m cell coloured by the number of days algae were detected in it.
- **Timeline** across the top: one bar per day, week or month, with height showing bloom area (mean daily area for weeks and months). Click or drag to pick one, or press play to animate.
- **Map** (MapLibre GL): dark or satellite basemap. In daily mode, the area observed that day (Sentinel-2 tiles, plus Landsat footprints split on the S2 grid) is shaded underneath the masks, so "no algae" can be told apart from "not imaged".
- **Side panel**: place search, stats, and a bloom-area chart (click a bar to jump there).
- **Download** a day's mask as GeoJSON, or a composite as PNG.

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
    coverage/                    ← from scripts/build_coverage.py
      summary.json, 2025-01-01.geojson, ...
    composites/                  ← from scripts/build_composites.py
      weekly/summary.json, 2025-W01.png, 2025-W01_lo.png, ...
      monthly/summary.json, 2025-01.png, 2025-01_lo.png, ...
```

## Daily area summary

The timeline and chart need every day's area. Rather than downloading every mask, compute it once:

```bash
npm run summary -- E:/post_processing/CARIBBEAN_SEA/DAILY_MASKS data/summary.json "Caribbean Sea"
```

Upload `data/summary.json` to `<MASK_PREFIX>summary.json` in the bucket. Re-run it when you add days.
Without it, the dashboard still works: the timeline lists the day folders, and each day's area
is measured when you open it.

## Weekly and monthly composites

Built from the local daily masks with Python (conda `base` has geopandas, shapely, numpy, Pillow);
takes about a minute for a year:

```bash
conda run -n base python scripts/build_composites.py E:/post_processing/CARIBBEAN_SEA/DAILY_MASKS data/composites
```

Each period gets a detailed image (`<id>.png`, ~500 m cells) and an overview (`<id>_lo.png`, ~4 km)
used when zoomed out. The frequency classes and colours are set at the top of the script.
## Daily observation coverage

Which Sentinel-2 tiles were imaged each day, by Sentinel-2 or (split along the S2 grid) by
Landsat. Built from the inference file names and the two tile shapefiles, no rasters read:

```bash
conda run -n base python scripts/build_coverage.py --out data/coverage   --s2-tiles E:/post_processing/DATASET/shapefiles/Sentinel_tiles_Caribbean_Sea.shp   --s2-dir   E:/post_processing/DATASET/Caribbean_Sentinel_inferences   --ls-tiles E:/post_processing/DATASET/shapefiles/Landsat_tiles_Caribbean_Sea.shp   --ls-dir   E:/post_processing/DATASET/Caribbean_Landsat_inferences
```

A tile counts as observed when a scene exists for it that day; clouds and swath edges inside a
scene are not excluded (the inference rasters carry no nodata band).

To look at freshly built composites/coverage in `npm run dev` before uploading, put
`VITE_DERIVED_URL=/data/` in `.env.development.local`.

## Uploading to R2

`scripts/make-upload-manifest.mjs` lists files for `wrangler r2 bulk put`:

```bash
# everything
npm run manifest -- --masks E:/post_processing/CARIBBEAN_SEA/DAILY_MASKS --composites data/composites --coverage data/coverage --summary data/summary.json --out data/upload-manifest.json
# only the derived files (composites + coverage)
npm run manifest -- --composites data/composites --coverage data/coverage --out data/upload-derived.json

npx wrangler r2 bulk put floating-algal-dashboard --filename data/upload-derived.json --remote
```

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

## Deploy on Vercel (static site + public bucket)

The bucket is public at `https://pub-78e45d7d1b8f4e41ab06d26727276385.r2.dev`. In this mode
the page reads `summary.json` and the `.shp` files straight from it (`VITE_DATA_URL` in
`.env.vercel`), and no Worker is involved.

1. Import the GitHub repo in Vercel. `vercel.json` already sets the build (`vite build --mode vercel`, output `dist`).
2. Allow the Vercel domain to read the bucket: put it in `r2-cors.json`, then
   `npx wrangler r2 bucket cors set floating-algal-dashboard --file r2-cors.json`.

To try this mode locally: `npm run dev:public` (needs `http://localhost:5173` in the CORS rules).

## Deploy on Cloudflare Workers

```bash
npx wrangler login   # once
npm run deploy
```

This publishes the site and the API as the Worker `floating-algal-dashboard` on your
Cloudflare account, bound to the R2 bucket of the same name.
