<template>
  <div class="timeline">
    <div class="tl-head">
      <div class="controls">
        <button class="ctl" title="Previous day (←)" :disabled="!canPrev" @click="step(-1)">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5v14M18 5l-9 7 9 7z" /></svg>
        </button>
        <button class="ctl play" :title="state.playing ? 'Pause (space)' : 'Play (space)'" :disabled="!days.length" @click="togglePlay">
          <svg v-if="!state.playing" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4l13 8-13 8z" /></svg>
          <svg v-else viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4h4v16H7zM13 4h4v16h-4z" /></svg>
        </button>
        <button class="ctl" title="Next day (→)" :disabled="!canNext" @click="step(1)">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 5v14M6 5l9 7-9 7z" /></svg>
        </button>
      </div>

      <div class="current">
        <span class="dot" :class="{ busy: state.maskLoading }" />
        <strong>{{ state.selectedDate ? formatDate(state.selectedDate) : '—' }}</strong>
        <span v-if="selectedDay?.area_km2 != null" class="muted">
          · {{ formatArea(selectedDay.area_km2) }} km²
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
          :key="b.date"
          :x="b.x + 0.12"
          :y="100 - b.h"
          width="0.76"
          :height="b.h"
          :class="{ sel: b.date === state.selectedDate, empty: b.empty }"
        />
      </svg>
      <div v-if="selX != null" class="sel-band" :style="{ left: `${(selX / span) * 100}%`, width: `max(6px, ${100 / span}%)` }" />
      <div v-for="m in months" :key="m.key" class="month" :style="{ left: `${(m.x / span) * 100}%` }">
        <span>{{ m.label }}</span>
      </div>
      <div
        v-if="hover"
        class="tip"
        :style="{ left: `${(hover.x / span) * 100}%` }"
      >
        <strong>{{ formatDate(hover.date) }}</strong>
        <span v-if="hover.day">{{ hover.day.area_km2 != null ? `${formatArea(hover.day.area_km2)} km²` : 'mask available' }}</span>
        <span v-else class="muted">no data</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { state, days, selectedIndex, selectedDay, step, selectDate, formatDate, formatArea, monthName } from '../state'
import type { DaySummary } from '../../shared/types'

const DAY_MS = 86_400_000
const toMs = (iso: string) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10))
const toIso = (ms: number) => new Date(ms).toISOString().slice(0, 10)

const track = ref<HTMLDivElement>()
const hover = ref<{ x: number; date: string; day?: DaySummary } | null>(null)
const speed = ref(700)

// Calendar span covered by the data, so missing days show as gaps.
const start = computed(() => (days.value.length ? toMs(days.value[0].date) : 0))
const span = computed(() =>
  days.value.length ? Math.round((toMs(days.value[days.value.length - 1].date) - start.value) / DAY_MS) + 1 : 1,
)
const byDate = computed(() => new Map(days.value.map((d) => [d.date, d])))

const bars = computed(() => {
  const max = Math.max(0, ...days.value.map((d) => d.area_km2 ?? 0))
  return days.value.map((d) => {
    const x = Math.round((toMs(d.date) - start.value) / DAY_MS)
    // sqrt scale: bloom areas span several orders of magnitude.
    let h = 22
    if (d.area_km2 != null && max > 0) h = d.area_km2 > 0 ? 6 + 94 * Math.sqrt(d.area_km2 / max) : 3
    return { date: d.date, x, h, empty: d.area_km2 === 0 }
  })
})

const selX = computed(() =>
  state.selectedDate && days.value.length ? Math.round((toMs(state.selectedDate) - start.value) / DAY_MS) : null,
)

const months = computed(() => {
  if (!days.value.length) return []
  const out: { key: string; x: number; label: string }[] = []
  const first = new Date(start.value)
  let y = first.getUTCFullYear()
  let m = first.getUTCMonth()
  for (;;) {
    const ms = Date.UTC(y, m, 1)
    const x = Math.round((ms - start.value) / DAY_MS)
    if (x >= span.value) break
    // Year shown on January and on the first label.
    if (x >= 0) out.push({ key: `${y}-${m}`, x, label: m === 0 || !out.length ? `${monthName(m)} ${y}` : monthName(m) })
    if (++m === 12) { m = 0; y++ }
  }
  return out
})

const canPrev = computed(() => selectedIndex.value > 0)
const canNext = computed(() => selectedIndex.value >= 0 && selectedIndex.value < days.value.length - 1)

function dayAt(ev: PointerEvent) {
  const r = track.value!.getBoundingClientRect()
  const x = Math.min(span.value - 1, Math.max(0, Math.floor(((ev.clientX - r.left) / r.width) * span.value)))
  const date = toIso(start.value + x * DAY_MS)
  return { x, date, day: byDate.value.get(date) }
}

/** Nearest date that actually has a mask. */
function nearestAvailable(date: string) {
  if (byDate.value.has(date)) return date
  const t = toMs(date)
  let best = days.value[0]?.date
  for (const d of days.value) if (Math.abs(toMs(d.date) - t) < Math.abs(toMs(best) - t)) best = d.date
  return best
}

let dragging = false
function onPointerDown(ev: PointerEvent) {
  if (!days.value.length) return
  dragging = true
  track.value!.setPointerCapture(ev.pointerId)
  state.playing = false
  selectDate(nearestAvailable(dayAt(ev).date))
  const up = () => { dragging = false; window.removeEventListener('pointerup', up) }
  window.addEventListener('pointerup', up)
}
function onPointerMove(ev: PointerEvent) {
  if (!days.value.length) return
  const h = dayAt(ev)
  hover.value = h
  if (dragging) selectDate(nearestAvailable(h.date))
}

// ── playback: advance once the current mask has finished loading ──
let timer = 0
function togglePlay() {
  if (!state.playing && !canNext.value && days.value.length) selectDate(days.value[0].date)
  state.playing = !state.playing
}
watch(
  () => [state.playing, state.maskLoading, state.selectedDate] as const,
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
  grid-template-columns: auto 1fr auto;
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

.current {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  font-size: 14px;
  white-space: nowrap;
}
.dot {
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
  transform: translateX(-35%);
  border-radius: 3px;
  background: rgba(155, 226, 47, 0.18);
  border: 1px solid var(--accent);
  pointer-events: none;
  box-shadow: 0 0 12px rgba(155, 226, 47, 0.35);
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

@media (max-width: 700px) {
  .timeline {
    padding: 10px 16px 8px;
  }
  .speed {
    display: none;
  }
  .tl-head {
    grid-template-columns: auto 1fr;
  }
  .month span {
    font-size: 10px;
  }
}
</style>
