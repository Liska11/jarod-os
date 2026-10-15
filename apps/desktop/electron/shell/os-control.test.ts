import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ControlSecurity, controlAuditSink, controlEndpoint, type ControlEndpoint, type ControlTokens } from './control-authz.ts'
import type { OsControlReply } from '../../shared/ipc.ts'
import { IPC } from '../../shared/ipc.ts'
import { log } from '../log.ts'
import { OsCommandBridge, OsControlServer } from './os-control.ts'

// `OsCommandBridge` registers an ipcMain listener when it is built and Electron's runtime is not
// here; the server under test never builds one.
vi.mock('electron', () => ({ ipcMain: { on: vi.fn() } }))
vi.mock('../log.ts', () => ({ log: vi.fn() }))

const TOKENS: ControlTokens = { backend: 'backend-token-000000000001', cli: 'cli-token-00000000000001' }
const created: string[] = []

/** The listener `OsCommandBridge` registered for replies (its constructor is the only place that does). */
function replyHandler(): (event: { sender: { id: number } }, reply: OsControlReply) => void {
  const calls = vi.mocked(ipcMain.on).mock.calls.filter(([channel]) => channel === IPC.osControlReply)

  return calls[calls.length - 1]?.[1] as unknown as (event: { sender: { id: number } }, reply: OsControlReply) => void
}

describe('OsCommandBridge', () => {
  it('answers only the window it asked: a reply from another one is ignored (R3)', async () => {
    const sent: { requestId?: string }[] = []
    const target = {
      webContents: {
        id: 7,
        send: (_channel: string, payload: { requestId?: string }) => sent.push(payload),
      },
      isDestroyed: () => false,
    }
    const bridge = new OsCommandBridge(() => target as unknown as BrowserWindow)
    const answer = replyHandler()
    const pending = bridge.run('page.open', { name: 'memory' }, 'agent')
    const requestId = sent[0]?.requestId as string
    let settled: unknown = 'pending'

    void pending.then(value => {
      settled = value
    })

    answer({ sender: { id: 99 } }, { requestId, result: { ok: true, summary: 'not mine' } })
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(settled).toBe('pending')
    expect(vi.mocked(log).mock.calls.some(([scope, message]) => scope === 'os-control' && message.includes('another window'))).toBe(true)

    answer({ sender: { id: 7 } }, { requestId, result: { ok: true, summary: 'mine' } })
    await expect(pending).resolves.toMatchObject({ result: { summary: 'mine' } })
  })
})

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'hos-control-'))
  created.push(dir)

  return dir
}

afterEach(() => {
  while (created.length) {
    rmSync(created.pop() as string, { recursive: true, force: true })
  }
})

function targetFor(platform: NodeJS.Platform): ControlEndpoint {
  const dir = tempDir()

  return controlEndpoint({ platform, runtimeDir: dir, dataDir: dir })
}

/** One request line in, one reply line out, over whatever this endpoint is. */
function ask(target: ControlEndpoint, line: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(target.path)
    let buffer = ''

    socket.setEncoding('utf8')
    socket.on('connect', () => socket.write(`${line}\n`))
    socket.on('data', chunk => {
      buffer += chunk

      if (buffer.endsWith('\n')) {
        socket.end()
        resolve(buffer.trim())
      }
    })
    socket.on('error', reject)
  })
}

describe('controlEndpoint', () => {
  it('names a private pipe on Windows, not a loopback port', () => {
    const ipc = targetFor('win32')

    expect(ipc.kind).toBe('pipe')
    expect(ipc.path.startsWith('\\\\.\\pipe\\herald-os-')).toBe(true)
    expect(ipc.endpoint).toBe(`pipe://${ipc.path.slice('\\\\.\\pipe\\'.length)}`)
    expect(ipc.endpoint).not.toContain('tcp://')
  })

  it('gives each profile its own pipe', () => {
    const one = targetFor('win32')
    const two = targetFor('win32')

    expect(one.path).not.toBe(two.path)
  })

  it('keeps a unix socket path in the shape its own filesystem uses', () => {
    const ipc = controlEndpoint({ platform: 'linux', runtimeDir: '/run/user/1000', dataDir: '/home/san' })

    expect(ipc.kind).toBe('unix')
    expect(ipc.path).toBe('/run/user/1000/herald-os/control.sock')
    expect(ipc.endpoint).toBe(ipc.path)
  })
})

