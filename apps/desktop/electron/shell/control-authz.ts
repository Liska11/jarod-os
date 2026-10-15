/**
 * Who may ask the shell's control plane to do what.
 *
 * The decision used to sit with the caller, or with nobody: `ControlSocket` took any well-formed
 * request, and `os`/`os-run` asked for no token at all. Authorization now happens here, on the way
 * in. The token a caller presents says which surface it may use — the agent backend holds the
 * registry token, the `herald-os` CLI holds the CLI token, and neither opens the other's door — the
 * shell's own command catalogue says what a command is worth, and every attempt is written down.
 *
 * This module stays free of Electron so the policy can be tested on its own; the shell supplies the
 * tokens, the catalogue and the audit sink.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { sameToken } from './json-lines.ts'

export type ControlClient = 'backend' | 'cli'

/** The same ladder the renderer's registry uses (src/store/os-commands.ts). */
export type ControlTier = 'read' | 'act' | 'mutate' | 'destructive'

export interface ControlTokens {
  /** Given to the agent backend; drives the command registry in the Hermes window. */
  backend: string
  /** Given to the `herald-os` CLI over a user-only file; drives the shell's own surface. */
  cli: string
}

/** Requests that run a command in the registry inside the Hermes window. */
export const REGISTRY_COMMANDS = new Set(['ui', 'ui-list', 'ui-state'])

/**
 * Everything the desktop server (`main.ts`) serves on its own door: the registry, plus the few shell
 * conveniences it relays. `os`/`os-run` are deliberately absent — they run registry commands, so they
 * are the CLI's door and the backend's token must not open them — and the list is an allow-list, so a
 * command `main` does not serve is refused here instead of reaching the dispatcher's default branch
 * (which would reply `unknown command` after the journal had already recorded an allow).
 */
export const BACKEND_COMMANDS = new Set(['ui', 'ui-list', 'ui-state', 'page', 'notify', 'voice'])

/**
 * Which door is being guarded. The desktop server (`OsControlServer`) is the *backend's* surface —
 * the shell hands its endpoint to the agent and nothing else dials it — while the Linux panel socket
 * is shared by the `herald-os` CLI and the backend at once.
 */
export type ControlSurface = 'panel' | 'backend'

/** The shape the socket decodes before anything else looks at it: JSON, so nothing is trusted yet. */
export interface ControlRequestShape {
  cmd?: unknown
  token?: unknown
  command?: unknown
  args?: unknown
  source?: unknown
}

export interface ControlDecision {
  allowed: boolean
  /** Which token was accepted, `null` when none was. */
  client: ControlClient | null
  reason: string
  /** Resolved from the shell's catalogue when the command is known. */
  tier?: ControlTier
}

export interface ControlContext {
  tokens: ControlTokens
  /** Which door this policy guards; the shared panel socket unless said otherwise. */
  surface?: ControlSurface
  /** Resolves a command id to its tier from the catalogue the renderer registered. */
  tierOf?: (command: string) => ControlTier | undefined
  /**
   * Whether the catalogue is worth consulting yet. Commands register as their modules load, so an
   * empty catalogue right after launch must not turn real commands away.
   */
  catalogueReady?: boolean
}

export interface ControlAuditEntry {
  at: string
  client: ControlClient | 'unauthenticated'
  cmd: string
  command?: string
  tier?: ControlTier
  source?: string
  allowed: boolean
  reason: string
}

const TIERS: readonly ControlTier[] = ['read', 'act', 'mutate', 'destructive']

let minted: ControlTokens | null = null

/**
 * The two per-launch tokens, minted once per process and kept in memory only. The backend's drives
 * the command registry; the CLI's is written to a user-only file that `herald-os` reads. Neither
 * opens the other's commands.
 */
export function controlTokens(): ControlTokens {
  if (!minted) {
    minted = {
      backend: crypto.randomBytes(24).toString('base64url'),
      cli: crypto.randomBytes(24).toString('base64url'),
    }
  }

  return minted
}

/**
 * The journal the shell writes: one JSON line per control attempt. It is a record, not a gate — a
 * disk that cannot be written must never change what the shell allows — so failures are swallowed.
 */
export function controlAuditSink(filePath: string): (entry: ControlAuditEntry) => void {
  return entry => {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
      fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, { mode: 0o600 })
    } catch {
      // An unwritable journal is a gap in the record, never a reason to permit or deny anything.
    }
  }
}

export function asControlTier(value: unknown): ControlTier | undefined {
  return TIERS.includes(value as ControlTier) ? (value as ControlTier) : undefined
}

function commandIdOf(cmd: string, request: ControlRequestShape): string {
  // The CLI passes the command id as its first argument — `herald-os os <id> [json]` and
  // `herald-os os-run <id> [json]` alike; the bridge names it directly on `ui`.
  if (cmd === 'os' || cmd === 'os-run') {
    const args = Array.isArray(request.args) ? request.args : []

    return typeof args[0] === 'string' ? args[0] : ''
  }

  return typeof request.command === 'string' ? request.command : ''
}

/**
 * The authorization decision for one control request. Pure: same request and context, same answer.
 */
