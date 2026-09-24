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

    <div v-if="gridReady" class="cell-hint">
      {{ zoom >= CELL_MIN_ZOOM ? 'Click a 4 km cell for its time series' : 'Zoom in to explore 4 km cell time series' }}
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
import { state, periods, selectedPeriod, formatDate, formatPeriod, setMode, selectPeriod } from '../state'
import { loadGrid, cellAt, loadCellSeries, type CellRef, type CellSeries as Series, type Grid } from '../cells'
import CellSeries from './CellSeries.vue'
import { loadMask, prefetchMask, type LoadedMask } from '../masks'
import { compositeUrl, coverageUrl } from '../dataSource'
import type { FeatureCollection } from 'geojson'

const DARK_STYLE = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json'
const WATER = '#0d1540'
const MASK = '#9be22f'
// Caribbean Sea; replaced by the data bbox once the summary arrives.
const DEFAULT_BOUNDS: [number, number, number, number] = [-88, 8, -58, 25]
const MASK_LAYERS = ['mask-dots-glow', 'mask-dots', 'mask-fill', 'mask-line']
const COMP_LAYERS = ['comp-lo', 'comp-hi']
const COVERAGE_LAYERS = ['coverage-fill', 'coverage-line']
const OBS_FILL = '#8fa6ff'
const OBS_S2 = '#8fa6ff'
const OBS_LANDSAT = '#e8b04a'
// The 4 km cells become clickable from this zoom on.
const CELL_MIN_ZOOM = 6
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
    bounds: state.summary?.bbox ?? DEFAULT_BOUNDS,
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
        'circle-opacity': ['interpolate', ['linear'], ['zoom'], 6, 0.35, 9, 0],
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
        'circle-opacity': ['interpolate', ['linear'], ['zoom'], 7, 1, 9, 0],
      },
    }, firstLabel)
    m.addLayer({
      id: 'mask-fill',
      type: 'fill',
      source: 'mask',
      minzoom: 6,
      paint: {
        'fill-color': MASK,
        'fill-opacity': ['interpolate', ['linear'], ['zoom'], 6, 0, 8, 0.9],
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
        'line-opacity': ['interpolate', ['linear'], ['zoom'], 6, 0, 8, 1],
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
  loadGrid().then((g) => { grid = g; gridReady.value = !!g })
  m.on('mousemove', onCellHover)
  m.on('mouseout', () => setCellOutline('cell-hover', null))
  m.on('click', onCellClick)

  map.value = m
  if (import.meta.env.DEV) (window as unknown as { __map: MLMap }).__map = m
})

onBeforeUnmount(() => map.value?.remove())

function setMaskData(mask: LoadedMask) {
  if (!styleReady.value) return
  ;(map.value?.getSource('mask') as GeoJSONSource | undefined)?.setData(mask.geojson)
  ;(map.value?.getSource('mask-points') as GeoJSONSource | undefined)?.setData(mask.points)
}

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
function loadCoverageDay(date: string) {
  let p = coverageCache.get(date)
  if (!p) {
    p = fetch(coverageUrl(`${date}.geojson`))
      .then((r) => (r.ok ? (r.json() as Promise<FeatureCollection>) : null))
      .catch(() => null)
    coverageCache.set(date, p)
    if (coverageCache.size > 16) coverageCache.delete(coverageCache.keys().next().value!)
  }
  return p
}
function setCoverageData(fc: FeatureCollection | null) {
  if (!styleReady.value) return
  ;(map.value?.getSource('coverage') as GeoJSONSource | undefined)?.setData(fc ?? { type: 'FeatureCollection', features: [] })
}

watch(() => state.showCoverage, (on) => setVisible(COVERAGE_LAYERS, on && state.mode === 'daily'))

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
  () => [state.selectedId, state.mode, comp.value, styleReady.value] as const,
  async ([id, mode]) => {
    if (!id) return
    const my = ++token
    state.maskError = ''
    const i = periods.value.findIndex((p) => p.id === id)
    const next = state.playing ? periods.value[i + 1] : undefined

    if (mode === 'daily') {
      setVisible(COMP_LAYERS, false)
      setVisible(MASK_LAYERS, true)
      setVisible(COVERAGE_LAYERS, state.showCoverage)
      loadCoverageDay(id).then((fc) => {
        if (my === token) setCoverageData(fc)
      })
      state.maskLoading = true
      try {
        const mask = await loadMask(id)
        if (my !== token) return
        current.value = mask
        state.liveStats = { date: id, area_km2: mask.area_km2, patches: mask.patches }
        setMaskData(mask)
        if (next) prefetchMask(next.id)
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
    const urls = { hi: compositeUrl(mode, `${id}.png`), lo: compositeUrl(mode, `${id}_lo.png`) }
    state.maskLoading = true
    try {
      await Promise.all([preloadImage(urls.lo), preloadImage(urls.hi)])
      if (my !== token) return
      showComposite(urls, summary.bounds)
      compositeShown.value = { id, ...urls }
      if (next) {
        preloadImage(compositeUrl(mode, `${next.id}.png`)).catch(() => {})
        preloadImage(compositeUrl(mode, `${next.id}_lo.png`)).catch(() => {})
      }
    } catch (err) {
      if (my === token) state.maskError = (err as Error).message
    } finally {
      if (my === token) state.maskLoading = false
    }
  },
  { immediate: true },
)

watch(
  () => state.summary?.bbox,
  (bbox) => { if (bbox) map.value?.fitBounds(bbox, { padding: 40, duration: 0 }) },
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
.cell-hint {
  position: absolute;
  top: 12px;
  right: 56px;
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
