import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc.ts'
import { log } from '../log.ts'
import { freshEnv } from '../setup/audit.ts'
import { type InstallResult, installPrerequisite, isInstallable } from '../setup/install.ts'
import type { AuditService } from '../setup/service.ts'

/** The system audit's half in main: the saved (or running) report, a fresh audit on request, and installing what it found missing. */
export function registerSystemAuditIpc(service: AuditService): void {
  ipcMain.handle(IPC.systemAuditGet, () => service.get())
  ipcMain.handle(IPC.systemAuditRun, () => service.get(true))
  // One install at a time: winget and the Windows installer take one package at a time anyway.
  let busy: Promise<InstallResult> | null = null
  ipcMain.handle(IPC.systemAuditInstall, async (_event, tool: unknown, upgrade: unknown): Promise<InstallResult> => {
    if (!isInstallable(tool)) throw new Error('this prerequisite cannot be installed from here')
    if (busy) await busy.catch(() => undefined)
    busy = (async () => installPrerequisite(tool, { upgrade: upgrade === true, env: await freshEnv(), log: message => log('setup', message) }))()
    try {
      return await busy
    } finally {
      busy = null
    }
  })
}
