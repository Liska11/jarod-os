import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrateLegacyData } from './migrate.ts'

let root = ''

function write(rel: string, text = 'x'): void {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
  fs.writeFileSync(path.join(root, rel), text)
}

function read(rel: string): string | null {
  try {
    return fs.readFileSync(path.join(root, rel), 'utf8')
  } catch {
    return null
  }
}

function locations() {
  return { hermesHome: path.join(root, '.hermes'), appData: path.join(root, 'appData'), userData: path.join(root, 'appData', 'Jarod-OS') }
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'herald-migrate-'))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('migrateLegacyData', () => {
  it('moves the Hermes home folder, the profile and its web partitions', () => {
    write('.hermes/hermes-os/prefs.json', '{"theme":"ice"}')
    write('.hermes/hermes-os/permissions.yaml', 'tiers: {}')
    write('appData/Hermes OS/Local Storage/leveldb/000003.log', 'ls')
    write('appData/Hermes OS/Partitions/hermes-web/Cookies', 'cookies')
    write('appData/Hermes OS/Partitions/hermes-preview/Cookies', 'preview')

    const moved = migrateLegacyData(locations())

    expect(moved.some(line => line.startsWith('failed'))).toBe(false)
    expect(read('.hermes/herald-os/prefs.json')).toBe('{"theme":"ice"}')
    expect(read('.hermes/herald-os/permissions.yaml')).toBe('tiers: {}')
    expect(fs.existsSync(path.join(root, '.hermes/hermes-os'))).toBe(false)
    expect(read('appData/Jarod-OS/Local Storage/leveldb/000003.log')).toBe('ls')
    expect(read('appData/Jarod-OS/Partitions/herald-web/Cookies')).toBe('cookies')
    expect(read('appData/Jarod-OS/Partitions/herald-preview/Cookies')).toBe('preview')
  })

  it('merges into a folder another process already created, keeping its files', () => {
    write('.hermes/hermes-os/permissions.yaml', 'custom policy')
    write('.hermes/hermes-os/audit.jsonl', 'old audit')
    write('.hermes/herald-os/audit.jsonl', 'new audit')

    migrateLegacyData(locations())

    expect(read('.hermes/herald-os/permissions.yaml')).toBe('custom policy')
    expect(read('.hermes/herald-os/audit.jsonl')).toBe('new audit')
    expect(read('.hermes/hermes-os/audit.jsonl')).toBe('old audit')
  })

  it('moves the profile into the empty folder Electron creates when asked for userData', () => {
    write('appData/Hermes OS/Local Storage/leveldb/000003.log', 'ls')
    fs.mkdirSync(path.join(root, 'appData/Jarod-OS'), { recursive: true })

    migrateLegacyData(locations())

    expect(read('appData/Jarod-OS/Local Storage/leveldb/000003.log')).toBe('ls')
    expect(fs.existsSync(path.join(root, 'appData/Hermes OS'))).toBe(false)
  })

  it('never replaces an existing profile', () => {
    write('appData/Hermes OS/Preferences', 'old')
    write('appData/Jarod-OS/Preferences', 'new')

    migrateLegacyData(locations())

    expect(read('appData/Jarod-OS/Preferences')).toBe('new')
    expect(read('appData/Hermes OS/Preferences')).toBe('old')
  })

  it('is a no-op on a fresh install and when run twice', () => {
    expect(migrateLegacyData(locations())).toEqual([])
    write('.hermes/hermes-os/prefs.json')
    expect(migrateLegacyData(locations())).toHaveLength(1)
    expect(migrateLegacyData(locations())).toEqual([])
  })
})
