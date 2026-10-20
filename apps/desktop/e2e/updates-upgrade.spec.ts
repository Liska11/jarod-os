import { expect, type Page, test } from '@playwright/test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { type Launched, launchShell, ROOT_PREFIX } from './launch'

// Système › Mises à jour: upgrading one listed winget package, in the running app. winget is the scripted one (JAROD_WINGET_MOCK, honoured
// only in an isolated profile): nothing is installed on this machine. The last check's results are seeded in the throwaway root.
test.describe.configure({ mode: 'serial' })

let shell: Launched
let page: Page
let mock: string

const ITEM = { name: 'Git', id: 'Git.Git', current: '2.50.0', available: '2.51.0', source: 'winget', repository: 'winget', restart: false, elevation: false }
const REPORT = {
  checkedAt: new Date().toISOString(),
  categories: {
    windows: { status: 'available', items: [{ name: 'Mise à jour cumulative (KB5099999)', id: 'KB5099999', current: null, available: null, source: 'Windows Update', restart: true, elevation: true }] },
    drivers: { status: 'up-to-date', items: [] },
    software: { status: 'available', items: [ITEM, { ...ITEM, name: 'Other', id: 'Other.Tool', current: '1.0', available: '1.1' }] }
  },
  coverage: ['Couverture de test.']
}

async function skipSetup(target: Page): Promise<void> {
  await expect(target.getByRole('button', { name: 'Accueil' }).first()).toBeVisible({ timeout: 60_000 })

  for (let step = 0; step < 8; step++) {
    const next = target.getByRole('button', { name: /^(Plus tard|Suivant|Commencer)/ })

    if (!(await next.count())) break
    await next.first().click()
    await target.waitForTimeout(800)
  }
}

/** Opens Système through Fichiers › Gérer le stockage, the way a person reaches it. */
async function openSystem(target: Page): Promise<void> {
  await target.getByRole('navigation').first().getByRole('button', { name: 'Fichiers', exact: true }).click()
  await target.getByText('Gérer le stockage').first().click()
  await expect(target.getByRole('region', { name: 'Mises à jour' })).toBeVisible({ timeout: 30_000 })
}

const journal = () => {
  const file = path.join(shell.root, 'hermes', 'jarod-os', 'control-audit.jsonl')

  return existsSync(file)
    ? readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line) as { command?: string; allowed?: boolean; code?: string; reason?: string; source?: string })
    : []
}

test.beforeAll(async () => {
  const root = mkdtempSync(path.join(tmpdir(), ROOT_PREFIX))

  mkdirSync(path.join(root, 'config'), { recursive: true })
  writeFileSync(path.join(root, 'config', 'updates-check.json'), JSON.stringify(REPORT))
  mock = path.join(root, 'winget-mock.json')
  // 0x8A150109: installed, a restart of the computer is needed to finish (as Node reports it, signed).
  writeFileSync(mock, JSON.stringify({ lines: ['Trouvé Git [Git.Git] Version 2.51.0', 'Téléchargement https://example.test/Git.exe', '  ██████  30.0 MB / 60.0 MB', 'Installation réussie'], exitCode: 0x8a150109 | 0, delayMs: 150 }))
  shell = await launchShell({ JAROD_WINGET_MOCK: mock }, { root, own: true })
  page = shell.page
  await skipSetup(page)
})

test.afterAll(async () => {
  await shell?.close()
})

