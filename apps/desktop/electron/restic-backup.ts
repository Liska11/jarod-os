/**
 * G4 — restic (restic/restic) SOUS la sauvegarde externe existante : dépôt chiffré et dédupliqué des sauvegardes Jarod.
 *
 * Ce module ne refait aucune des garanties de `external-backup.ts`, il les reprend :
 *  - on n'archive qu'un dossier de sauvegarde Jarod COMPLET (manifeste `jarod-backup.json`, statut « complete ») dont chaque fichier a été
 *    relu et comparé à son empreinte (`verifyExternal`) : l'arrêt cohérent du noyau, la base sans les valeurs du coffre, les exclusions
 *    (clés, sessions web, journaux…) sont celles du moteur existant ;
 *  - le manifeste Jarod voyage DANS l'instantané restic : deux formats séparés, le format restic ne remplace pas le manifeste ;
 *  - une restauration extrait l'instantané dans un dossier temporaire puis le revérifie par `verifyExternal` ; la mise en place reste celle du
 *    moteur existant (`stageRestore`, `swapIn` : l'état précédent est gardé à côté) ;
 *  - aucune commande `forget`, `prune`, `unlock --remove-all` ni `init` sur un dépôt existant : `runRestic` refuse toute sous-commande hors liste ;
 *  - la CLÉ du dépôt n'est jamais rangée dans les données sauvegardées : elle est fournie par l'appelant (coffre DPAPI de la coquille, hors
 *    profil) ET rendue une fois sous forme de feuille de récupération à conserver ailleurs ; sans elle, le dépôt est illisible, par conception.
 *  - aucune migration de l'ancien format : les dossiers de sauvegarde existants restent tels quels, restic s'ajoute à côté.
 *  - Limite : les métadonnées Windows (ACL, attributs étendus) ne sont pas présumées conservées ; seules les données et les empreintes du
 *    manifeste font foi.
 */
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { MANIFEST, readManifest, verifyExternal } from './external-backup.ts'

export const RESTIC_FOLDER = 'Jarod-OS-Restic'

/** Les seules sous-commandes permises. Ni forget, ni prune, ni unlock, ni key remove, ni init forcé. */
const ALLOWED = new Set(['version', 'init', 'backup', 'snapshots', 'restore', 'check', 'cat'])

export interface ResticOptions {
  restic: string
  repo: string
  /** Mot de passe du dépôt : passé à l'enfant par `RESTIC_PASSWORD` seulement, jamais en argument, jamais journalisé. */
  password: string
  signal?: AbortSignal
  timeoutMs?: number
  cwd?: string
}

export class ResticError extends Error {}

const ENV_KEEP = ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec', 'TEMP', 'TMP', 'LOCALAPPDATA', 'USERPROFILE']

export function runRestic(o: ResticOptions, args: string[]): Promise<string> {
  const sub = args[0]
  if (!sub || !ALLOWED.has(sub)) return Promise.reject(new ResticError(`sous-commande restic refusée : ${sub ?? '(aucune)'}`))
  const env: Record<string, string> = {}
  for (const k of ENV_KEEP) if (process.env[k] !== undefined) env[k] = process.env[k]!
  Object.assign(env, { RESTIC_REPOSITORY: o.repo, RESTIC_PASSWORD: o.password, RESTIC_PROGRESS_FPS: '0' })
  return new Promise((resolve, reject) => {
    execFile(o.restic, [...args, '--no-cache'], { env, ...(o.cwd ? { cwd: o.cwd } : {}), windowsHide: true, timeout: o.timeoutMs ?? 6 * 3600_000, maxBuffer: 64 * 1024 * 1024, ...(o.signal ? { signal: o.signal } : {}) }, (error, stdout, stderr) => {
      if (error) {
        if (error.name === 'AbortError') return reject(new ResticError('annulé'))
        return reject(new ResticError(`restic ${sub} a échoué : ${String(stderr || error.message).split(o.password).join('[clé]').slice(0, 600)}`))
      }
      resolve(String(stdout))
    })
  })
}

/** Nouvelle clé de dépôt : 32 octets aléatoires. */
export function newRepoKey(): string {
  return randomBytes(32).toString('base64url')
}

/** La feuille de récupération : la clé et ce qu'il faut pour relire le dépôt SANS Jarod. À imprimer ou ranger hors de la machine. */
export function recoverySheet(repo: string, key: string, instance: string): string {
  return [
    'Jarod-OS — feuille de récupération du dépôt restic',
    `Instance : ${instance}`,
    `Dépôt : ${repo}`,
    `Clé du dépôt : ${key}`,
    '',
    'Sans cette clé, le dépôt est illisible : Jarod ne la range pas dans les données sauvegardées.',
    'Relire sans Jarod : restic -r "<dépôt>" snapshots   puis   restic -r "<dépôt>" restore <id> --target <dossier>',
    'Chaque instantané contient un dossier de sauvegarde Jarod et son manifeste jarod-backup.json (empreintes SHA-256).',
  ].join('\r\n')
}

export function repoFolder(destination: string, instance: string): string {
  return path.join(destination, RESTIC_FOLDER, instance)
}

