import { reactive, computed, markRaw } from 'vue'
import type { SummaryResponse } from '../shared/types'
import { summaryUrl, compositeUrl, coverageUrl } from './dataSource'
import type { ViewSeries } from './cells'
import { DEFAULT_REGION, getRegion, type RegionId } from '../shared/regions'

export type Mode = 'daily' | 'weekly' | 'monthly'
export const MODES: Mode[] = ['daily', 'weekly', 'monthly']

/** One selectable step on the timeline: a day, an ISO week or a month. */
export interface Period {
  id: string
  /** First and last calendar day, YYYY-MM-DD. */
  start: string
  end: string
  /** Daily: that day's area. Weekly/monthly: mean of the daily areas. */
  area_km2: number | null
  /** Daily only. */
  patches: number | null
  /** Days with a mask in the period. */
  days: number
  peak: { date: string; area_km2: number } | null
  /** Daily, map-view mode only: share of the view that was observed that day (0–1). */
  observed?: number
}

/** Written by scripts/build_composites.py next to each composite set. */
export interface CompositeSummary {
  kind: 'weekly' | 'monthly'
  bounds: [number, number, number, number]
  cell_m: number
  classes: number[]
  ramp: string[]
  periods: { id: string; start: string; end: string; days: number; max_count: number }[]
}

/** Per-day observation counts from scripts/build_coverage.py. */
export interface DayCoverage {
  s2_tiles: number
  landsat_scenes: number
  tiles: number
  observed_km2: number
}

/** Single shared store for the dashboard (small enough not to need Pinia). */
export const state = reactive({
  /** Region whose data is shown; follows the map (MapView) and the ?region= link. */
  region: (getRegion(new URLSearchParams(location.search).get('region'))?.id ?? DEFAULT_REGION) as RegionId,
  summary: null as SummaryResponse | null,
  summaryError: '',
  composites: {} as Partial<Record<'weekly' | 'monthly', CompositeSummary | null>>,
  coverage: null as Record<string, DayCoverage> | null,
  showCoverage: true,
  mode: 'daily' as Mode,
  selectedId: '',
  playing: false,
  maskLoading: false,
  maskError: '',
  /** Area / patches measured from the currently loaded mask (fallback when no summary.json). */
  liveStats: null as { date: string; area_km2: number; patches: number } | null,
  /** Set by the search box; MapView flies there and clears it. */
  flyTo: null as { bbox?: [number, number, number, number]; center?: [number, number] } | null,
  panelOpen: true,
  /** Timeline and chart follow the map view (sum of the 4 km cells in view) when zoomed in. */
  followView: true,
  /** Totals for the current map view; null = whole region (the daily summary is used). */
  viewSeries: null as ViewSeries | null,
  viewLoading: false,
})

export function setViewSeries(v: ViewSeries | null) {
  state.viewSeries = v ? markRaw(v) : null
}

// ── periods ───────────────────────────────────────────────────────
const DAY_MS = 86_400_000
export const toMs = (iso: string) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10))
export const toIso = (ms: number) => new Date(ms).toISOString().slice(0, 10)

/** Same period ids as scripts/build_composites.py (ISO weeks, calendar months). */
export function periodOf(iso: string, mode: Mode): { id: string; start: string; end: string } {
  if (mode === 'daily') return { id: iso, start: iso, end: iso }
  const t = toMs(iso)
  if (mode === 'monthly') {
    const d = new Date(t)
    const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)
    return { id: iso.slice(0, 7), start: `${iso.slice(0, 7)}-01`, end: toIso(end) }
  }
  const dow = (new Date(t).getUTCDay() + 6) % 7 // Monday = 0
  const monday = t - dow * DAY_MS
  const thursday = monday + 3 * DAY_MS // ISO week-year is the year of the week's Thursday
  const year = new Date(thursday).getUTCFullYear()
  const week = Math.floor((thursday - Date.UTC(year, 0, 1)) / (7 * DAY_MS)) + 1
  return { id: `${year}-W${String(week).padStart(2, '0')}`, start: toIso(monday), end: toIso(monday + 6 * DAY_MS) }
}

