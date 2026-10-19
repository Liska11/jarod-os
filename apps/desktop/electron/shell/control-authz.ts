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
import { HERALD_EVENT_NAMES } from '../../shared/events.ts'
import { sameToken } from './json-lines.ts'

/**
 * Who is asking. `backend` and `cli` hold a token from this shell; `plugin` is a widget the person
 * enabled and `ui` is one of the shell's own windows, both calling from inside this process — neither
 * has a token, and neither needs one, because `HostControlGate.submitLocal` is the only way in. The
 * gate still asks the person for a plugin's mutation (R2.2); a window's click is the person (R3).
 */
export type ControlClient = 'backend' | 'cli' | 'plugin' | 'ui'

/** The same ladder the renderer's registry uses (src/store/os-commands.ts). */
export type ControlTier = 'read' | 'act' | 'mutate' | 'destructive'

/**
 * Why a request was turned away, in the vocabulary the journal and the caller's error share. The
 * distinction matters to whoever reads the log: `unauthenticated` is a caller without a credential,
 * `unauthorized` had one but asked for the other door's command, `unsupported` asked for a command
 * that no longer exists, and `invalid` reached the right command with the wrong arguments.
 */
export type ControlRefusalCode = 'unauthenticated' | 'unauthorized' | 'unsupported' | 'invalid'

export interface ControlTokens {
  /** Given to the agent backend; drives the command registry in the Hermes window. */
  backend: string
  /** Given to the `herald-os` CLI over a user-only file; drives the shell's own surface. */
  cli: string
}

/** Requests that run a command in the registry inside the Hermes window. */
export const REGISTRY_COMMANDS = new Set(['ui', 'ui-list', 'ui-state'])

/**
 * The commands that run a *named* registry command and say what it is worth: `run` waits for the
 * result and reports it, `list`/`state` read the catalogue and the window state. They replaced
 * `os`/`os-run`, which took the command id as a loose first argument and carried no argument shape.
 */
export const TYPED_REGISTRY_COMMANDS = new Set(['run', 'list', 'state'])

/**
 * Gone, and gone loudly: `herald-os os <id> [json]` and `herald-os os-run <id> [json]`. A caller that
 * still asks for them is told they no longer exist rather than quietly falling through a default
 * branch — the point of R2's typed interface is that the shell refuses to guess what was meant.
 */
export const RETIRED_COMMANDS = new Set(['os', 'os-run'])

/**
 * Everything the desktop server (`main.ts`) serves on its own door: the registry, plus the few shell
 * conveniences it relays. `os`/`os-run` are deliberately absent — they run registry commands, so they
 * are the CLI's door and the backend's token must not open them — and the list is an allow-list, so a
 * command `main` does not serve is refused here instead of reaching the dispatcher's default branch
 * (which would reply `unknown command` after the journal had already recorded an allow).
 */
export const BACKEND_COMMANDS = new Set(['ui', 'ui-list', 'ui-state', 'run', 'list', 'state', 'page', 'notify', 'voice'])

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
  /** The registry command id a typed call names (`ui`, `run`). */
  command?: unknown
  args?: unknown
  source?: unknown
  /** A one-shot capability the host issued for exactly this call. */
  capability?: unknown
  /**
   * The caller's own name for this attempt, so the bridge's journal and the host's can be read
   * together (R2.2). It is not a credential: it authorises nothing, it is never compared to anything,
   * and a request without one is still a request.
   */
  requestId?: unknown
  /** Kept because the shared panel socket carries them; `theme` reads them. */
  attachments?: unknown
  shell?: unknown
  wallpaper?: unknown
  colors?: unknown
}

export interface ControlDecision {
  allowed: boolean
  /** Which token was accepted, `null` when none was. */
  client: ControlClient | null
  reason: string
  /** Resolved from the shell's catalogue when the command is known. */
  tier?: ControlTier
  /** Refusals only: the machine-readable class of the refusal. */
  code?: ControlRefusalCode
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
  /** More values the journal must keep out (R1 invariant 7); the two tokens are always included. */
  secrets?: () => readonly ControlSecret[]
}

