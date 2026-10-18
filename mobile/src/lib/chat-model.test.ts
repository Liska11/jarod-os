import { describe, expect, it } from 'vitest'
import { applyEvent, type Conversation, describeArgs, fromHistory } from './chat-model.ts'
import { addressOrder, forgetPc, loadPc, type PairedPc, savePc } from './pairing-store.ts'

const S = 'session-1'
const run = (events: Record<string, unknown>[], start: Conversation = { sessionId: S, lines: [], running: false }) =>
  events.reduce(applyEvent, start)

describe('conversation on the phone', () => {
  it('builds the history from what was said, tool traffic reduced to its name', () => {
    const c = fromHistory(S, [
      { id: '1', role: 'user', content: 'Bonjour' },
      { id: '2', role: 'assistant', content: '' },
      { id: '3', role: 'tool', content: 'sortie', toolName: 'read_file' },
      { id: '4', role: 'tool', content: 'bruit' },
      { id: '5', role: 'assistant', content: 'Voilà.' }
    ])
    expect(c.lines.map(l => [l.role, l.text])).toEqual([
      ['user', 'Bonjour'],
      ['tool', 'read_file'],
      ['assistant', 'Voilà.']
    ])
  })

  it('streams a reply as it is written, then keeps the finished message', () => {
    const c = run([
      { type: 'message', sessionId: S, message: { id: 'u', role: 'user', content: 'Salut' } },
      { type: 'stream-start', sessionId: S, streamId: 'a' },
      { type: 'delta', sessionId: S, streamId: 'a', text: 'Bon' },
      { type: 'delta', sessionId: S, streamId: 'a', text: 'jour' }
    ])
    expect(c.running).toBe(true)
    expect(c.lines.at(-1)).toMatchObject({ role: 'assistant', text: 'Bonjour', streaming: true })
    const done = run(
      [
        { type: 'message', sessionId: S, streamId: 'a', message: { id: 'm', role: 'assistant', content: 'Bonjour !' } },
        { type: 'done', sessionId: S }
      ],
      c
    )
    expect(done.running).toBe(false)
    expect(done.lines.map(l => [l.id, l.text, Boolean(l.streaming)])).toEqual([
      ['u', 'Salut', false],
      ['m', 'Bonjour !', false]
    ])
  })

  it('shows tools and errors, and ignores other conversations', () => {
    const c = run([
      { type: 'tool-start', sessionId: S, call: { id: 't', name: 'remote_exec' } },
      { type: 'delta', sessionId: 'autre', streamId: 'z', text: 'pas ici' },
      { type: 'error', sessionId: S, error: 'Aucun fournisseur configuré' }
    ])
    expect(c.lines.map(l => [l.role, l.text])).toEqual([
      ['tool', 'remote_exec'],
      ['error', 'Aucun fournisseur configuré']
    ])
    expect(c.running).toBe(false)
  })

  it('a reset stream starts again from nothing', () => {
    const c = run([
      { type: 'delta', sessionId: S, streamId: 'a', text: 'brouillon' },
      { type: 'stream-reset', sessionId: S, streamId: 'a' },
      { type: 'delta', sessionId: S, streamId: 'a', text: 'net' }
    ])
    expect(c.lines.at(-1)!.text).toBe('net')
  })

  it('shortens long arguments but says how much is missing', () => {
    expect(describeArgs({ command: 'dir' })).toContain('"command": "dir"')
    const long = describeArgs('x'.repeat(700), 600)
    expect(long).toContain('100 caractères de plus')
  })
})

describe('the paired PC on the phone', () => {
  const mem = () => {
    const m = new Map<string, string>()
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) }
  }
  const pc: PairedPc = { v: 1, hostId: 'h', hostKey: 'k', name: 'PC', urls: ['http://a', 'http://b'], wrappedKey: 'w', deviceName: 'Pixel', pairedAt: 1, watch: true }

  it('saves, loads and forgets it; refuses a broken record', () => {
    const s = mem()
    expect(loadPc(s)).toBeNull()
    savePc(pc, s)
    expect(loadPc(s)).toEqual(pc)
    forgetPc(s)
    expect(loadPc(s)).toBeNull()
    s.setItem('jarod.pairedPc', '{"v":1,"hostKey":"k"}')
    expect(loadPc(s)).toBeNull()
    s.setItem('jarod.pairedPc', 'pas du json')
    expect(loadPc(s)).toBeNull()
  })

  it('tries the address that worked last first', () => {
    expect(addressOrder(pc)).toEqual(['http://a', 'http://b'])
    expect(addressOrder({ ...pc, lastUrl: 'http://b' })).toEqual(['http://b', 'http://a'])
    expect(addressOrder({ ...pc, lastUrl: 'http://gone' })).toEqual(['http://a', 'http://b'])
  })
})
