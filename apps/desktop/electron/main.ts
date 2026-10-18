import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Notification, protocol, screen, shell } from 'electron'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { type ControlRunResult, type EnvInfo, type HeraldOSPrefs, IPC, type RestRequest, type ShellCommand, type WindowState } from '../shared/ipc.ts'
import { BackendManager } from './backend/manager.ts'
import { jarodDataDir, resolveJarodCore, runDbSnapshot, selectBackend } from './backend/jarod-core.ts'
import { CrashWatcher } from './crash/watch.ts'
import { fireEventAutomations } from './events/automations.ts'
import { events } from './events/bus.ts'
import { runHooks } from './events/hooks.ts'
import { startEventSources } from './events/sources.ts'
import { registerAppsIpc } from './ipc/apps.ts'
import { registerBridgeIpc } from './ipc/bridge.ts'
import { registerCaptureIpc } from './ipc/capture.ts'
import { registerControlsIpc } from './ipc/controls.ts'
import { registerCatalogIpc } from './ipc/catalog.ts'
import { registerSetupIpc } from './ipc/setup.ts'
import { PluginHost } from './plugins/host.ts'
import { registerDictationIpc } from './ipc/dictation.ts'
import { registerContextIpc } from './ipc/context.ts'
import { registerFsIpc } from './ipc/fs.ts'
import { registerJarodShellIpc } from './ipc/jarod-shell.ts'
import { registerSystemIpc } from './ipc/system.ts'
import { registerTerminalIpc } from './ipc/terminal.ts'
import { registerThemeIpc, syncHermesSkin } from './ipc/theme.ts'
import { applyVoiceHotkey, registerVoiceIpc } from './ipc/voice.ts'
import { registerEditIpc } from './ipc/edit.ts'
import { registerWebIpc, type WebViews } from './ipc/web.ts'
import { broadcastPinokioState, openElsewhere, registerPinokioIpc } from './ipc/pinokio.ts'
import { locateRuntime, PINOKIO_URL, PinokioService } from './pinokio/service.ts'
import { registerSystemAuditIpc } from './ipc/system-audit.ts'
import { registerDataDiskIpc } from './ipc/data-disk.ts'
import { BackupService } from './ipc/backups.ts'
import { registerSandboxesIpc } from './ipc/sandboxes.ts'
import { registerEnvironmentsIpc } from './ipc/environments.ts'
import { registerVmsIpc } from './ipc/vms.ts'
import { applyDataRoot } from './data-root.ts'
import { NetworkPolicyService, setActiveNetworkPolicy } from './network.ts'
import { cutDisallowed, installSocketGuard } from './net-guard.ts'
import { electronNetworkSessions, registerNetworkIpc } from './ipc/network.ts'
import { ExternalBackupService } from './ipc/external-backup.ts'
import { registerRemoteMachinesIpc } from './ipc/remote-machines.ts'
import { registerUpdatesCheckIpc } from './ipc/updates-check.ts'
import { MEDIA_SCHEME_PRIVILEGES, registerMediaIpc } from './ipc/media.ts'
import { registerNativeAppsIpc } from './ipc/native-apps.ts'
import { registerWindowEmbeds } from './platform/window-embed.ts'
import { AuditService } from './setup/service.ts'
import { log, logTail } from './log.ts'
import { installProblemLogging } from './problem-log.ts'
import { migrateLegacyData, migrateShellConfig } from './migrate.ts'
import { registerNotificationHistoryIpc } from './notifications-history.ts'
import { osEnv } from './env.ts'
import { claimSingleInstance } from './single-instance.ts'
import { SwitchService } from './switches.ts'
import { appUserModelId, hermesHome, heraldOsDataDir, isDev, legacyShellConfigDir, shellConfigDir } from './paths.ts'
import { readPrefs, writePrefs } from './prefs.ts'
import { isOmarchy, readOmarchyTheme } from './theme/omarchy.ts'
import { prefsForTheme } from './theme/themes.ts'
import { ControlSocket } from './shell/control-socket.ts'
import { DesktopHost, type ShellHost } from './shell/host.ts'
import { shellMode } from './shell/mode.ts'
import { createCompositor, detectCompositor } from './wm/compositor.ts'
import { NotificationDaemon } from './shell/notification-daemon.ts'
import { maximizeAction } from './window-controls.ts'
import { handleUiRequest, OsCommandBridge, OsControlServer } from './shell/os-control.ts'
import { asControlTier, ControlSecurity, controlAuditSink, controlEndpoint, controlTokens, type ControlAuditEntry } from './shell/control-authz.ts'
import { hostCatalogueEntries, hostCatalogueTiers } from './shell/host-actions.ts'
import { HostControlGate, type ApprovalProvider, type CatalogueEntry } from './shell/host-control.ts'
import { PanelShell } from './shell/panels.ts'
import { registerBrandingIpc } from './shell/branding.ts'
import { EmojiPanel } from './shell/emoji-panel.ts'
import { registerMenuExtensionsIpc } from './shell/menu-extensions.ts'
import { registerServiceIpc, runCliThroughGate } from './shell/services.ts'
import { WallpaperService } from './shell/wallpaper.ts'
import { appIconPath, createMainWindow, loadShell, MAIN_WINDOW_MIN } from './window.ts'
import { CrashPolicy, isSafeMode, recoveryAction, recoveryPage, relaunchArgs } from './recovery.ts'
import { readWindowState, restoreBounds, roundingDrift, withoutDrift, writeWindowState } from './window-state.ts'
import { ShellTray, trayLanguage } from './tray.ts'

