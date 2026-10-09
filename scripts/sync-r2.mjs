#!/usr/bin/env node
// Uploads to R2 only the files whose content changed since the last sync.
//
// Keeps an MD5 per R2 key in a state file (default data/r2-state.json). R2 reports the same
// MD5 as its ETag for these single-part uploads, so the state can be checked against the bucket.
//
// Usage:
//   node scripts/sync-r2.mjs <sources...>              dry run: list what would be uploaded
//   node scripts/sync-r2.mjs <sources...> --upload     upload the changes, then update the state
//   node scripts/sync-r2.mjs <sources...> --prune      also delete files uploaded earlier that no longer exist locally
//                                                      (only within the sources given; combine with --upload)
//   node scripts/sync-r2.mjs <sources...> --init       record the current files as already in R2 (no upload)
//   --verify            first check the bucket (public URL, ETag = MD5) for files already uploaded, e.g.
//                       after an interrupted run; --batch N (200) and --concurrency N (10) tune the upload
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
    prune: { type: 'boolean', default: false },
    init: { type: 'boolean', default: false },
    verify: { type: 'boolean', default: false },
    batch: { type: 'string', default: '200' },
    concurrency: { type: 'string', default: '10' },
  },
})
if (!['masks', 'composites', 'coverage', 'cells', 'summary'].some((k) => args[k])) {
  console.error('Usage: node scripts/sync-r2.mjs [--masks DIR] [--composites DIR] [--coverage DIR] [--cells DIR] [--summary FILE] [--upload] [--prune] | [--init]')
  process.exit(1)
}

const md5 = (file) =>
  new Promise((ok, fail) => {
    const h = createHash('md5')
    createReadStream(file).on('data', (b) => h.update(b)).on('end', () => ok(h.digest('hex'))).on('error', fail)
  })

const { bucket, prefix } = r2Config(args.prefix)
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

let changed = entries.filter((e) => state[e.key] !== hashes.get(e.key))

// Which of these files the bucket already holds with the same content (its ETag is the MD5),
// checked through the public bucket URL. Used by --verify and when retrying a failed batch.
const env = existsSync('.env.vercel') ? readFileSync('.env.vercel', 'utf8') : ''
const publicBase = env.match(/^VITE_DATA_URL=(\S+)/m)?.[1]?.replace(/\/?$/, '/')
async function inBucket(list) {
  if (!publicBase) return []
  const found = []
  let next = 0
  await Promise.all(Array.from({ length: 16 }, async () => {
    while (next < list.length) {
      const e = list[next++]
      try {
        const res = await fetch(publicBase + e.key.split('/').map(encodeURIComponent).join('/'), { method: 'HEAD' })
        if (res.ok && res.headers.get('etag')?.replaceAll('"', '') === hashes.get(e.key)) found.push(e.key)
      } catch {
        // unreachable: treat as not uploaded
      }
    }
  }))
  return found
}

// --verify: record the "changed" files the bucket already has (e.g. after an interrupted upload).
if (args.verify && changed.length) {
  if (!publicBase) {
    console.error('--verify needs the public bucket URL (VITE_DATA_URL in .env.vercel).')
    process.exit(1)
  }
  const already = await inBucket(changed)
  await saveState(already)
  console.log(`Verified against the bucket: ${already.length} of ${changed.length} files were already up to date.`)
  const done = new Set(already)
  changed = changed.filter((e) => !done.has(e.key))
}

// Stale: uploaded earlier under this prefix, in one of the given sources, but gone locally
// (e.g. a day removed from the masks folder). Deleted only with --prune.
const local = new Set(entries.map((e) => e.key))
const inScope = (rest) =>
  (args.masks && /^\d{4}-\d{2}-\d{2}\//.test(rest)) ||
  ['composites', 'coverage', 'cells'].some((k) => args[k] && rest.startsWith(`${k}/`)) ||
  (args.summary && rest === 'summary.json')
const stale = Object.keys(state).filter((k) => k.startsWith(prefix) && !local.has(k) && inScope(k.slice(prefix.length)))

// Summarise by folder so a long list stays readable.
function printGroups(keys) {
  const groups = new Map()
  for (const key of keys) {
    const rest = key.slice(prefix.length)
    const group = /^\d{4}-\d{2}-\d{2}\//.test(rest) ? 'daily masks' : rest.includes('/') ? rest.slice(0, rest.lastIndexOf('/')) : rest
    groups.set(group, [...(groups.get(group) ?? []), rest.slice(rest.lastIndexOf('/') + 1)])
  }
  for (const [group, files] of groups) {
    const shown = group === 'daily masks' ? [...new Set(files.map((f) => f.slice(0, 10)))] : files
    console.log(`  ${group}: ${shown.length > 12 ? `${shown.slice(0, 12).join(', ')} … (+${shown.length - 12})` : shown.join(', ')}`)
  }
}
const mb = changed.reduce((s, e) => s + e.size, 0) / 1e6
console.log(`${changed.length} of ${entries.length} files changed (${mb.toFixed(1)} MB):`)
printGroups(changed.map((e) => e.key))
if (stale.length) {
  console.log(`${stale.length} files in ${bucket}/${prefix} no longer exist locally${args.prune ? ' (will be deleted)' : ' (add --prune to delete them)'}:`)
  printGroups(stale)
}

if (!args.upload && !args.prune) {
  if (changed.length || stale.length) console.log('\nDry run. Add --upload to send the changes to R2 (and --prune to delete the stale files).')
  process.exit(0)
}

const wrangler = process.platform === 'win32' ? 'npx.cmd' : 'npx'
const run = (argv) => spawnSync(wrangler, ['wrangler', ...argv], { stdio: 'inherit', shell: process.platform === 'win32' })

if (args.upload && changed.length) {
  // Upload in batches and record each finished batch, so a failure (e.g. a Cloudflare 504)
  // only costs that batch: re-running continues with the files not uploaded yet.
  const size = Math.max(1, Number(args.batch) || 200)
  const manifest = 'data/upload-changed.json'
  for (let i = 0; i < changed.length; i += size) {
    const batch = changed.slice(i, i + size)
    console.log(`\nBatch ${i / size + 1} of ${Math.ceil(changed.length / size)}: ${batch.length} files`)
    await writeFile(manifest, JSON.stringify(batch.map(({ key, file }) => ({ key, file })), null, 1))
    // --force skips wrangler's "may overwrite existing objects / data catalog" prompt: overwriting the
    // changed files is the point, and the list was shown above (and by the dry run).
    const res = run(['r2', 'bulk', 'put', bucket, '--filename', manifest, '--remote', '--force', '--concurrency', args.concurrency])
    if (res.status !== 0) {
      console.error(`\nUpload failed in this batch; ${i} of ${changed.length} files are uploaded and recorded.` +
        '\nRe-run the same command to continue (add --verify to also skip files of this batch that made it).')
      process.exit(res.status ?? 1)
    }
    await saveState(batch.map((e) => e.key))
  }
  console.log(`\nUploaded ${changed.length} files; state saved to ${args.state}.`)
}

// Prune after uploading, so the dashboard never points at a file that is already gone.
if (args.prune && stale.length) {
  let deleted = 0
  for (const key of stale) {
    const res = run(['r2', 'object', 'delete', `${bucket}/${key}`, '--remote'])
    if (res.status !== 0) {
      console.error(`\nCould not delete ${key}; re-run to retry the rest.`)
      break
    }
    delete state[key]
    deleted++
  }
  await saveState([])
  console.log(`Deleted ${deleted} of ${stale.length} stale files; state saved to ${args.state}.`)
}
