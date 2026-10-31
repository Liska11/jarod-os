import { describe, expect, it } from 'vitest'
import { ago, digestText, toggled } from './notif-digest.ts'

const NOW = 1_000_000_000_000

describe('ago', () => {
  it('says how long ago, in French', () => {
    expect(ago(NOW - 10_000, NOW)).toBe('à l’instant')
    expect(ago(NOW - 5 * 60_000, NOW)).toBe('il y a 5 min')
    expect(ago(NOW - 3 * 3_600_000, NOW)).toBe('il y a 3 h')
    expect(ago(NOW - 49 * 3_600_000, NOW)).toBe('il y a 2 j')
  })
  it('never goes negative when the clock is behind', () => {
    expect(ago(NOW + 60_000, NOW)).toBe('à l’instant')
  })
})

describe('digestText', () => {
  it('is empty when there is nothing', () => {
    expect(digestText([], NOW)).toBe('')
  })
  it('lists one line per notification, in the order given', () => {
    const out = digestText(
      [
        { app: 'Messages', title: 'Léa', text: 'On mange à 20 h ?', when: NOW - 2 * 60_000 },
        { app: 'Banque', title: '', text: '', when: NOW - 3_600_000 }
      ],
      NOW
    )
    expect(out).toContain('- Messages (il y a 2 min) : Léa : On mange à 20 h ?')
    expect(out).toContain('- Banque (il y a 1 h) : sans texte')
    expect(out.split('\n')).toHaveLength(3)
  })
})

describe('toggled', () => {
  it('adds once and removes', () => {
    expect(toggled(['a'], 'b', true)).toEqual(['a', 'b'])
    expect(toggled(['a', 'b'], 'b', true)).toEqual(['a', 'b'])
    expect(toggled(['a', 'b'], 'a', false)).toEqual(['b'])
    expect(toggled([], 'a', false)).toEqual([])
  })
})
