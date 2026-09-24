// 4 km fishnet time series (scripts/build_cells.py). The fishnet is a regular Web
// Mercator grid, so the clicked cell is found arithmetically and only its 64x64 block
// of numbers is downloaded.
import { cellsUrl } from './dataSource'

const R = 6378137

export interface Grid {
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

let gridPromise: Promise<Grid | null> | null = null
export function loadGrid(): Promise<Grid | null> {
  gridPromise ??= fetch(cellsUrl('grid.json'))
    .then((r) => (r.ok ? (r.json() as Promise<Grid>) : null))
    .catch(() => null)
  return gridPromise
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
function loadChunk(name: string) {
  let p = chunkCache.get(name)
  if (!p) {
    p = fetch(cellsUrl(`${name}.json`))
      .then((r) => (r.ok ? (r.json() as Promise<Chunk>) : null))
      .catch(() => null)
    chunkCache.set(name, p)
  }
  return p
}

/** Time series for a cell; null when the cell is not part of the fishnet (e.g. land). */
export async function loadCellSeries(grid: Grid, cell: CellRef): Promise<CellSeries | null> {
  const name = `${Math.floor(cell.row / grid.chunk)}_${Math.floor(cell.col / grid.chunk)}`
  if (!grid.chunks.includes(name)) return null
  const chunk = await loadChunk(name)
  const entry = chunk?.cells[`${cell.row}_${cell.col}`]
  if (!chunk || !entry) return null

  // Observed days: one bit per day (numpy packbits, most significant bit first).
  const bits = Uint8Array.from(atob(chunk.patterns[entry[0]]), (ch) => ch.charCodeAt(0))
  const values: (number | null)[] = grid.dates.map((_, d) => ((bits[d >> 3] >> (7 - (d & 7))) & 1 ? 0 : null))
  for (let i = 1; i < entry.length; i += 2) values[entry[i]] = entry[i + 1]
  return { cell, dates: grid.dates, values }
}
