import { expect, test, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { type Launched, launchShell, ROOT_PREFIX } from './launch'

// G4 raccordé à Réglages › Stockage (2026-10-21), dans l'application réelle, dossiers jetables : activer l'archive chiffrée (clé rangée par
// DPAPI, feuille de récupération écrite par la boîte native — ici remplacée dans le main par un chemin jetable), archiver une sauvegarde,
// relire le dépôt SANS Jarod avec la seule feuille, vérifier, restaurer un instantané. La clé ne passe jamais par la fenêtre.
test.describe.configure({ mode: 'serial' })

const RESTIC = path.resolve(import.meta.dirname, '..', '..', '..', 'engines', 'restic', 'restic.exe')
let shell: Launched
let page: Page
let destination: string
let papers: string
let key = ''

test.skip(!existsSync(RESTIC), 'restic absent (engines/restic)')

test.beforeAll(async () => {
  shell = await launchShell()
  page = shell.page
  destination = mkdtempSync(path.join(tmpdir(), `${ROOT_PREFIX}dest-`))
  papers = mkdtempSync(path.join(tmpdir(), `${ROOT_PREFIX}papiers-`))
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
  rmSync(papers, { recursive: true, force: true })
})

/** La boîte « Enregistrer sous » du main, remplacée pour le test par un chemin choisi ici. */
const answerSaveDialog = (file: string) =>
  shell.app.evaluate(({ dialog }, target) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: target })) as never
  }, file)

test('activer : dépôt créé, clé rangée par DPAPI (jamais en clair, jamais dans la fenêtre), feuille de récupération écrite', async () => {
  test.setTimeout(120_000)
  expect(await page.evaluate(dest => window.jarodOS.externalBackup.setDestination(dest), destination)).toEqual({ ok: true })
  const before = await page.evaluate(() => window.jarodOS.externalBackup.state())

  expect(before.restic).toMatchObject({ available: true, enabled: false })
  const sheet = path.join(papers, 'feuille.txt')

  await answerSaveDialog(sheet)
  expect(await page.evaluate(() => window.jarodOS.externalBackup.restic.enable())).toEqual({ ok: true, created: true, sheetSaved: true })

  key = /Clé du dépôt : (\S+)/.exec(readFileSync(sheet, 'utf8'))?.[1] ?? ''
  expect(key.length).toBeGreaterThan(30)
  const state = await page.evaluate(() => window.jarodOS.externalBackup.state())

  expect(state.restic).toMatchObject({ enabled: true, sheetSaved: true })
  expect(state.restic.keyFingerprint).toMatch(/^[a-f0-9]{8}$/)
  // Ni la fenêtre, ni les réglages, ni le fichier chiffré ne contiennent la clé en clair.
  expect(JSON.stringify(state)).not.toContain(key)
  const configDir = path.join(shell.root, 'config')

  expect(readFileSync(path.join(configDir, 'external-backup.json'), 'utf8')).not.toContain(key)
  const blob = readFileSync(path.join(configDir, 'restic-key.bin'))

  expect(blob.includes(Buffer.from(key))).toBe(false)
  // Et c'est bien Windows (safeStorage → DPAPI) qui la rend.
  const decrypted = await shell.app.evaluate(({ safeStorage }, file) => safeStorage.decryptString(process.getBuiltinModule('fs').readFileSync(file)), path.join(configDir, 'restic-key.bin'))

  expect(decrypted).toBe(key)
})

test('la feuille n’est jamais rangée à côté du dépôt', async () => {
  await answerSaveDialog(path.join(destination, 'Jarod-OS-Restic', 'feuille.txt'))
  expect(await page.evaluate(() => window.jarodOS.externalBackup.restic.saveSheet())).toEqual({ ok: false, error: 'sheet-next-to-repo' })
})

test('une sauvegarde réussie est archivée ; le dépôt se relit SANS Jarod avec la seule feuille ; il se vérifie', async () => {
  test.setTimeout(240_000)
  writeFileSync(path.join(shell.root, 'workspace', 'avant.txt'), 'version archivée')
  const result = await page.evaluate(() => window.jarodOS.externalBackup.run())

  expect(result, JSON.stringify(result)).toMatchObject({ ok: true })
  const state = await page.evaluate(() => window.jarodOS.externalBackup.state())

  expect(state.last).toMatchObject({ ok: true, message: 'complete' })
  expect(state.restic.last).toMatchObject({ ok: true, message: 'archived' })
  const snapshots = await page.evaluate(() => window.jarodOS.externalBackup.restic.list())

  expect(snapshots).toHaveLength(1)
  expect(snapshots[0].backupId).toBe(state.list[0].id)
  // Sans Jarod : restic, le dépôt et la clé de la feuille.
  const repo = state.restic.repo as string
  const outside = JSON.parse(execFileSync(RESTIC, ['-r', repo, 'snapshots', '--json', '--no-cache'], { env: { ...process.env, RESTIC_PASSWORD: key } }).toString()) as unknown[]

  expect(outside).toHaveLength(1)
  expect(await page.evaluate(() => window.jarodOS.externalBackup.restic.check())).toEqual({ ok: true })
})

test('Réglages › Stockage montre l’archive chiffrée, son empreinte et son instantané', async () => {
  await page.getByRole('button', { name: 'Réglages' }).first().click()
  await page.getByRole('button', { name: 'Général', exact: true }).click()
  await page.getByRole('button', { name: 'Stockage', exact: true }).click()
  const block = page.getByTestId('restic-archive')

  await expect(block).toBeVisible({ timeout: 30_000 })
  await expect(block.getByText('Archive chiffrée (restic)')).toBeVisible()
  await expect(block.getByText(/Clé rangée par Windows \(DPAPI\)/)).toBeVisible()
  await expect(block.getByText('Feuille de récupération enregistrée. Gardez-la hors de ce PC et de ce disque.')).toBeVisible()
  await expect(block.getByRole('button', { name: 'Restaurer…' })).toHaveCount(1, { timeout: 30_000 })
  await block.scrollIntoViewIfNeeded()
  await page.screenshot({ path: path.join(test.info().outputDir, 'reglages-stockage-restic.png') })
})

test('restaurer un instantané : le dossier de travail archivé revient, l’état actuel est gardé à côté', async () => {
  test.setTimeout(240_000)
  const workspace = path.join(shell.root, 'workspace')
  writeFileSync(path.join(workspace, 'avant.txt'), 'modifié après l’archive')
  await shell.app.evaluate(({ app }) => {
    app.relaunch = () => undefined
  })
  const snapshots = await page.evaluate(() => window.jarodOS.externalBackup.restic.list())
  const closed = new Promise<void>(resolve => shell.app.once('close', () => resolve()))
  const result = await page.evaluate(id => window.jarodOS.externalBackup.restic.restore(id), snapshots[0].id)

  expect(result).toMatchObject({ ok: true })
  await closed.catch(() => undefined)
  expect(readFileSync(path.join(workspace, 'avant.txt'), 'utf8')).toBe('version archivée')
  const aside = readdirSync(shell.root).find(name => name.startsWith('workspace.before-restore-'))

  expect(aside).toBeTruthy()
  expect(readFileSync(path.join(shell.root, aside as string, 'avant.txt'), 'utf8')).toBe('modifié après l’archive')
})
