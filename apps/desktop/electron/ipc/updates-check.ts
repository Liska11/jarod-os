import { BrowserWindow, ipcMain, shell } from 'electron'
import { IPC } from '../../shared/ipc.ts'
import { log } from '../log.ts'
import { internetAllowed } from '../network.ts'
import type { HostControlGate } from '../shell/host-control.ts'
import { checkWindowsUpdate, checkWinget, COVERAGE, readReport, REPORT_FILE, type UpdatesReport, writeReport } from '../updates-check.ts'
import { confirmations, realSpawner, upgradeThroughGate, type WingetPlan, type WingetProgress, type WingetResult, type WingetTarget, wingetSpawner } from '../winget-install.ts'

/*
 * Système › Mises à jour (electron/updates-check.ts). A check runs only on request and only while Jarod's Internet is on; otherwise the
 * last results are shown with their date, marked as old. Windows updates and drivers are never installed from here. One winget package
 * the check listed can be upgraded (electron/winget-install.ts): prepared, confirmed by the person, then run through the control gate.
 */

export interface UpdatesState {
  report: UpdatesReport
  running: boolean
  /** The Internet is off: no check can run, the results shown are the last ones. */
  offline: boolean
  windows: boolean
  /** The one upgrade running now, if any. */
  upgrading: WingetProgress | null
}

export type PrepareReply = { ok: true; plan: WingetPlan } | { ok: false; error: string }
export type UpgradeReply = { ok: true; result: WingetResult; state: UpdatesState } | { ok: false; error: string }

export function registerUpdatesCheckIpc(configDir: string, gate: HostControlGate): void {
  const file = REPORT_FILE(configDir)
  const pending = confirmations()
  const spawner = wingetSpawner()
  const mocked = spawner !== realSpawner
  let running = false
  let upgrading: WingetProgress | null = null

  const state = (): UpdatesState => ({ report: readReport(file), running, offline: !internetAllowed(), windows: process.platform === 'win32' || mocked, upgrading })

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

  // Step 1: what exactly would be upgraded. Only a package of the last check, at the version it listed; refused offline.
  ipcMain.handle(IPC.updatesPrepareUpgrade, (event, target: WingetTarget): PrepareReply => {
    if (!BrowserWindow.fromWebContents(event.sender)) return { ok: false, error: 'Cette fenêtre ne peut pas installer de logiciel.' }
    if (!state().windows) return { ok: false, error: 'La mise à jour des logiciels n’existe que sous Windows.' }

    try {
      return { ok: true, plan: pending.prepare(target, readReport(file).categories.software.items) }
    } catch (error) {
      return { ok: false, error: (error as Error).message }
    }
  })

  // Step 2: the person confirmed the plan. One upgrade at a time, never several in one call.
  ipcMain.handle(IPC.updatesUpgrade, async (event, token: string): Promise<UpgradeReply> => {
    if (!BrowserWindow.fromWebContents(event.sender)) return { ok: false, error: 'Cette fenêtre ne peut pas installer de logiciel.' }
    if (upgrading) return { ok: false, error: `Une mise à jour est déjà en cours (${upgrading.id}).` }

    upgrading = { id: 'winget', phase: 'starting', percent: null, line: '' }

    try {
      const reply = await upgradeThroughGate(gate, pending, token, {
        spawner,
        onProgress: progress => {
          upgrading = progress.phase === 'done' ? upgrading : progress
          if (!event.sender.isDestroyed()) event.sender.send(IPC.updatesProgress, progress)
        }
      })

      if (!reply.ok) return reply

      const { target, result } = reply

      log('updates', `winget upgrade ${target.id} ${target.version} (${target.source}) -> ${result.outcome}${result.exitCode ? ` 0x${result.exitCode.toString(16)}` : ''}`)

      // Done: the package leaves the list, so the same upgrade is not offered twice.
      if (result.outcome === 'success' || result.outcome === 'reboot-required') {
        const report = readReport(file)
        const software = report.categories.software
        const items = software.items.filter(item => item.id !== target.id)

        writeReport(file, { ...report, categories: { ...report.categories, software: { ...software, items, status: items.length ? 'available' : 'up-to-date' } } })
      }

      upgrading = null

      return { ok: true, result, state: state() }
    } finally {
      upgrading = null
    }
  })
}
