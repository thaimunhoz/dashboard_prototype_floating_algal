<template>
  <div class="map-wrap">
    <div ref="container" class="map" />

    <div class="map-tools">
      <div class="seg" role="group" aria-label="Basemap">
        <button :class="{ on: basemap === 'dark' }" @click="basemap = 'dark'">Dark</button>
        <button :class="{ on: basemap === 'satellite' }" @click="basemap = 'satellite'">Satellite</button>
      </div>
      <button
        v-if="state.mode === 'daily'"
        class="tool"
        :class="{ active: state.showCoverage }"
        :aria-pressed="state.showCoverage"
        title="Show the area observed by Sentinel-2 / Landsat on this day"
        @click="state.showCoverage = !state.showCoverage"
      >
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
          <path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" />
        </svg>
        Observed tiles
      </button>
      <button
        v-if="state.mode === 'daily'"
        class="tool"
        :class="{ active: trueColor }"
        :aria-pressed="trueColor"
        title="Show this day's true-colour satellite images under the masks (zoom in)"
        @click="trueColor = !trueColor"
      >
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
          <rect x="3.5" y="5" width="17" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="1.8" />
          <path d="M5 17l4.5-5 3.5 3.5 2.5-2.5L19 17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" />
          <circle cx="15.5" cy="9" r="1.6" fill="currentColor" />
        </svg>
        True colour
      </button>
      <label v-if="state.mode === 'daily' && trueColor" class="tool opacity" title="Mask opacity over the true-colour images">
        Mask
        <input v-model.number="maskOpacity" type="range" min="0" max="1" step="0.05" aria-label="Mask opacity" />
      </label>
      <button
        v-if="state.mode === 'daily'"
        class="tool"
        :disabled="!current || !current.geojson.features.length"
        title="Download this day's mask as GeoJSON"
        @click="download"
      >
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
          <path d="M12 3v12m0 0l-5-5m5 5l5-5M4 19h16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        GeoJSON
      </button>
      <a
        v-else-if="compositeShown"
        class="tool"
        :href="compositeShown.hi"
        :download="`floating_algal_frequency_${compositeShown.id}.png`"
        target="_blank"
        rel="noopener"
        title="Download this composite as a PNG image"
      >
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
          <path d="M12 3v12m0 0l-5-5m5 5l5-5M4 19h16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        PNG
      </a>
    </div>

    <div class="map-status" :class="{ show: state.maskLoading || state.maskError }">
      <span v-if="state.maskLoading" class="spinner" />
      <span>{{ state.maskError || `Loading ${selectedPeriod ? formatPeriod(selectedPeriod, state.mode) : ''}…` }}</span>
    </div>

    <div class="map-hints">
      <div v-if="gridReady" class="cell-hint">
        {{ zoom >= CELL_MIN_ZOOM ? 'Click a 4 km cell for its time series' : 'Zoom in to explore 4 km cell time series' }}
      </div>

      <div v-if="state.mode === 'daily' && trueColor" class="tc-hint">
        <template v-if="zoom < TC_MIN_ZOOM">Zoom in to see this day's true-colour images</template>
        <template v-else-if="tcLoading">Loading true-colour images…</template>
        <template v-else-if="tcInfo && tcInfo.shown">
          {{ tcInfo.shown }} true-colour image{{ tcInfo.shown === 1 ? '' : 's' }} in view{{ tcInfo.total > tcInfo.shown ? ` (nearest ${tcInfo.shown} of ${tcInfo.total})` : '' }}
          · <a :href="tcInfo.nearest.url" target="_blank" rel="noopener" :title="tcInfo.nearest.id">Open image ↗</a>
        </template>
        <template v-else>No true-colour image for this day here</template>
      </div>
    </div>

    <div v-if="state.mode === 'daily'" class="legend legend-daily">
      <div class="row">
        <span class="swatch" /> Floating algal bloom mask
        <span v-if="current" class="legend-date">{{ formatDate(current.date) }}</span>
      </div>
      <template v-if="state.showCoverage && dayCoverage">
        <div class="row">
          <span class="swatch obs" /> Observed
          <span class="tile-key s2" /> Sentinel-2
          <span class="tile-key ls" /> Landsat only
        </div>
        <div class="row muted">
          {{ dayCoverage.s2_tiles }} S2 tiles · {{ dayCoverage.landsat_scenes }} Landsat scenes ·
          {{ Math.round(dayCoverage.observed_km2 / 1000).toLocaleString('en-US') }}k km² observed
        </div>
        <div class="row muted">Blank areas outside the observed tiles were not imaged.</div>
      </template>
    </div>
    <div v-else-if="comp" class="legend legend-ramp">
      <span class="legend-title">Days with algal blooms detected</span>
      <span class="ramp">
        <span v-for="(c, i) in comp.ramp" :key="c" class="step">
          <i :style="{ background: c }" />
          <small>{{ classLabel(i) }}</small>
        </span>
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, createApp, h, onMounted, onBeforeUnmount, reactive, ref, shallowRef, watch } from 'vue'
import * as maplibregl from 'maplibre-gl'
import type { GeoJSONSource, ImageSource, Map as MLMap } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
// MapLibre locates its worker next to its own module, which Vite's bundling breaks;
// let Vite build the worker and hand MapLibre the resulting URL.
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import { state, periods, selectedPeriod, formatDate, formatPeriod, setMode, selectPeriod, setViewSeries, setRegion } from '../state'
import { REGIONS, getRegion, type Region, type RegionId } from '../../shared/regions'
import FOOTPRINTS from '../../shared/footprints.json'
import { loadGrid, cellAt, loadCellSeries, loadViewSeries, type CellRef, type CellSeries as Series, type Grid } from '../cells'
import CellSeries from './CellSeries.vue'
import { loadMask, prefetchMask, type LoadedMask } from '../masks'
import { compositeUrl, coverageUrl, previewDayUrl, truecolorUrl } from '../dataSource'
import type { FeatureCollection } from 'geojson'

