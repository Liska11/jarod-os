// Typed contract between Electron main, the preload bridge and the renderer.
// Everything the renderer can ask the machine to do is declared here; nothing else is exposed.

import type { EventAutomation } from './events.ts'
import type { MenuBarLayout } from './menu-bar.ts'
import type { ColorScheme, ThemeColors } from './theme.ts'

export type BackendPhase = 'idle' | 'resolving' | 'starting' | 'ready' | 'restarting' | 'failed' | 'stopped'

export interface BackendRuntime {
  /** How the runtime was found: the Jarod core built into the app, env override, managed Hermes install, PATH shim, or a backend already running (HERALD_OS_BACKEND_URL). */
  kind: 'jarod' | 'env' | 'managed' | 'path' | 'attached'
  label: string
  /** Source checkout root when known (managed install / env override). */
  root?: string
  command: string[]
}

export interface BackendState {
  phase: BackendPhase
  attempt: number
  runtime?: BackendRuntime
  /** URL du WebSocket JSON-RPC, **sans** jeton (voir `wsToken` et `src/lib/ws-auth.ts`). */
  wsUrl?: string
  /** Jeton de la passerelle : la fenêtre le présente en sous-protocole WebSocket, jamais dans une URL. */
  wsToken?: string
  baseUrl?: string
  port?: number
  error?: string
  /** `refused` : le noyau a refusé de démarrer et l'a dit (profil déjà servi, port occupé) — on ne relance pas en boucle. */
  errorKind?: 'refused'
  logTail: string[]
  /** Another app's messaging gateway on this Hermes home (Hermes Desktop, say): its pid. */
  sharedGateway?: number
}

/** Cible d'un WebSocket authentifié de la passerelle : le jeton va en sous-protocole, pas dans l'URL. */
export interface AudioWsTarget {
  url: string
  token: string
}

export interface RestRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  path: string
  body?: unknown
  query?: Record<string, string | number | boolean | undefined>
}

export interface SystemInfo {
  hostname: string
  platform: NodeJS.Platform
  arch: string
  osVersion: string
  osName: string
  cpuModel: string
  cpuCount: number
  totalMemory: number
  userName: string
  /** Account display name when the platform exposes one. */
  fullName?: string
  homeDir: string
}

export interface DiskUsage {
  mount: string
  total: number
  free: number
  used: number
}

export interface BatteryStatus {
  present: boolean
  percent?: number
  charging?: boolean
}

export interface SystemStats {
  sampledAt: number
  cpuPercent: number
  loadAverage: [number, number, number]
  memoryTotal: number
  memoryUsed: number
  memoryFree: number
  uptimeSeconds: number
  disks: DiskUsage[]
  battery: BatteryStatus
}

export interface ProcessInfo {
  pid: number
  ppid: number
  user: string
  cpuPercent: number
  memPercent: number
  rssBytes: number
  command: string
  name: string
}

/** The menu bar's quick panels. */
export type StatusPanelId = 'wifi' | 'bluetooth' | 'audio' | 'display' | 'power' | 'clock'

export interface WifiNetwork {
  ssid: string
  /** 0 to 100. */
  signal: number
  secure: boolean
  active: boolean
  /** A saved connection exists, so it joins without a password. */
  known: boolean
}

export interface WifiState {
  /** False when there is no Wi-Fi hardware or no NetworkManager. */
  available: boolean
  enabled: boolean
  connected?: string
  networks: WifiNetwork[]
}

export interface BluetoothDevice {
  address: string
  name: string
  paired: boolean
  connected: boolean
  /** freedesktop icon name such as audio-headphones or input-mouse. */
  icon?: string
  battery?: number
}

export interface BluetoothState {
  available: boolean
  powered: boolean
  devices: BluetoothDevice[]
}

export interface AudioDevice {
  /** The PipeWire/PulseAudio node name (what the default and volume calls take). */
  id: string
  name: string
  isDefault: boolean
  /** 0 to 150. */
  volume: number
  muted: boolean
}

export interface AudioState {
  available: boolean
  outputs: AudioDevice[]
  inputs: AudioDevice[]
}

export interface DisplayMode {
  width: number
  height: number
  /** Hz. */
  refresh: number
}

export interface DisplayInfo {
  name: string
  label: string
  enabled: boolean
  width: number
  height: number
  refresh: number
  scale: number
  modes: DisplayMode[]
}

export interface DisplayState {
  available: boolean
  displays: DisplayInfo[]
  /** Built-in backlight, 0 to 100, when there is one. */
  brightness?: number
}

export interface PowerState {
  available: boolean
  battery: BatteryStatus
  /** e.g. "about 3 hours left" or "full in 40 minutes". */
  timeRemaining?: string
  /** power-profiles-daemon: performance, balanced, power-saver. */
  profile?: string
  profiles: string[]
}

export type StatusPanelState =
  | { panel: 'wifi'; wifi: WifiState }
  | { panel: 'bluetooth'; bluetooth: BluetoothState }
  | { panel: 'audio'; audio: AudioState }
  | { panel: 'display'; display: DisplayState }
  | { panel: 'power'; power: PowerState }

