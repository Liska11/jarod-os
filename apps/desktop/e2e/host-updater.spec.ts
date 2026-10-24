import { expect, type Page, test } from '@playwright/test'
import { createHash, generateKeyPairSync, type KeyObject, sign } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Launched, launchShell, ROOT_PREFIX } from './launch'

// V-21 — Jarod-OS's own A/B update in the running app, flag on (JAROD_HOST_UPDATER=1), driving the REAL `jarod-updater` (a debug build of
// host-rust/crates/host-updater, the only kind that accepts a test key). Bundles are signed in memory with a key made for this run; the
// native folder picker and confirmations are replaced in main. Skipped when the binary was not built (`cargo build -p host-updater`).
test.describe.configure({ mode: 'serial' })

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const BIN = process.env.JAROD_UPDATER_BIN ?? path.join(REPO, 'host-rust', 'target', 'debug', 'jarod-updater.exe')

test.skip(!existsSync(BIN), 'jarod-updater is not built')

let shell: Launched
let page: Page
let root: string
const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })

function bundle(version: string, signer: KeyObject = privateKey): string {
  const dir = path.join(root, 'bundles', version)
  const files: [string, string][] = [
    ['bin/jarod-os.exe', `host ${version}`],
    ['resources/gateway.mjs', `kernel ${version}`]
  ]

  for (const [file, text] of files) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
    writeFileSync(path.join(dir, file), text)
  }

  const manifest = Buffer.from(
    JSON.stringify({
      schema: 1,
      product: 'jarod-os',
      version,
      channel: 'stable',
      createdAt: '2026-10-24T12:00:00Z',
      entry: 'bin/jarod-os.exe',
      files: files.map(([file, text]) => ({ path: file, sha256: createHash('sha256').update(text).digest('hex'), size: Buffer.byteLength(text) }))
    })
  )

  writeFileSync(path.join(dir, 'manifest.json'), manifest)
  writeFileSync(path.join(dir, 'manifest.sig'), sign('sha256', manifest, signer).toString('base64'))

  return dir
}

/** The folder the next "Installer une mise à jour signée…" picks; every native confirmation is recorded and accepted. */
async function pickNext(folder: string): Promise<void> {
  await shell.app.evaluate(({ dialog }, picked) => {
    const g = globalThis as unknown as { __dialogs?: string[] }

    g.__dialogs ??= []
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [picked] })) as never
    dialog.showMessageBox = (async (...args: unknown[]) => {
      g.__dialogs?.push((args.at(-1) as { message: string }).message)

      return { response: 0, checkboxChecked: false }
    }) as never
  }, folder)
}

const dialogs = () => shell.app.evaluate(() => (globalThis as unknown as { __dialogs?: string[] }).__dialogs ?? [])

async function skipSetup(target: Page): Promise<void> {
  await expect(target.getByRole('button', { name: 'Accueil' }).first()).toBeVisible({ timeout: 60_000 })

  for (let step = 0; step < 8; step++) {
    const next = target.getByRole('button', { name: /^(Plus tard|Suivant|Commencer)/ })

    if (!(await next.count())) break
    await next.first().click()
    await target.waitForTimeout(800)
  }
}

async function openSystem(target: Page): Promise<void> {
  await target.getByRole('navigation').first().getByRole('button', { name: 'Fichiers', exact: true }).click()
  await target.getByText('Gérer le stockage').first().click()
  await expect(target.getByRole('region', { name: 'Mises à jour' })).toBeVisible({ timeout: 30_000 })
}

test.beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), ROOT_PREFIX))
  const key = path.join(root, 'test.pub')

  writeFileSync(key, publicKey.export({ type: 'spki', format: 'pem' }))
  shell = await launchShell(
    { JAROD_HOST_UPDATER: '1', JAROD_UPDATER_BIN: BIN, JAROD_UPDATER_TEST_KEY: key, JAROD_OS_CONTRACTS_DIR: path.join(REPO, 'contracts', 'v1') },
    { root, own: true }
  )
  page = shell.page
  await skipSetup(page)
})

test.afterAll(async () => {
  await shell?.close()
})

test('install, a trial, "this version works", then a rollback that blocks the failed version', async () => {
  await openSystem(page)
  const section = page.getByRole('region', { name: 'Jarod-OS (mise à jour A/B)' })

  await expect(section).toBeVisible()
  await expect(section).toContainText('En service')
  await expect(section).toContainText('aucune')

  // First install: nothing to fall back to, so no trial.
  await pickNext(bundle('1.0.0'))
  await section.getByRole('button', { name: 'Installer une mise à jour signée…' }).click()
  await expect(section.getByRole('status').last()).toContainText('Jarod-OS 1.0.0 installé', { timeout: 30_000 })
  await expect(section.getByRole('status', { name: 'Version à l’essai' })).toHaveCount(0)

  // Second: on trial, the install button waits for the trial to end.
  await pickNext(bundle('1.1.0'))
  await section.getByRole('button', { name: 'Installer une mise à jour signée…' }).click()
  const trial = section.getByRole('status', { name: 'Version à l’essai' })

  await expect(trial).toContainText('Jarod-OS 1.1.0 est à l’essai', { timeout: 30_000 })
  await expect(section.getByRole('button', { name: 'Installer une mise à jour signée…' })).toBeDisabled()
  expect(await dialogs()).toContain('Installer Jarod-OS 1.1.0 dans l’emplacement de secours ?')

  await trial.getByRole('button', { name: 'Cette version fonctionne' }).click()
  await expect(trial).toHaveCount(0, { timeout: 30_000 })
  await expect(section).toContainText('1.1.0')

  // Third: rolled back, blocked.
  await pickNext(bundle('2.0.0'))
  await section.getByRole('button', { name: 'Installer une mise à jour signée…' }).click()
  await expect(trial).toContainText('2.0.0', { timeout: 30_000 })
  await trial.getByRole('button', { name: 'Revenir à la précédente' }).click()
  await expect(section.getByRole('status').last()).toContainText('Retour à Jarod-OS 1.1.0', { timeout: 30_000 })
  await expect(section).toContainText('Versions bloquées')
  expect(await dialogs()).toContain('Revenir à la version précédente ?')
})

test('a bundle signed by anyone else is refused before any question, and nothing changes', async () => {
  const section = page.getByRole('region', { name: 'Jarod-OS (mise à jour A/B)' })
  const before = (await dialogs()).length
  const stranger = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey

  await pickNext(bundle('3.0.0', stranger))
  await section.getByRole('button', { name: 'Installer une mise à jour signée…' }).click()
  await expect(section.getByRole('alert')).toContainText('Mise à jour refusée — untrusted', { timeout: 30_000 })
  expect((await dialogs()).length).toBe(before)

  const state = await page.evaluate(() => window.jarodOS.hostUpdater.state())

  expect(state.state?.slots[state.state.current ?? '']?.version).toBe('1.1.0')
})

test('the flag off: the channels answer "disabled" and run nothing', async () => {
  const off = await launchShell({ JAROD_UPDATER_BIN: BIN })

  try {
    await expect(off.page.getByRole('button', { name: 'Accueil' }).first()).toBeVisible({ timeout: 60_000 })
    const view = await off.page.evaluate(() => window.jarodOS.hostUpdater.state())
    const install = await off.page.evaluate(() => window.jarodOS.hostUpdater.install())

    expect(view).toMatchObject({ enabled: false, state: null })
    expect(install).toMatchObject({ ok: false, error: expect.stringMatching(/désactivée/) })
    expect(existsSync(path.join(view.root, 'state.json'))).toBe(false)
  } finally {
    await off.close()
  }
})
