import { describe, expect, it } from 'vitest'
import type { InstalledApp } from '../../shared/ipc.ts'
import { assertLaunchable, isInstalledApp } from './launch-guard.ts'

const catalog: InstalledApp[] = [
  { name: 'Calculatrice', path: 'shell:AppsFolder\\Microsoft.WindowsCalculator_8wekyb3d8bbwe!App', bundleId: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App' },
  { name: 'Notepad', path: 'C:\\Program Files\\Notepad++\\notepad++.exe' }
]

describe('isInstalledApp', () => {
  it('accepts an entry the Start Menu lists, whatever the letter case', () => {
    expect(isInstalledApp('shell:AppsFolder\\Microsoft.WindowsCalculator_8wekyb3d8bbwe!App', catalog, 'win32')).toBe(true)
    expect(isInstalledApp('shell:appsfolder\\microsoft.windowscalculator_8wekyb3d8bbwe!app', catalog, 'win32')).toBe(true)
    expect(isInstalledApp('C:\\Program Files\\Notepad++\\notepad++.exe', catalog, 'win32')).toBe(true)
  })

  it('accepts a bare bundle id', () => {
    expect(isInstalledApp('Microsoft.WindowsCalculator_8wekyb3d8bbwe!App', catalog, 'win32')).toBe(true)
  })

  it('refuses a program the catalog does not list', () => {
    expect(isInstalledApp('C:\\Users\\Sam\\Downloads\\maj.msi', catalog, 'win32')).toBe(false)
    expect(isInstalledApp('C:\\Windows\\System32\\cmd.exe', catalog, 'win32')).toBe(false)
    expect(isInstalledApp('\\\\partage\\maj.msi', catalog, 'win32')).toBe(false)
  })

  it('uses the platform comparison for the macOS catalog', () => {
    const mac: InstalledApp[] = [{ name: 'Safari', path: '/Applications/Safari.app', bundleId: 'com.apple.Safari' }]

    expect(isInstalledApp('/Applications/Safari.app', mac, 'darwin')).toBe(true)
    expect(isInstalledApp('com.apple.Safari', mac, 'darwin')).toBe(true)
    expect(isInstalledApp('/Applications/Safari.APP', mac, 'darwin')).toBe(true)
    expect(isInstalledApp('applications/safari.app', mac, 'darwin')).toBe(false)
  })

  it('assertLaunchable returns a listed entry and throws for anything else', () => {
    expect(assertLaunchable('shell:AppsFolder\\Microsoft.WindowsCalculator_8wekyb3d8bbwe!App', catalog, 'win32')).toBe('shell:AppsFolder\\Microsoft.WindowsCalculator_8wekyb3d8bbwe!App')
    expect(() => assertLaunchable('C:\\Users\\Sam\\Downloads\\maj.msi', catalog, 'win32')).toThrow(/not an application installed on this machine/)
  })
})
