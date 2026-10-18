import type { BackupActionResult, BackupsState } from '../shared/backups.ts'
import type { SandboxResult, SandboxesState } from '../shared/sandboxes.ts'
import type { EnvironmentResult, EnvironmentsState } from '../shared/environments.ts'
import type { VmResult, VmsState } from '../shared/vms.ts'
import type { NetworkPolicy } from '../shared/network-policy.ts'
import type { DestinationCheck, ExternalEstimate, ExternalPart, ExternalProgress, ExternalResult, ExternalState } from '../shared/external-backup.ts'
import type { DataDiskApplyResult, DataDiskState, DriveInfo } from '../shared/data-disk.ts'
import { contextBridge, ipcRenderer, webUtils } from 'electron'
import {
  type AudioWsKind,
  type AudioWsTarget,
  type AuditEntry,
  type BackendState,
  type CalendarResult,
  type CatalogGroupView,
  type CatalogResult,
  type SetupResult,
  type SetupState,
  type TelegramBot,
  type TelegramRoundTrip,
  type ClipboardEntry,
  type ContextReturn,
  type ContextSnapshot,
  type ControlAction,
  type ControlRunResult,
  type CrashReport,
  type HeraldOsResult,
  type IncomingNotification,
  type PowerAction,
  type DirEntry,
  type EditAction,
  type EnvInfo,
  type FilePreview,
  type HeraldOSPrefs,
  type ImageInfo,
  type InstalledApp,
  IPC,
  type MicPermission,
  type NetworkStatus,
  type OsControlReply,
  type OsControlRequest,
  type ProcessInfo,
  type RecentFile,
  type RecordingState,
  type CaptureTool,
  type CaptureToolResult,
  type RestRequest,
  type ScreenshotMode,
  type ShellCommand,
  type ShellMode,
  type ShellSurface,
  type StatusPanelId,
  type StatusPanelState,
  type SwitchName,
  type SwitchState,
  type SystemInfo,
  type SystemStats,
  type TerminalCreateOptions,
  type TerminalHandle,
  type TreeChangedEvent,
  type TreeEntry,
  type WebOpenOptions,
  type WebViewBounds,
  type PinokioState,
  type WebViewEvent,
  type WindowState,
  type WmAction,
  type WmState
} from '../shared/ipc.ts'
import type { BrandingPatch, BrandingView } from '../shared/branding.ts'
import type { MenuExtensions } from '../shared/menu-extensions.ts'
import type { PluginMethod, PluginView } from '../shared/plugins.ts'
import type { HeraldEvent } from '../shared/events.ts'
import type { ThemeSpec, ThemeSummary } from '../shared/theme.ts'
import type { AuditReport } from '../shared/system-audit.ts'

type Unsubscribe = () => void

// Main passes the surface identity as extra Chromium switches so it is known before any IPC.
const argValue = (name: string): string | undefined => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
const SURFACE = (argValue('hermes-surface') ?? 'desktop') as ShellSurface
const SHELL_MODE = (argValue('hermes-shell-mode') === 'panels' ? 'panels' : 'desktop') as ShellMode

const subscribe = <T,>(channel: string, listener: (payload: T) => void): Unsubscribe => {
  const wrapped = (_event: unknown, payload: T) => listener(payload)
  ipcRenderer.on(channel, wrapped)

  return () => ipcRenderer.removeListener(channel, wrapped)
}

