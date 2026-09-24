<template>
  <div class="map-wrap">
    <div ref="container" class="map" />

    <div class="map-tools">
      <div class="seg" role="group" aria-label="Basemap">
        <button :class="{ on: basemap === 'dark' }" @click="basemap = 'dark'">Dark</button>
        <button :class="{ on: basemap === 'satellite' }" @click="basemap = 'satellite'">Satellite</button>
      </div>
      <button
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
    </div>

    <div class="map-status" :class="{ show: state.maskLoading || state.maskError }">
      <span v-if="state.maskLoading" class="spinner" />
      <span>{{ state.maskError || `Loading ${formatDate(state.selectedDate)}…` }}</span>
    </div>

    <div class="legend">
      <span class="swatch" /> Floating algae mask
      <span v-if="current" class="legend-date">{{ formatDate(current.date) }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import * as maplibregl from 'maplibre-gl'
import type { GeoJSONSource, Map as MLMap } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
// MapLibre locates its worker next to its own module, which Vite's bundling breaks;
// let Vite build the worker and hand MapLibre the resulting URL.
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import { state, days, formatDate } from '../state'
import { loadMask, prefetchMask, type LoadedMask } from '../masks'

const DARK_STYLE = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json'
const WATER = '#0d1540'
const MASK = '#9be22f'
// Caribbean Sea; replaced by the data bbox once the summary arrives.
const DEFAULT_BOUNDS: [number, number, number, number] = [-88, 8, -58, 25]

maplibregl.setWorkerUrl(maplibreWorkerUrl)
// Basemap tiles and the (large) mask GeoJSON share the worker pool; one worker makes both wait.
maplibregl.setWorkerCount(Math.min(4, Math.max(2, (navigator.hardwareConcurrency || 4) >> 1)))

const container = ref<HTMLDivElement>()
const map = shallowRef<MLMap>()
const current = shallowRef<LoadedMask | null>(null)
const basemap = ref<'dark' | 'satellite'>('dark')
let styleReady = false

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

    styleReady = true
    if (current.value) setMaskData(current.value)
  })

  map.value = m
  if (import.meta.env.DEV) (window as unknown as { __map: MLMap }).__map = m
})

onBeforeUnmount(() => map.value?.remove())

function setMaskData(mask: LoadedMask) {
  if (!styleReady) return
  ;(map.value?.getSource('mask') as GeoJSONSource | undefined)?.setData(mask.geojson)
  ;(map.value?.getSource('mask-points') as GeoJSONSource | undefined)?.setData(mask.points)
}

// Load the mask whenever the selected date changes; ignore stale responses.
let token = 0
watch(
  () => state.selectedDate,
  async (date) => {
    if (!date) return
    const my = ++token
    state.maskLoading = true
    state.maskError = ''
    try {
      const mask = await loadMask(date)
      if (my !== token) return
      current.value = mask
      state.liveStats = { date, area_km2: mask.area_km2, patches: mask.patches }
      setMaskData(mask)

      // While playing, fetch the next day in the background.
      if (state.playing) {
        const i = days.value.findIndex((d) => d.date === date)
        const next = days.value[i + 1]
        if (next) prefetchMask(next.date)
      }
    } catch (err) {
      if (my !== token) return
      state.maskError = (err as Error).message
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
  if (!styleReady || !map.value) return
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
