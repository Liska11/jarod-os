import fs from 'node:fs'
import path from 'node:path'

/*
 * Backups on the Jarod disk (docs/JAROD-DISK.md): <root>\backups\<id>\{data,workspace,backup.json}.
 *
 * Each backup is a full tree, but a file unchanged since the previous backup (same size and modification time) is a
 * hard link to it instead of a copy, so a daily backup costs only what changed, and any backup can be deleted without
 * touching the others. The core's database is copied with the core stopped (the caller's job); the workspace is copied
 * as it is, without the folders tools rebuild (node_modules, .venv, caches).
 *
 * Restoring never deletes: the current folders are first moved aside into a "before-restore" backup.
 */

export type BackupReason = 'manual' | 'daily' | 'before-restore'

export interface BackupManifest {
  id: string
  created: string
  reason: BackupReason
  /** Which parts the backup holds. */
  parts: Array<'data' | 'workspace'>
  files: number
  bytes: number
  /** Files shared with the previous backup (hard links): they cost no space. */
  linked: number
}

export interface BackupSettings {
  /** A backup at startup when the last one is older than a day. */
  daily: boolean
  /** How many backups to keep (the before-restore ones count too); the oldest go first. */
  keep: number
}

export const DEFAULT_SETTINGS: BackupSettings = { daily: true, keep: 10 }
export const MANIFEST = 'backup.json'
const SETTINGS_FILE = 'settings.json'

/** Folders tools rebuild: never worth a backup. */
export const SKIPPED = new Set(['node_modules', '.venv', 'venv', '__pycache__', '.cache', '.pytest_cache', '.next', '.turbo'])

/** A sortable, filename-safe id: 2026-10-18T09-30-00-000Z-daily. */
export function backupId(now: Date, reason: BackupReason): string {
  return `${now.toISOString().replace(/[:.]/g, '-')}-${reason}`
}

