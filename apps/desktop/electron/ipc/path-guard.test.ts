import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { assertOpenablePath, assertReadablePath, assertWritablePath, hasDecoyComponent, isBelow, isProjectLocation, protectedRoots, resolveRealPath } from './path-guard.ts'

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

describe('the Jarod disk', () => {
  const diskEnv = { ...winEnv, JAROD_OS_ROOT: 'D:\\Jarod-OS', JAROD_OS_DATA: 'D:\\Jarod-OS\\data' }

  it('is the person’s own space, except the data folder', () => {
    expect(assertWritablePath('D:\\Jarod-OS\\workspace\\notes.md', winHome, 'win32', diskEnv)).toBe('D:\\Jarod-OS\\workspace\\notes.md')
    expect(isProjectLocation('D:\\Jarod-OS\\sandboxes\\site', winHome, 'win32', diskEnv)).toBe(true)
    expect(() => assertWritablePath('D:\\Jarod-OS\\data\\profile\\jarod.db', winHome, 'win32', diskEnv)).toThrow('protected location')
    expect(() => assertWritablePath('D:\\Other\\x.txt', winHome, 'win32', diskEnv)).toThrow('inside your home folder')
  })

  it('is not writable when Jarod-OS has no disk of its own', () => {
    expect(() => assertWritablePath('D:\\Jarod-OS\\workspace\\notes.md', winHome, 'win32', winEnv)).toThrow('inside your home folder')
  })
})

describe('protectedRoots', () => {
  it('lists the Windows credential stores', () => {
    const roots = protectedRoots(winHome, 'win32', winEnv)

    expect(roots).toContain('C:\\Users\\Sam\\.ssh')
    expect(roots).toContain('C:\\Users\\Sam\\AppData\\Local\\Microsoft\\Vault')
  })

  it('protects the certificate store and the machine crypto store the kernel lists too', () => {
    const roots = protectedRoots(winHome, 'win32', winEnv)

    expect(roots).toContain('C:\\Users\\Sam\\AppData\\Roaming\\Microsoft\\SystemCertificates')
    expect(roots).toContain('C:\\ProgramData\\Microsoft\\Crypto')

    for (const file of ['C:\\Users\\Sam\\AppData\\Roaming\\Microsoft\\SystemCertificates\\My\\x', 'C:\\ProgramData\\Microsoft\\Crypto\\RSA\\key']) {
      expect(() => assertReadablePath(file, winHome, 'win32', winEnv), file).toThrow('protected location')
    }
  })

  it('lists the shell state and the kernel profile, honouring HERMES_HOME and JAROD_OS_DATA', () => {
    const roots = protectedRoots(winHome, 'win32', winEnv)

    expect(roots).toContain('C:\\Users\\Sam\\AppData\\Local\\hermes\\herald-os')
    expect(roots).toContain('C:\\Users\\Sam\\AppData\\Local\\hermes\\vault')
    expect(roots).toContain('C:\\Users\\Sam\\AppData\\Local\\Jarod-OS')

    const elsewhere = protectedRoots(winHome, 'win32', { ...winEnv, HERMES_HOME: 'D:\\hermes', JAROD_OS_DATA: 'D:\\jarod' })

    expect(elsewhere).toContain('D:\\hermes\\herald-os')
    expect(elsewhere).toContain('D:\\jarod')
    expect(elsewhere).not.toContain('C:\\Users\\Sam\\AppData\\Local\\Jarod-OS')
  })
})

describe('hasDecoyComponent', () => {
  it('spots a Windows component that ends with a dot or a space, and only on Windows', () => {
    expect(hasDecoyComponent('C:\\Users\\Sam\\.ssh.\\id_rsa', 'win32')).toBe(true)
    expect(hasDecoyComponent('C:\\Users\\Sam\\Documents\\notes.md ', 'win32')).toBe(true)
    expect(hasDecoyComponent('C:\\Users\\Sam\\Documents\\notes.md', 'win32')).toBe(false)
    expect(hasDecoyComponent('C:\\Users\\Sam\\..\\Sam\\a.txt', 'win32')).toBe(false)
    expect(hasDecoyComponent('C:\\Users\\Sam\\.\\a.txt', 'win32')).toBe(false)
    // A trailing dot is a legal file name everywhere else.
    expect(hasDecoyComponent('/tmp/x/a.', 'darwin')).toBe(false)
    expect(hasDecoyComponent('/tmp/x/a.', 'linux')).toBe(false)
  })
})

describe('resolveRealPath', () => {
  it('leaves a path with no existing prefix alone', () => {
    expect(resolveRealPath('C:\\no-such-root-42\\a\\b.txt', 'win32')).toBe('C:\\no-such-root-42\\a\\b.txt')
  })
})