/** A value this process holds right now that the journal must never contain, and what it is called there. */
export interface ControlSecret {
  kind: 'token' | 'capability' | 'nonce'
  value: string
}

/** Longest free-text field the journal keeps; the rest is cut before scanning, so nothing escapes the scan. */
const JOURNAL_FIELD_MAX = 4096
const SECRET_RUN = /[A-Za-z0-9_-]+/g
const MIN_SECRET_LENGTH = 8

/**
 * Replace every active secret of this process found in `text` by `[REDACTED:<kind>]`.
 *
 * Only values the process actually holds are masked, compared by sha256 digest with `timingSafeEqual`,
 * so nothing is guessed from the shape of a string and a legitimate long id is never touched. Windows
 * are tried only inside runs of token characters, at the lengths of the live values, which keeps the
 * scan linear in the field size. A capability contains its own nonce; the longer match wins.
 */
export function redactSecrets(text: string, secrets: readonly ControlSecret[]): string {
  const live = secrets.filter(secret => typeof secret.value === 'string' && secret.value.length >= MIN_SECRET_LENGTH)

  if (!text || live.length === 0) {
    return text
  }

  const bounded = text.length > JOURNAL_FIELD_MAX ? `${text.slice(0, JOURNAL_FIELD_MAX)}…[cut]` : text
  const digest = (value: string) => crypto.createHash('sha256').update(value).digest()
  const byLength = new Map<number, Array<{ kind: ControlSecret['kind']; hash: Buffer }>>()

  for (const secret of live) {
    const group = byLength.get(secret.value.length) ?? []

    group.push({ kind: secret.kind, hash: digest(secret.value) })
    byLength.set(secret.value.length, group)
  }

  const found: Array<{ start: number; end: number; kind: ControlSecret['kind'] }> = []

  for (const run of bounded.matchAll(SECRET_RUN)) {
    const base = run.index ?? 0

    for (const [length, group] of byLength) {
      for (let at = 0; at + length <= run[0].length; at += 1) {
        const window = digest(run[0].slice(at, at + length))
        let matched: ControlSecret['kind'] | undefined

        for (const candidate of group) {
          if (crypto.timingSafeEqual(window, candidate.hash)) {
            matched = candidate.kind
          }
        }

        if (matched) {
          found.push({ start: base + at, end: base + at + length, kind: matched })
        }
      }
    }
  }

  if (found.length === 0) {
    return bounded
  }

  found.sort((a, b) => a.start - b.start || b.end - a.end)

  let out = ''
  let cursor = 0

  for (const hit of found) {
    if (hit.start < cursor) {
      continue
    }

    out += `${bounded.slice(cursor, hit.start)}[REDACTED:${hit.kind}]`
    cursor = hit.end
  }

  return out + bounded.slice(cursor)
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
  /** The outcome's machine-readable class (`ok`, `approval-denied`, `capability-replayed`, …). */
  code?: string
  /** An approval this attempt came from, as a fingerprint — never the capability itself. */
  approval?: string
  /** The caller's name for the attempt, so both journals can be read together (never a secret). */
  requestId?: string
  /** Which door: the shared panel socket, or the desktop server the backend dials. */
  surface?: ControlSurface
}

/**
 * What one shell command is worth, and what a well-formed request for it looks like.
 *
 * The tier is the whole point: `read` and `act` are what a caller may do with a credential alone,
 * `mutate` and `destructive` additionally need the host to have witnessed an approval (see
 * shell/host-control.ts). The validator is deliberately shallow — the dispatcher below still has to
 * defend itself — but it runs *before* the dispatcher, so a malformed request is refused and
 * journalled as such instead of reaching a handler that assumes it was checked.
 */
export interface ShellCommandSpec {
  tier: ControlTier | ((request: ControlRequestShape) => ControlTier)
  validate?: (request: ControlRequestShape) => string | undefined
}

