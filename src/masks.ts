import { parseShp } from 'shpjs'
import turfArea from '@turf/area'
import type { FeatureCollection, Geometry } from 'geojson'
import { maskUrl } from './dataSource'
import type { RegionId } from '../shared/regions'

export interface LoadedMask {
  date: string
  geojson: FeatureCollection
  /** One point per patch, used to keep sub-pixel patches visible when zoomed out. */
  points: FeatureCollection
  area_km2: number
  patches: number
}

// Keep a handful of recent days in memory so stepping back and forth is instant.
const CACHE_SIZE = 8
const cache = new Map<string, Promise<LoadedMask>>()

export function loadMask(region: RegionId, date: string): Promise<LoadedMask> {
  const key = `${region}/${date}`
  const hit = cache.get(key)
  if (hit) {
    // refresh LRU position
    cache.delete(key)
    cache.set(key, hit)
    return hit
  }
  const p = fetchMask(region, date)
  cache.set(key, p)
  p.catch(() => cache.delete(key))
  while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!)
  return p
}

/** Warm the cache for a date without waiting on it (used while playing). */
export function prefetchMask(region: RegionId, date: string) {
  loadMask(region, date).catch(() => {})
}

async function fetchMask(region: RegionId, date: string): Promise<LoadedMask> {
  const res = await fetch(maskUrl(region, date))
  if (!res.ok) throw new Error(res.status === 404 ? `No mask for ${date}` : `HTTP ${res.status}`)
  const buf = await res.arrayBuffer()

  // Masks are stored in WGS84 lon/lat, so no reprojection is needed.
  // An empty-day shapefile is just the 100-byte header.
  const geoms = (buf.byteLength > 100 ? parseShp(buf) : []) as (Geometry | null)[]

  let m2 = 0
  let patches = 0
  const features: FeatureCollection['features'] = []
  const points: FeatureCollection['features'] = []
  for (const g of geoms) {
    if (!g) continue
    const f = { type: 'Feature' as const, geometry: g, properties: {} }
    m2 += turfArea(f)
    const polys = g.type === 'MultiPolygon' ? g.coordinates : g.type === 'Polygon' ? [g.coordinates] : []
    patches += polys.length
    for (const poly of polys) {
      const c = ringCenter(poly[0])
      if (c) points.push({ type: 'Feature', geometry: { type: 'Point', coordinates: c }, properties: {} })
    }
    features.push(f)
  }

  return {
    date,
    geojson: { type: 'FeatureCollection', features },
    points: { type: 'FeatureCollection', features: points },
    area_km2: m2 / 1e6,
    patches,
  }
}

/** Bounding-box centre of a ring: cheap, and patches are small enough that it's accurate. */
function ringCenter(ring: number[][] | undefined): [number, number] | null {
  if (!ring?.length) return null
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const [x, y] of ring) {
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  return [(minX + maxX) / 2, (minY + maxY) / 2]
}