describe('assertWritablePath, through the file system', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'path-guard-'))
  const home = path.join(tmp, 'home')
  const ssh = path.join(home, '.ssh')
  const work = path.join(home, 'Documents', 'work')

  fs.mkdirSync(ssh, { recursive: true })
  fs.writeFileSync(path.join(ssh, 'id_ed25519'), 'key')
  fs.mkdirSync(path.dirname(work), { recursive: true })
  fs.symlinkSync(ssh, work, process.platform === 'win32' ? 'junction' : 'dir')

  afterAll(() => {
    try {
      if (process.platform === 'win32') {
        fs.rmdirSync(work)
      } else {
        fs.unlinkSync(work)
      }
    } catch {
      // Already gone.
    }

    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('refuses a folder that is really a link into .ssh', () => {
    expect(() => assertWritablePath(path.join(work, 'authorized_keys'), home)).toThrow('protected location')
  })

  it('refuses a read through the same link', () => {
    expect(() => assertReadablePath(path.join(work, 'id_ed25519'), home)).toThrow('protected location')
  })

  it('still allows an ordinary file inside the same home', () => {
    const notes = path.join(home, 'Documents', 'notes.md')

    expect(assertWritablePath(notes, home)).toBe(notes)
    expect(assertReadablePath(notes, home)).toBe(notes)
  })
})

describe('assertWritablePath, Windows name tricks', () => {
  it('refuses a component that ends with a dot or a space', () => {
    expect(() => assertWritablePath('C:\\Users\\Sam\\.ssh.\\authorized_keys', winHome, 'win32', winEnv)).toThrow('name trick')
    expect(() => assertWritablePath('C:\\Users\\Sam\\Documents\\notes.md ', winHome, 'win32', winEnv)).toThrow('name trick')
  })
})

describe('assertReadablePath', () => {
  it('refuses the credential stores, wherever the file sits', () => {
    expect(() => assertReadablePath('C:\\Users\\Sam\\.ssh\\id_rsa', winHome, 'win32', winEnv)).toThrow('protected location')
    expect(() => assertReadablePath('C:\\Windows\\System32\\config\\SAM', winHome, 'win32', winEnv)).toThrow('protected location')
    expect(() => assertReadablePath('C:\\Users\\Sam\\AppData\\Local\\hermes\\herald-os\\audit.jsonl', winHome, 'win32', winEnv)).toThrow('protected location')
  })

  it('keeps a workspace on another drive readable', () => {
    expect(assertReadablePath('D:\\projects\\app\\src\\index.ts', winHome, 'win32', winEnv)).toBe('D:\\projects\\app\\src\\index.ts')
  })
})

describe('assertOpenablePath', () => {
  it('refuses anything the default action would execute', () => {
    for (const file of ['C:\\Users\\Sam\\Documents\\setup.exe', 'C:\\Users\\Sam\\Documents\\rapport.pdf.lnk', 'C:\\Users\\Sam\\Documents\\build.bat', 'C:\\Users\\Sam\\Documents\\notes.ps1', 'C:\\Users\\Sam\\Documents\\app.msi']) {
      expect(() => assertOpenablePath(file, winHome, 'win32', winEnv), file).toThrow('program or a script')
    }
  })

  it('allows a document, and a folder', () => {
    expect(assertOpenablePath('C:\\Users\\Sam\\Documents\\rapport.pdf', winHome, 'win32', winEnv)).toBe('C:\\Users\\Sam\\Documents\\rapport.pdf')
    expect(assertOpenablePath('C:\\Users\\Sam\\Downloads', winHome, 'win32', winEnv)).toBe('C:\\Users\\Sam\\Downloads')
  })
})

describe('real path resolution', () => {
  it('refuses a protected folder reached through its 8.3 short name', () => {
    if (process.platform !== 'win32') {
      return
    }

    // realpathSync.native expands PROGRA~1 to Program Files, which is one of the protected roots.
    expect(() => assertReadablePath('C:\\PROGRA~1\\Windows\\System32\\config\\SAM', winHome, 'win32', winEnv)).toThrow('protected location')
  })

  it('resolves the nearest existing ancestor for a path that does not exist yet', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'herald-os-guard-'))
    const fresh = path.join(home, 'code', 'new', 'deep', 'a.txt')

    try {
      expect(assertWritablePath(fresh, home)).toBe(fresh)
      expect(() => assertWritablePath(path.join(home, '.ssh', 'new', 'authorized_keys'), home)).toThrow('protected location')
      expect(() => assertReadablePath(path.join(home, '.ssh', 'new', 'authorized_keys'), home)).toThrow('protected location')
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})
