import path from 'node:path'
import type { InstalledApp } from '../../shared/ipc.ts'

/** The Start Menu reports what the OS resolves; compare without case and without separator surprises. */
function fold(value: string, platform: NodeJS.Platform): string {
  const lib = platform === 'win32' ? path.win32 : path.posix

  // Case-insensitive everywhere: the entry must already be in the catalog, so leniency here cannot add
  // anything the OS would not resolve anyway.
  return lib.normalize(value).toLowerCase()
}

/**
 * Whether `appPath` names an application the platform catalog really lists — a `shell:AppsFolder\<AppID>`
 * entry, a bundle id, or the program's own path. The window starts applications through the shell's
 * default action, which runs whatever it is given: a path the model wrote (a shortcut to a script, a
 * downloaded installer) must never reach it. Launching is limited to what the Apps grid itself shows.
 */
export function isInstalledApp(appPath: string, apps: readonly Pick<InstalledApp, 'path' | 'bundleId'>[], platform: NodeJS.Platform = process.platform): boolean {
  const target = fold(appPath, platform)

  return apps.some(app => fold(app.path, platform) === target || Boolean(app.bundleId && fold(app.bundleId, platform) === target))
}

/**
 * Same rule, as a gate: returns the path to start, or throws. Keeping the decision here (rather than in the
 * IPC handler) makes the refusal testable without Electron.
 */
export function assertLaunchable(appPath: string, apps: readonly Pick<InstalledApp, 'path' | 'bundleId'>[], platform: NodeJS.Platform = process.platform): string {
  if (!isInstalledApp(appPath, apps, platform)) {
    throw new Error('not an application installed on this machine')
  }

  return appPath
}
