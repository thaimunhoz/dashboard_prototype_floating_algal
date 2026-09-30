// Lists local files and the R2 keys they belong under (shared by make-upload-manifest.mjs and sync-r2.mjs).
//   - daily masks:  <masks-dir>/<YYYY-MM-DD>/<YYYY-MM-DD>.*  → <prefix><date>/<file>
//   - composites / coverage / cells: <dir>/**                 → <prefix><kind>/...
//   - summary.json                                            → <prefix>summary.json
import { readdir, stat } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join, resolve, relative, sep } from 'node:path'

export const OPTIONS = {
  masks: { type: 'string' },
  composites: { type: 'string' },
  coverage: { type: 'string' },
  cells: { type: 'string' },
  summary: { type: 'string' },
  // R2 folder to upload into; defaults to MASK_PREFIX in wrangler.jsonc (e.g. --prefix europe-masks-2025/).
  prefix: { type: 'string' },
}

/** Bucket name and key prefix (from wrangler.jsonc unless overridden), so uploads land where the dashboard reads. */
export function r2Config(prefix) {
  const cfg = JSON.parse(readFileSync('wrangler.jsonc', 'utf8').replace(/^\s*\/\/.*$/gm, ''))
  return { bucket: cfg.r2_buckets[0].bucket_name, prefix: prefix ? prefix.replace(/\/?$/, '/') : cfg.vars.MASK_PREFIX }
}

async function* walk(dir) {
  for (const d of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, d.name)
    if (d.isDirectory()) yield* walk(p)
    else if (d.isFile()) yield p
  }
}

const posix = (p) => p.split(sep).join('/')

/** [{ key, file, size }] for every source given in args. */
export async function collectEntries(args, prefix) {
  const entries = []
  const add = async (key, file) => entries.push({ key, file: resolve(file), size: (await stat(file)).size })

  if (args.masks) {
    const days = (await readdir(args.masks)).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort()
    for (const day of days) {
      for await (const file of walk(join(args.masks, day))) {
        await add(`${prefix}${day}/${posix(relative(join(args.masks, day), file))}`, file)
      }
    }
  }
  for (const kind of ['composites', 'coverage', 'cells']) {
    if (!args[kind]) continue
    for await (const file of walk(args[kind])) await add(`${prefix}${kind}/${posix(relative(args[kind], file))}`, file)
  }
  if (args.summary) await add(`${prefix}summary.json`, args.summary)
  return entries
}
