import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { nodePolyfills } from 'vite-plugin-node-polyfills'
import path from 'path'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    svelte(),
    nodePolyfills({ include: ['buffer', 'crypto', 'stream', 'process'] })
  ],
  base: '',
  server: {
    host: true
  },
  publicDir: 'public',
  resolve: {
    alias: {
      '$lib': path.resolve('./src/lib'),
      './libsodium-sumo.mjs': path.resolve('./node_modules/libsodium-sumo/dist/modules-sumo-esm/libsodium-sumo.mjs')
    }
  },
  optimizeDeps: {
    exclude: ['libsodium-wrappers-sumo'],
    esbuildOptions: {
      define: { global: 'globalThis' }
    }
  },
  build: {
    commonjsOptions: {
      transformMixedEsModules: true
    }
  }
})