const DARK_STYLE = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json'
const WATER = '#0d1540'
const MASK = '#9be22f'
const MASK_LAYERS = ['mask-dots-glow', 'mask-dots', 'mask-fill', 'mask-line']
// Each mask layer's opacity property and its zoom stops [zoom, opacity, zoom, opacity] at full strength;
// the mask-opacity slider (shown with the true-colour images) scales the opacities.
const MASK_OPACITY: Record<string, ['circle-opacity' | 'fill-opacity' | 'line-opacity', number, number, number, number]> = {
  'mask-dots-glow': ['circle-opacity', 6, 0.35, 9, 0],
  'mask-dots': ['circle-opacity', 7, 1, 9, 0],
  'mask-fill': ['fill-opacity', 6, 0, 8, 0.9],
  'mask-line': ['line-opacity', 6, 0, 8, 1],
}
const COMP_LAYERS = ['comp-lo', 'comp-hi']
const COVERAGE_LAYERS = ['coverage-fill', 'coverage-line']
const OBS_FILL = '#8fa6ff'
const OBS_S2 = '#8fa6ff'
const OBS_LANDSAT = '#e8b04a'
// The 4 km cells become clickable from this zoom on.
const CELL_MIN_ZOOM = 6
// True-colour images are drawn from this zoom, at most this many (the nearest to the map centre).
const TC_MIN_ZOOM = 6.5
const TC_MAX_IMAGES = 16
// Detailed composite image takes over from the ~4 km overview around this zoom.
const COMP_SWITCH_ZOOM = 6.5

maplibregl.setWorkerUrl(maplibreWorkerUrl)
// Basemap tiles and the (large) mask GeoJSON share the worker pool; one worker makes both wait.
maplibregl.setWorkerCount(Math.min(4, Math.max(2, (navigator.hardwareConcurrency || 4) >> 1)))

const container = ref<HTMLDivElement>()
const map = shallowRef<MLMap>()
const current = shallowRef<LoadedMask | null>(null)
const compositeShown = shallowRef<{ id: string; hi: string; lo: string } | null>(null)
const basemap = ref<'dark' | 'satellite'>('dark')
const styleReady = ref(false)
const zoom = ref(0)
const gridReady = ref(false)
const trueColor = ref(false)
const maskOpacity = ref(1)
const tcLoading = ref(false)
const tcInfo = shallowRef<{ shown: number; total: number; nearest: { id: string; url: string } } | null>(null)
let grid: Grid | null = null

const comp = computed(() => (state.mode === 'daily' ? null : state.composites[state.mode] ?? null))
const dayCoverage = computed(() => (state.mode === 'daily' ? state.coverage?.[state.selectedId] ?? null : null))

function classLabel(i: number) {
  const cls = comp.value!.classes
  const lo = cls[i]
  const hi = cls[i + 1] != null ? cls[i + 1] - 1 : null
  if (hi == null) return `${lo}+`
  return hi === lo ? `${lo}` : `${lo}–${hi}`
}

