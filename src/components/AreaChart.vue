<template>
  <section class="chart">
    <header>
      <h2>Algal bloom area <span class="unit">(km²)</span></h2>
      <div class="month-nav">
        <button :disabled="monthIdx <= 0" title="Previous month" @click="shiftMonth(-1)">‹</button>
        <span>{{ monthLabel }}</span>
        <button :disabled="monthIdx >= monthKeys.length - 1" title="Next month" @click="shiftMonth(1)">›</button>
      </div>
    </header>

    <p v-if="!state.summary?.hasAreas" class="note">
      Areas are measured as each day is opened. Run the summary script to show every day at once.
    </p>

    <ol class="rows">
      <li
        v-for="r in rows"
        :key="r.date"
        :class="{ sel: r.date === state.selectedDate }"
        @click="selectDate(r.date)"
      >
        <span class="d">{{ r.label }}</span>
        <span class="bar-wrap">
          <span class="bar" :style="{ width: `${r.pct}%` }" />
          <span class="v">{{ r.area == null ? '' : formatArea(r.area) }}</span>
        </span>
      </li>
    </ol>

    <footer v-if="monthTotal != null">
      <div><span class="k">Peak</span><strong>{{ formatArea(monthPeak?.area) }} km²</strong><span class="k">{{ monthPeak ? monthPeak.label : '' }}</span></div>
      <div><span class="k">Daily mean</span><strong>{{ formatArea(monthMean) }} km²</strong></div>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { state, days, selectDate, formatArea, monthName } from '../state'

const monthKeys = computed(() => [...new Set(days.value.map((d) => d.date.slice(0, 7)))])
const month = ref('')

// Follow the selected date into its month (e.g. while playing).
watch(
  () => state.selectedDate,
  (d) => { if (d) month.value = d.slice(0, 7) },
  { immediate: true },
)

const monthIdx = computed(() => monthKeys.value.indexOf(month.value))
const monthLabel = computed(() => {
  if (!month.value) return ''
  const [y, m] = month.value.split('-').map(Number)
  return `${monthName(m - 1)} ${y}`
})
function shiftMonth(delta: number) {
  const k = monthKeys.value[monthIdx.value + delta]
  if (k) month.value = k
}

const rows = computed(() => {
  const list = days.value
    .filter((d) => d.date.startsWith(month.value))
    .map((d) => {
      const live = d.area_km2 == null && state.liveStats?.date === d.date ? state.liveStats.area_km2 : null
      return { date: d.date, area: d.area_km2 ?? live, label: `${monthName(+d.date.slice(5, 7) - 1)} ${+d.date.slice(8, 10)}` }
    })
  // Scale to the month's max so within-month variation stays readable.
  const max = Math.max(0, ...list.map((r) => r.area ?? 0))
  return list.map((r) => ({ ...r, pct: r.area && max ? Math.max(1.5, (r.area / max) * 100) : 0 }))
})

const known = computed(() => rows.value.filter((r) => r.area != null) as { area: number; label: string }[])
const monthTotal = computed(() => (state.summary?.hasAreas && known.value.length ? known.value.reduce((s, r) => s + r.area, 0) : null))
const monthMean = computed(() => (monthTotal.value != null ? monthTotal.value / known.value.length : null))
const monthPeak = computed(() => known.value.reduce<(typeof known.value)[number] | null>((a, r) => (!a || r.area > a.area ? r : a), null))
</script>

<style scoped>
.chart {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
h2 {
  font-size: 15px;
  font-weight: 600;
}
.unit {
  color: var(--text-3);
  font-weight: 500;
}
.month-nav {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  font-weight: 600;
}
.month-nav span {
  min-width: 64px;
  text-align: center;
}
.month-nav button {
  width: 24px;
  height: 24px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--panel-2);
  color: var(--text-1);
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
}
.month-nav button:disabled {
  opacity: 0.35;
  cursor: default;
}
.note {
  font-size: 11.5px;
  color: var(--text-3);
  line-height: 1.4;
}

.rows {
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.rows li {
  display: grid;
  grid-template-columns: 50px 1fr;
  align-items: center;
  gap: 8px;
  height: 17px;
  padding: 0 4px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 11px;
}
.rows li:hover {
  background: var(--panel-2);
}
.rows li.sel {
  background: rgba(155, 226, 47, 0.12);
}
.d {
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}
.sel .d {
  color: var(--text-1);
  font-weight: 600;
}
.bar-wrap {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  border-left: 1px solid var(--line);
  height: 100%;
}
.bar {
  height: 11px;
  border-radius: 0 3px 3px 0;
  background: var(--accent-dim);
  transition: width 0.25s;
  max-width: calc(100% - 44px);
}
.sel .bar {
  background: var(--accent);
}
.v {
  color: var(--text-2);
  font-variant-numeric: tabular-nums;
}

footer {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
footer div {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--panel-2);
}
.k {
  font-size: 11px;
  color: var(--text-3);
}
footer strong {
  font-size: 14px;
}
</style>
