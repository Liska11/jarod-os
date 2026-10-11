import { describe, expect, it } from 'vitest'
import { assertWritablePath, isBelow, isProjectLocation, protectedRoots } from './path-guard.ts'

const winHome = 'C:\\Users\\Sam'
const winEnv = { APPDATA: 'C:\\Users\\Sam\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\Sam\\AppData\\Local', SystemRoot: 'C:\\Windows' }

describe('isBelow', () => {
  it('is strict about the root and ignores case only on Windows', () => {
    expect(isBelow('C:\\Users\\Sam', 'c:\\users\\sam\\Docs\\a.txt', 'win32')).toBe(true)
    expect(isBelow('C:\\Users\\Sam', 'C:\\Users\\Sam', 'win32')).toBe(false)
    expect(isBelow('C:\\Users\\Sam', 'C:\\Users\\Sam', 'win32', true)).toBe(true)
    expect(isBelow('C:\\Users\\Sam', 'C:\\Users\\Samantha\\a.txt', 'win32')).toBe(false)
    expect(isBelow('/Users/sam', '/users/sam/a.txt', 'darwin')).toBe(false)
    expect(isBelow('/Users/sam', '/Users/sam/a.txt', 'darwin')).toBe(true)
  })
})

describe('assertWritablePath', () => {
  it('allows the home folder on Windows and refuses everything outside it', () => {
    expect(assertWritablePath('C:\\Users\\Sam\\Documents\\notes.md', winHome, 'win32', winEnv)).toBe('C:\\Users\\Sam\\Documents\\notes.md')
    expect(() => assertWritablePath('C:\\Windows\\System32\\drivers\\etc\\hosts', winHome, 'win32', winEnv)).toThrow('inside your home folder')
    expect(() => assertWritablePath('D:\\other\\a.txt', winHome, 'win32', winEnv)).toThrow('inside your home folder')
  })

  it('refuses SSH keys and the Credential Manager and DPAPI stores, in any letter case', () => {
    for (const file of ['C:\\Users\\Sam\\.ssh\\id_ed25519', 'c:\\users\\sam\\.SSH\\config', 'C:\\Users\\Sam\\AppData\\Roaming\\Microsoft\\Credentials\\ABC', 'C:\\Users\\Sam\\AppData\\Local\\Microsoft\\Vault\\x', 'C:\\Users\\Sam\\AppData\\Roaming\\Microsoft\\Protect\\S-1\\key']) {
      expect(() => assertWritablePath(file, winHome, 'win32', winEnv), file).toThrow('protected location')
    }
  })

  it('keeps the macOS rules', () => {
    expect(() => assertWritablePath('/Users/sam/.ssh/config', '/Users/sam', 'darwin')).toThrow('protected location')
    expect(() => assertWritablePath('/etc/hosts', '/Users/sam', 'darwin')).toThrow('inside your home folder')
    expect(assertWritablePath('/tmp/x/a.txt', '/Users/sam', 'darwin')).toBe('/tmp/x/a.txt')
  })
})

describe('isProjectLocation', () => {
  it('accepts folders under home and refuses the rest', () => {
    expect(isProjectLocation('C:\\Users\\Sam\\code\\app', winHome, 'win32')).toBe(true)
    expect(isProjectLocation('C:\\Program Files\\App', winHome, 'win32')).toBe(false)
  })
})

describe('protectedRoots', () => {
  it('lists the Windows credential stores', () => {
    const roots = protectedRoots(winHome, 'win32', winEnv)

    expect(roots).toContain('C:\\Users\\Sam\\.ssh')
    expect(roots).toContain('C:\\Users\\Sam\\AppData\\Local\\Microsoft\\Vault')
  })
})
