import { describe, expect, it } from 'vitest'
import { keyboardOpen, tallestAt } from './viewport.ts'

describe('rotation', () => {
  it('keeps the tallest height at the same width', () => {
    let s = tallestAt({ width: 0, tallest: 0 }, 360, 804)
    s = tallestAt(s, 360, 476)
    expect(s).toEqual({ width: 360, tallest: 804 })
    expect(keyboardOpen(s.tallest, 476)).toBe(true)
  })

  it('starts again when the width changes, so landscape is not read as a keyboard', () => {
    let s = tallestAt({ width: 0, tallest: 0 }, 360, 804)
    s = tallestAt(s, 804, 360)
    expect(s).toEqual({ width: 804, tallest: 360 })
    expect(keyboardOpen(s.tallest, 360)).toBe(false)
  })
})

describe('keyboard detection', () => {
  it('sees the keyboard when the visible height shrinks a lot', () => {
    expect(keyboardOpen(804, 476)).toBe(true)
  })

  it('ignores the small changes of the system bars', () => {
    expect(keyboardOpen(804, 760)).toBe(false)
    expect(keyboardOpen(804, 804)).toBe(false)
  })

  it('sees it closed again', () => {
    expect(keyboardOpen(804, 804)).toBe(false)
  })
})