describe('OsControlServer', () => {
  it('serves one request per line behind the token, over the transport this platform really uses', async () => {
    const target = targetFor(process.platform)
    const journal = path.join(tempDir(), 'control-audit.jsonl')
    const security = new ControlSecurity({ tokens: TOKENS, surface: 'backend' }, controlAuditSink(journal))
    const allowed: string[] = []
    const server = new OsControlServer(target, async request => {
      const decision = security.check(request)

      if (!decision.allowed) {
        return { ok: false, error: decision.reason }
      }

      allowed.push(String(request.cmd))

      return { ok: true, cmd: String(request.cmd) }
    }, reason => security.malformed(reason))

    server.start()
    await server.ready

    try {
      expect(server.endpoint).toBe(target.endpoint)
      expect(server.status).toEqual({ serving: true, failure: null })

      const ran = JSON.parse(await ask(target, JSON.stringify({ cmd: 'ui', command: 'memory.forget', args: {}, source: 'agent', token: TOKENS.backend })))

      expect(ran).toEqual({ ok: true, cmd: 'ui' })

      const stranger = JSON.parse(await ask(target, JSON.stringify({ cmd: 'ui', command: 'memory.forget', token: 'guessed' })))

      expect(stranger).toEqual({ ok: false, error: 'invalid control token' })

      const cliOnTheBackendSurface = JSON.parse(await ask(target, JSON.stringify({ cmd: 'ui', command: 'memory.forget', token: TOKENS.cli })))

      expect(cliOnTheBackendSurface).toEqual({ ok: false, error: 'the backend shell surface needs the backend token' })

      // A line that is not JSON, carrying a token anyway: it must be refused, journalled, and the
      // token must not survive into the record.
      expect(JSON.parse(await ask(target, `{ not json, and this is the CLI token: ${TOKENS.cli}`))).toEqual({ ok: false, error: 'invalid JSON' })

      expect(allowed).toEqual(['ui'])

      // Every attempt reaches the journal, the refused ones included — the unattributable line too:
      // that is what makes a silent attempt visible.
      const raw = readFileSync(journal, 'utf8')

      expect(raw.trim().split('\n').map(line => {
        const entry = JSON.parse(line) as { cmd: string; client: string; allowed: boolean; reason: string }

        return [entry.cmd, entry.client, entry.allowed, entry.reason]
      })).toEqual([
        ['ui', 'backend', true, 'ui on the backend shell surface'],
        ['ui', 'unauthenticated', false, 'invalid control token'],
        ['ui', 'cli', false, 'the backend shell surface needs the backend token'],
        ['', 'unauthenticated', false, 'invalid JSON']
      ])
      expect(raw).not.toContain(TOKENS.backend)
      expect(raw).not.toContain(TOKENS.cli)
      expect(vi.mocked(log).mock.calls.some(([scope, message]) => scope === 'os-control' && message.includes('not JSON'))).toBe(true)
    } finally {
      server.stop()
    }
  })

  it('does not fall back silently when it cannot open the door', async () => {
    const blocker = path.join(tempDir(), 'blocker')
    const target: ControlEndpoint = { kind: 'unix', endpoint: path.join(blocker, 'control.sock'), path: path.join(blocker, 'control.sock') }

    writeFileSync(blocker, 'not a directory')
    const server = new OsControlServer(target, async () => ({ ok: true }))

    server.start()
    await server.ready

    expect(server.status.serving).toBe(false)
    expect(server.status.failure).toMatch(/cannot prepare/)
    // The reason is in the shell's log as a refusal, not as an aside: the door is not open.
    expect(vi.mocked(log).mock.calls.some(([scope, message]) => scope === 'os-control' && message.includes('refusing to serve'))).toBe(true)
    server.stop()
  })

  it.skipIf(process.platform !== 'win32')('refuses a pipe name that another process already holds', async () => {
    const target = targetFor('win32')
    // The squatter is a second server on the same name; libuv refuses it (FILE_FLAG_FIRST_PIPE_INSTANCE),
    // so the door must report that it is not the one listening rather than carry on.
    const squatter = net.createServer(socket => socket.end())

    await new Promise<void>(resolve => squatter.listen(target.path, resolve))

    const server = new OsControlServer(target, async () => ({ ok: true }))

    server.start()
    await server.ready

    try {
      expect(server.status.serving).toBe(false)
      expect(server.status.failure).toBeTruthy()
      expect(vi.mocked(log).mock.calls.some(([scope, message]) => scope === 'os-control' && message.includes('refusing to serve'))).toBe(true)
    } finally {
      server.stop()
      squatter.close()
    }
  })

  it.skipIf(process.platform === 'win32')('keeps the unix socket to its owner', async () => {
    const target = targetFor(process.platform)
    const server = new OsControlServer(target, async () => ({ ok: true }))

    server.start()
    await server.ready

    try {
      expect(statSync(target.path).mode & 0o777).toBe(0o600)
    } finally {
      server.stop()
    }

    expect(() => statSync(target.path)).toThrow()
  })
})
