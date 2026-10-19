import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const here = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  root: here,
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@jarod-os/client': fileURLToPath(new URL('../../packages/hermes-client/src/index.ts', import.meta.url))
    },
    // The upstream snapshot lives outside this package; React must resolve to one copy.
    dedupe: ['react', 'react-dom']
  },
  server: {
    fs: {
      allow: [fileURLToPath(new URL('../..', import.meta.url))]
    }
  },
  build: {
    outDir: 'dist/renderer',
    emptyOutDir: true,
    target: 'chrome130',
    sourcemap: true
  }
})
