import type { KeyValue } from './pairing-store.ts'

/** How long the app may stay in the background before it locks itself (the device key leaves memory). */
export const LOCK_CHOICES = [
  { ms: 60_000, label: '1 minute' },
  { ms: 5 * 60_000, label: '5 minutes' },
  { ms: 15 * 60_000, label: '15 minutes' },
  { ms: 0, label: 'Jamais' }
] as const

/** 0 means never. */
export type LockDelay = (typeof LOCK_CHOICES)[number]['ms']

export const DEFAULT_LOCK_DELAY: LockDelay = 5 * 60_000

const KEY = 'jarod.lockDelay'

export function loadLockDelay(store: KeyValue = localStorage): LockDelay {
  try {
    const v = Number(store.getItem(KEY))
    return LOCK_CHOICES.some(c => c.ms === v) && store.getItem(KEY) !== null ? (v as LockDelay) : DEFAULT_LOCK_DELAY
  } catch {
    return DEFAULT_LOCK_DELAY
  }
}

export function saveLockDelay(ms: LockDelay, store: KeyValue = localStorage): void {
  try {
    store.setItem(KEY, String(ms))
  } catch {
    // Storage refused: the choice lasts until the app closes.
  }
}

/** Whether being away for `awayMs` locks the app under this delay. */
export const shouldLock = (awayMs: number, delay: LockDelay): boolean => delay !== 0 && awayMs > delay

/** "Verrouillé après 5 minutes d’absence." */
export function lockNotice(delay: LockDelay): string {
  const label = LOCK_CHOICES.find(c => c.ms === delay)?.label ?? ''
  return `Verrouillé après ${label.toLowerCase()} d’absence.`
}
