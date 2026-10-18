import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// The protocol is the core's own file, imported as is: both ends run the same bytes.
const protocol = fileURLToPath(new URL('../jarod-core/packages/plugins/gateways/src/remote-protocol.ts', import.meta.url))

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@jarod-protocol': protocol } },
  // Relative paths: Capacitor serves the build from the app's own files.
  base: './',
  build: { outDir: 'dist', target: 'es2023', sourcemap: false },
  server: {
    fs: { allow: ['..'] },
    // Development in a desktop browser: `JAROD_BRIDGE=http://127.0.0.1:10492 npm run dev` forwards /m1
    // to a local Jarod, so the page and the bridge share an origin.
    proxy: process.env.JAROD_BRIDGE ? { '/m1': { target: process.env.JAROD_BRIDGE, changeOrigin: false } } : undefined
  },
  test: { environment: 'node', include: ['src/**/*.test.ts'] }
})
