<template>
  <div class="timeline">
    <div class="tl-head">
      <div class="controls">
        <button class="ctl" :title="`Previous ${unit} (←)`" :disabled="!canPrev" @click="step(-1)">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5v14M18 5l-9 7 9 7z" /></svg>
        </button>
        <button class="ctl play" :title="state.playing ? 'Pause (space)' : 'Play (space)'" :disabled="!periods.length" @click="togglePlay">
          <svg v-if="!state.playing" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4l13 8-13 8z" /></svg>
          <svg v-else viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4h4v16H7zM13 4h4v16h-4z" /></svg>
        </button>
        <button class="ctl" :title="`Next ${unit} (→)`" :disabled="!canNext" @click="step(1)">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 5v14M6 5l9 7-9 7z" /></svg>
        </button>
      </div>

      <div class="modes" role="radiogroup" aria-label="Time step">
        <button
          v-for="m in MODES"
          :key="m"
          role="radio"
          :aria-checked="state.mode === m"
          :class="{ on: state.mode === m }"
          @click="setMode(m)"
        >
          {{ MODE_LABEL[m] }}
        </button>
      </div>

      <div class="current">
        <span class="dot" :class="{ busy: state.maskLoading }" />
        <strong>{{ selectedPeriod ? formatPeriod(selectedPeriod, state.mode) : '—' }}</strong>
        <span v-if="selectedPeriod?.area_km2 != null" class="muted">
          · {{ formatArea(selectedPeriod.area_km2) }} km²{{ state.mode === 'daily' ? '' : ' / day' }}
        </span>
      </div>

      <div class="speed">
        <label for="speed">Speed</label>
        <select id="speed" v-model.number="speed">
          <option :value="1500">0.5×</option>
          <option :value="700">1×</option>
          <option :value="250">2×</option>
        </select>
      </div>
    </div>

    <div
      ref="track"
      class="track"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerleave="hover = null"
    >
      <svg class="bars" :viewBox="`0 0 ${span} 100`" preserveAspectRatio="none" aria-hidden="true">
        <rect
          v-for="b in bars"
          :key="b.id"
          :x="b.x + b.gap"
          :y="100 - b.h"
          :width="Math.max(0.1, b.w - 2 * b.gap)"
          :height="b.h"
          :class="{ sel: b.id === state.selectedId, empty: b.empty }"
        />
      </svg>
      <div
        v-if="selBand"
        class="sel-band"
        :style="{ left: `${(selBand.x / span) * 100}%`, width: `max(6px, ${(selBand.w / span) * 100}%)` }"
      />
      <div v-for="m in months" :key="m.key" class="month" :style="{ left: `${(m.x / span) * 100}%` }">
        <span>{{ m.label }}</span>
      </div>
      <div v-if="hover" class="tip" :style="{ left: `${(hover.x / span) * 100}%` }">
        <template v-if="hover.period">
          <strong>{{ formatPeriod(hover.period, state.mode) }}</strong>
          <span v-if="hover.period.area_km2 != null">
            {{ formatArea(hover.period.area_km2) }} km²{{ state.mode === 'daily' ? '' : ' mean per day' }}
          </span>
          <span v-else>mask available</span>
        </template>
        <template v-else>
          <strong>{{ formatDate(hover.date) }}</strong>
          <span class="muted">no data</span>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import {
  state, periods, dataRange, selectedIndex, selectedPeriod, step, selectPeriod, setMode,
  formatDate, formatPeriod, formatArea, monthName, toMs, toIso, MODES, type Mode, type Period,
} from '../state'

const DAY_MS = 86_400_000
const MODE_LABEL: Record<Mode, string> = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly' }
const unit = computed(() => ({ daily: 'day', weekly: 'week', monthly: 'month' })[state.mode])

const track = ref<HTMLDivElement>()
const hover = ref<{ x: number; date: string; period?: Period } | null>(null)
const speed = ref(700)

// Calendar extent of the data; composites are clipped to it.
const start = computed(() => (dataRange.value ? toMs(dataRange.value.start) : 0))
const span = computed(() => (dataRange.value ? (toMs(dataRange.value.end) - start.value) / DAY_MS + 1 : 1))
const dayX = (iso: string) => (toMs(iso) - start.value) / DAY_MS

