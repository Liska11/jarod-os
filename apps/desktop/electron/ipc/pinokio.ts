import { BrowserWindow, ipcMain, shell } from 'electron'
import { IPC, type WebOpenOptions } from '../../shared/ipc.ts'
import { log } from '../log.ts'
import type { PinokioService } from '../pinokio/service.ts'
import type { WebViews } from './web.ts'

/*
 * The Pinokio window's half in main: the engine's state (pushed to every window), start and stop, its UI in a web view
 * and its home folder. Pages pinokiod or its UI want shown elsewhere (an app's own UI, a link out) go to the window
 * through `pinokioOpenUrl`, which opens them as Jarod-OS windows.
 */

export function registerPinokioIpc(service: PinokioService, views: () => WebViews | null, mainWindow: () => BrowserWindow | null): void {
  ipcMain.handle(IPC.pinokioGetState, () => service.refresh())
  ipcMain.handle(IPC.pinokioStart, () => service.start())
  ipcMain.handle(IPC.pinokioStop, () => service.stop())
  ipcMain.handle(IPC.pinokioOpenHome, async () => {
    const home = service.state.home

    if (!home) {
      throw new Error('The Pinokio engine has no home folder yet: open Pinokio once to choose it.')
    }

    const error = await shell.openPath(home)

    if (error) {
      throw new Error(error)
    }
  })
  ipcMain.handle(IPC.pinokioOpenView, async (event, url: unknown, options: WebOpenOptions = {}) => {
    const manager = views()

    if (!manager) {
      throw new Error('web views are not ready yet')
    }

    const state = await service.start()

    if (state.phase !== 'running' && state.phase !== 'external') {
      throw new Error(state.error ?? 'The Pinokio engine is not running.')
    }

    const target = typeof url === 'string' && url ? url : state.url

    return manager.openPinokio(event.sender, target, options, page => openElsewhere(mainWindow, page))
  })
}

/** Ask the shell to show `url` in a Jarod-OS window (desktop mode); the system browser when no window is up. */
export function openElsewhere(mainWindow: () => BrowserWindow | null, url: string, surface: 'window' | 'browser' = 'window'): void {
  const win = mainWindow()

  if (surface === 'browser' || !win || win.isDestroyed()) {
    log('pinokio', `opening ${url} in the system browser`)
    void shell.openExternal(url)

    return
  }

  win.webContents.send(IPC.pinokioOpenUrl, url)
}

export function broadcastPinokioState(state: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(IPC.pinokioState, state)
    }
  }
}
