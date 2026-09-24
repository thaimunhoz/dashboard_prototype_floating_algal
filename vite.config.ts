import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { cloudflare } from '@cloudflare/vite-plugin'

// `--mode vercel` builds a plain static site that reads the public bucket
// (VITE_DATA_URL in .env.vercel); other modes bundle the Cloudflare Worker.
export default defineConfig(({ mode }) => ({
  base: '/',
  plugins: mode === 'vercel' ? [vue()] : [vue(), cloudflare()],
  // MapLibre 6 runs its tile worker as an ES module (see src/components/MapView.vue).
  worker: { format: 'es' },
}))
