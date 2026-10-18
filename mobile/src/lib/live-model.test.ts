import { describe, expect, it } from 'vitest'
import { LIVE_START, type LiveEvent, type LiveState, liveStep, MIN_HOLD_MS } from './live-model.ts'
import { levelOf } from './voice.ts'

const run = (events: LiveEvent[], from: LiveState = LIVE_START) => events.reduce(liveStep, from)
const agent = (data: Record<string, unknown>): LiveEvent => ({ type: 'agent', data })

describe('live conversation', () => {
  it('goes from talking to Jarod speaking, and back to waiting', () => {
    const steps: LiveEvent[] = [
      { type: 'press' },
      { type: 'release', ms: 1800 },
      { type: 'heard', text: ' quelle heure est-il ? ' },
      agent({ type: 'message', message: { role: 'user', content: 'quelle heure est-il ?' } }),
      agent({ type: 'stream-start', streamId: 'a' }),
      agent({ type: 'delta', streamId: 'a', text: 'Il est ' }),
      agent({ type: 'delta', streamId: 'a', text: '15 h.' }),
      agent({ type: 'message', message: { role: 'assistant', content: 'Il est 15 h.' } }),
      agent({ type: 'done' }),
      { type: 'speaking', on: true },
      { type: 'speaking', on: false }
    ]
    const phases = steps.reduce<{ s: LiveState; seen: string[] }>(
      (acc, e) => {
        const s = liveStep(acc.s, e)
        return { s, seen: acc.seen.at(-1) === s.phase ? acc.seen : [...acc.seen, s.phase] }
      },
      { s: LIVE_START, seen: ['idle'] }
    )
    expect(phases.seen).toEqual(['idle', 'listening', 'sending', 'thinking', 'answering', 'reading', 'speaking', 'idle'])
    expect(phases.s.heard).toBe('quelle heure est-il ?')
    expect(phases.s.reply).toBe('Il est 15 h.')
  })

  it('a tap is not a message', () => {
    const s = run([{ type: 'press' }, { type: 'release', ms: MIN_HOLD_MS - 1 }])
    expect(s.phase).toBe('idle')
    expect(s.note).toContain('Maintenez')
  })

  it('says when nothing was heard, and when Jarod fails', () => {
    expect(run([{ type: 'press' }, { type: 'release', ms: 900 }, { type: 'heard', text: '  ' }]).phase).toBe('idle')
    const failed = run([{ type: 'press' }, { type: 'release', ms: 900 }, { type: 'heard', text: 'salut' }, agent({ type: 'error', error: 'Aucun fournisseur' })])
    expect(failed).toMatchObject({ phase: 'error', note: 'Aucun fournisseur' })
    expect(run([{ type: 'fail', message: 'Micro indisponible' }])).toMatchObject({ phase: 'error', note: 'Micro indisponible' })
  })

  it('pressing while Jarod speaks starts listening again, with a clean slate', () => {
    const speaking: LiveState = { phase: 'speaking', heard: 'a', reply: 'b', note: '' }
    expect(liveStep(speaking, { type: 'press' })).toMatchObject({ phase: 'listening', heard: '', reply: '' })
  })

  it('ignores what is not about the current exchange', () => {
    // Events from a run while waiting, or speech from elsewhere, change nothing.
    expect(run([agent({ type: 'delta', text: 'bruit' })]).phase).toBe('idle')
    expect(run([{ type: 'speaking', on: true }]).phase).toBe('idle')
    expect(run([{ type: 'heard', text: 'tard' }]).phase).toBe('idle')
  })

  it('keeps the answer on screen when it cannot be read aloud', () => {
    const reading: LiveState = { phase: 'reading', heard: 'a', reply: 'b', note: '' }
    expect(liveStep(reading, { type: 'silent' })).toMatchObject({ phase: 'idle', reply: 'b' })
  })
})

describe('microphone level', () => {
  it('is 0 for silence and grows with loudness, never above 1', () => {
    expect(levelOf(new Uint8Array(512).fill(128))).toBe(0)
    const soft = levelOf(Uint8Array.from({ length: 512 }, (_, i) => (i % 2 ? 136 : 120)))
    const loud = levelOf(Uint8Array.from({ length: 512 }, (_, i) => (i % 2 ? 200 : 56)))
    expect(soft).toBeGreaterThan(0)
    expect(loud).toBeGreaterThan(soft)
    expect(levelOf(Uint8Array.from({ length: 512 }, (_, i) => (i % 2 ? 255 : 0)))).toBe(1)
    expect(levelOf(new Uint8Array(0))).toBe(0)
  })
})
