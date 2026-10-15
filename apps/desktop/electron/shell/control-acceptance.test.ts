/**
 * R2 acceptance: the whole host pipeline over the transport this platform really uses.
 *
 * `main.ts` wires a gate and a door; this drives the same pair — `ControlSecurity` for identity,
 * `HostControlGate` for authorisation, `OsControlServer` for the wire — through a real socket, with a
 * stand-in for the person. Every case here is one of R2's acceptance criteria: a mutation without a
 * witnessed approval is refused, a refused call leaves nothing behind, `os`/`os-run` are gone, every
 * attempt is journalled, and no secret (token, capability) reaches the journal or the reply.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ControlSecurity, asControlTier, controlAuditSink, controlEndpoint, type ControlEndpoint, type ControlTokens } from './control-authz.ts'
import { HostControlGate, type ApprovalAsk, type CatalogueEntry } from './host-control.ts'
import { OsControlServer } from './os-control.ts'

// `OsCommandBridge` touches Electron's ipcMain when it is built; the door under test never builds one.
vi.mock('electron', () => ({ ipcMain: { on: vi.fn() } }))
vi.mock('../log.ts', () => ({ log: vi.fn() }))

const TOKENS: ControlTokens = { backend: 'backend-token-000000000001', cli: 'cli-token-00000000000001' }

const CATALOGUE: readonly CatalogueEntry[] = [
  { id: 'page.open', tier: 'read', args: [{ name: 'name', type: 'string', required: true }] },
  { id: 'memory.add', tier: 'mutate', args: [{ name: 'text', type: 'string', required: true }] },
  { id: 'memory.forget', tier: 'destructive', args: [{ name: 'match', type: 'string', required: true }] },
]

const created: string[] = []

afterEach(() => {
  while (created.length) {
    rmSync(created.pop() as string, { recursive: true, force: true })
  }
})

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'hos-accept-'))

  created.push(dir)

  return dir
}

/** One request line in, the whole pipeline's reply out. */
function ask(target: ControlEndpoint, line: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(target.path)
    let buffer = ''

    socket.setEncoding('utf8')
    socket.on('connect', () => socket.write(`${line}\n`))
    socket.on('data', chunk => {
      buffer += chunk

      if (buffer.endsWith('\n')) {
        socket.end()
        resolve(JSON.parse(buffer.trim()) as Record<string, unknown>)
      }
    })
    socket.on('error', reject)
  })
}

interface Door {
  send: (line: unknown) => Promise<Record<string, unknown>>
  asks: ApprovalAsk[]
  ran: string[]
  journal: string
  answer: (value: boolean | ((ask: ApprovalAsk) => boolean)) => void
  close: () => void
}

/** The pipeline main.ts wires for the backend door, over a real endpoint for this platform. */
async function openDoor(): Promise<Door> {
  const target = controlEndpoint({ platform: process.platform, runtimeDir: tempDir(), dataDir: tempDir() })
  const journal = path.join(tempDir(), 'control-audit.jsonl')
  const security = new ControlSecurity({ tokens: TOKENS, surface: 'backend' }, controlAuditSink(journal))
  const asks: ApprovalAsk[] = []
  const ran: string[] = []
  let answer: boolean | ((ask: ApprovalAsk) => boolean) = false
  const gate = new HostControlGate({
    security,
    approve: async ask => {
      asks.push(ask)

      return typeof answer === 'function' ? answer(ask) : answer
    },
  })

  // `learnCatalogue` in main.ts hands the same catalogue to both halves: the security uses the tiers,
  // the gate uses the tiers and the declared argument shapes.
  security.setCatalogue(id => asControlTier(CATALOGUE.find(entry => entry.id === id)?.tier))
  gate.setCatalogue(CATALOGUE)

  const server = new OsControlServer(
    target,
    async request => {
      const result = await gate.submit(request)

      if (result.kind === 'reply') {
        return { ...result.reply }
      }

      ran.push(String(request.command ?? request.cmd))

      const reply = { ok: true, summary: `${String(request.command ?? request.cmd)} done` }

      result.finish({ ok: true })

      return { ...reply, code: 'ok' }
    },
    reason => security.malformed(reason)
  )

  server.start()
  await server.ready

  return {
    send: line => ask(target, typeof line === 'string' ? line : JSON.stringify(line)),
    asks,
    ran,
    journal,
    answer: value => {
      answer = value
    },
    close: () => server.stop(),
  }
}