/** Crée le dépôt s'il n'existe pas ; un dépôt existant n'est JAMAIS réinitialisé. */
export async function ensureRepo(o: ResticOptions): Promise<'created' | 'existing'> {
  if (fs.existsSync(path.join(o.repo, 'config'))) {
    await runRestic(o, ['cat', 'config']) // la clé doit l'ouvrir
    return 'existing'
  }
  if (fs.existsSync(o.repo) && fs.readdirSync(o.repo).length) throw new ResticError(`le dossier ${o.repo} existe, n'est pas vide et n'est pas un dépôt restic : rien n'y est écrit`)
  await runRestic(o, ['init'])
  return 'created'
}

export interface ArchiveResult {
  snapshot: string
  backupId: string
  filesNew: number
  bytesAdded: number
}

/** Archive UN dossier de sauvegarde Jarod complet et vérifié. */
export async function archiveBackup(o: ResticOptions & { folder: string; instance: string }): Promise<ArchiveResult> {
  const manifest = readManifest(await fs.promises.readFile(path.join(o.folder, MANIFEST), 'utf8'))
  if (manifest.status !== 'complete') throw new ResticError('sauvegarde incomplète : rien n\'est archivé')
  await verifyExternal(o.folder, o.signal ?? new AbortController().signal, () => {})
  // Lancé DEPUIS le dossier, sur « . » : l'instantané ne contient que la sauvegarde, sans le chemin de la machine.
  const out = await runRestic({ ...o, cwd: o.folder }, ['backup', '--json', '--host', 'jarod-os', '--tag', 'jarod-backup', '--tag', `instance-${o.instance}`, '--tag', `backup-${manifest.id}`, '.'])
  return parseSummary(out, manifest.id)
}

function parseSummary(out: string, backupId: string): ArchiveResult {
  const summary = out
    .split(/\r?\n/)
    .map(l => {
      try {
        return JSON.parse(l) as { message_type?: string; snapshot_id?: string; files_new?: number; data_added?: number }
      } catch {
        return null
      }
    })
    .find(l => l?.message_type === 'summary')
  if (!summary?.snapshot_id) throw new ResticError('restic n\'a pas rendu d\'instantané')
  return { snapshot: summary.snapshot_id, backupId, filesNew: summary.files_new ?? 0, bytesAdded: summary.data_added ?? 0 }
}

export interface SnapshotSummary {
  id: string
  time: string
  backupId: string | null
  instance: string | null
}

export async function listSnapshots(o: ResticOptions): Promise<SnapshotSummary[]> {
  const list = JSON.parse(await runRestic(o, ['snapshots', '--json', '--tag', 'jarod-backup'])) as { short_id?: string; id: string; time: string; tags?: string[] }[]
  return list.map(s => ({
    id: s.id,
    time: s.time,
    backupId: s.tags?.find(t => t.startsWith('backup-'))?.slice(7) ?? null,
    instance: s.tags?.find(t => t.startsWith('instance-'))?.slice(9) ?? null
  }))
}

/**
 * Extrait un instantané dans un dossier temporaire NEUF et le revérifie (manifeste et empreintes). Rend le dossier de sauvegarde prêt pour
 * `stageRestore` / `swapIn`. En cas d'échec, le dossier temporaire est supprimé : rien n'est touché ailleurs.
 */
export async function extractSnapshot(o: ResticOptions & { snapshot: string; into?: string }): Promise<{ folder: string; cleanup: () => Promise<void> }> {
  if (!/^[0-9a-f]{8,64}$/.test(o.snapshot)) throw new ResticError('identifiant d\'instantané invalide')
  const target = await fs.promises.mkdtemp(path.join(o.into ?? os.tmpdir(), 'jarod-restic-restore-'))
  const cleanup = () => fs.promises.rm(target, { recursive: true, force: true, maxRetries: 3 })
  try {
    await runRestic(o, ['restore', o.snapshot, '--target', target])
    const folder = await findBackupFolder(target)
    await verifyExternal(folder, o.signal ?? new AbortController().signal, () => {})
    return { folder, cleanup }
  } catch (error) {
    await cleanup()
    throw error
  }
}

/** Le dossier qui porte `jarod-backup.json` dans l'arbre restauré (restic recrée le chemin d'origine). */
async function findBackupFolder(root: string): Promise<string> {
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop()!
    if (fs.existsSync(path.join(dir, MANIFEST))) return dir
    for (const e of await fs.promises.readdir(dir, { withFileTypes: true })) if (e.isDirectory() && !e.isSymbolicLink()) stack.push(path.join(dir, e.name))
  }
  throw new ResticError('aucun manifeste jarod-backup.json dans l\'instantané')
}

/** Contrôle du dépôt, avec relecture d'une partie des données. */
export async function checkRepo(o: ResticOptions, readSubset = '10%'): Promise<void> {
  if (!/^\d{1,3}%$/.test(readSubset)) throw new ResticError('sous-ensemble invalide')
  await runRestic(o, ['check', `--read-data-subset=${readSubset}`])
}