onMounted(() => {
  const m = new maplibregl.Map({
    container: container.value!,
    style: DARK_STYLE,
    bounds: [...getRegion(state.region)!.bbox] as [number, number, number, number],
    fitBoundsOptions: { padding: 40 },
    attributionControl: { compact: true },
    maxPitch: 0,
  })
  m.dragRotate.disable()
  m.touchZoomRotate.disableRotation()
  m.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right')
  m.addControl(new maplibregl.FullscreenControl(), 'top-right')
  m.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left')

  // 'style.load' rather than 'load': 'load' waits for every basemap tile, so one slow tile would delay the masks.
  m.once('style.load', () => {
    const layers = m.getStyle().layers
    // Deep navy water so the green masks pop, as in the reference atlas.
    for (const l of layers) {
      if (l.type === 'fill' && /water/.test(l.id)) m.setPaintProperty(l.id, 'fill-color', WATER)
    }
    if (m.getLayer('background')) m.setPaintProperty('background', 'background-color', '#1c1f26')

    const firstLabel = layers.find((l) => l.type === 'symbol')?.id

    m.addSource('satellite', {
      type: 'raster',
      tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
      tileSize: 256,
      maxzoom: 19,
      attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
    })
    m.addLayer({ id: 'satellite', type: 'raster', source: 'satellite', layout: { visibility: 'none' } }, firstLabel)

    const empty = { type: 'FeatureCollection' as const, features: [] }
    m.addSource('mask', { type: 'geojson', data: empty })
    m.addSource('mask-points', { type: 'geojson', data: empty })
    m.addSource('coverage', { type: 'geojson', data: empty })

    // Observed area for the day (merged, so overlapping tiles don't darken) under the masks,
    // plus S2 tile outlines: blue where Sentinel-2 imaged the tile, amber where only Landsat did.
    m.addLayer({
      id: 'coverage-fill',
      type: 'fill',
      source: 'coverage',
      filter: ['==', ['get', 'kind'], 'observed'],
      paint: { 'fill-color': OBS_FILL, 'fill-opacity': 0.09 },
    }, firstLabel)
    m.addLayer({
      id: 'coverage-line',
      type: 'line',
      source: 'coverage',
      filter: ['==', ['get', 'kind'], 'tile'],
      paint: {
        'line-color': ['case', ['==', ['get', 'sensors'], 'Landsat'], OBS_LANDSAT, OBS_S2],
        'line-opacity': ['interpolate', ['linear'], ['zoom'], 4, 0.3, 8, 0.55],
        'line-width': ['interpolate', ['linear'], ['zoom'], 4, 0.5, 8, 1],
      },
    }, firstLabel)

    // Most patches are far smaller than a pixel at regional zoom and get dropped
    // when tiled, so show a glowing dot per patch until the polygons take over.
    m.addLayer({
      id: 'mask-dots-glow',
      type: 'circle',
      source: 'mask-points',
      maxzoom: 9,
      paint: {
        'circle-color': MASK,
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, 3, 8, 6],
        'circle-blur': 1,
        'circle-opacity': maskOpacityExpr('mask-dots-glow'),
      },
    }, firstLabel)
    m.addLayer({
      id: 'mask-dots',
      type: 'circle',
      source: 'mask-points',
      maxzoom: 9,
      paint: {
        'circle-color': MASK,
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, 1, 8, 2],
        'circle-opacity': maskOpacityExpr('mask-dots'),
      },
    }, firstLabel)
    m.addLayer({
      id: 'mask-fill',
      type: 'fill',
      source: 'mask',
      minzoom: 6,
      paint: {
        'fill-color': MASK,
        'fill-opacity': maskOpacityExpr('mask-fill'),
      },
    }, firstLabel)
    m.addLayer({
      id: 'mask-line',
      type: 'line',
      source: 'mask',
      minzoom: 6,
      paint: {
        'line-color': MASK,
        'line-width': ['interpolate', ['linear'], ['zoom'], 6, 1.5, 12, 0.6],
        'line-opacity': maskOpacityExpr('mask-line'),
      },
    }, firstLabel)

    // 4 km cell under the cursor / clicked cell (the grid itself is never drawn).
    m.addSource('cell-hover', { type: 'geojson', data: empty })
    m.addSource('cell-selected', { type: 'geojson', data: empty })
    m.addLayer({ id: 'cell-hover', type: 'line', source: 'cell-hover', paint: { 'line-color': '#ffffff', 'line-opacity': 0.45, 'line-width': 1 } })
    m.addLayer({ id: 'cell-selected', type: 'line', source: 'cell-selected', paint: { 'line-color': '#ffffff', 'line-width': 2 } })

    styleReady.value = true
    if (current.value) setMaskData(current.value)
  })

  zoom.value = m.getZoom()
  m.on('zoom', () => { zoom.value = m.getZoom() })
  loadRegionGrid()
  let viewTimer = 0
  m.on('moveend', () => {
    clearTimeout(viewTimer)
    viewTimer = window.setTimeout(() => {
      detectRegion()
      updateView()
      updateTrueColor()
    }, 250)
  })
  m.on('mousemove', onCellHover)
  m.on('mouseout', () => setCellOutline('cell-hover', null))
  m.on('click', onCellClick)

  map.value = m
  if (import.meta.env.DEV) (window as unknown as { __map: MLMap }).__map = m
})

