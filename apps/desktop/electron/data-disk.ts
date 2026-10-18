import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { isRoot, LOCATION_FILE, MARKER, ROOT_FOLDERS, type RootMarker, rootPaths } from './data-root.ts'

/*
 * Choosing and moving to Jarod-OS's own disk (data-root.ts says how the choice is applied at startup). Nothing here
 * formats, partitions or deletes: a move copies, checks the copy, and leaves the old folders where they were.
 */

export type DriveKind = 'fixed' | 'removable' | 'network' | 'other'
export type DriveWarning = 'system' | 'removable' | 'network' | 'fat' | 'lowSpace'

export interface Drive {
  /** "D:" */
  letter: string
  label: string
  fileSystem: string
  free: number
  size: number
  kind: DriveKind
  system: boolean
  warnings: DriveWarning[]
  /** Where Jarod-OS would go on it: "D:\Jarod-OS". */
  suggestedRoot: string
}

/** Below this, environments, backups and VMs will not fit for long. */
export const LOW_SPACE = 64 * 1024 ** 3

const KINDS: Record<number, DriveKind> = { 2: 'removable', 3: 'fixed', 4: 'network' }

/** Win32_LogicalDisk rows (ConvertTo-Json: one object, or an array) → drives Jarod-OS could live on, fixed ones first. */
export function parseDrives(json: string, systemDrive = 'C:'): Drive[] {
  let rows: unknown

  try {
    rows = JSON.parse(json)
  } catch {
    return []
  }

  const list = (Array.isArray(rows) ? rows : [rows]) as Array<Record<string, unknown>>
  const drives: Drive[] = []

  for (const row of list) {
    const letter = typeof row?.DeviceID === 'string' ? row.DeviceID.toUpperCase() : ''
    const type = Number(row?.DriveType)

    // CD/DVD (5) and RAM disks (6) are not places to keep data; a drive without a size has no medium.
    if (!/^[A-Z]:$/.test(letter) || type === 5 || type === 6 || !Number(row?.Size)) {
      continue
    }

    const kind = KINDS[type] ?? 'other'
    const fileSystem = typeof row.FileSystem === 'string' ? row.FileSystem : ''
    const free = Number(row.FreeSpace) || 0
    const system = letter === systemDrive.toUpperCase()
    const warnings: DriveWarning[] = []

    if (system) warnings.push('system')
    if (kind === 'removable') warnings.push('removable')
    if (kind === 'network') warnings.push('network')
    // No permissions, no links, 4 GB files at most on FAT32: VMs and sandboxes need NTFS or ReFS.
    if (/^(fat|fat32|exfat)$/i.test(fileSystem)) warnings.push('fat')
    if (free < LOW_SPACE) warnings.push('lowSpace')

    drives.push({ letter, label: typeof row.VolumeName === 'string' ? row.VolumeName : '', fileSystem, free, size: Number(row.Size), kind, system, warnings, suggestedRoot: `${letter}\\Jarod-OS` })
  }

  const rank = (drive: Drive) => (drive.kind === 'fixed' ? 0 : 1) + (drive.system ? 2 : 0)

  return drives.sort((a, b) => rank(a) - rank(b) || b.free - a.free)
}

export function listDrives(): Promise<Drive[]> {
  if (process.platform !== 'win32') {
    return Promise.resolve([])
  }

  const script = 'Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID, DriveType, FreeSpace, Size, VolumeName, FileSystem | ConvertTo-Json -Compress'

  return new Promise(resolve => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 20_000 }, (error, stdout) => {
      resolve(error ? [] : parseDrives(stdout, process.env.SystemDrive ?? 'C:'))
    })
  })
}

const win = path.win32
const fold = (file: string) => win.normalize(file).replace(/[\\]+$/, '').toLowerCase()
const inside = (parent: string, child: string) => fold(child) === fold(parent) || fold(child).startsWith(`${fold(parent)}\\`)

