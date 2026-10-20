import { expect, test, type Page } from '@playwright/test'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { type Launched, launchShell } from './launch'

// The cockpit's frame in the running app: the Internet switch of the top bar (applied for real to the shell's web sessions, persisted,
// never turned back on by itself), the model picker in the conversation's header, and the sidebar in a short window.
test.describe.configure({ mode: 'serial' })

let shell: Launched
let page: Page

async function skipSetup(target: Page): Promise<void> {
  await expect(target.getByRole('button', { name: 'Accueil' }).first()).toBeVisible({ timeout: 60_000 })

  for (let step = 0; step < 8; step++) {
    const next = target.getByRole('button', { name: /^(Plus tard|Suivant|Commencer)/ })

    if (!(await next.count())) break
    await next.first().click()
    await target.waitForTimeout(800)
  }
}

test.beforeAll(async () => {
  shell = await launchShell()
  page = shell.page
  await skipSetup(page)
})

test.afterAll(async () => {
  await shell?.close()
})

const policyFile = () => path.join(shell.root, 'config', 'network-policy.json')
const pill = (target: Page) => target.getByRole('button', { name: /^Accès Internet de Jarod/ })

test('the Internet switch starts on, and its file exists for the core', async () => {
  await expect(pill(page)).toHaveAttribute('aria-label', 'Accès Internet de Jarod : Internet activé')
  expect(JSON.parse(readFileSync(policyFile(), 'utf8'))).toMatchObject({ version: 1, internet: true })
})

test('turning it off blocks the shell’s own web requests, and is written for the core', async () => {
  await pill(page).click()
  const dialog = page.getByRole('dialog', { name: 'Internet pour Jarod' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('switch', { name: 'Internet pour Jarod' }).click()
  await expect(pill(page)).toHaveAttribute('aria-label', 'Accès Internet de Jarod : Internet désactivé')
  expect(JSON.parse(readFileSync(policyFile(), 'utf8'))).toMatchObject({ internet: false, remoteMachines: false, localCommands: false })

  // The window's own session goes through the dead proxy: a request to the Internet fails without leaving (the address is not even routed).
  const outcome = await page.evaluate(async () => {
    try {
      await fetch('http://203.0.113.9/', { signal: AbortSignal.timeout(8000) })

      return 'reached'
    } catch (error) {
      return error instanceof Error ? error.name : 'failed'
    }
  })
  expect(outcome).not.toBe('reached')
  expect(outcome).not.toBe('TimeoutError')

  // The core was started with the file's path: it reads the same policy.
  const env = await shell.app.evaluate(() => process.env.JAROD_NETWORK_POLICY ?? '')
  expect(path.resolve(env)).toBe(path.resolve(policyFile()))
  await page.keyboard.press('Escape')
})

test('the model picker sits in the conversation header, and is gone from under the composer', async () => {
  await page.getByRole('navigation').first().getByRole('button').nth(1).click()
  const picker = page.getByRole('button', { name: 'Choisir le modèle' })
  await expect(picker).toHaveCount(1)
  const pickerBox = await picker.boundingBox()
  const composer = await page.getByPlaceholder(/Jarod|Connexion/).first().boundingBox()

  expect(pickerBox && composer && pickerBox.y < composer.y).toBe(true)
})

test('in a short window the sidebar scrolls, and its fold button stays reachable', async () => {
  await shell.app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find(w => w.isVisible())
    win?.unmaximize()
    win?.setSize(900, 620)
  })
  await page.waitForTimeout(800)
  const fold = page.getByRole('button', { name: 'Réduire la barre latérale' })
  await expect(fold).toBeInViewport()
  await fold.click()
  await expect(page.getByRole('button', { name: 'Déplier la barre latérale' })).toBeInViewport()
  // The spaces are still there, as dots with their names.
  await expect(page.getByRole('button', { name: /Personal/ }).first()).toBeAttached()
  await page.getByRole('button', { name: 'Déplier la barre latérale' }).click()
})