app.setName('Jarod-OS')
// First, before anything touches data or opens a socket (the lock is keyed on the name set just above).
const primary = claimSingleInstance(app)
// Safe mode: started without widget plugins, hook scripts and event automations (see recovery.ts).
const safeMode = isSafeMode()
const windowStateFile = () => path.join(app.getPath('userData'), 'window-state.json')
let lastCrash: { at: string; reason: string } | null = null
const tray = new ShellTray(appIconPath(), safeMode, {
  show: () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore()
      }

      mainWindow.show()
      mainWindow.focus()
    }
  },
  relaunch: safe => relaunch(safe)
})
const coreLocation = { packaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath: app.getAppPath() }

// Jarod-OS's own disk, when the person chose one (data-root.ts): applied before anything resolves the data paths.
const dataRoot = applyDataRoot(shellConfigDir())

// The Internet switch (docs/NETWORK-POLICY.md): read before any session, socket or backend exists. The core reads the same file
// (JAROD_NETWORK_POLICY) on each of its connections; this process's own Node sockets go through the guard.
const network = new NetworkPolicyService(shellConfigDir())
network.load()
setActiveNetworkPolicy(network)
process.env.JAROD_NETWORK_POLICY = network.file
installSocketGuard(host => network.allows(host))
network.onChange(() => cutDisallowed(host => network.allows(host)))
const networkSessions = electronNetworkSessions()

// With the Jarod core as backend, the shell keeps its Hermes-style files (plugins, themes, audit, notes) in a home of its own, never in a Hermes install of this machine.
// Left alone when the person set HERMES_HOME, or attached the shell to a backend they run themselves.
if (!process.env.HERMES_HOME?.trim() && !process.env.HERALD_OS_BACKEND_URL?.trim() && selectBackend(process.env, resolveJarodCore({ ...coreLocation, env: process.env })) === 'jarod') {
  process.env.HERMES_HOME = path.join(jarodDataDir(), 'herald-home')
}

// Widget plugins load from herald-plugin://<id>/, the Player streams jarod-media:// (registered before the app is
// ready, in one call, as Electron requires).
protocol.registerSchemesAsPrivileged([{ scheme: 'herald-plugin', privileges: { standard: true, secure: true, supportFetchAPI: true } }, MEDIA_SCHEME_PRIVILEGES])

// Electron shows a modal dialog for an uncaught main-process error and waits on it: the whole
// shell, the Linux session included, would freeze behind a box nobody may see. Log it and go on.
process.on('uncaughtException', error => log('main', `uncaught exception: ${error.stack ?? error.message}`))
// The rest of what can go wrong reaches the same log: rejected promises here, every window's errors, failing IPC calls.
installProblemLogging(app, ipcMain, log)

if (dataRoot.kind !== 'default') {
  log('disk', dataRoot.kind === 'root' ? `Jarod-OS lives on ${dataRoot.root}` : dataRoot.kind === 'missing' ? `the Jarod disk ${dataRoot.root} is not reachable: using the default folders` : 'data folders set by the environment')
}

for (const line of primary ? migrateLegacyData({ hermesHome: hermesHome(), appData: app.getPath('appData'), userData: app.getPath('userData') }) : []) {
  log('migrate', line)
}

// A folder chosen with HERALD_OS_CONFIG_DIR is the person's (or a test's): nothing is moved into it.
for (const line of primary && !osEnv('CONFIG_DIR') ? migrateShellConfig(process.platform, legacyShellConfigDir(), shellConfigDir()) : []) {
  log('migrate', line)
}

const backend = new BackendManager(coreLocation)
const externalBackups = new ExternalBackupService({
  configDir: shellConfigDir(),
  isCoreRunning: () => ['ready', 'starting', 'resolving', 'restarting'].includes(backend.getState().phase),
  stopCore: () => backend.stop(),
  startCore: () => void backend.start(),
  snapshotDb: (src, dest) => {
    const core = resolveJarodCore({ ...coreLocation, env: process.env })

    if (!core) return Promise.reject(new Error('aucun moteur Jarod dans cette version : la base ne peut pas être copiée'))

    return runDbSnapshot(core, src, dest)
  },
  relaunch: () => relaunch(false)
})
const backups = new BackupService({ stopBackend: () => backend.stop(), startBackend: () => void backend.start(), relaunch: () => relaunch(false) })
// The Pinokio engine (ADR-022): started on demand by its window or the agent's tools, stopped on quit.
// The system audit runs in the background once main is ready, then is reused from its JSON (electron/setup).
const systemAudit = new AuditService({ configDir: shellConfigDir(), log: message => log('audit', message) })

