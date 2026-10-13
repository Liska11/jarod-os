import { app, BrowserWindow, globalShortcut, ipcMain, Notification, protocol, screen, shell } from 'electron'
import os from 'node:os'
import path from 'node:path'
import { type EnvInfo, type HeraldOSPrefs, IPC, type RestRequest, type ShellCommand, type WindowState } from '../shared/ipc.ts'
import { BackendManager } from './backend/manager.ts'
import { jarodDataDir, resolveJarodCore, selectBackend } from './backend/jarod-core.ts'
import { CrashWatcher } from './crash/watch.ts'
import { fireEventAutomations } from './events/automations.ts'
import { events } from './events/bus.ts'
import { runHooks } from './events/hooks.ts'
import { run } from './platform/exec.ts'
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
import { AuditService } from './setup/service.ts'
import { log, logTail } from './log.ts'
import { migrateLegacyData, migrateShellConfig } from './migrate.ts'
import { registerNotificationHistoryIpc } from './notifications-history.ts'
import { osEnv } from './env.ts'
import { claimSingleInstance } from './single-instance.ts'
import { SwitchService } from './switches.ts'
import { hermesHome, heraldOsDataDir, isDev, legacyShellConfigDir, shellConfigDir } from './paths.ts'
import { readPrefs, writePrefs } from './prefs.ts'
import { isOmarchy, readOmarchyTheme } from './theme/omarchy.ts'
import { prefsForTheme } from './theme/themes.ts'
import { ControlSocket } from './shell/control-socket.ts'
import { DesktopHost, type ShellHost } from './shell/host.ts'
import { shellMode } from './shell/mode.ts'
import { createCompositor, detectCompositor } from './wm/compositor.ts'
import { NotificationDaemon } from './shell/notification-daemon.ts'
import { maximizeAction } from './window-controls.ts'
import { handleUiRequest, OsCommandBridge, OsControlServer, osControlToken } from './shell/os-control.ts'
import { sameToken } from './shell/json-lines.ts'
import { PanelShell } from './shell/panels.ts'
import { registerBrandingIpc } from './shell/branding.ts'
import { EmojiPanel } from './shell/emoji-panel.ts'
import { registerMenuExtensionsIpc } from './shell/menu-extensions.ts'
import { registerServiceIpc } from './shell/services.ts'
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

// With the Jarod core as backend, the shell keeps its Hermes-style files (plugins, themes, audit, notes) in a home of its own, never in a Hermes install of this machine.
// Left alone when the person set HERMES_HOME, or attached the shell to a backend they run themselves.
if (!process.env.HERMES_HOME?.trim() && !process.env.HERALD_OS_BACKEND_URL?.trim() && selectBackend(process.env, resolveJarodCore({ ...coreLocation, env: process.env })) === 'jarod') {
  process.env.HERMES_HOME = path.join(jarodDataDir(), 'herald-home')
}

// Widget plugins load from herald-plugin://<id>/ (registered before the app is ready, as Electron requires).
protocol.registerSchemesAsPrivileged([{ scheme: 'herald-plugin', privileges: { standard: true, secure: true, supportFetchAPI: true } }])

// Electron shows a modal dialog for an uncaught main-process error and waits on it: the whole
// shell, the Linux session included, would freeze behind a box nobody may see. Log it and go on.
process.on('uncaughtException', error => log('main', `uncaught exception: ${error.stack ?? error.message}`))

for (const line of primary ? migrateLegacyData({ hermesHome: hermesHome(), appData: app.getPath('appData'), userData: app.getPath('userData') }) : []) {
  log('migrate', line)
}

// A folder chosen with HERALD_OS_CONFIG_DIR is the person's (or a test's): nothing is moved into it.
for (const line of primary && !osEnv('CONFIG_DIR') ? migrateShellConfig(process.platform, legacyShellConfigDir(), shellConfigDir()) : []) {
  log('migrate', line)
}

const backend = new BackendManager(coreLocation)
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
const appHost = !panels && process.platform === 'linux' ? new DesktopHost(() => mainWindow, createCompositor(detectCompositor())) : null
// macOS: Cmd+Ctrl+E opens the emoji picker over any app (Jarod-OS Linux binds it in niri).
const emojiPanel = !panels && process.platform === 'darwin' ? new EmojiPanel(() => mainWindow) : null
const shellHost: ShellHost | null = panels ?? appHost
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
      plugins
    )
  : null
// Desktop mode has no compositor CLI socket; the OS control server gives it the same `ui*` surface.
const osControlPath = panels ? path.join(process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 1000}`, 'herald-os', 'control.sock') : path.join(heraldOsDataDir(), 'control.sock')
const osControl = panels
  ? null
  : new OsControlServer(osControlPath, async request => {
      // No CLI talks to this socket (the Linux one serves `herald-os`), so every client is the backend.
      if (!sameToken(request.token, osControlToken())) {
        return { ok: false, error: 'invalid control token' }
      }

      const ui = await handleUiRequest(request as unknown as Parameters<typeof handleUiRequest>[0], osBridge)

      if (ui) {
        return ui
      }

      // A few CLI conveniences the Linux socket also offers, relayed as ShellCommands.
      const cmd = String(request.cmd ?? '')
      const args = Array.isArray(request.args) ? (request.args as string[]) : []
      const relay = (command: ShellCommand) => {
        mainWindow?.webContents.send(IPC.shellCommand, command)
        mainWindow?.show()
      }

      switch (cmd) {
        case 'page':
          relay({ type: 'show-page', args })

          return { ok: true }
        case 'notify':
          relay({ type: 'notify', args })

          return { ok: true }
        case 'voice':
          relay({ type: 'voice', args: [args[0] ?? 'toggle'] })

          return { ok: true }
        case 'os':
          relay({ type: 'os', args: [args[0]], payload: args[1] ? (JSON.parse(args[1]) as Record<string, unknown>) : undefined })

          return { ok: true }
        default:
          return { ok: false, error: `unknown command ${cmd}` }
      }
    })
backend.setControl(() => osControl?.endpoint || osControlPath, osControlToken())
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
  ipcMain.handle(IPC.prefsSet, (_event, patch: Partial<HeraldOSPrefs>) => {
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

    // The keymap lives in niri's config, which the CLI renders (niri reloads it by itself).
    if ('keymap' in patch && process.platform === 'linux') {
      void run('herald-os', ['keymap', next.keymap === 'omarchy' ? 'omarchy' : 'herald'], 10_000).then(result => result.code !== 0 && log('keymap', result.stderr.trim()))
    }

    // Every surface window sees the same preferences.
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.webContents !== _event.sender) {
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
  registerServiceIpc()
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
  registerCatalogIpc()
  registerSetupIpc()
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

  // Windows groups the taskbar button, jump list and toast notifications under this id. A dev run (`electron .`) gets its own: it leaves a
  // Start Menu shortcut to electron.exe under its id, and sharing the installed app's id made the taskbar show Electron's atom for Jarod-OS.
  if (process.platform === 'win32') {
    app.setAppUserModelId(isDev ? 'one.jarod.os.dev' : 'one.jarod.os')
  }

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
  void backend.start()
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