onBeforeUnmount(() => map.value?.remove())

function setMaskData(mask: LoadedMask | null) {
  if (!styleReady.value) return
  const empty = { type: 'FeatureCollection' as const, features: [] }
  ;(map.value?.getSource('mask') as GeoJSONSource | undefined)?.setData(mask?.geojson ?? empty)
  ;(map.value?.getSource('mask-points') as GeoJSONSource | undefined)?.setData(mask?.points ?? empty)
}

// ── region follows the map ─────────────────────────────────────────
// Rules in shared/regions.ts: priority box, then Sentinel-2 tile footprint, then box / nearest.
function detectRegion() {
  const m = map.value
  if (!m) return
  const b = m.getBounds()
  const c = m.getCenter()
  const inView = REGIONS.filter(({ bbox: [w, s_, e, n] }) => w < b.getEast() && e > b.getWest() && s_ < b.getNorth() && n > b.getSouth())
  if (!inView.length) return
  const inBox = (r: Region) => c.lng >= r.bbox[0] && c.lng <= r.bbox[2] && c.lat >= r.bbox[1] && c.lat <= r.bbox[3]
  const fp = (r: Region) => (FOOTPRINTS as Record<string, MultiPolygonCoords | undefined>)[r.id]
  const dist = (r: Region) => Math.hypot((r.bbox[0] + r.bbox[2]) / 2 - c.lng, (r.bbox[1] + r.bbox[3]) / 2 - c.lat)
  const current = getRegion(state.region)!
  const target =
    inView.find((r) => r.priority && inBox(r)) ??
    inView.find((r) => fp(r) && inMultiPolygon(c.lng, c.lat, fp(r)!)) ??
    (inBox(current) ? current : inView.reduce((a, r) => (dist(r) < dist(a) ? r : a)))
  if (target.id !== state.region) setRegion(target.id)
}

type MultiPolygonCoords = { coordinates: number[][][][] }
/** Even-odd point-in-polygon over every ring, so holes in a footprint are respected. */
function inMultiPolygon(x: number, y: number, mp: MultiPolygonCoords) {
  let inside = false
  for (const poly of mp.coordinates) {
    for (const ring of poly) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i]
        const [xj, yj] = ring[j]
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
      }
    }
  }
  return inside
}

function loadRegionGrid() {
  const region: RegionId = state.region
  grid = null
  gridReady.value = false
  loadGrid(region).then((g) => {
    if (region !== state.region) return
    grid = g
    gridReady.value = !!g
    updateView()
  })
}

// A new region: drop the old region's layers and pop-up, load its grid.
watch(() => state.region, () => {
  popup?.remove()
  setCellOutline('cell-hover', null)
  setCellOutline('cell-selected', null)
  current.value = null
  setMaskData(null)
  setCoverageData(null)
  setVisible(COMP_LAYERS, false)
  compositeShown.value = null
  loadRegionGrid()
})

// ── timeline follows the map view ─────────────────────────────────
// When the whole region is in view the regional daily totals are used; otherwise the
// 4 km cells in view are summed (scripts/build_cells.py), so the bars match what's on screen.
let viewToken = 0
async function updateView() {
  const m = map.value
  const bbox = getRegion(state.region)!.bbox
  const b = m?.getBounds()
  const view: [number, number, number, number] | null = b ? [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()] : null
  const tol = 0.25 // degrees
  const wholeRegion = !view ||
    (view[0] <= bbox[0] + tol && view[1] <= bbox[1] + tol && view[2] >= bbox[2] - tol && view[3] >= bbox[3] - tol)
  const my = ++viewToken
  if (!state.followView || !grid || grid.region !== state.region || wholeRegion) {
    setViewSeries(null)
    state.viewLoading = false
    return
  }
  state.viewLoading = true
  const series = await loadViewSeries(grid, view!)
  if (my !== viewToken) return
  setViewSeries(series)
  state.viewLoading = false
}
watch(() => state.followView, () => updateView())

// ── 4 km cell time series ─────────────────────────────────────────
function cellPolygon(c: CellRef) {
  const [w, s_, e, n] = c.bounds
  return { type: 'Feature' as const, properties: {}, geometry: { type: 'Polygon' as const, coordinates: [[[w, s_], [e, s_], [e, n], [w, n], [w, s_]]] } }
}
function setCellOutline(source: 'cell-hover' | 'cell-selected', c: CellRef | null) {
  const src = map.value?.getSource(source) as GeoJSONSource | undefined
  src?.setData({ type: 'FeatureCollection', features: c ? [cellPolygon(c)] : [] })
}

