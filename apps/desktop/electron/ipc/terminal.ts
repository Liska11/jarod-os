import { environmentVariables, listEnvironments } from '../environments.ts'
import { listVms, VM_NAME } from '../vms.ts'
import { type BrowserWindow, ipcMain, type WebContents } from 'electron'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { IPC, type TerminalCreateOptions, type TerminalHandle } from '../../shared/ipc.ts'
import { terminalBin } from '../catalog/catalog.ts'
import { log } from '../log.ts'
import { loadCatalog } from './catalog.ts'
import { normalizeUserPath } from './fs.ts'

interface PtyLike {
  pid: number
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
  onData(listener: (data: string) => void): { dispose(): void }
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void }
}

interface PtyModule {
  spawn(file: string, args: string[], options: Record<string, unknown>): PtyLike
}

let ptyModule: PtyModule | null | undefined

/**
 * The shell a Terminal tab starts. `$SHELL` wins on macOS and Linux; on Windows it is not a
 * Windows path when set (Git Bash exports it), so PowerShell is used unless HERALD_OS_SHELL names one.
 */
export function defaultShell(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  if (platform === 'win32') {
    return env.HERALD_OS_SHELL?.trim() || 'powershell.exe'
  }

  return env.SHELL || (platform === 'darwin' ? '/bin/zsh' : '/bin/bash')
}

/**
 * npm strips the executable bit from node-pty's prebuilt `spawn-helper` (the tarball ships it
 * 0644), and pty.spawn then fails with `posix_spawnp failed`. Restore it before the first load.
 */
export function ensureSpawnHelperExecutable(ptyEntry: string): void {
  if (process.platform === 'win32') {
    return
  }

  const helper = path.join(path.dirname(path.dirname(ptyEntry)), 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper')

  try {
    const mode = fs.statSync(helper).mode

    if ((mode & 0o111) === 0) {
      fs.chmodSync(helper, mode | 0o755)
      log('terminal', `restored executable bit on ${helper}`)
    }
  } catch {
    // No prebuilt helper (compiled from source); nothing to fix.
  }
}

export function loadPty(): PtyModule | null {
  if (ptyModule !== undefined) {
    return ptyModule
  }

  try {
    const require = createRequire(import.meta.url)
    ensureSpawnHelperExecutable(require.resolve('node-pty'))
    ptyModule = require('node-pty') as PtyModule
  } catch (error) {
    log('terminal', `node-pty unavailable: ${error instanceof Error ? error.message : String(error)}`)
    ptyModule = null
  }

  return ptyModule
}

/** Real PTYs for the Terminal surface. One id per tab; output is pushed to the owning window. */
export function registerTerminalIpc(getWindow: () => BrowserWindow | null): void {
  const sessions = new Map<string, PtyLike>()
  const owned = new Map<WebContents, Set<string>>()
  let nextId = 1

  const kill = (id: string) => {
    const child = sessions.get(id)
    sessions.delete(id)

    try {
      child?.kill()
    } catch {
      // Already exited.
    }
  }

  const release = (owner: WebContents) => {
    for (const id of owned.get(owner) ?? []) {
      kill(id)
    }

    owned.get(owner)?.clear()
  }

  // A closed or reloaded page can't show its tabs again, so their shells end with it. This waits
  // for the commit: navigations the shell blocks never reach it.
  const adopt = (owner: WebContents, id: string) => {
    if (!owned.has(owner)) {
      owned.set(owner, new Set())
      owner.on('did-navigate', () => release(owner))
      owner.once('destroyed', () => {
        release(owner)
        owned.delete(owner)
      })
    }

    owned.get(owner)?.add(id)
  }

  ipcMain.handle(IPC.terminalCreate, async (event, options: TerminalCreateOptions): Promise<TerminalHandle> => {
    const pty = loadPty()
    // Output goes back to the window that created the PTY (in panels mode each terminal is its own
    // window); the main window is only a fallback.
    const owner = event.sender
    const target = () => (owner.isDestroyed() ? getWindow()?.webContents : owner)

    if (!pty) {
      throw new Error('Terminal is unavailable: node-pty failed to load for this Electron build.')
    }

    const shell = defaultShell()
    const cwd = options.cwd ? normalizeUserPath(options.cwd) : os.homedir()
    const id = `t${nextId++}`
    // A coding agent from the catalog runs first; the tab stays a shell after it exits.
    const program = options.program ? terminalBin(loadCatalog(), options.program) : null

    if (options.program && !program) {
      throw new Error(`${options.program} is not a terminal program from the install catalog`)
    }

    // An environment of the Jarod disk: its tools come first in PATH, and the tab starts in its folder.
    const jarodRoot = process.env.JAROD_OS_ROOT?.trim()
    const environmentsDir = jarodRoot ? path.join(jarodRoot, 'environments') : null
    const environment = options.environment && environmentsDir ? listEnvironments(environmentsDir).find(item => item.name === options.environment) : undefined

    if (options.environment && !environment) {
      throw new Error(`${options.environment} is not an environment of the Jarod disk`)
    }

    const baseEnv = environment && environmentsDir ? environmentVariables(environmentsDir, environment, process.env) : process.env
    const home = os.homedir()
    const resolved = program ? ([path.join(home, '.local', 'bin', program), path.join(home, '.local', 'share', 'mise', 'shims', program)].find(candidate => fs.existsSync(candidate)) ?? program) : null
    // A WSL machine: the tab is that machine's shell (the name was checked against the list of machines).
    const vm = options.vm && process.platform === 'win32' && VM_NAME.test(options.vm) ? (await listVms()).find(item => item.name === options.vm) : undefined

    if (options.vm && !vm) {
      throw new Error(`${options.vm} is not a WSL machine of this computer`)
    }

    const args = process.platform === 'win32' ? [] : resolved ? ['-l', '-c', `${JSON.stringify(resolved)}; exec ${JSON.stringify(shell)} -l`] : ['-l']
    const child = pty.spawn(vm ? 'wsl.exe' : shell, vm ? ['-d', vm.name, '--cd', '~'] : args, {
      name: 'xterm-256color',
      cols: Math.max(2, options.cols),
      rows: Math.max(1, options.rows),
      cwd: environment && environmentsDir && !options.cwd ? path.join(environmentsDir, environment.name) : cwd,
      env: { ...baseEnv, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'HeraldOS', LANG: process.env.LANG || 'en_US.UTF-8' }
    })
    sessions.set(id, child)
    adopt(owner, id)

    child.onData(data => {
      target()?.send(IPC.terminalData, id, data)
    })
    child.onExit(({ exitCode }) => {
      sessions.delete(id)
      owned.get(owner)?.delete(id)
      target()?.send(IPC.terminalExit, id, exitCode)
    })

    return { id, pid: child.pid, shell }
  })

  ipcMain.on(IPC.terminalWrite, (_event, id: string, data: string) => {
    sessions.get(id)?.write(data)
  })
  ipcMain.on(IPC.terminalResize, (_event, id: string, cols: number, rows: number) => {
    try {
      sessions.get(id)?.resize(Math.max(2, cols), Math.max(1, rows))
    } catch {
      // Resizing a dying pty throws; ignore.
    }
  })
  ipcMain.handle(IPC.terminalDispose, (_event, id: string) => {
    kill(id)
  })
}
