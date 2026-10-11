import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ powerMonitor: { on: () => undefined }, ipcMain: { handle: () => undefined } }))

const { batteryCrossing, networkKey } = await import('./sources.ts')
const { hookCommand, hookScripts } = await import('./hooks.ts')

describe('batteryCrossing', () => {
  it('fires once when the battery drops to 15% and re-arms after charging', () => {
    let armed = true
    const step = (percent: number, charging = false) => {
      const verdict = batteryCrossing(armed, { present: true, percent, charging })
      armed = verdict.armed

      return verdict.fire
    }

    expect(step(40)).toBe(false)
    expect(step(15)).toBe(true)
    expect(step(12)).toBe(false)
    expect(step(12, true)).toBe(false)
    expect(step(14)).toBe(true)
  })

  it('stays quiet without a battery', () => {
    expect(batteryCrossing(true, { present: false })).toEqual({ fire: false, armed: true })
    expect(batteryCrossing(true, undefined)).toEqual({ fire: false, armed: true })
  })
})

describe('networkKey', () => {
  it('changes when going offline or joining another Wi-Fi network', () => {
    const home = networkKey({ online: true, wifi: { connected: true, ssid: 'Home' } })

    expect(networkKey({ online: true, wifi: { connected: true, ssid: 'Home' } })).toBe(home)
    expect(networkKey({ online: true, wifi: { connected: true, ssid: 'Cafe' } })).not.toBe(home)
    expect(networkKey({ online: false })).not.toBe(home)
  })
})

describe('hookScripts', () => {
  it.skipIf(process.platform === 'win32')('runs executable scripts in name order, skipping samples and dotfiles', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herald-hooks-'))
    const write = (name: string, mode: number) => fs.writeFileSync(path.join(dir, name), '#!/bin/sh\n', { mode })

    write('20-second', 0o755)
    write('10-first', 0o755)
    write('not-executable', 0o644)
    write('30-example.sample', 0o755)
    write('.hidden', 0o755)

    expect(hookScripts(dir).map(file => path.basename(file))).toEqual(['10-first', '20-second'])
    expect(hookScripts(path.join(dir, 'missing'))).toEqual([])
  })

  it('on Windows runs runnable file types instead of looking for an executable bit', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herald-hooks-'))

    for (const name of ['20-second.ps1', '10-first.cmd', '15-tool.exe', 'notes.txt', '30-example.sample', '.hidden.ps1']) {
      fs.writeFileSync(path.join(dir, name), '')
    }

    expect(hookScripts(dir, 'win32').map(file => path.basename(file))).toEqual(['10-first.cmd', '15-tool.exe', '20-second.ps1'])
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('starts scripts through their interpreter on Windows and directly elsewhere', () => {
    expect(hookCommand('C:\\h\\a.ps1', 'wake', 'win32')).toEqual({ file: 'powershell.exe', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\h\\a.ps1', 'wake'] })
    expect(hookCommand('C:\\h\\a.cmd', 'wake', 'win32')).toEqual({ file: 'cmd.exe', args: ['/d', '/c', 'C:\\h\\a.cmd', 'wake'] })
    expect(hookCommand('C:\\h\\a.exe', 'wake', 'win32')).toEqual({ file: 'C:\\h\\a.exe', args: ['wake'] })
    expect(hookCommand('/h/a', 'wake', 'linux')).toEqual({ file: '/h/a', args: ['wake'] })
  })
})