/** Per-day values the timeline and chart use: whole region, or the current map view. */
const dayValues = computed(() => {
  const view = state.followView ? state.viewSeries : null
  const index = view ? new Map(view.dates.map((d, i) => [d, i])) : null
  return (state.summary?.days ?? []).map((d) => {
    if (view && index) {
      const i = index.get(d.date)
      return { date: d.date, area_km2: i == null ? null : view.area[i], patches: null, observed: i == null ? 0 : view.observed[i] }
    }
    const live = d.area_km2 == null && state.liveStats?.date === d.date ? state.liveStats : null
    return { date: d.date, area_km2: d.area_km2 ?? live?.area_km2 ?? null, patches: d.patches ?? live?.patches ?? null, observed: undefined }
  })
})

const dailyPeriods = computed<Period[]>(() =>
  dayValues.value.map((d) => ({
    id: d.date,
    start: d.date,
    end: d.date,
    area_km2: d.area_km2,
    patches: d.patches,
    days: 1,
    peak: d.area_km2 != null ? { date: d.date, area_km2: d.area_km2 } : null,
    observed: d.observed,
  })),
)

function groupPeriods(mode: 'weekly' | 'monthly'): Period[] {
  const out = new Map<string, Period & { sum: number; known: number }>()
  for (const d of dayValues.value) {
    const p = periodOf(d.date, mode)
    let g = out.get(p.id)
    if (!g) out.set(p.id, (g = { ...p, area_km2: null, patches: null, days: 0, peak: null, sum: 0, known: 0 }))
    g.days++
    // In map-view mode, days when nothing in view was imaged don't count towards the mean.
    if (d.area_km2 != null && d.observed !== 0) {
      g.sum += d.area_km2
      g.known++
      if (!g.peak || d.area_km2 > g.peak.area_km2) g.peak = { date: d.date, area_km2: d.area_km2 }
    }
  }
  return [...out.values()].map(({ sum, known, ...p }) => ({ ...p, area_km2: known ? sum / known : null }))
}

const weeklyPeriods = computed(() => groupPeriods('weekly'))
const monthlyPeriods = computed(() => groupPeriods('monthly'))

export const periods = computed<Period[]>(() =>
  state.mode === 'daily' ? dailyPeriods.value : state.mode === 'weekly' ? weeklyPeriods.value : monthlyPeriods.value,
)

/** First and last day with data, for the timeline extent. */
export const dataRange = computed(() => {
  const d = state.summary?.days ?? []
  return d.length ? { start: d[0].date, end: d[d.length - 1].date } : null
})

export const selectedIndex = computed(() => periods.value.findIndex((p) => p.id === state.selectedId))
export const selectedPeriod = computed<Period | null>(() => periods.value[selectedIndex.value] ?? null)

// ── selection & URL ───────────────────────────────────────────────
function syncUrl() {
  const url = new URL(location.href)
  url.searchParams.set('region', state.region)
  if (state.selectedId) url.searchParams.set('date', state.selectedId)
  if (state.mode === 'daily') url.searchParams.delete('mode')
  else url.searchParams.set('mode', state.mode)
  history.replaceState(null, '', url)
}

export function selectPeriod(id: string) {
  if (id === state.selectedId) return
  state.selectedId = id
  syncUrl()
}

export function step(delta: number) {
  const list = periods.value
  if (!list.length) return
  const i = selectedIndex.value < 0 ? 0 : selectedIndex.value
  selectPeriod(list[Math.min(list.length - 1, Math.max(0, i + delta))].id)
}

/** Switch daily/weekly/monthly, keeping the same moment in time selected. */
export function setMode(mode: Mode) {
  if (mode === state.mode) return
  const cur = selectedPeriod.value
  state.playing = false
  state.mode = mode
  if (mode !== 'daily') loadComposite(mode)
  if (!cur) return
  // Composite containing the old selection, or the first day of the old composite.
  const anchor = mode === 'daily' ? (state.summary?.days.find((d) => d.date >= cur.start)?.date ?? cur.start) : cur.start
  const target = periods.value.find((p) => p.id === periodOf(anchor, mode).id) ?? periods.value[0]
  state.selectedId = ''
  if (target) selectPeriod(target.id)
}

