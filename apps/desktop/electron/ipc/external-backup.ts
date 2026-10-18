import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import {
  DEFAULT_PARTS,
  type ExternalDestination,
  type ExternalEstimate,
  type ExternalPart,
  type ExternalProgress,
  type ExternalResult,
  type ExternalSettings,
  type ExternalState,
  OPTIONAL_PARTS
} from '../../shared/external-backup.ts'
import { IPC } from '../../shared/ipc.ts'
import { writeFileAtomic } from '../atomic-write.ts'
import { jarodDataDir, jarodWorkspace } from '../backend/jarod-core.ts'
import { cleanLeftovers, dataExclusion, listExternal, makeBackup, type PartSource, planBackup, stageRestore, swapIn, verifyExternal } from '../external-backup.ts'
import { checkDestination, readVolumes, realish, volumeOf } from '../external-destination.ts'
import { log } from '../log.ts'
import { acquireOperation, busyWith } from '../operation-lock.ts'
import { listVms } from '../vms.ts'

/*
 * External backups in the running app (electron/external-backup.ts, docs/BACKUP-EXTERNE.md). The core is stopped while its data is
 * copied (its databases go through its own maintenance mode, without the vault's values) and started again only if it was running.
 * One operation at a time (operation-lock.ts). Progress goes to every window; a backup can be cancelled; the automatic one is off by
 * default and runs only when its disk is there and is still the same volume.
 */

const SETTINGS_FILE = 'external-backup.json'
const INSTANCE_FILE = 'instance.json'
const HOURS = [6, 12, 24, 72, 168]

export interface ExternalBackupDeps {
  configDir: string
  isCoreRunning: () => boolean
  stopCore: () => Promise<void>
  startCore: () => void
  /** The core's maintenance mode: a database snapshot without the vault's values; resolves with how many were removed. */
  snapshotDb: (src: string, dest: string) => Promise<number>
  relaunch: () => void
}

const idle: ExternalProgress = { operation: null, phase: 'idle', done: 0, total: 0, current: '' }

export class ExternalBackupService {
  private progress: ExternalProgress = { ...idle }
  private abort: AbortController | null = null
  private last: ExternalState['last'] = null
  private deferred: string | null = null
  private timer: NodeJS.Timeout | null = null

  constructor(private readonly deps: ExternalBackupDeps) {}

  // ── Settings ───────────────────────────────────────────────────────────

