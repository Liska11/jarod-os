import { expect, test, type Page } from '@playwright/test'
import { type Launched, launchShell } from './launch'

/*
 * V-12 — one registry, on the BUILT app (real shell, real bundled core, throwaway profile): Réglages › Capacités shows, beside the integrations,
 * the shell's control surface (from the C2 matrix) as AVAILABLE — the core really asked the shell's control door (`state`) — and the window's
 * own command registry, read through that door (`ui-list`), plus the Rust host with each crate's real state. The core's `capabilities` tool
 * answers from the same registry. Run `npm run bundle:core && npm run build` first; labels from src/locales/fr.ts.
 */
test.describe.configure({ mode: 'serial' })

let shell: Launched
let page: Page
let wsInfo: { wsUrl?: string; wsToken?: string }

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const ws = new WebSocket(`${wsInfo.wsUrl}?token=${wsInfo.wsToken}`)

  try {
    await new Promise<void>((ok, bad) => {
      ws.addEventListener('open', () => ok())
      ws.addEventListener('error', () => bad(new Error('control line refused')))
    })

    return await new Promise<T>((ok, bad) => {
      ws.addEventListener('message', event => {
        const frame = JSON.parse(String(event.data)) as { id?: number; result?: { result: T }; error?: { message?: string } }

        if (frame.id === 1) {
          frame.error ? bad(new Error(frame.error.message ?? 'error')) : ok(frame.result!.result)
        }
      })
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'jarod.invoke', params: { channel, args } }))
    })
  } finally {
    ws.close()
    await new Promise(resolve => setTimeout(resolve, 300))
  }
}

test.beforeAll(async () => {
  shell = await launchShell()
  page = shell.page
  await expect(page.getByRole('button', { name: 'Accueil' }).first()).toBeVisible({ timeout: 60_000 })

  for (let step = 0; step < 8; step++) {
    const next = page.getByRole('button', { name: /^(Plus tard|Suivant|Commencer)/ })

    if (!(await next.count())) {
      break
    }

    await next.first().click()
    await page.waitForTimeout(800)
  }

  wsInfo = await page.evaluate(() => window.jarodOS.backend.getState())
})

test.afterAll(async () => {
  await shell?.close()
})

test('the core reaches the real control door: the C2 surface is available and the window registry is read', async () => {
  const rows = await invoke<{ id: string; state: string; detail: string; risk: string }[]>('capabilities-list')

  expect(rows.filter(r => r.id.startsWith('shell.'))).toHaveLength(29)
  expect(rows.find(r => r.id === 'shell.state')).toMatchObject({ state: 'available', detail: expect.stringMatching(/ouverte/) })
  // The window's registry, as the renderer declares it: page navigation is one of its commands.
  const window = rows.filter(r => r.id.startsWith('ui.'))

  expect(window.length).toBeGreaterThan(10)
  expect(window.every(r => r.state === 'available')).toBe(true)
  expect(rows.filter(r => r.id.startsWith('rust.'))).toHaveLength(6)
})

test('Réglages › Capacités shows the shell surface, the window registry and the Rust host', async () => {
  await page.getByRole('button', { name: 'Réglages' }).first().click()
  await page.getByRole('button', { name: 'Capacités', exact: true }).first().click()
  await expect(page.getByRole('heading', { name: 'Capacités', level: 2 })).toBeVisible({ timeout: 30_000 })

  await expect(page.getByTestId('capabilities-shell')).toHaveAttribute('data-state', 'available', { timeout: 30_000 })
  await expect(page.getByTestId('capabilities-shell')).toHaveAttribute('data-count', '29')
  await expect(page.getByTestId('capabilities-window')).toHaveAttribute('data-state', 'available')
  expect(Number(await page.getByTestId('capabilities-window').getAttribute('data-count'))).toBeGreaterThan(10)
  await expect(page.getByTestId('capability-rust.host-control')).toHaveAttribute('data-state', 'installed-unconfigured')
  await expect(page.getByRole('heading', { name: 'Shell Jarod-OS' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Hôte Rust' })).toBeVisible()
  await page.getByTestId('capabilities-shell').locator('xpath=ancestor::section[1]').screenshot({ path: test.info().outputPath('registre.png') })
})
