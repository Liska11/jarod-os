import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { copyChecked, inspectTarget, LOW_SPACE, moveToRoot, parseDrives, rootProblem } from './data-disk.ts'
import { applyDataRoot, LOCATION_FILE, MARKER, readLocation } from './data-root.ts'

const GB = 1024 ** 3

describe('parseDrives', () => {
  const rows = JSON.stringify([
    { DeviceID: 'C:', DriveType: 3, FreeSpace: 80 * GB, Size: 500 * GB, VolumeName: 'Windows', FileSystem: 'NTFS' },
    { DeviceID: 'D:', DriveType: 3, FreeSpace: 900 * GB, Size: 1000 * GB, VolumeName: 'Jarod', FileSystem: 'NTFS' },
    { DeviceID: 'E:', DriveType: 2, FreeSpace: 20 * GB, Size: 32 * GB, VolumeName: 'USB', FileSystem: 'FAT32' },
    { DeviceID: 'F:', DriveType: 5, FreeSpace: 0, Size: 4 * GB, VolumeName: 'DVD', FileSystem: 'UDF' },
    { DeviceID: 'Z:', DriveType: 4, FreeSpace: 2000 * GB, Size: 4000 * GB, VolumeName: 'NAS', FileSystem: 'NTFS' },
    { DeviceID: 'G:', DriveType: 2, FreeSpace: null, Size: null, VolumeName: null, FileSystem: null }
  ])

  it('keeps the drives data can live on, the best first, with what to warn about', async () => {
    const drives = parseDrives(rows, 'C:')

    expect(drives.map(d => d.letter)).toEqual(['D:', 'Z:', 'E:', 'C:'])
    expect(drives[0]).toMatchObject({ kind: 'fixed', system: false, warnings: [], suggestedRoot: 'D:\\Jarod-OS' })
    expect(drives.find(d => d.letter === 'C:')?.warnings).toEqual(['system'])
    expect(drives.find(d => d.letter === 'E:')?.warnings).toEqual(['removable', 'fat', 'lowSpace'])
    expect(drives.find(d => d.letter === 'Z:')?.warnings).toEqual(['network'])
  })

  it('reads a single drive (ConvertTo-Json gives an object) and survives garbage', async () => {
    expect(parseDrives(JSON.stringify({ DeviceID: 'D:', DriveType: 3, FreeSpace: LOW_SPACE - 1, Size: 100 * GB, FileSystem: 'ReFS' }))).toMatchObject([{ letter: 'D:', warnings: ['lowSpace'] }])
    expect(parseDrives('not json')).toEqual([])
  })
})