  settings(): ExternalSettings {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(this.deps.configDir, SETTINGS_FILE), 'utf8')) as Partial<ExternalSettings> & { last?: ExternalState['last'] }
      const parts = Array.isArray(raw.parts) ? raw.parts.filter((p): p is ExternalPart => [...DEFAULT_PARTS, ...OPTIONAL_PARTS].includes(p as ExternalPart)) : DEFAULT_PARTS
      const destination = raw.destination && typeof raw.destination.path === 'string' ? { path: raw.destination.path, volumeId: typeof raw.destination.volumeId === 'string' ? raw.destination.volumeId : null, label: String(raw.destination.label ?? '') } : null
      const everyHours = HOURS.includes(Number(raw.auto?.everyHours)) ? Number(raw.auto?.everyHours) : 24
      this.last ??= raw.last ?? null

      return { destination, parts: parts.length ? parts : DEFAULT_PARTS, auto: { enabled: raw.auto?.enabled === true, everyHours } }
    } catch {
      return { destination: null, parts: [...DEFAULT_PARTS], auto: { enabled: false, everyHours: 24 } }
    }
  }

  private save(settings: ExternalSettings): void {
    writeFileAtomic(path.join(this.deps.configDir, SETTINGS_FILE), `${JSON.stringify({ ...settings, last: this.last }, null, 2)}\n`)
  }

  instance(): string {
    const file = path.join(this.deps.configDir, INSTANCE_FILE)

    try {
      const id = (JSON.parse(fs.readFileSync(file, 'utf8')) as { id?: unknown }).id

      if (typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id)) return id
    } catch {
      // First time: a new id below.
    }

    const id = randomUUID()
    writeFileAtomic(file, `${JSON.stringify({ id, created: new Date().toISOString() }, null, 2)}\n`)

    return id
  }

  // ── Sources ────────────────────────────────────────────────────────────

  private sources(parts: ExternalPart[]): PartSource[] {
    const root = process.env.JAROD_OS_ROOT?.trim() || null
    const list: PartSource[] = []

    for (const part of parts) {
      if (part === 'data') list.push({ part, dir: jarodDataDir(), exclude: dataExclusion })
      if (part === 'workspace') list.push({ part, dir: jarodWorkspace() })
      // Only the preferences: where the Jarod disk is, the Internet switch and local state are this machine's, never restored.
      if (part === 'config') list.push({ part, dir: this.deps.configDir, exclude: rel => (rel === 'prefs.json' ? null : 'réglages propres à cette machine (emplacement du disque, interrupteur Internet, état local)') })
      if (root && (part === 'environments' || part === 'sandboxes' || part === 'vms')) list.push({ part, dir: path.join(root, part) })
    }

    return list
  }

  private sourceDirs(): string[] {
    const root = process.env.JAROD_OS_ROOT?.trim()

    return [jarodDataDir(), jarodWorkspace(), this.deps.configDir, ...(root ? [path.join(root, 'environments'), path.join(root, 'sandboxes'), path.join(root, 'vms')] : [])]
  }

  async estimate(parts: ExternalPart[]): Promise<ExternalEstimate> {
    const plan = await planBackup(this.sources(parts))

    return { bytes: plan.bytes, files: plan.files.length, excluded: alwaysExcluded(plan.excluded, parts) }
  }

  // ── Destination ────────────────────────────────────────────────────────

  async destinationStatus(destination: ExternalDestination | null): Promise<ExternalState['destinationStatus']> {
    if (!destination) return 'none'

    const volume = volumeOf(destination.path, await readVolumes())

    if (!volume || !fs.existsSync(destination.path)) return 'absent'
    if (destination.volumeId && volume.uniqueId !== destination.volumeId) return 'changed'

    return 'ok'
  }

  async state(): Promise<ExternalState> {
    const settings = this.settings()
    const status = await this.destinationStatus(settings.destination)
    const list = settings.destination && status === 'ok' ? await listExternal(settings.destination.path) : []

    return { settings, instance: this.instance(), progress: this.progress, destinationStatus: status, last: this.last, deferred: this.deferred, list }
  }

  // ── Backup ─────────────────────────────────────────────────────────────

  private emit(progress: Partial<ExternalProgress>): void {
    this.progress = { ...this.progress, ...progress }

    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IPC.externalBackupProgress, this.progress)
    }
  }

  private finish(ok: boolean, message: string, id?: string): void {
    this.last = { at: new Date().toISOString(), ok, message, ...(id ? { id } : {}) }
    this.save(this.settings())
    this.emit({ ...idle })
  }

  async run(reason: 'manual' | 'auto'): Promise<ExternalResult> {
    const settings = this.settings()

    if (!settings.destination) return { ok: false, error: 'no-destination' }

    const status = await this.destinationStatus(settings.destination)

    if (status !== 'ok') return { ok: false, error: status === 'changed' ? 'destination-changed' : 'destination-absent' }

    const release = acquireOperation('external-backup')

    if (!release) return { ok: false, error: 'busy' }

    const abort = new AbortController()
    this.abort = abort
    const wasRunning = this.deps.isCoreRunning()
    let coreStopped = false
    const restartCore = () => {
      if (coreStopped && wasRunning) {
        coreStopped = false
        this.deps.startCore()
      }
    }

    try {
      const parts = settings.parts

      if (parts.includes('vms')) {
        const root = process.env.JAROD_OS_ROOT?.trim()
        const running = (await listVms()).filter(vm => vm.state.toLowerCase() === 'running' && root && vm.location?.toLowerCase().startsWith(path.join(root, 'vms').toLowerCase()))

        if (running.length) return { ok: false, error: 'vms-running' }
      }

      this.emit({ operation: 'backup', phase: 'measuring', done: 0, total: 0, current: '' })
      const estimate = await planBackup(this.sources(parts))
      const check = checkDestination(settings.destination.path, await readVolumes(), this.sourceDirs(), estimate.bytes)

      if (!check.ok) return { ok: false, error: check.problems[0] ?? 'destination' }

      const instance = this.instance()
      const leftovers = await cleanLeftovers(settings.destination.path, instance)

      if (leftovers) log('external-backup', `removed ${leftovers} interrupted backup folder(s) of this instance`)

      // The core stops before the files are listed: what it writes while running (its state files, its journal) is settled by then.
      if (parts.includes('data') && wasRunning) {
        this.emit({ phase: 'stopping-core' })
        await this.deps.stopCore()
        coreStopped = true
      }

      const plan = await planBackup(this.sources(parts))

      const manifest = await makeBackup(
        { destination: settings.destination.path, instance, app: app.getVersion(), reason, parts, plan: { ...plan, excluded: alwaysExcluded(plan.excluded, parts) } },
        {
          signal: abort.signal,
          snapshotDb: this.deps.snapshotDb,
          afterData: restartCore,
          progress: (phase, done, total, current) => this.emit({ phase, done, total, current })
        }
      )
      log('external-backup', `${manifest.id}: ${manifest.files.length} files, ${manifest.bytes} bytes, ${manifest.secretsRemoved} secret value(s) left out, ${reason}`)
      this.deferred = null
      this.finish(true, 'complete', manifest.id)

      return { ok: true, id: manifest.id }
    } catch (error) {
      const message = describe(error)
      log('external-backup', `${reason} backup failed: ${message}`)
      this.finish(false, message)

      return { ok: false, error: message }
    } finally {
      restartCore()
      this.abort = null
      release()
      if (this.progress.operation) this.emit({ ...idle })
    }
  }

  cancel(): boolean {
    if (!this.abort) return false

    this.abort.abort()

    return true
  }

  // ── Restore ────────────────────────────────────────────────────────────

  /**
   * Restores a backup found on the destination (any instance: a fresh install restores from an older one). Verified in full on its disk,
   * copied into staging folders next to the targets and checked again, then swapped in with the core stopped; the previous folders stay
   * beside them (`*.before-restore-<tag>`). VMs are restored apart (`vms.restored-<tag>`), never over machines in use. Jarod-OS restarts.
   */
  async restore(folder: string): Promise<ExternalResult> {
    const settings = this.settings()

    if (!settings.destination || !realish(folder).toLowerCase().startsWith(realish(settings.destination.path).toLowerCase())) return { ok: false, error: 'not-a-backup' }

    const release = acquireOperation('external-restore')

    if (!release) return { ok: false, error: 'busy' }

    const abort = new AbortController()
    this.abort = abort
    const wasRunning = this.deps.isCoreRunning()
    let swapped = false

    try {
      this.emit({ operation: 'restore', phase: 'verifying', done: 0, total: 0, current: '' })
      const manifest = await verifyExternal(folder, abort.signal, (done, total, current) => this.emit({ done, total, current }))
      const root = process.env.JAROD_OS_ROOT?.trim() || null
      const tag = `${new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-')}`
      const targets: Partial<Record<ExternalPart, string>> = { data: jarodDataDir(), workspace: jarodWorkspace(), config: path.join(this.deps.configDir, `restored-config-${tag}`) }

      if (root) {
        targets.environments = path.join(root, 'environments')
        targets.sandboxes = path.join(root, 'sandboxes')
        targets.vms = path.join(root, `vms.restored-${tag}`)
      }

      this.emit({ phase: 'staging' })
      const staging = await stageRestore(folder, manifest, targets, tag, abort.signal, (done, total, current) => this.emit({ done, total, current }))

      this.emit({ phase: 'swapping', current: '' })
      await this.deps.stopCore()
      const { aside } = await swapIn(staging, targets, tag)
      swapped = true

      // The preferences: the restored prefs.json replaces the current one (kept beside it), the rest of the config stays this machine's.
      const restoredPrefs = path.join(targets.config as string, 'prefs.json')

      if (fs.existsSync(restoredPrefs)) {
        const prefs = path.join(this.deps.configDir, 'prefs.json')
        if (fs.existsSync(prefs)) await fs.promises.rename(prefs, `${prefs}.before-restore-${tag}`)
        await fs.promises.copyFile(restoredPrefs, prefs)
        await fs.promises.rm(targets.config as string, { recursive: true, force: true })
      }

      log('external-backup', `restored ${manifest.id} (${manifest.instance}); previous folders kept: ${aside.join(', ') || 'none'}`)
      this.finish(true, 'restored', manifest.id)
      setTimeout(this.deps.relaunch, 1500)

      return { ok: true, id: manifest.id }
    } catch (error) {
      const message = describe(error)
      log('external-backup', `restore failed: ${message}`)
      this.finish(false, message)

      if (!swapped && wasRunning && !this.deps.isCoreRunning()) this.deps.startCore()

      return { ok: false, error: message }
    } finally {
      this.abort = null
      release()
    }
  }

  // ── Automatic backups ──────────────────────────────────────────────────

  /** Checks every hour (first after two minutes): due, disk present and same volume, nothing else running, core up. Never at quit. */
  startAutomatic(): void {
    const tick = async () => {
      const settings = this.settings()

      if (!settings.auto.enabled || !settings.destination) {
        this.deferred = null

        return
      }

      const lastOk = this.last?.ok ? Date.parse(this.last.at) : 0

      if (Date.now() - lastOk < settings.auto.everyHours * 3_600_000) return

      const status = await this.destinationStatus(settings.destination)

      if (status !== 'ok') {
        this.deferred = status === 'changed' ? 'destination-changed' : 'destination-absent'

        return
      }

      if (busyWith() || !this.deps.isCoreRunning()) {
        this.deferred = 'busy'

        return
      }

      await this.run('auto')
    }

    setTimeout(() => void tick().catch(() => undefined), 120_000)
    this.timer = setInterval(() => void tick().catch(() => undefined), 3_600_000)
    this.timer.unref()
  }

  /** At quit: a backup in progress is cancelled (its folder removed), so the quit is never held up. */
  stop(): void {
    this.abort?.abort()
    if (this.timer) clearInterval(this.timer)
  }

  register(): void {
    ipcMain.handle(IPC.externalBackupState, () => this.state())
    ipcMain.handle(IPC.externalBackupEstimate, (_event, parts: unknown) => this.estimate(validParts(parts)))
    ipcMain.handle(IPC.externalBackupCheck, async (_event, dest: unknown) => {
      if (typeof dest !== 'string') return { ok: false, problems: ['not-absolute'], warnings: [], free: null, fileSystem: null }
      const estimate = await this.estimate(this.settings().parts)

      return checkDestination(dest, await readVolumes(), this.sourceDirs(), estimate.bytes)
    })
    ipcMain.handle(IPC.externalBackupChoose, async event => {
      const win = BrowserWindow.fromWebContents(event.sender)
      const picked = await (win ? dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] }) : dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] }))

      return picked.canceled ? null : (picked.filePaths[0] ?? null)
    })
    ipcMain.handle(IPC.externalBackupSetDestination, async (_event, dest: unknown): Promise<ExternalResult> => {
      if (busyWith()) return { ok: false, error: 'busy' }
      if (dest === null) {
        this.save({ ...this.settings(), destination: null })

        return { ok: true }
      }

      if (typeof dest !== 'string') return { ok: false, error: 'not-absolute' }

      const volumes = await readVolumes()
      const check = checkDestination(dest, volumes, this.sourceDirs(), null)

      if (!check.ok) return { ok: false, error: check.problems[0] ?? 'destination' }

      const volume = volumeOf(realish(dest), volumes)
      this.save({ ...this.settings(), destination: { path: dest, volumeId: volume?.uniqueId ?? null, label: volume?.label ?? '' } })
      log('external-backup', `destination set to ${dest}`)

      return { ok: true }
    })
    ipcMain.handle(IPC.externalBackupSetOptions, (_event, parts: unknown, auto: unknown) => {
      const current = this.settings()
      const a = auto as { enabled?: unknown; everyHours?: unknown } | null
      this.save({ ...current, parts: validParts(parts), auto: { enabled: a?.enabled === true, everyHours: HOURS.includes(Number(a?.everyHours)) ? Number(a?.everyHours) : current.auto.everyHours } })

      return this.state()
    })
    ipcMain.handle(IPC.externalBackupRun, () => this.run('manual'))
    ipcMain.handle(IPC.externalBackupCancel, () => this.cancel())
    ipcMain.handle(IPC.externalBackupRestore, (_event, folder: unknown) => (typeof folder === 'string' ? this.restore(folder) : { ok: false, error: 'not-a-backup' }))
  }
}