const pinokio = new PinokioService({
  runtime: locateRuntime(coreLocation),
  execPath: process.execPath,
  onState: broadcastPinokioState,
  onOpen: (url, surface) => openElsewhere(() => mainWindow, url, surface)
})

// The core's pinokio_* tools are offered only when this build can run an engine.
if (pinokio.state.bundled) {
  process.env.JAROD_PINOKIO_URL = PINOKIO_URL
}
let mainWindow: BrowserWindow | null = null
const mode = shellMode()
// Panels mode (niri): several surface windows, compositor state mirror, control socket for hotkeys.
const panels = mode === 'panels' ? new PanelShell(win => attachMainWindow(win)) : null
const wallpaper = panels ? new WallpaperService(panels) : null
// The agent's `os_ui` tool and the CLI run registry commands in the Hermes window through this bridge.
const osBridge = new OsCommandBridge(() => (panels ? panels.mainWindow() : mainWindow))
const plugins = new PluginHost(
  () => BrowserWindow.getAllWindows(),
  () => (panels ? panels.mainWindow() : mainWindow),
  osBridge,
  safeMode
)
/** Preferences changed outside a renderer (the CLI, a theme): every window and the wallpaper follow. */
function broadcastPrefs(next: HeraldOSPrefs): void {
  wallpaper?.apply(next.wallpaper)

  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(IPC.prefsChanged, next)
  }
}

const switches = new SwitchService({
  session: Boolean(panels),
  getWindows: () => BrowserWindow.getAllWindows(),
  onPrefs: broadcastPrefs,
  showScreensaver: () => mainWindow?.webContents.send(IPC.shellCommand, { type: 'screensaver' } satisfies ShellCommand)
})
// Linux without the panels session: Herald as an app inside Hyprland or Omarchy, or the cage kiosk.
// The `herald-os` CLI (and so the compositor's hotkeys) reaches the one window through the same socket.
const appHost =
  !panels && process.platform === 'linux'
    ? new DesktopHost(
        () => mainWindow,
        // Hyprland has no screenshot UI of its own: Herald's capture takes it. It runs through the same
        // gate as every other CLI call, so it is tiered and journalled rather than a private spawn off
        // the window-action path (R3.2).
        createCompositor(detectCompositor(), what => {
          void runCliThroughGate(backendGate, ['capture', 'screenshot', what], 'wm-action').catch(error => log('wm', String(error)))
        }),
      )
    : null
// macOS: Cmd+Ctrl+E opens the emoji picker over any app (Jarod-OS Linux binds it in niri).
const emojiPanel = !panels && process.platform === 'darwin' ? new EmojiPanel(() => mainWindow) : null
const shellHost: ShellHost | null = panels ?? appHost
// Who may drive the shell, and what the shell writes down about it. Two tokens, one per surface: the
// backend's (it runs registry commands through the bridge) and the CLI's (a user-only file the
// `herald-os` command reads). Neither token is enough on its own for anything that changes the
// machine: `mutate` and `destructive` calls need an approval this process itself witnessed, carried
// by a one-shot capability (shell/host-control.ts).
const { backend: backendToken, cli: cliToken } = controlTokens()
const surfaceTokens = { backend: backendToken, cli: cliToken }
const journalControl = controlAuditSink(path.join(heraldOsDataDir(), 'control-audit.jsonl'))
const auditControl = (entry: ControlAuditEntry) => {
  log('control', `${entry.allowed ? 'allowed' : 'refused'} ${entry.cmd}${entry.command ? ` ${entry.command}` : ''} from ${entry.client}: ${entry.reason}`)
  journalControl(entry)
}
/**
 * The host's own way of asking a person: a modal dialog on the Hermes window. One at a time — a second
 * request while one is open is denied rather than queued behind it, so nothing can stack dialogs — and
 * the answer becomes a capability bound to this exact call, not to the caller.
 */
