import { describe, expect, it } from 'vitest'
import { contextView, tokenCount } from './context-meter.ts'

describe('tokenCount', () => {
  it('reads like a person would', () => {
    expect(tokenCount(950)).toBe('950')
    expect(tokenCount(8200)).toBe('8.2k')
    expect(tokenCount(16384)).toBe('16.4k')
    expect(tokenCount(32768)).toBe('32.8k')
  })
})

describe('contextView', () => {
  it('has nothing to show before the first reply', () => {
    expect(contextView(null)).toMatchObject({ label: 'Context', percent: null, tone: 'unknown', full: false })
    expect(contextView({ context_used: null })).toMatchObject({ percent: null, tone: 'unknown' })
  })

  it('shows the share of the window, and warns as it fills', () => {
    expect(contextView({ context_used: 4096, context_max: 16384 })).toMatchObject({ label: '4.1k / 16.4k', percent: 25, tone: 'ok', full: false })
    expect(contextView({ context_used: 12000, context_max: 16384 })).toMatchObject({ percent: 73.2, tone: 'warn', full: false })
    expect(contextView({ context_used: 14000, context_max: 16384 })).toMatchObject({ percent: 85.4, tone: 'warn', full: true })
    expect(contextView({ context_used: 15800, context_max: 16384 })).toMatchObject({ percent: 96.4, tone: 'danger', full: true })
  })

  it('never goes past full', () => {
    expect(contextView({ context_used: 40000, context_max: 16384 }).percent).toBe(100)
  })

  it('without a known window it counts tokens and never warns', () => {
    expect(contextView({ context_used: 9100, context_max: null })).toMatchObject({ label: '9.1k tokens', percent: null, tone: 'unknown', full: false })
    expect(contextView({ context_used: 9100, context_max: 0 })).toMatchObject({ percent: null })
  })

  it('says when the figure is an estimate and how many times the context was compacted', () => {
    const view = contextView({ context_used: 300, context_max: 16384, context_estimated: true, compressions: 2 })

    expect(view.title).toContain('(estimated)')
    expect(view.title).toContain('Compacted 2 times.')
    expect(contextView({ context_used: 300, context_max: 16384, compressions: 1 }).title).toContain('Compacted 1 time.')
  })
})
