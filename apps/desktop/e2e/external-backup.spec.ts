import { expect, test, type Page } from '@playwright/test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { type Launched, launchShell, ROOT_PREFIX } from './launch'

// External backup in the running app, on throwaway folders: a fake secret entered in Settings › Secrets, a backup to another folder (the
// core's database copied through its maintenance mode, without the secret's value), then a restore that puts the workspace back and keeps
// the previous one beside it. The destination is a second throwaway folder (removed at the end).
test.describe.configure({ mode: 'serial' })

const FAKE = 'valeur-factice-e2e-0004'
let shell: Launched
let page: Page
let destination: string

test.beforeAll(async () => {
  shell = await launchShell()
  page = shell.page
  destination = mkdtempSync(path.join(tmpdir(), `${ROOT_PREFIX}dest-`))
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
  rmSync(destination, { recursive: true, force: true })
})

test('a fake secret is stored in the vault from Settings', async () => {
  await page.getByRole('button', { name: 'Réglages' }).first().click()
  await page.getByRole('button', { name: 'Secrets', exact: true }).click()
  await page.getByRole('button', { name: 'Ajouter…' }).click()
  await page.getByPlaceholder('GithubToken').fill('FauxJeton')
  await page.locator('input[type=password]').fill(FAKE)
  await page.getByRole('button', { name: 'Enregistrer' }).click()
  await expect(page.getByText('FauxJeton', { exact: true })).toBeVisible({ timeout: 20_000 })
})

let backupFolder = ''

test('an external backup is complete, verified, and holds no secret value', async () => {
  test.setTimeout(180_000)
  writeFileSync(path.join(shell.root, 'workspace', 'avant.txt'), 'version sauvegardée')

  const set = await page.evaluate(dest => window.jarodOS.externalBackup.setDestination(dest), destination)
  expect(set).toEqual({ ok: true })
  const result = await page.evaluate(() => window.jarodOS.externalBackup.run())
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true })

  const state = await page.evaluate(() => window.jarodOS.externalBackup.state())
  expect(state.list).toHaveLength(1)
  backupFolder = state.list[0].folder
  const manifest = JSON.parse(readFileSync(path.join(backupFolder, 'jarod-backup.json'), 'utf8')) as { secretsRemoved: number; files: Array<{ path: string }>; excluded: string[] }

  expect(manifest.secretsRemoved).toBeGreaterThanOrEqual(1)
  expect(manifest.files.some(file => file.path.endsWith('/jarod.db'))).toBe(true)
  expect(manifest.files.some(file => file.path === 'workspace/avant.txt')).toBe(true)
  expect(manifest.excluded.join('\n')).toMatch(/coffre/)
  // No byte of the fake value anywhere in the backup.
  const all = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => (entry.isDirectory() ? all(path.join(dir, entry.name)) : [path.join(dir, entry.name)]))
  expect(all(backupFolder).some(file => readFileSync(file).includes(Buffer.from(FAKE)))).toBe(false)
  // The core was started again.
  await expect.poll(async () => (await page.evaluate(() => window.jarodOS.backend.getState())).phase, { timeout: 60_000 }).toBe('ready')
})

test('the backup is shown in Settings › Stockage', async () => {
  await page.getByRole('button', { name: 'Général', exact: true }).click()
  await page.getByRole('button', { name: 'Stockage', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Sauvegarde externe' })).toBeVisible()
  await expect(page.getByText(/Disque présent/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Restaurer…' })).toBeVisible()
})

test('a restore puts the saved workspace back and keeps the current one beside it', async () => {
  test.setTimeout(180_000)
  const workspace = path.join(shell.root, 'workspace')
  writeFileSync(path.join(workspace, 'avant.txt'), 'modifié après la sauvegarde')
  // The app restarts itself after a restore; here it only quits, so no instance outside the test's control is left running.
  await shell.app.evaluate(({ app }) => {
    app.relaunch = () => undefined
  })
  const closed = new Promise<void>(resolve => shell.app.once('close', () => resolve()))
  const result = await page.evaluate(folder => window.jarodOS.externalBackup.restore(folder), backupFolder)

  expect(result).toMatchObject({ ok: true })
  await closed.catch(() => undefined)
  expect(readFileSync(path.join(workspace, 'avant.txt'), 'utf8')).toBe('version sauvegardée')
  const aside = readdirSync(shell.root).find(name => name.startsWith('workspace.before-restore-'))
  expect(aside).toBeTruthy()
  expect(readFileSync(path.join(shell.root, aside as string, 'avant.txt'), 'utf8')).toBe('modifié après la sauvegarde')
  expect(existsSync(path.join(shell.root, 'data', 'profile'))).toBe(true)
})

test('after the restart, the restored database opens: the secret’s name is back, without its value', async () => {
  test.setTimeout(120_000)
  const root = shell.root
  shell = await launchShell({}, { root, own: true })
  page = shell.page
  await expect(page.getByRole('button', { name: 'Accueil' }).first()).toBeVisible({ timeout: 60_000 })
  await expect
    .poll(async () => (await page.evaluate(() => window.jarodOS.backend.getState())).phase, { timeout: 60_000 })
    .toBe('ready')
    .catch(async error => {
      console.log('BACKEND', JSON.stringify(await page.evaluate(() => window.jarodOS.backend.getState())))
      throw error
    })

  for (let step = 0; step < 8; step++) {
    const next = page.getByRole('button', { name: /^(Plus tard|Suivant|Commencer)/ })

    if (!(await next.count())) break
    await next.first().click()
    await page.waitForTimeout(800)
  }

  await page.getByRole('button', { name: 'Réglages' }).first().click()
  await page.getByRole('button', { name: 'Secrets', exact: true }).click()
  await expect(page.getByText('FauxJeton', { exact: true })).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText('Sans valeur')).toBeVisible()
})
