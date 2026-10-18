import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc.ts'
import type { DataDiskApplyResult, DataDiskState } from '../../shared/data-disk.ts'
import { jarodDataDir, jarodWorkspace } from '../backend/jarod-core.ts'
import { listDrives, moveToRoot } from '../data-disk.ts'
import type { DataRootState } from '../data-root.ts'
import { log } from '../log.ts'

/*
 * The Jarod disk in Settings and at first run: where the data lives now, the drives it could move to, and the move
 * itself (stop the backend, copy, check, record the choice, restart). Only one move at a time.
 */
export function registerDataDiskIpc(options: { state: DataRootState; configDir: string; stopBackend: () => Promise<void>; startBackend: () => void; relaunch: () => void }): void {
  let moving = false

  ipcMain.handle(IPC.dataDiskState, (): DataDiskState => ({ ...options.state, dataDir: jarodDataDir(), workspace: jarodWorkspace() }))
  ipcMain.handle(IPC.dataDiskDrives, () => listDrives())
  ipcMain.handle(IPC.dataDiskApply, async (_event, root: unknown, move: unknown): Promise<DataDiskApplyResult> => {
    if (typeof root !== 'string' || !root.trim()) {
      return { ok: false, error: 'not-absolute' }
    }

    if (moving) {
      return { ok: false, error: 'busy' }
    }

    moving = true
    const dataDir = jarodDataDir()
    const workspace = jarodWorkspace()
    log('disk', `moving Jarod-OS to ${root} (copy data: ${Boolean(move)}) from ${dataDir} and ${workspace}`)

    try {
      // The core's database is open while it runs: it stops for the copy.
      if (move) {
        await options.stopBackend()
      }

      const result = await moveToRoot({ root: root.trim(), move: Boolean(move), dataDir, workspace, configDir: options.configDir, current: [dataDir, workspace] })
      log('disk', `${result.adopted ? 'adopted' : 'prepared'} ${result.root}: ${result.copied.files} file(s), ${result.copied.bytes} bytes copied; old copies kept: ${result.oldCopies.join(', ') || 'none'}`)
      // The new place takes effect from the next start.
      setTimeout(options.relaunch, 1500)

      return { ok: true, ...result }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      log('disk', `move to ${root} failed: ${reason}`)

      if (move) {
        options.startBackend()
      }

      return { ok: false, error: reason }
    } finally {
      moving = false
    }
  })
}
