#!/usr/bin/env node
// Builds the key/file list that `wrangler r2 bulk put` needs (every file, changed or not).
// To upload only what changed since the last upload, use scripts/sync-r2.mjs instead.
//
// Usage:
//   node scripts/make-upload-manifest.mjs [--masks DIR] [--composites DIR] [--coverage DIR] [--cells DIR] [--summary FILE] [--out FILE]
//   node scripts/make-upload-manifest.mjs --composites data/composites --coverage data/coverage --cells data/cells --out data/upload-derived.json
// Then:
//   npx wrangler r2 bulk put floating-algal-dashboard --filename <out> --remote
import { writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { parseArgs } from 'node:util'
import { OPTIONS, r2Config, collectEntries } from './lib/r2-entries.mjs'

const { values: args } = parseArgs({
  options: { ...OPTIONS, out: { type: 'string', default: 'data/upload-manifest.json' } },
})
if (!Object.keys(OPTIONS).some((k) => args[k])) {
  console.error('Usage: node scripts/make-upload-manifest.mjs [--masks DIR] [--composites DIR] [--coverage DIR] [--cells DIR] [--summary FILE] [--out FILE]')
  process.exit(1)
}

const { bucket, prefix } = r2Config()
const entries = await collectEntries(args, prefix)
await mkdir(dirname(args.out), { recursive: true })
await writeFile(args.out, JSON.stringify(entries.map(({ key, file }) => ({ key, file })), null, 1))
const mb = entries.reduce((s, e) => s + e.size, 0) / 1e6
console.log(`${args.out}: ${entries.length} files, ${mb.toFixed(1)} MB → ${bucket}/${prefix}`)
