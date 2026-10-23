import { expect, test, type Page } from '@playwright/test'
import { type Launched, launchShell } from './launch'

/*
 * V-09 — the access profile on the BUILT app (real shell, real bundled core, throwaway profile): Réglages › Agent et sécurité offers the four
 * presets; « Plein » goes through the engine's NATIVE confirmation, which names the hard limits, and is stored; going back to « Demander » asks
 * nothing (it only tightens); the global « sans demander » switch is greyed out outside « Personnalisé ». What each profile does to tool calls is
 * proven on the real loop (plugins/agent/test/access-profile.engine.test.ts). The native box is answered by a stub that records it.
 * Run `npm run bundle:core && npm run build` first; labels from src/locales/fr.ts.
 */
test.describe.configure({ mode: 'serial' })

let shell: Launched
let page: Page
let wsInfo: { wsUrl?: string; wsToken?: string }

async function settings(): Promise<{ accessProfile?: string }> {
  const ws = new WebSocket(`${wsInfo.wsUrl}?token=${wsInfo.wsToken}`)

  try {
    await new Promise<void>((ok, bad) => {
      ws.addEventListener('open', () => ok())
      ws.addEventListener('error', () => bad(new Error('control line refused')))
    })

    return await new Promise((ok, bad) => {
      ws.addEventListener('message', event => {
        const frame = JSON.parse(String(event.data)) as { id?: number; result?: { result: { accessProfile?: string } }; error?: { message?: string } }

        if (frame.id === 1) {
          frame.error ? bad(new Error(frame.error.message ?? 'error')) : ok(frame.result!.result)
        }
      })
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'jarod.invoke', params: { channel: 'get-jarod-settings', args: [] } }))
    })
  } finally {
    ws.close()
    await new Promise(resolve => setTimeout(resolve, 300))
  }
}

const dialogs = () => shell.app.evaluate(() => (globalThis as unknown as { __dialogs: { message: string; detail: string }[] }).__dialogs)

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

  await shell.app.evaluate(({ dialog }) => {
    const g = globalThis as unknown as { __dialogs: { message: string; detail: string }[] }

    g.__dialogs = []
    dialog.showMessageBox = (async (...args: unknown[]) => {
      const options = args.at(-1) as { message: string; detail?: string }

      g.__dialogs.push({ message: options.message, detail: options.detail ?? '' })

      return { response: 0, checkboxChecked: false }
    }) as never
  })
  wsInfo = await page.evaluate(() => window.jarodOS.backend.getState())
})

test.afterAll(async () => {
  await shell?.close()
})

test('the four presets, « Personnalisé » by default; « Plein » is confirmed natively, names the hard limits, and is stored', async () => {
  await page.getByRole('button', { name: 'Réglages' }).first().click()
  await page.getByRole('button', { name: 'Agent et sécurité', exact: true }).first().click()

  const profiles = page.getByTestId('access-profiles')

  await expect(profiles).toBeVisible({ timeout: 30_000 })
  for (const label of ['Demander', 'M’approuver', 'Plein', 'Personnalisé']) {
    await expect(profiles.getByRole('button', { name: new RegExp(`^${label}`) })).toBeVisible()
  }
  expect((await settings()).accessProfile).toBe('custom')
  await expect(page.getByText('Utiliser les outils sans demander')).toBeVisible()

  await profiles.getByRole('button', { name: /^Plein/ }).click()
  await expect.poll(async () => (await settings()).accessProfile, { timeout: 15_000 }).toBe('full')
  const box = (await dialogs()).at(-1)!

  expect(box.message).toMatch(/« Plein »/)
  expect(box.detail).toMatch(/limites dures.*run_shell/)
  await profiles.screenshot({ path: test.info().outputPath('profils-acces.png') })
  // Outside « Personnalisé » the global switch no longer decides: greyed out, and it says so.
  await expect(page.getByText('Ne compte qu’avec le profil d’accès Personnalisé')).toBeVisible()
})

test('going back to « Demander » only tightens: stored without any confirmation', async () => {
  const before = (await dialogs()).length

  await page.getByTestId('access-profiles').getByRole('button', { name: /^Demander/ }).click()
  await expect.poll(async () => (await settings()).accessProfile, { timeout: 15_000 }).toBe('ask')
  expect((await dialogs()).length).toBe(before)
})