describe('rootProblem', () => {
  const env = { SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', ProgramData: 'C:\\ProgramData' }

  it('accepts a folder on another drive', async () => {
    expect(rootProblem('D:\\Jarod-OS', ['C:\\Users\\me\\AppData\\Local\\Jarod-OS'], env)).toBeNull()
  })

  it('refuses relative paths, system folders and the folders in use', async () => {
    expect(rootProblem('Jarod-OS', [], env)).toBe('not-absolute')
    expect(rootProblem('\\\\nas\\share', [], env)).toBe('not-absolute')
    expect(rootProblem('C:\\Program Files\\Jarod', [], env)).toBe('system-folder')
    expect(rootProblem('c:\\windows\\x', [], env)).toBe('system-folder')
    expect(rootProblem('C:\\Users\\me\\AppData\\Local\\Jarod-OS\\disk', ['C:\\Users\\me\\AppData\\Local\\Jarod-OS'], env)).toBe('overlaps-current')
    expect(rootProblem('D:\\', ['D:\\Jarod-OS\\data'], env)).toBe('overlaps-current')
  })
})

describe('moving to a Jarod disk', () => {
  let base: string
  let dataDir: string
  let workspace: string
  let configDir: string

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'jarod-disk-test-'))
    dataDir = path.join(base, 'old', 'data')
    workspace = path.join(base, 'old', 'workspace')
    configDir = path.join(base, 'config')
    fs.mkdirSync(path.join(dataDir, 'profile'), { recursive: true })
    fs.writeFileSync(path.join(dataDir, 'profile', 'jarod.db'), 'database')
    fs.mkdirSync(workspace, { recursive: true })
    fs.writeFileSync(path.join(workspace, 'notes.md'), '# notes')
  })

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true })
  })

  const current = () => [dataDir, workspace]

  it('prepares the root, copies the data and workspace, keeps the old copies and records the choice', async () => {
    const root = path.join(base, 'disk', 'Jarod-OS')
    const result = await moveToRoot({ root, move: true, dataDir, workspace, configDir, current: current() })

    expect(result).toMatchObject({ adopted: false, copied: { files: 2 }, oldCopies: [dataDir, workspace] })
    expect(fs.readFileSync(path.join(root, 'data', 'profile', 'jarod.db'), 'utf8')).toBe('database')
    expect(fs.readFileSync(path.join(root, 'workspace', 'notes.md'), 'utf8')).toBe('# notes')
    for (const folder of ['environments', 'backups', 'sandboxes', 'vms']) {
      expect(fs.statSync(path.join(root, folder)).isDirectory()).toBe(true)
    }
    expect(fs.existsSync(path.join(dataDir, 'profile', 'jarod.db'))).toBe(true)
    expect(readLocation(configDir)).toBe(root)
  })

  it('applies the recorded root at startup through the environment', async () => {
    const root = path.join(base, 'disk', 'Jarod-OS')
    await moveToRoot({ root, move: false, dataDir, workspace, configDir, current: current() })
    const env: NodeJS.ProcessEnv = {}

    expect(applyDataRoot(configDir, env)).toEqual({ kind: 'root', root })
    expect(env).toMatchObject({ JAROD_OS_ROOT: root, JAROD_OS_DATA: path.join(root, 'data'), JAROD_WORKSPACE: path.join(root, 'workspace') })
  })

  it('lets the environment win, and reports a root that is not there', async () => {
    fs.mkdirSync(configDir, { recursive: true })
    fs.writeFileSync(path.join(configDir, LOCATION_FILE), JSON.stringify({ root: 'Q:\\Jarod-OS' }))

    expect(applyDataRoot(configDir, { JAROD_OS_DATA: 'X:\\tests' })).toEqual({ kind: 'environment' })
    const env: NodeJS.ProcessEnv = {}
    expect(applyDataRoot(configDir, env)).toEqual({ kind: 'missing', root: 'Q:\\Jarod-OS' })
    expect(env.JAROD_OS_DATA).toBeUndefined()
    expect(applyDataRoot(path.join(base, 'nowhere'), {})).toEqual({ kind: 'default' })
  })

  it('adopts a folder that already is a Jarod root, refuses one that holds something else', async () => {
    const existing = path.join(base, 'reinstall')
    fs.mkdirSync(existing)
    fs.writeFileSync(path.join(existing, MARKER), JSON.stringify({ kind: 'jarod-os-root', version: 1, created: 'x' }))
    expect(inspectTarget(existing)).toBe('adopt')
    expect(await moveToRoot({ root: existing, move: true, dataDir, workspace, configDir, current: current() })).toMatchObject({ adopted: true, copied: { files: 0 } })

    const other = path.join(base, 'photos')
    fs.mkdirSync(other)
    fs.writeFileSync(path.join(other, 'cat.jpg'), 'x')
    await expect(moveToRoot({ root: other, move: true, dataDir, workspace, configDir, current: current() })).rejects.toThrow('occupied')
  })

  it('never overwrites a file already at the destination, and says when a copy is incomplete', async () => {
    const to = path.join(base, 'to')
    fs.mkdirSync(path.join(to, 'profile'), { recursive: true })
    fs.writeFileSync(path.join(to, 'profile', 'jarod.db'), 'other')

    await expect(copyChecked(dataDir, to)).rejects.toThrow(/did not copy.*jarod\.db/)
    expect(fs.readFileSync(path.join(to, 'profile', 'jarod.db'), 'utf8')).toBe('other')
  })
})
