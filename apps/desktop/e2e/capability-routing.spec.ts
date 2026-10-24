import { expect, test, type Page } from '@playwright/test'
import { type Launched, launchShell } from './launch'

/*
 * V-19 — model per task on the BUILT app (real shell, real bundled core, throwaway profile): Réglages › Agent et sécurité › Modèle par
 * tâche. A local provider set as the "Code" route is written to the core with no question (nothing leaves the machine); removing it
 * clears the route. The turn-level routing itself is proven in plugin-agent (capability-routing.engine.test.ts).
 * Run `npm run bundle:core && npm run build` first; labels from src/locales/fr.ts.
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

const routes = async () => (await invoke<{ capabilityRouting?: Record<string, { provider: string; model: string }> }>('get-jarod-settings')).capabilityRouting

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

test('Modèle par tâche: a local provider for « Code » is saved without a question, then removed', async () => {
  const options = await invoke<{ providers: { id: string; name: string; local: boolean; configured: boolean }[] }>('get-jarod-options')
  const local = options.providers.find(p => p.local && p.configured)

  expect(local, 'a local provider is configured on a fresh profile').toBeTruthy()
  expect(await routes()).toEqual({})

  await page.getByRole('button', { name: 'Réglages' }).first().click()
  await page.getByRole('button', { name: 'Agent et sécurité', exact: true }).first().click()

  const row = page.getByTestId('capability-code')

  await expect(row).toBeVisible({ timeout: 30_000 })
  await row.getByRole('combobox', { name: 'Code', exact: true }).selectOption(local!.id)
  await row.getByRole('combobox', { name: 'Code · Modèle' }).fill('qwen2.5-coder')
  await row.getByRole('button', { name: 'Enregistrer' }).click()

  await expect.poll(routes, { timeout: 15_000 }).toEqual({ code: { provider: local!.id, model: 'qwen2.5-coder' } })
  await expect(row).toHaveAttribute('data-route', `${local!.id}:qwen2.5-coder`)
  await page.getByTestId('capability-vision').locator('xpath=..').screenshot({ path: test.info().outputPath('modele-par-tache.png') })

  await row.getByRole('combobox', { name: 'Code', exact: true }).selectOption('')
  await row.getByRole('button', { name: 'Retirer' }).click()
  await expect.poll(routes, { timeout: 15_000 }).toEqual({})
})
