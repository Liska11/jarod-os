import { ipcMain, shell } from 'electron'
import { IPC } from '../../shared/ipc.ts'
import { log } from '../log.ts'
import { internetAllowed } from '../network.ts'
import { checkWindowsUpdate, checkWinget, COVERAGE, readReport, REPORT_FILE, type UpdatesReport, writeReport } from '../updates-check.ts'

/*
 * Système › Mises à jour (electron/updates-check.ts). A check runs only on request and only while Jarod's Internet is on; otherwise the
 * last results are shown with their date, marked as old. Installing is never done from here.
 */

export interface UpdatesState {
  report: UpdatesReport
  running: boolean
  /** The Internet is off: no check can run, the results shown are the last ones. */
  offline: boolean
  windows: boolean
}

export function registerUpdatesCheckIpc(configDir: string): void {
  const file = REPORT_FILE(configDir)
  let running = false

  const state = (): UpdatesState => ({ report: readReport(file), running, offline: !internetAllowed(), windows: process.platform === 'win32' })

  ipcMain.handle(IPC.updatesState, () => state())

  ipcMain.handle(IPC.updatesCheck, async (): Promise<UpdatesState> => {
    if (running || !internetAllowed() || process.platform !== 'win32') return state()

    running = true
    const started = Date.now()

    try {
      const [wu, software] = await Promise.all([checkWindowsUpdate(), checkWinget()])
      const report: UpdatesReport = { checkedAt: new Date().toISOString(), categories: { windows: wu.windows, drivers: wu.drivers, software }, coverage: COVERAGE }
      writeReport(file, report)
      log('updates', `checked in ${Math.round((Date.now() - started) / 1000)} s: windows ${wu.windows.status} (${wu.windows.items.length}), drivers ${wu.drivers.status} (${wu.drivers.items.length}), software ${software.status} (${software.items.length})`)
    } finally {
      running = false
    }

    return state()
  })

  /** Windows Update's own page in Settings: installing Windows updates and drivers is Windows' job, with its own prompts and restarts. */
  ipcMain.handle(IPC.updatesOpenWindowsUpdate, () => shell.openExternal('ms-settings:windowsupdate'))
}
