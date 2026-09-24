#!/usr/bin/env node
// Builds summary.json (bloom area + patch count per day) from a local folder
// of daily masks laid out as <dir>/<YYYY-MM-DD>/<YYYY-MM-DD>.shp.
//
// Usage:
//   node scripts/build-summary.mjs <masks-dir> [out-file] [region-name]
//   node scripts/build-summary.mjs E:/post_processing/CARIBBEAN_SEA/DAILY_MASKS data/summary.json "Caribbean Sea"
//
// Upload the result next to the day folders in R2 (<MASK_PREFIX>summary.json).
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { parseShp } from 'shpjs'
import turfArea from '@turf/area'

const [dir, out = 'data/summary.json', region = 'Caribbean Sea'] = process.argv.slice(2)
if (!dir) {
  console.error('Usage: node scripts/build-summary.mjs <masks-dir> [out-file] [region-name]')
  process.exit(1)
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const dates = (await readdir(dir, { withFileTypes: true }))
  .filter((d) => d.isDirectory() && DATE_RE.test(d.name))
  .map((d) => d.name)
  .sort()

const days = []
const bbox = [Infinity, Infinity, -Infinity, -Infinity]

for (const [i, date] of dates.entries()) {
  const shpPath = join(dir, date, `${date}.shp`)
  if (!existsSync(shpPath)) {
    console.warn(`skip ${date}: no ${date}.shp`)
    continue
  }
  const buf = await readFile(shpPath)
  // Shapefile header bbox (bytes 36-68): xmin, ymin, xmax, ymax.
  if (buf.length >= 100) {
    const [xmin, ymin, xmax, ymax] = [36, 44, 52, 60].map((o) => buf.readDoubleLE(o))
    if (Number.isFinite(xmin) && xmax > xmin) {
      bbox[0] = Math.min(bbox[0], xmin); bbox[1] = Math.min(bbox[1], ymin)
      bbox[2] = Math.max(bbox[2], xmax); bbox[3] = Math.max(bbox[3], ymax)
    }
  }

  const geoms = buf.length > 100 ? parseShp(buf) : []
  let m2 = 0
  let patches = 0
  for (const g of geoms) {
    if (!g) continue
    m2 += turfArea({ type: 'Feature', geometry: g, properties: {} })
    patches += g.type === 'MultiPolygon' ? g.coordinates.length : 1
  }
  days.push({ date, area_km2: Math.round((m2 / 1e6) * 100) / 100, patches })
  process.stdout.write(`\r${i + 1}/${dates.length} ${date}  ${(m2 / 1e6).toFixed(1)} km²   `)
}
process.stdout.write('\n')

const summary = {
  region,
  bbox: Number.isFinite(bbox[0]) ? bbox.map((v) => Math.round(v * 1e4) / 1e4) : null,
  generated: new Date().toISOString(),
  days,
}
await mkdir(dirname(out), { recursive: true })
await writeFile(out, JSON.stringify(summary))
console.log(`Wrote ${out} (${days.length} days)`)
