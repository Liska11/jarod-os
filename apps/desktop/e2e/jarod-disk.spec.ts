import { expect, test, type Page } from '@playwright/test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { type Launched, launchShell, ROOT_PREFIX } from './launch'

// The Jarod disk in the running app: the throwaway root plays the disk (JAROD_OS_ROOT), its data and workspace are the
// ones the harness already gives the shell. A backup is made from Settings › Stockage and lands in <root>\backups.
test.describe.configure({ mode: 'serial' })

let shell: Launched
let page: Page
let root: string

test.beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), ROOT_PREFIX))
  shell = await launchShell({ JAROD_OS_ROOT: root }, { root, own: true })
  page = shell.page
  await expect(page.getByRole('button', { name: 'Accueil' })).toBeVisible({ timeout: 60_000 })

  for (let step = 0; step < 8; step++) {
    const next = page.getByRole('button', { name: /^(Plus tard|Suivant|Commencer)/ })

    if (!(await next.count())) {
      break
    }

    await next.first().click()
    await page.waitForTimeout(800)
  }
})

test.afterAll(async () => {
  await shell.close()
})

test('a backup made from Settings lands on the Jarod disk, with its manifest', async () => {
  // Something in the workspace to back up.
  const workspace = path.join(root, 'workspace')
  writeFileSync(path.join(workspace, 'notes.md'), '# from the e2e test')

  await page.getByRole('button', { name: 'Réglages' }).first().click()
  await page.getByRole('button', { name: 'Stockage', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Sauvegardes' })).toBeVisible()
  await page.getByRole('button', { name: 'Sauvegarder maintenant' }).click()
  await expect(page.getByText(/· à la main/)).toBeVisible({ timeout: 60_000 })

  const backups = path.join(root, 'backups')
  const [id] = readdirSync(backups).filter(name => name.endsWith('-manual'))
  const manifest = JSON.parse(readFileSync(path.join(backups, id, 'backup.json'), 'utf8')) as { parts: string[]; files: number }

  expect(manifest.parts).toEqual(['data', 'workspace'])
  expect(manifest.files).toBeGreaterThan(0)
  expect(readFileSync(path.join(backups, id, 'workspace', 'notes.md'), 'utf8')).toBe('# from the e2e test')
  expect(existsSync(path.join(backups, id, 'data'))).toBe(true)
})

test('the core starts again after the backup (it stops only for the data copy)', async () => {
  await expect
    .poll(async () => (await page.evaluate(() => window.heraldOS.backend.getState())).phase, { timeout: 60_000 })
    .not.toBe('stopped')
})

test('a sandbox of a project: compared and applied from Settings', async () => {
  const project = path.join(root, 'workspace', 'projet')
  mkdirSync(path.join(project, 'src'), { recursive: true })
  writeFileSync(path.join(project, 'src', 'app.js'), 'v1')

  // The folder picker is a native dialog: the sandbox is created through the same call the button makes.
  const created = await page.evaluate(source => window.heraldOS.sandboxes.create(source, 'essai', false), project)
  expect(created).toMatchObject({ ok: true, name: 'essai' })
  writeFileSync(path.join(root, 'sandboxes', 'essai', 'src', 'app.js'), 'v2 from the sandbox')

  // The list is read when the section opens.
  await page.getByRole('button', { name: 'Général', exact: true }).click()
  await page.getByRole('button', { name: 'Stockage', exact: true }).click()
  await expect(page.getByText('essai', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Comparer' }).click()
  await expect(page.getByText('modifié', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Appliquer 1 changement(s)' }).click()
  await expect(page.getByText('1 changement(s) appliqué(s) au projet.')).toBeVisible()

  expect(readFileSync(path.join(project, 'src', 'app.js'), 'utf8')).toBe('v2 from the sandbox')
})

test('a Python environment built with uv, and a terminal that runs its Python', async () => {
  test.setTimeout(240_000)
  const built = await page.evaluate(() => window.heraldOS.environments.create('py-test', 'python', '3.11'))
  expect(built).toEqual({ ok: true, name: 'py-test' })
  expect(existsSync(path.join(root, 'environments', 'py-test', 'Scripts', 'python.exe'))).toBe(true)

  // A terminal in the environment: its python answers first, from the environment's folder.
  const output = await page.evaluate(async () => {
    const handle = await window.heraldOS.terminal.create({ cols: 120, rows: 30, environment: 'py-test' })
    let text = ''
    const off = window.heraldOS.terminal.onData((id, data) => {
      if (id === handle.id) text += data
    })
    await new Promise(resolve => setTimeout(resolve, 2500))
    window.heraldOS.terminal.write(handle.id, 'python -c "import sys; print(sys.prefix)"\r')
    await new Promise(resolve => setTimeout(resolve, 4000))
    off()
    await window.heraldOS.terminal.dispose(handle.id)

    return text
  })

  expect(output.replace(/\s+/g, '')).toContain(path.join(root, 'environments', 'py-test').replace(/\s+/g, ''))

  await page.getByRole('button', { name: 'Général', exact: true }).click()
  await page.getByRole('button', { name: 'Stockage', exact: true }).click()
  await expect(page.getByText('py-test', { exact: true })).toBeVisible()
  await expect(page.getByText(/^Python 3\.11\./)).toBeVisible()
})
