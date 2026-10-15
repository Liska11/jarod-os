import { type BrowserWindow, ipcMain } from 'electron'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { IPC, type OsControlReply, type OsControlRequest } from '../../shared/ipc.ts'
import { log } from '../log.ts'
import type { ControlEndpoint } from './control-authz.ts'
import { LineSplitter } from './json-lines.ts'

/*
 * OS control: how anything outside the renderer (the agent's `os_ui` tool through the bridge
 * plugin, the `herald-os` CLI) runs a command from the renderer's registry and gets the result.
 *
 * - `OsCommandBridge` is the main <-> renderer half: it posts an `OsControlRequest` to the Hermes
 *   window and resolves when the window replies (or times out).
 * - `OsControlServer` is a JSON-lines server shared by both shell modes. In panels mode the
 *   existing `ControlSocket` hands `ui*` requests to `handleUiRequest`; in desktop mode the server
 *   runs on its own under the Jarod-OS data dir.
 *
 * Neither decides who may ask: both gate their requests through `ControlSecurity` (control-authz.ts)
 * before they get here, so `handleUiRequest` only has to do the work.
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

const UI_COMMANDS = new Set(['ui', 'ui-list', 'ui-state'])

export function isUiRequest(cmd: string): boolean {
  return UI_COMMANDS.has(cmd)
}

/**
 * Serve one `ui*` request through the bridge; `null` when `cmd` is not a UI request.
 *
 * The caller has already decided that the request may run (`ControlSecurity`), so this does not read
 * a token: there is one gate, and it is not here.
 */
export async function handleUiRequest(request: UiControlRequest, bridge: OsCommandBridge): Promise<Record<string, unknown> | null> {
  if (!isUiRequest(request.cmd)) {
    return null
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
 * on macOS and Linux; a Windows named pipe on Windows, created with the owner's own access control
 * and not dialable as a port by anything else on the machine.
 */
export class OsControlServer {
  private server: net.Server | null = null
  private markReady: () => void = () => undefined
  /** Resolves once the server is listening (or has given up), so the backend is not started before the endpoint exists. */
  readonly ready: Promise<void> = new Promise(resolve => {
    this.markReady = resolve
  })

  constructor(
    private readonly target: ControlEndpoint,
    private readonly handle: (request: Record<string, unknown>) => Promise<Record<string, unknown>>,
    /** Writes a line that never became a request into the shell's journal (see `ControlSecurity`). */
    private readonly onMalformed?: (reason: string) => void
  ) {}

  /** What the backend dials: the socket path, or `pipe://<name>` on Windows. */
  get endpoint(): string {
    return this.target.endpoint
  }

  start(): void {
    if (this.target.kind === 'unix') {
      try {
        fs.mkdirSync(path.dirname(this.target.path), { recursive: true, mode: 0o700 })
        fs.unlinkSync(this.target.path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          log('os-control', `cannot prepare ${this.target.path}: ${(error as Error).message}`)
          this.markReady()

          return
        }
      }
    }

    this.server = net.createServer(connection => {
      const lines = new LineSplitter()
      connection.setEncoding('utf8')
      connection.on('data', (chunk: string) => {
        const complete = lines.push(chunk)

        if (!complete) {
          log('os-control', 'dropped a connection whose request line had no end')
          connection.destroy()

          return
        }

        for (const line of complete) {
          void this.handleLine(line).then(reply => {
            if (!connection.destroyed) {
              connection.write(`${JSON.stringify(reply)}\n`)
            }
          })
        }
      })
      connection.on('error', () => undefined)
    })
    this.server.on('error', error => {
      log('os-control', `socket error: ${error.message}`)
      this.markReady()
    })

    this.server.listen(this.target.path, () => {
      if (this.target.kind === 'unix') {
        fs.chmodSync(this.target.path, 0o600)
      }

      log('os-control', `listening on ${this.target.endpoint}`)
      this.markReady()
    })
  }

  stop(): void {
    this.server?.close()
    this.server = null

    if (this.target.kind !== 'unix') {
      return
    }

    try {
      fs.unlinkSync(this.target.path)
    } catch {
      // Already gone.
    }
  }

  private async handleLine(line: string): Promise<Record<string, unknown>> {
    let request: Record<string, unknown>

    try {
      request = JSON.parse(line) as Record<string, unknown>
    } catch {
      // Not a request anyone can attribute, so the policy never sees it: no token, no command, no
      // caller. The attempt is still journalled — without the line, which may carry a token — and
      // the shell log keeps it visible too.
      log('os-control', 'rejected a request line that was not JSON')
      this.onMalformed?.('invalid JSON')

      return { ok: false, error: 'invalid JSON' }
    }

    try {
      return await this.handle(request)
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
}
