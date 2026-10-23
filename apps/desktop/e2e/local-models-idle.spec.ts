import { expect, test, type Page } from '@playwright/test'
import path from 'node:path'
import { type Launched, launchShell } from './launch'

// « Décharger après inactivité » (2026-10-21) dans l'application réelle, profil jetable : la ligne est à côté du hotswap, le choix est écrit par
// le moteur (canal `local-models-configure`) et relu à l'ouverture suivante de l'écran.
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

const openLocalModels = async () => {
  await page.getByRole('button', { name: 'Réglages' }).first().click()
  await page.getByRole('button', { name: 'Modèles locaux', exact: true }).first().click()
}

test('la ligne est sous le hotswap, « Jamais » par défaut ; 15 min est enregistré et relu', async () => {
  await openLocalModels()
  const select = page.getByRole('combobox', { name: 'Décharger après inactivité' })

  await expect(select).toBeVisible({ timeout: 30_000 })
  await expect(select).toHaveValue('0')
  await expect(select.locator('option')).toHaveText(['Jamais', '5 min', '15 min', '30 min', '1 h', '2 h', '8 h'])
  // À côté du hotswap : la ligne qui suit la sienne, dans le même groupe « Chargement ».
  const hotswap = page.getByText('Un seul modèle de conversation à la fois (hotswap)')
  const hotswapBox = await hotswap.boundingBox()
  const selectBox = await select.boundingBox()

  expect(hotswapBox && selectBox && selectBox.y > hotswapBox.y).toBe(true)
  await page.screenshot({ path: path.join(test.info().outputDir, 'modeles-locaux-inactivite.png') })

  await select.selectOption('15')
  await expect(select).toHaveValue('15')
  await page.waitForTimeout(500)

  // Relu depuis le moteur : quitter l'écran, y revenir.
  await page.getByRole('button', { name: 'Stockage', exact: true }).first().click().catch(() => undefined)
  await page.getByRole('button', { name: 'Général', exact: true }).first().click()
  await page.getByRole('button', { name: 'Modèles locaux', exact: true }).first().click()
  await expect(page.getByRole('combobox', { name: 'Décharger après inactivité' })).toHaveValue('15', { timeout: 30_000 })
})
