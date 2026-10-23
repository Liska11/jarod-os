import { expect, type Page, test } from '@playwright/test'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { type Launched, launchShell, ROOT_PREFIX } from './launch'

/*
 * Cycle restic COMPLET depuis la build PACKAGÉE (release/win-unpacked/Jarod-OS.exe), profil jetable — à lancer SEULEMENT avec l'accord de
 * l'utilisateur, qui l'a refusé jusqu'ici (« sans l'installer ») :
 *
 *   JAROD_PACKAGE_RUN=1 npx playwright test e2e/package-restic-cycle.spec.ts --reporter=line
 *
 * Rien n'est installé : l'exécutable est lancé là où electron-builder l'a posé. Aucune donnée réelle : config, données, dossier de travail,
 * profil Electron et destination sont des dossiers neufs sous %TEMP% (préfixe jarod-e2e-), supprimés à la fin. La clé est rangée par DPAPI
 * pour CE compte dans ce profil jetable, puis supprimée avec lui. Aucune restauration sur les données réelles : la restauration se fait dans un
 * dossier séparé, puis (dernier test) sur le profil JETABLE seulement.
 *
 * Étapes : données factices → sauvegarde → archive restic → `check --read-data` (toutes les données relues) avec le restic DU PAQUET →
 * restauration dans un dossier séparé → comparaison octet par octet → exclusions vérifiées → erreurs (clé fausse, destination absente, feuille
 * refusée) → annulation (sauvegarde arrêtée, dépôt toujours sain).
 */
test.describe.configure({ mode: 'serial' })
test.skip(process.env.JAROD_PACKAGE_RUN !== '1', 'build packagée : lancement soumis à l’accord de l’utilisateur (JAROD_PACKAGE_RUN=1)')

const APP = path.resolve(import.meta.dirname, '..', 'release', 'win-unpacked')
const EXE = path.join(APP, 'Jarod-OS.exe')
const RESTIC = path.join(APP, 'resources', 'restic', 'restic.exe')
const LOCK = path.resolve(import.meta.dirname, '..', '..', '..', 'jarod-core', 'engines.lock', 'restic.json')

let shell: Launched
let page: Page
let destination: string
let papers: string
let key = ''

const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex')