/** Why `root` cannot hold Jarod-OS, or null. `current` lists the folders in use now (a root cannot sit inside them). */
export function rootProblem(root: string, current: string[], env: NodeJS.ProcessEnv = process.env): string | null {
  if (!/^[a-z]:\\/i.test(root) || root.includes('..')) {
    return 'not-absolute'
  }

  const system = [env.SystemRoot ?? 'C:\\Windows', env.ProgramFiles ?? 'C:\\Program Files', env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', env.ProgramData ?? 'C:\\ProgramData']

  if (system.some(folder => inside(folder, root))) {
    return 'system-folder'
  }

  if (current.some(folder => folder && (inside(folder, root) || inside(root, folder)))) {
    return 'overlaps-current'
  }

  return null
}

export type TargetState = 'empty' | 'adopt' | 'occupied'

/** An empty or missing folder is prepared; a Jarod root is taken as it is; anything else is refused. */
export function inspectTarget(root: string): TargetState {
  if (!fs.existsSync(root)) {
    return 'empty'
  }

  if (isRoot(root)) {
    return 'adopt'
  }

  return fs.readdirSync(root).length === 0 ? 'empty' : 'occupied'
}

export function prepareRoot(root: string, now = new Date()): void {
  for (const folder of Object.values(rootPaths(root, win))) {
    fs.mkdirSync(folder, { recursive: true })
  }

  const marker: RootMarker = { kind: 'jarod-os-root', version: 1, created: now.toISOString() }
  fs.writeFileSync(path.join(root, MARKER), `${JSON.stringify(marker, null, 2)}\n`, 'utf8')
}

const fsp = fs.promises

/** Files and bytes under a folder (links are not followed). */
export async function measure(folder: string): Promise<{ files: number; bytes: number }> {
  let files = 0
  let bytes = 0
  const walk = async (dir: string) => {
    for (const entry of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(dir, entry.name)

      if (entry.isDirectory()) {
        await walk(full)
      } else if (entry.isFile()) {
        files++
        bytes += (await fsp.stat(full)).size
      }
    }
  }

  await walk(folder)

  return { files, bytes }
}

/**
 * Copy `from` into `to` (merged, nothing overwritten) and check that every file arrived with its size. Asynchronous: a
 * large workspace copies while the window stays alive.
 */
export async function copyChecked(from: string, to: string): Promise<{ files: number; bytes: number }> {
  if (!fs.existsSync(from)) {
    return { files: 0, bytes: 0 }
  }

  const before = await measure(from)
  await fsp.cp(from, to, { recursive: true, force: false, errorOnExist: false, preserveTimestamps: true, verbatimSymlinks: true })
  const missing: string[] = []
  const check = async (dir: string) => {
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      const source = path.join(dir, entry.name)
      const target = path.join(to, path.relative(from, source))

      if (entry.isDirectory()) {
        await check(source)
      } else if (entry.isFile()) {
        const copied = await fsp.stat(target).catch(() => null)

        if (!copied || copied.size !== (await fsp.stat(source)).size) {
          missing.push(path.relative(from, source))
        }
      }
    }
  }

  await check(from)

  if (missing.length > 0) {
    throw new Error(`${missing.length} file(s) did not copy, starting with ${missing[0]}`)
  }

  return before
}

export function writeLocation(configDir: string, root: string | null): void {
  fs.mkdirSync(configDir, { recursive: true })
  const file = path.join(configDir, LOCATION_FILE)

  if (root === null) {
    fs.rmSync(file, { force: true })

    return
  }

  fs.writeFileSync(file, `${JSON.stringify({ root }, null, 2)}\n`, 'utf8')
}

export interface MoveResult {
  root: string
  adopted: boolean
  copied: { files: number; bytes: number }
  /** The folders the data was copied from: left in place, for the person to remove once they are sure. */
  oldCopies: string[]
}

/**
 * Make `root` Jarod-OS's disk: adopt it when it already is one, otherwise prepare it and (with `move`) copy the data and
 * the workspace in. The backend must be stopped first (its database is open). The location is written last, so a failed
 * copy changes nothing at the next start.
 */
export async function moveToRoot(options: { root: string; move: boolean; dataDir: string; workspace: string; configDir: string; current: string[] }): Promise<MoveResult> {
  const root = win.normalize(options.root)
  const problem = rootProblem(root, options.current)

  if (problem) {
    throw new Error(problem)
  }

  const state = inspectTarget(root)

  if (state === 'occupied') {
    throw new Error('occupied')
  }

  if (state === 'adopt') {
    writeLocation(options.configDir, root)

    return { root, adopted: true, copied: { files: 0, bytes: 0 }, oldCopies: [] }
  }

  prepareRoot(root)
  const paths = rootPaths(root, win)
  const copied = { files: 0, bytes: 0 }
  const oldCopies: string[] = []

  if (options.move) {
    for (const [from, to] of [
      [options.dataDir, paths.data],
      [options.workspace, paths.workspace]
    ] as const) {
      const done = await copyChecked(from, to)
      copied.files += done.files
      copied.bytes += done.bytes

      if (done.files > 0) {
        oldCopies.push(from)
      }
    }
  }

  writeLocation(options.configDir, root)

  return { root, adopted: false, copied, oldCopies }
}

export { ROOT_FOLDERS }
