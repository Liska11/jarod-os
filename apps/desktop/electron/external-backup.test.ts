import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BACKUPS_FOLDER,
  cleanLeftovers,
  dataExclusion,
  INCOMPLETE,
  listExternal,
  makeBackup,
  MANIFEST,
  OPERATION,
  planBackup,
  readManifest,
  removeOwnIncomplete,
  safeRelative,
  stageRestore,
  swapIn,
  verifyExternal
} from './external-backup.ts'
import { checkDestination, parseVolumes, type Volume } from './external-destination.ts'

const INSTANCE = '0f2c1a3e-1111-4222-8333-944455556666'
const dirs: string[] = []
const temp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarod-ext-'))
  dirs.push(dir)

  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

/** A data folder like the real one (profile, database, key, safety copy, web sessions) and a workspace. */
function sources() {
  const root = temp()
  const data = path.join(root, 'data')
  const workspace = path.join(root, 'workspace')
  write(path.join(data, 'profile', 'profiles', 'default', 'jarod.db'), 'DB')
  write(path.join(data, 'profile', 'profiles', 'default', 'jarod.db-wal'), 'WAL')
  write(path.join(data, 'profile', 'profiles', 'default', 'db.key.dpapi'), 'KEYBLOB')
  write(path.join(data, 'profile', 'profiles', 'default', 'jarod.db.avant-import-hermes'), 'OLD DB WITH VAULT')
  write(path.join(data, 'herald-userdata', 'Cookies'), 'cookies')
  write(path.join(data, 'gateway.log'), 'log')
  write(path.join(workspace, 'notes.md'), '# notes')
  write(path.join(workspace, 'app', 'node_modules', 'x', 'index.js'), 'x')
  write(path.join(workspace, 'app', 'src', 'main.ts'), 'main')

  return { root, data, workspace }
}

const hooks = (extra: Partial<Parameters<typeof makeBackup>[1]> = {}) => ({
  signal: new AbortController().signal,
  snapshotDb: async (_src: string, dest: string) => {
    fs.writeFileSync(dest, 'DB WITHOUT VAULT')

    return 2
  },
  progress: () => undefined,
  ...extra
})

async function backupOf(s: ReturnType<typeof sources>, destination: string) {
  const plan = await planBackup([
    { part: 'data', dir: s.data, exclude: dataExclusion },
    { part: 'workspace', dir: s.workspace }
  ])

  return makeBackup({ destination, instance: INSTANCE, app: 'test', reason: 'manual', parts: ['data', 'workspace'], plan }, hooks())
}

describe('what a backup holds', () => {
  it('plans the files, snapshots the database, and names every exclusion', async () => {
    const s = sources()
    const plan = await planBackup([
      { part: 'data', dir: s.data, exclude: dataExclusion },
      { part: 'workspace', dir: s.workspace }
    ])
    const rels = plan.files.map(file => file.rel).sort()

    expect(rels).toEqual(['data/profile/profiles/default/db.key.dpapi', 'data/profile/profiles/default/jarod.db', 'workspace/app/src/main.ts', 'workspace/notes.md'])
    expect(plan.files.find(file => file.rel.endsWith('jarod.db'))?.snapshot).toBe(true)
    expect(plan.excluded.join('\n')).toMatch(/copies de sécurité internes/)
    expect(plan.excluded.join('\n')).toMatch(/sessions web/)
    expect(plan.excluded.join('\n')).toMatch(/node_modules/)
  })

  it.runIf(process.platform === 'win32')('never follows a junction (no loop, no way out of the part)', async () => {
    const s = sources()
    fs.symlinkSync(s.root, path.join(s.workspace, 'loop'), 'junction')
    const plan = await planBackup([{ part: 'workspace', dir: s.workspace }])

    expect(plan.files.every(file => !file.rel.includes('loop'))).toBe(true)
    expect(plan.excluded.join('\n')).toMatch(/liens et jonctions/)
  })
})

