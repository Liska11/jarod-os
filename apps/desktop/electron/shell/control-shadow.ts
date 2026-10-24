import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { shippedDir } from '../host-updater.ts'
import { type ControlClient, type ControlDecision, type ControlRequestShape, type ControlSurface, type ControlTier, commandIdOf, shellArgumentProblem } from './control-authz.ts'

/*
 * V-22 — the Rust adjudicator (host-rust/crates/host-control, binary `jarod-control-shadow`) in the shadow of this one, behind a flag.
 * Off unless JAROD_HOST_CONTROL=1: with the flag off nothing here runs. With it on, the TypeScript door still decides every request,
 * alone; each decision it reached is also handed to the Rust process, and any answer that differs is written to
 * `<config>/control-shadow.jsonl`. That is the live form of the C2 « golden » check (same request, same context, same decision) the
 * Rust host must pass before it takes the door; the rollback is the flag.
 *
 * The live tokens never leave this process: the shadow gets two tokens minted for it, and each request carries the one that matches the
 * client this door recognised (none when it recognised none). Only `cmd`, `command` and `args` go with it. A missing binary, a binary that
 * refuses to start or dies only turns the shadow off, once, with a line in the log: it can never refuse or delay a request.
 */

export const FLAG = 'JAROD_HOST_CONTROL'
export const BIN_ENV = 'JAROD_CONTROL_SHADOW_BIN'
const BINARY = process.platform === 'win32' ? 'jarod-control-shadow.exe' : 'jarod-control-shadow'
/** Requests awaiting the shadow's answer; past this the oldest are dropped and counted, never waited for. */
const MAX_PENDING = 1000
const MAX_COMMAND_KEYS = 200
/** How often, at most, the counts are written to disk while requests keep coming. */
const STATS_EVERY_MS = 1000

export function flagOn(env: NodeJS.ProcessEnv): boolean {
  return env[FLAG] === '1'
}

/** JAROD_CONTROL_SHADOW_BIN when it names a file, else the copy the Windows package ships in `resources/updater`, else the first on PATH. */
export function findShadowBinary(env: NodeJS.ProcessEnv, exists: (file: string) => boolean = fs.existsSync, shipped: string | null = shippedDir()): string | null {
  const named = env[BIN_ENV]

  if (named) return exists(named) ? named : null
  if (shipped && exists(path.join(shipped, BINARY))) return path.join(shipped, BINARY)

  for (const dir of (env.PATH ?? env.Path ?? '').split(path.delimiter)) {
    if (dir && exists(path.join(dir, BINARY))) return path.join(dir, BINARY)
  }

  return null
}

export interface ShadowTokens {
  backend: string
  cli: string
}

export function mintShadowTokens(): ShadowTokens {
  return { backend: randomBytes(24).toString('base64url'), cli: randomBytes(24).toString('base64url') }
}

/** What the shadow sees of a request: the fields the adjudicator reads, with the shadow's token for the client this door recognised. */
export function shadowRequest(request: ControlRequestShape, client: ControlClient | null, tokens: ShadowTokens): Record<string, unknown> {
  const token = client === 'backend' ? tokens.backend : client === 'cli' ? tokens.cli : 'not-a-shadow-token'
  const shown: Record<string, unknown> = { token }

  for (const key of ['cmd', 'command', 'args'] as const) {
    if (request && typeof request === 'object' && key in request) shown[key] = request[key]
  }

  return shown
}

/** The fields on which two decisions differ, in a fixed order; empty when they agree. An absent field and `undefined` are the same. */
export function diffDecisions(ts: ControlDecision, rust: Partial<ControlDecision>): string[] {
  return (['allowed', 'client', 'code', 'tier', 'reason'] as const).filter(field => (ts[field] ?? null) !== (rust[field] ?? null))
}

/**
 * A difference host-rust/README.md already lists, with the same end for the request: counted, not written as a divergence. Only one so
 * far — difference 2: an action a tiered shell command does not know (`plugin frobnicate`) is allowed by this adjudicator and refused by
 * its argument check right after; Rust refuses it as `invalid` at once. It counts only when this side's argument check refuses it too.
 */
export function knownDifference(request: ControlRequestShape, ts: ControlDecision, rust: Partial<ControlDecision>): string | null {
  const cmd = typeof request?.cmd === 'string' ? request.cmd.trim() : ''

  if (ts.allowed && rust.allowed === false && rust.code === 'invalid' && rust.client === ts.client && cmd && shellArgumentProblem(cmd, request) !== undefined) {
    return 'readme-2-unknown-action'
  }

  return null
}

export interface ShadowDivergence {
  at: string
  surface: ControlSurface
  cmd: string
  command?: string
  fields: string[]
  ts: ControlDecision
  rust: Partial<ControlDecision> | { error: string }
}

