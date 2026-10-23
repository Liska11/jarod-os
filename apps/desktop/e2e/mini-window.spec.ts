import { expect, test, type Page } from '@playwright/test'
import path from 'node:path'
import { type Launched, launchShell } from './launch'

// Lot C (2026-10-21) : la mini-fenêtre dans l'application réelle, profil jetable. Allumée par la préférence, elle s'ouvre sur SA page
// (mini.html), sans l'API du shell ; elle affiche le résumé que la fenêtre principale envoie ; un clic ramène la fenêtre principale ; éteinte,
// elle disparaît.
test.describe.configure({ mode: 'serial' })

let shell: Launched
let page: Page

test.beforeAll(async () => {
  shell = await launchShell()
  page = shell.page
  await expect(page.getByRole('button', { name: 'Accueil' }).first()).toBeVisible({ timeout: 60_000 })

  for (let step = 0; step < 8; step++) {
    const next = page.getByRole('button', { name: /^(Plus tard|Suivant|Commencer)/ })

    if (!(await next.count())) break
    await next.first().click()
    await page.waitForTimeout(800)
  }
})

test.afterAll(async () => {
  await shell?.close()
})

const miniPage = () => shell.app.windows().find(w => w.url().endsWith('/mini.html'))

test('allumée : sa page à part, sans API du shell ; elle affiche l’état ; un clic ramène Jarod ; éteinte, elle disparaît', async () => {
  expect(miniPage()).toBeUndefined()
  await page.evaluate(() => window.jarodOS.prefs.set({ miniWindow: true }))
  await expect.poll(() => Boolean(miniPage()), { timeout: 15_000 }).toBe(true)
  const mini = miniPage()!

  await expect(mini.locator('#line2')).toHaveText(/Au repos|répond|travaille|en cours/, { timeout: 15_000 })
  // Ni l'API du shell, ni Node : seulement de quoi recevoir le résumé.
  expect(await mini.evaluate(() => ({ shell: typeof (window as unknown as { jarodOS?: unknown }).jarodOS, node: typeof (globalThis as unknown as { require?: unknown }).require, mini: Object.keys((window as unknown as { jarodMini: object }).jarodMini) }))).toEqual({
    shell: 'undefined',
    node: 'undefined',
    mini: ['onSummary']
  })
  await mini.screenshot({ path: path.join(test.info().outputDir, 'mini-fenetre.png') })

  // Un résumé avec une demande en attente, envoyé comme la fenêtre principale le fait : la mini-fenêtre passe à « Accord demandé ».
  await page.evaluate(() => window.jarodOS.mini.state({ working: [], workingCount: 0, waiting: [{ kind: 'approval', text: 'Déplacer 3 fichiers' }], waitingCount: 1, agents: 0 }))
  await expect(mini.locator('#line1')).toHaveText('Accord demandé')
  await expect(mini.locator('#line2')).toHaveText('Déplacer 3 fichiers')
  await mini.screenshot({ path: path.join(test.info().outputDir, 'mini-fenetre-accord.png') })

  await mini.locator('#pill').click()
  await expect.poll(() => shell.app.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.webContents.getURL() ?? ''), { timeout: 10_000 }).not.toMatch(/mini\.html$/)

  await page.evaluate(() => window.jarodOS.prefs.set({ miniWindow: false }))
  await expect.poll(() => Boolean(miniPage()), { timeout: 15_000 }).toBe(false)
})