function stringArgs(request: ControlRequestShape): string[] {
  return Array.isArray(request.args) ? request.args.filter((arg): arg is string => typeof arg === 'string') : []
}

function pluginAction(request: ControlRequestShape): string {
  return stringArgs(request)[0] ?? 'list'
}

function brandingAction(request: ControlRequestShape): string {
  return stringArgs(request)[0] ?? 'show'
}

function voiceAction(request: ControlRequestShape): string | undefined {
  const [action] = stringArgs(request)

  return action ?? 'toggle'
}

function requiresTarget(request: ControlRequestShape, command: string): string | undefined {
  const [, target] = stringArgs(request)

  return target ? undefined : `${command} needs a target`
}

/**
 * The shell's own surface: everything `herald-os` may ask for, classified. A command that is not in
 * this table is refused by the policy rather than forwarded, so the table is also the allow-list.
 */
export const SHELL_COMMANDS: ReadonlyMap<string, ShellCommandSpec> = new Map<string, ShellCommandSpec>([
  // Reading: no side effect beyond answering.
  ['state', { tier: 'read' }],
  ['menu-check', { tier: 'read' }],
  ['list', { tier: 'read' }],
  ['ui-list', { tier: 'read' }],
  ['ui-state', { tier: 'read' }],

  // Acting: opens things, tells the window what to do, changes nothing that outlives the session.
  ['page', { tier: 'act', validate: request => (stringArgs(request)[0] ? undefined : 'page needs an id') }],
  ['open', { tier: 'act', validate: request => (stringArgs(request)[0] ? undefined : 'open needs an app id') }],
  ['launch', { tier: 'act', validate: request => (stringArgs(request).length ? undefined : 'launch needs an application name') }],
  ['notify', { tier: 'act', validate: request => (stringArgs(request).length ? undefined : 'notify needs a message') }],
  ['dictate', { tier: 'act' }],
  [
    'voice',
    {
      tier: 'act',
      validate: request => (['toggle', 'start', 'stop', 'mute'].includes(voiceAction(request) ?? '') ? undefined : 'voice needs toggle | start | stop | mute'),
    },
  ],
  ['update-available', { tier: 'act' }],
  ['switches', { tier: 'act' }],
  ['screensaver', { tier: 'act' }],
  [
    'panel',
    {
      tier: 'act',
      validate: request =>
        ['wifi', 'bluetooth', 'audio', 'display', 'power', 'clock'].includes(stringArgs(request)[0] ?? '')
          ? undefined
          : 'panel needs wifi, bluetooth, audio, display, power or clock',
    },
  ],
  [
    'event',
    {
      tier: 'act',
      validate: request => {
        const [name] = stringArgs(request)

        return name && (HERALD_EVENT_NAMES as readonly string[]).includes(name) ? undefined : `unknown event ${name ?? ''}`
      },
    },
  ],
  // The command overlay, in each of its modes: `herald-os ask …` and friends, CLI-only.
  ...['ask', 'command', 'applications', 'menu', 'power', 'clipboard', 'emoji'].map(
    (mode): [string, ShellCommandSpec] => [mode, { tier: 'act' }]
  ),

  // Mutating: writes preferences, files or plugin state.
  [
    'webapp',
    {
      tier: 'mutate',
      validate: request => {
        const [url, name] = stringArgs(request)

        if (!url || !/^https?:\/\//i.test(url)) {
          return 'webapp needs an http(s) url and a name'
        }

        return name ? undefined : 'webapp needs an http(s) url and a name'
      },
    },
  ],
  ['wallpaper', { tier: 'mutate' }],
  ['theme', { tier: 'mutate', validate: request => (stringArgs(request)[0] ? undefined : 'theme needs a name') }],
  ['theme-omarchy', { tier: 'mutate' }],
  [
    'branding',
    {
      tier: request => (['set', 'reset'].includes(brandingAction(request)) ? 'mutate' : 'read'),
      validate: request => {
        const [action, value] = stringArgs(request)

        if (!['show', 'set', 'reset'].includes(action ?? 'show')) {
          return 'branding show | set <json> | reset [all|logo|lock|name]'
        }

        if (action === 'set') {
          try {
            const patch = JSON.parse(value || '{}') as unknown

            return patch && typeof patch === 'object' && !Array.isArray(patch) ? undefined : 'branding set needs a JSON object'
          } catch {
            return 'branding set needs a JSON object'
          }
        }

        if (action === 'reset' && value && !['all', 'logo', 'lock', 'name'].includes(value)) {
          return 'branding reset [all|logo|lock|name]'
        }

        return undefined
      },
    },
  ],
  [
    'plugin',
    {
      tier: request => {
        const action = pluginAction(request)

        if (action === 'remove') {
          return 'destructive'
        }

        return action === 'list' ? 'read' : 'mutate'
      },
      validate: request => {
        const action = pluginAction(request)

        if (!['list', 'add', 'enable', 'disable', 'update', 'remove'].includes(action)) {
          return 'plugin list | add <url> | enable <id> | disable <id> | update <id> | remove <id>'
        }

        if (action === 'add') {
          const [, url] = stringArgs(request)

          if (!url || !/^(https?:\/\/|git@|ssh:\/\/)/i.test(url)) {
            return 'plugin add needs a repository url'
          }
        }

        if (action !== 'list' && action !== 'add') {
          return requiresTarget(request, `plugin ${action}`)
        }

        return undefined
      },
    },
  ],
])

