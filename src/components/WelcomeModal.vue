<template>
  <div class="backdrop" @click.self="$emit('close')">
    <section class="welcome" role="dialog" aria-modal="true" aria-labelledby="welcome-title">
      <button class="close" aria-label="Close" @click="$emit('close')">×</button>

      <h1 id="welcome-title">Welcome to the Floating Algal Bloom Atlas</h1>

      <div class="text">
        <p>
          Algal blooms are rapid, large-scale accumulations of micro- or macroalgae in the upper water
          column. They occur in many kinds of coastal environments and can affect ecosystems, water
          quality, fisheries and tourism. Monitoring floating algae is essential for designing integrated
          strategies for risk management, mitigation and adaptation. This portal provides daily
          monitoring of floating algae based on available Landsat-8/9 and Sentinel-2 observations.
        </p>
        <p>
          <strong>How to use:</strong> Move through time with the timeline, or click a bar to jump to a
          specific day. Switch between daily masks and weekly or monthly composites. Each day's masks
          can be downloaded as GeoJSON.
        </p>
        <p>
          <strong>Note:</strong> These data were produced with deep learning models and have
          limitations. Before drawing conclusions, please read the associated manuscript for a detailed
          discussion of the method's capabilities and limitations.
        </p>
      </div>

      <img
        class="examples"
        src="/landing-examples.webp"
        width="2000"
        height="866"
        alt="Examples of detected floating algae (red) next to the satellite image: cyanobacteria in the Rio de la Plata, Argentina (30 Dec 2024); Ulva in the Yellow Sea, China (23 Jun 2019); Noctiluca scintillans in the Arabian Sea (14 Mar 2019); Aphanizomenon sp. in the Baltic Sea (20 Jul 2019)."
      />

      <div class="logos">
        <img src="/logos/msstate.png" alt="Mississippi State University" />
        <img src="/logos/gcer.png" alt="GCER Lab" />
        <img src="/logos/nasa-ecr.png" alt="NASA Earth Science Division – Early Career Research" />
      </div>

      <button ref="enter" class="enter" @click="$emit('close')">Explore the atlas</button>
    </section>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'

const emit = defineEmits<{ close: [] }>()
const enter = ref<HTMLButtonElement>()

function onKey(ev: KeyboardEvent) {
  if (ev.key === 'Escape') emit('close')
}
onMounted(() => {
  enter.value?.focus()
  window.addEventListener('keydown', onKey)
})
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: grid;
  place-items: center;
  padding: 24px 16px;
  background: rgba(4, 7, 18, 0.72);
  backdrop-filter: blur(4px);
  overflow-y: auto;
}
.welcome {
  position: relative;
  width: min(960px, 100%);
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding: 28px 36px 30px;
  border-radius: 14px;
  border: 1px solid rgba(155, 190, 255, 0.18);
  background: #0b1535;
  box-shadow: 0 30px 80px rgba(0, 0, 0, 0.55);
}
.close {
  position: absolute;
  top: 10px;
  right: 12px;
  width: 32px;
  height: 32px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--text-2);
  font-size: 24px;
  line-height: 1;
  cursor: pointer;
}
.close:hover {
  background: rgba(255, 255, 255, 0.08);
  color: var(--text-1);
}
h1 {
  text-align: center;
  font-size: clamp(22px, 3.2vw, 32px);
  font-weight: 400;
  letter-spacing: 0.01em;
  color: #f4f6fb;
}
.text {
  display: flex;
  flex-direction: column;
  gap: 14px;
  font-size: 15px;
  line-height: 1.6;
  color: #dfe5f2;
  text-align: justify;
  hyphens: auto;
}
.text strong {
  color: #fff;
}
.examples {
  width: 100%;
  height: auto;
  border-radius: 6px;
}
.logos {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: clamp(20px, 6vw, 56px);
}
.logos img {
  height: clamp(56px, 10vw, 96px);
  max-width: 30%;
  object-fit: contain;
}
.enter {
  align-self: center;
  border: 0;
  border-radius: 999px;
  padding: 11px 28px;
  background: var(--accent);
  color: #0d1a05;
  font: inherit;
  font-size: 15px;
  font-weight: 700;
  cursor: pointer;
  box-shadow: 0 0 24px rgba(155, 226, 47, 0.35);
}
.enter:hover {
  filter: brightness(1.08);
}

@media (max-width: 600px) {
  .welcome {
    padding: 22px 18px 24px;
  }
  .text {
    font-size: 14px;
    text-align: left;
  }
}
</style>
