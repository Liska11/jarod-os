import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { $memory, addEntry, buildEntries, forgetEntry, fromRemote, loadMemory, memorySource, type RemoteMemoryFiles, updateEntry } from './memory-store.ts'

interface Call {
  method: string
  path: string
  body?: unknown
}

/** A fake Electron bridge: REST answers come from `routes`, files from `disk`. */
function bridge(routes: Record<string, (call: Call) => unknown>, disk: Record<string, string> = {}) {
  const calls: Call[] = []
  const writes: Record<string, string> = {}
  const rest = vi.fn(async (req: Call) => {
    calls.push(req)
    const route = routes[`${req.method} ${req.path}`]

    if (!route) {
      throw new Error(`GET ${req.path} -> 404`)
    }

    return route(req)
  })

  ;(globalThis as { window?: unknown }).window = {
    heraldOS: {
      backend: { rest },
      fs: {
        readDir: async (dir: string) => Object.keys(disk).filter(p => p.startsWith(dir)).map(p => ({ name: p.slice(dir.length + 1), modifiedAt: 1000 })),
        readFile: async (path: string) => ({ kind: 'text', content: disk[path] ?? '' }),
        mkdir: async () => undefined,
        writeText: async (path: string, text: string) => {
          writes[path] = text
        }
      }
    }
  }

  return { calls, writes, rest }
}

const JAROD_STATUS = () => ({ status: 'ok', backend: 'jarod' })
const HERMES_STATUS = () => ({ status: 'ok', version: '1.0' })

const remoteFiles = (memory: string[], user: string[], dates?: number[]): RemoteMemoryFiles => ({
  files: {
    'MEMORY.md': { exists: memory.length > 0, modified_at: 5000, texts: memory, ...(dates ? { dates } : {}) },
    'USER.md': { exists: user.length > 0, modified_at: 6000, texts: user }
  }
})

beforeEach(() => {
  $memory.set({ files: null, entries: [], loading: false, loaded: false, error: null })
})

afterEach(() => {
  delete (globalThis as { window?: unknown }).window
})

describe('memorySource', () => {
  it('is the gateway only when the backend says it is Jarod', async () => {
    bridge({ 'GET /api/status': JAROD_STATUS })
    expect(await memorySource()).toBe('gateway')
    bridge({ 'GET /api/status': HERMES_STATUS })
    expect(await memorySource()).toBe('disk')
  })

  it('falls back to the disk when the status cannot be read', async () => {
    bridge({})
    expect(await memorySource()).toBe('disk')
  })
})

describe('fromRemote', () => {
  it('maps both lists, trims, drops blanks and keeps per-entry dates only when they line up', () => {
    const [memory, user] = fromRemote(remoteFiles([' a ', 'b'], ['  ', 'c'], [111, 222]))
    expect(memory).toMatchObject({ file: 'MEMORY.md', exists: true, remote: true, truncated: false, modifiedAt: 5000, texts: ['a', 'b'], dates: [111, 222] })
    // `USER.md` had a blank entry: the dates (none here) are not used, the blank is dropped.
    expect(user).toMatchObject({ file: 'USER.md', texts: ['c'], remote: true })
    expect(user.dates).toBeUndefined()
    expect(fromRemote(remoteFiles(['a', 'b'], [], [111]))[0]!.dates).toBeUndefined()
    expect(fromRemote({ files: {} } as RemoteMemoryFiles).map(f => [f.exists, f.texts])).toEqual([[false, []], [false, []]])
  })

  it("an entry's date is its creation time from the backend, unless the text carries its own ISO date", () => {
    const [memory] = fromRemote(remoteFiles(['no date here', 'Decided on 2026-03-04 to ship'], [], [1_700_000_000_000, 1_700_000_000_000]))
    const entries = buildEntries(memory!)
    expect(entries[0]!.date).toBe(1_700_000_000_000)
    expect(entries[1]!.date).toBe(new Date(2026, 2, 4).getTime())
  })
})

