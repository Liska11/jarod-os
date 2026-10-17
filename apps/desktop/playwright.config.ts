import { defineConfig } from '@playwright/test'

// End-to-end tests drive the BUILT shell (dist/electron) in Electron with a throwaway profile: run `npm run build` first.
export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  workers: 1,
  reporter: [['list']],
  use: { trace: 'retain-on-failure' }
})
