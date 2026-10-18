import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc.ts'
import { isNativeAppId, type NativeAppId } from '../../shared/web-sites.ts'
import { log } from '../log.ts'
import { interpret, realRunner, type InstallResult, type Runner } from '../setup/install.ts'

/*
 * Desktop apps the Social, Player and Browser pages hand over to: Signal (it has no web version), VLC (what Chromium
 * cannot play) and Brave. Jarod-OS finds them where their installers put them, starts them with a file or page, and
 * installs a missing one with winget. The list is closed, and so are the arguments: a file the user picked, a web page.
 */

export interface NativeAppDef {
  winget: string
  /** Where the installer puts the program, under an environment folder. */
  places: ReadonlyArray<readonly ['LOCALAPPDATA' | 'ProgramFiles' | 'ProgramFiles(x86)', string]>
}

export const NATIVE_APPS: Readonly<Record<NativeAppId, NativeAppDef>> = {
  signal: { winget: 'OpenWhisperSystems.Signal', places: [['LOCALAPPDATA', 'Programs\\signal-desktop\\Signal.exe']] },
  vlc: {
    winget: 'VideoLAN.VLC',
    places: [
      ['ProgramFiles', 'VideoLAN\\VLC\\vlc.exe'],
      ['ProgramFiles(x86)', 'VideoLAN\\VLC\\vlc.exe']
    ]
  },
  brave: {
    winget: 'Brave.Brave',
    places: [
      ['LOCALAPPDATA', 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'],
      ['ProgramFiles', 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'],
      ['ProgramFiles(x86)', 'BraveSoftware\\Brave-Browser\\Application\\brave.exe']
    ]
  }
}

/** The program's path, or null when it is not installed (or not on Windows). */
export function findNativeApp(id: NativeAppId, env: NodeJS.ProcessEnv = process.env, exists: (file: string) => boolean = fs.existsSync, platform = process.platform): string | null {
  if (platform !== 'win32') {
    return null
  }

  for (const [variable, rest] of NATIVE_APPS[id].places) {
    const base = env[variable]

    if (base) {
      const file = path.win32.join(base, rest)

      if (exists(file)) {
        return file
      }
    }
  }

  return null
}

/** What may be handed to the app: a page for Brave, an existing file for VLC, nothing for Signal. */
export function launchArgument(id: NativeAppId, target: unknown, isFile: (file: string) => boolean = file => fs.statSync(file, { throwIfNoEntry: false })?.isFile() ?? false): string[] {
  if (typeof target !== 'string' || !target) {
    return []
  }

  if (id === 'brave' && /^https?:\/\//i.test(target)) {
    return [target]
  }

  if (id === 'vlc' && path.isAbsolute(target) && isFile(target)) {
    return ['--', target]
  }

  return []
}

export function wingetInstall(id: NativeAppId): { command: string; args: string[] } {
  return {
    command: 'winget',
    args: ['install', '--id', NATIVE_APPS[id].winget, '--exact', '--source', 'winget', '--no-upgrade', '--silent', '--disable-interactivity', '--accept-package-agreements', '--accept-source-agreements']
  }
}

export async function installNativeApp(id: NativeAppId, run: Runner = realRunner): Promise<InstallResult> {
  if (process.platform !== 'win32') {
    return { ok: false, error: 'automatic install is only available on Windows' }
  }

  const command = wingetInstall(id)
  log('apps', `installing ${id}: ${command.command} ${command.args.join(' ')}`)
  const { code, output } = await run(command, process.env, 15 * 60_000)
  const result = interpret(id, code, output)
  log('apps', `${id}: ${result.ok ? (result.already ? 'already installed' : 'installed') : `failed — ${result.error}`}`)

  return result
}

export function registerNativeAppsIpc(): void {
  let installing = false

  ipcMain.handle(IPC.nativeAppFind, (_event, id: unknown) => (isNativeAppId(id) ? findNativeApp(id) !== null : false))
  ipcMain.handle(IPC.nativeAppLaunch, (_event, id: unknown, target: unknown) => {
    if (!isNativeAppId(id)) {
      throw new Error('unknown app')
    }

    const program = findNativeApp(id)

    if (!program) {
      throw new Error(`${id} is not installed`)
    }

    const child = spawn(program, launchArgument(id, target), { detached: true, stdio: 'ignore', windowsHide: false })
    child.on('error', error => log('apps', `${id} failed to start: ${error.message}`))
    child.unref()
    log('apps', `started ${id}`)
  })
  ipcMain.handle(IPC.nativeAppInstall, async (_event, id: unknown): Promise<InstallResult> => {
    if (!isNativeAppId(id)) {
      return { ok: false, error: 'unknown app' }
    }

    if (installing) {
      return { ok: false, error: 'another install is running' }
    }

    installing = true

    try {
      return await installNativeApp(id)
    } finally {
      installing = false
    }
  })
}