function specOf(cmd: string): ShellCommandSpec | undefined {
  return SHELL_COMMANDS.get(cmd)
}

/** The tier a shell command is worth for this request, from the table's rule or its constant. */
export function shellTier(cmd: string, request: ControlRequestShape): ControlTier | undefined {
  const spec = specOf(cmd)

  if (!spec) {
    return undefined
  }

  return typeof spec.tier === 'function' ? spec.tier(request) : spec.tier
}

/** What is wrong with this request for this command, or `undefined` when it is well formed. */
export function shellArgumentProblem(cmd: string, request: ControlRequestShape): string | undefined {
  return specOf(cmd)?.validate?.(request)
}

/** Every command the shell's own surface accepts; the policy's allow-list, for tests and callers. */
export function shellCommandNames(): string[] {
  return [...SHELL_COMMANDS.keys()]
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
export function controlAuditSink(filePath: string, limit = 8 * 1024 * 1024): (entry: ControlAuditEntry) => void {
  return entry => {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })

      // Bounded like the host's own journal: past the limit the file becomes <name>.1 (one older generation).
      if (fs.existsSync(filePath) && fs.statSync(filePath).size >= limit) {
        fs.rmSync(`${filePath}.1`, { force: true })
        fs.renameSync(filePath, `${filePath}.1`)
      }

      fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, { mode: 0o600 })
    } catch {
      // An unwritable journal is a gap in the record, never a reason to permit or deny anything.
    }
  }
}

export function asControlTier(value: unknown): ControlTier | undefined {
  return TIERS.includes(value as ControlTier) ? (value as ControlTier) : undefined
}

export function commandIdOf(request: ControlRequestShape): string {
  return typeof request.command === 'string' ? request.command.trim() : ''
}

/** What a request id may look like. Long enough to be unique, short enough to read in a journal. */
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/

/** The caller's own name for this attempt, or `''` when it sent none (R2.2). */
export function requestIdOf(request: ControlRequestShape): string {
  return typeof request.requestId === 'string' ? request.requestId.trim() : ''
}

/**
 * `undefined` when the id is absent or well formed, otherwise why it cannot be used.
 *
 * An id is not a credential, so a bad one is not a security event — but it is still a client that
 * disagrees with the protocol, and a promise to correlate two journals is worth refusing a malformed
 * attempt over rather than writing a line no one can join to anything.
 */
export function requestIdProblem(request: ControlRequestShape): string | undefined {
  const id = requestIdOf(request)

  if (!id) {
    return undefined
  }

  return REQUEST_ID.test(id) ? undefined : 'a requestId is a short opaque string, not a secret'
}

