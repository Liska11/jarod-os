// G4 — restic SOUS la sauvegarde externe : contre restic RÉEL (engines/restic/restic.exe, 0.19.1, sha256 = SHA256SUMS de la release),
// sur une sauvegarde Jarod produite par le vrai `makeBackup` (base sans coffre, exclusions), dans des dossiers jetables.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { dataExclusion, makeBackup, MANIFEST, planBackup, stageRestore, swapIn } from './external-backup.ts'
import { archiveBackup, checkRepo, ensureRepo, extractSnapshot, listSnapshots, newRepoKey, recoverySheet, repoFolder, ResticError, runRestic } from './restic-backup.ts'

const RESTIC = process.env.JAROD_RESTIC ?? path.resolve(__dirname, '../../../engines/restic/restic.exe')
const has = fs.existsSync(RESTIC)
if (!has) console.warn(`[moteurs] ${RESTIC} absent : les tests restic réels sont ignorés (voir jarod-core/engines.lock/README.md)`)

const INSTANCE = '0f2c1a3e-1111-4222-8333-944455556666'
const VAULT_VALUE = 'valeur-du-coffre-a-ne-jamais-sauvegarder-0042'
const dirs: string[] = []
const temp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarod-restic-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function write(file: string, text: string | Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

/** Un profil et un dossier de travail fabriqués ; la « base » contient une valeur du coffre, que le snapshot retire (comme le noyau). */
function sources() {
  const root = temp()
  const data = path.join(root, 'data')
  const workspace = path.join(root, 'workspace')
  write(path.join(data, 'profile', 'profiles', 'default', 'jarod.db'), `DB ${VAULT_VALUE}`)
  write(path.join(data, 'profile', 'profiles', 'default', 'db.key.dpapi'), 'KEYBLOB')
  write(path.join(data, 'gateway.log'), 'journal du noyau')
  write(path.join(workspace, 'notes.md'), '# notes v1')
  write(path.join(workspace, 'gros.bin'), Buffer.alloc(2 * 1024 * 1024, 3))
  return { root, data, workspace }
}

async function backupOf(s: ReturnType<typeof sources>, destination: string) {
  const plan = await planBackup([
    { part: 'data', dir: s.data, exclude: dataExclusion },
    { part: 'workspace', dir: s.workspace }
  ])
  const manifest = await makeBackup(
    { destination, instance: INSTANCE, app: 'test', reason: 'manual', parts: ['data', 'workspace'], plan },
    {
      signal: new AbortController().signal,
      snapshotDb: async (src, dest) => {
        fs.writeFileSync(dest, fs.readFileSync(src, 'utf8').replace(VAULT_VALUE, ''))
        return 1
      },
      progress: () => undefined
    }
  )
  return path.join(destination, 'Jarod-OS-Backups', INSTANCE, manifest.id)
}

describe.runIf(has)('G4 — restic sous la sauvegarde externe (restic réel)', () => {
  it('dépôt créé une fois ; deux sauvegardes archivées, la seconde dédupliquée ; instantanés étiquetés par sauvegarde Jarod', async () => {
    const s = sources()
    const staging = temp()
    const repo = repoFolder(temp(), INSTANCE)
    const o = { restic: RESTIC, repo, password: newRepoKey() }
    expect(await ensureRepo(o)).toBe('created')
    expect(await ensureRepo(o)).toBe('existing')

    const first = await archiveBackup({ ...o, folder: await backupOf(s, staging), instance: INSTANCE })
    write(path.join(s.workspace, 'notes.md'), '# notes v2')
    await new Promise(r => setTimeout(r, 1100)) // un identifiant de sauvegarde par seconde
    const second = await archiveBackup({ ...o, folder: await backupOf(s, staging), instance: INSTANCE })

    expect(first.bytesAdded).toBeGreaterThan(0)
    // Le gros fichier inchangé n'est pas réécrit : la seconde archive n'ajoute presque rien.
    expect(second.bytesAdded).toBeLessThan(first.bytesAdded / 4)
    const snaps = await listSnapshots(o)
    expect(snaps.map(x => x.backupId).sort()).toEqual([first.backupId, second.backupId].sort())
    expect(snaps.every(x => x.instance === INSTANCE)).toBe(true)
    await checkRepo(o, '100%')
  }, 180_000)

  it('restauration : extraite, revérifiée par le manifeste Jarod, puis mise en place par le moteur existant (état précédent gardé)', async () => {
    const s = sources()
    const repo = repoFolder(temp(), INSTANCE)
    const o = { restic: RESTIC, repo, password: newRepoKey() }
    await ensureRepo(o)
    const { snapshot } = await archiveBackup({ ...o, folder: await backupOf(s, temp()), instance: INSTANCE })

    write(path.join(s.workspace, 'notes.md'), '# modifié après la sauvegarde')
    const { folder, cleanup } = await extractSnapshot({ ...o, snapshot })
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(folder, MANIFEST), 'utf8'))
      const staged = await stageRestore(folder, manifest, { workspace: s.workspace }, 'test', new AbortController().signal, () => {})
      const { aside } = await swapIn(staged, { workspace: s.workspace }, 'test')
      expect(fs.readFileSync(path.join(s.workspace, 'notes.md'), 'utf8')).toBe('# notes v1')
      expect(aside.length).toBe(1)
      expect(fs.readFileSync(path.join(aside[0]!, 'notes.md'), 'utf8')).toBe('# modifié après la sauvegarde')
    } finally {
      await cleanup()
    }
  }, 180_000)

  it("exclusions du moteur conservées : ni valeur du coffre, ni journaux dans le dépôt (relu par restic)", async () => {
    const s = sources()
    const repo = repoFolder(temp(), INSTANCE)
    const o = { restic: RESTIC, repo, password: newRepoKey() }
    await ensureRepo(o)
    const { snapshot } = await archiveBackup({ ...o, folder: await backupOf(s, temp()), instance: INSTANCE })
    const { folder, cleanup } = await extractSnapshot({ ...o, snapshot })
    try {
      const all: string[] = []
      const walk = (d: string) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(path.join(d, e.name)) : all.push(path.join(d, e.name))
      }
      walk(folder)
      expect(all.some(f => f.endsWith('gateway.log'))).toBe(false)
      for (const f of all) expect(fs.readFileSync(f).includes(VAULT_VALUE), f).toBe(false)
    } finally {
      await cleanup()
    }
    // Le dépôt est chiffré : la valeur, même si elle y était, ne se lirait pas en clair ; on vérifie aussi qu'aucun nom de fichier ne fuit.
    const raw: Buffer[] = []
    const walkRepo = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walkRepo(path.join(d, e.name)) : raw.push(fs.readFileSync(path.join(d, e.name)))
    }
    walkRepo(repo)
    expect(raw.some(b => b.includes('notes.md'))).toBe(false)
  }, 180_000)

  it("refus : mauvaise clé, sauvegarde altérée, dossier non vide qui n'est pas un dépôt, sous-commandes destructrices", async () => {
    const s = sources()
    const dest = temp()
    const repo = repoFolder(temp(), INSTANCE)
    const o = { restic: RESTIC, repo, password: newRepoKey() }
    await ensureRepo(o)
    await expect(ensureRepo({ ...o, password: newRepoKey() })).rejects.toBeInstanceOf(ResticError)

    const folder = await backupOf(s, dest)
    fs.appendFileSync(path.join(folder, 'workspace', 'notes.md'), 'altéré')
    await expect(archiveBackup({ ...o, folder, instance: INSTANCE })).rejects.toThrow()
    expect(await listSnapshots(o)).toEqual([])

    const notRepo = temp()
    write(path.join(notRepo, 'perso.txt'), 'à moi')
    await expect(ensureRepo({ ...o, repo: notRepo })).rejects.toThrow(/n'est pas un dépôt restic/)
    expect(fs.readdirSync(notRepo)).toEqual(['perso.txt'])

    for (const sub of ['forget', 'prune', 'unlock', 'key', 'migrate', 'rewrite']) await expect(runRestic(o, [sub, '--prune'])).rejects.toThrow(/refusée/)
  }, 180_000)

  it('la clé ne passe jamais en argument ; la feuille de récupération suffit pour relire sans Jarod', async () => {
    const key = newRepoKey()
    const sheet = recoverySheet('E:\\Jarod-OS-Restic\\x', key, INSTANCE)
    expect(sheet).toContain(key)
    expect(sheet).toMatch(/restic -r/)
    const s = sources()
    const repo = repoFolder(temp(), INSTANCE)
    await ensureRepo({ restic: RESTIC, repo, password: key })
    await archiveBackup({ restic: RESTIC, repo, password: key, folder: await backupOf(s, temp()), instance: INSTANCE })
    // Relecture « sans Jarod » : la commande de la feuille, avec la seule clé.
    const { execFileSync } = await import('node:child_process')
    const out = execFileSync(RESTIC, ['-r', repo, 'snapshots', '--json', '--no-cache'], { env: { ...process.env, RESTIC_PASSWORD: key } }).toString()
    expect(JSON.parse(out)).toHaveLength(1)
  }, 180_000)
})