/** Les fichiers d'un dossier, chemin relatif → empreinte. */
function tree(dir: string, rel = ''): Map<string, string> {
  const out = new Map<string, string>()

  for (const entry of readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${entry.name}` : entry.name

    if (entry.isDirectory()) for (const [k, v] of tree(dir, r)) out.set(k, v)
    else if (entry.isFile()) out.set(r, sha(path.join(dir, r)))
  }

  return out
}

const restic = (args: string[], password = key) => spawnSync(RESTIC, args, { env: { ...process.env, RESTIC_PASSWORD: password }, encoding: 'utf8', timeout: 300_000 })
const answerSaveDialog = (file: string | null) =>
  shell.app.evaluate(({ dialog }, target) => {
    dialog.showSaveDialog = (async () => (target ? { canceled: false, filePath: target } : { canceled: true, filePath: '' })) as never
  }, file)

test.beforeAll(async () => {
  // La build qu'on lance est bien celle qui embarque le restic vérifié.
  expect(existsSync(EXE), EXE).toBe(true)
  const lock = JSON.parse(readFileSync(LOCK, 'utf8')) as { version: string; exe: { sha256: string } }

  expect(sha(RESTIC)).toBe(lock.exe.sha256)
  expect(JSON.parse(readFileSync(path.join(APP, 'resources', 'restic', 'VERSION.json'), 'utf8')).version).toBe(lock.version)

  shell = await launchShell({}, { executablePath: EXE })
  page = shell.page
  destination = mkdtempSync(path.join(tmpdir(), `${ROOT_PREFIX}pkg-dest-`))
  papers = mkdtempSync(path.join(tmpdir(), `${ROOT_PREFIX}pkg-papiers-`))
  await expect(page.getByRole('button', { name: 'Accueil' }).first()).toBeVisible({ timeout: 120_000 })

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

test('le paquet trouve SON restic (resources\\restic), pas celui du dépôt', async () => {
  const state = await page.evaluate(() => window.jarodOS.externalBackup.state())

  // Sans destination encore choisie, l'archive n'est pas « disponible » pour CETTE raison-là ; ce qui compte ici : restic est trouvé.
  expect(state.restic.reason).toBe('no-destination')
  expect(state.restic.reason).not.toBe('no-restic')
  const used = await shell.app.evaluate(() => process.resourcesPath)

  expect(path.resolve(used)).toBe(path.resolve(APP, 'resources'))
})

test('données factices, sauvegarde, archive chiffrée', async () => {
  test.setTimeout(300_000)
  const ws = path.join(shell.root, 'workspace')

  mkdirSync(path.join(ws, 'dossier', 'sous-dossier'), { recursive: true })
  writeFileSync(path.join(ws, 'texte.txt'), 'contenu factice\n')
  writeFileSync(path.join(ws, 'dossier', 'accentué é ü.md'), '# titre\nligne\n')
  writeFileSync(path.join(ws, 'dossier', 'sous-dossier', 'binaire.bin'), Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 37) % 256)))
  writeFileSync(path.join(ws, 'vide.txt'), '')
  // Ce que la sauvegarde exclut toujours (données) — posé ici pour vérifier qu'il n'est PAS dans l'archive.
  const data = readdirSync(path.join(shell.root, 'data'))[0] ? path.join(shell.root, 'data', readdirSync(path.join(shell.root, 'data'))[0]!) : path.join(shell.root, 'data')

  writeFileSync(path.join(data, '.env'), 'OPENAI_API_KEY=factice-ne-doit-pas-partir\n')
  writeFileSync(path.join(data, 'auth.json'), '{"factice":true}')
  writeFileSync(path.join(data, 'trace.log'), 'journal\n')

  expect(await page.evaluate(dest => window.jarodOS.externalBackup.setDestination(dest), destination)).toEqual({ ok: true })
  expect(await page.evaluate(() => window.jarodOS.externalBackup.setOptions(['data', 'workspace', 'config'], { enabled: false, everyHours: 24 }))).toBeTruthy()
  await answerSaveDialog(path.join(papers, 'feuille.txt'))
  expect(await page.evaluate(() => window.jarodOS.externalBackup.restic.enable())).toEqual({ ok: true, created: true, sheetSaved: true })
  key = /Clé du dépôt : (\S+)/.exec(readFileSync(path.join(papers, 'feuille.txt'), 'utf8'))?.[1] ?? ''
  expect(key.length).toBeGreaterThan(30)

  const result = await page.evaluate(() => window.jarodOS.externalBackup.run())
  const state = await page.evaluate(() => window.jarodOS.externalBackup.state())

  expect(result, JSON.stringify(result)).toMatchObject({ ok: true })
  expect(state.restic.last).toMatchObject({ ok: true, message: 'archived' })
})

test('check avec relecture de TOUTES les données, par le restic du paquet et la seule feuille', async () => {
  test.setTimeout(600_000)
  const repo = (await page.evaluate(() => window.jarodOS.externalBackup.state())).restic.repo as string
  const r = restic(['-r', repo, 'check', '--read-data', '--no-cache'])

  expect(r.status, r.stderr).toBe(0)
  expect(r.stdout).toMatch(/no errors were found/)
  // Et la vérification de Jarod (sous-ensemble) aussi.
  expect(await page.evaluate(() => window.jarodOS.externalBackup.restic.check())).toEqual({ ok: true })
})

test('restauration dans un dossier SÉPARÉ, comparaison octet par octet, exclusions absentes', async () => {
  test.setTimeout(600_000)
  const repo = (await page.evaluate(() => window.jarodOS.externalBackup.state())).restic.repo as string
  const target = mkdtempSync(path.join(tmpdir(), `${ROOT_PREFIX}pkg-restore-`))

  try {
    const r = restic(['-r', repo, 'restore', 'latest', '--target', target, '--no-cache'])

    expect(r.status, r.stderr).toBe(0)
    const restored = tree(target)
    const find = (suffix: string) => [...restored.keys()].filter(k => k.endsWith(suffix))
    const ws = tree(path.join(shell.root, 'workspace'))

    // Chaque fichier du dossier de travail est revenu, identique.
    for (const [rel, hash] of ws) {
      const hit = find(`workspace/${rel}`)

      expect(hit, rel).toHaveLength(1)
      expect(restored.get(hit[0]!), rel).toBe(hash)
    }

    // Exclusions : ni fichiers de clés en clair, ni journaux, ni la clé du dépôt, ni d'autre réglage que prefs.json.
    for (const banned of ['/.env', '/auth.json', '/trace.log', '/restic-key.bin', '/external-backup.json']) expect(find(banned), banned).toEqual([])
    // Les sessions web du navigateur intégré : exclusion prouvée par electron/external-backup.test.ts, qui en sème ; ce profil jetable n'en a pas.
    // La clé ne figure dans aucun fichier restauré.
    for (const rel of restored.keys()) expect(readFileSync(path.join(target, rel)).includes(Buffer.from(key)), rel).toBe(false)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('erreurs : clé fausse refusée par restic ; destination absente ; feuille refusée ou annulée', async () => {
  test.setTimeout(300_000)
  const repo = (await page.evaluate(() => window.jarodOS.externalBackup.state())).restic.repo as string
  const wrong = restic(['-r', repo, 'snapshots', '--no-cache'], 'ce-n-est-pas-la-cle')

  expect(wrong.status).not.toBe(0)
  expect(wrong.stderr).toMatch(/wrong password|no key found/i)

  await answerSaveDialog(path.join(repo, 'feuille.txt'))
  expect(await page.evaluate(() => window.jarodOS.externalBackup.restic.saveSheet())).toEqual({ ok: false, error: 'sheet-next-to-repo' })
  await answerSaveDialog(null)
  expect(await page.evaluate(() => window.jarodOS.externalBackup.restic.saveSheet())).toEqual({ ok: false, error: 'sheet-cancelled' })

  // Destination débranchée : la sauvegarde échoue en le disant, rien n'est écrit ailleurs.
  const away = `${destination}-debranche`

  renameSync(destination, away)

  try {
    const result = await page.evaluate(() => window.jarodOS.externalBackup.run())

    expect(result.ok).toBe(false)
  } finally {
    renameSync(away, destination)
  }
})

test('annulation : une sauvegarde arrêtée en route ne laisse ni sauvegarde à moitié ni dépôt abîmé', async () => {
  test.setTimeout(600_000)
  // Assez de données pour que l'annulation arrive pendant la copie.
  const big = path.join(shell.root, 'workspace', 'gros')

  mkdirSync(big, { recursive: true })
  for (let i = 0; i < 60; i++) writeFileSync(path.join(big, `f${i}.bin`), randomBytes(8 * 1024 * 1024))
  const before = (await page.evaluate(() => window.jarodOS.externalBackup.restic.list())).length
  const running = page.evaluate(() => window.jarodOS.externalBackup.run())

  // Annuler PENDANT la sauvegarde : attendre que l'opération soit en cours (copie ou archivage), pas un délai arbitraire.
  await expect
    .poll(async () => (await page.evaluate(() => window.jarodOS.externalBackup.state())).progress.operation, { timeout: 60_000, intervals: [25] })
    .toBe('backup')
  expect(await page.evaluate(() => window.jarodOS.externalBackup.cancel())).toBe(true)
  const result = await running

  expect(result).toEqual({ ok: false, error: 'cancelled' })
  expect((await page.evaluate(() => window.jarodOS.externalBackup.restic.list())).length).toBe(before)
  const repo = (await page.evaluate(() => window.jarodOS.externalBackup.state())).restic.repo as string
  const r = restic(['-r', repo, 'check', '--no-cache'])

  expect(r.status, r.stderr).toBe(0)
  // Aucun dossier de sauvegarde inachevé ne reste dans la destination.
  const leftovers = readdirSync(destination, { recursive: true }).map(String).filter(p => /\.partial|\.tmp-|incomplete/i.test(p))

  expect(leftovers).toEqual([])
  expect(statSync(destination).isDirectory()).toBe(true)
  void execFileSync
})
