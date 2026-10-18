import path from 'node:path'
import { ipcMain } from 'electron'
import type { BackupActionResult, BackupsState } from '../../shared/backups.ts'
import { IPC } from '../../shared/ipc.ts'
import { jarodDataDir, jarodWorkspace } from '../backend/jarod-core.ts'
import { type BackupReason, createBackup, dailyDue, listBackups, readSettings, removeBackup, restoreBackup, toPrune, writeSettings } from '../backups.ts'
import { log } from '../log.ts'

/*
 * Backups of the Jarod disk (electron/backups.ts): made by hand from Settings, or daily at startup; restored with the
 * core stopped, then Jarod-OS restarts. They live in <JAROD_OS_ROOT>\backups, so they need the Jarod disk.
 */

export class BackupService {
  private running = false

  constructor(private readonly options: { stopBackend: () => Promise<void>; startBackend: () => void; relaunch: () => void; env?: NodeJS.ProcessEnv }) {}

  get folder(): string | null {
    const root = (this.options.env ?? process.env).JAROD_OS_ROOT?.trim()

    return root ? path.join(root, 'backups') : null
  }

  state(): BackupsState {
    const folder = this.folder
    const settings = folder ? readSettings(folder) : { daily: false, keep: 0 }

    return { available: Boolean(folder), folder, ...settings, running: this.running, list: folder ? listBackups(folder) : [] }
  }

  /**
   * Back up the data (core stopped meanwhile, unless `coreStopped` says it is not running yet) and the workspace, then
   * keep the newest ones. Resolves with the new backup's id.
   */
  async run(reason: BackupReason, coreStopped = false, afterData?: () => void): Promise<string> {
    const folder = this.folder

    if (!folder) {
      throw new Error('no-disk')
    }

    if (this.running) {
      throw new Error('busy')
    }

    this.running = true
    const started = Date.now()

    try {
      if (!coreStopped) {
        await this.options.stopBackend()
      }

      const manifest = await createBackup(folder, { data: jarodDataDir(), workspace: jarodWorkspace() }, reason, new Date(), () => {
        if (coreStopped) {
          afterData?.()
        } else {
          this.options.startBackend()
        }
      })
      const settings = readSettings(folder)

      for (const old of toPrune(listBackups(folder), settings.keep, manifest.id)) {
        await removeBackup(folder, old.id)
        log('backups', `removed ${old.id} (keeping ${settings.keep})`)
      }

      log('backups', `${manifest.id}: ${manifest.files} files, ${manifest.bytes} bytes, ${manifest.linked} unchanged (linked), ${Math.round((Date.now() - started) / 1000)} s`)

      return manifest.id
    } catch (error) {
      log('backups', `${reason} backup failed: ${error instanceof Error ? error.message : String(error)}`)

      if (!coreStopped) {
        this.options.startBackend()
      }

      throw error
    } finally {
      this.running = false
    }
  }

  /** At startup, before the core starts: the daily backup when one is due. Never blocks the start for long on errors. */
  async dailyBeforeStart(startBackend: () => void): Promise<void> {
    const folder = this.folder

    if (!folder || !readSettings(folder).daily || !dailyDue(listBackups(folder), new Date())) {
      startBackend()

      return
    }

    log('backups', 'daily backup due')
    let started = false
    const start = () => {
      if (!started) {
        started = true
        startBackend()
      }
    }

    // The core has not started yet: the data copies first, then the core starts while the workspace copies.
    try {
      await this.run('daily', true, start).catch(() => undefined)
    } finally {
      start()
    }
  }

  register(): void {
    ipcMain.handle(IPC.backupsState, () => this.state())
    ipcMain.handle(IPC.backupsCreate, async (): Promise<BackupActionResult> => {
      try {
        return { ok: true, id: await this.run('manual') }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    })
    ipcMain.handle(IPC.backupsSettings, (_event, daily: unknown, keep: unknown) => {
      const folder = this.folder

      if (folder && typeof daily === 'boolean' && Number.isInteger(keep) && (keep as number) >= 1 && (keep as number) <= 365) {
        writeSettings(folder, { daily, keep: keep as number })
      }

      return this.state()
    })
    ipcMain.handle(IPC.backupsRemove, async (_event, id: unknown): Promise<BackupActionResult> => {
      const folder = this.folder

      if (!folder || typeof id !== 'string' || this.running) {
        return { ok: false, error: this.running ? 'busy' : 'no-disk' }
      }

      try {
        await removeBackup(folder, id)
        log('backups', `removed ${id} (asked)`)

        return { ok: true }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    })
    ipcMain.handle(IPC.backupsRestore, async (_event, id: unknown, withWorkspace: unknown): Promise<BackupActionResult> => {
      const folder = this.folder

      if (!folder || typeof id !== 'string' || this.running) {
        return { ok: false, error: this.running ? 'busy' : 'no-disk' }
      }

      this.running = true

      try {
        await this.options.stopBackend()
        const { aside } = await restoreBackup(folder, id, { data: jarodDataDir(), ...(withWorkspace === true ? { workspace: jarodWorkspace() } : {}) })
        log('backups', `restored ${id}${withWorkspace === true ? ' with the workspace' : ''}; the previous state is in ${aside}`)
        setTimeout(this.options.relaunch, 1200)

        return { ok: true, id: aside }
      } catch (error) {
        log('backups', `restore of ${id} failed: ${error instanceof Error ? error.message : String(error)}`)
        this.options.startBackend()

        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      } finally {
        this.running = false
      }
    })
  }
}