/** The whole capability surface the renderer gets. Keep it narrow and typed. */
const api = {
  backend: {
    getState: (): Promise<BackendState> => ipcRenderer.invoke(IPC.backendGetState),
    onState: (listener: (state: BackendState) => void): Unsubscribe => subscribe(IPC.backendState, listener),
    restart: (): Promise<void> => ipcRenderer.invoke(IPC.backendRestart),
    rest: <T,>(request: RestRequest): Promise<T> => ipcRenderer.invoke(IPC.backendRest, request),
    logTail: (lines = 200): Promise<string[]> => ipcRenderer.invoke(IPC.backendLogTail, lines)
  },
  system: {
    info: (): Promise<SystemInfo> => ipcRenderer.invoke(IPC.systemInfo),
    stats: (): Promise<SystemStats> => ipcRenderer.invoke(IPC.systemStats),
    processes: (sort: 'cpu' | 'memory', limit: number): Promise<ProcessInfo[]> => ipcRenderer.invoke(IPC.systemProcesses, sort, limit),
    network: (): Promise<NetworkStatus> => ipcRenderer.invoke(IPC.systemNetwork),
    subscribeStats: (listener: (stats: SystemStats) => void): Unsubscribe => {
      const off = subscribe(IPC.systemStatsPush, listener)
      void ipcRenderer.invoke(IPC.systemStatsSubscribe, true)

      return () => {
        off()
        void ipcRenderer.invoke(IPC.systemStatsSubscribe, false)
      }
    }
  },
  apps: {
    list: (): Promise<InstalledApp[]> => ipcRenderer.invoke(IPC.appsList),
    launch: (appPath: string): Promise<void> => ipcRenderer.invoke(IPC.appsLaunch, appPath),
    icon: (appPath: string): Promise<string> => ipcRenderer.invoke(IPC.appsIcon, appPath)
  },
  fs: {
    home: (): Promise<string> => ipcRenderer.invoke(IPC.fsHome),
    readDir: (target: string): Promise<DirEntry[]> => ipcRenderer.invoke(IPC.fsReadDir, target),
    readFile: (target: string): Promise<FilePreview> => ipcRenderer.invoke(IPC.fsReadFile, target),
    reveal: (target: string): Promise<void> => ipcRenderer.invoke(IPC.fsReveal, target),
    openPath: (target: string): Promise<void> => ipcRenderer.invoke(IPC.fsOpenPath, target),
    openIn: (app: 'editor' | 'finder' | 'terminal', target: string): Promise<void> => ipcRenderer.invoke(IPC.fsOpenIn, app, target),
    recent: (limit = 30): Promise<RecentFile[]> => ipcRenderer.invoke(IPC.fsRecent, limit),
    /** Files under the home folder whose name matches, best match first. */
    find: (query: string, limit = 10): Promise<RecentFile[]> => ipcRenderer.invoke(IPC.fsFind, query, limit),
    thumbnail: (target: string, size = 512): Promise<string | null> => ipcRenderer.invoke(IPC.fsThumbnail, target, size),
    imageInfo: (target: string): Promise<ImageInfo | null> => ipcRenderer.invoke(IPC.fsImageInfo, target),
    writeText: (target: string, content: string): Promise<void> => ipcRenderer.invoke(IPC.fsWriteText, target, content),
    mkdir: (target: string): Promise<void> => ipcRenderer.invoke(IPC.fsMkdir, target),
    rename: (from: string, to: string): Promise<void> => ipcRenderer.invoke(IPC.fsRename, from, to),
    trash: (targets: string[]): Promise<void> => ipcRenderer.invoke(IPC.fsTrash, targets),
    exportPdf: (html: string, suggestedName: string): Promise<string | null> => ipcRenderer.invoke(IPC.fsExportPdf, html, suggestedName),
    pickFiles: (options?: { directory?: boolean; multiple?: boolean }): Promise<string[]> => ipcRenderer.invoke(IPC.fsPickFiles, options ?? {}),
    dirSize: (target: string): Promise<{ bytes: number; files: number; complete: boolean }> => ipcRenderer.invoke(IPC.fsDirSize, target),
    listTree: (root: string, limit = 3000): Promise<{ entries: TreeEntry[]; truncated: boolean }> => ipcRenderer.invoke(IPC.fsListTree, root, limit),
    watchTree: (root: string): Promise<string> => ipcRenderer.invoke(IPC.fsWatchTree, root),
    unwatchTree: (watchId: string): Promise<void> => ipcRenderer.invoke(IPC.fsUnwatchTree, watchId),
    onTreeChanged: (listener: (event: TreeChangedEvent) => void): Unsubscribe => subscribe(IPC.fsTreeChanged, listener),
    /** Absolute path of a File dropped from Finder (Electron removed File.path). */
    pathForFile: (file: File): string => {
      try {
        return webUtils.getPathForFile(file)
      } catch {
        return ''
      }
    }
  },
  calendar: {
    today: (): Promise<CalendarResult> => ipcRenderer.invoke(IPC.calendarToday)
  },
  context: {
    /** Recent documents, active project folders and running apps, minus the user's exclusions. */
    snapshot: (): Promise<ContextSnapshot> => ipcRenderer.invoke(IPC.contextSnapshot),
    /** The user is back after sleep, a lock or a long idle stretch (fires in every window). */
    onReturned: (listener: (event: ContextReturn) => void): Unsubscribe => subscribe(IPC.contextReturned, listener)
  },
  crash: {
    /** Programs that crashed since Jarod-OS started, newest first. */
    recent: (): Promise<CrashReport[]> => ipcRenderer.invoke(IPC.crashRecent)
  },
  theme: {
    list: (): Promise<ThemeSummary[]> => ipcRenderer.invoke(IPC.themeList),
    /** Apply an installed theme everywhere; resolves with the new preferences. */
    apply: (name: string): Promise<HeraldOSPrefs> => ipcRenderer.invoke(IPC.themeApply, name),
    /** Save a theme into ~/.config/herald-os/themes (with its wallpaper image copied in). */
    save: (spec: ThemeSpec, imagePath?: string): Promise<string> => ipcRenderer.invoke(IPC.themeSave, spec, imagePath),
    /** A small PNG data URL of an image, to take theme colours from (null when it is not an image). */
    sample: (imagePath: string): Promise<string | null> => ipcRenderer.invoke(IPC.themeSample, imagePath),
    /** Install the themes in a git repository; resolves with their names. */
    install: (url: string): Promise<string[]> => ipcRenderer.invoke(IPC.themeInstall, url)
  },
  fonts: {
    list: (): Promise<string[]> => ipcRenderer.invoke(IPC.fontsList)
  },
  capture: {
    /** The person draws a rectangle on screen; resolves with the PNG's path, or null when cancelled. */
    region: (): Promise<string | null> => ipcRenderer.invoke(IPC.captureRegion),
    /** A screenshot saved where screenshots go (null when the selection was cancelled). */
    screenshot: (mode: ScreenshotMode): Promise<string | null> => ipcRenderer.invoke(IPC.captureScreenshot, mode),
    record: (action: 'start' | 'stop' | 'toggle', options: { region?: boolean; audio?: boolean } = {}): Promise<RecordingState> => ipcRenderer.invoke(IPC.captureRecord, action, options),
    recordState: (): Promise<RecordingState> => ipcRenderer.invoke(IPC.captureRecordState),
    /** macOS: the colour picker, a QR code or the text in part of the screen, copied to the clipboard. */
    tool: (tool: CaptureTool): Promise<CaptureToolResult> => ipcRenderer.invoke(IPC.captureTool, tool),
    onRecordChanged: (listener: (state: RecordingState) => void): Unsubscribe => subscribe(IPC.captureRecordChanged, listener),
    readImage: (file: string): Promise<string> => ipcRenderer.invoke(IPC.captureReadImage, file),
    saveImage: (file: string, dataUrl: string): Promise<string> => ipcRenderer.invoke(IPC.captureSaveImage, file, dataUrl),
    copyImage: (source: string): Promise<void> => ipcRenderer.invoke(IPC.captureCopyImage, source),
    requestCamera: (): Promise<boolean> => ipcRenderer.invoke(IPC.cameraRequest)
  },
  catalog: {
    /** The install catalog with each entry's state on this machine (Linux: everything; macOS: what installs here). */
    list: (): Promise<CatalogGroupView[]> => ipcRenderer.invoke(IPC.catalogList),
    install: (id: string): Promise<CatalogResult> => ipcRenderer.invoke(IPC.catalogInstall, id),
    remove: (id: string): Promise<CatalogResult> => ipcRenderer.invoke(IPC.catalogRemove, id),
    /** The models a local server has (for "Use with Hermes"); rejects with what to do when it is not running. */
    localModels: (kind: 'ollama' | 'lmstudio'): Promise<string[]> => ipcRenderer.invoke(IPC.catalogLocalModels, kind)
  },
  plugins: {
    /** Installed widget plugins: manifest, enabled, problems, and a revision that bumps on saves. */
    list: (): Promise<PluginView[]> => ipcRenderer.invoke(IPC.pluginsList),
    setEnabled: (id: string, enabled: boolean): Promise<PluginView[]> => ipcRenderer.invoke(IPC.pluginsSetEnabled, id, enabled),
    add: (url: string): Promise<PluginView> => ipcRenderer.invoke(IPC.pluginsAdd, url),
    update: (id: string): Promise<PluginView> => ipcRenderer.invoke(IPC.pluginsUpdate, id),
    remove: (id: string): Promise<PluginView[]> => ipcRenderer.invoke(IPC.pluginsRemove, id),
    /** One message from a widget frame, answered (and permission-checked) by main. */
    call: (id: string, method: PluginMethod, params: Record<string, unknown>): Promise<unknown> => ipcRenderer.invoke(IPC.pluginCall, id, method, params),
    onChanged: (listener: (plugins: PluginView[]) => void): Unsubscribe => subscribe(IPC.pluginsChanged, listener)
  },
  branding: {
    /** About's logo and name, and the Linux lock-screen picture. */
    get: (): Promise<BrandingView> => ipcRenderer.invoke(IPC.brandingGet),
    /** Image paths are copied into ~/.config/herald-os/branding; null removes one. */
    set: (patch: BrandingPatch): Promise<BrandingView> => ipcRenderer.invoke(IPC.brandingSet, patch),
    onChanged: (listener: (branding: BrandingView) => void): Unsubscribe => subscribe(IPC.brandingChanged, listener)
  },
  setup: {
    /** First-boot setup on the Jarod-OS image: due or not, the account, the name so far. */
    state: (): Promise<SetupState> => ipcRenderer.invoke(IPC.setupState),
    name: (name: string): Promise<SetupResult> => ipcRenderer.invoke(IPC.setupName, name),
    password: (password: string): Promise<SetupResult> => ipcRenderer.invoke(IPC.setupPassword, password),
    /** `later`: setting it up for someone else, who finishes setup at the next start. */
    finish: (options: { later?: boolean } = {}): Promise<SetupResult> => ipcRenderer.invoke(IPC.setupFinish, options),
    /** Check a Telegram bot token with Telegram (`getMe`); the token is not saved. */
    telegramCheck: (token: string): Promise<TelegramBot> => ipcRenderer.invoke(IPC.setupTelegramCheck, token),
    /** Wait (up to 2 minutes) for a message to the bot and answer it with `reply`. */
    telegramTest: (token: string, reply: string): Promise<TelegramRoundTrip> => ipcRenderer.invoke(IPC.setupTelegramTest, token, reply)
  },
  dictation: {
    /** Type text into the focused app (any app); `copied` when it could only be left on the clipboard. */
    type: (text: string, options: { submit?: boolean; delayMs?: number } = {}): Promise<{ typed: boolean; copied: boolean }> => ipcRenderer.invoke(IPC.dictationType, text, options)
  },
  events: {
    /** Events Jarod-OS saw lately (login, wake, crash, low battery, …), newest first. */
    recent: (): Promise<HeraldEvent[]> => ipcRenderer.invoke(IPC.eventsRecent)
  },
  switches: {
    get: (): Promise<SwitchState> => ipcRenderer.invoke(IPC.switchesGet),
    /** Night light, do not disturb, staying awake, the screensaver; resolves with every switch. */
    set: (name: SwitchName, enabled: boolean): Promise<SwitchState> => ipcRenderer.invoke(IPC.switchesSet, name, enabled),
    onChanged: (listener: (state: SwitchState) => void): Unsubscribe => subscribe(IPC.switchesChanged, listener)
  },
  notificationHistory: {
    /** The last week of notifications, kept across restarts. */
    load: (): Promise<unknown[]> => ipcRenderer.invoke(IPC.notificationsLoad),
    save: (items: unknown[]): Promise<void> => ipcRenderer.invoke(IPC.notificationsSave, items)
  },
  controls: {
    /** A quick panel's state: Wi-Fi networks, Bluetooth devices, audio devices, displays, power. */
    status: (panel: StatusPanelId): Promise<StatusPanelState> => ipcRenderer.invoke(IPC.controlsStatus, panel),
    /** Change something from a quick panel; resolves with that panel's new state. */
    act: (action: ControlAction): Promise<StatusPanelState> => ipcRenderer.invoke(IPC.controlsAction, action)
  },
  terminal: {
    create: (options: TerminalCreateOptions): Promise<TerminalHandle> => ipcRenderer.invoke(IPC.terminalCreate, options),
    write: (id: string, data: string): void => ipcRenderer.send(IPC.terminalWrite, id, data),
    resize: (id: string, cols: number, rows: number): void => ipcRenderer.send(IPC.terminalResize, id, cols, rows),
    dispose: (id: string): Promise<void> => ipcRenderer.invoke(IPC.terminalDispose, id),
    onData: (listener: (id: string, data: string) => void): Unsubscribe => {
      const wrapped = (_event: unknown, id: string, data: string) => listener(id, data)
      ipcRenderer.on(IPC.terminalData, wrapped)

      return () => ipcRenderer.removeListener(IPC.terminalData, wrapped)
    },
    onExit: (listener: (id: string, code: number) => void): Unsubscribe => {
      const wrapped = (_event: unknown, id: string, code: number) => listener(id, code)
      ipcRenderer.on(IPC.terminalExit, wrapped)

      return () => ipcRenderer.removeListener(IPC.terminalExit, wrapped)
    }
  },
  notifications: {
    native: (title: string, body: string): Promise<void> => ipcRenderer.invoke(IPC.notifyNative, title, body)
  },
  window: {
    getState: (): Promise<WindowState> => ipcRenderer.invoke(IPC.windowGetState),
    onState: (listener: (state: WindowState) => void): Unsubscribe => subscribe(IPC.windowState, listener),
    toggleFullscreen: (): Promise<void> => ipcRenderer.invoke(IPC.windowToggleFullscreen),
    quit: (): Promise<void> => ipcRenderer.invoke(IPC.windowQuit),
    /** Quit and start again, in safe mode (no widget plugins, hook scripts or event automations) or normally. */
    relaunch: (safeMode: boolean): Promise<void> => ipcRenderer.invoke(IPC.windowRelaunch, safeMode),
    minimize: (): Promise<void> => ipcRenderer.invoke(IPC.windowMinimize),
    toggleMaximize: (): Promise<void> => ipcRenderer.invoke(IPC.windowToggleMaximize),
    close: (): Promise<void> => ipcRenderer.invoke(IPC.windowClose)
  },
  shell: {
    openExternal: (url: string): Promise<void> => ipcRenderer.invoke(IPC.shellOpenExternal, url),
    /** Which surface this window is, and how the shell is composed. Known synchronously at load. */
    surface: SURFACE,
    mode: SHELL_MODE,
    /** Panels mode: open a surface window (optionally delivering a command to it). */
    open: (surface: ShellSurface, command?: ShellCommand): Promise<void> => ipcRenderer.invoke(IPC.shellOpen, surface, command),
    /** Close a surface window (this one when omitted). */
    close: (surface?: ShellSurface): Promise<void> => ipcRenderer.invoke(IPC.shellClose, surface),
    /** Deliver a command to another surface (e.g. the command overlay asking main to send a prompt). */
    relay: (target: ShellSurface, command: ShellCommand): Promise<void> => ipcRenderer.invoke(IPC.shellRelay, target, command),
    /** Commands arriving for this surface: from the `herald-os` CLI (hotkeys) or another surface. */
    onCommand: (listener: (command: ShellCommand) => void): Unsubscribe => subscribe(IPC.shellCommand, listener),
    /** Ask main to resize this surface window (overlays size to their content). */
    resize: (width: number, height: number): Promise<void> => ipcRenderer.invoke(IPC.shellResize, width, height),
    /** Wallpaper surface only: hand a rendered PNG frame to main for swaybg. */
    wallpaperFrame: (dataUrl: string): Promise<void> => ipcRenderer.invoke(IPC.shellWallpaperFrame, dataUrl),
    /** Run a `herald-os` CLI command from the shell (Linux; rejects elsewhere). */
    heraldOs: (args: string[]): Promise<HeraldOsResult> => ipcRenderer.invoke(IPC.shellHeraldOs, args),
    /** The person's control-menu entries from ~/.config/herald-os/menu.json. */
    menuExtensions: (): Promise<MenuExtensions> => ipcRenderer.invoke(IPC.menuExtensions),
    /** Start a menu.json entry's program (main reads it from the file; only the id crosses). */
    runMenuExtension: (id: string): Promise<void> => ipcRenderer.invoke(IPC.menuExtensionRun, id),
    /** Suspend, reboot, power off, log out, or lock. */
    power: (action: PowerAction): Promise<void> => ipcRenderer.invoke(IPC.shellPower, action)
  },
  edit: {
    /** Type, press a key, or run a clipboard/undo action on the focused element (or in a web view). */
    perform: (action: EditAction, webViewId?: string): Promise<void> => ipcRenderer.invoke(IPC.editAction, action, webViewId)
  },
  web: {
    /** Open an http(s) page in an embedded view owned by this window; resolves with the view id. */
    open: (url: string, options: WebOpenOptions = {}): Promise<string> => ipcRenderer.invoke(IPC.webOpen, url, options),
    /** Show a local file in a viewer view owned by this window; resolves with the view id. */
    openFile: (filePath: string, options: WebOpenOptions = {}): Promise<string> => ipcRenderer.invoke(IPC.webOpenFile, filePath, options),
    /** Place the view over the frame's content rect (CSS px); hidden views keep their bounds. */
    setBounds: (id: string, bounds: WebViewBounds, visible: boolean): void => ipcRenderer.send(IPC.webSetBounds, id, bounds, visible),
    close: (id: string): Promise<void> => ipcRenderer.invoke(IPC.webClose, id),
    openPreview: (target: string, options: WebOpenOptions = {}): Promise<string> => ipcRenderer.invoke(IPC.webOpenPreview, target, options),
    navigate: (id: string, target: string): Promise<void> => ipcRenderer.invoke(IPC.webNavigate, id, target),
    reload: (id: string): Promise<void> => ipcRenderer.invoke(IPC.webReload, id),
    /** A site's page (the Browser, a Social app): one view per site, in the site's own partition; resolves with its id. */
    openSite: (site: string): Promise<string> => ipcRenderer.invoke(IPC.webOpenSite, site),
    history: (id: string, direction: 'back' | 'forward'): Promise<void> => ipcRenderer.invoke(IPC.webHistory, id, direction),
    onEvent: (listener: (event: WebViewEvent) => void): Unsubscribe => subscribe(IPC.webEvent, listener)
  },
  pinokio: {
    getState: (): Promise<PinokioState> => ipcRenderer.invoke(IPC.pinokioGetState),
    onState: (listener: (state: PinokioState) => void): Unsubscribe => subscribe(IPC.pinokioState, listener),
    /** Start the engine (or find the Pinokio app's); resolves with the resulting state. */
    start: (): Promise<PinokioState> => ipcRenderer.invoke(IPC.pinokioStart),
    stop: (): Promise<PinokioState> => ipcRenderer.invoke(IPC.pinokioStop),
    /** Open the engine's UI (or `url`, a page on this computer) in a view owned by this window; resolves with the view id. */
    openView: (url?: string, options: WebOpenOptions = {}): Promise<string> => ipcRenderer.invoke(IPC.pinokioOpenView, url ?? '', options),
    openHome: (): Promise<void> => ipcRenderer.invoke(IPC.pinokioOpenHome),
    /** Main asks for a page to be shown in a Jarod-OS window (an app's UI, a link out of Pinokio). */
    onOpenUrl: (listener: (url: string) => void): Unsubscribe => subscribe(IPC.pinokioOpenUrl, listener)
  },
  dataDisk: {
    state: (): Promise<DataDiskState> => ipcRenderer.invoke(IPC.dataDiskState),
    drives: (): Promise<DriveInfo[]> => ipcRenderer.invoke(IPC.dataDiskDrives),
    /** Make `root` the Jarod disk (copying the data and workspace in with `move`); Jarod-OS restarts on success. */
    apply: (root: string, move: boolean): Promise<DataDiskApplyResult> => ipcRenderer.invoke(IPC.dataDiskApply, root, move)
  },
  backups: {
    state: (): Promise<BackupsState> => ipcRenderer.invoke(IPC.backupsState),
    create: (): Promise<BackupActionResult> => ipcRenderer.invoke(IPC.backupsCreate),
    settings: (daily: boolean, keep: number): Promise<BackupsState> => ipcRenderer.invoke(IPC.backupsSettings, daily, keep),
    remove: (id: string): Promise<BackupActionResult> => ipcRenderer.invoke(IPC.backupsRemove, id),
    /** Put a backup back (with the workspace too when asked); Jarod-OS restarts on success. */
    restore: (id: string, withWorkspace: boolean): Promise<BackupActionResult> => ipcRenderer.invoke(IPC.backupsRestore, id, withWorkspace)
  },
  sandboxes: {
    state: (): Promise<SandboxesState> => ipcRenderer.invoke(IPC.sandboxesState),
    /** Copy a project into a new sandbox (`full`: with node_modules and the other rebuildable folders). */
    create: (source: string, label: string, full: boolean): Promise<SandboxResult> => ipcRenderer.invoke(IPC.sandboxesCreate, source, label, full),
    compare: (name: string): Promise<SandboxResult> => ipcRenderer.invoke(IPC.sandboxesCompare, name),
    /** Bring the sandbox's changes (or only `paths`) into its project; removed files go to the Recycle Bin. */
    apply: (name: string, paths?: string[]): Promise<SandboxResult> => ipcRenderer.invoke(IPC.sandboxesApply, name, paths),
    remove: (name: string): Promise<SandboxResult> => ipcRenderer.invoke(IPC.sandboxesRemove, name)
  },
  environments: {
    state: (): Promise<EnvironmentsState> => ipcRenderer.invoke(IPC.environmentsState),
    /** Build a Python (uv) or Node.js environment of `version` ("3.12", "22"…). */
    create: (name: string, kind: 'python' | 'node', version: string): Promise<EnvironmentResult> => ipcRenderer.invoke(IPC.environmentsCreate, name, kind, version),
    remove: (name: string): Promise<EnvironmentResult> => ipcRenderer.invoke(IPC.environmentsRemove, name)
  },
  vms: {
    state: (): Promise<VmsState> => ipcRenderer.invoke(IPC.vmsState),
    online: (): Promise<Array<{ id: string; label: string }>> => ipcRenderer.invoke(IPC.vmsOnline),
    /** Install a distribution as `name` on the Jarod disk (not started: its first start in a terminal asks for a user). */
    create: (distro: string, name: string): Promise<VmResult> => ipcRenderer.invoke(IPC.vmsCreate, distro, name),
    move: (name: string): Promise<VmResult> => ipcRenderer.invoke(IPC.vmsMove, name),
    stop: (name: string): Promise<VmResult> => ipcRenderer.invoke(IPC.vmsStop, name),
    remove: (name: string, typed: string): Promise<VmResult> => ipcRenderer.invoke(IPC.vmsRemove, name, typed)
  },
  externalBackup: {
    state: (): Promise<ExternalState> => ipcRenderer.invoke(IPC.externalBackupState),
    estimate: (parts: ExternalPart[]): Promise<ExternalEstimate> => ipcRenderer.invoke(IPC.externalBackupEstimate, parts),
    check: (dest: string): Promise<DestinationCheck> => ipcRenderer.invoke(IPC.externalBackupCheck, dest),
    /** The native folder picker; null when cancelled. */
    choose: (): Promise<string | null> => ipcRenderer.invoke(IPC.externalBackupChoose),
    setDestination: (dest: string | null): Promise<ExternalResult> => ipcRenderer.invoke(IPC.externalBackupSetDestination, dest),
    setOptions: (parts: ExternalPart[], auto: { enabled: boolean; everyHours: number }): Promise<ExternalState> => ipcRenderer.invoke(IPC.externalBackupSetOptions, parts, auto),
    run: (): Promise<ExternalResult> => ipcRenderer.invoke(IPC.externalBackupRun),
    cancel: (): Promise<boolean> => ipcRenderer.invoke(IPC.externalBackupCancel),
    /** Restore the backup in `folder` (Jarod-OS restarts once it is in place). */
    restore: (folder: string): Promise<ExternalResult> => ipcRenderer.invoke(IPC.externalBackupRestore, folder),
    onProgress: (listener: (progress: ExternalProgress) => void): Unsubscribe => subscribe(IPC.externalBackupProgress, listener)
  },
  remote: {
    /** Tailscale's state and peers, read from the local Tailscale service. */
    tailscale: (): Promise<{ installed: boolean; backend: string | null; self: { name: string; ips: string[] } | null; peers: Array<{ name: string; dnsName: string; ips: string[]; os: string; online: boolean; sshHostKeys: boolean }>; error?: string }> =>
      ipcRenderer.invoke(IPC.remoteTailscale),
    /** Network test: a TCP connection to host:port, nothing sent. */
    probe: (host: string, port: number): Promise<{ ok: boolean; ms: number; error?: string }> => ipcRenderer.invoke(IPC.remoteProbe, host, port),
    /** Reads the host keys and compares them with known_hosts; `token` confirms them with trustKeys. */
    scanKeys: (host: string, port: number): Promise<{ token: string; verdict: 'unknown' | 'match' | 'changed' | 'unreachable'; keys: Array<{ type: string; fingerprint: string }>; known: string[] } | { error: string }> =>
      ipcRenderer.invoke(IPC.remoteScanKeys, host, port),
    trustKeys: (token: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke(IPC.remoteTrustKeys, token),
    syncHosts: (hosts: string[]): Promise<NetworkPolicy> => ipcRenderer.invoke(IPC.remoteSyncHosts, hosts)
  },
  network: {
    /** Jarod's Internet policy (the switch in the top bar). */
    get: (): Promise<NetworkPolicy> => ipcRenderer.invoke(IPC.networkGet),
    set: (change: Partial<Omit<NetworkPolicy, 'version'>>): Promise<NetworkPolicy> => ipcRenderer.invoke(IPC.networkSet, change),
    onChanged: (listener: (policy: NetworkPolicy) => void): Unsubscribe => subscribe(IPC.networkChanged, listener)
  },
  systemAudit: {
    /** The system audit: the saved report, or the one running since startup. */
    get: (): Promise<AuditReport> => ipcRenderer.invoke(IPC.systemAuditGet),
    /** Audit the system again (after installing a missing prerequisite). */
    run: (): Promise<AuditReport> => ipcRenderer.invoke(IPC.systemAuditRun),
    /** Install (or, with `upgrade`, update) a prerequisite the audit found missing; Windows only. */
    install: (tool: string, upgrade = false): Promise<{ ok: boolean; restart?: boolean; already?: boolean; error?: string }> => ipcRenderer.invoke(IPC.systemAuditInstall, tool, upgrade)
  },
  clipboard: {
    history: (limit = 50): Promise<ClipboardEntry[]> => ipcRenderer.invoke(IPC.clipboardHistory, limit),
    paste: (id: string): Promise<void> => ipcRenderer.invoke(IPC.clipboardPaste, id)
  },
  desktopNotifications: {
    onIncoming: (listener: (notification: IncomingNotification) => void): Unsubscribe => subscribe(IPC.notificationsIncoming, listener),
    /** Report that the user invoked an action (or 'default' for a click) on a notification. */
    action: (id: number, actionKey: string): Promise<void> => ipcRenderer.invoke(IPC.notificationsAction, id, actionKey)
  },
  wm: {
    getState: (): Promise<WmState> => ipcRenderer.invoke(IPC.wmGetState),
    onState: (listener: (state: WmState) => void): Unsubscribe => subscribe(IPC.wmState, listener),
    action: (action: WmAction): Promise<void> => ipcRenderer.invoke(IPC.wmAction, action)
  },
  prefs: {
    get: (): Promise<HeraldOSPrefs> => ipcRenderer.invoke(IPC.prefsGet),
    set: (patch: Partial<HeraldOSPrefs>): Promise<HeraldOSPrefs> => ipcRenderer.invoke(IPC.prefsSet, patch),
    /** Preferences changed from another surface window. */
    onChanged: (listener: (prefs: HeraldOSPrefs) => void): Unsubscribe => subscribe(IPC.prefsChanged, listener)
  },
  osControl: {
    /** Main asks this window to run a registry command / list commands / report state. */
    onRequest: (listener: (request: OsControlRequest) => void): Unsubscribe => subscribe(IPC.osControlRequest, listener),
    reply: (reply: OsControlReply): void => ipcRenderer.send(IPC.osControlReply, reply)
  },
  control: {
    /**
     * Run one registry command from this window (the shell's own palette or menu): main checks it
     * against the catalogue, decides, records the attempt, and runs it in the Hermes window.
     */
    run: (command: string, args: Record<string, unknown> = {}): Promise<ControlRunResult> => ipcRenderer.invoke(IPC.controlRun, command, args)
  },
  voice: {
    /** Current OS-level microphone authorization (always 'granted' outside macOS). */
    microphoneStatus: (): Promise<MicPermission> => ipcRenderer.invoke(IPC.voiceMicrophoneStatus),
    /** Prompt the OS for microphone access when it has not been decided yet. */
    requestMicrophone: (): Promise<MicPermission> => ipcRenderer.invoke(IPC.voiceRequestMicrophone),
    /** Audio WebSocket target for the shell (speak-stream): token as a subprotocol, never in the URL. */
    audioWsUrl: (kind: AudioWsKind): Promise<AudioWsTarget> => ipcRenderer.invoke(IPC.voiceAudioWsUrl, kind),
    /** The global voice hotkey was pressed (fires in every window; the main surface acts). */
    onHotkey: (listener: () => void): Unsubscribe => subscribe<void>(IPC.voiceHotkey, () => listener())
  },
  jarod: {
    /** Perform a native gesture the Jarod engine asked for (see electron/ipc/jarod-shell-gestures.ts). */
    shell: (kind: string, params: Record<string, unknown> = {}): Promise<unknown> => ipcRenderer.invoke(IPC.jarodShell, kind, params)
  },
  nativeApps: {
    /** Signal, VLC or Brave is installed on this computer. */
    installed: (app: string): Promise<boolean> => ipcRenderer.invoke(IPC.nativeAppFind, app),
    /** Start it, with a page (Brave) or a file (VLC). */
    launch: (app: string, target?: string): Promise<void> => ipcRenderer.invoke(IPC.nativeAppLaunch, app, target),
    install: (app: string): Promise<{ ok: boolean; already?: boolean; restart?: boolean; error?: string }> => ipcRenderer.invoke(IPC.nativeAppInstall, app),
    /** Start (or find) the app and bring its window into the right pane, with a file for VLC. */
    embed: (app: string, target?: string): Promise<void> => ipcRenderer.invoke(IPC.nativeEmbedOpen, app, target),
    /** Place the embedded window over the tab (CSS px of this window), or hide it. */
    place: (app: string, bounds: WebViewBounds, visible: boolean): void => ipcRenderer.send(IPC.nativeEmbedBounds, app, bounds, visible),
    /** Give the window its frame back (the tab closed). */
    release: (app: string): Promise<void> => ipcRenderer.invoke(IPC.nativeEmbedRelease, app),
    onGone: (listener: (app: string) => void): Unsubscribe => subscribe(IPC.nativeEmbedGone, listener)
  },
  media: {
    /** Let the Player stream these files; resolves with a jarod-media: URL for each one that exists. */
    allow: (files: string[]): Promise<Array<{ file: string; url: string }>> => ipcRenderer.invoke(IPC.mediaAllow, files)
  },
  bridge: {
    readPolicy: (): Promise<string> => ipcRenderer.invoke(IPC.bridgePolicyRead),
    writePolicy: (text: string): Promise<void> => ipcRenderer.invoke(IPC.bridgePolicyWrite, text),
    readAudit: (limit = 200): Promise<AuditEntry[]> => ipcRenderer.invoke(IPC.bridgeAuditRead, limit)
  },
  env: (): Promise<EnvInfo> => ipcRenderer.invoke(IPC.envInfo)
}

export type HeraldOSApi = typeof api

contextBridge.exposeInMainWorld('heraldOS', api)
