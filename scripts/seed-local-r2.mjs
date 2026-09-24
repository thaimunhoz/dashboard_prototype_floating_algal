#!/usr/bin/env node
// Copies masks into the *local* simulated R2 bucket used by `npm run dev`,
// so the dashboard can be developed without touching the real bucket.
//
// Usage:
//   node scripts/seed-local-r2.mjs <masks-dir> [summary.json] [max-days]
//   node scripts/seed-local-r2.mjs E:/post_processing/CARIBBEAN_SEA/DAILY_MASKS data/summary.json
import { readdir } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const [dir, summary, maxDays] = process.argv.slice(2)
if (!dir) {
  console.error('Usage: node scripts/seed-local-r2.mjs <masks-dir> [summary.json] [max-days]')
  process.exit(1)
}

// Read bucket name + prefix from wrangler.jsonc (strip // comments first).
const cfg = JSON.parse(readFileSync('wrangler.jsonc', 'utf8').replace(/^\s*\/\/.*$/gm, ''))
const bucket = cfg.r2_buckets[0].bucket_name
const prefix = cfg.vars.MASK_PREFIX

async function put(key, file) {
  const wrangler = join('node_modules', '.bin', process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler')
  await run(wrangler, ['r2', 'object', 'put', `${bucket}/${key}`, '--file', file, '--local'], { shell: true })
}

const dates = (await readdir(dir)).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort()
  .slice(0, maxDays ? Number(maxDays) : undefined)

if (summary) {
  await put(`${prefix}summary.json`, summary)
  console.log(`put ${prefix}summary.json`)
}

// Only the .shp is needed by the map (the .dbf holds just FID); upload a few in parallel.
let done = 0
const queue = [...dates]
await Promise.all(Array.from({ length: 6 }, async () => {
  for (let date; (date = queue.shift()); ) {
    for (const ext of ['shp', 'dbf', 'prj']) {
      const file = join(dir, date, `${date}.${ext}`)
      if (existsSync(file)) await put(`${prefix}${date}/${date}.${ext}`, file)
    }
    process.stdout.write(`\r${++done}/${dates.length} ${date}   `)
  }
}))
console.log(`\nSeeded ${dates.length} days into local bucket "${bucket}".`)
