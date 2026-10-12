import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, shell } from 'electron'
import { IPC } from '../../shared/ipc.ts'
import { type NativeDialogs, type NativeEffects, runNativeGesture, str } from './jarod-shell-gestures.ts'

/* Registers the `jarod.shell` gestures (see jarod-shell-gestures.ts for the rules). */

export function registerJarodShellIpc(getWindow: () => BrowserWindow | null): void {
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
    }
  }

  ipcMain.handle(IPC.jarodShell, (_event, kind: unknown, params: unknown) =>
    runNativeGesture(str(kind, 40), params && typeof params === 'object' ? (params as Record<string, unknown>) : {}, dialogs, effects)
  )
}
