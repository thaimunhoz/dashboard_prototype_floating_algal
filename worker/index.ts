import type { DaySummary, SummaryResponse } from '../shared/types'
import { getRegion } from '../shared/regions'

interface Env {
  MASKS: R2Bucket
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
// Shapefile components we are willing to serve.
const MASK_EXTENSIONS = new Set(['shp', 'dbf', 'shx', 'prj', 'cpg'])

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return json({ error: 'Method not allowed' }, 405)
    }

    // /api/<region>/<rest>; the region maps to its folder in the bucket (shared/regions.ts).
    const m = url.pathname.match(/^\/api\/([a-z]+)\/(.+)$/)
    const region = m ? getRegion(m[1]) : undefined
    if (!m || !region) return json({ error: 'Not found' }, 404)
    const prefix = region.prefix
    const rest = m[2]

    try {
      if (rest === 'summary') return await getSummary(env, prefix)

      // mask/2025-01-01.shp
      const mask = rest.match(/^mask\/(\d{4}-\d{2}-\d{2})\.(\w+)$/)
      if (mask) return await getMaskFile(env, prefix, mask[1], mask[2].toLowerCase())

      // composites/weekly/2025-W03.png, composites/monthly/summary.json
      // coverage/summary.json, coverage/2025-01-13.geojson
      // cells/grid.json, cells/3_12.json
      if (
        /^composites\/(weekly|monthly)\/(summary\.json|[\w-]+\.png)$/.test(rest) ||
        /^coverage\/(summary\.json|\d{4}-\d{2}-\d{2}\.geojson)$/.test(rest) ||
        /^cells\/(grid\.json|\d+_\d+\.json)$/.test(rest)
      ) {
        return await getDerived(env, prefix, rest)
      }
    } catch (err) {
      console.error(err)
      return json({ error: 'Internal error' }, 500)
    }

    return json({ error: 'Not found' }, 404)
  },
} satisfies ExportedHandler<Env>

/**
 * Returns the per-day summary. Prefers `<prefix>summary.json` (areas
 * precomputed by scripts/build-summary.mjs); otherwise lists the day
 * folders in the bucket so the timeline still works without areas.
 */
async function getSummary(env: Env, prefix: string): Promise<Response> {
  const summaryObj = await env.MASKS.get(`${prefix}summary.json`)
  if (summaryObj) {
    const summary = (await summaryObj.json()) as Omit<SummaryResponse, 'hasAreas'>
    return json({ ...summary, hasAreas: true }, 200, 300)
  }

  const days: DaySummary[] = []
  let cursor: string | undefined
  do {
    const page = await env.MASKS.list({ prefix, delimiter: '/', cursor })
    for (const p of page.delimitedPrefixes) {
      const date = p.slice(prefix.length).replace(/\/$/, '')
      if (DATE_RE.test(date)) days.push({ date, area_km2: null, patches: null })
    }
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)

  days.sort((a, b) => a.date.localeCompare(b.date))
  const body: SummaryResponse = { region: '', bbox: null, hasAreas: false, days }
  return json(body, 200, 300)
}

async function getMaskFile(env: Env, prefix: string, date: string, ext: string): Promise<Response> {
  if (!MASK_EXTENSIONS.has(ext)) return json({ error: 'Unsupported file type' }, 400)

  const obj = await env.MASKS.get(`${prefix}${date}/${date}.${ext}`)
  if (!obj) return json({ error: `No mask for ${date}` }, 404)

  const headers = new Headers()
  obj.writeHttpMetadata(headers)
  headers.set('etag', obj.httpEtag)
  headers.set('content-type', ext === 'prj' || ext === 'cpg' ? 'text/plain' : 'application/octet-stream')
  // Daily masks rarely change once published; let browsers and the CDN cache them.
  headers.set('cache-control', 'public, max-age=86400')
  headers.set('content-disposition', `inline; filename="${date}.${ext}"`)
  return new Response(obj.body, { headers })
}

/** Files built from the masks (composites, coverage, cells); paths are validated by the routes above. */
async function getDerived(env: Env, prefix: string, path: string): Promise<Response> {
  const obj = await env.MASKS.get(`${prefix}${path}`)
  if (!obj) return json({ error: `Not found: ${path}` }, 404)
  const headers = new Headers()
  obj.writeHttpMetadata(headers)
  headers.set('etag', obj.httpEtag)
  const type = path.endsWith('.png') ? 'image/png' : path.endsWith('.geojson') ? 'application/geo+json' : 'application/json'
  headers.set('content-type', type)
  const short = path.endsWith('summary.json') || path.endsWith('grid.json')
  headers.set('cache-control', `public, max-age=${short ? 300 : 86400}`)
  return new Response(obj.body, { headers })
}

function json(body: unknown, status = 200, maxAge = 0): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': maxAge ? `public, max-age=${maxAge}` : 'no-store',
    },
  })
}
