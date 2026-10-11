import { describe, expect, it } from 'vitest'
import { rankFiles } from './find.ts'
import { appIdToFile, appsFolderId, asArray, encodePowerShell, isAppsFolderPath, parseNetshWlan, pickInterface, recentTargets, startAppsToInstalled, toProcessInfo } from './windows-parse.ts'

const env = { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', SystemRoot: 'C:\\Windows', LOCALAPPDATA: 'C:\\Users\\Sam\\AppData\\Local' }

describe('encodePowerShell', () => {
  it('encodes UTF-16LE base64 with the UTF-8 output prelude', () => {
    const decoded = Buffer.from(encodePowerShell("'héllo'"), 'base64').toString('utf16le')

    expect(decoded).toContain("'héllo'")
    expect(decoded).toContain('[Console]::OutputEncoding')
  })
})

describe('asArray', () => {
  it('undoes the one-object quirk of ConvertTo-Json', () => {
    expect(asArray({ a: 1 })).toEqual([{ a: 1 }])
    expect(asArray(null)).toEqual([])
    expect(asArray([1, 2])).toEqual([1, 2])
  })
})

describe('appIdToFile', () => {
  it('resolves paths and known-folder ids, and gives packaged apps none', () => {
    expect(appIdToFile('C:\\Tools\\7zFM.exe', env)).toBe('C:\\Tools\\7zFM.exe')
    expect(appIdToFile('{6D809377-6AF0-444B-8957-A3773F02200E}\\7-Zip\\7zFM.exe', env)).toBe('C:\\Program Files\\7-Zip\\7zFM.exe')
    expect(appIdToFile('{7C5A40EF-A0FB-4BFC-874A-C0F2E0B9FA8E}\\Foo\\foo.exe', env)).toBe('C:\\Program Files (x86)\\Foo\\foo.exe')
    expect(appIdToFile('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\voiceaccess.exe', env)).toBe('C:\\Windows\\System32\\voiceaccess.exe')
    expect(appIdToFile('Microsoft.WindowsCalculator_8wekyb3d8bbwe!App', env)).toBeNull()
    expect(appIdToFile('{00000000-0000-0000-0000-000000000000}\\x.exe', env)).toBeNull()
  })
})

describe('apps folder paths', () => {
  it('splits and validates shell:AppsFolder entries', () => {
    expect(appsFolderId('shell:AppsFolder\\Pkg!App')).toBe('Pkg!App')
    expect(appsFolderId('C:\\a.exe')).toBeNull()
    expect(isAppsFolderPath('shell:AppsFolder\\Microsoft.WindowsCalculator_8wekyb3d8bbwe!App')).toBe(true)
    expect(isAppsFolderPath('shell:AppsFolder\\x" & calc')).toBe(false)
    expect(isAppsFolderPath('shell:Startup')).toBe(false)
  })
})

describe('startAppsToInstalled', () => {
  it('keeps the first entry of each name, sorted', () => {
    const apps = startAppsToInstalled([
      { name: 'Zed', id: 'C:\\z.exe' },
      { name: '7-Zip', id: 'C:\\7z.exe' },
      { name: '7-zip', id: '{GUID}\\7z.exe' },
      { name: '', id: 'x' }
    ])

    expect(apps).toEqual([
      { name: '7-Zip', path: 'shell:AppsFolder\\C:\\7z.exe', bundleId: 'C:\\7z.exe' },
      { name: 'Zed', path: 'shell:AppsFolder\\C:\\z.exe', bundleId: 'C:\\z.exe' }
    ])
  })
})

describe('parseNetshWlan', () => {
  it('reads the SSID in any language and is null without a link', () => {
    expect(parseNetshWlan('    Nom      : Wi-Fi\n    État : connecté\n    SSID     : MaBox\n    BSSID : aa:bb')).toEqual({ connected: true, ssid: 'MaBox', interface: 'Wi-Fi' })
    expect(parseNetshWlan('Il n’existe aucune interface sans fil sur le système.')).toBeNull()
  })
})

describe('pickInterface', () => {
  it('prefers a physical adapter over virtual ones and ignores link-local and internal addresses', () => {
    const nic = (address: string, internal = false) => [{ address, family: 'IPv4', internal }]

    expect(pickInterface({ 'vEthernet (Default Switch)': nic('172.24.240.1'), Tailscale: nic('100.1.2.3'), Ethernet: nic('192.168.1.42'), Loopback: nic('127.0.0.1', true), Bad: nic('169.254.1.1') })).toEqual({ name: 'Ethernet', ipv4: '192.168.1.42' })
    expect(pickInterface({ Tailscale: nic('100.1.2.3') })).toEqual({ name: 'Tailscale', ipv4: '100.1.2.3' })
    expect(pickInterface({ Loopback: nic('127.0.0.1', true) })).toBeNull()
  })
})

describe('toProcessInfo', () => {
  it('scales CPU to the machine and memory to a percentage', () => {
    const [row] = toProcessInfo([{ pid: 9, ppid: 4, name: 'chrome.exe', path: 'C:\\c\\chrome.exe', rss: 250, cpu: 400, user: 'sam' }], 8, 1000)

    expect(row).toEqual({ pid: 9, ppid: 4, user: 'sam', cpuPercent: 50, memPercent: 25, rssBytes: 250, command: 'C:\\c\\chrome.exe', name: 'chrome.exe' })
    expect(toProcessInfo([{ pid: 4, ppid: 0, name: 'System', rss: 1, cpu: 900 }], 1, 0)[0]).toMatchObject({ cpuPercent: 100, memPercent: 0, command: 'System' })
  })
})

describe('recentTargets', () => {
  it('keeps the newest of each file under home and drops noise', () => {
    const home = 'C:\\Users\\Sam'
    const rows = [
      { target: 'C:\\Users\\Sam\\Documents\\a.txt', used: 1 },
      { target: 'c:\\users\\sam\\documents\\A.txt', used: 5 },
      { target: 'C:\\Users\\Sam\\AppData\\Local\\x.dat', used: 9 },
      { target: 'D:\\other\\b.txt', used: 8 },
      { target: 'C:\\Users\\Sam\\proj\\node_modules\\p\\i.js', used: 7 },
      { target: '', used: 6 },
      { target: 'C:\\Users\\Sam\\Pictures\\p.png', used: 3 }
    ]

    expect(recentTargets(rows, home)).toEqual([
      { target: 'c:\\users\\sam\\documents\\A.txt', used: 5 },
      { target: 'C:\\Users\\Sam\\Pictures\\p.png', used: 3 }
    ])
  })
})

describe('rankFiles on Windows paths', () => {
  it('penalises caches and build folders written with backslashes', () => {
    const file = (filePath: string) => ({ path: filePath, name: 'hello.pdf', extension: '.pdf', size: 1, modifiedAt: 0, lastUsedAt: 0, kind: 'file' as const })
    const ranked = rankFiles('hello.pdf', [file('C:\\Users\\Sam\\proj\\node_modules\\x\\hello.pdf'), file('C:\\Users\\Sam\\Documents\\hello.pdf')], 2)

    expect(ranked[0].path).toBe('C:\\Users\\Sam\\Documents\\hello.pdf')
  })
})
