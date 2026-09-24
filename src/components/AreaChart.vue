<template>
  <section class="chart">
    <header>
      <h2>
        {{ state.mode === 'daily' ? 'Algal bloom area' : 'Mean daily bloom area' }}
        <span class="unit">(km²)</span>
      </h2>
      <div v-if="groupKeys.length > 1" class="group-nav">
        <button :disabled="groupIdx <= 0" :title="`Previous ${groupUnit}`" @click="shiftGroup(-1)">‹</button>
        <span>{{ groupLabel }}</span>
        <button :disabled="groupIdx >= groupKeys.length - 1" :title="`Next ${groupUnit}`" @click="shiftGroup(1)">›</button>
      </div>
      <span v-else class="group-single">{{ groupLabel }}</span>
    </header>

    <p v-if="!state.summary?.hasAreas" class="note">
      Areas are measured as each day is opened. Run the summary script to show every day at once.
    </p>

    <ol ref="list" class="rows" :class="state.mode">
      <li
        v-for="r in rows"
        :key="r.id"
        :class="{ sel: r.id === state.selectedId }"
        :title="r.title"
        @click="selectPeriod(r.id)"
      >
        <span class="d">{{ r.label }}</span>
        <span class="bar-wrap">
          <span class="bar" :style="{ width: `${r.pct}%` }" />
          <span class="v">{{ r.area == null ? '' : formatArea(r.area) }}</span>
        </span>
      </li>
    </ol>

    <footer v-if="stats">
      <div><span class="k">Peak day</span><strong>{{ formatArea(stats.peak.area) }} km²</strong><span class="k">{{ stats.peak.label }}</span></div>
      <div><span class="k">Mean per day</span><strong>{{ formatArea(stats.mean) }} km²</strong><span class="k">{{ groupLabel }}</span></div>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { state, periods, selectPeriod, formatArea, formatDay, formatPeriod, monthName, type Period } from '../state'

const list = ref<HTMLOListElement>()

// Daily rows are grouped by month; weekly and monthly rows by year.
// (ISO week-year for weeks, so 2025-W01 starting 30 Dec 2024 stays with 2025.)
const groupOf = (p: Period) => p.id.slice(0, state.mode === 'daily' ? 7 : 4)
const groupKeys = computed(() => [...new Set(periods.value.map(groupOf))])
const groupUnit = computed(() => (state.mode === 'daily' ? 'month' : 'year'))
const group = ref('')

// Follow the selection into its group (e.g. while playing or after a mode switch).
watch(
  () => [state.selectedId, state.mode] as const,
  async () => {
    const p = periods.value.find((x) => x.id === state.selectedId)
    if (p) group.value = groupOf(p)
    await nextTick()
    list.value?.querySelector('.sel')?.scrollIntoView({ block: 'nearest' })
  },
  { immediate: true },
)

const groupIdx = computed(() => groupKeys.value.indexOf(group.value))
const groupLabel = computed(() => {
  if (!group.value) return ''
  if (state.mode !== 'daily') return group.value
  const [y, m] = group.value.split('-').map(Number)
  return `${monthName(m - 1)} ${y}`
})
function shiftGroup(delta: number) {
  const k = groupKeys.value[groupIdx.value + delta]
  if (k) group.value = k
}

function rowLabel(p: Period) {
  if (state.mode === 'daily') return formatDay(p.id)
  if (state.mode === 'monthly') return monthName(+p.id.slice(5, 7) - 1)
  return `W${p.id.slice(6)} · ${formatDay(p.start)}`
}

const rows = computed(() => {
  const inGroup = periods.value.filter((p) => groupOf(p) === group.value)
  // Scale to the group's max so variation within it stays readable.
  const max = Math.max(0, ...inGroup.map((p) => p.area_km2 ?? 0))
  return inGroup.map((p) => ({
    id: p.id,
    area: p.area_km2,
    label: rowLabel(p),
    title: state.mode === 'daily' ? '' : `${formatPeriod(p, state.mode)} · ${p.days} day${p.days === 1 ? '' : 's'} with data`,
    pct: p.area_km2 && max ? Math.max(1.5, (p.area_km2 / max) * 100) : 0,
  }))
})

const stats = computed(() => {
  if (!state.summary?.hasAreas) return null
  const inGroup = periods.value.filter((p) => groupOf(p) === group.value && p.area_km2 != null)
  if (!inGroup.length) return null
  // Peak single day, and mean daily area weighted by days with data.
  const peak = inGroup.reduce<{ area: number; label: string } | null>((best, p) => {
    if (!p.peak || (best && best.area >= p.peak.area_km2)) return best
    return { area: p.peak.area_km2, label: formatDay(p.peak.date) }
  }, null)!
  const days = inGroup.reduce((s, p) => s + p.days, 0)
  const mean = inGroup.reduce((s, p) => s + p.area_km2! * p.days, 0) / days
  return { peak, mean }
})
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
.group-nav {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  font-weight: 600;
}
.group-nav span {
  min-width: 64px;
  text-align: center;
}
.group-single {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-2);
}
.group-nav button {
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
.group-nav button:disabled {
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
.rows.weekly {
  max-height: 460px;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: var(--line) transparent;
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
.rows.weekly li {
  grid-template-columns: 78px 1fr;
}
.rows.monthly li {
  height: 24px;
  font-size: 12px;
}
.rows.monthly .bar {
  height: 16px;
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
  white-space: nowrap;
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
