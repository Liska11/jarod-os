import { beforeEach, describe, expect, it, vi } from 'vitest'

const calls: Array<{ method: string; params: Record<string, unknown> }> = []
let fail = false

vi.mock('./gateway.ts', () => ({
  gatewayCall: vi.fn(async (method: string, params: Record<string, unknown>) => {
    calls.push({ method, params })

    if (fail) {
      throw new Error('Not available in this version')
    }

    return {}
  })
}))

function stubStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  vi.stubGlobal('localStorage', { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) })

  return data
}

async function load(initial: Record<string, string> = {}) {
  vi.resetModules()
  const storage = stubStorage(initial)
  const mod = await import('./pinned-sessions.ts')

  return { ...mod, storage }
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

beforeEach(() => {
  calls.length = 0
  fail = false
})

describe('togglePinned', () => {
  it('changes the rail at once and tells the core', async () => {
    const { $pinnedSessions, togglePinned, storage } = await load()

    togglePinned('a')
    expect([...$pinnedSessions.get()]).toEqual(['a'])
    expect(JSON.parse(storage.get('jarod.pinnedSessions') ?? '[]')).toEqual(['a'])
    togglePinned('a')
    expect([...$pinnedSessions.get()]).toEqual([])
    await flush()
    expect(calls.map(c => c.params)).toEqual([
      { session_id: 'a', pinned: true },
      { session_id: 'a', pinned: false }
    ])
  })

  it('keeps the pin here when the core cannot take it', async () => {
    fail = true
    const { $pinnedSessions, togglePinned } = await load()

    togglePinned('a')
    await flush()
    expect([...$pinnedSessions.get()]).toEqual(['a'])
  })
})

describe('adoptServerPins', () => {
  it('takes what the core reports as the truth', async () => {
    const { $pinnedSessions, adoptServerPins } = await load({ 'jarod.pinnedSessions': '["x"]', 'jarod.pinnedSessions.sent': '1' })

    adoptServerPins([
      { id: 'x', pinned: false },
      { id: 'y', pinned: true }
    ])
    expect([...$pinnedSessions.get()]).toEqual(['y'])
  })

  it('does nothing with a core that does not report pins', async () => {
    const { $pinnedSessions, adoptServerPins } = await load({ 'jarod.pinnedSessions': '["x"]' })

    adoptServerPins([{ id: 'x' }, { id: 'y' }])
    expect([...$pinnedSessions.get()]).toEqual(['x'])
    expect(calls).toEqual([])
  })

  it('sends the pins made before the core kept them, once', async () => {
    const { $pinnedSessions, adoptServerPins, storage } = await load({ 'jarod.pinnedSessions': '["old","gone"]' })

    adoptServerPins([
      { id: 'old', pinned: false },
      { id: 'other', pinned: true }
    ])
    await flush()
    expect(calls.map(c => c.params)).toEqual([{ session_id: 'old', pinned: true }])
    expect([...$pinnedSessions.get()].sort()).toEqual(['old', 'other'])
    expect(storage.get('jarod.pinnedSessions.sent')).toBe('1')

    calls.length = 0
    adoptServerPins([{ id: 'old', pinned: true }])
    await flush()
    expect(calls).toEqual([])
  })

  it('a list that arrives while a change is on its way does not undo it', async () => {
    const { $pinnedSessions, adoptServerPins, togglePinned } = await load({ 'jarod.pinnedSessions.sent': '1' })

    togglePinned('a')
    adoptServerPins([{ id: 'a', pinned: false }])
    expect([...$pinnedSessions.get()]).toEqual(['a'])
    await flush()
    adoptServerPins([{ id: 'a', pinned: false }])
    expect([...$pinnedSessions.get()]).toEqual([])
  })
})