describe('making a backup', () => {
  it('writes a complete, verifiable backup with hashes; the database copy comes from the snapshot', async () => {
    const s = sources()
    const dest = temp()
    const manifest = await backupOf(s, dest)
    const folder = path.join(dest, BACKUPS_FOLDER, INSTANCE, manifest.id)

    expect(manifest.secretsRemoved).toBe(2)
    expect(fs.readFileSync(path.join(folder, 'data', 'profile', 'profiles', 'default', 'jarod.db'), 'utf8')).toBe('DB WITHOUT VAULT')
    expect(fs.existsSync(path.join(folder, 'data', 'profile', 'profiles', 'default', 'jarod.db-wal'))).toBe(false)
    expect(fs.existsSync(path.join(folder, OPERATION))).toBe(false)
    expect(manifest.files.every(file => /^[a-f0-9]{64}$/.test(file.sha256))).toBe(true)
    await expect(verifyExternal(folder, new AbortController().signal, () => undefined)).resolves.toMatchObject({ id: manifest.id })
    expect((await listExternal(dest)).map(item => item.id)).toEqual([manifest.id])
    // The source is untouched.
    expect(fs.readFileSync(path.join(s.data, 'profile', 'profiles', 'default', 'jarod.db'), 'utf8')).toBe('DB')
  })

  it('a cancelled backup leaves nothing, and is never listed', async () => {
    const s = sources()
    const dest = temp()
    const abort = new AbortController()
    abort.abort()
    const plan = await planBackup([{ part: 'workspace', dir: s.workspace }])

    await expect(makeBackup({ destination: dest, instance: INSTANCE, app: 'test', reason: 'manual', parts: ['workspace'], plan }, hooks({ signal: abort.signal }))).rejects.toThrow()
    expect(fs.readdirSync(path.join(dest, BACKUPS_FOLDER, INSTANCE))).toEqual([])
  })

  it('a failure in the middle (the disk full, the database refused) removes the operation’s own folder only', async () => {
    const s = sources()
    const dest = temp()
    const foreign = path.join(dest, BACKUPS_FOLDER, INSTANCE, 'mes-documents')
    write(path.join(foreign, 'a.txt'), 'à moi')
    const plan = await planBackup([{ part: 'data', dir: s.data, exclude: dataExclusion }])

    await expect(
      makeBackup({ destination: dest, instance: INSTANCE, app: 'test', reason: 'manual', parts: ['data'], plan }, hooks({ snapshotDb: async () => Promise.reject(Object.assign(new Error('plein'), { code: 'ENOSPC' })) }))
    ).rejects.toThrow('plein')
    expect(fs.readdirSync(path.join(dest, BACKUPS_FOLDER, INSTANCE))).toEqual(['mes-documents'])
    expect(fs.readFileSync(path.join(foreign, 'a.txt'), 'utf8')).toBe('à moi')
  })

  it('leftovers of an interrupted backup are cleaned, a folder without our marker is not', async () => {
    const dest = temp()
    const parent = path.join(dest, BACKUPS_FOLDER, INSTANCE)
    const ours = path.join(parent, `20261018-101010-abcdef${INCOMPLETE}`)
    const look = path.join(parent, `20261018-101011-abcdef${INCOMPLETE}`)
    write(path.join(ours, OPERATION), JSON.stringify({ operation: 'x' }))
    write(path.join(ours, 'data', 'f'), 'partial')
    write(path.join(look, 'f'), 'no marker')

    expect(await cleanLeftovers(dest, INSTANCE)).toBe(1)
    expect(fs.existsSync(ours)).toBe(false)
    expect(fs.existsSync(look)).toBe(true)
    expect(await removeOwnIncomplete(path.join(dest, 'anything'), null)).toBe(false)
  })
})

describe('checking a backup before restoring it', () => {
  it('refuses a manifest with an absolute path, a traversal or an unknown part', () => {
    for (const bad of ['C:/Windows/x', '/etc/passwd', 'data/../../x', 'other/x', 'data', 'data//x', 'data\\x', 'data/a:b']) {
      expect(safeRelative(bad), bad).toBe(false)
    }

    expect(safeRelative('workspace/notes.md')).toBe(true)
    const manifest = { format: 1, status: 'complete', id: '20261018-101010-abcdef', instance: INSTANCE, parts: ['data'], files: [{ path: 'data/../evil', size: 1, sha256: 'a'.repeat(64) }] }
    expect(() => readManifest(JSON.stringify(manifest))).toThrow(/refusée/)
    expect(() => readManifest(JSON.stringify({ ...manifest, status: 'incomplete', files: [] }))).toThrow(/incomplète/)
  })

  it('detects a changed or missing file', async () => {
    const s = sources()
    const dest = temp()
    const manifest = await backupOf(s, dest)
    const folder = path.join(dest, BACKUPS_FOLDER, INSTANCE, manifest.id)
    fs.writeFileSync(path.join(folder, 'workspace', 'notes.md'), '# altered')

    await expect(verifyExternal(folder, new AbortController().signal, () => undefined)).rejects.toThrow(/abîmé|taille/)
    fs.rmSync(path.join(folder, 'workspace', 'notes.md'))
    await expect(verifyExternal(folder, new AbortController().signal, () => undefined)).rejects.toThrow(/manque/)
  })
})

