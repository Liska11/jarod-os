// Typed contract between Electron main, the preload bridge and the renderer.
// Everything the renderer can ask the machine to do is declared here; nothing else is exposed.

import type { EventAutomation } from './events.ts'
import type { MenuBarLayout } from './menu-bar.ts'
import type { ColorScheme, ThemeColors } from './theme.ts'

export type BackendPhase = 'idle' | 'resolving' | 'starting' | 'ready' | 'restarting' | 'failed' | 'stopped'

export interface BackendRuntime {
  /** How the runtime was found: the Jarod core built into the app, env override, managed Hermes install, PATH shim, or a backend already running (JAROD_OS_BACKEND_URL). */
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
  /** Jeton de la passerelle : la fenêtre le présente comme `wsAuth` le dit. */
  wsToken?: string
  /** Comment présenter `wsToken` (voir `src/lib/ws-auth.ts`). Absent : `subprotocol`. */
  wsAuth?: GatewayAuth
  baseUrl?: string
  port?: number
  error?: string
  /** `refused` : le noyau a refusé de démarrer et l'a dit (profil déjà servi, port occupé) — on ne relance pas en boucle. */
  errorKind?: 'refused'
  logTail: string[]
  /** Another app's messaging gateway on this Hermes home (Hermes Desktop, say): its pid. */
  sharedGateway?: number
}

/**
 * Où un WebSocket de la passerelle porte son jeton. `subprotocol` : le noyau Jarod (`jarod-gw`, hors de l'URL).
 * `query` : `?token=`, la seule forme qu'un `hermes serve` local accepte (v0.22.4, `web_server_chat._ws_auth_reason`) ;
 * le jeton y passe dans l'URL, d'où le masquage de `token=` dans les journaux (`shared/redact.ts`).
 */
export type GatewayAuth = 'subprotocol' | 'query'

/** Cible d'un WebSocket authentifié de la passerelle : le jeton va là où `auth` le dit. */
export interface AudioWsTarget {
  url: string
  token: string
  auth?: GatewayAuth
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

/** What `fs.lock` got: the lock (until `fs.unlock(id)`), a wait that ran out, or no way to take it here (V-20, upstream #140). */
export type FileLockResult = { status: 'locked'; id: string } | { status: 'timeout' } | { status: 'unavailable'; reason: string }

/** `fs.writeText` options (V-20, upstream #140). */
export interface WriteTextOptions {
  /** Replace the file through a renamed temporary, so readers never see it half written. */
  atomic?: boolean
  /** With `atomic`: write only if the file still holds exactly this text (`null`: only if absent). */
  expect?: string | null
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
  /** A remote machine (docs/REMOTE-SSH.md): the tab runs `ssh` to it, host keys checked strictly (an unknown key fails). */
  ssh?: { host: string; port: number; user: string; identity?: string }
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
  /**
   * Duplex: the mic keeps listening while Jarod speaks, and speaking over it interrupts (docs/VOICE.md). Off (classic): the mic is
   * closed while Jarod speaks; the stop button still interrupts. Headphones make duplex reliable.
   */
  duplex: boolean
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

export interface JarodOSPrefs {
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
  /** Lot C : la mini-fenêtre en haut de l'écran (ce que fait Jarod, ce qui attend une réponse) ; éteinte par défaut, menu de l'icône. */
  miniWindow?: boolean
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

/**
 * V-03 : les dernières lignes BRUTES des journaux du shell — `audit.jsonl` (pont système), `control-audit.jsonl` (contrôle, shell et hôte Rust)
 * et `download-quarantine.jsonl` (téléchargements des applications web, V-07).
 */
export interface AuditJournals {
  bridge: string[]
  control: string[]
  downloads: string[]
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

/** Main -> renderer: lifecycle of one embedded web view (`window.jarodOS.web`). */
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
  backendGetState: 'jarod-os:backend:get-state',
  backendState: 'jarod-os:backend:state',
  backendRestart: 'jarod-os:backend:restart',
  backendRest: 'jarod-os:backend:rest',
  backendLogTail: 'jarod-os:backend:log-tail',

  systemInfo: 'jarod-os:system:info',
  systemStats: 'jarod-os:system:stats',
  systemStatsPush: 'jarod-os:system:stats-push',
  systemStatsSubscribe: 'jarod-os:system:stats-subscribe',
  systemProcesses: 'jarod-os:system:processes',

