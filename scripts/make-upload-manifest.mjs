#!/usr/bin/env node
// Builds the key/file list that `wrangler r2 bulk put` needs, uploading under MASK_PREFIX:
//   - daily masks:  <masks-dir>/<YYYY-MM-DD>/<YYYY-MM-DD>.*  → <prefix><date>/<file>
//   - composites:   <composites-dir>/{weekly,monthly}/*       → <prefix>composites/...
//   - summary.json                                            → <prefix>summary.json
//
// Usage:
//   node scripts/make-upload-manifest.mjs [--masks DIR] [--composites DIR] [--summary FILE] [--out FILE]
//   node scripts/make-upload-manifest.mjs --composites data/composites --out data/upload-composites.json
// Then:
//   npx wrangler r2 bulk put floating-algal-dashboard --filename <out> --remote
import { readdir, writeFile, mkdir, stat } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join, dirname, resolve, relative, sep } from 'node:path'
import { parseArgs } from 'node:util'

const { values: args } = parseArgs({
  options: {
    masks: { type: 'string' },
    composites: { type: 'string' },
    summary: { type: 'string' },
    out: { type: 'string', default: 'data/upload-manifest.json' },
  },
})
if (!args.masks && !args.composites && !args.summary) {
  console.error('Usage: node scripts/make-upload-manifest.mjs [--masks DIR] [--composites DIR] [--summary FILE] [--out FILE]')
  process.exit(1)
}

// Prefix comes from wrangler.jsonc so uploads land where the dashboard reads.
const cfg = JSON.parse(readFileSync('wrangler.jsonc', 'utf8').replace(/^\s*\/\/.*$/gm, ''))
const prefix = cfg.vars.MASK_PREFIX

const entries = []
let bytes = 0
async function add(key, file) {
  entries.push({ key, file: resolve(file) })
  bytes += (await stat(file)).size
}
async function* walk(dir) {
  for (const d of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, d.name)
    if (d.isDirectory()) yield* walk(p)
    else if (d.isFile()) yield p
  }
}

if (args.masks) {
  const days = (await readdir(args.masks)).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort()
  for (const day of days) {
    for await (const file of walk(join(args.masks, day))) {
      await add(`${prefix}${day}/${relative(join(args.masks, day), file).split(sep).join('/')}`, file)
    }
  }
  console.log(`daily masks: ${days.length} days`)
}
if (args.composites) {
  let n = 0
  for await (const file of walk(args.composites)) {
    await add(`${prefix}composites/${relative(args.composites, file).split(sep).join('/')}`, file)
    n++
  }
  console.log(`composites: ${n} files`)
}
if (args.summary) await add(`${prefix}summary.json`, args.summary)

await mkdir(dirname(args.out), { recursive: true })
await writeFile(args.out, JSON.stringify(entries, null, 1))
console.log(`${args.out}: ${entries.length} files, ${(bytes / 1e6).toFixed(1)} MB → ${cfg.r2_buckets[0].bucket_name}/${prefix}`)
