import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import type { ExternalBackupSummary, ExternalFileEntry, ExternalManifest, ExternalPart } from '../shared/external-backup.ts'

/*
 * External backups (docs/BACKUP-EXTERNE.md): independent snapshots of Jarod-OS on another disk, distinct from the Jarod disk's own
 * backups and from moving the Jarod disk. Each backup is a new folder <dest>\Jarod-OS-Backups\<instance>\<id>, built as <id>.incomplete
 * and renamed only once every file was copied, hashed and read back: an incomplete folder is never listed, never restored. Nothing is
 * mirrored, nothing old is pruned, nothing outside the operation's own folder is ever removed.
 */

export const BACKUPS_FOLDER = 'Jarod-OS-Backups'
/** The manifest of one backup: distinct from the active install's `.jarod-os-root.json`, so a backup is never taken for an install. */
export const MANIFEST = 'jarod-backup.json'
/** Written first in an <id>.incomplete folder: proves the folder is this operation's, before anything removes it. */
export const OPERATION = 'jarod-backup-operation.json'
export const INCOMPLETE = '.incomplete'
const ID = /^\d{8}-\d{6}-[a-z0-9]{6}$/
const INSTANCE = /^[a-f0-9-]{36}$/

/** Folders rebuilt by their tools: never backed up (named in the manifest's exclusions). */
export const REBUILDABLE = new Set(['node_modules', '.venv', 'venv', '__pycache__', '.cache', '.pytest_cache', '.next', '.turbo'])

export interface PartSource {
  part: ExternalPart
  dir: string
  /** Whether a file (relative path, forward slashes) of this part is left out, with the reason; null keeps it. */
  exclude?: (rel: string, name: string) => string | null
}

export interface PlannedFile {
  part: ExternalPart
  /** Path inside the backup: <part>/<relative path>. */
  rel: string
  abs: string
  size: number
  /** Database files copied through the core's snapshot (no secret values), not byte for byte. */
  snapshot?: boolean
}

export interface Plan {
  files: PlannedFile[]
  bytes: number
  excluded: string[]
}

/**
 * The data part's rules: the core's databases go through a snapshot without the vault's values; their journals are in that snapshot;
 * internal safety copies of a database (`*.avant-*`, `backups/*.bak`) hold the vault and are left out; so are web sessions and logs.
 */
export function dataExclusion(rel: string, name: string): string | null {
  const lower = name.toLowerCase()

  if (/\.db(-wal|-shm)?\.avant-/i.test(name) || /\.avant-[\w-]+$/i.test(name) || /(^|\/)backups\/[^/]+\.bak$/i.test(rel)) return 'copies de sécurité internes de la base (elles contiennent le coffre)'
  if (rel.split('/')[0] === 'herald-userdata') return 'sessions web du navigateur intégré'
  if (lower === '.env' || lower === 'auth.json') return 'fichiers de clés en clair'
  if (lower.endsWith('.log')) return 'journaux (régénérés)'

  return null
}

const isJournal = (name: string) => /^jarod\.db-(wal|shm)$/i.test(name)

/** Walks the parts: regular files only. Links and junctions are never followed (a loop or a way out of the part), only reported. */
export async function planBackup(sources: PartSource[]): Promise<Plan> {
  const files: PlannedFile[] = []
  const excluded = new Set<string>()
  let bytes = 0

  const walk = async (source: PartSource, dir: string, rel: string): Promise<void> => {
    let entries: fs.Dirent[]

    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }

    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name
      const abs = path.join(dir, entry.name)
      const stat = await fs.promises.lstat(abs)

      if (stat.isSymbolicLink()) {
        excluded.add(`liens et jonctions (non suivis) : ${source.part}/${childRel}`)
        continue
      }

      if (stat.isDirectory()) {
        if (REBUILDABLE.has(entry.name)) {
          excluded.add(`dossiers reconstruits par leurs outils (${entry.name})`)
          continue
        }

        await walk(source, abs, childRel)
        continue
      }

      if (!stat.isFile()) continue

      if (source.part === 'data' && isJournal(entry.name)) continue

      const reason = source.exclude?.(childRel, entry.name) ?? null

      if (reason) {
        excluded.add(reason)
        continue
      }

      const snapshot = source.part === 'data' && entry.name.toLowerCase() === 'jarod.db'
      files.push({ part: source.part, rel: `${source.part}/${childRel}`, abs, size: stat.size, ...(snapshot ? { snapshot } : {}) })
      bytes += stat.size
    }
  }

  for (const source of sources) {
    await walk(source, source.dir, '')
  }

  return { files, bytes, excluded: [...excluded].sort() }
}

