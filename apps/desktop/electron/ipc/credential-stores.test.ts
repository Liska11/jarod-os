import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { CREDENTIAL_HOME_ENTRIES, assertReadablePath, assertWritablePath, protectedRoots } from './path-guard.ts'

// 2026-10-22 — the window's file channels protect the same credential stores as the core's file gate, confined shell,
// system tools and Python bridge (contracts/v1/credential-stores.reference.json). The terminal is not affected: git, aws,
// kubectl, ssh and docker keep reading their own files from it.
const winHome = 'C:\\Users\\Sam'
const winEnv = { APPDATA: 'C:\\Users\\Sam\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\Sam\\AppData\\Local', SystemRoot: 'C:\\Windows', ProgramData: 'C:\\ProgramData' }

const reference = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../../contracts/v1/credential-stores.reference.json'), 'utf8')) as {
  homeDirs: string[]
  homeFiles: string[]
  windows: { roaming: string[]; local: string[]; programData: string[] }
}

describe('credential stores shared with the core', () => {
  it('lists exactly the home entries of the reference', () => {
    expect([...CREDENTIAL_HOME_ENTRIES].sort()).toEqual([...reference.homeDirs, ...reference.homeFiles].sort())
  })

  it('protects every home entry of the reference, on Windows and elsewhere', () => {
    const win = protectedRoots(winHome, 'win32', winEnv).map(root => root.toLowerCase())
    const posix = protectedRoots('/Users/sam', 'darwin', {})

    for (const entry of CREDENTIAL_HOME_ENTRIES) {
      expect(win, entry).toContain(path.win32.join(winHome, ...entry.split('/')).toLowerCase())
      expect(posix, entry).toContain(path.posix.join('/Users/sam', ...entry.split('/')))
    }
  })

  it('protects the Windows stores of the reference', () => {
    const win = protectedRoots(winHome, 'win32', winEnv).map(root => root.toLowerCase())

    for (const entry of reference.windows.roaming) expect(win, entry).toContain(path.win32.join(winEnv.APPDATA, ...entry.split('/')).toLowerCase())
    for (const entry of reference.windows.local) expect(win, entry).toContain(path.win32.join(winEnv.LOCALAPPDATA, ...entry.split('/')).toLowerCase())
    for (const entry of reference.windows.programData) expect(win, entry).toContain(path.win32.join(winEnv.ProgramData, ...entry.split('/')).toLowerCase())
  })

  it('refuses reading and writing a cloud or cluster credential file, but not a neighbour', () => {
    for (const file of ['C:\\Users\\Sam\\.aws\\credentials', 'C:\\Users\\Sam\\.kube\\config', 'C:\\Users\\Sam\\.docker\\config.json', 'C:\\Users\\Sam\\.config\\gh\\hosts.yml', 'C:\\Users\\Sam\\.git-credentials', 'C:\\Users\\Sam\\.npmrc']) {
      expect(() => assertReadablePath(file, winHome, 'win32', winEnv), file).toThrow('protected location')
      expect(() => assertWritablePath(file, winHome, 'win32', winEnv), file).toThrow('protected location')
    }

    expect(assertReadablePath('C:\\Users\\Sam\\.config\\other\\x.yml', winHome, 'win32', winEnv)).toBe('C:\\Users\\Sam\\.config\\other\\x.yml')
    expect(assertWritablePath('C:\\Users\\Sam\\.awesome\\x.txt', winHome, 'win32', winEnv)).toBe('C:\\Users\\Sam\\.awesome\\x.txt')
  })
})
