import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { BrowserWindow, ipcMain, powerMonitor, powerSaveBlocker } from 'electron'
import { type JarodOSPrefs, type IdleTimings, IPC, type SwitchName, type SwitchState } from '../shared/ipc.ts'
import { log } from './log.ts'
import { run } from './platform/exec.ts'
import { readPrefs, writePrefs } from './prefs.ts'
import { IDLE_RESTART_ACTION } from './shell/host-actions.ts'
import type { HostControlGate } from './shell/host-control.ts'
import { runCliThroughGate } from './shell/services.ts'

const STAY_AWAKE_MARKER = path.join(os.homedir(), '.local', 'state', 'herald-os', 'stay-awake')
const IDLE_CONF = path.join(os.homedir(), '.config', 'herald-os', 'idle.conf')
export const IDLE_DEFAULTS: IdleTimings = { lockAfter: 10, screenOffAfter: 15, suspendAfter: 0 }
const SCREENSAVER_DEFAULT_MINUTES = 5
const IDLE_POLL_MS = 10_000

/** Every switch a window may set. Anything else is refused before the system side is touched. */
const SWITCH_NAMES: readonly SwitchName[] = ['nightLight', 'stayAwake', 'doNotDisturb', 'screensaver']

/** idle.conf for linux/bin/herald-os-idle: seconds, 0 for never. */
export function renderIdleConf(prefs: Pick<JarodOSPrefs, 'idle' | 'screensaver'>): string {
  const idle = { ...IDLE_DEFAULTS, ...prefs.idle }
  const seconds = (minutes: number) => Math.max(0, Math.round(minutes * 60))
  const screensaver = prefs.screensaver?.enabled ? seconds(prefs.screensaver.afterMinutes || SCREENSAVER_DEFAULT_MINUTES) : 0

  return ['# Written by Jarod-OS from Settings; seconds of inactivity, 0 for never.', `screensaver=${screensaver}`, `lock=${seconds(idle.lockAfter)}`, `screen_off=${seconds(idle.screenOffAfter)}`, `suspend=${seconds(idle.suspendAfter)}`, ''].join('\n')
}

/**
 * The quick switches. In the Jarod-OS Linux session the `herald-os` CLI owns the system side
 * (wlsunset for night light, the swayidle unit for staying awake), so the menu bar, the hotkeys and
 * a terminal all agree; elsewhere staying awake is Electron's power-save blocker, which macOS and
 * the D-Bus idle inhibitor (hypridle on Omarchy) honour. Do not disturb and the screensaver are the
 * shell's own.
 */
export class SwitchService {
  private blocker: number | null = null
  private screensaverUp = false
  private control: HostControlGate | null = null

  constructor(
    private readonly options: {
      /** The Jarod-OS Linux session (niri, the herald-os CLI). */
      session: boolean
      getWindows: () => BrowserWindow[]
      /** Preferences changed here (do not disturb, the screensaver): every window follows. */
      onPrefs: (prefs: JarodOSPrefs) => void
      /** Desktop mode: show the screensaver over the shell. */
      showScreensaver: () => void
    }
  ) {}

  /** The system side of a switch runs through the same gate as every other host action (R3.2). */
  setControl(gate: HostControlGate): void {
    this.control = gate
  }

  start(): void {
    ipcMain.handle(IPC.switchesGet, () => this.state())
    ipcMain.handle(IPC.switchesSet, (event, name: SwitchName, enabled: boolean) => {
      if (!BrowserWindow.fromWebContents(event.sender)) {
        log('switches', 'refused a switch change from a window that is not a herald-os surface')

        throw new Error('This window may not change the shell switches.')
      }

      if (!SWITCH_NAMES.includes(name)) {
        log('switches', `refused an unknown switch ${String(name)}`)

        throw new Error(`unknown switch ${String(name)}`)
      }

      return this.set(name, Boolean(enabled))
    })

    if (this.options.session) {
      this.writeIdleConf(readPrefs())
    } else {
      // The session's swayidle runs the screensaver on Jarod-OS Linux; elsewhere the shell watches.
      setInterval(() => this.checkIdle(), IDLE_POLL_MS).unref()
    }
  }