  appsList: 'jarod-os:apps:list',
  appsLaunch: 'jarod-os:apps:launch',
  appsIcon: 'jarod-os:apps:icon',

  fsHome: 'jarod-os:fs:home',
  fsReadDir: 'jarod-os:fs:read-dir',
  fsReadFile: 'jarod-os:fs:read-file',
  fsReveal: 'jarod-os:fs:reveal',
  fsOpenPath: 'jarod-os:fs:open-path',
  fsOpenIn: 'jarod-os:fs:open-in',
  fsRecent: 'jarod-os:fs:recent',
  /** Find files by name under the home folder (Spotlight on macOS). */
  fsFind: 'jarod-os:fs:find',
  fsThumbnail: 'jarod-os:fs:thumbnail',
  fsImageInfo: 'jarod-os:fs:image-info',
  fsWriteText: 'jarod-os:fs:write-text',
  fsMkdir: 'jarod-os:fs:mkdir',
  /** Take or release the exclusive lock Hermes's memory tool takes on a `.lock` file (V-20). */
  fsLock: 'jarod-os:fs:lock',
  fsUnlock: 'jarod-os:fs:unlock',
  fsRename: 'jarod-os:fs:rename',
  fsTrash: 'jarod-os:fs:trash',
  fsExportPdf: 'jarod-os:fs:export-pdf',
  fsPickFiles: 'jarod-os:fs:pick-files',
  fsDirSize: 'jarod-os:fs:dir-size',
  /** A bounded recursive listing of a project folder (build output and dependencies skipped). */
  fsListTree: 'jarod-os:fs:list-tree',
  fsWatchTree: 'jarod-os:fs:watch-tree',
  fsUnwatchTree: 'jarod-os:fs:unwatch-tree',
  /** Main -> renderer: `TreeChangedEvent`. */
  fsTreeChanged: 'jarod-os:fs:tree-changed',

  systemNetwork: 'jarod-os:system:network',
  calendarToday: 'jarod-os:calendar:today',

  /** Recent documents, project folders and running apps, for "Pick up where you left off". */
  contextSnapshot: 'jarod-os:context:snapshot',
  /** Main tells the windows the user is back after sleep, a lock or a long idle stretch. */
  contextReturned: 'jarod-os:context:returned',

  /** The crashes seen since Jarod-OS started, newest first (offers arrive as a `crash` ShellCommand). */
  crashRecent: 'jarod-os:crash:recent',

  /** Installed themes (built in and the user's own). */
  themeList: 'jarod-os:theme:list',
  /** Apply a theme everywhere: the shell, Hermes's skin and, on Jarod-OS Linux, the whole session. */
  themeApply: 'jarod-os:theme:apply',
  /** Save a theme the shell made (from an image) into the user's theme folder. */
  themeSave: 'jarod-os:theme:save',
  /** A small PNG of an image (data URL) to take theme colours from. */
  themeSample: 'jarod-os:theme:sample',
  /** Install a theme from a git repository (colours and images only). */
  themeInstall: 'jarod-os:theme:install',
  /** Font families installed on this computer. */
  fontsList: 'jarod-os:fonts:list',

  /** Let the person select part of the screen; resolves with the PNG's path, or null when cancelled. */
  captureRegion: 'jarod-os:capture:region',
  /** A screenshot of a region, the focused window or the whole screen, saved where screenshots go. */
  captureScreenshot: 'jarod-os:capture:screenshot',
  /** Start, stop or toggle a screen recording; resolves with the recording state. */
  captureRecord: 'jarod-os:capture:record',
  captureRecordState: 'jarod-os:capture:record-state',
  captureTool: 'jarod-os:capture:tool',
  /** Main -> renderer: a recording started or stopped (`RecordingState`). */
  captureRecordChanged: 'jarod-os:capture:record-changed',
  /** An image file as a data URL, for the markup editor. */
  captureReadImage: 'jarod-os:capture:read-image',
  /** Write a PNG (data URL) inside the home folder. */
  captureSaveImage: 'jarod-os:capture:save-image',
  /** Put an image (a file or a data URL) on the clipboard. */
  captureCopyImage: 'jarod-os:capture:copy-image',
  /** Ask the OS for camera access (macOS), for the camera bubble. */
  cameraRequest: 'jarod-os:camera:request',

