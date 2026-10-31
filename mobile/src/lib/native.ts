import { Capacitor, registerPlugin } from '@capacitor/core'
import type { PowerState } from './diagnostics.ts'
import type { NotifItem } from './notif-digest.ts'
import type { LocalNetState } from './localnet.ts'
import type { SystemColors } from './theme.ts'

/**
 * The device key's safe (native, `DeviceVaultPlugin.java`): an AES-256-GCM key in the Android
 * Keystore that only a fingerprint, a face or the phone's PIN unlocks, for one use at a time.
 */
interface DeviceVaultPlugin {
  status(): Promise<{ available: boolean; reason?: string }>
  seal(o: { plaintext: string; title: string; subtitle?: string }): Promise<{ blob: string }>
  open(o: { blob: string; title: string; subtitle?: string }): Promise<{ plaintext: string }>
  /** A fresh check that the owner is holding the phone (approving an action). */
  confirm(o: { title: string; subtitle?: string; purpose?: 'screen' }): Promise<{ ok: boolean }>
  wipe(): Promise<void>
}

/** The closed app's watch (native, `WakeService.java`): asks the PC "anything new?", shows no content. */
interface WakePlugin {
  /** Also comes back by itself after the phone restarts (`BootReceiver.java`), until stopped. */
  start(o: { urls: string[]; token: string; seq: number; title: string; text: string; notify?: boolean }): Promise<void>
  /** `notify: false` keeps the watch quiet: every kind of notification is off on this phone. */
  /** The PC's addresses changed: the watch uses them from its next round (no restart, same token). */
  setUrls(o: { urls: string[] }): Promise<void>
  configure(o: { notify: boolean }): Promise<void>
  stop(): Promise<void>
  status(): Promise<{ running: boolean }>
}

/** The `jarod://pair#…` link that opened the app, if any (native, `JarodLaunchPlugin.java`). */
interface LaunchPlugin {
  take(): Promise<{ link: string }>
  addListener(event: 'link', fn: (e: { link: string }) => void): Promise<{ remove: () => Promise<void> }>
}

export const isNative = Capacitor.isNativePlatform()

const NativeVault = registerPlugin<DeviceVaultPlugin>('DeviceVault')
const NativeWake = registerPlugin<WakePlugin>('JarodWake')

/**
 * Outside the phone (`npm run dev` in a desktop browser) there is no Keystore: the key is kept as is,
 * and the screen says so. Development only — the APK always uses the native vault.
 */
const devVault: DeviceVaultPlugin = {
  status: async () => ({ available: true, reason: 'dev' }),
  seal: async ({ plaintext }) => ({ blob: `dev:${btoa(plaintext)}` }),
  open: async ({ blob }) => ({ plaintext: atob(blob.replace(/^dev:/, '')) }),
  confirm: async ({ title }) => ({ ok: window.confirm(title) }),
  wipe: async () => {}
}

export const vault: DeviceVaultPlugin = isNative ? NativeVault : devVault

export const wake: WakePlugin = isNative
  ? NativeWake
  : { start: async () => {}, setUrls: async () => {}, configure: async () => {}, stop: async () => {}, status: async () => ({ running: false }) }

/** Reading aloud with the phone's installed voices only (native, `JarodSpeechPlugin.java`). */
export interface SpeechPlugin {
  status(o: { lang: string }): Promise<{ available: boolean; reason?: string }>
  /** One piece of a reply; `flush` for the first piece stops what was being said. */
  speak(o: { text: string; lang: string; flush: boolean }): Promise<void>
  stop(): Promise<void>
  /** `state`: the phone starts or stops speaking (the live conversation's animation). */
  addListener(event: 'state', fn: (e: { speaking: boolean }) => void): Promise<{ remove: () => Promise<void> }>
}

const NativeSpeech = registerPlugin<SpeechPlugin>('JarodSpeech')

/** In a desktop browser (`npm run dev`), the browser's own synthesis stands in. */
const devSpeechListeners = new Set<(e: { speaking: boolean }) => void>()
const devSpeechState = (speaking: boolean) => devSpeechListeners.forEach(fn => fn({ speaking }))
let devLast: SpeechSynthesisUtterance | null = null
const devSpeech: SpeechPlugin = {
  status: async () =>
    'speechSynthesis' in window ? { available: true } : { available: false, reason: 'Pas de synthèse vocale dans ce navigateur.' },
  speak: async ({ text, lang, flush }) => {
    if (flush) speechSynthesis.cancel()
    const u = new SpeechSynthesisUtterance(text)
    u.lang = lang
    devLast = u
    u.onstart = () => devSpeechState(true)
    u.onend = u.onerror = () => devLast === u && devSpeechState(false)
    speechSynthesis.speak(u)
  },
  stop: async () => {
    speechSynthesis.cancel()
    devSpeechState(false)
  },
  addListener: async (_event, fn) => {
    devSpeechListeners.add(fn)
    return { remove: async () => void devSpeechListeners.delete(fn) }
  }
}

export const speech: SpeechPlugin = isNative ? NativeSpeech : devSpeech

