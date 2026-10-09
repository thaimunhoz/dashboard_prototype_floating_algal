# Floating Algal Atlas

A public web dashboard for browsing daily floating algal bloom masks, stored as shapefiles in a
Cloudflare R2 bucket. Four regions: **Caribbean Sea**, **Europe**, **North America** and
**South America** (2025).

- **Welcome page** on every page load (reopen with the ⓘ button in the title).
- **Regions follow the map**: pan to Europe or the Caribbean and the timeline, chart, masks and
  composites switch to that region (shown next to the date; also kept in the link as `?region=`).
- **Daily / Weekly / Monthly** switch. Daily shows each day's mask; weekly (ISO, Mon–Sun) and monthly
  show frequency composites: every cell coloured by the number of days algae were detected in it.
- **Timeline** across the top: one bar per day, week or month, with height showing bloom area (mean
  daily area for weeks and months). Click or drag to pick one, or press play to animate.
- **Map view mode** (on by default): when zoomed in, the timeline and chart show the area inside the
  current view, summed from the 4 km cell data; days when nothing in view was imaged are marked
  "not imaged" instead of zero.
- **Observed tiles**: in daily mode, the area imaged that day (Sentinel-2 tiles, plus Landsat
  footprints split on the S2 grid) is shaded under the masks.
- **4 km cell time series**: zoomed in (zoom ≥ 6), click the sea to see the daily algal bloom area in
  that grid cell, with observed-but-clear days and unobserved days told apart.
- **Download** a day's mask as GeoJSON, or a composite as PNG.

Stack: Vue 3 · Vite · TypeScript · MapLibre GL · shpjs · Cloudflare Workers + R2.

## Regions

Regions are listed once in `shared/regions.ts` (id, name, R2 folder, extent), used by both the page and
the Worker. Each region has the same layout in the bucket:

```
floating-algal-dashboard/
  caribbea-sea-masks/            ← Caribbean Sea
  europe-masks-2025/             ← Europe
    summary.json                 ← scripts/build-summary.mjs
    2025-01-01/2025-01-01.shp    (+ .dbf .shx .prj .cpg)
    ...
    composites/                  ← scripts/build_composites.py
      weekly/summary.json, 2025-W01.png, 2025-W01_lo.png, ...
      monthly/summary.json, 2025-01.png, 2025-01_lo.png, ...
    coverage/                    ← scripts/build_coverage.py
      summary.json, 2025-01-01.geojson, ...
    cells/                       ← scripts/build_cells.py
      grid.json, 3_12.json, ...
```

Local copies of the built files live in `data/<region>/` (`data/caribbean/`, `data/europe/`).
To add a region: add it to `shared/regions.ts`, build its files with the recipe below, upload them.

## How it works

```
browser ──► Cloudflare Worker (worker/index.ts) ──► R2 bucket "floating-algal-dashboard"
             GET /api/<region>/summary           → <folder>summary.json, or a listing of day folders
             GET /api/<region>/mask/<date>.shp   → <folder><date>/<date>.shp
             GET /api/<region>/composites|coverage|cells/…
```

The Worker reads R2 through a binding (`MASKS` in `wrangler.jsonc`), so no R2 keys are exposed to the
browser. On Vercel the page reads the public bucket directly instead (see below).

## Building a region's files

Python scripts run in the conda `base` environment (geopandas, shapely, numpy, Pillow).

| Region | Masks | 4 km grid | S2 tiles / inferences | Landsat tiles / inferences |
|---|---|---|---|---|
| Caribbean | `Z:/guser/tml/global_model/PROTOTYPE/prototype_v2/global_post_processed/CARIBBEAN_SEA` | `Z:/…/prototype_v2/shapefiles/caribbean_4km_fishnet.shp` | `E:/post_processing/DATASET/shapefiles/Sentinel_tiles_Caribbean_Sea.shp`, `E:/post_processing/DATASET/Caribbean_Sentinel_inferences` | `E:/post_processing/DATASET/shapefiles/Landsat_tiles_Caribbean_Sea.shp`, `E:/post_processing/DATASET/Caribbean_Landsat_inferences` |
| Europe | `Z:/guser/tml/global_model/PROTOTYPE/prototype_v2/global_post_processed/EUROPE/daily_masks` | `Z:/guser/tml/global_model/data_management/shapefiles/continents/europe_4x4_grid.shp` | `Z:/…/continents/S2_Europe.shp`, `Z:/…/prototype_v2/AQUAVis_dataset/inference_sentinel` | `Z:/…/continents/L89_Europe.shp`, `Z:/…/prototype_v2/AQUAVis_dataset/inference_landsat` |
| North America | `Z:/guser/tml/global_model/PROTOTYPE/prototype_v2/global_post_processed/NORTH_AMERICA/daily_masks_new` | `Z:/…/continents/north_america_4x4_grid.shp` | `Z:/…/continents/S2_North_America.shp`, `Z:/…/AQUAVis_dataset/inference_sentinel` | `Z:/…/continents/L89_North_America.shp`, `Z:/…/AQUAVis_dataset/inference_landsat` |
| South America | `Z:/guser/tml/global_model/PROTOTYPE/prototype_v2/global_post_processed/SOUTH_AMERICA/daily_masks` | `Z:/…/continents/south_america_4x4_grid.shp` | `Z:/…/continents/S2_South_America.shp`, `Z:/…/AQUAVis_dataset/inference_sentinel` | `Z:/…/continents/L89_South_America.shp`, `Z:/…/AQUAVis_dataset/inference_landsat` |