/** [x, width] of a period in day units, clipped to the data extent. */
function extent(p: Period) {
  const x0 = Math.max(0, dayX(p.start))
  const x1 = Math.min(span.value, dayX(p.end) + 1)
  return { x: x0, w: Math.max(0, x1 - x0) }
}

const bars = computed(() => {
  const max = Math.max(0, ...periods.value.map((p) => p.area_km2 ?? 0))
  const gap = state.mode === 'daily' ? 0.12 : 0.6
  return periods.value.map((p) => {
    // sqrt scale: bloom areas span several orders of magnitude.
    let h = 22
    if (p.area_km2 != null && max > 0) h = p.area_km2 > 0 ? 6 + 94 * Math.sqrt(p.area_km2 / max) : 3
    return { id: p.id, ...extent(p), h, gap, empty: p.area_km2 === 0 }
  })
})

const selBand = computed(() => (selectedPeriod.value ? extent(selectedPeriod.value) : null))

const months = computed(() => {
  if (!dataRange.value) return []
  const out: { key: string; x: number; label: string }[] = []
  const first = new Date(start.value)
  let y = first.getUTCFullYear()
  let m = first.getUTCMonth()
  for (;;) {
    const x = (Date.UTC(y, m, 1) - start.value) / DAY_MS
    if (x >= span.value) break
    // Year shown on January and on the first label.
    if (x >= 0) out.push({ key: `${y}-${m}`, x, label: m === 0 || !out.length ? `${monthName(m)} ${y}` : monthName(m) })
    if (++m === 12) { m = 0; y++ }
  }
  return out
})

const canPrev = computed(() => selectedIndex.value > 0)
const canNext = computed(() => selectedIndex.value >= 0 && selectedIndex.value < periods.value.length - 1)

function periodAt(ev: PointerEvent) {
  const r = track.value!.getBoundingClientRect()
  const x = Math.min(span.value - 1, Math.max(0, Math.floor(((ev.clientX - r.left) / r.width) * span.value)))
  const date = toIso(start.value + x * DAY_MS)
  return { x: x + 0.5, date, period: periods.value.find((p) => p.start <= date && date <= p.end) }
}

/** Nearest period that has data (days can be missing). */
function nearest(date: string) {
  const t = toMs(date)
  let best: Period | undefined
  let bestD = Infinity
  for (const p of periods.value) {
    const d = t < toMs(p.start) ? toMs(p.start) - t : t > toMs(p.end) ? t - toMs(p.end) : 0
    if (d < bestD) { best = p; bestD = d }
  }
  return best?.id
}

let dragging = false
function onPointerDown(ev: PointerEvent) {
  if (!periods.value.length) return
  dragging = true
  track.value!.setPointerCapture(ev.pointerId)
  state.playing = false
  const id = nearest(periodAt(ev).date)
  if (id) selectPeriod(id)
  const up = () => { dragging = false; window.removeEventListener('pointerup', up) }
  window.addEventListener('pointerup', up)
}
function onPointerMove(ev: PointerEvent) {
  if (!periods.value.length) return
  const h = periodAt(ev)
  hover.value = h
  if (dragging) {
    const id = nearest(h.date)
    if (id) selectPeriod(id)
  }
}

// ── playback: advance once the current map layer has finished loading ──
let timer = 0
function togglePlay() {
  if (!state.playing && !canNext.value && periods.value.length) selectPeriod(periods.value[0].id)
  state.playing = !state.playing
}
watch(
  () => [state.playing, state.maskLoading, state.selectedId] as const,
  ([playing, loading]) => {
    clearTimeout(timer)
    if (!playing || loading) return
    timer = window.setTimeout(() => {
      if (!canNext.value) { state.playing = false; return }
      step(1)
    }, speed.value)
  },
)
onBeforeUnmount(() => clearTimeout(timer))
</script>

<style scoped>
.timeline {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 20px 10px;
  min-width: 0;
  background: var(--panel);
  border-bottom: 1px solid var(--line);
}

