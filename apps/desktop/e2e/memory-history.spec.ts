import { expect, test, type Page } from '@playwright/test'
import { type Launched, launchShell } from './launch'

/*
 * V-18 — memory history on the BUILT app (real shell, real bundled core, throwaway profile): a memory added then edited by the core
 * shows both changes in Mémoire › Historique, word by word; "Rétablir" on the edit brings the old text back, in the core and on the page,
 * and the undo itself appears as a new change. Clearing the history goes through a native confirmation (covered by the bridge tests).
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
  expect(await invoke('add-memory-entry', 'Le dépôt est sur C: depuis hier')).toMatchObject({ success: true })
  expect(await invoke('update-memory-entry', 0, 'Le dépôt est sur D: depuis hier')).toMatchObject({ success: true })
})

test.afterAll(async () => {
  await shell?.close()
})

test('Mémoire › Historique: both changes, word by word; Rétablir undoes the edit in the core and on the page', async () => {
  await page.getByRole('button', { name: 'Mémoire' }).first().click()
  await page.getByRole('button', { name: 'Historique' }).click()

  const panel = page.getByTestId('memory-history')
  const changes = panel.locator('li')

  await expect(changes).toHaveCount(2, { timeout: 30_000 })
  await expect(changes.nth(0)).toHaveAttribute('data-action', 'update')
  await expect(changes.nth(0).locator('del')).toHaveText('C:')
  await expect(changes.nth(0).locator('ins')).toHaveText('D:')
  await expect(changes.nth(1)).toHaveAttribute('data-action', 'add')
  await panel.screenshot({ path: test.info().outputPath('historique-memoire.png') })

  await changes.nth(0).getByRole('button', { name: 'Défaire ce changement' }).click()
  await expect(changes).toHaveCount(3, { timeout: 30_000 })
  await expect(changes.nth(0).locator('ins')).toHaveText('C:')

  const read = await invoke<{ memory: { entries: { content: string }[] } }>('read-memory')

  expect(read.memory.entries.map(e => e.content)).toEqual(['Le dépôt est sur C: depuis hier'])

  await page.getByRole('button', { name: 'Retour aux souvenirs' }).click()
  await expect(page.getByText('Le dépôt est sur C: depuis hier').first()).toBeVisible({ timeout: 30_000 })
})
