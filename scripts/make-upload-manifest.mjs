#!/usr/bin/env node
// Builds the key/file list that `wrangler r2 bulk put` needs to upload a folder
// of daily masks (<dir>/<YYYY-MM-DD>/<YYYY-MM-DD>.*) under MASK_PREFIX.
//
// Usage:
//   node scripts/make-upload-manifest.mjs <masks-dir> [out-file] [summary.json]
// Then:
//   npx wrangler r2 bulk put floating-algal-dashboard --filename data/upload-manifest.json --remote
import { readdir, writeFile, mkdir, stat } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'

const [dir, out = 'data/upload-manifest.json', summary] = process.argv.slice(2)
if (!dir) {
  console.error('Usage: node scripts/make-upload-manifest.mjs <masks-dir> [out-file] [summary.json]')
  process.exit(1)
}

// Prefix comes from wrangler.jsonc so uploads land where the Worker reads.
const cfg = JSON.parse(readFileSync('wrangler.jsonc', 'utf8').replace(/^\s*\/\/.*$/gm, ''))
const prefix = cfg.vars.MASK_PREFIX

const entries = []
let bytes = 0
const days = (await readdir(dir)).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort()
for (const day of days) {
  for (const name of await readdir(join(dir, day))) {
    const file = resolve(dir, day, name)
    const s = await stat(file)
    if (!s.isFile()) continue
    entries.push({ key: `${prefix}${day}/${name}`, file })
    bytes += s.size
  }
}
if (summary) {
  entries.push({ key: `${prefix}summary.json`, file: resolve(summary) })
  bytes += (await stat(summary)).size
}

await mkdir(dirname(out), { recursive: true })
await writeFile(out, JSON.stringify(entries, null, 1))
console.log(`${out}: ${entries.length} files from ${days.length} days, ${(bytes / 1e6).toFixed(0)} MB → ${cfg.r2_buckets[0].bucket_name}/${prefix}`)
