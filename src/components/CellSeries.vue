<template>
  <div class="cell-series">
    <header>
      <strong>4 km cell</strong>
      <span class="coords">{{ center }}</span>
    </header>

    <p v-if="!series" class="empty">This location is outside the 4 km analysis grid.</p>
    <template v-else>
      <div class="readout">
        <template v-if="hover != null">
          <span>{{ formatDate(series.dates[hover]) }}</span>
          <strong :class="{ muted: series.values[hover] == null }">{{ valueLabel(series.values[hover]) }}</strong>
        </template>
        <template v-else>
          <span>Algal bloom area per day</span>
          <strong>max {{ formatArea(stats.max) }} km²</strong>
        </template>
      </div>

      <svg
        :viewBox="`0 0 ${W} ${H}`"
        class="chart"
        role="img"
        :aria-label="`Daily algal bloom area in this cell, ${stats.algalDays} days with algal blooms out of ${stats.observed} observed`"
        @mousemove="onMove"
        @mouseleave="hover = null"
        @click="onClick"
      >
        <line :x1="PAD_L" :x2="W - PAD_R" :y1="baseY" :y2="baseY" class="axis" />
        <text :x="PAD_L - 4" :y="PAD_T + 4" class="ylab" text-anchor="end">{{ formatArea(yMax) }}</text>
        <text :x="PAD_L - 4" :y="baseY" class="ylab" text-anchor="end">0</text>
        <g v-for="m in monthTicks" :key="m.x">
          <line :x1="m.x" :x2="m.x" :y1="baseY" :y2="baseY + 3" class="axis" />
          <text :x="m.x + 1" :y="H - 2" class="xlab">{{ m.label }}</text>
        </g>
        <!-- observed without algae: tick on the baseline; not observed: nothing -->
        <rect
          v-for="d in zeroDays"
          :key="`z${d}`"
          :x="xOf(d)"
          :y="baseY - 1.5"
          :width="barW"
          height="1.5"
          class="zero"
        />
        <rect
          v-for="d in algalDays"
          :key="`a${d}`"
          :x="xOf(d)"
          :y="yOf(series.values[d]!)"
          :width="barW"
          :height="baseY - yOf(series.values[d]!)"
          class="bar"
        />
        <line v-if="selIdx >= 0" :x1="xOf(selIdx) + barW / 2" :x2="xOf(selIdx) + barW / 2" :y1="PAD_T" :y2="baseY" class="sel" />
        <line v-if="hover != null" :x1="xOf(hover) + barW / 2" :x2="xOf(hover) + barW / 2" :y1="PAD_T" :y2="baseY" class="hover" />
      </svg>

      <ul class="stats">
        <li><strong>{{ stats.observed }}</strong> days observed</li>
        <li><strong>{{ stats.algalDays }}</strong> with algal blooms</li>
        <li><strong>{{ formatArea(stats.mean) }}</strong> km² mean when present</li>
      </ul>
      <p class="hint">
        <span class="key bar-key" /> algal bloom <span class="key zero-key" /> observed, none · gaps: not observed.
        Cell ≈ {{ series.cell.km2.toFixed(1) }} km². Click the chart to open that day.
      </p>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import type { CellSeries } from '../cells'
import { formatArea, formatDate, monthName } from '../state'

const props = defineProps<{
  series: CellSeries | null
  center: string
  selectedDate: string
}>()
const emit = defineEmits<{ pick: [date: string] }>()

const W = 300
const H = 118
const PAD_L = 30
const PAD_R = 6
const PAD_T = 6
const baseY = H - 16

const hover = ref<number | null>(null)
const n = computed(() => props.series?.dates.length ?? 1)
const barW = computed(() => Math.max(0.6, (W - PAD_L - PAD_R) / n.value - 0.2))
const xOf = (d: number) => PAD_L + (d / n.value) * (W - PAD_L - PAD_R)

const algalDays = computed(() => (props.series?.values ?? []).flatMap((v, d) => (v != null && v > 0 ? [d] : [])))
const zeroDays = computed(() => (props.series?.values ?? []).flatMap((v, d) => (v === 0 ? [d] : [])))

const stats = computed(() => {
  const vals = props.series?.values ?? []
  const pos = vals.filter((v): v is number => v != null && v > 0)
  return {
    observed: vals.filter((v) => v != null).length,
    algalDays: pos.length,
    max: pos.length ? Math.max(...pos) : 0,
    mean: pos.length ? pos.reduce((a, b) => a + b, 0) / pos.length : null,
  }
})
const yMax = computed(() => stats.value.max || 1)
const yOf = (v: number) => baseY - Math.max(1, (v / yMax.value) * (baseY - PAD_T))

const selIdx = computed(() => props.series?.dates.indexOf(props.selectedDate) ?? -1)

const monthTicks = computed(() => {
  const dates = props.series?.dates ?? []
  return dates.flatMap((d, i) => (d.endsWith('-01') ? [{ x: xOf(i), label: monthName(+d.slice(5, 7) - 1)[0] }] : []))
})

function valueLabel(v: number | null) {
  if (v == null) return 'not observed'
  if (v === 0) return 'no algal bloom'
  return `${formatArea(v)} km²`
}

function dayAt(ev: MouseEvent) {
  const svg = ev.currentTarget as SVGSVGElement
  const r = svg.getBoundingClientRect()
  const x = ((ev.clientX - r.left) / r.width) * W
  const d = Math.floor(((x - PAD_L) / (W - PAD_L - PAD_R)) * n.value)
  return d >= 0 && d < n.value ? d : null
}
function onMove(ev: MouseEvent) {
  hover.value = dayAt(ev)
}
function onClick(ev: MouseEvent) {
  const d = dayAt(ev)
  if (d != null && props.series) emit('pick', props.series.dates[d])
}
</script>

<style scoped>
.cell-series {
  width: 300px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  color: var(--text-1);
  font-family: 'Inter', system-ui, sans-serif;
  font-size: 12px;
}
header {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding-right: 18px;
}
header strong {
  font-size: 13px;
}
.coords {
  color: var(--text-3);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.empty {
  color: var(--text-2);
}
.readout {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  color: var(--text-2);
  font-size: 11.5px;
}
.readout strong {
  color: var(--accent);
  font-variant-numeric: tabular-nums;
}
.readout strong.muted {
  color: var(--text-3);
}
.chart {
  width: 100%;
  height: auto;
  cursor: crosshair;
  display: block;
}
.axis {
  stroke: var(--line);
  stroke-width: 1;
}
.ylab,
.xlab {
  fill: var(--text-3);
  font-size: 8.5px;
  font-variant-numeric: tabular-nums;
}
.bar {
  fill: var(--accent);
}
.zero {
  fill: #6f7f9e;
}
.sel {
  stroke: #fff;
  stroke-width: 1;
  stroke-dasharray: 2 2;
  opacity: 0.8;
}
.hover {
  stroke: var(--text-2);
  stroke-width: 1;
}
.stats {
  list-style: none;
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  color: var(--text-3);
  font-size: 11px;
}
.stats strong {
  color: var(--text-1);
}
.hint {
  color: var(--text-3);
  font-size: 10.5px;
  line-height: 1.5;
}
.key {
  display: inline-block;
  width: 8px;
  height: 8px;
  margin: 0 2px 0 0;
  vertical-align: -1px;
}
.bar-key {
  background: var(--accent);
}
.zero-key {
  height: 2px;
  vertical-align: 1px;
  background: #6f7f9e;
}
</style>
