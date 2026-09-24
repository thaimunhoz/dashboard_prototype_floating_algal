import { reactive, computed } from 'vue'
import type { DaySummary, SummaryResponse } from '../shared/types'
import { summaryUrl } from './dataSource'

/** Single shared store for the dashboard (small enough not to need Pinia). */
export const state = reactive({
  summary: null as SummaryResponse | null,
  summaryError: '',
  selectedDate: '',
  playing: false,
  maskLoading: false,
  maskError: '',
  /** Area / patches measured from the currently loaded mask (fallback when no summary.json). */
  liveStats: null as { date: string; area_km2: number; patches: number } | null,
  /** Set by the search box; MapView flies there and clears it. */
  flyTo: null as { bbox?: [number, number, number, number]; center?: [number, number] } | null,
  panelOpen: true,
})

export const days = computed<DaySummary[]>(() => state.summary?.days ?? [])

export const selectedIndex = computed(() => days.value.findIndex((d) => d.date === state.selectedDate))

/** Summary row for the selected date, with live stats filled in when areas are missing. */
export const selectedDay = computed<DaySummary | null>(() => {
  const d = days.value[selectedIndex.value]
  if (!d) return null
  if (d.area_km2 == null && state.liveStats?.date === d.date) {
    return { ...d, area_km2: state.liveStats.area_km2, patches: state.liveStats.patches }
  }
  return d
})

export function selectDate(date: string) {
  if (date === state.selectedDate) return
  state.selectedDate = date
  const url = new URL(location.href)
  url.searchParams.set('date', date)
  history.replaceState(null, '', url)
}

export function step(delta: number) {
  const list = days.value
  if (!list.length) return
  const i = selectedIndex.value < 0 ? 0 : selectedIndex.value
  const next = Math.min(list.length - 1, Math.max(0, i + delta))
  selectDate(list[next].date)
}

export async function loadSummary() {
  try {
    const res = await fetch(summaryUrl)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const summary = (await res.json()) as SummaryResponse
    // summary.json read directly from the bucket always carries areas; the Worker sets the flag itself.
    summary.hasAreas ??= true
    state.summary = summary
    if (!summary.days.length) {
      state.summaryError = 'No daily masks found in the bucket.'
      return
    }
    const fromUrl = new URLSearchParams(location.search).get('date')
    const valid = summary.days.some((d) => d.date === fromUrl)
    selectDate(valid ? fromUrl! : summary.days[summary.days.length - 1].date)
  } catch (err) {
    state.summaryError = `Could not load the list of masks (${(err as Error).message}).`
  }
}

// ── formatting helpers ────────────────────────────────────────────
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function monthName(m: number) {
  return MONTHS[m]
}

/** "12 Mar 2025" */
export function formatDate(iso: string) {
  const [y, m, d] = iso.split('-').map(Number)
  return `${d} ${MONTHS[m - 1]} ${y}`
}

export function formatArea(km2: number | null | undefined) {
  if (km2 == null) return '–'
  if (km2 >= 100) return Math.round(km2).toLocaleString('en-US')
  if (km2 >= 10) return km2.toFixed(1)
  return km2.toFixed(2)
}
