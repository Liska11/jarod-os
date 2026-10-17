import { expect, test, type Page } from '@playwright/test'
import { type Launched, launchShell } from './launch'

// The shell runs in French on this machine; the assertions use the French labels of the catalog (src/locales/fr.ts).
test.describe.configure({ mode: 'serial' })

let shell: Launched
let page: Page

test.beforeAll(async () => {
  shell = await launchShell()
  page = shell.page
  await expect(page.getByRole('button', { name: 'Accueil' })).toBeVisible({ timeout: 60_000 })
})

test.afterAll(async () => {
  await shell.close()
})

async function openSettings(section: string) {
  await page.getByRole('button', { name: 'Réglages' }).first().click()
  await page.getByRole('button', { name: section, exact: true }).click()
}

test.describe('onboarding', () => {
  test('first run walks through five steps and ends on « Commencer »', async () => {
    await expect(page.getByText('Bienvenue dans Jarod-OS')).toBeVisible({ timeout: 30_000 })

    const seen: string[] = []

    for (let step = 0; step < 6; step++) {
      const next = page.getByRole('button', { name: /^(Plus tard|Suivant|Commencer)/ })

      if (!(await next.count())) {
        break
      }

      seen.push((await next.first().innerText()).trim())
      await next.first().click()
      await page.waitForTimeout(800)
    }

    expect(seen).toEqual(['Suivant', 'Suivant', 'Plus tard', 'Plus tard', 'Commencer'])
    await expect(page.getByText('Bienvenue dans Jarod-OS')).toHaveCount(0)
  })

  test('the wizard does not come back on the next launch of the same profile', async () => {
    const root = shell.root
    await shell.app.close()
    const again = await launchShell({ HERALD_OS_CONFIG_DIR: `${root}/config`, JAROD_OS_DATA: `${root}/data`, JAROD_WORKSPACE: `${root}/workspace` })

    try {
      await expect(again.page.getByRole('button', { name: 'Accueil' })).toBeVisible({ timeout: 60_000 })
      await again.page.waitForTimeout(3000)
      await expect(again.page.getByText('Bienvenue dans Jarod-OS')).toHaveCount(0)
    } finally {
      await again.app.close().catch(() => undefined)
    }

    // the shared window is gone: the next tests start their own
    shell = await launchShell({ HERALD_OS_CONFIG_DIR: `${root}/config`, JAROD_OS_DATA: `${root}/data`, JAROD_WORKSPACE: `${root}/workspace` })
    page = shell.page
    await expect(page.getByRole('button', { name: 'Accueil' })).toBeVisible({ timeout: 60_000 })
  })
})

test.describe('settings', () => {
  test('lists the sections and filters them with the search box', async () => {
    await page.getByRole('button', { name: 'Réglages' }).first().click()

    for (const name of ['Général', 'Fournisseurs et clés', 'Agent et sécurité', 'Secrets', 'Confidentialité', 'À propos']) {
      await expect(page.getByRole('button', { name, exact: true })).toBeVisible()
    }

    const search = page.getByPlaceholder('Rechercher dans les réglages')

    await search.fill('zzqxnomatch')
    await expect(page.getByText('Étapes par tour')).toHaveCount(0)
    await expect(page.getByText('Aucun réglage ne correspond à « zzqxnomatch »')).toBeVisible()
    await search.fill('Étapes par tour')
    await expect(page.getByText('Étapes par tour').first()).toBeVisible()
    await search.fill('')
  })

  test('the autonomy choice is shown and changes', async () => {
    await openSettings('Jarod et agents')

    const strict = page.getByRole('button', { name: /^Demander d’abord/ })
    const balanced = page.getByRole('button', { name: /^Équilibré/ })

    await balanced.click()
    await expect(balanced).toHaveClass(/glass-card-selected/, { timeout: 15_000 })
    await strict.click()
    await expect(strict).toHaveClass(/glass-card-selected/, { timeout: 15_000 })
  })
})

test.describe('permissions', () => {
  test('shell guard defaults to the workspace only', async () => {
    await openSettings('Agent et sécurité')
    await expect(page.getByRole('heading', { name: 'Garde du shell' })).toBeVisible()
    await expect(page.getByText('Dossier de travail seulement').first()).toBeAttached()
    await expect(page.getByText('Aucun pour l’instant.')).toBeVisible()
  })

  test('a deny rule is added and listed, and starts empty', async () => {
    await openSettings('Agent et sécurité')
    await expect(page.getByText('Aucune règle.')).toBeVisible()

    await page.getByPlaceholder('Nom d’outil, famille/* ou *').fill('run_shell')
    await page.locator('select[aria-label]').filter({ has: page.locator('option[value=deny]') }).selectOption('deny')
    await page.getByRole('button', { name: 'Ajouter la règle' }).click()

    await expect(page.getByText('Aucune règle.')).toHaveCount(0, { timeout: 15_000 })
    await expect(page.getByText('run_shell').first()).toBeVisible()
  })
})

test.describe('chat', () => {
  test('the composer accepts a message and shows it in the conversation', async () => {
    await page.getByRole('button', { name: 'Accueil' }).click()

    const composer = page.getByPlaceholder('Que voulez-vous accomplir ?').first()
    await expect(composer).toBeVisible()
    await composer.fill('bonjour e2e')
    await composer.press('Enter')

    // No provider is configured in the throwaway profile: the turn cannot complete, but the message must be on screen.
    await expect(page.getByText('bonjour e2e').first()).toBeVisible({ timeout: 15_000 })
  })
})