/** What the quick panels can change. */
export type ControlAction =
  | { panel: 'wifi'; action: 'enable'; enabled: boolean }
  | { panel: 'wifi'; action: 'scan' }
  | { panel: 'wifi'; action: 'connect'; ssid: string; password?: string }
  | { panel: 'wifi'; action: 'disconnect' }
  | { panel: 'wifi'; action: 'forget'; ssid: string }
  | { panel: 'bluetooth'; action: 'power'; enabled: boolean }
  | { panel: 'bluetooth'; action: 'scan' }
  | { panel: 'bluetooth'; action: 'connect' | 'disconnect' | 'pair' | 'remove'; address: string }
  | { panel: 'audio'; action: 'default'; kind: 'output' | 'input'; id: string }
  | { panel: 'audio'; action: 'volume'; kind: 'output' | 'input'; id?: string; percent?: number; muted?: boolean }
  | { panel: 'display'; action: 'brightness'; percent: number }
  | { panel: 'display'; action: 'scale'; name: string; scale: number }
  | { panel: 'display'; action: 'mode'; name: string; mode: DisplayMode }
  | { panel: 'display'; action: 'enable'; name: string; enabled: boolean }
  | { panel: 'power'; action: 'profile'; profile: string }

export interface InstalledApp {
  name: string
  path: string
  bundleId?: string
  /** LSApplicationCategoryType, e.g. public.app-category.developer-tools. */
  category?: string
}

export interface NetworkStatus {
  online: boolean
  defaultInterface?: string
  ipv4?: string
  wifi?: { connected: boolean; ssid?: string; interface?: string }
}

export interface CalendarEvent {
  id: string
  title: string
  start: number
  end: number
  allDay: boolean
  location?: string
  notes?: string
  calendar?: string
  url?: string
}

export interface CalendarResult {
  status: 'authorized' | 'denied' | 'not-determined' | 'restricted' | 'unavailable'
  events: CalendarEvent[]
  error?: string
}

export interface RecentFile {
  path: string
  name: string
  extension: string
  size: number
  modifiedAt: number
  lastUsedAt: number
  kind: 'file' | 'directory'
}

/** A project folder with recent activity: a git repository or any folder under the projects roots. */
export interface ProjectActivity {
  path: string
  name: string
  /** Current branch; absent when the folder is not a git repository. */
  branch?: string
  /** Files with uncommitted changes. */
  changed: number
  /** The first few of them, relative to the folder. */
  changedFiles: string[]
  /** The last few commits, newest first. */
  commits: { subject: string; at: number }[]
  /** Newest change seen (a commit, a changed file or the folder itself), epoch ms. */
  touchedAt: number
}

/**
 * What Jarod-OS can see of the user's recent work, for "Pick up where you left off": documents,
 * project folders and running apps, minus everything the user excluded. Never window titles or
 * screen contents.
 */
export interface ContextSnapshot {
  takenAt: number
  files: RecentFile[]
  projects: ProjectActivity[]
  /** Names of the apps running now. */
  apps: string[]
}

/** The user came back after sleep, a locked screen or a long idle stretch. */
export interface ContextReturn {
  reason: 'resume' | 'unlock' | 'idle'
  awayMs: number
}

export interface ContinuityItem {
  kind: 'file' | 'folder' | 'project' | 'chat'
  /** Absolute path, or the stored session id for chats. */
  ref: string
  label: string
}

/** One piece of work Hermes thinks the user will want to resume. */
export interface ContinuityThread {
  id: string
  title: string
  summary: string
  /** Where the work stopped, in one short sentence. */
  stopped: string
  /** A suggested next step; the user starts it. */
  next?: { label: string; prompt: string }
  items: ContinuityItem[]
}

export interface ContinuityPrefs {
  /** Null until the user answers the offer on the Overview: the catch-up sends names to the model provider. */
  enabled: boolean | null
  /** Folders (absolute paths) and words Herald never looks at; a word hides any path, chat or event containing it. */
  exclude: string[]
  /** Threads from the last catch-up. */
  threads?: ContinuityThread[]
  updatedAt?: number
  /** Ids of threads the user dismissed. */
  dismissed?: string[]
}

/** A program on this computer crashed: a macOS crash report or a Linux core dump. */
export interface CrashReport {
  id: string
  /** The program's name as people know it ("Safari", "firefox"). */
  app: string
  pid?: number
  /** Executable path, when the report names it. */
  exe?: string
  /** macOS: the `.ips` crash report file. */
  reportPath?: string
  /** Signal or exception, e.g. "SIGSEGV" or "EXC_BAD_ACCESS (SIGSEGV)". */
  reason?: string
  /** Epoch ms. */
  at: number
  source: 'macos' | 'coredump'
}

export interface CrashHelpPrefs {
  /** Offer to have Hermes diagnose crashes (on by default). */
  enabled: boolean
  /** Program names whose crashes stay quiet (compared case-insensitively). */
  muted: string[]
}

export interface ImageInfo {
  width: number
  height: number
}

export interface DirEntry {
  name: string
  path: string
  kind: 'file' | 'directory' | 'symlink' | 'other'
  size: number
  modifiedAt: number
  hidden: boolean
  extension: string
}

export interface FilePreview {
  path: string
  kind: 'text' | 'image' | 'binary' | 'too-large' | 'directory'
  size: number
  /** Text content (utf-8) or a data URL for images. */
  content?: string
  truncated?: boolean
  mime?: string
}

export interface TerminalCreateOptions {
  cwd?: string
  cols: number
  rows: number
  /** A coding agent from the install catalog (its id) to run in the tab instead of a bare shell. */
  program?: string
  /** An environment of the Jarod disk (its name): the shell starts with its tools first in PATH. */
  environment?: string
  /** A WSL machine (its name): the tab runs `wsl -d <name>` instead of the Windows shell. */
  vm?: string
}