let approvalOpen = false
const approveMutation: ApprovalProvider = async ask => {
  const win = panels ? panels.mainWindow() : mainWindow

  if (!win || win.isDestroyed() || approvalOpen) {
    return false
  }

  approvalOpen = true

  try {
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['Deny', 'Allow once'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: 'Jarod-OS: confirm a control request',
      message: `Allow this ${ask.tier} request?`,
      detail: [
        `Command: ${ask.command}`,
        `Asked by: ${ask.client}${ask.source ? ` (${ask.source})` : ''}`,
        ask.preview ? `Arguments: ${ask.preview}` : undefined,
        ask.requestId ? `Request: ${ask.requestId}` : undefined,
        '',
        'Allowing lets this one call through, once.',
      ]
        .filter((line): line is string => line !== undefined)
        .join('\n'),
    })

    return response === 1
  } finally {
    approvalOpen = false
  }
}
// The pipe nonce is a secret until the backend is told where to dial; the journal keeps it out too.
const pipeNonce = randomBytes(8).toString('hex')
const pipeSecrets = () => [{ kind: 'nonce' as const, value: pipeNonce }]
const panelSecurity = new ControlSecurity({ tokens: surfaceTokens, secrets: pipeSecrets }, auditControl)
const backendSecurity = new ControlSecurity({ tokens: surfaceTokens, surface: 'backend', secrets: pipeSecrets }, auditControl)
const panelGate = new HostControlGate({ security: panelSecurity, approve: approveMutation })
const backendGate = new HostControlGate({ security: backendSecurity, approve: approveMutation })
/**
 * R3.1: the host's own actions are known here, in the main process, so they are decidable from the
 * first moment rather than after the renderer has registered the registry catalogue. A first run sets
 * the account password in the setup wizard, which can happen before the backend has answered
 * `osBridge.list()`; without this seed that action would be refused as unknown. `learnCatalogue`
 * merges the registry's entries into the same lookup once they arrive.
 */
const hostTiers = hostCatalogueTiers()
const hostEntries = hostCatalogueEntries()

for (const security of [panelSecurity, backendSecurity]) {
  security.setCatalogue(id => hostTiers.get(id))
}

for (const gate of [panelGate, backendGate]) {
  gate.setCatalogue(hostEntries)
}
// A plugin's OS commands go through the same gate, and so into the same journal (R2.2). Set here
// because the gate is built after the plugin host; until it is set, plugin commands are refused.
plugins.setControl(backendGate)
// The quick switches reach the system through the `herald-os` CLI and the idle unit; both take the
// gate now, so a window asking for one names a catalogued action and leaves a line (R3.2).
switches.setControl(backendGate)
/**
 * The shell's own windows run a registry command the way everything else does: through the gate,
 * against the catalogue, with a line in the journal. Before R3 the palette and the control menu sent
 * a generic `os` message over the shell bus, where nothing checked the id, nothing checked the
 * arguments, and nothing was written down.
 *
 * The sender is checked to be a window of this app (the preload is what makes that true): a widget
 * plugin lives in a sandboxed frame without it, and a web view has no preload at all.
 */
ipcMain.handle(IPC.controlRun, async (event, id: unknown, rawArgs: unknown): Promise<ControlRunResult> => {
  if (!BrowserWindow.fromWebContents(event.sender)) {
    return { ok: false, error: 'This window may not run shell commands.' }
  }

  const command = typeof id === 'string' ? id : ''
  const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? (rawArgs as Record<string, unknown>) : {}
  // The command itself runs in the Hermes window; make sure it is there to be asked.
  if (panels && !panels.mainWindow()) {
    panels.open('main')
  }

  const result = await backendGate.submitLocal({ client: 'ui', command, args, source: 'ui' })

  if (result.kind === 'reply') {
    return { ok: false, error: result.reply.error ?? 'The shell refused that command.' }
  }

  const reply = await handleUiRequest({ cmd: 'ui', command, args, source: 'ui' }, osBridge)
  const ok = reply?.ok !== false

  result.finish({ ok, reason: typeof reply?.error === 'string' ? reply.error : undefined })

  return {
    ok,
    summary: typeof reply?.summary === 'string' ? reply.summary : undefined,
    error: typeof reply?.error === 'string' ? reply.error : undefined,
  }
})
const control = shellHost
  ? new ControlSocket(
      shellHost,
      broadcastPrefs,
      osBridge,
      spec => {
        syncHermesSkin(spec, backend)
        events.emit('theme-set', { theme: spec.name })
      },
      () => void switches.broadcast(),
      plugins,
      panelGate
    )
  : null
