import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { osEnv } from './env.ts'

/** Profile-aware Hermes home; mirrors upstream `get_hermes_home()` for the default profile. */
export function hermesHome(): string {
  const override = process.env.HERMES_HOME?.trim()

  if (override) {
    return override
  }

  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'hermes')
  }

  return path.join(os.homedir(), '.hermes')
}

/** The shell's folder in the Hermes home: `jarod-os` since the rename (phase 5); migrate.ts copies the older `herald-os` into it once. */
export function heraldOsDataDir(): string {
  return path.join(hermesHome(), 'jarod-os')
}

/**
 * The shell's own settings: widget plugins, hook scripts, user themes, branding, menu entries, first-run state.
 * `~/.config/herald-os` on Linux and macOS, where the `herald-os` CLI and the docs expect it. On Windows it is
 * `%APPDATA%\Jarod-OS\config`, beside the app's other settings, rather than a Unix dot-folder in the home
 * (`migrateShellConfig` moves an old one over). JAROD_OS_CONFIG_DIR moves it anywhere (a portable install, tests).
 */
export function shellConfigDir(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  const override = osEnv('CONFIG_DIR', env)?.trim()

  if (override) {
    return override
  }

  if (platform === 'win32') {
    return path.win32.join(env.APPDATA ?? path.win32.join(home, 'AppData', 'Roaming'), 'Jarod-OS', 'config')
  }

  return path.join(home, '.config', 'herald-os')
}

/** Where the shell's settings lived on Windows before they got a Windows home. */
export function legacyShellConfigDir(home: string = os.homedir()): string {
  return path.join(home, '.config', 'herald-os')
}

export const isDev = process.env.JAROD_OS_BUILD_MODE === 'development' || Boolean(osEnv('DEV_SERVER'))

/**
 * The Windows AppUserModelID: the installed app's only when packaged. Any run from the checkout (dev server, `electron .`, the
 * e2e suite) uses electron.exe; under the installed app's id it left a Start Menu shortcut to electron.exe carrying that id,
 * and the taskbar then showed Electron's icon for the installed Jarod-OS.
 */
export function appUserModelId(packaged: boolean): string {
  return packaged ? 'one.jarod.os' : 'one.jarod.os.dev'
}

export function devServerUrl(): string | undefined {
  return osEnv('DEV_SERVER')
}

/** The built renderer page. Every electron/ module is bundled into dist/electron/main.mjs. */
export function rendererIndex(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'renderer', 'index.html')
}

/**
 * Whether `url` is the shell's own page: the dev server's origin, or the bundled renderer. Shell
 * windows carry the preload bridge, so they must load nothing else (a dropped HTML file or a stray
 * link would otherwise get it), and only the shell may use the microphone.
 */
export function isShellPage(url: string, index = rendererIndex(), dev: string | undefined = devServerUrl()): boolean {
  try {
    const target = new URL(url)

    if (dev) {
      return target.origin === new URL(dev).origin
    }

    return target.protocol === 'file:' && target.pathname === pathToFileURL(index).pathname
  } catch {
    return false
  }
}
