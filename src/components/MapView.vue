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
        :download="`floating_algae_frequency_${compositeShown.id}.png`"
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

    <div v-if="state.mode === 'daily'" class="legend">
      <span class="swatch" /> Floating algae mask
      <span v-if="current" class="legend-date">{{ formatDate(current.date) }}</span>
    </div>
    <div v-else-if="comp" class="legend legend-ramp">
      <span class="legend-title">Days with algae detected</span>
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
import { computed, onMounted, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import * as maplibregl from 'maplibre-gl'
import type { GeoJSONSource, ImageSource, Map as MLMap } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
// MapLibre locates its worker next to its own module, which Vite's bundling breaks;
// let Vite build the worker and hand MapLibre the resulting URL.
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import { state, periods, selectedPeriod, formatDate, formatPeriod } from '../state'
import { loadMask, prefetchMask, type LoadedMask } from '../masks'
import { compositeUrl } from '../dataSource'

const DARK_STYLE = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json'
const WATER = '#0d1540'
const MASK = '#9be22f'
// Caribbean Sea; replaced by the data bbox once the summary arrives.
const DEFAULT_BOUNDS: [number, number, number, number] = [-88, 8, -58, 25]
const MASK_LAYERS = ['mask-dots-glow', 'mask-dots', 'mask-fill', 'mask-line']
const COMP_LAYERS = ['comp-lo', 'comp-hi']
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

const comp = computed(() => (state.mode === 'daily' ? null : state.composites[state.mode] ?? null))

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

    styleReady.value = true
    if (current.value) setMaskData(current.value)
  })

  map.value = m
  if (import.meta.env.DEV) (window as unknown as { __map: MLMap }).__map = m
})

onBeforeUnmount(() => map.value?.remove())

function setMaskData(mask: LoadedMask) {
  if (!styleReady.value) return
  ;(map.value?.getSource('mask') as GeoJSONSource | undefined)?.setData(mask.geojson)
  ;(map.value?.getSource('mask-points') as GeoJSONSource | undefined)?.setData(mask.points)
}

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
  a.download = `floating_algae_mask_${mask.date}.geojson`
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