export function readSettings(backupsDir: string): BackupSettings {
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(backupsDir, SETTINGS_FILE), 'utf8')) as Partial<BackupSettings>

    return {
      daily: typeof saved.daily === 'boolean' ? saved.daily : DEFAULT_SETTINGS.daily,
      keep: Number.isInteger(saved.keep) && (saved.keep as number) >= 1 && (saved.keep as number) <= 365 ? (saved.keep as number) : DEFAULT_SETTINGS.keep
    }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export function writeSettings(backupsDir: string, settings: BackupSettings): void {
  fs.mkdirSync(backupsDir, { recursive: true })
  fs.writeFileSync(path.join(backupsDir, SETTINGS_FILE), `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
}

/** Finished backups, newest first (a folder without its manifest is an interrupted one and is ignored). */
export function listBackups(backupsDir: string): BackupManifest[] {
  if (!fs.existsSync(backupsDir)) {
    return []
  }

  const list: BackupManifest[] = []

  for (const entry of fs.readdirSync(backupsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue
    }

    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(backupsDir, entry.name, MANIFEST), 'utf8')) as BackupManifest

      if (manifest.id === entry.name) {
        list.push(manifest)
      }
    } catch {
      // Interrupted or foreign: not a backup.
    }
  }

  return list.sort((a, b) => b.created.localeCompare(a.created))
}

/** A daily backup is due when there is none from the last 24 hours. */
export function dailyDue(backups: readonly BackupManifest[], now: Date): boolean {
  const last = backups[0]

  return !last || now.getTime() - Date.parse(last.created) >= 24 * 3600 * 1000
}

interface CopyStats {
  files: number
  bytes: number
  linked: number
}

/** Copy `from` into `to`, hard-linking files unchanged since `previous` (the same part of the last backup). */
export function snapshot(from: string, to: string, previous: string | null, stats: CopyStats = { files: 0, bytes: 0, linked: 0 }): CopyStats {
  if (!fs.existsSync(from)) {
    return stats
  }

  fs.mkdirSync(to, { recursive: true })

  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name)
    const target = path.join(to, entry.name)
    const before = previous ? path.join(previous, entry.name) : null

    if (entry.isDirectory()) {
      if (!SKIPPED.has(entry.name)) {
        snapshot(source, target, before, stats)
      }

      continue
    }

    if (!entry.isFile()) {
      continue
    }

    const stat = fs.statSync(source)
    const old = before ? fs.statSync(before, { throwIfNoEntry: false }) : undefined
    stats.files++
    stats.bytes += stat.size

    if (old?.isFile() && old.size === stat.size && Math.abs(old.mtimeMs - stat.mtimeMs) < 2) {
      try {
        fs.linkSync(before as string, target)
        stats.linked++

        continue
      } catch {
        // Another volume, or a file system without hard links: copy it.
      }
    }

    fs.copyFileSync(source, target)
    fs.utimesSync(target, stat.atime, stat.mtime)
  }

  return stats
}

/**
 * Back up `parts` (folder per part) into a new backup and write its manifest last: until then the folder is an
 * interrupted backup that listBackups ignores. Returns the manifest. The data part comes first: the caller stops the
 * core for it and starts it again in `afterData`.
 */
export async function createBackup(
  backupsDir: string,
  parts: Partial<Record<'data' | 'workspace', string>>,
  reason: BackupReason,
  now = new Date(),
  /** Called once the data part is copied: the core, stopped for it, may start again while the workspace copies. */
  afterData?: () => void | Promise<void>
): Promise<BackupManifest> {
  const id = backupId(now, reason)
  const folder = path.join(backupsDir, id)
  const previous = listBackups(backupsDir)[0]
  const stats: CopyStats = { files: 0, bytes: 0, linked: 0 }
  const done: Array<'data' | 'workspace'> = []

  fs.mkdirSync(folder, { recursive: true })

  for (const part of ['data', 'workspace'] as const) {
    const source = parts[part]

    if (source && fs.existsSync(source)) {
      snapshot(source, path.join(folder, part), previous?.parts.includes(part) ? path.join(backupsDir, previous.id, part) : null, stats)
      done.push(part)
    }

    if (part === 'data') {
      await afterData?.()
    }
  }

  const manifest: BackupManifest = { id, created: now.toISOString(), reason, parts: done, ...stats }
  fs.writeFileSync(path.join(folder, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  return manifest
}

/** The backups to remove so that `keep` remain (oldest first); `protect` is never one of them. */
export function toPrune(backups: readonly BackupManifest[], keep: number, protect?: string): BackupManifest[] {
  return backups.filter(backup => backup.id !== protect).slice(Math.max(0, keep - (protect ? 1 : 0)))
}

export function removeBackup(backupsDir: string, id: string): void {
  if (!/^[\w-]+$/.test(id)) {
    throw new Error('not a backup')
  }

  fs.rmSync(path.join(backupsDir, id), { recursive: true, force: true })
}

/**
 * Put a backup back: the current folders move aside into a "before-restore" backup (a rename, nothing is deleted),
 * then the backup's parts are copied in place. The core must be stopped, and Jarod-OS restarted afterwards.
 */
export function restoreBackup(backupsDir: string, id: string, targets: Partial<Record<'data' | 'workspace', string>>, now = new Date()): { aside: string } {
  const backup = listBackups(backupsDir).find(item => item.id === id)

  if (!backup) {
    throw new Error('no such backup')
  }

  const asideId = backupId(now, 'before-restore')
  const aside = path.join(backupsDir, asideId)
  const parts = backup.parts.filter(part => targets[part])
  fs.mkdirSync(aside, { recursive: true })
  const stats: CopyStats = { files: 0, bytes: 0, linked: 0 }

  for (const part of parts) {
    const target = targets[part] as string

    if (fs.existsSync(target)) {
      // Same volume (both on the Jarod disk): a rename, instant and lossless; across volumes, a copy.
      try {
        fs.renameSync(target, path.join(aside, part))
      } catch {
        snapshot(target, path.join(aside, part), null, stats)
        fs.rmSync(target, { recursive: true, force: true })
      }
    }

    fs.cpSync(path.join(backupsDir, id, part), target, { recursive: true, preserveTimestamps: true })
  }

  const manifest: BackupManifest = { id: asideId, created: now.toISOString(), reason: 'before-restore', parts, ...stats }
  fs.writeFileSync(path.join(aside, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  return { aside: asideId }
}
