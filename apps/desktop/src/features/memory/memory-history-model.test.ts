import { describe, expect, it } from 'vitest'
import { describeChange, type MemoryChange, wordDiff } from './memory-history-model.ts'

const join = (parts: { kind: string; text: string }[], keep: 'before' | 'after') => parts.filter(p => p.kind === 'same' || p.kind === (keep === 'before' ? 'del' : 'add')).map(p => p.text).join('')

describe('wordDiff (V-18)', () => {
  it('marks only the words that changed, and rebuilds both texts exactly', () => {
    const parts = wordDiff('Le dépôt est sur C: depuis hier', 'Le dépôt est sur D: depuis hier')

    expect(parts).toEqual([
      { kind: 'same', text: 'Le dépôt est sur ' },
      { kind: 'del', text: 'C:' },
      { kind: 'add', text: 'D:' },
      { kind: 'same', text: ' depuis hier' }
    ])
    expect(join(parts, 'before')).toBe('Le dépôt est sur C: depuis hier')
    expect(join(parts, 'after')).toBe('Le dépôt est sur D: depuis hier')
  })

  it('handles empty texts and identical texts', () => {
    expect(wordDiff('', 'nouveau')).toEqual([{ kind: 'add', text: 'nouveau' }])
    expect(wordDiff('ancien', '')).toEqual([{ kind: 'del', text: 'ancien' }])
    expect(wordDiff('même texte', 'même texte')).toEqual([{ kind: 'same', text: 'même texte' }])
  })

  it('gives up word by word on huge texts, still showing both versions', () => {
    const big = Array.from({ length: 600 }, (_, i) => `w${i}`).join(' ')
    const parts = wordDiff(big, `${big} fin`)

    expect(parts.map(p => p.kind)).toEqual(['del', 'add'])
  })
})

describe('describeChange (V-18)', () => {
  const change = (over: Partial<MemoryChange>): MemoryChange => ({ seq: 1, memoryId: 'm', action: 'update', at: 0, ...over })

  it('an addition shows the new text, a removal the old one', () => {
    expect(describeChange(change({ action: 'add', after: { type: 'fact', content: 'A' } })).parts).toEqual([{ kind: 'add', text: 'A' }])
    expect(describeChange(change({ action: 'delete', before: { type: 'fact', content: 'A' } })).parts).toEqual([{ kind: 'del', text: 'A' }])
  })

  it('an edit shows the word diff, and says when the type changed', () => {
    const d = describeChange(change({ before: { type: 'fact', content: 'A B' }, after: { type: 'preference', content: 'A C' } }))

    expect(d.typeChange).toEqual({ from: 'fact', to: 'preference' })
    expect(d.parts.map(p => p.kind)).toEqual(['same', 'del', 'add'])
    expect(describeChange(change({ before: { type: 'fact', content: 'A' }, after: { type: 'fact', content: 'B' } })).typeChange).toBeNull()
  })
})