/** One entry of the install catalog (linux/catalog/*.json), with its state on this machine. */
export interface CatalogEntryView {
  id: string
  label: string
  description: string
  group: string
  installed: boolean
  /** Installed by one of the catalog's own methods, so removing it from here works. */
  removable?: boolean
  /** It can be installed here (the right OS, architecture, package manager). */
  available: boolean
  /** How it would install: flatpak, dnf, pacman, aur, npm, mise, script, webapp, link, brew, brew-cask. */
  method: string | null
  /** Why it cannot be installed here. */
  reason?: string
  /** A coding agent that runs in the Terminal. */
  terminal?: boolean
  /** A terminal app Super+Return can open instead of Herald's terminal. */
  terminalApp?: string
  /** A local model server Hermes can use. */
  hermes?: 'ollama' | 'lmstudio'
  bin?: string
  /** For `link` installs: the download page. */
  url?: string
}

export interface CatalogGroupView {
  id: string
  label: string
  description: string
  entries: CatalogEntryView[]
}

export interface SetupState {
  /** The Jarod-OS image has not been set up by its owner yet, or (Windows) this install has not been set up yet. */
  needed: boolean
  /** `image`: the Linux image's first boot (account, Wi-Fi). `desktop`: Jarod-OS on Windows (system audit, then accounts). */
  mode: 'image' | 'desktop'
  user: string
  /** The name Herald greets with (blank until setup asks). */
  name: string
}

/** The first-run Telegram step (electron/setup/telegram.ts): the bot behind a token, and a message round trip. */
/** Why a Telegram check failed, for the screen to say it in its language (`error` keeps Telegram's own words). */
export type TelegramErrorCode = 'shape' | 'unauthorized' | 'network' | 'no-message' | 'refused'

export interface TelegramBot {
  ok: boolean
  /** The bot's @username and display name, when the token works. */
  username?: string
  name?: string
  error?: string
  code?: TelegramErrorCode
}

export interface TelegramRoundTrip {
  ok: boolean
  /** Who wrote to the bot. */
  from?: string
  error?: string
  code?: TelegramErrorCode
}

export interface SetupResult {
  ok: boolean
  error?: string
}

export interface CatalogResult {
  ok: boolean
  /** The last lines of the installer's output. */
  output: string
}

export interface TerminalHandle {
  id: string
  pid: number
  shell: string
}

export interface SpaceDef {
  id: string
  name: string
  color: string
  cwd?: string
}

/** Which pipeline turns speech into a Hermes turn and back. See docs/VOICE.md. */
export type VoiceEngine = 'chained' | 'live'

export interface VoicePrefs {
  /** Master switch: when off, no microphone is ever opened and the orb stays hidden. */
  enabled: boolean
  engine: VoiceEngine
  /** Arm the backend "hey hermes" detector with client-captured audio while the shell runs. */
  wakeWord: boolean
  /** Electron accelerator toggling a conversation from anywhere (empty disables the hotkey). */
  hotkey: string
  /** Seconds the mic keeps listening for a follow-up after Hermes finishes speaking. */
  followUpSeconds: number
  /** Speak `notification.show` bodies (missions, reminders) aloud while voice is enabled. */
  announceNotifications: boolean
  /** Show Hermes's own tool results on screen (memory, automations, files) even outside a voice conversation. */
  followHermes: boolean
  /** Set once Jarod-OS has tuned local speech recognition (model + vocabulary), so a later user choice is never overwritten. */
  sttTuned: boolean
  /** Live engine: close the paid session after this many idle seconds. */
  liveIdleSeconds: number
  /** Live engine: refuse to open new sessions once today's minutes reach this cap (0 = no cap). */
  liveDailyCapMinutes: number
  /** Live engine: seconds of session time used on `day` (YYYY-MM-DD, local). */
  liveUsage: { day: string; seconds: number }
}

export type MicPermission = 'granted' | 'denied' | 'not-determined' | 'restricted' | 'unknown'

/** Keyboard modifiers for `EditAction` key presses (Electron accelerator names). */
export type KeyModifier = 'shift' | 'control' | 'alt' | 'meta'

/** Text and editing actions performed on whatever is focused in a Jarod-OS window. */
export type EditAction =
  | { kind: 'insert'; text: string }
  | { kind: 'key'; key: string; modifiers?: KeyModifier[] }
  | { kind: 'copy' | 'cut' | 'paste' | 'selectAll' | 'undo' | 'redo' | 'delete' | 'unselect' }

/** Main -> renderer: run a registry command, list the catalogue, or describe the shell state. */
export type OsControlRequest =
  | { requestId: string; kind: 'run'; command: string; args: Record<string, unknown>; source: 'agent' | 'cli' | 'plugin' | 'ui' }
  | { requestId: string; kind: 'list' }
  | { requestId: string; kind: 'state' }

export interface OsControlReply {
  requestId: string
  /** A `CommandResult`, a command list, or a state snapshot; `error` when the renderer failed outright. */
  result?: unknown
  error?: string
}

/**
 * Renderer -> main: this window asks the shell to run one registry command (its own palette, its own
 * menu). Main decides through the host gate and records the attempt, then runs it in the Hermes
 * window; the shell bus never carries a registry command.
 */
export interface ControlRunResult {
  ok: boolean
  summary?: string
  error?: string
}