export function newBackupId(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`

  return `${stamp}-${randomUUID().replace(/-/g, '').slice(0, 6)}`
}

export function instanceFolder(destination: string, instance: string): string {
  if (!INSTANCE.test(instance)) throw new Error('identifiant d’instance invalide')

  return path.join(destination, BACKUPS_FOLDER, instance)
}

/** Copies a file while hashing it; the signal is checked between chunks. */
export async function copyHashed(src: string, dest: string, signal: AbortSignal, onBytes: (n: number) => void): Promise<string> {
  const hash = createHash('sha256')
  const tap = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      if (signal.aborted) {
        done(new Error('annulé'))

        return
      }

      hash.update(chunk)
      onBytes(chunk.length)
      done(null, chunk)
    }
  })
  await fs.promises.mkdir(path.dirname(dest), { recursive: true })
  // `wx`: never overwrites (a backup folder is new; a file already there is an error, not something to replace).
  await pipeline(fs.createReadStream(src), tap, fs.createWriteStream(dest, { flags: 'wx' }), { signal })

  return hash.digest('hex')
}

export async function hashFile(file: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256')

  for await (const chunk of fs.createReadStream(file, signal ? { signal } : {})) {
    hash.update(chunk as Buffer)
  }

  return hash.digest('hex')
}

export interface BackupHooks {
  signal: AbortSignal
  /** Database snapshot without the vault's values (the core's maintenance mode); resolves with how many values were removed. */
  snapshotDb: (src: string, dest: string) => Promise<number>
  progress: (phase: 'copying' | 'snapshot' | 'verifying' | 'finishing', done: number, total: number, current: string) => void
  /** Called once the data part is copied: the core may start again before the workspace is copied. */
  afterData?: () => void
}

export interface BackupRequest {
  destination: string
  instance: string
  app: string
  reason: 'manual' | 'auto'
  parts: ExternalPart[]
  plan: Plan
  now?: Date
}

/**
 * Makes one backup. Files are copied and hashed, the databases snapshotted, then every file is read back from the destination and its
 * hash compared; only then is the manifest written and the folder renamed to its final name. On any failure or cancellation, the
 * operation's own <id>.incomplete folder is removed (its OPERATION file proves it is), and the error is rethrown.
 */
export async function makeBackup(request: BackupRequest, hooks: BackupHooks): Promise<ExternalManifest> {
  const id = newBackupId(request.now)
  const parent = instanceFolder(request.destination, request.instance)
  const work = path.join(parent, `${id}${INCOMPLETE}`)
  const operation = randomUUID()
  await fs.promises.mkdir(work, { recursive: true })
  await fs.promises.writeFile(path.join(work, OPERATION), JSON.stringify({ operation, id, started: new Date().toISOString() }), { flag: 'wx' })

  try {
    const entries: ExternalFileEntry[] = []
    const total = request.plan.bytes
    let done = 0
    let secretsRemoved = 0
    let dataDone = false
    const vanished: string[] = []
    const ordered = [...request.plan.files].sort((a, b) => order(a.part) - order(b.part))

    for (const file of ordered) {
      if (hooks.signal.aborted) throw new Error('annulé')

      if (!dataDone && file.part !== 'data') {
        dataDone = true
        hooks.afterData?.()
      }

      const dest = path.join(work, ...file.rel.split('/'))

      if (file.snapshot) {
        hooks.progress('snapshot', done, total, file.rel)
        await fs.promises.mkdir(path.dirname(dest), { recursive: true })
        secretsRemoved += await hooks.snapshotDb(file.abs, dest)
        const size = (await fs.promises.stat(dest)).size
        entries.push({ path: file.rel, size, sha256: await hashFile(dest, hooks.signal) })
        done += file.size
        continue
      }

      hooks.progress('copying', done, total, file.rel)
      let sha256: string

      try {
        sha256 = await copyHashed(file.abs, dest, hooks.signal, n => {
          done += n
        })
      } catch (error) {
        // A file removed between the listing and its copy (a temporary file of a program): noted, not an error.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !fs.existsSync(file.abs)) {
          vanished.push(file.rel)
          await fs.promises.rm(dest, { force: true })
          continue
        }

        throw error
      }
      const size = (await fs.promises.stat(dest)).size

      if (size !== file.size) {
        throw new Error(`${file.rel} a changé pendant la copie (${file.size} → ${size} octets)`)
      }

      entries.push({ path: file.rel, size, sha256 })
    }

    if (!dataDone) hooks.afterData?.()

    // Read everything back from the destination: what the disk holds, not what was sent.
    let checked = 0
    const bytes = entries.reduce((sum, entry) => sum + entry.size, 0)

    for (const entry of entries) {
      if (hooks.signal.aborted) throw new Error('annulé')
      hooks.progress('verifying', checked, bytes, entry.path)
      const actual = await hashFile(path.join(work, ...entry.path.split('/')), hooks.signal)

      if (actual !== entry.sha256) throw new Error(`${entry.path} relu différent de ce qui a été écrit`)
      checked += entry.size
    }

    hooks.progress('finishing', bytes, bytes, MANIFEST)
    const manifest: ExternalManifest = {
      format: 1,
      app: request.app,
      id,
      instance: request.instance,
      created: (request.now ?? new Date()).toISOString(),
      reason: request.reason,
      status: 'complete',
      parts: request.parts,
      excluded: vanished.length ? [...request.plan.excluded, `fichiers disparus pendant la copie : ${vanished.slice(0, 20).join(', ')}`] : request.plan.excluded,
      secretsRemoved,
      files: entries,
      bytes
    }
    await fs.promises.writeFile(path.join(work, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' })
    await fs.promises.rm(path.join(work, OPERATION))
    await fs.promises.rename(work, path.join(parent, id))

    return manifest
  } catch (error) {
    await removeOwnIncomplete(work, operation)
    throw error
  }
}

const order = (part: ExternalPart) => ['data', 'config', 'workspace', 'environments', 'sandboxes', 'vms'].indexOf(part)

/** Removes an <id>.incomplete folder only when its OPERATION file names `operation` (or, for leftovers, any operation of ours). */
export async function removeOwnIncomplete(folder: string, operation: string | null): Promise<boolean> {
  if (!path.basename(folder).endsWith(INCOMPLETE) || !ID.test(path.basename(folder).slice(0, -INCOMPLETE.length))) return false

  try {
    const marker = JSON.parse(await fs.promises.readFile(path.join(folder, OPERATION), 'utf8')) as { operation?: unknown }

    if (typeof marker.operation !== 'string' || (operation !== null && marker.operation !== operation)) return false
  } catch {
    return false
  }

  await fs.promises.rm(folder, { recursive: true, force: true, maxRetries: 3 })

  return true
}

/** Leftovers of interrupted backups (a crash, a disk pulled out) in this instance's folder: ours, so removed. */
export async function cleanLeftovers(destination: string, instance: string): Promise<number> {
  const parent = instanceFolder(destination, instance)
  let removed = 0

  for (const name of await fs.promises.readdir(parent).catch(() => [] as string[])) {
    if (name.endsWith(INCOMPLETE) && (await removeOwnIncomplete(path.join(parent, name), null))) removed++
  }

  return removed
}

/** The complete backups under a destination, every instance (a fresh install restores from any), newest first. */
export async function listExternal(destination: string): Promise<ExternalBackupSummary[]> {
  const root = path.join(destination, BACKUPS_FOLDER)
  const list: ExternalBackupSummary[] = []

  for (const instance of await fs.promises.readdir(root).catch(() => [] as string[])) {
    if (!INSTANCE.test(instance)) continue

    for (const id of await fs.promises.readdir(path.join(root, instance)).catch(() => [] as string[])) {
      if (!ID.test(id)) continue

      const folder = path.join(root, instance, id)

      try {
        const manifest = readManifest(await fs.promises.readFile(path.join(folder, MANIFEST), 'utf8'))

        if (manifest.id === id && manifest.instance === instance) {
          list.push({ id, instance, created: manifest.created, reason: manifest.reason, parts: manifest.parts, files: manifest.files.length, bytes: manifest.bytes, folder })
        }
      } catch {
        // No manifest, or a damaged one: not a restorable backup.
      }
    }
  }

  return list.sort((a, b) => b.created.localeCompare(a.created))
}

const PARTS = new Set(['data', 'workspace', 'config', 'environments', 'sandboxes', 'vms'])

/** A relative path a manifest may hold: inside a known part, no absolute path, drive, `..`, empty or odd segment. */
export function safeRelative(rel: string): boolean {
  if (typeof rel !== 'string' || !rel || rel.length > 1024 || rel.includes('\\') || rel.startsWith('/') || /^[a-zA-Z]:/.test(rel) || rel.includes('\u0000')) return false

  const segments = rel.split('/')

  return PARTS.has(segments[0]) && segments.length >= 2 && segments.every(s => s !== '' && s !== '.' && s !== '..' && !/[<>:"|?*]/.test(s))
}

/** Parses and checks a manifest: format, status, and every path safe. Throws on anything else. */
export function readManifest(text: string): ExternalManifest {
  const raw = JSON.parse(text) as ExternalManifest

  if (raw?.format !== 1 || raw.status !== 'complete' || !ID.test(String(raw.id)) || !INSTANCE.test(String(raw.instance)) || !Array.isArray(raw.files) || !Array.isArray(raw.parts)) {
    throw new Error('manifeste invalide ou sauvegarde incomplète')
  }

  for (const file of raw.files) {
    if (!safeRelative(file?.path) || !Number.isSafeInteger(file.size) || file.size < 0 || !/^[a-f0-9]{64}$/.test(String(file.sha256))) {
      throw new Error(`entrée refusée dans le manifeste : ${String(file?.path).slice(0, 120)}`)
    }
  }

  if (!raw.parts.every(part => PARTS.has(part))) throw new Error('partie inconnue dans le manifeste')

  return raw
}

/** Checks a backup on its disk: manifest, then each file present, a regular file (no link), with its size and hash. */
export async function verifyExternal(folder: string, signal: AbortSignal, progress: (done: number, total: number, current: string) => void): Promise<ExternalManifest> {
  const manifest = readManifest(await fs.promises.readFile(path.join(folder, MANIFEST), 'utf8'))
  let done = 0

  for (const file of manifest.files) {
    if (signal.aborted) throw new Error('annulé')
    progress(done, manifest.bytes, file.path)
    const abs = path.join(folder, ...file.path.split('/'))
    const stat = await fs.promises.lstat(abs).catch(() => null)

    if (!stat || !stat.isFile()) throw new Error(`${file.path} manque ou n’est pas un fichier ordinaire`)
    if (stat.size !== file.size) throw new Error(`${file.path} n’a plus sa taille d’origine`)
    if ((await hashFile(abs, signal)) !== file.sha256) throw new Error(`${file.path} est abîmé (empreinte différente)`)
    done += file.size
  }

  return manifest
}

/**
 * Copies a verified backup's parts into staging folders (one per part, next to its target so the swap is a rename on one volume), each file
 * hashed again on arrival. Returns the staging folders by part. On failure the staging folders are removed (they are this operation's).
 */
export async function stageRestore(folder: string, manifest: ExternalManifest, targets: Partial<Record<ExternalPart, string>>, tag: string, signal: AbortSignal, progress: (done: number, total: number, current: string) => void): Promise<Partial<Record<ExternalPart, string>>> {
  const staging: Partial<Record<ExternalPart, string>> = {}

  for (const part of manifest.parts) {
    const target = targets[part]

    if (target) {
      staging[part] = `${target}.restoring-${tag}`
    }
  }

  try {
    for (const dir of Object.values(staging)) {
      await fs.promises.mkdir(dir as string, { recursive: false })
    }

    let done = 0

    for (const file of manifest.files) {
      const [part, ...rest] = file.path.split('/') as [ExternalPart, ...string[]]
      const base = staging[part]

      if (!base) continue
      progress(done, manifest.bytes, file.path)
      const dest = path.join(base, ...rest)
      const sha = await copyHashed(path.join(folder, ...file.path.split('/')), dest, signal, n => {
        done += n
      })

      if (sha !== file.sha256) throw new Error(`${file.path} : la copie de préparation diffère de la sauvegarde`)
    }

    return staging
  } catch (error) {
    for (const dir of Object.values(staging)) {
      await fs.promises.rm(dir as string, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined)
    }

    throw error
  }
}

/**
 * Puts the staged parts in place: each current folder is renamed aside (`<target>.before-restore-<tag>`, kept: the previous state, never
 * deleted by Jarod), then the staged one takes its name. If any rename fails, what was done is undone in reverse order.
 */
export async function swapIn(staging: Partial<Record<ExternalPart, string>>, targets: Partial<Record<ExternalPart, string>>, tag: string): Promise<{ aside: string[] }> {
  const done: Array<{ target: string; aside: string | null; staged: string }> = []

  try {
    for (const [part, staged] of Object.entries(staging) as Array<[ExternalPart, string]>) {
      const target = targets[part] as string
      const aside = fs.existsSync(target) ? `${target}.before-restore-${tag}` : null

      if (aside) await fs.promises.rename(target, aside)
      done.push({ target, aside, staged })
      await fs.promises.rename(staged, target)
    }
  } catch (error) {
    for (const step of done.reverse()) {
      if (fs.existsSync(step.target) && !fs.existsSync(step.staged)) await fs.promises.rename(step.target, step.staged).catch(() => undefined)
      if (step.aside && fs.existsSync(step.aside) && !fs.existsSync(step.target)) await fs.promises.rename(step.aside, step.target).catch(() => undefined)
    }

    throw error
  }

  return { aside: done.flatMap(step => (step.aside ? [step.aside] : [])) }
}