describe('loadMemory and edits against the Jarod gateway', () => {
  const state = { memory: ['Prefers short answers', 'Works on Jarod-OS'], user: ['Marc'] }

  it('reads the lists from /api/memory/files and never touches the disk', async () => {
    const { calls } = bridge({ 'GET /api/status': JAROD_STATUS, 'GET /api/memory/files': () => remoteFiles(state.memory, state.user) })
    await loadMemory('C:/hermes-home')
    const memory = $memory.get()
    expect(memory.loaded).toBe(true)
    expect(memory.error).toBeNull()
    expect(memory.entries.map(e => [e.file, e.text])).toEqual([['MEMORY.md', 'Prefers short answers'], ['MEMORY.md', 'Works on Jarod-OS'], ['USER.md', 'Marc']])
    expect(calls.map(c => `${c.method} ${c.path}`)).toEqual(['GET /api/status', 'GET /api/memory/files'])
  })

  it('writes the whole list back with PUT, then re-reads the truth', async () => {
    let memoryList = [...state.memory]
    const { calls } = bridge({
      'GET /api/status': JAROD_STATUS,
      'GET /api/memory/files': () => remoteFiles(memoryList, state.user),
      'PUT /api/memory/files/MEMORY.md': call => {
        memoryList = (call.body as { texts: string[] }).texts

        return { files: {} }
      }
    })
    await loadMemory('h')
    const entry = $memory.get().entries[0]!
    await updateEntry('h', entry, '  Prefers very short answers  ')
    expect(calls.filter(c => c.method === 'PUT').map(c => [c.path, c.body])).toEqual([['/api/memory/files/MEMORY.md', { texts: ['Prefers very short answers', 'Works on Jarod-OS'] }]])
    expect($memory.get().entries.map(e => e.text)).toEqual(['Prefers very short answers', 'Works on Jarod-OS', 'Marc'])

    await forgetEntry('h', $memory.get().entries[1]!)
    expect(memoryList).toEqual(['Prefers very short answers'])

    const id = await addEntry('h', 'MEMORY.md', 'New fact')
    expect(id).toBe('MEMORY.md:1')
    expect(memoryList).toEqual(['Prefers very short answers', 'New fact'])
  })

  it('an edit to USER.md goes to USER.md only', async () => {
    const { calls } = bridge({
      'GET /api/status': JAROD_STATUS,
      'GET /api/memory/files': () => remoteFiles(state.memory, state.user),
      'PUT /api/memory/files/USER.md': () => ({})
    })
    await loadMemory('h')
    await addEntry('h', 'USER.md', 'Likes tea')
    expect(calls.filter(c => c.method === 'PUT').map(c => c.path)).toEqual(['/api/memory/files/USER.md'])
  })

  it('a failed write is reported to the caller, and the page then shows the truth again', async () => {
    const { calls } = bridge({
      'GET /api/status': JAROD_STATUS,
      'GET /api/memory/files': () => remoteFiles(state.memory, state.user),
      'PUT /api/memory/files/MEMORY.md': () => {
        throw new Error('PUT -> 400: Trop d\'entrées')
      }
    })
    await loadMemory('h')
    await expect(updateEntry('h', $memory.get().entries[0]!, 'changed')).rejects.toThrow(/Trop d'entrées/)
    expect($memory.get().entries[0]!.text).toBe('Prefers short answers')
    expect(calls.filter(c => c.path === '/api/memory/files' && c.method === 'GET')).toHaveLength(2)
  })

  it('reports a read error without losing what was already shown', async () => {
    bridge({ 'GET /api/status': JAROD_STATUS })
    await loadMemory('h')
    expect($memory.get().error).toMatch(/404/)
    expect($memory.get().loading).toBe(false)
  })
})

describe('a real Hermes backend still uses the files on disk', () => {
  it('reads MEMORY.md and USER.md from $HERMES_HOME/memories and writes with fs.writeText', async () => {
    const { calls, writes } = bridge(
      { 'GET /api/status': HERMES_STATUS },
      { 'H/memories/MEMORY.md': 'one\n§\ntwo', 'H/memories/USER.md': 'me' }
    )
    await loadMemory('H')
    expect($memory.get().entries.map(e => [e.id, e.text])).toEqual([['MEMORY.md:0', 'one'], ['MEMORY.md:1', 'two'], ['USER.md:0', 'me']])
    expect($memory.get().files?.['MEMORY.md']).toMatchObject({ path: 'H/memories/MEMORY.md' })
    expect($memory.get().files?.['MEMORY.md']?.remote).toBeUndefined()
    expect(calls.some(c => c.path === '/api/memory/files')).toBe(false)

    await addEntry('H', 'MEMORY.md', 'three')
    expect(writes['H/memories/MEMORY.md']).toBe('one\n§\ntwo\n§\nthree')
    expect(calls.some(c => c.method === 'PUT')).toBe(false)
  })
})
