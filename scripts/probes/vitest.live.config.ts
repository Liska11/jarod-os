// Bancs contre des runtimes réels (Hermes, DSH) : hors de la suite par défaut et des deux typages du bureau, lancés à la main
// depuis la racine du dépôt :
//   npx vitest run --config scripts/probes/vitest.live.config.ts [hermes|dsh]
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('../../apps/desktop/src', import.meta.url)),
      '@jarod-os/client': fileURLToPath(new URL('../../packages/hermes-client/src/index.ts', import.meta.url))
    }
  },
  test: {
    include: ['*.probe.ts'],
    environment: 'node',
    testTimeout: 300_000,
    fileParallelism: false
  }
})