/** Authenticated WebSocket endpoints the renderer may dial besides the gateway. */
export type AudioWsKind = 'speak-stream'

export interface HeraldOSPrefs {
  /** The interface language: the system's (`auto`, the default), English or French. */
  language?: 'auto' | 'en' | 'fr'
  /** What the assistant is called in the interface; unset follows the backend (Jarod for the Jarod core, Hermes for Hermes). */
  assistantName?: string
  fullscreenOnLaunch: boolean
  reduceMotion: boolean
  accent: 'blue' | 'ice' | 'violet'
  theme: 'ocean' | 'graphite'
  /** The installed theme in use (a folder name under the theme directories). */
  themeName?: string
  /** Colours of a theme without a hand-tuned preset; the shell derives its whole palette from them. */
  themeColors?: ThemeColors
  themeScheme?: ColorScheme
  /** Restyle Jarod-OS when Hermes's skin changes (`/skin` in a chat). */
  followHermesSkin?: boolean
  /** Font families for the interface and for code, tried before the built-in stacks. */
  fonts?: { ui?: string; mono?: string }
  /** Show the model plan's usage as a small meter in the menu bar. */
  usageInMenuBar?: boolean
  /** The menu bar's items (order, hidden ones) and clock; `normalizeMenuBar` fills the gaps. */
  menuBar?: MenuBarLayout
  /** Hermes automations that run when something happens rather than on a schedule. */
  eventAutomations?: EventAutomation[]
  /** Toasts, system notifications and spoken announcements stay quiet; the bell still collects them. */
  doNotDisturb?: boolean
  /** The drawn wallpaper and a clock after this many idle minutes. */
  screensaver?: { enabled: boolean; afterMinutes: number }
  /** Jarod-OS Linux: minutes of inactivity before locking, turning the screens off and suspending (0 = never). */
  idle?: IdleTimings
  /** Jarod-OS Linux: Herald's keys, or Omarchy-style Super+C, X and V for copy, cut and paste everywhere. */
  keymap?: 'herald' | 'omarchy'
  /** Jarod-OS Linux: the terminal Super+Return opens: Herald's own, or a catalog terminal (ghostty, alacritty, kitty, foot). */
  defaultTerminal?: string
  /** Absolute path or file:// URL of a custom wallpaper image. */
  wallpaper?: string
  defaultCwd?: string
  /** Where "build …" creates project folders (default ~/Projects). */
  projectsRoot?: string
  spaces: SpaceDef[]
  activeSpace: string
  favorites: string[]
  /** Files the user removed from Recents (the system's own recent list is left alone). */
  hiddenRecents?: string[]
  /** Persisted window bounds per app id. */
  windowBounds?: Record<string, { x: number; y: number; width: number; height: number }>
  /** Main-window sidebar: expanded width in px and whether it is collapsed to icons. */
  sidebar?: { width: number; collapsed: boolean }
  /** Slide the Dock off-screen until the cursor reaches the bottom edge (default on). */
  dockAutoHide?: boolean
  voice: VoicePrefs
  continuity: ContinuityPrefs
  crashHelp: CrashHelpPrefs
}

export type ScreenshotMode = 'region' | 'window' | 'screen'

/** macOS capture tools (Jarod-OS Linux runs its own through the CLI). */
export type CaptureTool = 'colour' | 'qr' | 'text'

export interface CaptureToolResult {
  /** What was copied: #rrggbb, the code's contents, or the text read. Empty when nothing was found. */
  text?: string
  lines?: number
  /** Escape before anything was picked or selected. */
  cancelled?: boolean
}

export interface RecordingState {
  recording: boolean
  /** The file being written, then the finished one. */
  file?: string
  startedAt?: number
  audio?: boolean
}

export interface IdleTimings {
  lockAfter: number
  screenOffAfter: number
  suspendAfter: number
}

/** Quick switches in the menu bar and the control menu. */
export type SwitchName = 'nightLight' | 'doNotDisturb' | 'stayAwake' | 'screensaver'

export interface SwitchState {
  /** Warmer colours: wlsunset on Jarod-OS Linux; null where Jarod-OS cannot switch it (macOS has Night Shift). */
  nightLight: boolean | null
  doNotDisturb: boolean
  /** The screens stay on and nothing locks or sleeps on its own. */
  stayAwake: boolean
  screensaver: boolean
}

export interface AuditEntry {
  ts: string
  tool: string
  tier: string
  action?: string
  decision: string
  ok: boolean
  error?: string
  summary?: string
  args?: Record<string, unknown>
}

export interface WindowState {
  fullscreen: boolean
  focused: boolean
  /** The window fills the work area without being fullscreen (Windows draws its own buttons for this). */
  maximized: boolean
}

/**
 * How the shell is composed on screen.
 * - `desktop`: one fullscreen window draws wallpaper, menu bar, dock and windows (macOS, cage).
 * - `panels`: a real compositor (niri) manages every window; the shell is several windows, one per surface.
 */
export type ShellMode = 'desktop' | 'panels'

/** Which part of the shell a renderer window is. `window:<appId>` hosts one floating Hermes app. */
export type ShellSurface = 'desktop' | 'menubar' | 'dock' | 'main' | 'command' | 'panel' | 'screensaver' | 'wallpaper' | 'emoji' | `window:${string}`

