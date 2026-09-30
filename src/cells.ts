// 4 km fishnet time series (scripts/build_cells.py). The fishnet is a regular Web
// Mercator grid, so the clicked cell is found arithmetically and only its 64x64 block
// of numbers is downloaded.
import { cellsUrl } from './dataSource'
import type { RegionId } from '../shared/regions'

const R = 6378137

export interface Grid {
  region: RegionId
  x0: number
  y0: number
  cell: number
  cols: number
  rows: number
  chunk: number
  chunks: string[]
  dates: string[]
}

interface Chunk {
  patterns: string[]
  cells: Record<string, number[]>
}

export interface CellRef {
  row: number
  col: number
  /** Cell corners in lon/lat: [west, south, east, north]. */
  bounds: [number, number, number, number]
  /** Ground area of the cell, km². */
  km2: number
}

export interface CellSeries {
  cell: CellRef
  dates: string[]
  /** Per day: null = not observed, 0 = observed without algae, > 0 = algal area in km². */
  values: (number | null)[]
}

const gridCache = new Map<RegionId, Promise<Grid | null>>()
export function loadGrid(region: RegionId): Promise<Grid | null> {
  let p = gridCache.get(region)
  if (!p) {
    p = fetch(cellsUrl(region, 'grid.json'))
      .then((r) => (r.ok ? (r.json() as Promise<Omit<Grid, 'region'>>) : null))
      .then((g) => (g ? { ...g, region } : null))
      .catch(() => null)
    gridCache.set(region, p)
  }
  return p
}

const lonToX = (lon: number) => (lon * Math.PI / 180) * R
const latToY = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI / 180) / 2)) * R
const xToLon = (x: number) => (x / R) * 180 / Math.PI
const yToLat = (y: number) => (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * 180 / Math.PI

/** Grid cell under a lon/lat, or null outside the grid's extent. */
export function cellAt(grid: Grid, lon: number, lat: number): CellRef | null {
  const col = Math.floor((lonToX(lon) - grid.x0) / grid.cell)
  const row = Math.floor((grid.y0 - latToY(lat)) / grid.cell)
  if (col < 0 || row < 0 || col >= grid.cols || row >= grid.rows) return null
  const x = grid.x0 + col * grid.cell
  const y = grid.y0 - row * grid.cell
  const midLat = yToLat(y - grid.cell / 2)
  return {
    row,
    col,
    bounds: [xToLon(x), yToLat(y - grid.cell), xToLon(x + grid.cell), yToLat(y)],
    km2: (grid.cell / 1000) ** 2 * Math.cos((midLat * Math.PI) / 180) ** 2,
  }
}

const chunkCache = new Map<string, Promise<Chunk | null>>()
function loadChunk(region: RegionId, name: string) {
  const key = `${region}/${name}`
  let p = chunkCache.get(key)
  if (!p) {
    p = fetch(cellsUrl(region, `${name}.json`))
      .then((r) => (r.ok ? (r.json() as Promise<Chunk>) : null))
      .catch(() => null)
    chunkCache.set(key, p)
  }
  return p
}

/** Time series for a cell; null when the cell is not part of the fishnet (e.g. land). */
export async function loadCellSeries(grid: Grid, cell: CellRef): Promise<CellSeries | null> {
  const name = `${Math.floor(cell.row / grid.chunk)}_${Math.floor(cell.col / grid.chunk)}`
  if (!grid.chunks.includes(name)) return null
  const chunk = await loadChunk(grid.region, name)
  const entry = chunk?.cells[`${cell.row}_${cell.col}`]
  if (!chunk || !entry) return null

  // Observed days: one bit per day (numpy packbits, most significant bit first).
  const bits = Uint8Array.from(atob(chunk.patterns[entry[0]]), (ch) => ch.charCodeAt(0))
  const values: (number | null)[] = grid.dates.map((_, d) => ((bits[d >> 3] >> (7 - (d & 7))) & 1 ? 0 : null))
  for (let i = 1; i < entry.length; i += 2) values[entry[i]] = entry[i + 1]
  return { cell, dates: grid.dates, values }
}

/** Daily totals for the grid cells whose centre lies inside a lon/lat box. */
export interface ViewSeries {
  dates: string[]
  /** Algal bloom area per day, km², summed over the cells in view. */
  area: number[]
  /** Share of the cells in view that were observed each day (0–1). */
  observed: number[]
  cells: number
}

/**
 * Sums the per-cell series over a map view. Only the 64x64 blocks touching the view are
 * fetched (cached). Cells sharing an observation pattern are counted once per pattern.
 */
export async function loadViewSeries(grid: Grid, [w, s, e, n]: [number, number, number, number]): Promise<ViewSeries> {
  // Cell rows/cols whose centre is inside the view.
  const c0 = Math.max(0, Math.ceil((lonToX(w) - grid.x0) / grid.cell - 0.5))
  const c1 = Math.min(grid.cols - 1, Math.floor((lonToX(e) - grid.x0) / grid.cell - 0.5))
  const r0 = Math.max(0, Math.ceil((grid.y0 - latToY(Math.min(n, 85))) / grid.cell - 0.5))
  const r1 = Math.min(grid.rows - 1, Math.floor((grid.y0 - latToY(Math.max(s, -85))) / grid.cell - 0.5))

  const nd = grid.dates.length
  const area = new Array<number>(nd).fill(0)
  const obsCount = new Array<number>(nd).fill(0)
  let cells = 0
  if (c0 > c1 || r0 > r1) return { dates: grid.dates, area, observed: obsCount, cells }

  const names: string[] = []
  for (let br = Math.floor(r0 / grid.chunk); br <= Math.floor(r1 / grid.chunk); br++) {
    for (let bc = Math.floor(c0 / grid.chunk); bc <= Math.floor(c1 / grid.chunk); bc++) {
      if (grid.chunks.includes(`${br}_${bc}`)) names.push(`${br}_${bc}`)
    }
  }
  const chunks = await Promise.all(names.map((n) => loadChunk(grid.region, n)))

  for (const chunk of chunks) {
    if (!chunk) continue
    const perPattern = new Map<number, number>()
    for (const key in chunk.cells) {
      const sep = key.indexOf('_')
      const r = +key.slice(0, sep)
      const c = +key.slice(sep + 1)
      if (r < r0 || r > r1 || c < c0 || c > c1) continue
      const entry = chunk.cells[key]
      cells++
      perPattern.set(entry[0], (perPattern.get(entry[0]) ?? 0) + 1)
      for (let i = 1; i < entry.length; i += 2) area[entry[i]] += entry[i + 1]
    }
    for (const [pat, count] of perPattern) {
      const bits = Uint8Array.from(atob(chunk.patterns[pat]), (ch) => ch.charCodeAt(0))
      for (let d = 0; d < nd; d++) if ((bits[d >> 3] >> (7 - (d & 7))) & 1) obsCount[d] += count
    }
  }
  return { dates: grid.dates, area, observed: obsCount.map((k) => (cells ? k / cells : 0)), cells }
}
