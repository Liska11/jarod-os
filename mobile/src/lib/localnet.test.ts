import { describe, expect, it } from 'vitest'
import { describeLocalNet, loadExplained, loadRefused, noteAnswer, saveExplained, shouldExplain } from './localnet.ts'

const memory = () => {
  const m = new Map<string, string>()
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) }
}

describe('when to explain the local network permission', () => {
  it('explains once, and only while the phone would still ask', () => {
    expect(shouldExplain('prompt', false)).toBe(true)
    expect(shouldExplain('prompt', true)).toBe(false)
    expect(shouldExplain('granted', false)).toBe(false)
    expect(shouldExplain('denied', false)).toBe(false) // refused: Diagnostic tells, no second sheet
    expect(shouldExplain('unneeded', false)).toBe(false)
  })

  it('remembers that the explanation was shown', () => {
    const store = memory()
    expect(loadExplained(store)).toBe(false)
    saveExplained(store)
    expect(loadExplained(store)).toBe(true)
  })
})

describe('remembering a refusal', () => {
  it('keeps it after a no, even while Android would ask again, and forgets it once granted', () => {
    const store = memory()
    expect(loadRefused(store)).toBe(false)
    noteAnswer('prompt', store) // the dialog was answered "no" once: Android still says "can ask"
    expect(loadRefused(store)).toBe(true)
    noteAnswer('denied', store)
    expect(loadRefused(store)).toBe(true)
    noteAnswer('granted', store)
    expect(loadRefused(store)).toBe(false)
  })
})

describe('what Diagnostic says about it', () => {
  it('says it is fine when granted, or not needed on this Android', () => {
    expect(describeLocalNet('granted').tone).toBe('ok')
    expect(describeLocalNet('unneeded').tone).toBe('ok')
    expect(describeLocalNet('unneeded').text).toMatch(/avant la 13|pas besoin/i)
  })

  it('says clearly what a refusal costs, and what still works', () => {
    const d = describeLocalNet('denied')
    expect(d.tone).toBe('warn')
    expect(d.title).toMatch(/refus/i)
    expect(d.text).toMatch(/réseau local|Wi-Fi/i)
    expect(d.text).toMatch(/Tailscale/)
    expect(d.actions).toEqual(['settings'])
  })

  it('says "refused" after one no, and still lets the owner try again', () => {
    const d = describeLocalNet('prompt', true)
    expect(d.tone).toBe('warn')
    expect(d.title).toMatch(/refus/i)
    expect(d.actions).toEqual(['ask', 'settings'])
  })

  it('offers to ask when it has not been asked yet', () => {
    const d = describeLocalNet('prompt', false)
    expect(d.tone).toBe('neutral')
    expect(d.actions).toEqual(['ask'])
  })

  it('has no action when nothing is to be done', () => {
    expect(describeLocalNet('granted').actions).toEqual([])
    expect(describeLocalNet('unneeded').actions).toEqual([])
  })
})