.tl-head {
  display: grid;
  grid-template-columns: auto auto 1fr auto;
  align-items: center;
  gap: 16px;
}
.controls {
  display: flex;
  gap: 4px;
}
.ctl {
  width: 30px;
  height: 30px;
  display: grid;
  place-items: center;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel-2);
  color: var(--text-1);
  cursor: pointer;
}
.ctl svg {
  width: 14px;
  height: 14px;
  fill: currentColor;
  stroke: currentColor;
  stroke-width: 1.5;
  stroke-linejoin: round;
}
.ctl.play {
  background: var(--accent);
  border-color: var(--accent);
  color: #0d1a05;
}
.ctl:hover:not(:disabled) {
  border-color: var(--accent);
}
.ctl:disabled {
  opacity: 0.35;
  cursor: default;
}

.modes {
  display: flex;
  padding: 3px;
  border: 1px solid var(--line);
  border-radius: 9px;
  background: var(--panel-2);
}
.modes button {
  border: 0;
  background: transparent;
  color: var(--text-2);
  font: inherit;
  font-size: 12.5px;
  font-weight: 600;
  padding: 5px 12px;
  border-radius: 6px;
  cursor: pointer;
}
.modes button:hover:not(.on) {
  color: var(--text-1);
}
.modes button.on {
  background: var(--accent);
  color: #0d1a05;
}

.current {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-width: 0;
  font-size: 14px;
  white-space: nowrap;
}
.current strong {
  overflow: hidden;
  text-overflow: ellipsis;
}
.dot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 8px var(--accent);
}
.dot.busy {
  animation: pulse 0.8s ease-in-out infinite alternate;
}
@keyframes pulse {
  to { opacity: 0.25; }
}
.muted {
  color: var(--text-3);
}

.speed {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-3);
}
.speed select {
  background: var(--panel-2);
  color: var(--text-1);
  border: 1px solid var(--line);
  border-radius: 6px;
  font: inherit;
  padding: 3px 4px;
}

.track {
  position: relative;
  height: 62px;
  margin-bottom: 16px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background:
    repeating-linear-gradient(to right, transparent 0 calc(100% / 52 - 1px), rgba(255, 255, 255, 0.025) calc(100% / 52 - 1px) calc(100% / 52));
  cursor: crosshair;
  touch-action: none;
  user-select: none;
}
.bars {
  position: absolute;
  inset: 4px 0 0;
  width: 100%;
  height: calc(100% - 4px);
}
.bars rect {
  fill: var(--accent-dim);
  transition: y 0.3s, height 0.3s;
}
.bars rect.empty {
  fill: var(--text-3);
}
.bars rect.sel {
  fill: var(--accent);
}
.sel-band {
  position: absolute;
  top: -1px;
  bottom: -1px;
  border-radius: 3px;
  background: rgba(155, 226, 47, 0.14);
  border: 1px solid var(--accent);
  pointer-events: none;
  box-shadow: 0 0 12px rgba(155, 226, 47, 0.35);
  transition: left 0.15s, width 0.15s;
}
.month {
  position: absolute;
  top: 100%;
  height: 16px;
  border-left: 1px solid var(--line);
  pointer-events: none;
}
.month span {
  position: absolute;
  top: 3px;
  left: 4px;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-3);
  white-space: nowrap;
}
.tip {
  position: absolute;
  bottom: calc(100% + 8px);
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 10px;
  border-radius: 6px;
  background: #05070d;
  border: 1px solid var(--line);
  font-size: 12px;
  white-space: nowrap;
  pointer-events: none;
  z-index: 5;
}

@media (max-width: 1100px) {
  .speed {
    display: none;
  }
  .tl-head {
    grid-template-columns: auto auto 1fr;
  }
}
@media (max-width: 700px) {
  .timeline {
    padding: 10px 16px 8px;
  }
  .tl-head {
    grid-template-columns: auto 1fr;
    gap: 10px;
  }
  .current {
    grid-column: 1 / -1;
    justify-content: flex-start;
  }
  .month span {
    font-size: 10px;
  }
}
</style>
