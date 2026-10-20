import { app, BrowserWindow, screen, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { JarodOSPrefs } from '../shared/ipc.ts'
import { osEnv } from './env.ts'
import { devServerUrl, isShellPage, rendererIndex } from './paths.ts'
import type { Rect } from './window-state.ts'

const here = path.dirname(fileURLToPath(import.meta.url))

/** The Herald icon: the 1024 px source in a checkout, the renderer's 256 px copy in a package. */
export function appIconPath(): string | undefined {
  const root = app.getAppPath()

  return [path.join(root, 'build', 'icon.png'), path.join(root, 'dist', 'renderer', 'brand', 'jarod-icon.png')].find(file => fs.existsSync(file))
}

/** The smallest the main window may get outside kiosk mode. */
export const MAIN_WINDOW_MIN = { width: 1024, height: 640 }

/** Loads the shell's page: the dev server in development, the bundled renderer otherwise. */
export function loadShell(win: BrowserWindow): void {
  const dev = devServerUrl()

  if (dev) {
    void win.loadURL(dev)
  } else {
    void win.loadFile(rendererIndex())
  }
}

/** `restore`: where the window was last time, already checked against today's screens (see window-state.ts). */
export function createMainWindow(prefs: JarodOSPrefs, restore: { bounds: Rect; maximized: boolean } | null = null): BrowserWindow {
  const { workAreaSize } = screen.getPrimaryDisplay()
  // Jarod-OS Linux: the shell is the whole session (cage hands it the only output). Kiosk mode
  // removes every escape hatch a window manager would normally offer.
  const kiosk = osEnv('KIOSK') === '1'
  const darwin = process.platform === 'darwin'
  const placed = kiosk ? null : restore?.bounds
  const win = new BrowserWindow({
    ...(placed ? { x: placed.x, y: placed.y, width: placed.width, height: placed.height } : { width: workAreaSize.width, height: workAreaSize.height }),
    minWidth: kiosk ? undefined : MAIN_WINDOW_MIN.width,
    minHeight: kiosk ? undefined : MAIN_WINDOW_MIN.height,
    show: false,
    frame: false,
    titleBarStyle: 'hidden',
    // Jarod-OS is its own environment: launch fullscreen on its own Space. `simpleFullscreen`
    // keeps the menu bar hidden without the macOS fullscreen animation on every toggle.
    // JAROD_OS_WINDOWED=1 is a developer escape hatch for automated runs and screenshots.
    fullscreen: kiosk || (prefs.fullscreenOnLaunch && !osEnv('WINDOWED')),
    kiosk,
    simpleFullscreen: false,
    fullscreenable: true,
    backgroundColor: '#07080a',
    // Window vibrancy exists only on macOS; Electron ignores it elsewhere but keep main honest.
    ...(darwin ? { vibrancy: 'under-window' as const, visualEffectState: 'active' as const } : { icon: appIconPath() }),
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false
    }
  })

  // Links stay outside: the renderer must never navigate away from the shell.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) {
      void shell.openExternal(url)
    }

    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (!isShellPage(url)) {
      event.preventDefault()
    }
  })

  loadShell(win)

  // HiDPI on compositors that expose the output at scale 1 (cage in Stage 1): zoom the page instead
  // of forcing Chromium's device scale factor, which would size Wayland buffers wrongly.
  const zoom = Number(osEnv('ZOOM'))

  if (Number.isFinite(zoom) && zoom > 0 && zoom !== 1) {
    const apply = () => win.webContents.setZoomFactor(zoom)
    win.webContents.on('did-finish-load', apply)
    win.webContents.on('did-navigate', apply)
  }

  win.once('ready-to-show', () => {
    if (placed && restore?.maximized && !win.isFullScreen()) {
      win.maximize()
    }

    win.show()
  })

  return win
}
