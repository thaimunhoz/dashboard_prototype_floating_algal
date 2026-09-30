// Where the dashboard reads data from, per region (shared/regions.ts).
//
// - VITE_DATA_URL set (the public bucket root, e.g. https://pub-….r2.dev/): read files
//   straight from the public bucket under each region's folder. Used for static hosting (Vercel).
// - Not set: go through the Cloudflare Worker's /api/<region>/… routes (worker/index.ts).
import { getRegion, type RegionId } from '../shared/regions'

const base = (import.meta.env.VITE_DATA_URL as string | undefined)?.replace(/\/?$/, '/')

// Optional override for trying freshly built files before uploading them, e.g.
// VITE_DERIVED_URL=/data/ in .env.development.local serves data/<region>/{summary.json,composites,coverage,cells}
// (the daily masks still come from the bucket).
const derivedBase = (import.meta.env.VITE_DERIVED_URL as string | undefined)?.replace(/\/?$/, '/')

function bucketUrl(region: RegionId, path: string) {
  return `${base}${getRegion(region)!.prefix}${path}`
}

export function summaryUrl(region: RegionId) {
  if (derivedBase) return `${derivedBase}${region}/summary.json`
  return base ? bucketUrl(region, 'summary.json') : `/api/${region}/summary`
}

export function maskUrl(region: RegionId, date: string) {
  return base ? bucketUrl(region, `${date}/${date}.shp`) : `/api/${region}/mask/${date}.shp`
}

function derivedUrl(region: RegionId, path: string) {
  if (derivedBase) return `${derivedBase}${region}/${path}`
  return base ? bucketUrl(region, path) : `/api/${region}/${path}`
}

/** Weekly/monthly frequency composites from scripts/build_composites.py. */
export function compositeUrl(region: RegionId, kind: 'weekly' | 'monthly', file: string) {
  return derivedUrl(region, `composites/${kind}/${file}`)
}

/** Daily observation coverage from scripts/build_coverage.py ('summary.json' or '<date>.geojson'). */
export function coverageUrl(region: RegionId, file: string) {
  return derivedUrl(region, `coverage/${file}`)
}

/** 4 km fishnet time series from scripts/build_cells.py ('grid.json' or '<block>.json'). */
export function cellsUrl(region: RegionId, file: string) {
  return derivedUrl(region, `cells/${file}`)
}