function lines(journal: string): { code?: string; client: string; command?: string; allowed: boolean; reason: string }[] {
  return readFileSync(journal, 'utf8')
    .trim()
    .split('\n')
    .map(line => JSON.parse(line) as { code?: string; client: string; command?: string; allowed: boolean; reason: string })
}
describe('the host control pipeline, end to end', () => {
  it('runs a read command on the token alone', async () => {
    const door = await openDoor()

    try {
      const reply = await door.send({ cmd: 'ui', command: 'page.open', args: { name: 'memory' }, source: 'agent', token: TOKENS.backend })

      expect(reply).toMatchObject({ ok: true, code: 'ok' })
      expect(door.ran).toEqual(['page.open'])
      expect(door.asks).toEqual([])
    } finally {
      door.close()
    }
  })

  it('refuses a mutation when the person says no, and changes nothing', async () => {
    const door = await openDoor()

    try {
      const reply = await door.send({ cmd: 'ui', command: 'memory.forget', args: { match: 'x' }, token: TOKENS.backend })

      expect(reply).toMatchObject({ ok: false, code: 'denied-approval' })
      expect(door.ran).toEqual([])
      expect(door.asks.map(ask => ask.command)).toEqual(['registry:memory.forget'])
    } finally {
      door.close()
    }
  })

  it('runs a mutation once, after the person says yes, on the capability it issued', async () => {
    const door = await openDoor()

    try {
      door.answer(true)

      const granted = await door.send({ cmd: 'ui', command: 'memory.add', args: { text: 'likes tea' }, token: TOKENS.backend })
      const capability = (granted.capability as { id?: string } | undefined)?.id

      expect(granted).toMatchObject({ ok: false, code: 'approval-granted' })
      expect(capability).toBeTypeOf('string')
      expect(door.ran).toEqual([])

      const done = await door.send({ cmd: 'ui', command: 'memory.add', args: { text: 'likes tea' }, token: TOKENS.backend, capability })

      expect(done).toMatchObject({ ok: true, code: 'ok' })
      expect(door.ran).toEqual(['memory.add'])
      expect(door.asks).toHaveLength(1)

      const again = await door.send({ cmd: 'ui', command: 'memory.add', args: { text: 'likes tea' }, token: TOKENS.backend, capability })

      expect(again).toMatchObject({ ok: false, code: 'replay' })
      expect(door.ran).toEqual(['memory.add'])
      // A replayed capability is refused on the spot: it is not a reason to ask the person again.
      expect(door.asks).toHaveLength(1)
    } finally {
      door.close()
    }
  })

  it('refuses a capability pointed at different arguments', async () => {
    const door = await openDoor()

    try {
      door.answer(true)

      const granted = await door.send({ cmd: 'ui', command: 'memory.forget', args: { match: 'x' }, token: TOKENS.backend })
      const capability = (granted.capability as { id: string }).id
      const changed = await door.send({ cmd: 'ui', command: 'memory.forget', args: { match: 'y' }, token: TOKENS.backend, capability })

      expect(changed).toMatchObject({ ok: false, code: 'capability-mismatch' })
      expect(door.ran).toEqual([])
    } finally {
      door.close()
    }
  })

  it('has retired the free-form registry doors for good', async () => {
    const door = await openDoor()

    try {
      for (const cmd of ['os', 'os-run']) {
        const reply = await door.send({ cmd, args: ['memory.forget', '{"match":"x"}'], token: TOKENS.backend })

        expect(reply).toMatchObject({ ok: false, code: 'unsupported' })
      }

      expect(door.ran).toEqual([])
      expect(door.asks).toEqual([])
    } finally {
      door.close()
    }
  })

  it('refuses an unknown command and a request with no credential', async () => {
    const door = await openDoor()

    try {
      expect(await door.send({ cmd: 'ui', command: 'made.up', args: {}, token: TOKENS.backend })).toMatchObject({ ok: false, code: 'unsupported' })
      expect(await door.send({ cmd: 'ui', command: 'page.open', args: {}, token: 'guessed' })).toMatchObject({ ok: false, code: 'unauthenticated' })
      expect(await door.send({ cmd: 'ui', command: 'page.open', args: {} })).toMatchObject({ ok: false, code: 'unauthenticated' })
      // The CLI token is not the backend's: this door serves one surface, and that is not it.
      expect(await door.send({ cmd: 'ui', command: 'page.open', args: {}, token: TOKENS.cli })).toMatchObject({ ok: false, code: 'unauthorized' })
      expect(door.ran).toEqual([])
    } finally {
      door.close()
    }
  })

  it('journals every attempt, and never a token or a capability', async () => {
    const door = await openDoor()

    try {
      door.answer(true)

      await door.send({ cmd: 'ui', command: 'page.open', args: { name: 'memory' }, token: TOKENS.backend })
      const granted = await door.send({ cmd: 'ui', command: 'memory.forget', args: { match: 'x' }, token: TOKENS.backend })
      const capability = (granted.capability as { id: string }).id

      await door.send({ cmd: 'ui', command: 'memory.forget', args: { match: 'x' }, token: TOKENS.backend, capability })
      await door.send({ cmd: 'os', args: ['memory.forget'], token: TOKENS.backend })
      await door.send(`{ not json, and this is the token: ${TOKENS.backend}`)

      const raw = readFileSync(door.journal, 'utf8')

      expect(lines(door.journal).map(entry => [entry.command, entry.allowed, entry.code])).toEqual([
        ['page.open', true, 'ok'],
        ['memory.forget', true, 'approval-granted'],
        ['memory.forget', true, 'ok'],
        // The retired door names no registry command, and a line that is not JSON names nothing at all:
        // both are still one journal line, which is what makes a silent attempt visible.
        [undefined, false, 'unsupported'],
        [undefined, false, 'invalid']
      ])
      expect(raw).not.toContain(TOKENS.backend)
      expect(raw).not.toContain(TOKENS.cli)
      expect(raw).not.toContain(capability)
    } finally {
      door.close()
    }
  })
})
