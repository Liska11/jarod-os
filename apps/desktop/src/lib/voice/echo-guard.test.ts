import { describe, expect, it } from 'vitest'
import { ECHO_GUARD, EchoGuard } from './echo-guard.ts'

describe('EchoGuard', () => {
  it('trips on the third empty interruption within a minute, not before', () => {
    const guard = new EchoGuard()

    expect(guard.emptyBargeIn(0)).toBe(false)
    expect(guard.emptyBargeIn(10_000)).toBe(false)
    expect(guard.tripped).toBe(false)
    expect(guard.emptyBargeIn(20_000)).toBe(true)
    expect(guard.tripped).toBe(true)
  })

  it('uses the documented thresholds', () => {
    expect(ECHO_GUARD).toEqual({ threshold: 3, windowMs: 60_000 })
  })

  it('forgets interruptions older than the window', () => {
    const guard = new EchoGuard()

    guard.emptyBargeIn(0)
    guard.emptyBargeIn(30_000)
    // The first one is now 60 s old: only two remain in the window.
    expect(guard.emptyBargeIn(60_000)).toBe(false)
    expect(guard.pending).toBe(2)
    expect(guard.emptyBargeIn(70_000)).toBe(true)
  })

  it('starts over after an interruption that held real words', () => {
    const guard = new EchoGuard()

    guard.emptyBargeIn(0)
    guard.emptyBargeIn(1_000)
    guard.heardBargeIn()
    expect(guard.pending).toBe(0)
    expect(guard.emptyBargeIn(2_000)).toBe(false)
    expect(guard.emptyBargeIn(3_000)).toBe(false)
    expect(guard.emptyBargeIn(4_000)).toBe(true)
  })

  it('trips only once per run: no repeated prompts, whatever follows', () => {
    const guard = new EchoGuard()

    for (const at of [0, 1_000, 2_000]) guard.emptyBargeIn(at)
    const later = [3_000, 4_000, 5_000, 120_000, 121_000, 122_000].map(at => guard.emptyBargeIn(at))
    guard.heardBargeIn()
    const afterSpeech = [200_000, 201_000, 202_000].map(at => guard.emptyBargeIn(at))

    expect([...later, ...afterSpeech].some(Boolean)).toBe(false)
    expect(guard.tripped).toBe(true)
  })

  it('takes custom thresholds', () => {
    const guard = new EchoGuard({ threshold: 2, windowMs: 5_000 })

    expect(guard.emptyBargeIn(0)).toBe(false)
    expect(guard.emptyBargeIn(6_000)).toBe(false)
    expect(guard.emptyBargeIn(7_000)).toBe(true)
  })
})
