import { describe, expect, it } from 'vitest'
import { powerCommand } from './power.ts'

describe('powerCommand', () => {
  it('runs shutdown.exe and rundll32 on Windows, without forcing applications closed', () => {
    expect(powerCommand('win32', 'poweroff')).toEqual(['shutdown.exe', '/s', '/t', '0'])
    expect(powerCommand('win32', 'reboot')).toEqual(['shutdown.exe', '/r', '/t', '0'])
    expect(powerCommand('win32', 'logout')).toEqual(['shutdown.exe', '/l'])
    expect(powerCommand('win32', 'lock')).toEqual(['rundll32.exe', 'user32.dll,LockWorkStation'])
    expect(powerCommand('win32', 'suspend')).toEqual(['rundll32.exe', 'powrprof.dll,SetSuspendState', '0,1,0'])

    for (const action of ['suspend', 'reboot', 'poweroff', 'logout', 'lock'] as const) {
      expect(powerCommand('win32', action)).not.toContain('/f')
    }
  })

  it('keeps systemd and niri on Linux', () => {
    expect(powerCommand('linux', 'poweroff')).toEqual(['systemctl', 'poweroff'])
    expect(powerCommand('linux', 'lock')).toEqual(['herald-os', 'lock'])
  })

  it('has nothing for macOS or an unknown action, and hands out a copy', () => {
    expect(powerCommand('darwin', 'poweroff')).toBeNull()
    expect(powerCommand('win32', 'format' as never)).toBeNull()
    expect(powerCommand('win32', 'constructor' as never)).toBeNull()

    powerCommand('win32', 'poweroff')!.push('/f')
    expect(powerCommand('win32', 'poweroff')).toEqual(['shutdown.exe', '/s', '/t', '0'])
  })
})
