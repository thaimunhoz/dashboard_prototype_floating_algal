// Where the dashboard reads masks from.
//
// - VITE_DATA_URL set (e.g. the public r2.dev URL + prefix): read files straight
//   from the public bucket. Used for static hosting such as Vercel.
// - Not set: go through the Cloudflare Worker's /api routes (worker/index.ts).
const base = (import.meta.env.VITE_DATA_URL as string | undefined)?.replace(/\/?$/, '/')

export const summaryUrl = base ? `${base}summary.json` : '/api/summary'

export function maskUrl(date: string) {
  return base ? `${base}${date}/${date}.shp` : `/api/mask/${date}.shp`
}

// Optional override for trying freshly built composites/coverage before uploading them,
// e.g. VITE_DERIVED_URL=/data/ in .env.development.local (serves data/composites, data/coverage).
const derivedBase = (import.meta.env.VITE_DERIVED_URL as string | undefined)?.replace(/\/?$/, '/')

function derivedUrl(path: string) {
  if (derivedBase) return `${derivedBase}${path}`
  return base ? `${base}${path}` : `/api/${path}`
}

/** Weekly/monthly frequency composites from scripts/build_composites.py. */
export function compositeUrl(kind: 'weekly' | 'monthly', file: string) {
  return derivedUrl(`composites/${kind}/${file}`)
}

/** Daily observation coverage from scripts/build_coverage.py ('summary.json' or '<date>.geojson'). */
export function coverageUrl(file: string) {
  return derivedUrl(`coverage/${file}`)
}

/** 4 km fishnet time series from scripts/build_cells.py ('grid.json' or '<block>.json'). */
export function cellsUrl(file: string) {
  return derivedUrl(`cells/${file}`)
}
