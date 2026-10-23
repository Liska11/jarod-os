import fs from 'node:fs'
import path from 'node:path'
import type { ResticSettings, ResticSnapshot, ResticView } from '../../shared/external-backup.ts'
import { archiveBackup, checkRepo, ensureRepo, extractSnapshot, listSnapshots, recoverySheet, repoFolder, type ResticOptions, newRepoKey, RESTIC_FOLDER } from '../restic-backup.ts'
import { ResticKeyStore } from '../restic-key.ts'

/*
 * G4 raccordé (2026-10-21) : le dépôt restic SOUS la sauvegarde externe, piloté depuis Réglages › Stockage.
 *  - Activer : crée le dépôt `<destination>\Jarod-OS-Restic\<instance>` avec une clé neuve (ou rouvre un dépôt dont la clé est déjà rangée),
 *    range la clé chiffrée par DPAPI (restic-key.ts), puis demande où écrire la FEUILLE DE RÉCUPÉRATION (boîte native du main : la clé ne
 *    passe jamais par la fenêtre). Un dépôt existant sans sa clé n'est jamais réinitialisé.
 *  - Après chaque sauvegarde externe réussie : archivée dans le dépôt (dédupliquée) ; un échec d'archive ne fait pas échouer la sauvegarde.
 *  - Restaurer un instantané : extrait dans un dossier temporaire puis remis au moteur de restauration existant (revérifié, mis en place à
 *    côté de l'état précédent). Vérifier : `restic check` sur une part des données.
 *  - Jamais `forget`, `prune`, `unlock`, `key` (restic-backup.ts les refuse).
 */

export interface ResticArchiveDeps {
  /** restic.exe, ou null s'il n'est pas là. */
  binary: () => string | null
  keys: ResticKeyStore
  settings: () => ResticSettings
  save: (next: ResticSettings) => void
  instance: () => string
  /** La boîte « Enregistrer sous » native ; null si l'utilisateur annule. */
  saveDialog: (defaultName: string) => Promise<string | null>
}

export type ResticResult = { ok: true; created?: boolean; sheetSaved?: boolean; path?: string } | { ok: false; error: string }

export class ResticArchive {
  constructor(private readonly d: ResticArchiveDeps) {}

  /** Ce que l'écran montre (jamais la clé : son empreinte seulement). */
  view(destination: string | null): ResticView {
    const s = this.d.settings()
    const bin = this.d.binary()
    const reason = !bin ? 'no-restic' : !destination ? 'no-destination' : null

    return {
      available: reason === null,
      reason,
      enabled: s.enabled,
      repo: destination ? repoFolder(destination, this.d.instance()) : null,
      keyFingerprint: s.keyFingerprint,
      sheetSaved: s.sheetSavedAt !== null,
      last: s.last
    }
  }

  private options(destination: string): ResticOptions {
    const bin = this.d.binary()

    if (!bin) throw new Error('no-restic')

    return { restic: bin, repo: repoFolder(destination, this.d.instance()), password: this.d.keys.read() }
  }