let hoverKey = ''
function onCellHover(ev: maplibregl.MapMouseEvent) {
  const m = map.value!
  const c = grid && m.getZoom() >= CELL_MIN_ZOOM ? cellAt(grid, ev.lngLat.lng, ev.lngLat.lat) : null
  const key = c ? `${c.row}_${c.col}` : ''
  if (key === hoverKey) return
  hoverKey = key
  setCellOutline('cell-hover', c)
  m.getCanvas().style.cursor = c ? 'pointer' : ''
}

let popup: maplibregl.Popup | null = null
async function onCellClick(ev: maplibregl.MapMouseEvent) {
  const m = map.value!
  if (!grid || m.getZoom() < CELL_MIN_ZOOM) return
  const c = cellAt(grid, ev.lngLat.lng, ev.lngLat.lat)
  if (!c) return
  popup?.remove()

  const props = reactive({ series: null as Series | null, loading: true })
  const el = document.createElement('div')
  const center = `${((c.bounds[1] + c.bounds[3]) / 2).toFixed(3)}°, ${((c.bounds[0] + c.bounds[2]) / 2).toFixed(3)}°`
  const app = createApp({
    render: () =>
      props.loading
        ? h('div', { class: 'cell-loading' }, 'Loading time series…')
        : h(CellSeries, {
            series: props.series,
            center,
            selectedDate: state.mode === 'daily' ? state.selectedId : '',
            onPick: (date: string) => {
              if (state.mode !== 'daily') setMode('daily')
              selectPeriod(date)
            },
          }),
  })
  app.mount(el)
  setCellOutline('cell-selected', c)
  const p = new maplibregl.Popup({ maxWidth: '340px', className: 'cell-popup', focusAfterOpen: false })
    .setLngLat([(c.bounds[0] + c.bounds[2]) / 2, c.bounds[3]])
    .setDOMContent(el)
    .addTo(m)
  p.on('close', () => {
    app.unmount()
    if (popup === p) {
      popup = null
      setCellOutline('cell-selected', null)
    }
  })
  popup = p

  props.series = await loadCellSeries(grid, c)
  props.loading = false
}

// Coverage is small (~30 kB/day) and optional: cache a few days, show nothing on failure.
const coverageCache = new Map<string, Promise<FeatureCollection | null>>()
function loadCoverageDay(region: RegionId, date: string) {
  const key = `${region}/${date}`
  let p = coverageCache.get(key)
  if (!p) {
    p = fetch(coverageUrl(region, `${date}.geojson`))
      .then((r) => (r.ok ? (r.json() as Promise<FeatureCollection>) : null))
      .catch(() => null)
    coverageCache.set(key, p)
    if (coverageCache.size > 16) coverageCache.delete(coverageCache.keys().next().value!)
  }
  return p
}
function setCoverageData(fc: FeatureCollection | null) {
  if (!styleReady.value) return
  ;(map.value?.getSource('coverage') as GeoJSONSource | undefined)?.setData(fc ?? { type: 'FeatureCollection', features: [] })
}

watch(() => state.showCoverage, (on) => setVisible(COVERAGE_LAYERS, on && state.mode === 'daily'))