/**
 * The authorization decision for one control request. Pure: same request and context, same answer.
 *
 * R2 tightened what "allowed" means: a command the shell does not know is refused *here*, by the
 * policy, instead of being handed to a dispatcher whose default branch would answer `unknown command`
 * after the journal had already recorded an allow. The tiers are the pairs the rest of the pipeline
 * reads: `read`/`act` are satisfied by a credential, `mutate`/`destructive` are not.
 */
export function adjudicate(request: ControlRequestShape, context: ControlContext): ControlDecision {
  const cmd = typeof request?.cmd === 'string' ? request.cmd.trim() : ''

  if (!cmd) {
    return { allowed: false, client: null, code: 'invalid', reason: 'a control request needs a cmd' }
  }

  const asBackend = sameToken(request.token, context.tokens.backend)
  const asCli = asBackend ? false : sameToken(request.token, context.tokens.cli)

  if (!asBackend && !asCli) {
    return { allowed: false, client: null, code: 'unauthenticated', reason: 'invalid control token' }
  }

  const client: ControlClient = asBackend ? 'backend' : 'cli'

  // The loose `os`/`os-run` interface is gone on every door, and says so: a caller that still sends it
  // is asking for something the shell no longer implements, not for something it is not allowed.
  if (RETIRED_COMMANDS.has(cmd)) {
    return { allowed: false, client, code: 'unsupported', reason: `${cmd} was replaced by run/list/state` }
  }

  if ((context.surface ?? 'panel') === 'backend') {
    if (!asBackend) {
      return { allowed: false, client, code: 'unauthorized', reason: 'the backend shell surface needs the backend token' }
    }

    if (!BACKEND_COMMANDS.has(cmd)) {
      // Everything `main` does not serve, retired commands included: this surface is an allow-list, so
      // a command it does not know is refused by the policy rather than by the dispatcher afterwards.
      return { allowed: false, client, code: 'unsupported', reason: `unknown command ${cmd} on the backend shell surface` }
    }

    if (cmd === 'run') {
      const id = commandIdOf(request)

      if (!id) {
        return { allowed: false, client, code: 'invalid', reason: 'run needs a command id' }
      }

      const tier = context.tierOf?.(id)

      if (tier === undefined && context.catalogueReady) {
        return { allowed: false, client, code: 'unsupported', reason: `unknown command ${id}` }
      }

      return { allowed: true, client, reason: `run runs ${id}`, tier }
    }

    if (cmd === 'list' || cmd === 'state') {
      return { allowed: true, client, reason: `${cmd} reads the command registry`, tier: 'read' }
    }

    const id = commandIdOf(request)

    return {
      allowed: true,
      client,
      reason: `${cmd} on the backend shell surface`,
      tier: REGISTRY_COMMANDS.has(cmd) ? (id ? context.tierOf?.(id) : undefined) : shellTier(cmd, request),
    }
  }

  if (REGISTRY_COMMANDS.has(cmd)) {
    if (!asBackend) {
      return { allowed: false, client, code: 'unauthorized', reason: `the ${cmd} command needs the backend token` }
    }

    const id = commandIdOf(request)

    return { allowed: true, client, reason: `${cmd} runs in the command registry`, tier: id ? context.tierOf?.(id) : undefined }
  }

  // Everything below is the CLI's own surface. The backend token does not open it: the agent's path to
  // the registry is `ui`, and a shell command is the person at the keyboard.
  if (!asCli) {
    return { allowed: false, client, code: 'unauthorized', reason: `the ${cmd} command needs the CLI token` }
  }

  if (cmd === 'list' || cmd === 'state') {
    return { allowed: true, client, reason: `${cmd} reads the command registry`, tier: 'read' }
  }

  if (cmd === 'run') {
    const id = commandIdOf(request)

    if (!id) {
      return { allowed: false, client, code: 'invalid', reason: 'run needs a command id' }
    }

    const tier = context.tierOf?.(id)

    if (tier === undefined && context.catalogueReady) {
      return { allowed: false, client, code: 'unsupported', reason: `unknown command ${id}` }
    }

    return { allowed: true, client, reason: `run runs ${id}`, tier }
  }

  if (!specOf(cmd)) {
    return { allowed: false, client, code: 'unsupported', reason: `unknown command ${cmd}` }
  }

  return { allowed: true, client, reason: `${cmd} is a shell command`, tier: shellTier(cmd, request) }
}

