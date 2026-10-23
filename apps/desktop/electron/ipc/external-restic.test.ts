// G4 raccordé — ResticArchive contre restic RÉEL (engines/restic), chiffrement de clé FACTICE (DPAPI est éprouvé de bout en bout, dans
// l'application réelle : e2e/restic-archive.spec.ts). Les chemins d'erreur que l'e2e ne joue pas : dépôt existant sans sa clé, mauvaise clé,
// feuille annulée ; et la clé n'est rangée qu'une fois le dépôt ouvert avec elle.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ResticSettings } from '../../shared/external-backup.ts'
import { newRepoKey, repoFolder, runRestic } from '../restic-backup.ts'
import { type KeyCipher, ResticKeyStore } from '../restic-key.ts'
import { ResticArchive } from './external-restic.ts'

const RESTIC = process.env.JAROD_RESTIC ?? path.resolve(__dirname, '../../../../engines/restic/restic.exe')
const has = fs.existsSync(RESTIC)
const INSTANCE = '0f2c1a3e-1111-4222-8333-944455556666'
const dirs: string[] = []
const temp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'jarod-restic-ui-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

/** Un « chiffrement » réversible et visible : le test vérifie qu'aucun octet de la clé n'est écrit tel quel. */
const fakeCipher: KeyCipher = { available: () => true, encrypt: s => Buffer.from([...Buffer.from(s)].map(b => b ^ 0x5a)), decrypt: b => Buffer.from([...b].map(x => x ^ 0x5a)).toString() }

function harness(o: { sheet?: string | null; keyFile?: string } = {}) {
  let settings: ResticSettings = { enabled: false, keyFingerprint: null, sheetSavedAt: null, last: null }
  const keyFile = o.keyFile ?? path.join(temp(), 'restic-key.bin')
  const archive = new ResticArchive({
    binary: () => RESTIC,
    keys: new ResticKeyStore(keyFile, fakeCipher),
    settings: () => settings,
    save: next => void (settings = next),
    instance: () => INSTANCE,
    saveDialog: async () => (o.sheet === undefined ? path.join(temp(), 'feuille.txt') : o.sheet)
  })

  return { archive, keyFile, settings: () => settings }
}

describe.runIf(has)('G4 — ResticArchive (restic réel)', () => {
  it('activer : la clé est rangée chiffrée, seulement après la création du dépôt ; feuille annulée = à refaire, dit par l’état', async () => {
    const dest = temp()
    const h = harness({ sheet: null })
    const r = await h.archive.enable(dest)

    expect(r).toEqual({ ok: true, created: true, sheetSaved: false })
    expect(h.settings()).toMatchObject({ enabled: true, sheetSavedAt: null })
    expect(h.settings().keyFingerprint).toMatch(/^[a-f0-9]{8}$/)
    const key = new ResticKeyStore(h.keyFile, fakeCipher).read()

    expect(fs.readFileSync(h.keyFile).includes(Buffer.from(key))).toBe(false)
    expect(h.archive.view(dest)).toMatchObject({ enabled: true, sheetSaved: false, repo: repoFolder(dest, INSTANCE) })
  }, 120_000)

  it('un dépôt existant sans sa clé n’est jamais réinitialisé ; une autre clé ne l’ouvre pas ; rien n’est rangé dans ces cas', async () => {
    const dest = temp()
    const repo = repoFolder(dest, INSTANCE)
    fs.mkdirSync(repo, { recursive: true })
    await runRestic({ restic: RESTIC, repo, password: newRepoKey() }, ['init'])

    const fresh = harness()
    expect(await fresh.archive.enable(dest)).toEqual({ ok: false, error: 'repo-without-key' })
    expect(fs.existsSync(fresh.keyFile)).toBe(false)

    const other = harness()
    new ResticKeyStore(other.keyFile, fakeCipher).write(newRepoKey())
    expect(await other.archive.enable(dest)).toMatchObject({ ok: false, error: 'wrong-key' })
    expect(other.settings().enabled).toBe(false)
    // Le dépôt d'origine est intact (toujours un seul fichier de configuration, non réécrit).
    expect(fs.existsSync(path.join(repo, 'config'))).toBe(true)
  }, 120_000)

  it('la feuille porte la clé et le chemin du dépôt ; jamais écrite à côté du dépôt ; restic absent = refus clair', async () => {
    const dest = temp()
    const sheet = path.join(temp(), 'feuille.txt')
    const h = harness({ sheet })

    expect(await h.archive.enable(dest)).toMatchObject({ ok: true, sheetSaved: true })
    const text = fs.readFileSync(sheet, 'utf8')

    expect(text).toContain(new ResticKeyStore(h.keyFile, fakeCipher).read())
    expect(text).toContain(repoFolder(dest, INSTANCE))
    const near = harness({ sheet: path.join(dest, 'Jarod-OS-Restic', 'f.txt'), keyFile: h.keyFile })

    expect(await near.archive.saveSheet(dest)).toEqual({ ok: false, error: 'sheet-next-to-repo' })
    const none = new ResticArchive({ binary: () => null, keys: new ResticKeyStore(path.join(temp(), 'k'), fakeCipher), settings: h.settings, save: () => undefined, instance: () => INSTANCE, saveDialog: async () => null })

    expect(await none.enable(dest)).toEqual({ ok: false, error: 'no-restic' })
    expect(none.view(dest)).toMatchObject({ available: false, reason: 'no-restic' })
  }, 120_000)
})
