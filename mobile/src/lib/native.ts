import { Capacitor, registerPlugin } from '@capacitor/core'

/**
 * The device key's safe (native, `DeviceVaultPlugin.java`): an AES-256-GCM key in the Android
 * Keystore that only a fingerprint, a face or the phone's PIN unlocks, for one use at a time.
 */
interface DeviceVaultPlugin {
  status(): Promise<{ available: boolean; reason?: string }>
  seal(o: { plaintext: string; title: string; subtitle?: string }): Promise<{ blob: string }>
  open(o: { blob: string; title: string; subtitle?: string }): Promise<{ plaintext: string }>
  /** A fresh check that the owner is holding the phone (approving an action). */
  confirm(o: { title: string; subtitle?: string }): Promise<{ ok: boolean }>
  wipe(): Promise<void>
}

/** The closed app's watch (native, `WakeService.java`): asks the PC "anything new?", shows no content. */
interface WakePlugin {
  /** Also comes back by itself after the phone restarts (`BootReceiver.java`), until stopped. */
  start(o: { urls: string[]; token: string; seq: number; title: string; text: string; notify?: boolean }): Promise<void>
  /** `notify: false` keeps the watch quiet: every kind of notification is off on this phone. */
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
  : { start: async () => {}, configure: async () => {}, stop: async () => {}, status: async () => ({ running: false }) }

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

const NativeLaunch = registerPlugin<LaunchPlugin>('JarodLaunch')

export const launch: LaunchPlugin = isNative
  ? NativeLaunch
  : { take: async () => ({ link: location.hash.startsWith('#v=2') ? location.hash : '' }), addListener: async () => ({ remove: async () => {} }) }