  /**
   * Active l'archive chiffrée. Clé neuve seulement si le dépôt n'existe pas ; s'il existe, la clé rangée doit l'ouvrir (jamais de
   * réinitialisation). La feuille de récupération est demandée tout de suite (annuler la laisse à faire, l'écran le rappelle).
   */
  async enable(destination: string): Promise<ResticResult> {
    const bin = this.d.binary()

    if (!bin) return { ok: false, error: 'no-restic' }

    const repo = repoFolder(destination, this.d.instance())
    const exists = fs.existsSync(path.join(repo, 'config'))
    let key: string
    let fresh = false

    try {
      if (this.d.keys.has()) key = this.d.keys.read()
      else if (exists) return { ok: false, error: 'repo-without-key' }
      else {
        key = newRepoKey()
        fresh = true
      }
    } catch (error) {
      return { ok: false, error: (error as Error).message === 'no-dpapi' ? 'no-dpapi' : 'key-unreadable' }
    }

    let outcome: 'created' | 'existing'

    try {
      outcome = await ensureRepo({ restic: bin, repo, password: key })
    } catch (error) {
      const message = (error as Error).message

      return { ok: false, error: /wrong password|no key found|clé/i.test(message) ? 'wrong-key' : /n'est pas un dépôt/.test(message) ? 'not-a-repo' : `restic: ${message.slice(0, 200)}` }
    }

    // La clé n'est rangée qu'une fois le dépôt créé ou ouvert avec elle.
    if (fresh) this.d.keys.write(key)

    const current = this.d.settings()
    this.d.save({ ...current, enabled: true, keyFingerprint: ResticKeyStore.fingerprint(key), ...(fresh ? { sheetSavedAt: null } : {}) })
    const sheet = fresh || current.sheetSavedAt === null ? await this.saveSheet(destination) : { ok: true as const, path: undefined }

    return { ok: true, created: outcome === 'created', sheetSaved: sheet.ok && Boolean(sheet.path) }
  }

  disable(): void {
    this.d.save({ ...this.d.settings(), enabled: false })
  }

  /** Écrit la feuille de récupération là où l'utilisateur le choisit (boîte native) ; la clé ne sort du main que vers ce fichier. */
  async saveSheet(destination: string): Promise<ResticResult> {
    if (!this.d.keys.has()) return { ok: false, error: 'no-key' }

    const file = await this.d.saveDialog(`Jarod-OS-recuperation-restic-${this.d.instance().slice(0, 8)}.txt`)

    if (!file) return { ok: false, error: 'sheet-cancelled' }

    let key: string

    try {
      key = this.d.keys.read()
    } catch {
      return { ok: false, error: 'key-unreadable' }
    }

    // Jamais à côté du dépôt : la clé et ce qu'elle ouvre ne vont pas au même endroit.
    if (path.resolve(file).toLowerCase().startsWith(path.resolve(destination, RESTIC_FOLDER).toLowerCase())) return { ok: false, error: 'sheet-next-to-repo' }

    fs.writeFileSync(file, recoverySheet(repoFolder(destination, this.d.instance()), key, this.d.instance()), 'utf8')
    this.d.save({ ...this.d.settings(), sheetSavedAt: new Date().toISOString() })

    return { ok: true, path: file }
  }

  /** Archive un dossier de sauvegarde complet (appelé après une sauvegarde réussie, si l'archive est activée). */
  async archive(destination: string, folder: string, signal?: AbortSignal): Promise<{ snapshot: string; bytesAdded: number }> {
    const o = this.options(destination)

    try {
      const r = await archiveBackup({ ...o, ...(signal ? { signal } : {}), folder, instance: this.d.instance() })
      this.d.save({ ...this.d.settings(), last: { at: new Date().toISOString(), ok: true, message: 'archived', snapshot: r.snapshot } })

      return { snapshot: r.snapshot, bytesAdded: r.bytesAdded }
    } catch (error) {
      this.d.save({ ...this.d.settings(), last: { at: new Date().toISOString(), ok: false, message: (error as Error).message.slice(0, 200) } })
      throw error
    }
  }

  async list(destination: string): Promise<ResticSnapshot[]> {
    return (await listSnapshots(this.options(destination))).map(s => ({ id: s.id, time: s.time, backupId: s.backupId, instance: s.instance })).sort((a, b) => b.time.localeCompare(a.time))
  }

  extract(destination: string, snapshot: string): Promise<{ folder: string; cleanup: () => Promise<void> }> {
    if (!/^[a-f0-9]{8,64}$/.test(snapshot)) throw new Error('not-a-snapshot')

    return extractSnapshot({ ...this.options(destination), snapshot })
  }

  check(destination: string): Promise<void> {
    return checkRepo(this.options(destination), '5%')
  }
}