/** A window the compositor manages (any client, including the shell's own windows). */
export interface WmWindow {
  id: number
  title: string
  appId: string
  pid: number | null
  workspaceId: number | null
  focused: boolean
  floating: boolean
  urgent: boolean
  /** True for the shell's own windows (menu bar, dock, Hermes window, floating apps). */
  ours: boolean
}

export interface WmWorkspace {
  id: number
  idx: number
  name: string | null
  output: string | null
  active: boolean
  focused: boolean
  activeWindowId: number | null
}

export interface WmState {
  /** False when no compositor IPC is available (desktop mode). */
  available: boolean
  windows: WmWindow[]
  workspaces: WmWorkspace[]
  focusedWindowId: number | null
}

/**
 * Compositor actions the renderer may request. Arguments mirror `niri msg action`.
 *
 * There is deliberately no compositor-argv variant: `niri msg action …` and `hyprctl dispatch …` can
 * both start a program, so a free-argument action would be a host command outside the control gate.
 * The union is the whole of what a window may ask for (R3.2).
 */
export type WmAction =
  | { type: 'focus-window'; id: number }
  | { type: 'close-window'; id: number }
  | { type: 'focus-workspace'; ref: string | number }
  | { type: 'move-window-to-workspace'; id: number; ref: string | number }
  | { type: 'toggle-floating'; id: number }
  | { type: 'fullscreen'; id: number }
  | { type: 'maximize-column' }
  | { type: 'toggle-overview' }
  | { type: 'screenshot'; what: 'screen' | 'window' | 'select' }

/** A command delivered to a surface: from the `herald-os` CLI (hotkeys), or relayed between surfaces. */
export interface ShellCommand {
  type: string
  args?: string[]
  text?: string
  attachments?: string[]
  /** The compositor's focused window when the command was issued (context for "ask"). */
  context?: WmWindow | null
  payload?: Record<string, unknown>
}

/** A rectangle in the renderer's CSS pixels; main converts to device-independent pixels. */
export interface WebViewBounds {
  x: number
  y: number
  width: number
  height: number
  /** Corner radius matching the frame around the view (CSS px). */
  radius?: number
}

export interface WebOpenOptions {
  /** Fixed window title; when omitted the page title is reported through `title` events. */
  title?: string
  /** Previews only: the project folder whose local files the preview may show. */
  root?: string
}

/**
 * The Pinokio engine (electron/pinokio/service.ts): `unavailable` when this build carries none, `external` when the
 * Pinokio app's own engine answers (Jarod-OS uses it but never stops it), `running` when Jarod-OS started its own.
 */
export type PinokioPhase = 'unavailable' | 'stopped' | 'starting' | 'running' | 'external' | 'stopping' | 'error'

export interface PinokioState {
  phase: PinokioPhase
  /** Where the engine answers (http://127.0.0.1:42000). */
  url: string
  /** This build ships an engine Jarod-OS can start. */
  bundled: boolean
  /** pinokiod's version while one answers. */
  version?: string
  /** pinokiod's home folder (apps, tools, models); null until its first-run screen sets one. */
  home: string | null
  error?: string
}

/** Main -> renderer: lifecycle of one embedded web view (`window.heraldOS.web`). */
export type WebViewEvent =
  | { id: string; type: 'title'; title: string }
  | { id: string; type: 'url'; url: string }
  | { id: string; type: 'loading'; loading: boolean }
  | { id: string; type: 'error'; error: string }
  | { id: string; type: 'closed' }
  /** A site's view can go back / forward. */
  | { id: string; type: 'history'; canGoBack: boolean; canGoForward: boolean }
  /** A site's link that leaves its hosts: the Browser page shows it. */
  | { id: string; type: 'external'; url: string }

/** One entry of a project listing (`fs.listTree`), for the Studio's file tree. */
export interface TreeEntry {
  path: string
  kind: 'file' | 'directory'
}

/** Main -> renderer: files changed under a watched project folder (`fs.watchTree`). */
export interface TreeChangedEvent {
  watchId: string
  paths: string[]
}

export interface EnvInfo {
  platform: NodeJS.Platform
  hermesHome: string
  homeDir: string
  version: string
  isDev: boolean
  shellMode: ShellMode
  /** Started with `--safe-mode`: no widget plugins, hook scripts or event automations. */
  safeMode: boolean
  /** Where the shell keeps its own settings and window state (Electron's userData). */
  userDataDir: string
  /** The last time this shell's own window crashed, if it has since it started. */
  lastCrash: { at: string; reason: string } | null
}

