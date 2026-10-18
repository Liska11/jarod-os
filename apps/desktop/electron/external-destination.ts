import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { DestinationCheck } from '../shared/external-backup.ts'

/*
 * Where an external backup may go (docs/BACKUP-EXTERNE.md). Unlike the Jarod disk, a removable drive is fine (that is the point), and
 * so is any file system that can hold the files, with warnings. Refused: system folders, a relative or network path, and any folder that
 * is inside what is being backed up or contains it, compared after resolving links and junctions. A volume is recognised by its unique
 * id, not by its letter: a different disk plugged in under the same letter is not taken for the chosen one.
 */

export interface Volume {
  letter: string
  uniqueId: string | null
  fileSystem: string
  driveType: string
  free: number
  size: number
  label: string
  /** The physical disk number, when Windows gives it (not for every kind of drive). */
  disk: number | null
}

export function parseVolumes(json: string): Volume[] {
  let rows: unknown

  try {
    rows = JSON.parse(json)
  } catch {
    return []
  }

  const list = (Array.isArray(rows) ? rows : [rows]) as Array<Record<string, unknown>>

  return list
    .filter(row => row && typeof row.Letter === 'string' && /^[A-Za-z]$/.test(row.Letter))
    .map(row => ({
      letter: `${String(row.Letter).toUpperCase()}:`,
      uniqueId: typeof row.UniqueId === 'string' && row.UniqueId ? row.UniqueId : null,
      fileSystem: typeof row.FileSystem === 'string' ? row.FileSystem : '',
      driveType: typeof row.DriveType === 'string' ? row.DriveType : '',
      free: Number(row.Free) || 0,
      size: Number(row.Size) || 0,
      label: typeof row.Label === 'string' ? row.Label : '',
      disk: typeof row.Disk === 'number' ? row.Disk : null
    }))
}

const SCRIPT = [
  'Get-Volume | Where-Object DriveLetter | ForEach-Object {',
  '  $p = Get-Partition -DriveLetter $_.DriveLetter -ErrorAction SilentlyContinue',
  '  [pscustomobject]@{ Letter = [string]$_.DriveLetter; UniqueId = [string]$_.UniqueId; FileSystem = [string]$_.FileSystemType; DriveType = [string]$_.DriveType;',
  '    Free = [double]$_.SizeRemaining; Size = [double]$_.Size; Label = [string]$_.FileSystemLabel; Disk = $(if ($p) { [int]$p.DiskNumber } else { $null }) }',
  '} | ConvertTo-Json -Compress'
].join('\n')

export function readVolumes(): Promise<Volume[]> {
  if (process.platform !== 'win32') return Promise.resolve([])

  return new Promise(resolve => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', SCRIPT], { windowsHide: true, timeout: 30_000 }, (error, stdout) => resolve(error ? [] : parseVolumes(stdout)))
  })
}

const win = path.win32
const fold = (file: string) => win.normalize(file).replace(/[\\]+$/, '').toLowerCase()
const inside = (parent: string, child: string) => fold(child) === fold(parent) || fold(child).startsWith(`${fold(parent)}\\`)

/** The real path of `file`, or of its nearest existing parent with the rest appended (links and junctions resolved). */
export function realish(file: string): string {
  let current = win.resolve(file)
  const tail: string[] = []

  for (;;) {
    try {
      return win.join(fs.realpathSync.native(current), ...tail.reverse())
    } catch {
      const parent = win.dirname(current)

      if (parent === current) return win.resolve(file)
      tail.push(win.basename(current))
      current = parent
    }
  }
}

export function volumeOf(file: string, volumes: Volume[]): Volume | null {
  const letter = /^([a-z]):/i.exec(file)?.[1]?.toUpperCase()

  return letter ? (volumes.find(v => v.letter === `${letter}:`) ?? null) : null
}

/** Checks a destination folder. `sources` are the folders being backed up; `estimate` the bytes to write (null: unknown yet). */
export function checkDestination(dest: string, volumes: Volume[], sources: string[], estimate: number | null, env: NodeJS.ProcessEnv = process.env): DestinationCheck {
  const problems: string[] = []
  const warnings: string[] = []

  if (!/^[a-z]:\\/i.test(dest) || dest.includes('..')) {
    return { ok: false, problems: ['not-absolute'], warnings, free: null, fileSystem: null }
  }

  const real = realish(dest)
  const system = [env.SystemRoot ?? 'C:\\Windows', env.ProgramFiles ?? 'C:\\Program Files', env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', env.ProgramData ?? 'C:\\ProgramData']

  if (system.some(folder => inside(folder, real) || inside(folder, dest))) problems.push('system-folder')
  if (sources.some(source => source && (inside(realish(source), real) || inside(real, realish(source))))) problems.push('inside-sources')

  const volume = volumeOf(real, volumes)

  if (!volume) {
    problems.push('no-volume')

    return { ok: false, problems, warnings, free: null, fileSystem: null }
  }

  if (/^(fat|fat32)$/i.test(volume.fileSystem)) warnings.push('fat')
  if (/^exfat$/i.test(volume.fileSystem)) warnings.push('exfat')
  if (/network|remote/i.test(volume.driveType)) warnings.push('network')

  const sourceDisks = new Set(sources.map(source => volumeOf(realish(source), volumes)?.disk).filter((disk): disk is number => typeof disk === 'number'))

  if (volume.disk !== null && sourceDisks.has(volume.disk)) warnings.push('same-disk')
  if (estimate !== null && volume.free < estimate * 1.05 + 256 * 1024 ** 2) problems.push('no-space')

  return { ok: problems.length === 0, problems, warnings, free: volume.free, fileSystem: volume.fileSystem }
}
