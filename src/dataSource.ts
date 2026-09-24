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

// Optional override for trying freshly built composites before uploading them,
// e.g. VITE_COMPOSITES_URL=/data/composites/ in .env.development.local.
const compositesBase = (import.meta.env.VITE_COMPOSITES_URL as string | undefined)?.replace(/\/?$/, '/')

/** Weekly/monthly frequency composites from scripts/build_composites.py. */
export function compositeUrl(kind: 'weekly' | 'monthly', file: string) {
  if (compositesBase) return `${compositesBase}${kind}/${file}`
  return base ? `${base}composites/${kind}/${file}` : `/api/composites/${kind}/${file}`
}
