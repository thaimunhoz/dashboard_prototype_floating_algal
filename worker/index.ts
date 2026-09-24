import type { DaySummary, SummaryResponse } from '../shared/types'

interface Env {
  MASKS: R2Bucket
  MASK_PREFIX: string
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

    try {
      if (url.pathname === '/api/summary') return await getSummary(env)

      // /api/mask/2025-01-01.shp
      const mask = url.pathname.match(/^\/api\/mask\/(\d{4}-\d{2}-\d{2})\.(\w+)$/)
      if (mask) return await getMaskFile(env, mask[1], mask[2].toLowerCase())
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
async function getSummary(env: Env): Promise<Response> {
  const summaryObj = await env.MASKS.get(`${env.MASK_PREFIX}summary.json`)
  if (summaryObj) {
    const summary = (await summaryObj.json()) as Omit<SummaryResponse, 'hasAreas'>
    return json({ ...summary, hasAreas: true }, 200, 300)
  }

  const days: DaySummary[] = []
  let cursor: string | undefined
  do {
    const page = await env.MASKS.list({ prefix: env.MASK_PREFIX, delimiter: '/', cursor })
    for (const p of page.delimitedPrefixes) {
      const date = p.slice(env.MASK_PREFIX.length).replace(/\/$/, '')
      if (DATE_RE.test(date)) days.push({ date, area_km2: null, patches: null })
    }
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)

  days.sort((a, b) => a.date.localeCompare(b.date))
  const body: SummaryResponse = { region: '', bbox: null, hasAreas: false, days }
  return json(body, 200, 300)
}

async function getMaskFile(env: Env, date: string, ext: string): Promise<Response> {
  if (!MASK_EXTENSIONS.has(ext)) return json({ error: 'Unsupported file type' }, 400)

  const obj = await env.MASKS.get(`${env.MASK_PREFIX}${date}/${date}.${ext}`)
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

function json(body: unknown, status = 200, maxAge = 0): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': maxAge ? `public, max-age=${maxAge}` : 'no-store',
    },
  })
}