  /** Type text into whatever app is focused (wtype on Wayland, a paste on macOS). */
  dictationType: 'jarod-os:dictation:type',

  /** The install catalog: groups of software with their state here, and installing or removing one. */
  catalogList: 'jarod-os:catalog:list',
  catalogInstall: 'jarod-os:catalog:install',
  catalogRemove: 'jarod-os:catalog:remove',
  /** Models a local server (Ollama, LM Studio) has, for "Use with Hermes". */
  catalogLocalModels: 'jarod-os:catalog:local-models',

  /** Widget plugins (ADR-019): the installed ones, turning one on or off, git installs, and their messages. */
  pluginsList: 'jarod-os:plugins:list',
  pluginsSetEnabled: 'jarod-os:plugins:set-enabled',
  pluginsAdd: 'jarod-os:plugins:add',
  pluginsUpdate: 'jarod-os:plugins:update',
  pluginsRemove: 'jarod-os:plugins:remove',
  pluginCall: 'jarod-os:plugins:call',
  /** main → renderer: the plugin list changed (installed, enabled, files saved). */
  pluginsChanged: 'jarod-os:plugins:changed',

  /** First-boot setup on the Jarod-OS image: whether it is due, the name, the password, done. */
  setupState: 'jarod-os:setup:state',
  /** First-run Telegram step: check a bot token (`getMe`); wait for a message to the bot and answer it. */
  setupTelegramCheck: 'jarod-os:setup:telegram-check',
  setupTelegramTest: 'jarod-os:setup:telegram-test',
  setupName: 'jarod-os:setup:name',
  setupPassword: 'jarod-os:setup:password',
  setupFinish: 'jarod-os:setup:finish',

  /** The events main emitted lately (`JarodEvent[]`, newest first), for Settings and the agent. */
  eventsRecent: 'jarod-os:events:recent',

  /** A quick panel's state (Wi-Fi networks, Bluetooth devices, audio devices, displays, power). */
  controlsStatus: 'jarod-os:controls:status',
  /** Change something from a quick panel (`ControlAction`); resolves with the panel's new state. */
  controlsAction: 'jarod-os:controls:action',

  switchesGet: 'jarod-os:switches:get',
  /** Turn one switch on or off; resolves with every switch's state. */
  switchesSet: 'jarod-os:switches:set',
  /** Main -> renderer: a switch changed (from the CLI, a hotkey or another window). */
  switchesChanged: 'jarod-os:switches:changed',

  /** The notification history (the last week), kept across restarts. */
  notificationsLoad: 'jarod-os:notifications:load',
  notificationsSave: 'jarod-os:notifications:save',

  terminalCreate: 'jarod-os:terminal:create',
  terminalWrite: 'jarod-os:terminal:write',
  terminalResize: 'jarod-os:terminal:resize',
  terminalDispose: 'jarod-os:terminal:dispose',
  terminalData: 'jarod-os:terminal:data',
  terminalExit: 'jarod-os:terminal:exit',

  notifyNative: 'jarod-os:notify:native',

  windowState: 'jarod-os:window:state',
  windowGetState: 'jarod-os:window:get-state',
  windowToggleFullscreen: 'jarod-os:window:toggle-fullscreen',
  windowQuit: 'jarod-os:window:quit',
  windowRelaunch: 'jarod-os:window:relaunch',
  windowMinimize: 'jarod-os:window:minimize',
  windowToggleMaximize: 'jarod-os:window:toggle-maximize',
  windowClose: 'jarod-os:window:close',

  shellOpenExternal: 'jarod-os:shell:open-external',

  /** Native gestures the Jarod engine asks for (pickers, confirmations, notices): kind + params in, the user's answer out. */
  jarodShell: 'jarod-os:jarod:shell',

