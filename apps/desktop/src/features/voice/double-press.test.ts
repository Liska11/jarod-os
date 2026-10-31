import { describe, expect, it, vi } from 'vitest'
import { createDoublePress } from './double-press.ts'

describe('createDoublePress', () => {
  it('one press runs the single action once the window has passed, and not before', () => {
    vi.useFakeTimers()
    const single = vi.fn()
    const double = vi.fn()
    const p = createDoublePress(single, double, 300)

    p.press()
    vi.advanceTimersByTime(299)
    expect(single).not.toHaveBeenCalled()
    vi.advanceTimersByTime(2)
    expect(single).toHaveBeenCalledOnce()
    expect(double).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('two presses inside the window run the double action only', () => {
    vi.useFakeTimers()
    const single = vi.fn()
    const double = vi.fn()
    const p = createDoublePress(single, double, 300)

    p.press()
    vi.advanceTimersByTime(150)
    p.press()
    vi.advanceTimersByTime(1000)
    expect(double).toHaveBeenCalledOnce()
    expect(single).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('a second press after the window is a new single press; cancel forgets a pending one', () => {
    vi.useFakeTimers()
    const single = vi.fn()
    const double = vi.fn()
    const p = createDoublePress(single, double, 300)

    p.press()
    vi.advanceTimersByTime(400)
    p.press()
    vi.advanceTimersByTime(400)
    expect(single).toHaveBeenCalledTimes(2)
    expect(double).not.toHaveBeenCalled()
    p.press()
    p.cancel()
    vi.advanceTimersByTime(1000)
    expect(single).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })
})

describe('createDoublePress.double', () => {
  it('runs the double action at once and forgets a pending single press', () => {
    vi.useFakeTimers()
    const single = vi.fn()
    const double = vi.fn()
    const p = createDoublePress(single, double, 300)

    p.press()
    p.double()
    vi.advanceTimersByTime(1000)
    expect(double).toHaveBeenCalledOnce()
    expect(single).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('after the single action already ran, a browser-counted second click does nothing', () => {
    vi.useFakeTimers()
    const single = vi.fn()
    const double = vi.fn()
    const p = createDoublePress(single, double, 500)

    p.press()
    // The window elapses: dictation starts. The browser still counts the next click as detail=2 for its own (longer) double-click time.
    vi.advanceTimersByTime(500)
    expect(single).toHaveBeenCalledOnce()
    p.double()
    vi.advanceTimersByTime(1000)
    expect(double).not.toHaveBeenCalled()
    vi.useRealTimers()
  })
})
