import { atom } from 'nanostores'
import { isPanels } from './shell.ts'
import { openApp } from './windows.ts'

/** A coding agent to start in a new Terminal tab (desktop mode; panels mode sends a command instead). */
export const $terminalRequest = atom<{ program?: string; environment?: string; vm?: string; ssh?: { host: string; port: number; user: string; identity?: string }; label: string; at: number } | null>(null)

/** Open the Terminal with a new tab running a catalog coding agent (claude, codex, …). */
export function openTerminalProgram(program: string, label: string): void {
  if (isPanels) {
    window.heraldOS.shell.open('window:terminal', { type: 'terminal-program', args: [program, label] }).catch(() => undefined)

    return
  }

  $terminalRequest.set({ program, label, at: Date.now() })
  openApp('terminal')
}

/** Open the Terminal with a new tab inside an environment of the Jarod disk (its tools first in PATH). */
export function openTerminalEnvironment(environment: string): void {
  $terminalRequest.set({ environment, label: environment, at: Date.now() })
  openApp('terminal')
}

/** Open the Terminal with a new tab on a WSL machine (wsl -d <name>). */
export function openTerminalVm(vm: string): void {
  $terminalRequest.set({ vm, label: vm, at: Date.now() })
  openApp('terminal')
}