export interface ShadowStats {
  running: boolean
  compared: number
  diverged: number
  /** Differences the README lists, with the same end for the request (`knownDifference`). */
  known: number
  dropped: number
  /** The same counts per `surface:cmd` (cmd trimmed, empty as `-`): which requests a session really sent through the door. */
  byCommand: Record<string, { compared: number; diverged: number; known: number; tiers: Partial<Record<ControlTier | 'none', number>> }>
}

export interface ControlShadowOptions {
  binary: string
  contracts: string
  /** One line per divergence; the caller writes it (redacted) where it belongs. */
  onDivergence: (entry: ShadowDivergence) => void
  /** Why the shadow stopped, once. */
  onStop?: (reason: string) => void
  /** After each comparison (the counts changed). */
  onCompared?: () => void
}

/** The doors a shadow watches: each tells it what it decided, with its catalogue, and redacts what it writes. */
export interface ShadowedDoor {
  surface: ControlSurface
  tierOf: (id: string) => ControlTier | undefined
  catalogueReady: boolean
  redact: (text: string) => string
  addObserver: (observer: (request: ControlRequestShape, decision: ControlDecision) => void) => void
}

/**
 * With the flag on, a binary and the contracts: one shadow for these doors, its divergences appended to `<configDir>/control-shadow.jsonl`
 * (cmd, command and reasons redacted by the door that decided) and its counts kept in `<configDir>/control-shadow-stats.json` (at start,
 * at most once a second while requests come, and when it stops). Returns null, and runs nothing, otherwise.
 */
export function attachControlShadow(options: {
  env: NodeJS.ProcessEnv
  configDir: string
  contracts: string | null
  doors: readonly ShadowedDoor[]
  log: (message: string) => void
}): ControlShadow | null {
  if (!flagOn(options.env)) return null

  const binary = findShadowBinary(options.env)

  if (!binary || !options.contracts) {
    options.log(`[control-shadow] ${FLAG}=1 but ${binary ? 'no contracts/v1' : `no ${BINARY} (${BIN_ENV}, resources/updater or PATH)`}: shadow off`)
    return null
  }

  const file = path.join(options.configDir, 'control-shadow.jsonl')
  const doorOf = (surface: ControlSurface) => options.doors.find(door => door.surface === surface)
  const shadow = new ControlShadow({
    binary,
    contracts: options.contracts,
    onDivergence: entry => {
      const door = doorOf(entry.surface)
      const redact = (text: string) => (door ? door.redact(text) : '[redacted]')
      const clean = (decision: Partial<ControlDecision> | { error: string }) =>
        'error' in decision ? { error: redact(decision.error) } : { ...decision, reason: decision.reason === undefined ? undefined : redact(decision.reason) }
      const line = { ...entry, cmd: redact(entry.cmd), command: entry.command === undefined ? undefined : redact(entry.command), ts: clean(entry.ts), rust: clean(entry.rust) }

      try {
        fs.mkdirSync(options.configDir, { recursive: true })
        fs.appendFileSync(file, `${JSON.stringify(line)}\n`)
      } catch (error) {
        options.log(`[control-shadow] cannot write ${file}: ${(error as Error).message}`)
      }
    },
    onStop: reason => {
      stopReason = reason
      writeStats()
      options.log(`[control-shadow] off: ${reason} (${summary()})`)
    },
    onCompared: () => {
      statsTimer ??= setTimeout(writeStats, STATS_EVERY_MS)
      statsTimer.unref?.()
    },
  })
  const statsFile = path.join(options.configDir, 'control-shadow-stats.json')
  const startedAt = new Date().toISOString()
  let statsTimer: ReturnType<typeof setTimeout> | undefined
  let stopReason: string | null = null
  const summary = () => {
    const { compared, diverged, known, dropped } = shadow.stats
    return `compared ${compared}, diverged ${diverged}, known ${known}, dropped ${dropped}`
  }
  // What a session really sent through the shadow, rewritten whole (temp file, then rename) so a reader never sees half of it.
  const writeStats = () => {
    if (statsTimer) clearTimeout(statsTimer)
    statsTimer = undefined
    const stats = shadow.stats
    const redact = (text: string) => options.doors[0]?.redact(text) ?? '[redacted]'
    const byCommand = Object.fromEntries(Object.entries(stats.byCommand).map(([key, row]) => [redact(key), row]))
    const body = { ...stats, byCommand, startedAt, updatedAt: new Date().toISOString(), stopReason }

    try {
      fs.mkdirSync(options.configDir, { recursive: true })
      fs.writeFileSync(`${statsFile}.tmp`, `${JSON.stringify(body, null, 1)}\n`)
      fs.renameSync(`${statsFile}.tmp`, statsFile)
    } catch (error) {
      options.log(`[control-shadow] cannot write ${statsFile}: ${(error as Error).message}`)
    }
  }

  for (const door of options.doors) {
    door.addObserver((request, decision) => shadow.observe(door.surface, request, decision, { tierOf: id => door.tierOf(id), catalogueReady: door.catalogueReady }))
  }

  shadow.start()
  writeStats()
  options.log(`[control-shadow] on: ${binary}, divergences -> ${file}, counts -> ${statsFile}`)

  return shadow
}

