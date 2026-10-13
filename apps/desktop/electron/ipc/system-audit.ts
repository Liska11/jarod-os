import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc.ts'
import type { AuditService } from '../setup/service.ts'

/** The system audit's half in main: the saved (or running) report, and a fresh audit on request. */
export function registerSystemAuditIpc(service: AuditService): void {
  ipcMain.handle(IPC.systemAuditGet, () => service.get())
  ipcMain.handle(IPC.systemAuditRun, () => service.get(true))
}