test('Connexions › Machines distantes shows Tailscale’s real state and the separate checks', async () => {
  await page.getByRole('navigation').first().getByRole('button', { name: 'Connexions', exact: true }).click()
  await page.getByRole('tab', { name: 'Machines distantes' }).or(page.getByRole('button', { name: 'Machines distantes' })).first().click()
  const state = await page.evaluate(() => window.jarodOS.remote.tailscale())
  await expect(page.getByText('Tailscale', { exact: true })).toBeVisible()

  if (!state.installed) {
    await expect(page.getByText('Tailscale n’est pas installé sur cet ordinateur.')).toBeVisible()
  } else if (state.backend === 'Running') {
    await expect(page.getByText(/^Connecté :/)).toBeVisible()
  } else {
    await expect(page.getByText(/Tailscale (n’est pas connecté|attend une connexion)/)).toBeVisible()
  }

  await expect(page.getByRole('button', { name: 'Ajouter une machine' })).toBeVisible()
  await expect(page.getByText(/L’agent ne lance de commandes sur une machine que si vous l’activez/)).toBeVisible()
  await page.screenshot({ path: path.join(process.env.AUDIT_SHOTS ?? shell.root, 'remote-machines.png') }).catch(() => undefined)
})

test('Réglages › Appareils: agent commands on a machine are off by default, on only after a native confirmation, off at once', async () => {
  // The core appends its remote commands to the shell's control journal; the path it is given lies in this run's throwaway root.
  const journal = await shell.app.evaluate(() => process.env.JAROD_CONTROL_JOURNAL ?? '')
  expect(journal.startsWith(shell.root)).toBe(true)
  expect(path.basename(journal)).toBe('control-audit.jsonl')
  await expect.poll(async () => (await page.evaluate(() => window.jarodOS.backend.getState())).phase, { timeout: 60_000 }).toBe('ready')

  // Native dialogs replaced in main: the key "chosen" is a throwaway file, every confirmation is recorded and accepted. Nothing connects.
  const key = path.join(shell.root, 'id_e2e')
  writeFileSync(key, 'not a real key\n')
  await shell.app.evaluate(({ dialog }, file) => {
    const g = globalThis as unknown as { __dialogs: { message: string; detail: string }[] }

    g.__dialogs = []
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [file] })) as never
    dialog.showMessageBox = (async (...args: unknown[]) => {
      const options = args.at(-1) as { message: string; detail?: string }

      g.__dialogs.push({ message: options.message, detail: options.detail ?? '' })

      return { response: 0, checkboxChecked: false }
    }) as never
  }, key)
  const dialogs = () => shell.app.evaluate(() => (globalThis as unknown as { __dialogs: { message: string; detail: string }[] }).__dialogs)

  await page.getByRole('button', { name: 'Réglages' }).first().click()
  await page.getByRole('button', { name: 'Appareils et API', exact: true }).first().click()
  await expect(page.getByText('Hôtes SSH').first()).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: 'Ajouter…' }).last().click()
  await page.getByLabel('Nom de l’hôte').fill('pc-e2e')
  await page.getByLabel('Adresse de l’hôte').fill('100.64.0.9')
  await page.getByLabel('Utilisateur', { exact: true }).fill('ops')
  await page.getByRole('button', { name: 'Choisir la clé…' }).click()
  await expect(page.getByText('Clé : id_e2e')).toBeVisible()
  await page.getByRole('button', { name: 'Ajouter', exact: true }).click()

  const toggle = page.getByRole('switch', { name: 'Laisser l’agent exécuter des commandes sur pc-e2e (chacune confirmée)' })
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  await expect(page.getByText(/commandes de l’agent : non/)).toBeVisible()
  expect(await dialogs()).toEqual([])

  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByText(/commandes de l’agent : oui, chacune confirmée/)).toBeVisible()
  const asked = await dialogs()
  expect(asked).toHaveLength(1)
  expect(asked[0]!.message).toContain('pc-e2e')
  expect(asked[0]!.detail).toContain('ops@100.64.0.9:22')
  await page.screenshot({ path: path.join(process.env.AUDIT_SHOTS ?? shell.root, 'ssh-agent-commands.png') }).catch(() => undefined)

  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  expect(await dialogs()).toHaveLength(1)
  await page.getByRole('button', { name: 'Retirer pc-e2e' }).click()
  await expect(toggle).toHaveCount(0)
})

test('the switch stays off after a restart: nothing turns the Internet back on by itself', async () => {
  const root = shell.root
  await shell.app.close()
  shell = await launchShell({}, { root, own: true })
  page = shell.page
  await skipSetup(page)
  await expect(pill(page)).toHaveAttribute('aria-label', 'Accès Internet de Jarod : Internet désactivé')
})