describe('restoring', () => {
  it('stages, swaps in, and keeps the previous state beside it; the restored content is the backup’s', async () => {
    const s = sources()
    const dest = temp()
    const manifest = await backupOf(s, dest)
    const folder = path.join(dest, BACKUPS_FOLDER, INSTANCE, manifest.id)
    // Things change after the backup.
    fs.writeFileSync(path.join(s.workspace, 'notes.md'), '# changed later')
    write(path.join(s.workspace, 'new.txt'), 'new')
    const targets = { data: s.data, workspace: s.workspace }
    const checked = await verifyExternal(folder, new AbortController().signal, () => undefined)
    const staging = await stageRestore(folder, checked, targets, 'T1', new AbortController().signal, () => undefined)
    const { aside } = await swapIn(staging, targets, 'T1')

    expect(fs.readFileSync(path.join(s.workspace, 'notes.md'), 'utf8')).toBe('# notes')
    expect(fs.existsSync(path.join(s.workspace, 'new.txt'))).toBe(false)
    expect(fs.readFileSync(path.join(s.data, 'profile', 'profiles', 'default', 'jarod.db'), 'utf8')).toBe('DB WITHOUT VAULT')
    expect(aside.sort()).toEqual([`${s.data}.before-restore-T1`, `${s.workspace}.before-restore-T1`].sort())
    expect(fs.readFileSync(path.join(`${s.workspace}.before-restore-T1`, 'notes.md'), 'utf8')).toBe('# changed later')
  })

  it('a swap that fails half way puts everything back', async () => {
    const s = sources()
    const staging = { workspace: path.join(s.root, 'staged-ws'), data: path.join(s.root, 'missing-staged-data') }
    write(path.join(staging.workspace, 'notes.md'), 'staged')

    await expect(swapIn(staging, { workspace: s.workspace, data: s.data }, 'T2')).rejects.toThrow()
    expect(fs.readFileSync(path.join(s.workspace, 'notes.md'), 'utf8')).toBe('# notes')
    expect(fs.existsSync(path.join(s.data, 'profile'))).toBe(true)
    expect(fs.existsSync(`${s.workspace}.before-restore-T2`)).toBe(false)
  })
})

describe('the destination', () => {
  const volumes: Volume[] = [
    { letter: 'C:', uniqueId: 'vc', fileSystem: 'NTFS', driveType: 'Fixed', free: 100 * 1024 ** 3, size: 0, label: 'OS', disk: 2 },
    { letter: 'E:', uniqueId: 've', fileSystem: 'exFAT', driveType: 'Removable', free: 10 * 1024 ** 3, size: 0, label: 'USB', disk: 8 },
    { letter: 'D:', uniqueId: 'vd', fileSystem: 'NTFS', driveType: 'Fixed', free: 900 * 1024 ** 3, size: 0, label: 'Data', disk: 2 }
  ]

  it('accepts a removable drive, with the warnings that apply', () => {
    const check = checkDestination('E:\\Sauvegardes', volumes, ['C:\\Users\\moi\\Jarod'], 1024 ** 3)

    expect(check.ok).toBe(true)
    expect(check.warnings).toContain('exfat')
  })

  it('refuses a system folder, a relative or network path, a folder inside what is backed up, and too little room', () => {
    expect(checkDestination('C:\\Windows\\Backups', volumes, [], null).problems).toContain('system-folder')
    expect(checkDestination('\\\\server\\share', volumes, [], null).problems).toContain('not-absolute')
    expect(checkDestination('backups', volumes, [], null).problems).toContain('not-absolute')
    expect(checkDestination('D:\\Jarod-OS\\data\\copies', volumes, ['D:\\Jarod-OS\\data'], null).problems).toContain('inside-sources')
    expect(checkDestination('D:\\', volumes, ['D:\\Jarod-OS\\data'], null).problems).toContain('inside-sources')
    expect(checkDestination('E:\\B', volumes, [], 50 * 1024 ** 3).problems).toContain('no-space')
    expect(checkDestination('Z:\\B', volumes, [], null).problems).toContain('no-volume')
  })

  it('warns when the destination is on the same physical disk as the data', () => {
    expect(checkDestination('D:\\Sauvegardes', volumes, ['C:\\Users\\moi\\AppData\\Local\\Jarod-OS'], null).warnings).toContain('same-disk')
  })

  it('reads the volumes PowerShell reports', () => {
    const list = parseVolumes('[{"Letter":"E","UniqueId":"\\\\\\\\?\\\\Volume{1}\\\\","FileSystem":"NTFS","DriveType":"Removable","Free":5,"Disk":8},{"Letter":null}]')

    expect(list).toEqual([{ letter: 'E:', uniqueId: '\\\\?\\Volume{1}\\', fileSystem: 'NTFS', driveType: 'Removable', free: 5, size: 0, label: '', disk: 8 }])
  })
})

describe('the manifest name', () => {
  it('is not the active install’s marker', () => {
    expect(MANIFEST).not.toBe('.jarod-os-root.json')
  })
})