Heatmap cell size (`--cell-m`): Caribbean 500 (default), Europe 1000, North and South America 1500,
chosen so each image stays under ~8000 px. R2 folders: `caribbea-sea-masks/`, `europe-masks-2025/`,
`north-america-masks-2025/`, `south-america-masks-2025/`.

**Which region the map shows** (rules in `shared/regions.ts`): inside the Caribbean box, always the
Caribbean dataset (North and South America also cover it); elsewhere, the region whose Sentinel-2 tile
footprint contains the map centre. The footprints are in `shared/footprints.json`; rebuild them when a
region or its tile list changes:

```bash
conda run -n base python scripts/build_footprints.py europe=<S2_Europe.shp> \
  north-america=<S2_North_America.shp> south-america=<S2_South_America.shp>
```

The scripts take extents from the polygons themselves, not the shapefile header (some South America
files have a wrong header bbox with 0.0 edges).

Example for Europe (`R=europe`; for the Caribbean use `data/caribbean`, its paths, and the default cell size):

```bash
# daily areas (timeline and chart)
npm run summary -- <masks> data/europe/summary.json "Europe"
# weekly/monthly frequency heatmaps; Europe needs 1 km cells to stay under ~8000 px per image
conda run -n base python scripts/build_composites.py <masks> data/europe/composites --cell-m 1000
# which tiles were imaged each day (from scene names only; --year filters a multi-year inference folder)
conda run -n base python scripts/build_coverage.py --out data/europe/coverage --year 2025 \
  --s2-tiles <S2 tiles> --s2-dir <S2 inferences> --ls-tiles <Landsat tiles> --ls-dir <Landsat inferences>
# 4 km cell time series (needs coverage first)
conda run -n base python scripts/build_cells.py --fishnet <grid> --masks <masks> \
  --coverage data/europe/coverage --out data/europe/cells
```

Notes:
- **Composites**: each period has a detailed image (`<id>.png`) and an 8×-coarser overview used when
  zoomed out. Frequency classes and colours are at the top of the script.
- **Coverage**: a tile counts as observed when a scene exists for it that day; clouds and swath edges
  inside a scene are not excluded. Inference folders may hold `<scene>_refined.tif` files (Caribbean) or
  `<scene>/` folders (Europe); only tile folders listed in the tile shapefile are read. Landsat scenes
  that touch no Sentinel-2 tile are left out.
- **Cells**: the grid must be a regular EPSG:3857 grid with `left`, `top`, `right`, `row_index`,
  `col_index`; the browser finds the clicked cell arithmetically. Mask area outside the grid is not counted.

To preview freshly built files in `npm run dev` before uploading, put `VITE_DERIVED_URL=/data/` in
`.env.development.local` (serves `data/<region>/…`; the daily masks still come from the bucket).

## Uploading to R2

`scripts/sync-r2.mjs` uploads only files whose content changed. It keeps an MD5 per R2 key in
`data/r2-state.json` (R2 reports the same MD5 as each object's ETag). `--prefix` picks the region's
folder (default: `MASK_PREFIX` in `wrangler.jsonc`, the Caribbean).

```bash
# dry run: what changed
npm run sync -- --prefix europe-masks-2025/ --masks <masks> --summary data/europe/summary.json \
  --composites data/europe/composites --coverage data/europe/coverage --cells data/europe/cells
# upload it
npm run sync -- --prefix europe-masks-2025/ --masks <masks> --summary data/europe/summary.json \
  --composites data/europe/composites --coverage data/europe/coverage --cells data/europe/cells --upload
```

After editing masks: rebuild the summary, composites and cells (coverage only changes when scenes are
added), then run the same sync.

**Replacing a region's masks with a new set** (e.g. a new model run): point `--masks` at the new folder,
rebuild the derived files into empty folders, and add `--prune` to the upload. Files are overwritten in
place, then anything uploaded earlier that is no longer in the new set (a day that was dropped, an old
block) is deleted, one `wrangler r2 object delete` per file, so the dashboard never has a gap. `--prune`
only touches the sources given in the command and only files the sync script uploaded itself. The state is only updated after a successful upload, so a failed run
can be repeated. If `data/r2-state.json` is lost, recreate it with the same sources and `--init`
(records the local files as already uploaded; only when they match the bucket).

`scripts/make-upload-manifest.mjs` (same options plus `--out`) lists every file for a plain
`npx wrangler r2 bulk put floating-algal-dashboard --filename <out> --remote`.

## Development

```bash
npm install
npm run dev          # http://localhost:5173
```

`npm run dev` reads the real bucket (`"remote": true` in `wrangler.jsonc`; needs `npx wrangler login`
once). Set it to `false` to use a local simulated bucket, filled with `npm run seed:local`.

## Deploy on Vercel (static site + public bucket)

The bucket is public at `https://pub-78e45d7d1b8f4e41ab06d26727276385.r2.dev`. In this mode the page
reads each region's files straight from it (`VITE_DATA_URL`, the bucket root, in `.env.vercel`), and no
Worker is involved.

1. Import the GitHub repo in Vercel. `vercel.json` already sets the build (`vite build --mode vercel`, output `dist`).
2. Allow the Vercel domain to read the bucket: put it in `r2-cors.json`, then
   `npx wrangler r2 bucket cors set floating-algal-dashboard --file r2-cors.json`.

To try this mode locally: `npm run dev:public` (needs `http://localhost:5173` in the CORS rules).

## Deploy on Cloudflare Workers

```bash
npx wrangler login   # once
npm run deploy
```

This publishes the site and the API as the Worker `floating-algal-dashboard` on your Cloudflare
account, bound to the R2 bucket of the same name.