  // Embedded web views: http(s) pages rendered inside a Jarod-OS window, never the system browser.
  /** Perform an `EditAction` in this window (or in one of its web views). */
  editAction: 'jarod-os:edit:action',
  webOpen: 'jarod-os:web:open',
  /** Show a local file (PDF, image, text, media) in a locked-down viewer view. */
  webOpenFile: 'jarod-os:web:open-file',
  webSetBounds: 'jarod-os:web:set-bounds',
  webClose: 'jarod-os:web:close',
  /** Studio preview: a web page or a file inside the project folder. */
  webOpenPreview: 'jarod-os:web:open-preview',
  webNavigate: 'jarod-os:web:navigate',
  webReload: 'jarod-os:web:reload',
  /** A site's own page (shared/web-sites.ts): the Browser or one of the Social apps, in its own partition. */
  webOpenSite: 'jarod-os:web:open-site',
  /** Back or forward in a view's history. */
  webHistory: 'jarod-os:web:history',
  /** Desktop apps the pages hand over to (electron/ipc/native-apps.ts): installed?, start, install with winget. */
  nativeAppFind: 'jarod-os:native-app:find',
  nativeAppLaunch: 'jarod-os:native-app:launch',
  nativeAppInstall: 'jarod-os:native-app:install',
  /** A desktop app's window inside the right pane (electron/platform/window-embed.ts): take it, place it, give it back. */
  nativeEmbedOpen: 'jarod-os:native-embed:open',
  nativeEmbedBounds: 'jarod-os:native-embed:bounds',
  nativeEmbedRelease: 'jarod-os:native-embed:release',
  /** Main -> renderer: the embedded app's window was closed. */
  nativeEmbedGone: 'jarod-os:native-embed:gone',
  /** The Player page may stream these files (picked or dropped by the user) through jarod-media:. */
  mediaAllow: 'jarod-os:media:allow',
  /** Main -> renderer: title/url/loading changes and `closed`. */
  webEvent: 'jarod-os:web:event',

  // The Pinokio engine (electron/pinokio): state, start/stop, its UI in a web view.
  pinokioGetState: 'jarod-os:pinokio:get-state',
  /** Main -> renderer: the engine's `PinokioState` changed. */
  pinokioState: 'jarod-os:pinokio:state',
  pinokioStart: 'jarod-os:pinokio:start',
  pinokioStop: 'jarod-os:pinokio:stop',
  /** Open the engine's UI (or one of its pages) in a web view owned by this window; resolves with the view id. */
  pinokioOpenView: 'jarod-os:pinokio:open-view',
  pinokioOpenHome: 'jarod-os:pinokio:open-home',
  /** Main -> renderer: show this page in a Jarod-OS web window (an app's UI, a link out of Pinokio). */
  pinokioOpenUrl: 'jarod-os:pinokio:open-url',

