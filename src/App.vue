<template>
  <div class="app" :class="{ collapsed: !state.panelOpen }">
    <header class="brand">
      <h1>
        <span class="l1">Floating</span>
        <span class="l2">Algal</span>
        <span class="l3">Atlas</span>
      </h1>
      <button class="about-btn" title="About this atlas" aria-label="About this atlas" @click="showWelcome = true">
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <circle cx="12" cy="12" r="9.5" fill="none" stroke="currentColor" stroke-width="1.8" />
          <path d="M12 11v6M12 7.5v.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
        </svg>
      </button>
    </header>

    <TimelineBar class="top" />

    <aside class="panel">
      <SearchBox />

      <div class="panel-body">
        <p v-if="state.summaryError" class="error">{{ state.summaryError }}</p>

        <AreaChart />

        <div class="logos">
          <img src="/logos/nasa-ecr.png" alt="NASA Earth Science Division – Early Career Research" />
          <img src="/logos/gcer.png" alt="GCER Lab" />
          <img src="/logos/msstate.png" alt="Mississippi State University" />
        </div>
      </div>
    </aside>

    <main class="map-area">
      <MapView />
      <button
        class="collapse"
        :title="state.panelOpen ? 'Hide panel' : 'Show panel'"
        :aria-expanded="state.panelOpen"
        @click="state.panelOpen = !state.panelOpen"
      >
        {{ state.panelOpen ? '‹' : '›' }}
      </button>
    </main>

    <WelcomeModal v-if="showWelcome" @close="closeWelcome" />
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import TimelineBar from './components/TimelineBar.vue'
import SearchBox from './components/SearchBox.vue'
import AreaChart from './components/AreaChart.vue'
import MapView from './components/MapView.vue'
import WelcomeModal from './components/WelcomeModal.vue'
import { state, loadSummary, step } from './state'

// Welcome page: shown on every page load, reopened from the (i) button.
const showWelcome = ref(true)
function closeWelcome() {
  showWelcome.value = false
}

onMounted(() => {
  loadSummary()
  window.addEventListener('keydown', onKey)
})
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

function onKey(ev: KeyboardEvent) {
  const t = ev.target as HTMLElement
  if (showWelcome.value || t.closest('input, select, textarea')) return
  if (ev.key === 'ArrowLeft') { state.playing = false; step(-1) }
  else if (ev.key === 'ArrowRight') { state.playing = false; step(1) }
  else if (ev.key === ' ' && !t.closest('button')) { ev.preventDefault(); state.playing = !state.playing }
}
</script>

<style scoped>
.app {
  --panel-w: 340px;
  display: grid;
  grid-template-columns: var(--panel-w) 1fr;
  grid-template-rows: auto 1fr;
  grid-template-areas:
    'brand top'
    'panel map';
  height: 100vh;
  height: 100dvh;
  transition: grid-template-columns 0.25s ease;
}
.app.collapsed {
  grid-template-columns: 0 1fr;
}

.brand {
  grid-area: brand;
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 14px 20px;
  background: linear-gradient(135deg, var(--brand) 0%, var(--brand-2) 100%);
  overflow: hidden;
  min-width: 0;
}
.collapsed .brand {
  padding: 0;
}
h1 {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  line-height: 0.95;
  text-transform: uppercase;
  letter-spacing: 0.01em;
}
.l1,
.l3 {
  font-size: 32px;
  font-weight: 800;
  color: #f4f8ec;
}
.l2 {
  font-size: 32px;
  font-weight: 500;
  color: #10220a;
}
.about-btn {
  position: absolute;
  top: 8px;
  right: 8px;
  width: 30px;
  height: 30px;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: rgba(16, 34, 10, 0.7);
  cursor: pointer;
}
.about-btn:hover {
  background: rgba(255, 255, 255, 0.2);
  color: #10220a;
}
.collapsed .about-btn {
  display: none;
}

.top {
  grid-area: top;
}

.panel {
  grid-area: panel;
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
  overflow: hidden;
  background: var(--panel);
  border-right: 1px solid var(--line);
}
.panel-body {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 18px;
  scrollbar-width: thin;
  scrollbar-color: var(--line) transparent;
}
.panel-body > * {
  /* the body scrolls; its sections keep their natural height */
  flex-shrink: 0;
}
.error {
  padding: 10px 12px;
  border-radius: 8px;
  background: rgba(255, 90, 90, 0.12);
  border: 1px solid rgba(255, 90, 90, 0.35);
  color: #ffb4b4;
  font-size: 12.5px;
}

.logos {
  display: flex;
  align-items: center;
  justify-content: space-around;
  gap: 12px;
  padding-top: 4px;
}
.logos img {
  height: 64px;
  max-width: 30%;
  object-fit: contain;
}

.map-area {
  grid-area: map;
  position: relative;
  min-height: 0;
  min-width: 0;
}
.collapse {
  position: absolute;
  top: 50%;
  left: 0;
  transform: translateY(-50%);
  width: 18px;
  height: 56px;
  border: 1px solid var(--line);
  border-left: 0;
  border-radius: 0 8px 8px 0;
  background: var(--panel);
  color: var(--text-2);
  font-size: 16px;
  cursor: pointer;
  z-index: 3;
}
.collapse:hover {
  color: var(--accent);
}

@media (max-width: 800px) {
  .app,
  .app.collapsed {
    grid-template-columns: 1fr;
    grid-template-rows: auto auto 65vh auto;
    grid-template-areas:
      'brand'
      'top'
      'map'
      'panel';
    height: auto;
  }
  .brand {
    padding: 12px 16px;
  }
  h1 {
    flex-direction: row;
    gap: 8px;
  }
  .l1,
  .l2,
  .l3 {
    font-size: 22px;
  }
  .panel {
    border-right: 0;
  }
  .panel-body {
    overflow: visible;
  }
  .collapse {
    display: none;
  }
}
</style>