// The panel socket is the CLI's door, so it needs a token the CLI can hold: one file, user-readable
// only, beside the socket. The backend's token never goes to disk.
if (control) {
  try {
    const tokenFile = path.join(path.dirname(control.socketPath), 'control.token')

    fs.mkdirSync(path.dirname(tokenFile), { recursive: true, mode: 0o700 })
    fs.writeFileSync(tokenFile, cliToken, { mode: 0o600 })
  } catch (error) {
    log('control', `cannot write the CLI control token: ${(error as Error).message}`)
  }
}
// Desktop mode has no compositor CLI socket; the OS control server gives the backend the same `ui*`
// surface. Windows gets a named pipe here rather than a loopback port (shell/control-authz.ts).
const osControlPath = panels ? path.join(process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 1000}`, 'herald-os', 'control.sock') : path.join(heraldOsDataDir(), 'control.sock')
const osControl = panels
  ? null
  : new OsControlServer(
      // The nonce is drawn here, once: the pipe name is then unguessable, and only this process knows
      // it until the DACL has been verified and the backend is told where to dial (R3.2).
      controlEndpoint({ platform: process.platform, runtimeDir: heraldOsDataDir(), dataDir: heraldOsDataDir(), nonce: pipeNonce }),
      async request => {
        // One pipeline, then the work: who is asking, whether the argument shape matches the command,
        // and — for anything that changes the machine — an approval this process witnessed itself.
        const result = await backendGate.submit(request)

        if (result.kind === 'reply') {
          return { ...result.reply }
        }

        const cmd = String(request.cmd ?? '')
        const args = Array.isArray(request.args) ? (request.args as string[]) : []
        // The pipeline's own reading of the name: it is the only one that is known to be well formed.
        const echoId = result.call.requestId
        const relay = (command: ShellCommand) => {
          mainWindow?.webContents.send(IPC.shellCommand, command)
          mainWindow?.show()
        }

        try {
          // `run`/`list`/`state` are the typed spellings of `ui`/`ui-list`/`ui-state`: one bridge call,
          // one reply shape, and the older spelling keeps working for the bridge that ships with the app.
          const asUi = cmd === 'run' ? 'ui' : cmd === 'list' ? 'ui-list' : cmd === 'state' ? 'ui-state' : cmd
          const ui = await handleUiRequest({ ...request, cmd: asUi } as unknown as Parameters<typeof handleUiRequest>[0], osBridge)

          if (ui) {
            result.finish({ ok: ui.ok !== false })

            return { ...ui, code: ui.ok === false ? 'execution-failed' : 'ok', requestId: echoId }
          }

          let reply: Record<string, unknown>

          switch (cmd) {
            case 'page':
              relay({ type: 'show-page', args })
              reply = { ok: true }

              break
            case 'notify':
              relay({ type: 'notify', args })
              reply = { ok: true }

              break
            case 'voice':
              relay({ type: 'voice', args: [args[0] ?? 'toggle'] })
              reply = { ok: true }

              break
            default:
              // Unreachable through the gate, whose allow-list is this surface's own table; kept so a
              // future command that skips the policy still gets an answer rather than silence.
              reply = { ok: false, error: `unknown command ${cmd}`, code: 'unsupported' }
          }

          result.finish({ ok: reply.ok !== false })

          return { ...reply, code: reply.ok === false ? 'execution-failed' : 'ok', requestId: echoId }
        } catch (error) {
          result.finish({ ok: false, code: 'execution-failed' })

          throw error
        }
      },
      reason => backendSecurity.malformed(reason)
    )
backend.setControl(() => osControl?.endpoint || osControlPath, backendToken)
// What a registry command is worth comes from the shell's own catalogue, which the renderer registers
// as it loads: ask it once the window can answer, so a command nobody declared is refused rather than
// guessed at. The argument shapes the policy checks come from the same reply.
const learnCatalogue = async (attempt = 0): Promise<void> => {
  const reply = await osBridge.list()

  if (reply.error || !Array.isArray(reply.result)) {
    if (attempt < 20) {
      setTimeout(() => void learnCatalogue(attempt + 1), 1_000)
    }

    return
  }

  // The renderer declares what its registry commands are worth; the main process adds the host
  // actions that are not registry commands at all (plugin administration, the CLI a window may spawn),
  // so one catalogue decides every privileged action, whoever asks for it (R3.1).
  const entries = [...(reply.result as CatalogueEntry[]), ...hostCatalogueEntries()]
  const tiers = new Map<string, 'read' | 'act' | 'mutate' | 'destructive'>()

  for (const entry of entries) {
    const tier = asControlTier(entry?.tier)

    if (typeof entry?.id === 'string' && tier) {
      tiers.set(entry.id, tier)
    }
  }

  for (const security of [panelSecurity, backendSecurity]) {
    security.setCatalogue(id => tiers.get(id) ?? hostTiers.get(id))
  }

  for (const gate of [panelGate, backendGate]) {
    gate.setCatalogue(entries)
  }
}
void learnCatalogue()
// Serves org.freedesktop.Notifications so other apps' notifications reach the shell.
const notifications = panels ? new NotificationDaemon(panels) : null
/** Deliver a ShellCommand to the Hermes window; panels mode queues it until that window has loaded. */
const toHermesWindow = (command: ShellCommand) => (panels ? panels.relay('main', command) : mainWindow?.webContents.send(IPC.shellCommand, command))
const crashes = new CrashWatcher(
  report => toHermesWindow({ type: 'crash', payload: { ...report } }),
  () => [backend.childPid()].filter((pid): pid is number => pid !== null),
  report => events.emit('crash', { app: report.app, pid: report.pid, reason: report.reason })
)
// Every event runs the person's hook scripts and fires the Hermes automations waiting for it.
events.on(event => {
  // Safe mode leaves out what a person added; the events themselves still flow to the renderer.
  if (safeMode) {
    return
  }

  runHooks(event)
  void fireEventAutomations(event, backend)
})

function windowState(win: BrowserWindow): WindowState {
  return { fullscreen: win.isFullScreen(), focused: win.isFocused(), maximized: win.isMaximized() }
}

function broadcastWindowState(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC.windowState, windowState(mainWindow))
  }
}

function registerCoreIpc(): void {
  ipcMain.handle(IPC.backendGetState, () => backend.getState())
  ipcMain.handle(IPC.backendRestart, () => backend.restart())
  ipcMain.handle(IPC.backendRest, (_event, request: RestRequest) => backend.rest(request))
  ipcMain.handle(IPC.backendLogTail, (_event, lines: number) => [...logTail(lines), ...backend.getState().logTail])

  ipcMain.handle(IPC.notifyNative, (_event, title: string, body: string) => {
    if (Notification.isSupported()) {
      const notification = new Notification({ title: String(title).slice(0, 120), body: String(body).slice(0, 400), silent: true })
      // macOS only shows notifications from code-signed apps; unsigned builds fail here.
      notification.on('failed', (_event, error) => log('notify', `native notification failed: ${error}`))
      notification.show()
    }
  })

  ipcMain.handle(IPC.windowGetState, () => (mainWindow ? windowState(mainWindow) : { fullscreen: false, focused: false, maximized: false }))
  ipcMain.handle(IPC.windowToggleFullscreen, () => {
    if (mainWindow) {
      mainWindow.setFullScreen(!mainWindow.isFullScreen())
    }
  })
  ipcMain.handle(IPC.windowQuit, () => app.quit())
  ipcMain.handle(IPC.windowRelaunch, (_event, safe: boolean) => relaunch(Boolean(safe)))
  // The window buttons Windows needs (macOS has its own, Linux a compositor).
  ipcMain.handle(IPC.windowMinimize, () => mainWindow?.minimize())
  ipcMain.handle(IPC.windowToggleMaximize, () => {
    if (!mainWindow) {
      return
    }

    // Leaving fullscreen, un-maximising and maximising are the one button's three states.
    switch (maximizeAction({ fullscreen: mainWindow.isFullScreen(), maximized: mainWindow.isMaximized() })) {
      case 'leave-fullscreen':
        mainWindow.setFullScreen(false)
        break
      case 'unmaximize':
        mainWindow.unmaximize()
        break
      default:
        mainWindow.maximize()
    }
  })
  ipcMain.handle(IPC.windowClose, () => mainWindow?.close())

  ipcMain.handle(IPC.shellOpenExternal, (_event, url: string) => {
    if (/^https?:\/\//i.test(url)) {
      return shell.openExternal(url)
    }

    throw new Error('only http(s) URLs may be opened externally')
  })

  ipcMain.handle(IPC.prefsGet, () => readPrefs())
  ipcMain.handle(IPC.prefsSet, (event, patch: Partial<HeraldOSPrefs>) => {
    const next = writePrefs(patch)

    if ('wallpaper' in patch) {
      wallpaper?.apply(next.wallpaper)
    }

    if (patch.voice) {
      applyVoiceHotkey(next.voice.enabled ? next.voice.hotkey : '', () => BrowserWindow.getAllWindows())
    }

    if ('idle' in patch || 'screensaver' in patch) {
      void switches.applyIdle(next)
    }

    if ('language' in patch) {
      tray.setLanguage(trayLanguage(next.language, app.getLocale()))
    }

    if ('doNotDisturb' in patch || 'screensaver' in patch) {
      void switches.broadcast()
    }

    // The keymap lives in niri's config, which the CLI renders (niri reloads it by itself). Setting it
    // is a host mutation like any other, so it takes the same gate and the same journal — this used to
    // be an ungated spawn on the preference path (R3.2).
    if ('keymap' in patch && process.platform === 'linux') {
      if (BrowserWindow.fromWebContents(event.sender)) {
        void runCliThroughGate(backendGate, ['keymap', next.keymap === 'omarchy' ? 'omarchy' : 'herald'], 'prefs-set').then(
          result => result.code !== 0 && log('keymap', result.stderr.trim()),
        )
      } else {
        log('keymap', 'refused a keymap change from a window that is not a herald-os surface')
      }
    }

    // Every surface window sees the same preferences.
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.webContents !== event.sender) {
        win.webContents.send(IPC.prefsChanged, next)
      }
    }

    return next
  })

  ipcMain.handle(
    IPC.envInfo,
    (): EnvInfo => ({
      platform: process.platform,
      hermesHome: hermesHome(),
      homeDir: os.homedir(),
      version: app.getVersion(),
      isDev,
      shellMode: mode,
      safeMode,
      userDataDir: app.getPath('userData'),
      lastCrash
    })
  )

  registerFsIpc(() => mainWindow)
  registerJarodShellIpc(() => mainWindow, () => void backend.restart())
  registerAppsIpc()
  registerBridgeIpc()
  registerServiceIpc(backendGate)
  registerMenuExtensionsIpc()
  registerBrandingIpc()
  registerSystemIpc(() => BrowserWindow.getAllWindows())
  registerContextIpc(
    () => BrowserWindow.getAllWindows(),
    back => events.emit('returned', { reason: back.reason, away_minutes: Math.round(back.awayMs / 60_000) })
  )
  registerThemeIpc({ panels: Boolean(panels), broadcast: broadcastPrefs, backend })
  registerCaptureIpc(state => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IPC.captureRecordChanged, state)
    }
  })
  registerControlsIpc()
  registerNotificationHistoryIpc()
  registerDictationIpc(() => (panels ? panels.mainWindow() : mainWindow))
  registerCatalogIpc(backendGate)
  registerSetupIpc(backendGate)
  plugins.registerIpc()
  plugins.registerProtocol()
  plugins.watch()
  emojiPanel?.register()
  registerTerminalIpc(() => mainWindow)
  registerVoiceIpc(backend)
  // Desktop mode layers pages over the shell window; panels mode gives them compositor windows.
  const webViews: WebViews = registerWebIpc(mode === 'desktop')
  registerEditIpc(() => webViews)
  registerPinokioIpc(pinokio, () => webViews, () => (panels ? panels.mainWindow() : mainWindow))
  registerSystemAuditIpc(systemAudit)
  backups.register()
  registerSandboxesIpc()
  registerEnvironmentsIpc()
  registerVmsIpc()
  registerNetworkIpc(network)
  registerRemoteMachinesIpc(network)
  registerUpdatesCheckIpc(shellConfigDir())
  externalBackups.register()
  registerDataDiskIpc({ state: dataRoot, configDir: shellConfigDir(), stopBackend: () => backend.stop(), startBackend: () => void backend.start(), relaunch: () => relaunch(false) })
  registerNativeAppsIpc()
  registerWindowEmbeds()
  registerMediaIpc()
}

/** Quit and start again (the backend is stopped on the way out, as for any quit), in safe mode or not. */
function relaunch(safe: boolean): void {
  log('main', `restarting${safe ? ' in safe mode' : ''}`)
  app.relaunch({ args: relaunchArgs(process.argv, safe) })
  app.quit()
}

/** A renderer that dies leaves a blank window: reload once, then offer the recovery page (recovery.ts). */
function watchRenderer(win: BrowserWindow): void {
  const policy = new CrashPolicy()

  win.webContents.on('render-process-gone', (_event, details) => {
    log('main', `the shell's page went away: ${details.reason} (exit code ${details.exitCode})`)

    if (details.reason !== 'clean-exit') {
      lastCrash = { at: new Date().toISOString(), reason: details.reason }
      events.emit('crash', { app: 'Jarod-OS', pid: process.pid, reason: `renderer ${details.reason}` })
    }

    switch (policy.next(details.reason, Date.now())) {
      case 'reload':
        loadShell(win)
        break
      case 'recover':
        void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(recoveryPage(details.reason, safeMode))}`)
        break
    }
  })
  win.webContents.on('unresponsive', () => log('main', "the shell's page stopped responding"))
  win.webContents.on('responsive', () => log('main', "the shell's page responds again"))
  // The recovery page's links: main acts on them (window.ts already refuses the navigation itself).
  win.webContents.on('will-navigate', (event, url) => {
    const action = recoveryAction(url)

    if (!action) {
      return
    }

    event.preventDefault()

    if (action === 'reload') {
      loadShell(win)
    } else if (action === 'quit') {
      app.quit()
    } else {
      relaunch(action === 'safe-mode')
    }
  })
}

/** Desktop mode: the window comes back where it was, and its place is saved when it closes. */
function createRestoredWindow(): BrowserWindow {
  const saved = readWindowState(windowStateFile())
  const bounds = restoreBounds(saved, screen.getAllDisplays().map(display => display.workArea), MAIN_WINDOW_MIN)
  const win = createMainWindow(readPrefs(), bounds ? { bounds, maximized: Boolean(saved?.maximized) } : null)
  const drift = roundingDrift(bounds, win.getBounds())

  win.on('close', () => {
    try {
      writeWindowState(windowStateFile(), { ...withoutDrift(win.getNormalBounds(), drift), maximized: win.isMaximized() })
    } catch (error) {
      log('main', `cannot save the window's place: ${error instanceof Error ? error.message : String(error)}`)
    }
  })

  return win
}

