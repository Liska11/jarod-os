import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrateLegacyData, migrateShellConfig } from './migrate.ts'

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

  it('still moves the profile when the single-instance lock is the only thing in userData', () => {
    write('appData/Hermes OS/Local Storage/leveldb/000003.log', 'ls')
    write('appData/Hermes OS/Preferences', 'old prefs')
    // Windows' lockfile and Linux's Singleton* links exist as soon as the lock is claimed, before migration runs.
    write('appData/Jarod-OS/lockfile', '')
    write('appData/Jarod-OS/SingletonLock', '')

    migrateLegacyData(locations())

    expect(read('appData/Jarod-OS/Local Storage/leveldb/000003.log')).toBe('ls')
    expect(read('appData/Jarod-OS/Preferences')).toBe('old prefs')
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
    // The move into the Herald folder, then the copy into the Jarod-OS one (rename, phase 5).
    expect(migrateLegacyData(locations())).toHaveLength(2)
    expect(migrateLegacyData(locations())).toEqual([])
  })
})

describe('migrateLegacyData: the Hermes home folder is COPIED to its Jarod-OS name (rename, phase 5)', () => {
  it('copies herald-os to jarod-os, leaves the old folder as it was, and leaves the plugin copy behind', () => {
    write('.hermes/herald-os/prefs.json', '{"theme":"ice"}')
    write('.hermes/herald-os/permissions.yaml', 'tiers: {}')
    write('.hermes/herald-os/audit.jsonl', '{"tool":"system_info"}\n')
    write('.hermes/herald-os/bridge-plugin/plugin.yaml', 'name: herald-os-bridge')

    const lines = migrateLegacyData(locations())

    expect(lines.some(line => line.startsWith('failed'))).toBe(false)
    expect(read('.hermes/jarod-os/prefs.json')).toBe('{"theme":"ice"}')
    expect(read('.hermes/jarod-os/permissions.yaml')).toBe('tiers: {}')
    expect(read('.hermes/jarod-os/audit.jsonl')).toBe('{"tool":"system_info"}\n')
    // The old folder is untouched: an earlier version still finds its data.
    expect(read('.hermes/herald-os/prefs.json')).toBe('{"theme":"ice"}')
    expect(read('.hermes/herald-os/bridge-plugin/plugin.yaml')).toBe('name: herald-os-bridge')
    // The plugin copy is regenerated by the app, never carried over.
    expect(fs.existsSync(path.join(root, '.hermes/jarod-os/bridge-plugin'))).toBe(false)
    expect(read('.hermes/jarod-os/.copied-from-herald-os')).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('never overwrites a Jarod-OS folder that already exists', () => {
    write('.hermes/herald-os/prefs.json', 'old')
    write('.hermes/jarod-os/prefs.json', 'new')

    expect(migrateLegacyData(locations())).toEqual([])
    expect(read('.hermes/jarod-os/prefs.json')).toBe('new')
  })

  it('runs once, and leaves no half-copied folder behind', () => {
    write('.hermes/herald-os/prefs.json', 'x')

    expect(migrateLegacyData(locations())).toHaveLength(1)
    expect(migrateLegacyData(locations())).toEqual([])
    expect(fs.readdirSync(path.join(root, '.hermes')).sort()).toEqual(['herald-os', 'jarod-os'])
  })

  it('does nothing when there is no older folder', () => {
    expect(migrateLegacyData(locations())).toEqual([])
    expect(fs.existsSync(path.join(root, '.hermes/jarod-os'))).toBe(false)
  })
})

describe('migrateShellConfig', () => {
  it('moves the Windows dot-folder into the Windows settings folder, keeping what is already there', () => {
    write('home/.config/herald-os/plugins/clock/manifest.json', '{"id":"clock"}')
    write('home/.config/herald-os/plugins.json', '{"enabled":{"clock":{}}}')
    write('home/.config/herald-os/menu.json', 'old menu')
    write('roaming/Jarod-OS/config/menu.json', 'new menu')

    const moved = migrateShellConfig('win32', path.join(root, 'home/.config/herald-os'), path.join(root, 'roaming/Jarod-OS/config'))

    expect(moved.some(line => line.startsWith('failed'))).toBe(false)
    expect(read('roaming/Jarod-OS/config/plugins/clock/manifest.json')).toBe('{"id":"clock"}')
    expect(read('roaming/Jarod-OS/config/plugins.json')).toBe('{"enabled":{"clock":{}}}')
    expect(read('roaming/Jarod-OS/config/menu.json')).toBe('new menu')
    expect(read('home/.config/herald-os/menu.json')).toBe('old menu')
  })

  it('creates the new folder from the old one in one move, and does nothing the second time', () => {
    write('home/.config/herald-os/hooks/login.d/hello.cmd', 'echo hi')
    const legacy = path.join(root, 'home/.config/herald-os')
    const target = path.join(root, 'roaming/Jarod-OS/config')

    expect(migrateShellConfig('win32', legacy, target)).toHaveLength(1)
    expect(read('roaming/Jarod-OS/config/hooks/login.d/hello.cmd')).toBe('echo hi')
    expect(fs.existsSync(legacy)).toBe(false)
    expect(migrateShellConfig('win32', legacy, target)).toEqual([])
  })

  it('leaves Linux and macOS alone', () => {
    write('home/.config/herald-os/menu.json', 'menu')

    expect(migrateShellConfig('linux', path.join(root, 'home/.config/herald-os'), path.join(root, 'elsewhere'))).toEqual([])
    expect(read('home/.config/herald-os/menu.json')).toBe('menu')
  })
})