function validParts(parts: unknown): ExternalPart[] {
  const all = [...DEFAULT_PARTS, ...OPTIONAL_PARTS]
  const list = Array.isArray(parts) ? parts.filter((p): p is ExternalPart => all.includes(p as ExternalPart)) : []

  return list.length ? [...new Set(list)] : [...DEFAULT_PARTS]
}

/** What a backup never holds, said before it starts, plus what the walk left out. */
function alwaysExcluded(found: string[], parts: ExternalPart[]): string[] {
  const always = [
    'valeurs du coffre et clés des fournisseurs (retirées de la copie de la base ; à ressaisir après une restauration)',
    'sessions web et profil Electron (%APPDATA%\\Jarod-OS)',
    'modèles locaux et moteurs (re-téléchargeables)',
    'les sauvegardes elles-mêmes (locales et externes)'
  ]

  for (const part of OPTIONAL_PARTS) {
    if (!parts.includes(part)) always.push(`${part} (non choisi)`)
  }

  return [...new Set([...always, ...found])]
}

function describe(error: unknown): string {
  const code = (error as NodeJS.ErrnoException)?.code
  const message = error instanceof Error ? error.message : String(error)

  if (code === 'ENOSPC') return 'no-space'
  if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') return `locked: ${message.slice(0, 200)}`
  if (code === 'ENOENT' || code === 'EIO' || code === 'ENODEV') return `unreachable: ${message.slice(0, 200)}`
  if (message === 'annulé' || (error as Error)?.name === 'AbortError') return 'cancelled'

  return message.slice(0, 300)
}
