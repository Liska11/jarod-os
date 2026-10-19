import { expect, test } from '@playwright/test'
import { type Launched, launchShell } from './launch'

// Jarod-OS rename, phase 3 (docs/RENAME-PLAN-JAROD-OS.md): widgets are served from jarod-plugin://, and the older herald-plugin://
// is still registered and answered by the same handler, so a widget written before the rename keeps loading its SDK. Checked in the
// real app: the main process fetches the SDK under both schemes through the protocol handlers Electron registered at start.
let shell: Launched

test.beforeAll(async () => {
  shell = await launchShell()
  await expect(shell.page.locator('body')).toBeVisible({ timeout: 60_000 })
})

test.afterAll(async () => {
  await shell?.close()
})

test('the widget SDK answers under jarod-plugin:// and under the older herald-plugin://, with the same script', async () => {
  const fetched = await shell.app.evaluate(async ({ net }) => {
    const read = async (url: string) => {
      const response = await net.fetch(url)

      return { status: response.status, type: response.headers.get('content-type'), body: await response.text() }
    }

    return { current: await read('jarod-plugin://sdk/widget.js'), legacy: await read('herald-plugin://sdk/widget.js') }
  })

  expect(fetched.current.status).toBe(200)
  expect(fetched.current.type).toContain('text/javascript')
  expect(fetched.current.body.length).toBeGreaterThan(100)
  expect(fetched.legacy).toEqual(fetched.current)
})

test('a plugin that is not enabled is refused under both schemes', async () => {
  const statuses = await shell.app.evaluate(async ({ net }) => {
    const status = async (url: string) => (await net.fetch(url)).status

    return [await status('jarod-plugin://not-installed/index.html'), await status('herald-plugin://not-installed/index.html')]
  })

  expect(statuses).toEqual([403, 403])
})