// ── true-colour images (scripts/build_previews.py) ─────────────────
// Each region has a small list per day of the previews of that day (scene, tile, map corners);
// the images of the tiles in view are drawn under the coverage outlines and the masks.
type PreviewEntry = { s: 'S' | 'L'; t: string; id: string; c: [number, number][]; v: number }
const previewDayCache = new Map<string, Promise<PreviewEntry[] | null>>()
function loadPreviewDay(region: RegionId, date: string) {
  const key = `${region}/${date}`
  let p = previewDayCache.get(key)
  if (!p) {
    p = fetch(previewDayUrl(region, date))
      .then((r) => (r.ok ? (r.json() as Promise<PreviewEntry[]>) : null))
      .catch(() => null)
    previewDayCache.set(key, p)
    if (previewDayCache.size > 30) previewDayCache.delete(previewDayCache.keys().next().value!)
  }
  return p
}
const tcLayerIds = () => map.value?.getStyle().layers.filter((l) => l.id.startsWith('tc-')).map((l) => l.id) ?? []
function clearTrueColor() {
  const m = map.value
  if (!m) return
  for (const id of tcLayerIds()) {
    m.removeLayer(id)
    if (m.getSource(id)) m.removeSource(id)
  }
}
let tcToken = 0
async function updateTrueColor() {
  const m = map.value
  const my = ++tcToken
  if (!m || !styleReady.value || !trueColor.value || state.mode !== 'daily' || !state.selectedId || m.getZoom() < TC_MIN_ZOOM) {
    clearTrueColor()
    tcInfo.value = null
    tcLoading.value = false
    return
  }
  tcLoading.value = true
  const list = await loadPreviewDay(state.region, state.selectedId)
  if (my !== tcToken) return
  tcLoading.value = false
  const b = m.getBounds()
  const c = m.getCenter()
  const box = (e: PreviewEntry) => {
    const xs = e.c.map((p) => p[0])
    const ys = e.c.map((p) => p[1])
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
  }
  const inView = (list ?? []).filter((e) => {
    const [w, s_, ea, n] = box(e)
    return w < b.getEast() && ea > b.getWest() && s_ < b.getNorth() && n > b.getSouth()
  })
  const dist = (e: PreviewEntry) => {
    const [w, s_, ea, n] = box(e)
    return Math.hypot((w + ea) / 2 - c.lng, (s_ + n) / 2 - c.lat)
  }
  inView.sort((a, b2) => dist(a) - dist(b2))
  const chosen = inView.slice(0, TC_MAX_IMAGES)
  const layerId = (e: PreviewEntry) => `tc-${e.s}-${e.t}-${e.id}`
  const wanted = new Set(chosen.map(layerId))
  for (const id of tcLayerIds()) {
    if (!wanted.has(id)) {
      m.removeLayer(id)
      if (m.getSource(id)) m.removeSource(id)
    }
  }
  // Landsat first, then Sentinel-2, so where both exist the Sentinel-2 image is on top.
  for (const e of [...chosen].sort((a, b2) => (a.s === b2.s ? 0 : a.s === 'L' ? -1 : 1))) {
    const id = layerId(e)
    if (m.getLayer(id)) continue
    const sensor = e.s === 'S' ? 'sentinel' : 'landsat'
    m.addSource(id, { type: 'image', url: truecolorUrl(sensor, e.t, e.id), coordinates: e.c as [[number, number], [number, number], [number, number], [number, number]] })
    const firstS2 = tcLayerIds().find((l) => l.startsWith('tc-S-'))
    m.addLayer({
      id,
      type: 'raster',
      source: id,
      paint: { 'raster-opacity': 1, 'raster-fade-duration': 0 },
    }, e.s === 'L' && firstS2 ? firstS2 : 'coverage-fill')
  }
  const nearest = chosen[0]
  tcInfo.value = nearest
    ? { shown: chosen.length, total: inView.length, nearest: { id: nearest.id, url: truecolorUrl(nearest.s === 'S' ? 'sentinel' : 'landsat', nearest.t, nearest.id) } }
    : { shown: 0, total: 0, nearest: { id: '', url: '' } }
}
watch(() => [trueColor.value, state.selectedId, state.mode, state.region, styleReady.value] as const, () => updateTrueColor())
// The mask slider applies only while the true-colour images are on; otherwise masks are at full strength.
function maskOpacityExpr(id: string) {
  const [, z0, o0, z1, o1] = MASK_OPACITY[id]
  const k = trueColor.value ? maskOpacity.value : 1
  return ['interpolate', ['linear'], ['zoom'], z0, o0 * k, z1, o1 * k] as ['interpolate', ['linear'], ['zoom'], number, number, number, number]
}
watch([maskOpacity, trueColor], () => {
  for (const id of MASK_LAYERS) {
    if (map.value?.getLayer(id)) map.value.setPaintProperty(id, MASK_OPACITY[id][0], maskOpacityExpr(id))
  }
})

function setVisible(ids: string[], on: boolean) {
  for (const id of ids) {
    if (map.value?.getLayer(id)) map.value.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none')
  }
}

/** Show a composite: two image layers (overview + detail) crossfading with zoom. */
function showComposite(urls: { hi: string; lo: string }, bounds: [number, number, number, number]) {
  const m = map.value!
  const [w, s, e, n] = bounds
  const coordinates: [[number, number], [number, number], [number, number], [number, number]] = [[w, n], [e, n], [e, s], [w, s]]
  const beforeId = m.getStyle().layers.find((l) => l.type === 'symbol')?.id
  for (const [id, url] of [['comp-lo', urls.lo], ['comp-hi', urls.hi]] as const) {
    const src = m.getSource(id) as ImageSource | undefined
    if (src) {
      src.updateImage({ url, coordinates })
      continue
    }
    m.addSource(id, { type: 'image', url, coordinates })
    m.addLayer({
      id,
      type: 'raster',
      source: id,
      paint: {
        'raster-resampling': 'nearest',
        'raster-fade-duration': 0,
        'raster-opacity': id === 'comp-lo'
          ? ['interpolate', ['linear'], ['zoom'], COMP_SWITCH_ZOOM - 0.5, 0.95, COMP_SWITCH_ZOOM + 0.5, 0]
          : ['interpolate', ['linear'], ['zoom'], COMP_SWITCH_ZOOM - 0.5, 0, COMP_SWITCH_ZOOM + 0.5, 0.95],
      },
    }, beforeId)
  }
  setVisible(COMP_LAYERS, true)
}

