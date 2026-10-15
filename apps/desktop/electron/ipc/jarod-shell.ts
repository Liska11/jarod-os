import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, session, shell } from 'electron'
import { IPC } from '../../shared/ipc.ts'
import { AgentBrowser, type ElectronBits } from '../agent-browser/agent-browser.ts'
import { runBrowserOp } from '../agent-browser/host.ts'
import { log } from '../log.ts'
import { type NativeDialogs, type NativeEffects, runNativeGesture, str } from './jarod-shell-gestures.ts'

/* Registers the `jarod.shell` gestures (see jarod-shell-gestures.ts for the rules). */

export function registerJarodShellIpc(getWindow: () => BrowserWindow | null, restartBackend: () => void): void {
  const parent = () => getWindow() ?? undefined

  const dialogs: NativeDialogs = {
    async open(options) {
      const win = parent()
      const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)

      return result.canceled ? null : (result.filePaths[0] ?? null)
    },
    async save(options) {
      const win = parent()
      const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)

      return result.canceled ? null : (result.filePath ?? null)
    },
    async message(options) {
      const win = parent()
      const result = win ? await dialog.showMessageBox(win, { ...options, noLink: true }) : await dialog.showMessageBox({ ...options, noLink: true })

      return result.response
    }
  }

  // The agent's browser: one isolated window, created on the first `browser_open`. Whether it shows and whether its session is kept on disk are the engine's
  // settings, sent with every call.
  let browserSettings = { visible: true, persistent: false }
  const agentBrowser = new AgentBrowser({ electron: { BrowserWindow, session } as unknown as ElectronBits, visible: () => browserSettings.visible, persistent: () => browserSettings.persistent })

  app.on('before-quit', () => void agentBrowser.close().catch(() => {}))

  const effects: NativeEffects = {
    writeClipboard: text => clipboard.writeText(text),
    openExternal: url => shell.openExternal(url),
    openPath: path => shell.openPath(path),
    showItemInFolder: path => shell.showItemInFolder(path),
    setThemeSource: source => {
      nativeTheme.themeSource = source
    },
    quit: () => app.quit(),
    relaunch: () => {
      app.relaunch()
      app.quit()
    },
    browser: params => {
      browserSettings = { visible: params.visible !== false, persistent: params.persistent === true }

      return runBrowserOp(agentBrowser, params.op, params.args)
    },
    // Later, so the gateway still receives the answer to this very gesture before it is stopped.
    restartBackend: () => void setTimeout(restartBackend, 400)
  }

  ipcMain.handle(IPC.jarodShell, (_event, kind: unknown, params: unknown) => {
    const gesture = str(kind, 40)

    return runNativeGesture(gesture, params && typeof params === 'object' ? (params as Record<string, unknown>) : {}, dialogs, effects).catch((error: unknown) => {
      // The engine reads the refusal itself; the log keeps one bounded line for the gestures that name a file.
      if (gesture === 'openPath' || gesture === 'showItemInFolder') {
        log('jarod.shell', `refused ${gesture}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 200))
      }

      throw error
    })
  })
}