test('main refuses an upgrade without a confirmation, an invalid id and a package the check did not list', async () => {
  const replies = await page.evaluate(async () => ({
    noConfirmation: await window.jarodOS.updates.upgrade('0123456789abcdef0123456789abcdef'),
    invalid: await window.jarodOS.updates.prepareUpgrade({ id: '--all', version: '1', source: 'winget' }),
    injection: await window.jarodOS.updates.prepareUpgrade({ id: 'Git.Git & calc', version: '2.51.0', source: 'winget' }),
    unlisted: await window.jarodOS.updates.prepareUpgrade({ id: 'Evil.Thing', version: '1.0', source: 'winget' })
  }))

  expect(replies.noConfirmation).toMatchObject({ ok: false, error: expect.stringMatching(/confirmez-la/) })
  expect(replies.invalid).toMatchObject({ ok: false, error: 'identifiant de paquet winget invalide' })
  expect(replies.injection).toMatchObject({ ok: false, error: 'identifiant de paquet winget invalide' })
  expect(replies.unlisted).toMatchObject({ ok: false, error: expect.stringMatching(/ne figure pas/) })
  expect(existsSync(`${mock}.args.json`)).toBe(false)
})

test('one listed program: the confirmation names id, version and source; progress and the result are shown; one journal line', async () => {
  await openSystem(page)
  const panel = page.getByRole('region', { name: 'Mises à jour' })

  // No "update everything": one button per program, none for Windows or drivers.
  await expect(panel.getByRole('button', { name: /tout/i })).toHaveCount(0)
  await expect(panel.getByRole('button', { name: /^Mettre à jour .+…$/ })).toHaveCount(2)
  await expect(panel.getByRole('button', { name: 'Ouvrir Windows Update' })).toBeVisible()

  await panel.getByRole('button', { name: 'Mettre à jour Git…' }).click()
  const dialog = panel.getByRole('alertdialog', { name: 'Installer cette mise à jour ?' })

  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('Git.Git')
  await expect(dialog).toContainText('2.50.0 → 2.51.0')
  await expect(dialog).toContainText('winget upgrade --id Git.Git --exact --version 2.51.0 --source winget')
  // Nothing has run before the confirmation.
  expect(existsSync(`${mock}.args.json`)).toBe(false)

  await dialog.getByRole('button', { name: 'Installer Git.Git 2.51.0' }).click()
  await expect(panel.getByRole('status', { name: 'Mise à jour en cours' })).toBeVisible()
  await expect(panel.getByRole('status', { name: 'Résultat de la mise à jour' })).toContainText('Git : redémarrage nécessaire.', { timeout: 30_000 })

  expect(JSON.parse(readFileSync(`${mock}.args.json`, 'utf8'))).toEqual([
    'upgrade',
    '--id',
    'Git.Git',
    '--exact',
    '--version',
    '2.51.0',
    '--source',
    'winget',
    '--silent',
    '--disable-interactivity',
    '--accept-package-agreements',
    '--accept-source-agreements'
  ])
  expect(journal().filter(line => line.command === 'shell.winget.upgrade')).toEqual([
    expect.objectContaining({ allowed: true, code: 'ok', source: 'updates', reason: 'Git.Git 2.51.0 (winget): reboot-required 0x8a150109' })
  ])

  // The upgraded program leaves the list; the other one stays.
  await expect(panel.getByRole('button', { name: 'Mettre à jour Git…' })).toHaveCount(0)
  await expect(panel.getByRole('button', { name: 'Mettre à jour Other…' })).toBeVisible()
  const saved = JSON.parse(readFileSync(path.join(shell.root, 'config', 'updates-check.json'), 'utf8')) as typeof REPORT

  expect(saved.categories.software.items.map(item => item.id)).toEqual(['Other.Tool'])
})

test('with the Internet off, the button is disabled and main refuses with a clear message', async () => {
  await page.evaluate(() => window.jarodOS.network.set({ internet: false }))
  await page.reload()
  await openSystem(page)
  const panel = page.getByRole('region', { name: 'Mises à jour' })

  await expect(panel.getByRole('button', { name: 'Mettre à jour Other…' })).toBeDisabled()
  const reply = await page.evaluate(() => window.jarodOS.updates.prepareUpgrade({ id: 'Other.Tool', version: '1.1', source: 'winget' }))

  expect(reply).toMatchObject({ ok: false, error: expect.stringMatching(/^Internet désactivé pour Jarod : la mise à jour de Other.Tool/) })
  await page.evaluate(() => window.jarodOS.network.set({ internet: true }))
})
