import { type BrowserWindow, ipcMain } from 'electron'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { IPC, type OsControlReply, type OsControlRequest } from '../../shared/ipc.ts'
import { log } from '../log.ts'

/*
 * OS control: how anything outside the renderer (the agent's `os_ui` tool through the bridge
 * plugin, the `herald-os` CLI) runs a command from the renderer's registry and gets the result.
 *
 * - `OsCommandBridge` is the main <-> renderer half: it posts an `OsControlRequest` to the Hermes
 *   window and resolves when the window replies (or times out).
 * - `OsControlServer` is a JSON-lines Unix socket shared by both shell modes. In panels mode the
 *   existing `ControlSocket` hands `ui*` requests to `handleUiRequest`; in desktop mode the server
 *   runs on its own under the Herald OS data dir.
 *
 * Requests carry a per-launch token that main also gives the backend (HERALD_OS_CONTROL_TOKEN), so a
 * stray local process cannot drive the UI even though the socket is user-only (0600).
 */

const REPLY_TIMEOUT_MS = 8_000

export class OsCommandBridge {
  private readonly pending = new Map<string, { resolve: (reply: OsControlReply) => void; timer: ReturnType<typeof setTimeout> }>()
  private counter = 0

  constructor(private readonly getWindow: () => BrowserWindow | null) {
    ipcMain.on(IPC.osControlReply, (_event, reply: OsControlReply) => {
      const entry = this.pending.get(reply.requestId)

      if (entry) {
        clearTimeout(entry.timer)
        this.pending.delete(reply.requestId)
        entry.resolve(reply)
      }
    })
  }

  private send(request: { kind: 'run'; command: string; args: Record<string, unknown>; source: 'agent' | 'cli' | 'plugin' } | { kind: 'list' } | { kind: 'state' }): Promise<OsControlReply> {
    const win = this.getWindow()

    if (!win || win.isDestroyed()) {
      return Promise.resolve({ requestId: '', error: 'The Hermes window is not open.' })
    }

    const requestId = `oc${++this.counter}`
    const full = { ...request, requestId } as OsControlRequest

    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        resolve({ requestId, error: 'The Hermes window did not answer in time.' })
      }, REPLY_TIMEOUT_MS)
      this.pending.set(requestId, { resolve, timer })
      win.webContents.send(IPC.osControlRequest, full)
    })
  }

  run(command: string, args: Record<string, unknown>, source: 'agent' | 'cli' | 'plugin'): Promise<OsControlReply> {
    return this.send({ kind: 'run', command, args, source })
  }

  list(): Promise<OsControlReply> {
    return this.send({ kind: 'list' })
  }

  state(): Promise<OsControlReply> {
    return this.send({ kind: 'state' })
  }
}

export interface UiControlRequest {
  cmd: string
  token?: string
  command?: string
  args?: unknown
  source?: string
}

let controlToken = ''

/** The per-launch token main hands to the backend and requires on `ui*` requests. */
export function osControlToken(): string {
  if (!controlToken) {
    controlToken = crypto.randomBytes(24).toString('base64url')
  }

  return controlToken
}

const UI_COMMANDS = new Set(['ui', 'ui-list', 'ui-state'])

export function isUiRequest(cmd: string): boolean {
  return UI_COMMANDS.has(cmd)
}

/** Serve one `ui*` request through the bridge; `null` when `cmd` is not a UI request. */
export async function handleUiRequest(request: UiControlRequest, bridge: OsCommandBridge): Promise<Record<string, unknown> | null> {
  if (!isUiRequest(request.cmd)) {
    return null
  }

  if (request.token !== osControlToken()) {
    return { ok: false, error: 'invalid control token' }
  }

  let reply: OsControlReply

  switch (request.cmd) {
    case 'ui': {
      if (!request.command || typeof request.command !== 'string') {
        return { ok: false, error: 'ui needs a command id' }
      }

      const args = request.args && typeof request.args === 'object' && !Array.isArray(request.args) ? (request.args as Record<string, unknown>) : {}
      reply = await bridge.run(request.command, args, request.source === 'cli' ? 'cli' : 'agent')

      break
    }
    case 'ui-list':
      reply = await bridge.list()

      break
    default:
      reply = await bridge.state()
  }

  if (reply.error) {
    return { ok: false, error: reply.error }
  }

  const result = reply.result

  if (request.cmd === 'ui' && result && typeof result === 'object') {
    return { ...(result as Record<string, unknown>) }
  }

  return { ok: true, result }
}

/**
 * A JSON-lines server: one request object per line in, one reply object per line out. A Unix socket
 * on macOS and Linux; on Windows (where Node serves only named pipes and Python's AF_UNIX support is
 * patchy) a loopback TCP port chosen by the system, announced as `tcp://127.0.0.1:<port>`. Every
 * request carries the per-launch token either way.
 */
export class OsControlServer {
  private server: net.Server | null = null
  private port = 0
  private markReady: () => void = () => undefined
  /** Resolves once the server is listening (or has given up), so the backend is not started before the endpoint exists. */
  readonly ready: Promise<void> = new Promise(resolve => {
    this.markReady = resolve
  })

  constructor(
    private readonly socketPath: string,
    private readonly handle: (request: Record<string, unknown>) => Promise<Record<string, unknown>>,
    private readonly loopback: boolean = process.platform === 'win32'
  ) {}

  /** What the backend dials: the socket path, or `tcp://127.0.0.1:<port>` once listening. */
  get endpoint(): string {
    return this.loopback ? (this.port ? `tcp://127.0.0.1:${this.port}` : '') : this.socketPath
  }

  start(): void {
    if (!this.loopback) {
      try {
        fs.mkdirSync(path.dirname(this.socketPath), { recursive: true, mode: 0o700 })
        fs.unlinkSync(this.socketPath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          log('os-control', `cannot prepare ${this.socketPath}: ${(error as Error).message}`)
          this.markReady()

          return
        }
      }
    }

    this.server = net.createServer(connection => {
      let buffer = ''
      connection.setEncoding('utf8')
      connection.on('data', chunk => {
        buffer += chunk
        let index = buffer.indexOf('\n')

        while (index >= 0) {
          const line = buffer.slice(0, index).trim()
          buffer = buffer.slice(index + 1)

          if (line) {
            void this.handleLine(line).then(reply => {
              if (!connection.destroyed) {
                connection.write(`${JSON.stringify(reply)}\n`)
              }
            })
          }

          index = buffer.indexOf('\n')
        }
      })
      connection.on('error', () => undefined)
    })
    this.server.on('error', error => {
      log('os-control', `socket error: ${error.message}`)
      this.markReady()
    })

    if (this.loopback) {
      this.server.listen(0, '127.0.0.1', () => {
        this.port = (this.server?.address() as net.AddressInfo).port
        log('os-control', `listening on ${this.endpoint}`)
        this.markReady()
      })

      return
    }

    this.server.listen(this.socketPath, () => {
      fs.chmodSync(this.socketPath, 0o600)
      log('os-control', `listening on ${this.socketPath}`)
      this.markReady()
    })
  }

  stop(): void {
    this.server?.close()
    this.server = null

    if (this.loopback) {
      return
    }

    try {
      fs.unlinkSync(this.socketPath)
    } catch {
      // Already gone.
    }
  }

  private async handleLine(line: string): Promise<Record<string, unknown>> {
    let request: Record<string, unknown>

    try {
      request = JSON.parse(line) as Record<string, unknown>
    } catch {
      return { ok: false, error: 'invalid JSON' }
    }

    try {
      return await this.handle(request)
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
}
