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
  const geoms = buf.length > 100 ? parseShp(buf) : []
  let m2 = 0
  let patches = 0
  for (const g of geoms) {
    if (!g) continue
    m2 += turfArea({ type: 'Feature', geometry: g, properties: {} })
    const polys = g.type === 'MultiPolygon' ? g.coordinates : [g.coordinates]
    patches += polys.length
    // Extent from the outer rings themselves: some writers leave the file header's bbox wrong.
    for (const poly of polys) {
      for (const [x, y] of poly[0] ?? []) {
        if (x < bbox[0]) bbox[0] = x
        if (y < bbox[1]) bbox[1] = y
        if (x > bbox[2]) bbox[2] = x
        if (y > bbox[3]) bbox[3] = y
      }
    }
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