  // The system audit (electron/setup/audit.ts): hardware and prerequisites, checked at first run.
  systemAuditGet: 'jarod-os:system-audit:get',
  /** Audit again, ignoring the saved report. */
  systemAuditRun: 'jarod-os:system-audit:run',
  /** Install (or update) one missing prerequisite on Windows: a closed list of tools (electron/setup/install.ts). */
  systemAuditInstall: 'jarod-os:system-audit:install',
  // The Jarod disk (electron/data-root.ts, electron/data-disk.ts): where Jarod-OS keeps its data, and moving it.
  dataDiskState: 'jarod-os:data-disk:state',
  dataDiskDrives: 'jarod-os:data-disk:drives',
  /** Make a folder the Jarod disk (copying the data in when asked), then restart. */
  dataDiskApply: 'jarod-os:data-disk:apply',
  // Backups on the Jarod disk (electron/backups.ts, electron/ipc/backups.ts).
  backupsState: 'jarod-os:backups:state',
  backupsCreate: 'jarod-os:backups:create',
  backupsSettings: 'jarod-os:backups:settings',
  backupsRemove: 'jarod-os:backups:remove',
  /** Put a backup back (the current state is kept aside), then restart. */
  backupsRestore: 'jarod-os:backups:restore',
  // Sandboxes on the Jarod disk (electron/sandboxes.ts, electron/ipc/sandboxes.ts).
  sandboxesState: 'jarod-os:sandboxes:state',
  sandboxesCreate: 'jarod-os:sandboxes:create',
  sandboxesCompare: 'jarod-os:sandboxes:compare',
  sandboxesApply: 'jarod-os:sandboxes:apply',
  sandboxesRemove: 'jarod-os:sandboxes:remove',
  // Environments on the Jarod disk (electron/environments.ts, electron/ipc/environments.ts).
  environmentsState: 'jarod-os:environments:state',
  environmentsCreate: 'jarod-os:environments:create',
  environmentsRemove: 'jarod-os:environments:remove',
  // WSL machines and the Jarod disk (electron/vms.ts, electron/ipc/vms.ts).
  vmsState: 'jarod-os:vms:state',
  vmsOnline: 'jarod-os:vms:online',
  vmsCreate: 'jarod-os:vms:create',
  vmsMove: 'jarod-os:vms:move',
  vmsStop: 'jarod-os:vms:stop',
  /** Erase a machine (wsl --unregister): the exact name typed by the person is required. */
  vmsRemove: 'jarod-os:vms:remove',
  // Engines (shared/engines.ts, electron/ipc/engines.ts): the list, the cockpit's engine (next launch), DSH driven over ACP.
  enginesList: 'jarod-os:engines:list',
  enginesSetPrefs: 'jarod-os:engines:set-prefs',
  enginesRelaunch: 'jarod-os:engines:relaunch',
  enginesChanged: 'jarod-os:engines:changed',
  enginesEvent: 'jarod-os:engines:event',
  enginesDshStart: 'jarod-os:engines:dsh:start',
  enginesDshStop: 'jarod-os:engines:dsh:stop',
  enginesDshNewSession: 'jarod-os:engines:dsh:new-session',
  enginesDshSessions: 'jarod-os:engines:dsh:sessions',
  enginesDshResume: 'jarod-os:engines:dsh:resume',
  enginesDshPrompt: 'jarod-os:engines:dsh:prompt',
  enginesDshCancel: 'jarod-os:engines:dsh:cancel',
  enginesDshApprove: 'jarod-os:engines:dsh:approve',
  // The Internet switch (shared/network-policy.ts, electron/network.ts).
  networkGet: 'jarod-os:network:get',
  networkSet: 'jarod-os:network:set',
  networkChanged: 'jarod-os:network:changed',
  // Remote machines (electron/remote-machines.ts, electron/ipc/remote-machines.ts).
  remoteTailscale: 'jarod-os:remote:tailscale',
  remoteProbe: 'jarod-os:remote:probe',
  remoteScanKeys: 'jarod-os:remote:scan-keys',
  remoteTrustKeys: 'jarod-os:remote:trust-keys',
  remoteSyncHosts: 'jarod-os:remote:sync-hosts',
  // Update checks (electron/updates-check.ts).
  updatesState: 'jarod-os:updates:state',
  updatesCheck: 'jarod-os:updates:check',
  updatesOpenWindowsUpdate: 'jarod-os:updates:open-windows-update',
  updatesPrepareUpgrade: 'jarod-os:updates:prepare-upgrade',
  updatesUpgrade: 'jarod-os:updates:upgrade',
  updatesProgress: 'jarod-os:updates:progress',
  // External backups (electron/external-backup.ts, electron/ipc/external-backup.ts).
  externalBackupState: 'jarod-os:external-backup:state',
  externalBackupEstimate: 'jarod-os:external-backup:estimate',
  externalBackupCheck: 'jarod-os:external-backup:check',
  externalBackupChoose: 'jarod-os:external-backup:choose',
  externalBackupSetDestination: 'jarod-os:external-backup:set-destination',
  externalBackupSetOptions: 'jarod-os:external-backup:set-options',
  externalBackupRun: 'jarod-os:external-backup:run',
  externalBackupCancel: 'jarod-os:external-backup:cancel',
  externalBackupRestore: 'jarod-os:external-backup:restore',
  // G4 (2026-10-21) : l'archive chiffrée restic sous la sauvegarde externe. Aucun canal ne rend la clé.
  externalBackupResticEnable: 'jarod-os:external-backup:restic-enable',
  externalBackupResticDisable: 'jarod-os:external-backup:restic-disable',
  externalBackupResticSheet: 'jarod-os:external-backup:restic-sheet',
  externalBackupResticList: 'jarod-os:external-backup:restic-list',
  externalBackupResticRestore: 'jarod-os:external-backup:restic-restore',
  externalBackupResticCheck: 'jarod-os:external-backup:restic-check',
  externalBackupProgress: 'jarod-os:external-backup:progress',

