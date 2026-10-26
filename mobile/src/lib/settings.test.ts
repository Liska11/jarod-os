import { describe, expect, it } from 'vitest'
import { DEFAULT_LOCK_DELAY, loadLockDelay, lockNotice, saveLockDelay, shouldLock } from './settings.ts'

const memory = () => {
  const m = new Map<string, string>()
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) }
}

describe('lock delay', () => {
  it('is 5 minutes until chosen, as before', () => {
    expect(loadLockDelay(memory())).toBe(5 * 60_000)
    expect(DEFAULT_LOCK_DELAY).toBe(5 * 60_000)
  })

  it('keeps one of the four choices, and never anything else', () => {
    const store = memory()
    for (const ms of [60_000, 15 * 60_000, 0] as const) {
      saveLockDelay(ms, store)
      expect(loadLockDelay(store)).toBe(ms)
    }
    store.setItem('jarod.lockDelay', '1234')
    expect(loadLockDelay(store)).toBe(DEFAULT_LOCK_DELAY)
    store.setItem('jarod.lockDelay', 'abc')
    expect(loadLockDelay(store)).toBe(DEFAULT_LOCK_DELAY)
  })

  it('locks only after the delay, and never with "jamais"', () => {
    expect(shouldLock(59_000, 60_000)).toBe(false)
    expect(shouldLock(61_000, 60_000)).toBe(true)
    expect(shouldLock(10 * 3_600_000, 0)).toBe(false)
  })

  it('says why it locked', () => {
    expect(lockNotice(5 * 60_000)).toBe('Verrouillé après 5 minutes d’absence.')
    expect(lockNotice(60_000)).toBe('Verrouillé après 1 minute d’absence.')
  })
})