  async state(): Promise<SwitchState> {
    const prefs = readPrefs()
    const nightLight = this.options.session ? (await run('systemctl', ['--user', 'is-active', '--quiet', 'herald-os-nightlight'], 5000)).code === 0 : null

    return {
      nightLight,
      doNotDisturb: Boolean(prefs.doNotDisturb),
      stayAwake: this.options.session ? fs.existsSync(STAY_AWAKE_MARKER) : this.blocker !== null,
      screensaver: Boolean(prefs.screensaver?.enabled)
    }
  }

  async set(name: SwitchName, enabled: boolean): Promise<SwitchState> {
    switch (name) {
      case 'nightLight':
        if (!this.options.session) {
          throw new Error('Night light is switched by the system here (Night Shift on macOS).')
        }

        await this.cli(['toggle', 'nightlight', enabled ? 'on' : 'off'])
        break
      case 'stayAwake':
        if (this.options.session) {
          await this.cli(['toggle', 'idle', enabled ? 'on' : 'off'])
        } else if (enabled && this.blocker === null) {
          this.blocker = powerSaveBlocker.start('prevent-display-sleep')
        } else if (!enabled && this.blocker !== null) {
          powerSaveBlocker.stop(this.blocker)
          this.blocker = null
        }

        break
      case 'doNotDisturb':
        this.options.onPrefs(writePrefs({ doNotDisturb: enabled }))
        break
      case 'screensaver': {
        const current = readPrefs().screensaver
        const next = writePrefs({ screensaver: { enabled, afterMinutes: current?.afterMinutes || SCREENSAVER_DEFAULT_MINUTES } })
        this.options.onPrefs(next)
        await this.applyIdle(next)
        break
      }
    }

    return this.broadcast()
  }

  /** Settings changed the idle timings or the screensaver delay. */
  async applyIdle(prefs: JarodOSPrefs): Promise<void> {
    if (!this.options.session) {
      return
    }

    this.writeIdleConf(prefs)

    // Staying awake means the idle unit is stopped on purpose; it picks the file up when it restarts.
    if (!fs.existsSync(STAY_AWAKE_MARKER)) {
      await this.restartIdleUnit()
    }
  }

  /** `herald-os-idle restart` reapplies the timings; it is a host action, so it takes the gate. */
  private async restartIdleUnit(): Promise<void> {
    const gate = this.control

    if (!gate) {
      log('switches', 'refused an idle restart before the control gate was ready')

      return
    }

    const gated = await gate.submitLocal({ client: 'ui', command: IDLE_RESTART_ACTION, args: {}, source: 'idle' })

    if (gated.kind === 'reply') {
      log('switches', `idle restart refused: ${gated.reply.error ?? 'denied'}`)

      return
    }

    const result = await run('herald-os-idle', ['restart'], 10_000)

    gated.finish({ ok: result.code === 0, reason: result.code === 0 ? undefined : `herald-os-idle exited ${result.code}` })
  }

  /** Something outside the shell (the CLI, a hotkey) changed a switch: tell every window. */
  async broadcast(): Promise<SwitchState> {
    const state = await this.state()

    for (const win of this.options.getWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(IPC.switchesChanged, state)
      }
    }

    return state
  }

  private writeIdleConf(prefs: JarodOSPrefs): void {
    try {
      fs.mkdirSync(path.dirname(IDLE_CONF), { recursive: true })
      fs.writeFileSync(IDLE_CONF, renderIdleConf(prefs))
    } catch (error) {
      log('switches', `could not write ${IDLE_CONF}: ${(error as Error).message}`)
    }
  }

  private async cli(argv: string[]): Promise<void> {
    const gate = this.control

    if (!gate) {
      throw new Error('The shell is not ready to change the switches yet.')
    }

    // The system side of a switch lives in the `herald-os` CLI, so it goes through the same gate as
    // every other window-initiated host action: a catalogued verb, tiered, and journalled (R3.2).
    const result = await runCliThroughGate(gate, argv, 'switches')

    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || `herald-os ${argv.join(' ')} failed`)
    }
  }

  private checkIdle(): void {
    const screensaver = readPrefs().screensaver
    const idleSeconds = powerMonitor.getSystemIdleTime()

    if (idleSeconds < 5) {
      this.screensaverUp = false

      return
    }

    if (!screensaver?.enabled || this.blocker !== null || this.screensaverUp) {
      return
    }

    if (idleSeconds >= (screensaver.afterMinutes || SCREENSAVER_DEFAULT_MINUTES) * 60) {
      this.screensaverUp = true
      this.options.showScreensaver()
    }
  }
}