/**
 * What the phone's system tells the page (native, `JarodSystemPlugin.java`): the wallpaper's colours
 * (Android 12+), the battery state the app may read, and shortcuts into the system settings.
 */
export interface SystemPlugin {
  colors(): Promise<SystemColors>
  /** The status and navigation bars follow the app's scheme (icon colour everywhere, bar colour before Android 15). */
  setBars(o: { scheme: 'light' | 'dark'; status: string; nav: string }): Promise<void>
  /** Android 16's local network permission ("Nearby devices"): its state, and the system's dialog. */
  localNetwork(): Promise<{ state: LocalNetState }>
  requestLocalNetwork(): Promise<{ state: LocalNetState }>
  power(): Promise<PowerState>
  /** Opens a system settings screen; `via` says which one it was (a fallback is possible). */
  openSettings(o: { target: 'battery-optimization' | 'battery' | 'battery-saver' | 'autostart' | 'app' | 'notifications' | 'assistant' | 'overlay' | 'listener' | 'accessibility' }): Promise<{ opened: boolean; via: string }>
}

const NativeSystem = registerPlugin<SystemPlugin>('JarodSystem')

export const system: SystemPlugin = isNative
  ? NativeSystem
  : {
      colors: async () => ({ supported: false, light: {}, dark: {} }),
      setBars: async () => {},
      localNetwork: async () => ({ state: 'unneeded' as const }),
      requestLocalNetwork: async () => ({ state: 'unneeded' as const }),
      power: async () => ({ ignoringBatteryOptimizations: false, powerSave: false, manufacturer: 'navigateur', model: '', sdk: 0 }),
      openSettings: async () => ({ opened: false, via: 'navigateur' })
    }

const NativeLaunch = registerPlugin<LaunchPlugin>('JarodLaunch')

export const launch: LaunchPlugin = isNative
  ? NativeLaunch
  : { take: async () => ({ link: location.hash.startsWith('#v=2') ? location.hash : '' }), addListener: async () => ({ remove: async () => {} }) }

/**
 * Whether this page runs in the assistant window rather than the app (native,
 * `JarodAssistPlugin.java`), and the way to close that window.
 */
export interface AssistContext {
  hosted: boolean
  /** Which door opened it: "assist" (system gesture), "voice" (voice-assist key), "orb" (the bubble) or "app". */
  source: 'assist' | 'voice' | 'orb' | 'app'
}

/** The floating bubble: allowed = the system lets Jarod draw over other apps; running = it is showing. */
export interface OrbState {
  allowed: boolean
  running: boolean
}

interface AssistPlugin {
  context(): Promise<AssistContext>
  close(): Promise<void>
  orb(): Promise<OrbState>
  /** Shows the bubble; with `allowed: false` nothing started and the owner must grant the permission first. */
  orbStart(): Promise<OrbState>
  orbStop(): Promise<OrbState>
}

const NativeAssist = registerPlugin<AssistPlugin>('JarodAssist')

export const assist: AssistPlugin = isNative ? NativeAssist : { context: async () => ({ hosted: false, source: 'app' as const }), close: async () => {}, orb: async () => ({ allowed: false, running: false }), orbStart: async () => ({ allowed: false, running: false }), orbStop: async () => ({ allowed: false, running: false }) }

/**
 * The showing notifications of the apps the owner ticked, read on request only (native,
 * `JarodNotificationsPlugin.java`). `enabled` is the system's "Notification access" for Jarod.
 */
export interface NotificationsPlugin {
  status(): Promise<{ enabled: boolean; connected: boolean; allowed: string[] }>
  /** Apps with a notification showing now (plus the ticked ones), to tick or untick. */
  apps(): Promise<{ apps: { pkg: string; label: string }[] }>
  setAllowed(o: { packages: string[] }): Promise<void>
  snapshot(o?: { limit?: number }): Promise<{ items: NotifItem[] }>
}

const NativeNotifications = registerPlugin<NotificationsPlugin>('JarodNotifications')

export const notifications: NotificationsPlugin = isNative
  ? NativeNotifications
  : { status: async () => ({ enabled: false, connected: false, allowed: [] }), apps: async () => ({ apps: [] }), setAllowed: async () => {}, snapshot: async () => ({ items: [] }) }

/**
 * Reads the screen of the app behind the assistant, on request (native, `JarodAccessibilityPlugin.java`).
 * Every call is preceded by `vault.confirm`: the owner's fingerprint, face or code, each time.
 */
export interface AccessibilityPlugin {
  /** `enabled`: switched on in the system's Accessibility settings; `screenshot`: Android 14 or later. */
  status(): Promise<{ enabled: boolean; connected: boolean; screenshot: boolean }>
  screenText(): Promise<{ text: string }>
  screenshot(): Promise<{ mime: string; data: string }>
}

const NativeAccessibility = registerPlugin<AccessibilityPlugin>('JarodAccessibility')

export const accessibility: AccessibilityPlugin = isNative
  ? NativeAccessibility
  : {
      status: async () => ({ enabled: false, connected: false, screenshot: false }),
      screenText: async () => ({ text: '' }),
      screenshot: async () => ({ mime: 'image/jpeg', data: '' })
    }
