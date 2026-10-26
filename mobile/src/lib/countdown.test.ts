import { describe, expect, it } from 'vitest'
import { formatCountdown, fractionLeft, secondsLeft } from './countdown.ts'

describe('countdown', () => {
  it('counts whole seconds up, and stops at zero', () => {
    expect(secondsLeft(10_500, 10_000)).toBe(1)
    expect(secondsLeft(11_000, 10_000)).toBe(1)
    expect(secondsLeft(10_000, 10_000)).toBe(0)
    expect(secondsLeft(9_000, 10_000)).toBe(0)
  })

  it('writes minutes and seconds', () => {
    expect(formatCountdown(247)).toBe('4:07')
    expect(formatCountdown(9)).toBe('0:09')
    expect(formatCountdown(0)).toBe('0:00')
    expect(formatCountdown(-4)).toBe('0:00')
    expect(formatCountdown(3725)).toBe('1:02:05')
  })

  it('gives the share left for the ring', () => {
    expect(fractionLeft(200, 100, 150)).toBe(0.5)
    expect(fractionLeft(200, 100, 250)).toBe(0)
    expect(fractionLeft(200, 100, 50)).toBe(1)
    expect(fractionLeft(100, 100, 100)).toBe(1)
  })
})