/**
 * The shell's side of the policy: decide, and record that you decided.
 *
 * Nothing consults the record to make a decision, so a failing audit sink can never widen access —
 * it is a journal, not a switch.
 */
export class ControlSecurity {
  private context: ControlContext
  private readonly secretSources: Array<() => readonly ControlSecret[]> = []

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

  /** Another holder of live values (the capability store, the pipe nonce) the journal must keep out. */
  addSecretSource(source: () => readonly ControlSecret[]): void {
    this.secretSources.push(source)
  }

  private activeSecrets(): ControlSecret[] {
    return [
      { kind: 'token', value: this.context.tokens.backend },
      { kind: 'token', value: this.context.tokens.cli },
      ...(this.context.secrets?.() ?? []),
      ...this.secretSources.flatMap(source => source()),
    ]
  }

  /** Which door this instance guards, for the journal. */
  get surface(): ControlSurface {
    return this.context.surface ?? 'panel'
  }

  /** What the catalogue says this command id is worth, once the renderer has registered it. */
  tierOf(command: string): ControlTier | undefined {
    return this.context.tierOf?.(command)
  }

  /** Whether the catalogue is worth consulting: an empty one right after launch is not evidence. */
  get catalogueReady(): boolean {
    return this.context.catalogueReady === true
  }

  /** The renderer finished registering its catalogue: `run` can be checked against it. */
  setCatalogue(tierOf: (command: string) => ControlTier | undefined): void {
    this.context = { ...this.context, tierOf, catalogueReady: true }
  }

  /**
   * A line that never became a request: valid JSON is required before a token, a command or a caller
   * can be named. There is no one to attribute it to and nothing was decided, but the attempt is
   * still written down — with no trace of the line itself, which may well have carried a token.
   */
  malformed(reason: string): void {
    this.record({ client: 'unauthenticated', cmd: '', allowed: false, code: 'invalid', reason })
  }

  /** Decide without writing anything: the pipeline records once, with the outcome it reached. */
  adjudicateOnly(request: ControlRequestShape): ControlDecision {
    return adjudicate(request, this.context)
  }

  /** One line in the journal. `code` and `approval` are the pipeline's, not the adjudicator's. */
  record(entry: Omit<ControlAuditEntry, 'at'> & { at?: string }): void {
    const secrets = this.activeSecrets()
    const clean = (value: string | undefined) => (value === undefined ? undefined : redactSecrets(value, secrets))
    const requestId = entry.requestId ? redactSecrets(entry.requestId, secrets) : undefined

    this.audit({
      at: entry.at ?? this.now().toISOString(),
      client: entry.client,
      cmd: clean(entry.cmd) ?? '',
      command: clean(entry.command) || undefined,
      tier: entry.tier,
      source: clean(entry.source),
      allowed: entry.allowed,
      reason: clean(entry.reason) ?? '',
      code: entry.code,
      approval: entry.approval,
      // Only a well-formed name is journalled: a value that cannot be an id does not get written
      // down, so an attempt that put something secret in the id field cannot leak it here (R2.2).
      // A redacted id no longer matches the pattern, so it is dropped rather than half-kept.
      requestId: requestId && REQUEST_ID.test(requestId) ? requestId : undefined,
      surface: entry.surface ?? this.surface,
    })
  }

  check(request: ControlRequestShape): ControlDecision {
    const decision = this.adjudicateOnly(request)
    const cmd = typeof request?.cmd === 'string' ? request.cmd : ''
    const command = typeof request?.command === 'string' ? request.command : undefined

    this.record({
      client: decision.client ?? 'unauthenticated',
      cmd,
      command,
      tier: decision.tier,
      source: typeof request?.source === 'string' && request.source ? request.source : undefined,
      allowed: decision.allowed,
      reason: decision.reason,
      code: decision.allowed ? undefined : (decision.code ?? 'unauthorized'),
      requestId: requestIdOf(request),
    })

    return decision
  }
}

