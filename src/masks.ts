import { parseShp } from 'shpjs'
import turfArea from '@turf/area'
import type { FeatureCollection, Geometry } from 'geojson'

export interface LoadedMask {
  date: string
  geojson: FeatureCollection
  area_km2: number
  patches: number
}

// Keep a handful of recent days in memory so stepping back and forth is instant.
const CACHE_SIZE = 8
const cache = new Map<string, Promise<LoadedMask>>()

export function loadMask(date: string): Promise<LoadedMask> {
  const hit = cache.get(date)
  if (hit) {
    // refresh LRU position
    cache.delete(date)
    cache.set(date, hit)
    return hit
  }
  const p = fetchMask(date)
  cache.set(date, p)
  p.catch(() => cache.delete(date))
  while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!)
  return p
}

/** Warm the cache for a date without waiting on it (used while playing). */
export function prefetchMask(date: string) {
  loadMask(date).catch(() => {})
}

async function fetchMask(date: string): Promise<LoadedMask> {
  const res = await fetch(`/api/mask/${date}.shp`)
  if (!res.ok) throw new Error(res.status === 404 ? `No mask for ${date}` : `HTTP ${res.status}`)
  const buf = await res.arrayBuffer()

  // Masks are stored in WGS84 lon/lat, so no reprojection is needed.
  // An empty-day shapefile is just the 100-byte header.
  const geoms = (buf.byteLength > 100 ? parseShp(buf) : []) as (Geometry | null)[]

  let m2 = 0
  let patches = 0
  const features: FeatureCollection['features'] = []
  for (const g of geoms) {
    if (!g) continue
    const f = { type: 'Feature' as const, geometry: g, properties: {} }
    m2 += turfArea(f)
    patches += g.type === 'MultiPolygon' ? g.coordinates.length : 1
    features.push(f)
  }

  return {
    date,
    geojson: { type: 'FeatureCollection', features },
    area_km2: m2 / 1e6,
    patches,
  }
}