  prefsGet: 'jarod-os:prefs:get',
  prefsSet: 'jarod-os:prefs:set',
  prefsChanged: 'jarod-os:prefs:changed',
  // Lot C (2026-10-21) : la mini-fenêtre. La fenêtre principale envoie un RÉSUMÉ (send, gardé par le contrôle d'émetteur) ; le main le
  // valide et le pousse à la mini-fenêtre, qui ne peut que le recevoir (aucun envoi depuis elle).
  miniState: 'jarod-os:mini:state',
  miniPush: 'jarod-os:mini:push',

  bridgePolicyRead: 'jarod-os:bridge:policy-read',
  bridgePolicyWrite: 'jarod-os:bridge:policy-write',
  bridgeAuditRead: 'jarod-os:bridge:audit-read',
  /** V-03 : les deux journaux d'audit que le shell possède, en lignes brutes (vue unique des journaux). */
  auditJournalsRead: 'jarod-os:audit:journals-read',

  envInfo: 'jarod-os:env:info',

  // OS control: main asks the Hermes window to run a registry command (from the control socket /
  // the agent's os_ui tool) and the window replies.
  osControlRequest: 'jarod-os:os-control:request',
  osControlReply: 'jarod-os:os-control:reply',
  /** Renderer -> main: this window asks for one registry command (the gate decides, then the bridge runs it). */
  controlRun: 'jarod-os:control:run',

  // Voice: microphone permission, tokenized audio WebSocket URLs, the global hotkey.
  voiceRequestMicrophone: 'jarod-os:voice:request-microphone',
  voiceMicrophoneStatus: 'jarod-os:voice:microphone-status',
  voiceAudioWsUrl: 'jarod-os:voice:audio-ws-url',
  /** Main -> renderer: the global voice hotkey was pressed. */
  voiceHotkey: 'jarod-os:voice:hotkey',

  // Panels mode: surfaces, cross-window relay, compositor state.
  shellOpen: 'jarod-os:shell:open',
  shellClose: 'jarod-os:shell:close',
  shellRelay: 'jarod-os:shell:relay',
  shellCommand: 'jarod-os:shell:command',
  shellResize: 'jarod-os:shell:resize',
  shellWallpaperFrame: 'jarod-os:shell:wallpaper-frame',
  wmGetState: 'jarod-os:wm:get-state',
  wmState: 'jarod-os:wm:state',
  wmAction: 'jarod-os:wm:action',

  // Phase 2: system services reachable from any surface.
  /** Run a `herald-os` CLI command (install, reminder, notice, ocr, …); resolves with its output. */
  shellJarodOs: 'jarod-os:shell:herald-os',
  menuExtensions: 'jarod-os:menu:extensions',
  menuExtensionRun: 'jarod-os:menu:extension-run',
  brandingGet: 'jarod-os:branding:get',
  brandingSet: 'jarod-os:branding:set',
  brandingChanged: 'jarod-os:branding:changed',
  /** Power actions: suspend | reboot | poweroff | logout | lock. */
  shellPower: 'jarod-os:shell:power',
  /** Clipboard history (cliphist): list entries / paste one back to the clipboard. */
  clipboardHistory: 'jarod-os:clipboard:history',
  clipboardPaste: 'jarod-os:clipboard:paste',
  /** Desktop notifications from other apps (org.freedesktop.Notifications), pushed to the Hermes window. */
  notificationsIncoming: 'jarod-os:notifications:incoming',
  notificationsAction: 'jarod-os:notifications:action'
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

export interface JarodOsResult {
  code: number
  stdout: string
  stderr: string
}

/**
 * Lot C (2026-10-21, inspiré de Coucou, concepts seulement) : ce que la mini-fenêtre affiche. Un résumé borné — jamais un message, une
 * commande complète ou un secret : des titres et des phrases coupées, des nombres.
 */
export interface MiniSummary {
  /** Les conversations où Jarod répond (au plus 3), et leur nombre total. */
  working: { title: string; status: string }[]
  workingCount: number
  /** Ce qui attend une réponse de l'utilisateur (au plus 3), et leur nombre total. */
  waiting: { kind: 'approval' | 'clarify' | 'sudo' | 'secret'; text: string }[]
  waitingCount: number
  /** Sous-agents en cours. */
  agents: number
}