/**
 * Loads the current region's daily summary. On the first load the mode and date come from
 * the link; after a region switch `keep` (the previous selection) is kept when it exists.
 */
export async function loadSummary(keep?: string) {
  const region = state.region
  loadCoverage(region)
  try {
    const res = await fetch(summaryUrl(region))
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const summary = (await res.json()) as SummaryResponse
    if (region !== state.region) return // switched again meanwhile
    // summary.json read directly from the bucket always carries areas; the Worker sets the flag itself.
    summary.hasAreas ??= true
    state.summary = summary
    if (!summary.days.length) {
      state.summaryError = 'No daily masks found in the bucket.'
      return
    }
    const params = new URLSearchParams(location.search)
    if (keep === undefined) {
      const mode = params.get('mode') as Mode | null
      if (mode && MODES.includes(mode)) state.mode = mode
    }
    if (state.mode !== 'daily') loadComposite(state.mode)
    const want = keep ?? params.get('date')
    const list = periods.value
    state.selectedId = ''
    selectPeriod(list.some((p) => p.id === want) ? want! : list[list.length - 1].id)
  } catch (err) {
    if (region === state.region) state.summaryError = `Could not load the list of masks (${(err as Error).message}).`
  }
}

/** Switch to another region (called when the map moves there), keeping the selected date. */
export function setRegion(id: RegionId) {
  if (id === state.region) return
  const keep = state.selectedId
  state.region = id
  state.summary = null
  state.summaryError = ''
  state.composites = {}
  state.coverage = null
  state.liveStats = null
  state.maskError = ''
  state.playing = false
  setViewSeries(null)
  syncUrl()
  loadSummary(keep)
}

async function loadCoverage(region: RegionId) {
  try {
    const res = await fetch(coverageUrl(region, 'summary.json'))
    if (res.ok && region === state.region) state.coverage = ((await res.json()) as { days: Record<string, DayCoverage> }).days
  } catch {
    // coverage is optional; the map just shows masks without it
  }
}

export async function loadComposite(kind: 'weekly' | 'monthly') {
  if (kind in state.composites) return
  const region = state.region
  state.composites[kind] = null
  try {
    const res = await fetch(compositeUrl(region, kind, 'summary.json'))
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const summary = (await res.json()) as CompositeSummary
    if (region === state.region) state.composites[kind] = summary
  } catch {
    if (region === state.region) delete state.composites[kind] // allow a retry on the next switch
  }
}

// ── formatting helpers ────────────────────────────────────────────
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

export function monthName(m: number) {
  return MONTHS[m]
}

/** "12 Mar 2025" */
export function formatDate(iso: string) {
  const [y, m, d] = iso.split('-').map(Number)
  return `${d} ${MONTHS[m - 1]} ${y}`
}

/** "12 Mar" */
export function formatDay(iso: string) {
  return `${+iso.slice(8, 10)} ${MONTHS[+iso.slice(5, 7) - 1]}`
}

/** Headline label for a period: "12 Mar 2025", "Week 11 · 10–16 Mar 2025", "March 2025". */
export function formatPeriod(p: Pick<Period, 'id' | 'start' | 'end'>, mode: Mode) {
  if (mode === 'daily') return formatDate(p.id)
  if (mode === 'monthly') return `${MONTHS_LONG[+p.id.slice(5, 7) - 1]} ${p.id.slice(0, 4)}`
  return `Week ${+p.id.slice(6)} · ${formatDay(p.start)} – ${formatDate(p.end)}`
}

export function formatArea(km2: number | null | undefined) {
  if (km2 == null) return '–'
  if (km2 >= 100) return Math.round(km2).toLocaleString('en-US')
  if (km2 >= 10) return km2.toFixed(1)
  return km2.toFixed(2)
}
