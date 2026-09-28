#!/usr/bin/env node
// Uploads to R2 only the files whose content changed since the last sync.
//
// Keeps an MD5 per R2 key in a state file (default data/r2-state.json). R2 reports the same
// MD5 as its ETag for these single-part uploads, so the state can be checked against the bucket.
//
// Usage:
//   node scripts/sync-r2.mjs <sources...>              dry run: list what would be uploaded
//   node scripts/sync-r2.mjs <sources...> --upload     upload the changes, then update the state
//   node scripts/sync-r2.mjs <sources...> --init       record the current files as already in R2 (no upload)
// Sources (any combination): --masks DIR --composites DIR --coverage DIR --cells DIR --summary FILE
//
// Example:
//   node scripts/sync-r2.mjs --masks Z:/.../CARIBBEAN_SEA --summary data/summary.json \
//     --composites data/composites --coverage data/coverage --cells data/cells --upload
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, readFileSync } from 'node:fs'
import { writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { OPTIONS, r2Config, collectEntries } from './lib/r2-entries.mjs'

const { values: args } = parseArgs({
  options: {
    ...OPTIONS,
    state: { type: 'string', default: 'data/r2-state.json' },
    upload: { type: 'boolean', default: false },
    init: { type: 'boolean', default: false },
  },
})
if (!Object.keys(OPTIONS).some((k) => args[k])) {
  console.error('Usage: node scripts/sync-r2.mjs [--masks DIR] [--composites DIR] [--coverage DIR] [--cells DIR] [--summary FILE] [--upload | --init]')
  process.exit(1)
}

const md5 = (file) =>
  new Promise((ok, fail) => {
    const h = createHash('md5')
    createReadStream(file).on('data', (b) => h.update(b)).on('end', () => ok(h.digest('hex'))).on('error', fail)
  })

const { bucket, prefix } = r2Config()
const entries = await collectEntries(args, prefix)
const state = existsSync(args.state) ? JSON.parse(readFileSync(args.state, 'utf8')) : {}

const hashes = new Map()
for (let i = 0; i < entries.length; i += 32) {
  const batch = entries.slice(i, i + 32)
  const hs = await Promise.all(batch.map((e) => md5(e.file)))
  batch.forEach((e, j) => hashes.set(e.key, hs[j]))
}

const saveState = async (keys) => {
  for (const k of keys) state[k] = hashes.get(k)
  await mkdir(dirname(args.state), { recursive: true })
  await writeFile(args.state, JSON.stringify(state, Object.keys(state).sort(), 1))
}

if (args.init) {
  await saveState(entries.map((e) => e.key))
  console.log(`Recorded ${entries.length} files as already in ${bucket} (${args.state}).`)
  process.exit(0)
}

const changed = entries.filter((e) => state[e.key] !== hashes.get(e.key))
const mb = changed.reduce((s, e) => s + e.size, 0) / 1e6
console.log(`${changed.length} of ${entries.length} files changed (${mb.toFixed(1)} MB):`)
// Summarise by folder so a long list stays readable.
const groups = new Map()
for (const e of changed) {
  const rest = e.key.slice(prefix.length)
  const group = /^\d{4}-\d{2}-\d{2}\//.test(rest) ? 'daily masks' : rest.includes('/') ? rest.slice(0, rest.lastIndexOf('/')) : rest
  groups.set(group, [...(groups.get(group) ?? []), rest.slice(rest.lastIndexOf('/') + 1)])
}
for (const [group, files] of groups) {
  const shown = group === 'daily masks' ? [...new Set(files.map((f) => f.slice(0, 10)))] : files
  console.log(`  ${group}: ${shown.length > 12 ? `${shown.slice(0, 12).join(', ')} … (+${shown.length - 12})` : shown.join(', ')}`)
}
if (!changed.length) process.exit(0)

if (!args.upload) {
  console.log('\nDry run. Add --upload to send these to R2.')
  process.exit(0)
}

const manifest = 'data/upload-changed.json'
await writeFile(manifest, JSON.stringify(changed.map(({ key, file }) => ({ key, file })), null, 1))
const wrangler = process.platform === 'win32' ? 'npx.cmd' : 'npx'
// --force skips wrangler's "may overwrite existing objects / data catalog" prompt: overwriting the
// changed files is the point, and the list was shown above (and by the dry run).
const res = spawnSync(wrangler, ['wrangler', 'r2', 'bulk', 'put', bucket, '--filename', manifest, '--remote', '--force'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
})
if (res.status !== 0) {
  console.error('\nUpload failed; the state was not updated, so re-running will retry the same files.')
  process.exit(res.status ?? 1)
}
await saveState(changed.map((e) => e.key))
console.log(`\nUploaded ${changed.length} files; state saved to ${args.state}.`)