function attachMainWindow(win: BrowserWindow): void {
  mainWindow = win
  watchRenderer(win)

  win.on('enter-full-screen', broadcastWindowState)
  win.on('leave-full-screen', broadcastWindowState)
  win.on('maximize', broadcastWindowState)
  win.on('unmaximize', broadcastWindowState)
  win.on('focus', broadcastWindowState)
  win.on('blur', broadcastWindowState)

  win.on('closed', () => {
    if (mainWindow === win) {
      mainWindow = null
    }
  })
}

function createWindow(): void {
  if (panels) {
    panels.start()
    void notifications?.start()
    control?.start()
    wallpaper?.start(readPrefs().wallpaper)

    return
  }

  attachMainWindow(createRestoredWindow())
  osControl?.start()
  appHost?.start()
  control?.start()

  // Inside Omarchy, Herald wears Omarchy's theme from the start (its theme-set hook keeps it in step),
  // unless a Herald theme was picked since.
  const themeName = readPrefs().themeName
  const omarchy = appHost && isOmarchy() && (!themeName || themeName.startsWith('omarchy-')) ? readOmarchyTheme() : null

  if (omarchy) {
    broadcastPrefs(writePrefs(prefsForTheme(omarchy.spec, omarchy.dir)))
  }
}

app.whenReady().then(async () => {
  void systemAudit.get().catch(error => log('audit', `failed: ${(error as Error).message}`))
  if (!primary) {
    return
  }

  log('main', `Jarod-OS ${app.getVersion()} starting (dev=${isDev}, mode=${mode}, HERMES_HOME=${hermesHome()}${safeMode ? ', safe mode' : ''})`)
  // A packaged app carries its icon in the bundle; `electron .` would show Electron's.
  const icon = isDev ? appIconPath() : undefined

  if (icon && process.platform === 'darwin') {
    app.dock?.setIcon(icon)
  }

  // Windows groups the taskbar button, jump list and toast notifications under this id. Only the packaged app takes the installed
  // app's id: a run from the checkout (dev or e2e, both on electron.exe) leaves a Start Menu shortcut under its id (see paths.ts).
  if (process.platform === 'win32') {
    app.setAppUserModelId(appUserModelId(app.isPackaged))
  }

  // Every web session takes the Internet policy before the first window loads anything.
  await network.attach(networkSessions)
  registerCoreIpc()
  events.registerIpc()
  crashes.start()
  startEventSources()
  switches.start()
  backend.onState(state => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IPC.backendState, state)
    }
  })
  createWindow()
  tray.start(trayLanguage(readPrefs().language, app.getLocale()))
  // Cmd+Ctrl+F is the standard macOS fullscreen toggle; register it as a local shortcut so the
  // user can always leave the environment. Only this shortcut follows focus: the voice hotkey
  // (ipc/voice.ts) must keep working while another app is in front.
  const fullscreenAccelerator = process.platform === 'darwin' ? 'Command+Control+F' : 'F11'
  app.on('browser-window-focus', () => {
    globalShortcut.register(fullscreenAccelerator, () => {
      mainWindow?.setFullScreen(!mainWindow.isFullScreen())
    })
  })
  app.on('browser-window-blur', () => globalShortcut.unregister(fullscreenAccelerator))
  const voicePrefs = readPrefs().voice
  applyVoiceHotkey(voicePrefs.enabled ? voicePrefs.hotkey : '', () => BrowserWindow.getAllWindows())
  // The backend is told where the control server listens, so wait for it (a port on Windows).
  await Promise.race([osControl?.ready, new Promise(resolve => setTimeout(resolve, 3000))])
  // The daily backup of the Jarod disk, when due, copies the data before the core starts.
  void backups.dailyBeforeStart(() => void backend.start())
  externalBackups.startAutomatic()
})

