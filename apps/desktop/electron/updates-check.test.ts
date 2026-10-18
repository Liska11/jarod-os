import { describe, expect, it } from 'vitest'
import { wingetCommand } from './ipc/terminal.ts'
import { NetworkPolicyService, setActiveNetworkPolicy } from './network.ts'
import { parseWindowsUpdate, parseWinget, WU_SCRIPT } from './updates-check.ts'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Real output of `winget upgrade --include-unknown` on a French Windows (2026-10-18).
const WINGET_FR = `Nom                                        ID                                     Version  Disponible Source
------------------------------------------------------------------------------------------------------------
Microsoft OLE DB Driver 19 pour SQL Server Microsoft.SQLServer.OLEDBDriver        19.4.2.0 19.4.3     winget
Visual Studio Build Tools 2022             Microsoft.VisualStudio.2022.BuildTools 17.14.41 17.14.42   winget
2 mises à niveau disponibles.
`

describe('winget', () => {
  it('reads the table whatever the language of its headers, and ignores the summary line', () => {
    expect(parseWinget(WINGET_FR)).toEqual([
      { name: 'Microsoft OLE DB Driver 19 pour SQL Server', id: 'Microsoft.SQLServer.OLEDBDriver', current: '19.4.2.0', available: '19.4.3', source: 'winget', restart: false, elevation: false },
      { name: 'Visual Studio Build Tools 2022', id: 'Microsoft.VisualStudio.2022.BuildTools', current: '17.14.41', available: '17.14.42', source: 'winget', restart: false, elevation: false }
    ])
  })

  it('finds nothing in an answer without a table (no update, or an error text)', () => {
    expect(parseWinget('Aucune mise à niveau disponible.')).toEqual([])
    expect(parseWinget('')).toEqual([])
  })

  it('upgrades one package by its exact id, interactively, and never while the Internet is off', async () => {
    expect(wingetCommand('Microsoft.VisualStudio.2022.BuildTools')).toEqual({ file: 'winget.exe', args: ['upgrade', '--id', 'Microsoft.VisualStudio.2022.BuildTools', '--exact'] })
    expect(() => wingetCommand('--all')).toThrow()
    expect(() => wingetCommand('a b')).toThrow()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarod-upd-'))
    const service = new NetworkPolicyService(dir)
    service.load()
    setActiveNetworkPolicy(service)
    await service.set({ internet: false })
    expect(() => wingetCommand('Git.Git')).toThrow(/Internet désactivé/)
    setActiveNetworkPolicy(null as never)
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe('Windows Update', () => {
  it('only searches (never downloads or installs)', () => {
    expect(WU_SCRIPT).toContain('CreateUpdateSearcher')
    expect(WU_SCRIPT).not.toMatch(/Download|Install\(|CreateUpdateInstaller|CreateUpdateDownloader/)
  })

  it('splits Windows updates and drivers, with restart and administrator notes', () => {
    const json = JSON.stringify([
      { Title: '2026-10 Mise à jour cumulative (KB5099999)', Type: 1, KB: '5099999', Reboot: 1, Model: '', Maker: '', Date: '' },
      { Title: 'Intel - Display - 31.0.101.5000', Type: 2, KB: '', Reboot: 0, Model: 'Intel(R) UHD Graphics', Maker: 'Intel', Date: '10/01/2026' }
    ])
    const { windows, drivers } = parseWindowsUpdate(json)

    expect(windows).toEqual([{ name: '2026-10 Mise à jour cumulative (KB5099999)', id: 'KB5099999', current: null, available: null, source: 'Windows Update', restart: true, elevation: true }])
    expect(drivers[0]).toMatchObject({ id: 'Intel Intel(R) UHD Graphics', available: '10/01/2026', restart: false })
    expect(parseWindowsUpdate('')).toEqual({ windows: [], drivers: [] })
    expect(parseWindowsUpdate(JSON.stringify({ Title: 'Seule', Type: 1, KB: '1', Reboot: 2 })).windows).toHaveLength(1)
  })
})
