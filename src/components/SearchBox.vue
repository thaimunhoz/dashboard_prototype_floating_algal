<template>
  <form class="search" role="search" @submit.prevent="search">
    <input v-model="q" type="search" placeholder="Find address, place or lat, lon" aria-label="Find a place" />
    <button type="submit" :disabled="busy" aria-label="Search">
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
        <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2" />
        <path d="M20 20l-4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
      </svg>
    </button>
    <p v-if="msg" class="msg">{{ msg }}</p>
  </form>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { state } from '../state'

const q = ref('')
const busy = ref(false)
const msg = ref('')

async function search() {
  const text = q.value.trim()
  msg.value = ''
  if (!text) return

  // "lat, lon" shortcut
  const ll = text.match(/^\s*(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)\s*$/)
  if (ll) {
    state.flyTo = { center: [Number(ll[2]), Number(ll[1])] }
    return
  }

  busy.value = true
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(text)}`
    const res = await fetch(url, { headers: { 'Accept-Language': 'en' } })
    const [hit] = (await res.json()) as { boundingbox: string[]; lon: string; lat: string }[]
    if (!hit) {
      msg.value = 'No place found.'
      return
    }
    const [s, n, w, e] = hit.boundingbox.map(Number)
    state.flyTo = { bbox: [w, s, e, n] }
  } catch {
    msg.value = 'Search is unavailable right now.'
  } finally {
    busy.value = false
  }
}
</script>

<style scoped>
.search {
  position: relative;
  display: flex;
  flex-wrap: wrap;
  border-bottom: 1px solid var(--line);
}
input {
  flex: 1;
  min-width: 0;
  height: 44px;
  padding: 0 16px;
  border: 0;
  background: transparent;
  color: var(--text-1);
  font: inherit;
  font-size: 13px;
  outline: none;
}
input::placeholder {
  color: var(--text-3);
}
button {
  width: 44px;
  border: 0;
  background: transparent;
  color: var(--text-2);
  cursor: pointer;
}
button:hover {
  color: var(--accent);
}
.msg {
  width: 100%;
  padding: 0 16px 8px;
  font-size: 12px;
  color: var(--text-3);
}
</style>
