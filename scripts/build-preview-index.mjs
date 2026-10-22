#!/usr/bin/env node
// Per-day lists of the true-colour previews of one region, for the dashboard's "True colour" layer.
//
// Reads the per-tile index.json files written by scripts/build_previews.py and keeps the tiles in the
// region's tile shapefiles (the same lists as the masks). Writes one small JSON per day:
//   <out>/<YYYY-MM-DD>.json  [{ s: "S"|"L", t: tile, id: scene, c: [[lon,lat] x4 TL,TR,BR,BL], v: valid }]
// Images themselves are uploaded once to <bucket>/previews-truecolor/<sensor>/<tile>/<scene>.webp.
//
// Usage:
//   node scripts/build-preview-index.mjs --previews Z:/.../previews_truecolor \
//     --s2-tiles E:/.../Sentinel_tiles_Caribbean_Sea.shp --ls-tiles E:/.../Landsat_tiles_Caribbean_Sea.shp \
//     --out data/caribbean/previews
import { readFileSync, existsSync } from 'node:fs'
import { mkdir, writeFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

const { values: args } = parseArgs({
  options: {
    previews: { type: 'string' },
    's2-tiles': { type: 'string' },
    'ls-tiles': { type: 'string' },
    out: { type: 'string' },
    year: { type: 'string', default: '2025' },
    'min-valid': { type: 'string', default: '0.005' }, // skip previews that are (almost) all no-data
  },
})
if (!args.previews || !args.out || (!args['s2-tiles'] && !args['ls-tiles'])) {
  console.error('Usage: node scripts/build-preview-index.mjs --previews DIR --s2-tiles SHP --ls-tiles SHP --out DIR')
  process.exit(1)
}

/** Values of one column of a shapefile's .dbf attribute table. */
function dbfColumn(shp, column = 'Name') {
  const data = readFileSync(shp.replace(/\.shp$/i, '.dbf'))
  const nRecords = data.readUInt32LE(4)
  const headerLen = data.readUInt16LE(8)
  const recordLen = data.readUInt16LE(10)
  const fields = []
  for (let pos = 32, offset = 1; data[pos] !== 0x0d; pos += 32) {
    const name = data.subarray(pos, pos + 11).toString('latin1').replace(/\0.*$/, '')
    fields.push({ name, offset, width: data[pos + 16] })
    offset += data[pos + 16]
  }
  const f = fields.find((x) => x.name.toLowerCase() === column.toLowerCase())
  if (!f) throw new Error(`${shp}: no '${column}' column`)
  const out = []
  for (let i = 0; i < nRecords; i++) {
    const rec = headerLen + i * recordLen
    if (data[rec] === 0x2a) continue // deleted
    out.push(data.subarray(rec + f.offset, rec + f.offset + f.width).toString('latin1').trim())
  }
  return out
}

const minValid = Number(args['min-valid'])
const byDay = new Map()
let tiles = 0
let scenes = 0
let missing = 0
for (const [sensor, code, shp] of [['sentinel', 'S', args['s2-tiles']], ['landsat', 'L', args['ls-tiles']]]) {
  if (!shp) continue
  for (const tile of new Set(dbfColumn(shp))) {
    const indexPath = join(args.previews, sensor, tile, 'index.json')
    if (!existsSync(indexPath)) {
      missing++
      continue
    }
    tiles++
    const index = JSON.parse(readFileSync(indexPath, 'utf8'))
    for (const [id, e] of Object.entries(index)) {
      if (!e.date?.startsWith(args.year) || (e.valid ?? 1) < minValid) continue
      if (!byDay.has(e.date)) byDay.set(e.date, [])
      byDay.get(e.date).push({ s: code, t: tile, id, c: e.corners, v: e.valid })
      scenes++
    }
  }
}

// Rewrite the folder so days that lost all previews don't keep a stale file.
await mkdir(args.out, { recursive: true })
for (const f of await readdir(args.out)) if (/^\d{4}-\d{2}-\d{2}\.json$/.test(f)) await rm(join(args.out, f))
for (const [date, list] of byDay) {
  list.sort((a, b) => a.s.localeCompare(b.s) || a.t.localeCompare(b.t) || a.id.localeCompare(b.id))
  await writeFile(join(args.out, `${date}.json`), JSON.stringify(list))
}
console.log(`${args.out}: ${byDay.size} days, ${scenes} previews from ${tiles} tiles` +
  (missing ? ` (${missing} tiles have no previews yet)` : ''))
