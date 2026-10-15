import { type BrowserWindow, ipcMain } from 'electron'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { IPC, type OsControlReply, type OsControlRequest } from '../../shared/ipc.ts'
import { log } from '../log.ts'
import type { ControlEndpoint } from './control-authz.ts'
import { LineSplitter } from './json-lines.ts'
import { hardenControlPipe, isLogonSid, resolvePipePrincipals } from './pipe-security.ts'

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
  private readonly pending = new Map<string, { resolve: (reply: OsControlReply) => void; timer: ReturnType<typeof setTimeout>; from: number }>()
  private counter = 0

  constructor(private readonly getWindow: () => BrowserWindow | null) {
    ipcMain.on(IPC.osControlReply, (event, reply: OsControlReply) => {
      const entry = this.pending.get(reply?.requestId)

      if (!entry) {
        return
      }

      // Only the window this command was asked of may answer it. A reply is a claim about a command
      // that was run, and every renderer in this app can send on this channel: one that did not run
      // the command must not be able to say what it returned.
      if (event.sender.id !== entry.from) {
        log('os-control', `ignored a reply to ${reply.requestId} from another window`)

        return
      }

      clearTimeout(entry.timer)
      this.pending.delete(reply.requestId)
      entry.resolve(reply)
    })
  }

  private send(request: { kind: 'run'; command: string; args: Record<string, unknown>; source: 'agent' | 'cli' | 'plugin' | 'ui' } | { kind: 'list' } | { kind: 'state' }): Promise<OsControlReply> {
    const win = this.getWindow()

    if (!win || win.isDestroyed()) {
      return Promise.resolve({ requestId: '', error: 'The Hermes window is not open.' })
    }

    const requestId = `oc${++this.counter}`
    const full = { ...request, requestId } as OsControlRequest
    const from = win.webContents.id

    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        resolve({ requestId, error: 'The Hermes window did not answer in time.' })
      }, REPLY_TIMEOUT_MS)
      this.pending.set(requestId, { resolve, timer, from })
      win.webContents.send(IPC.osControlRequest, full)
    })
  }

  run(command: string, args: Record<string, unknown>, source: 'agent' | 'cli' | 'plugin' | 'ui'): Promise<OsControlReply> {
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
      const source = request.source === 'cli' || request.source === 'ui' ? request.source : 'agent'
      reply = await bridge.run(request.command, args, source)

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
/**
 * Whether the control endpoint is really accepting, and why not when it is not. A door that failed to
 * open must never be mistaken for an open one: on Windows this class states the pipe's DACL itself
 * (`pipe-security.ts`) and refuses to serve until it has read that policy back, so a silent failure
 * here would be read by every caller as "the door is there".
 */
export interface ControlServeStatus {
  serving: boolean
  failure: string | null
}

export class OsControlServer {
  private server: net.Server | null = null
  private state: ControlServeStatus = { serving: false, failure: null }
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

  /** The measured state of the door, for whoever has to decide what to tell the person. */
  get status(): ControlServeStatus {
    return { ...this.state }
  }

  /** One way out of `start`, so a failure is recorded, logged as a security line, and never silent. */
  private giveUp(reason: string): void {
    this.state = { serving: false, failure: reason }
    log('os-control', `refusing to serve ${this.target.endpoint}: ${reason}`)
    try {
      this.server?.close()
    } catch {
      // Never opened, or already gone: nothing else to do with it.
    }

    this.server = null
    this.markReady()
  }

  start(): void {
    if (this.target.kind === 'unix') {
      try {
        fs.mkdirSync(path.dirname(this.target.path), { recursive: true, mode: 0o700 })
        fs.unlinkSync(this.target.path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          this.giveUp(`cannot prepare ${this.target.path}: ${(error as Error).message}`)

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
      // A bind failure means somebody else holds the name, or the platform refused this process the
      // pipe: either way the door is not open, and saying so is the only honest outcome.
      this.giveUp(error.message)
    })

    this.server.listen(this.target.path, () => {
      if (this.target.kind === 'pipe') {
        // The platform gives a pipe created by `net` an implicit DACL: Everyone and Anonymous can
        // read it. Until that DACL has been replaced with one naming exactly the principals of this
        // session, the door is not open — a caller asking `status` must never hear "serving" from a
        // pipe that still lets every local process connect.
        void this.hardenPipe()

        return
      }

      this.state = { serving: true, failure: null }

      try {
        fs.chmodSync(this.target.path, 0o600)
      } catch (error) {
        // A socket that is not owner-only is a different door than the one this code promises.
        this.giveUp(`cannot restrict ${this.target.path} to its owner: ${(error as Error).message}`)

        return
      }

      log('os-control', `listening on ${this.target.endpoint}`)
      this.markReady()
    })
  }

  /**
   * Windows: replace the implicit DACL with an explicit, protected one and read it back off the live
   * object. Every failure — no PowerShell, a refused `SetSecurityInfo`, a DACL that names more
   * principals than were asked for — closes the door rather than serving it half-restricted.
   */
  private async hardenPipe(): Promise<void> {
    try {
      const principals = await resolvePipePrincipals()

      // A token without a logon SID can only grant its account, not its session: the pipe then
      // narrows nothing between two processes of the same user, and the per-run token stays the only
      // credential that separates them. Say so rather than let the journal imply a session scoping
      // the DACL does not have (R3.2).
      if (principals.every(sid => !isLogonSid(sid))) {
        log('os-control', 'this token carries no logon SID: the pipe grants the account, not one session')
      }

      const applied = await hardenControlPipe(this.target.path, principals)

      this.state = { serving: true, failure: null }
      log('os-control', `listening on ${this.target.endpoint} with ${applied}`)
      this.markReady()
    } catch (error) {
      this.giveUp(error instanceof Error ? error.message : String(error))
    }
  }

  stop(): void {
    this.server?.close()
    this.server = null
    this.state = { serving: false, failure: this.state.failure }

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