interface Pending {
  surface: ControlSurface
  cmd: string
  command?: string
  ts: ControlDecision
  /** What the shadow was shown (shadow token), to classify a known difference. */
  shown: ControlRequestShape
}

export class ControlShadow {
  private child: ChildProcessWithoutNullStreams | null = null
  private readonly tokens = mintShadowTokens()
  private readonly pending = new Map<number, Pending>()
  private next = 1
  private stopped = false
  private readonly counts = { compared: 0, diverged: 0, known: 0, dropped: 0 }
  private readonly byCommand: ShadowStats['byCommand'] = {}

  constructor(private readonly options: ControlShadowOptions) {}

  start(): void {
    if (this.child || this.stopped) return

    const child = spawn(this.options.binary, ['--contracts', this.options.contracts], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    let stderr = ''

    this.child = child
    child.stderr.on('data', chunk => {
      stderr = (stderr + chunk).slice(-500)
    })
    child.on('error', error => this.stop(`cannot start ${this.options.binary}: ${error.message}`))
    child.on('exit', code => this.stop(`exited with code ${code}${stderr.trim() ? ` (${stderr.trim()})` : ''}`))
    child.stdin.on('error', () => undefined)
    createInterface({ input: child.stdout }).on('line', line => this.answer(line))
    child.stdin.write(`${JSON.stringify({ tokens: this.tokens })}\n`)
  }

  /** The door decided `ts` for this request; hand it to the shadow. Never throws, never waits. */
  observe(surface: ControlSurface, request: ControlRequestShape, ts: ControlDecision, context: { tierOf: (id: string) => ControlTier | undefined; catalogueReady: boolean }): void {
    const child = this.child

    if (!child || this.stopped || !child.stdin.writable) return

    const id = this.next++
    const commandId = commandIdOf(request ?? {})
    const shown = shadowRequest(request, ts.client, this.tokens)

    this.pending.set(id, {
      surface,
      cmd: typeof request?.cmd === 'string' ? request.cmd : '',
      command: typeof request?.command === 'string' ? request.command : undefined,
      ts: { ...ts },
      shown,
    })

    if (this.pending.size > MAX_PENDING) {
      const oldest = this.pending.keys().next().value as number
      this.pending.delete(oldest)
      this.counts.dropped++
    }

    const line = {
      id,
      surface,
      request: shown,
      tier: commandId ? (context.tierOf(commandId) ?? null) : null,
      catalogueReady: context.catalogueReady,
    }

    child.stdin.write(`${JSON.stringify(line)}\n`)
  }

  get stats(): ShadowStats {
    return { running: Boolean(this.child) && !this.stopped, ...this.counts, byCommand: structuredClone(this.byCommand) }
  }

  stop(reason = 'stopped'): void {
    if (this.stopped) return

    this.stopped = true
    this.pending.clear()
    this.child?.kill()
    this.options.onStop?.(reason)
  }

  private answer(line: string): void {
    let reply: { id?: unknown; decision?: Partial<ControlDecision>; error?: string; ready?: boolean }

    try {
      reply = JSON.parse(line)
    } catch {
      return
    }

    if (reply.ready || typeof reply.id !== 'number') return

    const pending = this.pending.get(reply.id)

    if (!pending) return

    this.pending.delete(reply.id)

    const rust = reply.decision ?? { error: reply.error ?? 'no decision' }
    const fields = reply.decision ? diffDecisions(pending.ts, reply.decision) : ['error']
    const outcome = fields.length === 0 ? 'same' : reply.decision && knownDifference(pending.shown, pending.ts, reply.decision) ? 'known' : 'diverged'
    // A cmd is whatever a caller sent: past MAX_COMMAND_KEYS distinct ones the rest share one row, so the counts stay bounded.
    const named = `${pending.surface}:${pending.cmd.trim() || '-'}`
    const key = Object.hasOwn(this.byCommand, named) || Object.keys(this.byCommand).length < MAX_COMMAND_KEYS ? named : `${pending.surface}:(other)`
    this.byCommand[key] ??= { compared: 0, diverged: 0, known: 0, tiers: {} }
    const row = this.byCommand[key]
    // The tier this door decided: what a session's requests were worth (read, act, mutate, destructive).
    const tier = pending.ts.tier ?? 'none'

    row.tiers[tier] = (row.tiers[tier] ?? 0) + 1

    this.counts.compared++
    row.compared++

    if (outcome === 'known') {
      this.counts.known++
      row.known++
    } else if (outcome === 'diverged') {
      this.counts.diverged++
      row.diverged++
      this.options.onDivergence({ at: new Date().toISOString(), surface: pending.surface, cmd: pending.cmd, command: pending.command, fields, ts: pending.ts, rust })
    }

    this.options.onCompared?.()
  }
}
