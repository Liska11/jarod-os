import type { PowerAction } from '../../shared/ipc.ts'

/*
 * What a power action runs on this machine. Linux is the Jarod-OS session (systemd, niri); Windows has `shutdown.exe` and two `rundll32` entry points. Nothing
 * else is guessed: an unknown platform gets no command and the caller says "not available" instead of spawning something that does not exist.
 */

const LINUX: Record<PowerAction, string[]> = {
  suspend: ['systemctl', 'suspend'],
  reboot: ['systemctl', 'reboot'],
  poweroff: ['systemctl', 'poweroff'],
  logout: ['niri', 'msg', 'action', 'quit', '--skip-confirmation'],
  lock: ['herald-os', 'lock']
}

// No /f: an application holding unsaved work still gets to say so, as with the Start menu. `/t 0` skips the 30 s countdown the confirmation already stood for.
const WINDOWS: Record<PowerAction, string[]> = {
  suspend: ['rundll32.exe', 'powrprof.dll,SetSuspendState', '0,1,0'],
  reboot: ['shutdown.exe', '/r', '/t', '0'],
  poweroff: ['shutdown.exe', '/s', '/t', '0'],
  logout: ['shutdown.exe', '/l'],
  lock: ['rundll32.exe', 'user32.dll,LockWorkStation']
}

export function powerCommand(platform: NodeJS.Platform, action: PowerAction): string[] | null {
  const table = platform === 'linux' ? LINUX : platform === 'win32' ? WINDOWS : null

  return table && Object.hasOwn(table, action) ? [...table[action]] : null
}