// GPU, utility and other helper processes: Chromium recovers by itself (a GPU that keeps crashing falls back to software); keep a trace.
app.on('child-process-gone', (_event, details) => {
  if (details.reason !== 'clean-exit') {
    log('main', `${details.type} process gone: ${details.reason} (exit code ${details.exitCode}${details.name ? `, ${details.name}` : ''})`)
  }
})

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) {
      mainWindow.restore()
    }

    mainWindow.show()
    mainWindow.focus()
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

app.on('window-all-closed', () => {
  // In panels mode the menu bar and dock keep the session alive; closing the Hermes window is fine.
  if (!panels) {
    app.quit()
  }
})

let quitting = false
app.on('before-quit', event => {
  if (quitting) {
    return
  }

  quitting = true
  event.preventDefault()
  globalShortcut.unregisterAll()
  crashes.stop()
  // A backup in progress is cancelled (its unfinished folder removed): quitting is never held up by it.
  externalBackups.stop()
  tray.stop()
  plugins.stop()
  emojiPanel?.stop()
  control?.stop()
  osControl?.stop()
  wallpaper?.stop()
  notifications?.stop()
  panels?.stop()
  appHost?.stop()
  void Promise.allSettled([backend.stop(), pinokio.stop()]).finally(() => app.quit())
})
