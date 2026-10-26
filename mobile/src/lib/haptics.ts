import type { KeyValue } from './pairing-store.ts'

const KEY = 'jarod.haptics'

export function loadHaptics(store: KeyValue = localStorage): boolean {
  try {
    return store.getItem(KEY) !== '0'
  } catch {
    return true
  }
}

export function saveHaptics(on: boolean, store: KeyValue = localStorage): void {
  try {
    store.setItem(KEY, on ? '1' : '0')
  } catch {
    // Storage refused: the choice lasts until the app closes.
  }
}

export type Feel = 'tap' | 'confirm' | 'warn'

const PATTERNS: Record<Feel, number | number[]> = { tap: 8, confirm: 18, warn: [24, 50, 24] }

let enabled = loadHaptics()

export function setHapticsEnabled(on: boolean): void {
  enabled = on
}

/** A short buzz for the actions that matter (sending, deciding, copying). Silent where the phone cannot. */
export function haptic(feel: Feel = 'tap'): void {
  if (!enabled) return
  try {
    navigator.vibrate?.(PATTERNS[feel])
  } catch {
    // No vibrator, or not allowed.
  }
}