function preloadImage(url: string) {
  return new Promise<void>((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve()
    img.onerror = () => reject(new Error('Composite image not found'))
    img.src = url
  })
}

// Load whatever the selection needs; a token discards responses that arrive late.
let token = 0
watch(
  () => [state.selectedId, state.mode, comp.value, styleReady.value, state.region] as const,
  async ([id, mode, , , region]) => {
    if (!id) return
    const my = ++token
    state.maskError = ''
    const i = periods.value.findIndex((p) => p.id === id)
    const next = state.playing ? periods.value[i + 1] : undefined

    if (mode === 'daily') {
      setVisible(COMP_LAYERS, false)
      setVisible(MASK_LAYERS, true)
      setVisible(COVERAGE_LAYERS, state.showCoverage)
      loadCoverageDay(region, id).then((fc) => {
        if (my === token) setCoverageData(fc)
      })
      state.maskLoading = true
      try {
        const mask = await loadMask(region, id)
        if (my !== token) return
        current.value = mask
        state.liveStats = { date: id, area_km2: mask.area_km2, patches: mask.patches }
        setMaskData(mask)
        if (next) prefetchMask(region, next.id)
      } catch (err) {
        if (my === token) state.maskError = (err as Error).message
      } finally {
        if (my === token) state.maskLoading = false
      }
      return
    }

    // Weekly / monthly composite.
    setVisible(MASK_LAYERS, false)
    setVisible(COVERAGE_LAYERS, false)
    const summary = comp.value
    // Not ready yet: the watcher re-runs when the style or the composite summary arrives.
    if (!styleReady.value) return
    if (!summary) {
      const failed = !(mode in state.composites) // loadComposite() drops the key on failure
      state.maskLoading = !failed
      if (failed) state.maskError = 'Composites are not available yet.'
      return
    }
    if (!summary.periods.some((p) => p.id === id)) {
      setVisible(COMP_LAYERS, false)
      state.maskError = 'No composite for this period.'
      return
    }
    const urls = { hi: compositeUrl(region, mode, `${id}.png`), lo: compositeUrl(region, mode, `${id}_lo.png`) }
    state.maskLoading = true
    try {
      await Promise.all([preloadImage(urls.lo), preloadImage(urls.hi)])
      if (my !== token) return
      showComposite(urls, summary.bounds)
      compositeShown.value = { id, ...urls }
      if (next) {
        preloadImage(compositeUrl(region, mode, `${next.id}.png`)).catch(() => {})
        preloadImage(compositeUrl(region, mode, `${next.id}_lo.png`)).catch(() => {})
      }
    } catch (err) {
      if (my === token) state.maskError = (err as Error).message
    } finally {
      if (my === token) state.maskLoading = false
    }
  },
  { immediate: true },
)


watch(basemap, (b) => {
  if (!styleReady.value || !map.value) return
  map.value.setLayoutProperty('satellite', 'visibility', b === 'satellite' ? 'visible' : 'none')
})

watch(
  () => state.flyTo,
  (t) => {
    if (!t || !map.value) return
    if (t.bbox) map.value.fitBounds(t.bbox, { padding: 60, maxZoom: 11 })
    else if (t.center) map.value.flyTo({ center: t.center, zoom: 9 })
    state.flyTo = null
  },
)

// Keep the canvas sized when the side panel collapses/expands.
watch(() => state.panelOpen, () => setTimeout(() => map.value?.resize(), 260))

