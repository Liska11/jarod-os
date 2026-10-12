import { describe, expect, it } from 'vitest'
import { DEFAULT_SPLIT, dragTo, leftWidth, nudge, parseSplit } from './split.ts'

const LIMITS = { minLeft: 380, minRight: 280, snapRight: 140 }
const TOTAL = 1400

describe('leftWidth', () => {
  it('takes its share of the row, within the minimums', () => {
    expect(leftWidth(TOTAL, { ratio: 0.45, collapsed: false }, LIMITS)).toBe(630)
    expect(leftWidth(TOTAL, { ratio: 0.1, collapsed: false }, LIMITS)).toBe(380)
    expect(leftWidth(TOTAL, { ratio: 0.99, collapsed: false }, LIMITS)).toBe(1120)
  })

  it('takes the whole row when the right pane is hidden', () => {
    expect(leftWidth(TOTAL, { ratio: 0.45, collapsed: true }, LIMITS)).toBe(TOTAL)
  })

  it('shares a row too narrow for both minimums in proportion', () => {
    const left = leftWidth(660, DEFAULT_SPLIT, LIMITS)
    expect(left).toBe(380)
    expect(leftWidth(330, DEFAULT_SPLIT, LIMITS)).toBe(190)
  })
})

describe('dragTo', () => {
  it('follows the pointer between the minimums', () => {
    expect(dragTo(TOTAL, 800, LIMITS)).toEqual({ ratio: 800 / TOTAL, collapsed: false })
    expect(dragTo(TOTAL, 100, LIMITS)).toEqual({ ratio: 380 / TOTAL, collapsed: false })
    expect(dragTo(TOTAL, 1150, LIMITS).ratio).toBe(1120 / TOTAL)
  })

  it('hides the right pane when it is dragged narrower than the snap width', () => {
    expect(dragTo(TOTAL, TOTAL - 139, LIMITS).collapsed).toBe(true)
    expect(dragTo(TOTAL, TOTAL, LIMITS).collapsed).toBe(true)
    expect(dragTo(TOTAL, TOTAL - 141, LIMITS).collapsed).toBe(false)
  })
})

describe('nudge', () => {
  it('moves the divider by the step', () => {
    const next = nudge(TOTAL, { ratio: 0.5, collapsed: false }, 24, LIMITS)
    expect(leftWidth(TOTAL, next, LIMITS)).toBe(724)
  })

  it('brings a hidden right pane back on the way left, and leaves it hidden on the way right', () => {
    const hidden = { ratio: 0.8, collapsed: true }
    expect(nudge(TOTAL, hidden, 24, LIMITS)).toBe(hidden)
    const back = nudge(TOTAL, hidden, -24, LIMITS)
    expect(back.collapsed).toBe(false)
    expect(leftWidth(TOTAL, back, LIMITS)).toBe(1120)
  })
})

describe('parseSplit', () => {
  it('reads what was stored and ignores anything else', () => {
    expect(parseSplit('{"ratio":0.6,"collapsed":true}')).toEqual({ ratio: 0.6, collapsed: true })
    expect(parseSplit(null)).toEqual(DEFAULT_SPLIT)
    expect(parseSplit('not json')).toEqual(DEFAULT_SPLIT)
    expect(parseSplit('{"ratio":3,"collapsed":false}')).toEqual(DEFAULT_SPLIT)
    expect(parseSplit('{"ratio":0.5}')).toEqual(DEFAULT_SPLIT)
  })
})