export function adjudicate(request: ControlRequestShape, context: ControlContext): ControlDecision {
  const cmd = typeof request?.cmd === 'string' ? request.cmd.trim() : ''

  if (!cmd) {
    return { allowed: false, client: null, reason: 'a control request needs a cmd' }
  }

  const asBackend = sameToken(request.token, context.tokens.backend)
  const asCli = asBackend ? false : sameToken(request.token, context.tokens.cli)

  if (!asBackend && !asCli) {
    return { allowed: false, client: null, reason: 'invalid control token' }
  }

  const client: ControlClient = asBackend ? 'backend' : 'cli'

  if ((context.surface ?? 'panel') === 'backend') {
    if (!asBackend) {
      return { allowed: false, client: asCli ? 'cli' : null, reason: 'the backend shell surface needs the backend token' }
    }

    // `os`/`os-run` are the CLI's door even here: they run a registry command, and the backend's own
    // path to the registry is `ui`. On Windows and macOS no CLI exists, so refusing them costs
    // nothing — it only means the backend cannot borrow the CLI's privilege.
    if (cmd === 'os' || cmd === 'os-run') {
      return { allowed: false, client, reason: `the ${cmd} command needs the CLI token` }
    }

    if (!BACKEND_COMMANDS.has(cmd)) {
      return { allowed: false, client, reason: `unknown command ${cmd} on the backend shell surface` }
    }

    const id = commandIdOf(cmd, request)

    return { allowed: true, client, reason: `${cmd} on the backend shell surface`, tier: id ? context.tierOf?.(id) : undefined }
  }

  if (REGISTRY_COMMANDS.has(cmd)) {
    if (!asBackend) {
      return { allowed: false, client, reason: `the ${cmd} command needs the backend token` }
    }

    const id = commandIdOf(cmd, request)

    return { allowed: true, client, reason: `${cmd} runs in the command registry`, tier: id ? context.tierOf?.(id) : undefined }
  }

  if (!asCli) {
    return { allowed: false, client, reason: `the ${cmd} command needs the CLI token` }
  }

  if (cmd === 'os' || cmd === 'os-run') {
    const id = commandIdOf(cmd, request)

    if (!id) {
      return { allowed: false, client, reason: `${cmd} needs a command id` }
    }

    const tier = context.tierOf?.(id)

    if (tier === undefined && context.catalogueReady) {
      return { allowed: false, client, reason: `unknown command ${id}` }
    }

    return { allowed: true, client, reason: `${cmd} runs ${id}`, tier }
  }

  return { allowed: true, client, reason: `${cmd} is a CLI command` }
}

/**
 * The shell's side of the policy: decide, and record that you decided.
 *
 * Nothing consults the record to make a decision, so a failing audit sink can never widen access —
 * it is a journal, not a switch.
 */
export class ControlSecurity {
  private context: ControlContext

  constructor(
    context: ControlContext,
    private readonly audit: (entry: ControlAuditEntry) => void,
    private readonly now: () => Date = () => new Date()
  ) {
    this.context = context
  }

  get tokens(): ControlTokens {
    return this.context.tokens
  }

  /** The renderer finished registering its catalogue: `os`/`os-run` can be checked against it. */
  setCatalogue(tierOf: (command: string) => ControlTier | undefined): void {
    this.context = { ...this.context, tierOf, catalogueReady: true }
  }

  /**
   * A line that never became a request: valid JSON is required before a token, a command or a caller
   * can be named. There is no one to attribute it to and nothing was decided, but the attempt is
   * still written down — with no trace of the line itself, which may well have carried a token.
   */
  malformed(reason: string): void {
    this.audit({ at: this.now().toISOString(), client: 'unauthenticated', cmd: '', allowed: false, reason })
  }

  check(request: ControlRequestShape): ControlDecision {
    const decision = adjudicate(request, this.context)
    const cmd = typeof request?.cmd === 'string' ? request.cmd : ''
    const command = typeof request?.command === 'string' ? request.command : undefined

    this.audit({
      at: this.now().toISOString(),
      client: decision.client ?? 'unauthenticated',
      cmd,
      command: command || undefined,
      tier: decision.tier,
      source: typeof request?.source === 'string' && request.source ? request.source : undefined,
      allowed: decision.allowed,
      reason: decision.reason,
    })

    return decision
  }
}

export interface ControlEndpointInput {
  platform: NodeJS.Platform
  runtimeDir: string
  dataDir: string
}

export interface ControlEndpoint {
  /** How the bridge should reach the shell: a Windows named pipe, or a unix socket path. */
  kind: 'pipe' | 'unix'
  /** What the backend is told to connect to (`HERALD_OS_CONTROL_SOCKET`). */
  endpoint: string
  /** What the host itself listens on. */
  path: string
}

/**
 * Where the control plane listens.
 *
 * Windows gets a named pipe rather than a loopback TCP port: a port is dialable by anything on the
 * machine (and was announced to the backend as `tcp://127.0.0.1:<port>`, token and all), while a
 * pipe is created with the creating user's own access control and is not a network surface. The name
 * carries a digest of the profile so two profiles never share one pipe. The token still stands as the
 * credential: the pipe narrows who can knock, it does not replace the lock.
 */
export function controlEndpoint(input: ControlEndpointInput): ControlEndpoint {
  if (input.platform === 'win32') {
    const digest = crypto.createHash('sha256').update(`${input.dataDir}\u0000${input.runtimeDir}`).digest('hex').slice(0, 16)
    const name = `herald-os-${digest}`

    return { kind: 'pipe', endpoint: `pipe://${name}`, path: `\\\\.\\pipe\\${name}` }
  }

  // This path only ever names a unix socket, so join it the way its own filesystem would: a runtime
  // dir of `/run/user/1000` must not become `\run\user\1000` because the shell reading it is on Windows.
  const socketPath = path.posix.join(input.runtimeDir, 'herald-os', 'control.sock')

  return { kind: 'unix', endpoint: socketPath, path: socketPath }
}
