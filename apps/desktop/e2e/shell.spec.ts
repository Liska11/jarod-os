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
  test('first run walks through six steps, the Jarod disk among them, and ends on « Commencer »', async () => {
    await expect(page.getByText('Bienvenue dans Jarod-OS')).toBeVisible({ timeout: 30_000 })

    const seen: string[] = []
    let diskStep = false

    for (let step = 0; step < 8; step++) {
      const next = page.getByRole('button', { name: /^(Plus tard|Suivant|Commencer)/ })

      if (!(await next.count())) {
        break
      }

      // The disk step: the drives are listed (or the folder can be typed), and it can be left for later.
      if (await page.getByText('Le disque de Jarod-OS').count()) {
        diskStep = true
        await expect(page.getByRole('button', { name: 'Utiliser ce disque' })).toBeVisible()
        await expect(page.getByRole('textbox', { name: 'Dossier de Jarod-OS' })).toBeVisible()
      }

      seen.push((await next.first().innerText()).trim())
      await next.first().click()
      await page.waitForTimeout(800)
    }

    expect(seen).toEqual(['Suivant', 'Suivant', 'Plus tard', 'Plus tard', 'Plus tard', 'Commencer'])
    expect(diskStep).toBe(true)
    await expect(page.getByText('Bienvenue dans Jarod-OS')).toHaveCount(0)
  })

  test('the wizard does not come back on the next launch of the same profile', async () => {
    const root = shell.root
    await shell.app.close()
    // Same root (config, data, workspace), not owned: the root is removed once, by the last launch below.
    const again = await launchShell({}, { root, own: false })

    try {
      await expect(again.page.getByRole('button', { name: 'Accueil' })).toBeVisible({ timeout: 60_000 })
      await again.page.waitForTimeout(3000)
      await expect(again.page.getByText('Bienvenue dans Jarod-OS')).toHaveCount(0)
    } finally {
      await again.close()
    }

    // the shared window is gone: the next tests start their own, which now owns the root (removed in afterAll)
    shell = await launchShell({}, { root, own: true })
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

test.describe('platform', () => {
  test('the platform screen lists MCP approvals, quarantine, sandboxes and Hyper-V from the real engine', async () => {
    await openSettings('Plateforme')

    await expect(page.getByRole('heading', { name: 'Plateforme', level: 2 })).toBeVisible()

    for (const name of ['Outils MCP à approuver', 'Plugins de la plateforme', 'Quarantaine', 'Bacs à sable', 'Hyper-V']) {
      await expect(page.getByRole('heading', { name, level: 3 })).toBeVisible()
    }

    // A fresh profile has nothing held back, nothing in quarantine and no sandbox.
    await expect(page.getByText('Aucune divergence')).toBeVisible()
    await expect(page.getByText('Rien en quarantaine')).toBeVisible()
    await expect(page.getByText('Aucun bac à sable')).toBeVisible()

    // Hyper-V is asked for real (read-only): the answer depends on the machine, never on a guess.
    await expect(page.getByText('Machines virtuelles isolées')).toBeVisible()
    await expect(page.getByText(/^(Prêt|Session non administrateur|Absent)$/)).toBeVisible({ timeout: 30_000 })
  })

  test('the platform screen is found by the settings search', async () => {
    await page.getByRole('button', { name: 'Réglages' }).first().click()
    await page.getByPlaceholder('Rechercher dans les réglages').fill('quarantaine')
    await expect(page.getByRole('heading', { name: 'Quarantaine', level: 3 })).toBeVisible()
    await page.getByPlaceholder('Rechercher dans les réglages').fill('')
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
    await expect(page.getByTestId('user-message').filter({ hasText: 'bonjour e2e' })).toBeVisible({ timeout: 15_000 })
  })
})

test.describe('isolation', () => {
  test('an isolated profile never lists files from the real machine', async () => {
    const recent = await page.evaluate(() => window.jarodOS.fs.recent(5))
    const found = await page.evaluate(() => window.jarodOS.fs.find('a', 5))

    expect(recent).toEqual([])
    expect(found).toEqual([])
  })
})