/** Channel names, table-driven so preload and main cannot drift. */
export const IPC = {
  backendGetState: 'herald-os:backend:get-state',
  backendState: 'herald-os:backend:state',
  backendRestart: 'herald-os:backend:restart',
  backendRest: 'herald-os:backend:rest',
  backendLogTail: 'herald-os:backend:log-tail',

  systemInfo: 'herald-os:system:info',
  systemStats: 'herald-os:system:stats',
  systemStatsPush: 'herald-os:system:stats-push',
  systemStatsSubscribe: 'herald-os:system:stats-subscribe',
  systemProcesses: 'herald-os:system:processes',

  appsList: 'herald-os:apps:list',
  appsLaunch: 'herald-os:apps:launch',
  appsIcon: 'herald-os:apps:icon',

  fsHome: 'herald-os:fs:home',
  fsReadDir: 'herald-os:fs:read-dir',
  fsReadFile: 'herald-os:fs:read-file',
  fsReveal: 'herald-os:fs:reveal',
  fsOpenPath: 'herald-os:fs:open-path',
  fsOpenIn: 'herald-os:fs:open-in',
  fsRecent: 'herald-os:fs:recent',
  /** Find files by name under the home folder (Spotlight on macOS). */
  fsFind: 'herald-os:fs:find',
  fsThumbnail: 'herald-os:fs:thumbnail',
  fsImageInfo: 'herald-os:fs:image-info',
  fsWriteText: 'herald-os:fs:write-text',
  fsMkdir: 'herald-os:fs:mkdir',
  fsRename: 'herald-os:fs:rename',
  fsTrash: 'herald-os:fs:trash',
  fsExportPdf: 'herald-os:fs:export-pdf',
  fsPickFiles: 'herald-os:fs:pick-files',
  fsDirSize: 'herald-os:fs:dir-size',
  /** A bounded recursive listing of a project folder (build output and dependencies skipped). */
  fsListTree: 'herald-os:fs:list-tree',
  fsWatchTree: 'herald-os:fs:watch-tree',
  fsUnwatchTree: 'herald-os:fs:unwatch-tree',
  /** Main -> renderer: `TreeChangedEvent`. */
  fsTreeChanged: 'herald-os:fs:tree-changed',

  systemNetwork: 'herald-os:system:network',
  calendarToday: 'herald-os:calendar:today',

  /** Recent documents, project folders and running apps, for "Pick up where you left off". */
  contextSnapshot: 'herald-os:context:snapshot',
  /** Main tells the windows the user is back after sleep, a lock or a long idle stretch. */
  contextReturned: 'herald-os:context:returned',

  /** The crashes seen since Jarod-OS started, newest first (offers arrive as a `crash` ShellCommand). */
  crashRecent: 'herald-os:crash:recent',

  /** Installed themes (built in and the user's own). */
  themeList: 'herald-os:theme:list',
  /** Apply a theme everywhere: the shell, Hermes's skin and, on Jarod-OS Linux, the whole session. */
  themeApply: 'herald-os:theme:apply',
  /** Save a theme the shell made (from an image) into the user's theme folder. */
  themeSave: 'herald-os:theme:save',
  /** A small PNG of an image (data URL) to take theme colours from. */
  themeSample: 'herald-os:theme:sample',
  /** Install a theme from a git repository (colours and images only). */
  themeInstall: 'herald-os:theme:install',
  /** Font families installed on this computer. */
  fontsList: 'herald-os:fonts:list',

  /** Let the person select part of the screen; resolves with the PNG's path, or null when cancelled. */
  captureRegion: 'herald-os:capture:region',
  /** A screenshot of a region, the focused window or the whole screen, saved where screenshots go. */
  captureScreenshot: 'herald-os:capture:screenshot',
  /** Start, stop or toggle a screen recording; resolves with the recording state. */
  captureRecord: 'herald-os:capture:record',
  captureRecordState: 'herald-os:capture:record-state',
  captureTool: 'herald-os:capture:tool',
  /** Main -> renderer: a recording started or stopped (`RecordingState`). */
  captureRecordChanged: 'herald-os:capture:record-changed',
  /** An image file as a data URL, for the markup editor. */
  captureReadImage: 'herald-os:capture:read-image',
  /** Write a PNG (data URL) inside the home folder. */
  captureSaveImage: 'herald-os:capture:save-image',
  /** Put an image (a file or a data URL) on the clipboard. */
  captureCopyImage: 'herald-os:capture:copy-image',
  /** Ask the OS for camera access (macOS), for the camera bubble. */
  cameraRequest: 'herald-os:camera:request',

  /** Type text into whatever app is focused (wtype on Wayland, a paste on macOS). */
  dictationType: 'herald-os:dictation:type',

  /** The install catalog: groups of software with their state here, and installing or removing one. */
  catalogList: 'herald-os:catalog:list',
  catalogInstall: 'herald-os:catalog:install',
  catalogRemove: 'herald-os:catalog:remove',
  /** Models a local server (Ollama, LM Studio) has, for "Use with Hermes". */
  catalogLocalModels: 'herald-os:catalog:local-models',

  /** Widget plugins (ADR-019): the installed ones, turning one on or off, git installs, and their messages. */
  pluginsList: 'herald-os:plugins:list',
  pluginsSetEnabled: 'herald-os:plugins:set-enabled',
  pluginsAdd: 'herald-os:plugins:add',
  pluginsUpdate: 'herald-os:plugins:update',
  pluginsRemove: 'herald-os:plugins:remove',
  pluginCall: 'herald-os:plugins:call',
  /** main → renderer: the plugin list changed (installed, enabled, files saved). */
  pluginsChanged: 'herald-os:plugins:changed',

  /** First-boot setup on the Jarod-OS image: whether it is due, the name, the password, done. */
  setupState: 'herald-os:setup:state',
  /** First-run Telegram step: check a bot token (`getMe`); wait for a message to the bot and answer it. */
  setupTelegramCheck: 'herald-os:setup:telegram-check',
  setupTelegramTest: 'herald-os:setup:telegram-test',
  setupName: 'herald-os:setup:name',
  setupPassword: 'herald-os:setup:password',
  setupFinish: 'herald-os:setup:finish',

  /** The events main emitted lately (`HeraldEvent[]`, newest first), for Settings and the agent. */
  eventsRecent: 'herald-os:events:recent',

  /** A quick panel's state (Wi-Fi networks, Bluetooth devices, audio devices, displays, power). */
  controlsStatus: 'herald-os:controls:status',
  /** Change something from a quick panel (`ControlAction`); resolves with the panel's new state. */
  controlsAction: 'herald-os:controls:action',

  switchesGet: 'herald-os:switches:get',
  /** Turn one switch on or off; resolves with every switch's state. */
  switchesSet: 'herald-os:switches:set',
  /** Main -> renderer: a switch changed (from the CLI, a hotkey or another window). */
  switchesChanged: 'herald-os:switches:changed',

  /** The notification history (the last week), kept across restarts. */
  notificationsLoad: 'herald-os:notifications:load',
  notificationsSave: 'herald-os:notifications:save',

  terminalCreate: 'herald-os:terminal:create',
  terminalWrite: 'herald-os:terminal:write',
  terminalResize: 'herald-os:terminal:resize',
  terminalDispose: 'herald-os:terminal:dispose',
  terminalData: 'herald-os:terminal:data',
  terminalExit: 'herald-os:terminal:exit',

  notifyNative: 'herald-os:notify:native',

  windowState: 'herald-os:window:state',
  windowGetState: 'herald-os:window:get-state',
  windowToggleFullscreen: 'herald-os:window:toggle-fullscreen',
  windowQuit: 'herald-os:window:quit',
  windowRelaunch: 'herald-os:window:relaunch',
  windowMinimize: 'herald-os:window:minimize',
  windowToggleMaximize: 'herald-os:window:toggle-maximize',
  windowClose: 'herald-os:window:close',

  shellOpenExternal: 'herald-os:shell:open-external',

  /** Native gestures the Jarod engine asks for (pickers, confirmations, notices): kind + params in, the user's answer out. */
  jarodShell: 'herald-os:jarod:shell',

  // Embedded web views: http(s) pages rendered inside a Jarod-OS window, never the system browser.
  /** Perform an `EditAction` in this window (or in one of its web views). */
  editAction: 'herald-os:edit:action',
  webOpen: 'herald-os:web:open',
  /** Show a local file (PDF, image, text, media) in a locked-down viewer view. */
  webOpenFile: 'herald-os:web:open-file',
  webSetBounds: 'herald-os:web:set-bounds',
  webClose: 'herald-os:web:close',
  /** Studio preview: a web page or a file inside the project folder. */
  webOpenPreview: 'herald-os:web:open-preview',
  webNavigate: 'herald-os:web:navigate',
  webReload: 'herald-os:web:reload',
  /** A site's own page (shared/web-sites.ts): the Browser or one of the Social apps, in its own partition. */
  webOpenSite: 'herald-os:web:open-site',
  /** Back or forward in a view's history. */
  webHistory: 'herald-os:web:history',
  /** Desktop apps the pages hand over to (electron/ipc/native-apps.ts): installed?, start, install with winget. */
  nativeAppFind: 'herald-os:native-app:find',
  nativeAppLaunch: 'herald-os:native-app:launch',
  nativeAppInstall: 'herald-os:native-app:install',
  /** A desktop app's window inside the right pane (electron/platform/window-embed.ts): take it, place it, give it back. */
  nativeEmbedOpen: 'herald-os:native-embed:open',
  nativeEmbedBounds: 'herald-os:native-embed:bounds',
  nativeEmbedRelease: 'herald-os:native-embed:release',
  /** Main -> renderer: the embedded app's window was closed. */
  nativeEmbedGone: 'herald-os:native-embed:gone',
  /** The Player page may stream these files (picked or dropped by the user) through jarod-media:. */
  mediaAllow: 'herald-os:media:allow',
  /** Main -> renderer: title/url/loading changes and `closed`. */
  webEvent: 'herald-os:web:event',

  // The Pinokio engine (electron/pinokio): state, start/stop, its UI in a web view.
  pinokioGetState: 'herald-os:pinokio:get-state',
  /** Main -> renderer: the engine's `PinokioState` changed. */
  pinokioState: 'herald-os:pinokio:state',
  pinokioStart: 'herald-os:pinokio:start',
  pinokioStop: 'herald-os:pinokio:stop',
  /** Open the engine's UI (or one of its pages) in a web view owned by this window; resolves with the view id. */
  pinokioOpenView: 'herald-os:pinokio:open-view',
  pinokioOpenHome: 'herald-os:pinokio:open-home',
  /** Main -> renderer: show this page in a Jarod-OS web window (an app's UI, a link out of Pinokio). */
  pinokioOpenUrl: 'herald-os:pinokio:open-url',

  // The system audit (electron/setup/audit.ts): hardware and prerequisites, checked at first run.
  systemAuditGet: 'herald-os:system-audit:get',
  /** Audit again, ignoring the saved report. */
  systemAuditRun: 'herald-os:system-audit:run',
  /** Install (or update) one missing prerequisite on Windows: a closed list of tools (electron/setup/install.ts). */
  systemAuditInstall: 'herald-os:system-audit:install',
  // The Jarod disk (electron/data-root.ts, electron/data-disk.ts): where Jarod-OS keeps its data, and moving it.
  dataDiskState: 'herald-os:data-disk:state',
  dataDiskDrives: 'herald-os:data-disk:drives',
  /** Make a folder the Jarod disk (copying the data in when asked), then restart. */
  dataDiskApply: 'herald-os:data-disk:apply',
  // Backups on the Jarod disk (electron/backups.ts, electron/ipc/backups.ts).
  backupsState: 'herald-os:backups:state',
  backupsCreate: 'herald-os:backups:create',
  backupsSettings: 'herald-os:backups:settings',
  backupsRemove: 'herald-os:backups:remove',
  /** Put a backup back (the current state is kept aside), then restart. */
  backupsRestore: 'herald-os:backups:restore',
  // Sandboxes on the Jarod disk (electron/sandboxes.ts, electron/ipc/sandboxes.ts).
  sandboxesState: 'herald-os:sandboxes:state',
  sandboxesCreate: 'herald-os:sandboxes:create',
  sandboxesCompare: 'herald-os:sandboxes:compare',
  sandboxesApply: 'herald-os:sandboxes:apply',
  sandboxesRemove: 'herald-os:sandboxes:remove',
  // Environments on the Jarod disk (electron/environments.ts, electron/ipc/environments.ts).
  environmentsState: 'herald-os:environments:state',
  environmentsCreate: 'herald-os:environments:create',
  environmentsRemove: 'herald-os:environments:remove',
  // WSL machines and the Jarod disk (electron/vms.ts, electron/ipc/vms.ts).
  vmsState: 'herald-os:vms:state',
  vmsOnline: 'herald-os:vms:online',
  vmsCreate: 'herald-os:vms:create',
  vmsMove: 'herald-os:vms:move',
  vmsStop: 'herald-os:vms:stop',
  /** Erase a machine (wsl --unregister): the exact name typed by the person is required. */
  vmsRemove: 'herald-os:vms:remove',
  // The Internet switch (shared/network-policy.ts, electron/network.ts).
  networkGet: 'herald-os:network:get',
  networkSet: 'herald-os:network:set',
  networkChanged: 'herald-os:network:changed',

  prefsGet: 'herald-os:prefs:get',
  prefsSet: 'herald-os:prefs:set',
  prefsChanged: 'herald-os:prefs:changed',

  bridgePolicyRead: 'herald-os:bridge:policy-read',
  bridgePolicyWrite: 'herald-os:bridge:policy-write',
  bridgeAuditRead: 'herald-os:bridge:audit-read',

  envInfo: 'herald-os:env:info',

  // OS control: main asks the Hermes window to run a registry command (from the control socket /
  // the agent's os_ui tool) and the window replies.
  osControlRequest: 'herald-os:os-control:request',
  osControlReply: 'herald-os:os-control:reply',
  /** Renderer -> main: this window asks for one registry command (the gate decides, then the bridge runs it). */
  controlRun: 'herald-os:control:run',

  // Voice: microphone permission, tokenized audio WebSocket URLs, the global hotkey.
  voiceRequestMicrophone: 'herald-os:voice:request-microphone',
  voiceMicrophoneStatus: 'herald-os:voice:microphone-status',
  voiceAudioWsUrl: 'herald-os:voice:audio-ws-url',
  /** Main -> renderer: the global voice hotkey was pressed. */
  voiceHotkey: 'herald-os:voice:hotkey',

  // Panels mode: surfaces, cross-window relay, compositor state.
  shellOpen: 'herald-os:shell:open',
  shellClose: 'herald-os:shell:close',
  shellRelay: 'herald-os:shell:relay',
  shellCommand: 'herald-os:shell:command',
  shellResize: 'herald-os:shell:resize',
  shellWallpaperFrame: 'herald-os:shell:wallpaper-frame',
  wmGetState: 'herald-os:wm:get-state',
  wmState: 'herald-os:wm:state',
  wmAction: 'herald-os:wm:action',

  // Phase 2: system services reachable from any surface.
  /** Run a `herald-os` CLI command (install, reminder, notice, ocr, …); resolves with its output. */
  shellHeraldOs: 'herald-os:shell:herald-os',
  menuExtensions: 'herald-os:menu:extensions',
  menuExtensionRun: 'herald-os:menu:extension-run',
  brandingGet: 'herald-os:branding:get',
  brandingSet: 'herald-os:branding:set',
  brandingChanged: 'herald-os:branding:changed',
  /** Power actions: suspend | reboot | poweroff | logout | lock. */
  shellPower: 'herald-os:shell:power',
  /** Clipboard history (cliphist): list entries / paste one back to the clipboard. */
  clipboardHistory: 'herald-os:clipboard:history',
  clipboardPaste: 'herald-os:clipboard:paste',
  /** Desktop notifications from other apps (org.freedesktop.Notifications), pushed to the Hermes window. */
  notificationsIncoming: 'herald-os:notifications:incoming',
  notificationsAction: 'herald-os:notifications:action'
} as const

export type PowerAction = 'suspend' | 'reboot' | 'poweroff' | 'logout' | 'lock'

export interface ClipboardEntry {
  id: string
  /** Text preview (binary entries show a type label such as "[[ binary data 12 KiB png ]]"). */
  preview: string
}

/** A notification received from another application through the freedesktop D-Bus service. */
export interface IncomingNotification {
  id: number
  appName: string
  summary: string
  body: string
  /** Icon name or path as sent by the app, if any. */
  icon?: string
  /** Pairs of [actionKey, label]; the renderer reports a chosen key through `notificationsAction`. */
  actions: Array<[string, string]>
  urgency: 'low' | 'normal' | 'critical'
  /** Milliseconds; -1 lets the shell decide. */
  expireTimeout: number
}

export interface HeraldOsResult {
  code: number
  stdout: string
  stderr: string
}
