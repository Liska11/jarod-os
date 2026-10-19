import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ ipcMain: { handle: () => undefined, on: () => undefined } }))

const { defaultShell } = await import('./terminal.ts')

describe('defaultShell', () => {
  it('uses PowerShell on Windows even when a POSIX $SHELL leaked in from Git Bash', () => {
    expect(defaultShell('win32', { SHELL: '/usr/bin/bash' })).toBe('powershell.exe')
    expect(defaultShell('win32', { JAROD_OS_SHELL: 'pwsh.exe' })).toBe('pwsh.exe')
  })

  it('keeps $SHELL and the platform defaults elsewhere', () => {
    expect(defaultShell('linux', { SHELL: '/usr/bin/fish' })).toBe('/usr/bin/fish')
    expect(defaultShell('darwin', {})).toBe('/bin/zsh')
    expect(defaultShell('linux', {})).toBe('/bin/bash')
  })
})
