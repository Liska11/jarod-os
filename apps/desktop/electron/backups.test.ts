import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createBackup, dailyDue, DEFAULT_SETTINGS, listBackups, readSettings, removeBackup, restoreBackup, toPrune, writeSettings } from './backups.ts'

let base: string
let data: string
let workspace: string
let backups: string

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'jarod-backups-test-'))
  data = path.join(base, 'data')
  workspace = path.join(base, 'workspace')
  backups = path.join(base, 'backups')
  fs.mkdirSync(path.join(data, 'profile'), { recursive: true })
  fs.writeFileSync(path.join(data, 'profile', 'jarod.db'), 'v1')
  fs.mkdirSync(path.join(workspace, 'site', 'node_modules', 'react'), { recursive: true })
  fs.writeFileSync(path.join(workspace, 'site', 'index.html'), '<h1>hi</h1>')
  fs.writeFileSync(path.join(workspace, 'site', 'node_modules', 'react', 'index.js'), 'x'.repeat(1000))
})

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true })
})

const at = (iso: string) => new Date(iso)

describe('createBackup', () => {
  it('copies data and workspace, without the folders tools rebuild, and writes its manifest', async () => {
    const backup = await createBackup(backups, { data, workspace }, 'manual', at('2026-10-18T09:00:00Z'))

    expect(backup).toMatchObject({ id: '2026-10-18T09-00-00-000Z-manual', reason: 'manual', parts: ['data', 'workspace'], files: 2, linked: 0 })
    expect(fs.readFileSync(path.join(backups, backup.id, 'data', 'profile', 'jarod.db'), 'utf8')).toBe('v1')
    expect(fs.existsSync(path.join(backups, backup.id, 'workspace', 'site', 'index.html'))).toBe(true)
    expect(fs.existsSync(path.join(backups, backup.id, 'workspace', 'site', 'node_modules'))).toBe(false)
    expect(listBackups(backups).map(b => b.id)).toEqual([backup.id])
  })

  it('links what did not change since the last backup and copies the rest', async () => {
    const first = await createBackup(backups, { data, workspace }, 'daily', at('2026-10-17T09:00:00Z'))
    let restarted = 0
    fs.writeFileSync(path.join(data, 'profile', 'jarod.db'), 'v2-longer')
    const second = await createBackup(backups, { data, workspace }, 'daily', at('2026-10-18T09:00:00Z'), () => {
      restarted++
    })

    expect(second).toMatchObject({ files: 2, linked: 1 })
    expect(restarted).toBe(1)
    expect(fs.readFileSync(path.join(backups, first.id, 'data', 'profile', 'jarod.db'), 'utf8')).toBe('v1')
    expect(fs.readFileSync(path.join(backups, second.id, 'data', 'profile', 'jarod.db'), 'utf8')).toBe('v2-longer')
    // A linked file survives the removal of the backup it came from.
    removeBackup(backups, first.id)
    expect(fs.readFileSync(path.join(backups, second.id, 'workspace', 'site', 'index.html'), 'utf8')).toBe('<h1>hi</h1>')
  })

  it('ignores an interrupted backup (no manifest)', async () => {
    fs.mkdirSync(path.join(backups, '2026-10-18T10-00-00-000Z-daily', 'data'), { recursive: true })

    expect(listBackups(backups)).toEqual([])
  })
})

describe('keeping backups', () => {
  it('is due daily, and keeps the newest ones', async () => {
    const a = await createBackup(backups, { data }, 'daily', at('2026-10-16T09:00:00Z'))
    const b = await createBackup(backups, { data }, 'daily', at('2026-10-17T09:00:00Z'))
    const c = await createBackup(backups, { data }, 'manual', at('2026-10-18T08:00:00Z'))
    const list = listBackups(backups)

    expect(dailyDue(list, at('2026-10-18T20:00:00Z'))).toBe(false)
    expect(dailyDue(list, at('2026-10-19T08:00:00Z'))).toBe(true)
    expect(dailyDue([], at('2026-10-19T08:00:00Z'))).toBe(true)
    expect(toPrune(list, 2).map(x => x.id)).toEqual([a.id])
    // The backup just made (here the oldest, a) is never pruned, and counts among the kept ones.
    expect(toPrune(list, 2, a.id).map(x => x.id)).toEqual([b.id])
    expect(c.reason).toBe('manual')
  })

  it('reads its settings, with safe defaults', async () => {
    expect(readSettings(backups)).toEqual(DEFAULT_SETTINGS)
    writeSettings(backups, { daily: false, keep: 3 })
    expect(readSettings(backups)).toEqual({ daily: false, keep: 3 })
    fs.writeFileSync(path.join(backups, 'settings.json'), '{"keep": -4}')
    expect(readSettings(backups)).toEqual(DEFAULT_SETTINGS)
  })

  it('refuses ids that are not backup names', async () => {
    expect(() => removeBackup(backups, '..\\..\\Windows')).toThrow('not a backup')
  })
})

describe('restoreBackup', () => {
  it('moves the current folders aside, then puts the backup back', async () => {
    const backup = await createBackup(backups, { data, workspace }, 'manual', at('2026-10-17T09:00:00Z'))
    fs.writeFileSync(path.join(data, 'profile', 'jarod.db'), 'broken')
    fs.writeFileSync(path.join(workspace, 'new.txt'), 'made after')

    const { aside } = restoreBackup(backups, backup.id, { data, workspace }, at('2026-10-18T09:00:00Z'))

    expect(fs.readFileSync(path.join(data, 'profile', 'jarod.db'), 'utf8')).toBe('v1')
    expect(fs.existsSync(path.join(workspace, 'new.txt'))).toBe(false)
    expect(fs.readFileSync(path.join(backups, aside, 'data', 'profile', 'jarod.db'), 'utf8')).toBe('broken')
    expect(fs.readFileSync(path.join(backups, aside, 'workspace', 'new.txt'), 'utf8')).toBe('made after')
    expect(listBackups(backups).map(b => b.reason)).toEqual(['before-restore', 'manual'])
  })
})