function download() {
  const mask = current.value
  if (!mask) return
  const blob = new Blob([JSON.stringify(mask.geojson)], { type: 'application/geo+json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `floating_algal_mask_${mask.date}.geojson`
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}
</script>

<style scoped>
.map-wrap {
  position: relative;
  height: 100%;
  min-height: 0;
  background: var(--water);
  container-type: size;
}
.map {
  position: absolute;
  inset: 0;
}

.map-tools {
  position: absolute;
  top: 12px;
  left: 12px;
  display: flex;
  gap: 8px;
  z-index: 2;
}
.seg {
  display: flex;
  background: var(--glass);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 3px;
  backdrop-filter: blur(8px);
}
.seg button,
.tool {
  border: 0;
  background: transparent;
  color: var(--text-2);
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  padding: 6px 10px;
  border-radius: 6px;
  cursor: pointer;
}
.seg button.on {
  background: var(--accent);
  color: #0d1a05;
}
.tool {
  display: flex;
  align-items: center;
  gap: 6px;
  background: var(--glass);
  border: 1px solid var(--line);
  border-radius: 8px;
  backdrop-filter: blur(8px);
}
.seg button:not(.on):hover,
.tool:not(:disabled):hover {
  color: var(--text-1);
}
.tool:disabled {
  opacity: 0.45;
  cursor: default;
}

.map-status {
  position: absolute;
  top: 12px;
  left: 50%;
  transform: translate(-50%, -8px);
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 14px;
  border-radius: 999px;
  background: var(--glass);
  border: 1px solid var(--line);
  font-size: 12px;
  color: var(--text-2);
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.2s, transform 0.2s;
  z-index: 2;
}
.map-status.show {
  opacity: 1;
  transform: translate(-50%, 0);
}
.spinner {
  width: 12px;
  height: 12px;
  border: 2px solid var(--line);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to { transform: rotate(360deg); }
}

.legend {
  position: absolute;
  left: 12px;
  bottom: 40px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-radius: 8px;
  background: var(--glass);
  border: 1px solid var(--line);
  font-size: 12px;
  color: var(--text-2);
  z-index: 2;
}
.swatch {
  width: 12px;
  height: 12px;
  border-radius: 3px;
  background: var(--accent);
  box-shadow: 0 0 8px var(--accent);
}
.legend-date {
  color: var(--text-1);
  font-weight: 600;
  padding-left: 8px;
  border-left: 1px solid var(--line);
}
.legend-ramp {
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
}
.legend-title {
  color: var(--text-1);
  font-weight: 600;
}
.ramp {
  display: flex;
  gap: 2px;
}
.step {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
}
.step i {
  width: 28px;
  height: 10px;
  border-radius: 2px;
}
.step small {
  font-size: 10px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}
a.tool {
  text-decoration: none;
}
/* Hints stacked at the top right; on a narrow map they move below the toolbar so they don't cover it. */
.map-hints {
  position: absolute;
  top: 12px;
  right: 56px;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
  z-index: 2;
}
@container (max-width: 1050px) {
  .map-hints {
    top: 56px;
  }
}
.tc-hint {
  padding: 6px 10px;
  border-radius: 8px;
  background: var(--glass);
  border: 1px solid rgba(143, 166, 255, 0.5);
  font-size: 11.5px;
  color: var(--text-2);
  z-index: 2;
}
.tc-hint a {
  color: var(--accent);
  font-weight: 600;
}
.tool.opacity {
  padding: 0 10px;
}
.tool.opacity input {
  width: 80px;
  accent-color: var(--accent);
}
.cell-hint {
  padding: 6px 10px;
  border-radius: 8px;
  background: var(--glass);
  border: 1px solid var(--line);
  font-size: 11.5px;
  color: var(--text-2);
  pointer-events: none;
  z-index: 2;
}
:deep(.cell-popup .maplibregl-popup-content) {
  padding: 12px 12px 10px;
  border-radius: 10px;
  background: #121620;
  border: 1px solid var(--line);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5);
}
:deep(.cell-popup .maplibregl-popup-tip) {
  border-top-color: #121620;
  border-bottom-color: #121620;
}
:deep(.cell-popup .maplibregl-popup-close-button) {
  color: var(--text-2);
  font-size: 18px;
  padding: 2px 8px;
}
:deep(.cell-loading) {
  width: 300px;
  padding: 20px 0;
  text-align: center;
  color: var(--text-2);
  font-size: 12px;
}
.tool.active {
  color: var(--text-1);
  border-color: rgba(143, 166, 255, 0.6);
}
.legend-daily {
  flex-direction: column;
  align-items: flex-start;
  gap: 5px;
  max-width: calc(100% - 90px);
}
.legend-daily .row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.legend-daily .muted {
  font-size: 11px;
  color: var(--text-3);
}
.swatch.obs {
  background: rgba(143, 166, 255, 0.35);
  box-shadow: none;
}
.tile-key {
  width: 14px;
  height: 10px;
  border: 1.5px solid;
  border-radius: 2px;
  margin-left: 4px;
}
.tile-key.s2 {
  border-color: #8fa6ff;
}
.tile-key.ls {
  border-color: #e8b04a;
}

:deep(.maplibregl-ctrl-group) {
  background: var(--glass);
  border: 1px solid var(--line);
  box-shadow: none;
}
:deep(.maplibregl-ctrl-group button + button) {
  border-top-color: var(--line);
}
:deep(.maplibregl-ctrl-icon) {
  filter: invert(0.85);
}
:deep(.maplibregl-ctrl-scale) {
  background: var(--glass);
  color: var(--text-2);
  border-color: var(--text-3);
}
:deep(.maplibregl-ctrl-attrib) {
  background: rgba(10, 13, 22, 0.7);
  color: var(--text-3);
}
:deep(.maplibregl-ctrl-attrib a) {
  color: var(--text-2);
}
:deep(.maplibregl-ctrl-attrib-button) {
  filter: invert(0.8);
}
</style>