export interface ControlEndpointInput {
  platform: NodeJS.Platform
  runtimeDir: string
  dataDir: string
  /**
   * Sixteen lowercase hex characters, drawn once per run (`main.ts`), that make the pipe name
   * unpredictable. Omit it and the name is the profile digest instead — the shape every unix socket
   * and the existing tests expect.
   */
  nonce?: string
}

export interface ControlEndpoint {
  /** How the bridge should reach the shell: a Windows named pipe, or a unix socket path. */
  kind: 'pipe' | 'unix'
  /** What the backend is told to connect to (`JAROD_OS_CONTROL_SOCKET`). */
  endpoint: string
  /** What the host itself listens on. */
  path: string
}

/**
 * Where the control plane listens.
 *
 * Windows gets a named pipe rather than a loopback TCP port: a port is dialable by anything on the
 * machine (and was announced to the backend as `tcp://127.0.0.1:<port>`, token and all), while a
 * pipe is not a network surface. The token still stands as the credential: the pipe narrows who can
 * knock, it does not replace the lock.
 *
 * What the pipe's access control really is, measured rather than assumed (R2.3,
 * `scripts/probe-pipe-acl.mjs`): the app passes no security descriptor — Node has no parameter for
 * one — so libuv creates the pipe with the creating token's *default* DACL. On an interactive token
 * that is `FA` for SYSTEM, Administrators and the creating user, and `FR` (read only) for Everyone
 * and Anonymous. Only a principal with a write bit can send a request, so no other user is granted a
 * useful connection, but the read-only ACEs are wider than this door needs. `pipe-security.ts`
 * states the real policy immediately after the object exists and refuses to serve until it has read
 * that policy back; the object's initial DACL is not a policy and is measured as such
 * (`pipe-security.test.ts` compares it, ACE for ACE, to the token's own default DACL).
 *
 * `nonce` closes what that measurement exposes: a name derived from the profile directories is one
 * any local process can compute and claim *before* the shell does. `FILE_FLAG_FIRST_PIPE_INSTANCE`
 * only refuses a claimant that also asks to be first, and an implicit DACL is in place for the
 * moment between `listen` and the read-back. With a per-run nonce the shell is the only party that
 * knows the name until it publishes it — and `main.ts` publishes it to the backend only after the
 * DACL has been verified.
 */
export function controlEndpoint(input: ControlEndpointInput): ControlEndpoint {
  if (input.platform === 'win32') {
    const name = `herald-os-${pipeNameSuffix(input)}`

    return { kind: 'pipe', endpoint: `pipe://${name}`, path: `\\\\.\\pipe\\${name}` }
  }

  // This path only ever names a unix socket, so join it the way its own filesystem would: a runtime
  // dir of `/run/user/1000` must not become `\run\user\1000` because the shell reading it is on Windows.
  const socketPath = path.posix.join(input.runtimeDir, 'herald-os', 'control.sock')

  return { kind: 'unix', endpoint: socketPath, path: socketPath }
}

/**
 * The per-run half of a pipe name: the caller's nonce when there is one, the profile digest
 * otherwise. The nonce is validated rather than trusted — a caller that passed a name, a path
 * separator or an empty string would otherwise choose part of the pipe path itself.
 */
function pipeNameSuffix(input: ControlEndpointInput): string {
  if (input.nonce === undefined) {
    return crypto.createHash('sha256').update(`${input.dataDir}\u0000${input.runtimeDir}`).digest('hex').slice(0, 16)
  }

  const nonce = String(input.nonce).trim()

  if (!/^[0-9a-f]{16}$/.test(nonce)) {
    throw new Error('a pipe nonce must be exactly 16 lowercase hexadecimal characters')
  }

  return nonce
}
