/**
 * The one place a control request turns into an action.
 *
 * R1 gave the shell two credentials and a refusal, which is enough to say *who* is asking. R2 asks the
 * harder question — *may this exact action happen, once, now?* — and the answer cannot be a token: a
 * token can be copied, held, and replayed, and a caller that holds one is not the same as a caller the
 * person at the keyboard just agreed with.
 *
 * So the pipeline is:
 *
 *   shape      → is this a request for a command the shell knows, with the argument shape that
 *                command takes? (`control-authz.ts` owns the table and the tiers.)
 *   identity   → which token, and does it open this door?
 *   capability → for `mutate`/`destructive`, did the *host itself* witness an approval for this call,
 *                is the capability unspent and unexpired, and does it bind these exact arguments?
 *   execute    → the caller's dispatcher runs it, then reports the outcome back here to be journalled.
 *
 * Every path ends in exactly one journal line, with a machine-readable `code`. The arguments are never
 * written down — only that a call happened, what it was worth, and how it ended.
 */

import type {
  ControlClient,
  ControlRequestShape,
  ControlSecurity,
  ControlTier,
} from './control-authz.ts'
import { commandIdOf, shellArgumentProblem } from './control-authz.ts'
import { CapabilityStore, capabilityFingerprint, type CapabilityRecord } from './control-capability.ts'

/** How a request ended, in the vocabulary the caller, the journal and the tests share. */
export type HostCode =
  | 'ok'
  | 'unauthenticated'
  | 'unauthorized'
  | 'unsupported'
  | 'invalid'
  | 'execution-failed'
  | 'denied-policy'
  | 'denied-approval'
  | 'expired'
  | 'replay'
  /** Extra, beyond the shared minimum: an approval was witnessed and a capability was minted. */
  | 'approval-granted'
  | 'capability-unavailable'
  | 'capability-mismatch'

export interface HostReply {
  ok: boolean
  code: HostCode
  error?: string
  summary?: string
  data?: unknown
  /** `approval-granted`: the one-shot credential to send back with the same call. */
  capability?: { id: string; expiresAt: number; binding: string }
}

/** One call, past validation, on its way to the caller's dispatcher. */
export interface HostCall {
  client: ControlClient
  tier: ControlTier
  /** The wire command (`run`, `theme`, `ui`, …). */
  cmd: string
  /** The caller's own label for the journal; never trusted for a decision. */
  source?: string
  /** The call's canonical name: `registry:<id>` or `shell:<cmd>`. */
  command: string
  /** The registry command id, for registry calls. */
  id?: string
  /** Validated parameters: an object for registry calls, a string array for shell commands. */
  args: unknown
}

export interface ApprovalAsk {
  id: string
  client: ControlClient
  tier: ControlTier
  command: string
  source?: string
  /** One line for the person reading it: what is about to happen. */
  summary: string
  /** A short preview of the arguments, for the same person; never journalled. */
  preview?: string
}

/** The host's way of asking a person. Returning false, throwing, or never answering denies. */
export type ApprovalProvider = (ask: ApprovalAsk) => Promise<boolean> | boolean

/** Handed to the caller so it can run the call and then say how it went. */
export interface HostTicket {
  kind: 'execute'
  call: HostCall
  /** Ends this request: one journal line, `ok` unless the caller says otherwise. */
  finish(outcome?: { ok?: boolean; code?: string; reason?: string; summary?: string }): void
}

export type HostGateResult = { kind: 'reply'; reply: HostReply } | HostTicket

/** The argument shape a registry command declares in the renderer's catalogue. */
export interface RegistryArgSpec {
  name: string
  type?: string
  required?: boolean
  enum?: readonly string[]
}

export interface CatalogueEntry {
  id: string
  tier?: string
  args?: readonly RegistryArgSpec[]
}

export interface HostControlOptions {
  security: ControlSecurity
  /** Absent means no mutation can be approved — and so none can run. */
  approve?: ApprovalProvider
  now?: () => number
  capabilityTtlMs?: number
  maxCapabilities?: number
  /** A dialog that never answers would otherwise hold a request forever. */
  approvalTimeoutMs?: number
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(value, key)
}

/** Registry calls carry their parameters as an object; shell commands carry positional strings. */
function takesObjectArgs(cmd: string): boolean {
  return cmd === 'run' || cmd === 'ui'
}

/**
 * Everything that changes what a call does, for the capability binding: the command's own parameters
 * and the extra fields the panel socket carries for `theme`. Provenance (`source`) is not behaviour
 * and is deliberately excluded — renaming the caller must not invalidate an approval, and changing an
 * argument must.
 */
export function bindingArgumentsOf(request: ControlRequestShape): unknown {
  return {
    command: typeof request.command === 'string' ? request.command : undefined,
    args: request.args ?? null,
    attachments: request.attachments ?? null,
    shell: request.shell ?? null,
    wallpaper: request.wallpaper ?? null,
    colors: request.colors ?? null,
  }
}

export class HostControlGate {
  /**
   * Capabilities live outside the class so a `HostControlGate` can be rebuilt (a new door, a new
   * surface) without forgetting what was already approved. Inside this process, nothing else can
   * mint one: there is no IPC, no command and no file that grants a capability (R2's phase 4).
   */
  private readonly capabilities: CapabilityStore
  private readonly schemas = new Map<string, readonly RegistryArgSpec[]>()
  private readonly approvalTimeoutMs: number

  constructor(private readonly options: HostControlOptions) {
    this.capabilities = new CapabilityStore({
      now: options.now,
      ttlMs: options.capabilityTtlMs,
      max: options.maxCapabilities,
    })
    this.approvalTimeoutMs = options.approvalTimeoutMs ?? 60_000
  }

  /** The catalogue the renderer registered: ids, tiers (via the security) and argument shapes. */
  setCatalogue(entries: readonly CatalogueEntry[]): void {
    this.schemas.clear()

    for (const entry of entries) {
      if (entry?.id && Array.isArray(entry.args)) {
        this.schemas.set(entry.id, entry.args)
      }
    }
  }

  /** For tests and diagnostics: how many approvals are waiting to be spent. */
  get pendingCapabilities(): number {
    return this.capabilities.size
  }

  /** The identity policy behind this gate, for the doors that journal a malformed line themselves. */
  get security(): ControlSecurity {
    return this.options.security
  }

  async submit(request: ControlRequestShape): Promise<HostGateResult> {
    const { security } = this.options
    const decision = security.adjudicateOnly(request)
    const cmd = typeof request?.cmd === 'string' ? request.cmd.trim() : ''
    const source = typeof request?.source === 'string' && request.source ? request.source : undefined
    const command = typeof request?.command === 'string' ? request.command.trim() : ''

    const refuse = (code: HostCode, reason: string): HostGateResult => {
      security.record({
        client: decision.client ?? 'unauthenticated',
        cmd,
        command,
        tier: decision.tier,
        source,
        allowed: false,
        code,
        reason,
      })

      return { kind: 'reply', reply: { ok: false, code, error: reason } }
    }

    if (!decision.allowed) {
      return refuse(decision.code ?? 'unauthorized', decision.reason)
    }

    const client = decision.client as ControlClient
    const registryCall = takesObjectArgs(cmd)
    const problem = this.validate(cmd, request, decision.tier)

    if (problem) {
      return refuse('invalid', problem)
    }

    const id = registryCall ? commandIdOf(request) : undefined
    const call: HostCall = {
      client,
      tier: decision.tier ?? 'act',
      cmd,
      source,
      command: id ? `registry:${id}` : `shell:${cmd}`,
      id,
      args: registryCall ? (request.args ?? {}) : (Array.isArray(request.args) ? request.args : []),
    }

    // The catalogue decides what a registry command is worth. Until it is loaded nothing is known
    // about the id, and an unknown command is not a small risk: the request waits, rather than
    // guessing a tier and running something the shell cannot classify.
    if (registryCall && id && decision.tier === undefined) {
      return refuse('unsupported', `unknown command ${id}`)
    }

    if (call.tier !== 'mutate' && call.tier !== 'destructive') {
      return this.ticket(call)
    }

    return this.withApproval(request, call)
  }

  /** Shape and argument validation, before any credential is spent on it. */
  private validate(cmd: string, request: ControlRequestShape, tier?: ControlTier): string | undefined {
    if (request.args !== undefined) {
      if (takesObjectArgs(cmd)) {
        if (!isPlainObject(request.args)) {
          return `${cmd} takes its arguments as a JSON object`
        }
      } else if (!Array.isArray(request.args) || request.args.some(arg => typeof arg !== 'string')) {
        return `${cmd} takes its arguments as a list of strings`
      }
    }

    if (request.token !== undefined && typeof request.token !== 'string') {
      return 'a token is a string'
    }

    if (request.capability !== undefined && typeof request.capability !== 'string') {
      return 'a capability is a string'
    }

    if (takesObjectArgs(cmd)) {
      const id = commandIdOf(request)

      if (id && tier !== undefined) {
        const problem = this.validateRegistryArgs(id, request.args, tier)

        if (problem) {
          return problem
        }
      }

      return undefined
    }

    return shellArgumentProblem(cmd, request)
  }

  /**
   * A registry command's declared arguments. Declared keys are checked for type and enum; a key the
   * catalogue does not declare is refused for `mutate`/`destructive` (an unexpected argument is
   * exactly how a command does something other than what it says) and recorded but tolerated for
   * `read`/`act`, so a command whose catalogue is thinner than its implementation still works.
   */
  private validateRegistryArgs(id: string, args: unknown, tier: ControlTier): string | undefined {
    const declared = this.schemas.get(id)

    if (!declared) {
      // No schema to check against: nothing declared, nothing to say.
      return undefined
    }

    const params = isPlainObject(args) ? args : {}
    const known = new Set(declared.map(spec => spec.name))

    for (const spec of declared) {
      const present = hasOwn(params, spec.name)

      if (!present) {
        if (spec.required) {
          return `${id} needs ${spec.name}`
        }

        continue
      }

      const value = params[spec.name]

      if (spec.type === 'string' && typeof value !== 'string') {
        return `${id} takes ${spec.name} as a string`
      }

      if (spec.type === 'number' && typeof value !== 'number') {
        return `${id} takes ${spec.name} as a number`
      }

      if (spec.type === 'boolean' && typeof value !== 'boolean') {
        return `${id} takes ${spec.name} as a boolean`
      }

      if (Array.isArray(spec.enum) && !spec.enum.includes(value as string)) {
        return `${id} takes ${spec.name} as one of ${spec.enum.join(', ')}`
      }
    }

    if (tier === 'mutate' || tier === 'destructive') {
      for (const key of Object.keys(params)) {
        if (!known.has(key)) {
          return `${id} does not take ${key}`
        }
      }
    }

    return undefined
  }

  /**
   * The `mutate`/`destructive` path. A capability that checks out is spent *before* the call runs, so
   * a crash, a hang or a second attempt cannot turn one approval into two actions.
   */
  private async withApproval(request: ControlRequestShape, call: HostCall): Promise<HostGateResult> {
    const { security, approve } = this.options
    const presented = typeof request.capability === 'string' ? request.capability.trim() : ''

    if (presented) {
      const check = this.capabilities.verify({ id: presented, command: call.command, args: bindingArgumentsOf(request) })

      if (check.outcome !== 'ok' || !check.record) {
        const code: HostCode = check.outcome === 'expired' ? 'expired' : check.outcome === 'mismatch' || check.outcome === 'malformed' ? 'capability-mismatch' : check.outcome === 'replayed' ? 'replay' : 'capability-unavailable'

        security.record({
          client: call.client,
          cmd: call.cmd,
          command: call.id ?? call.command,
          tier: call.tier,
          source: call.source,
          allowed: false,
          code,
          approval: check.record ? capabilityFingerprint(check.record) : undefined,
          reason: check.reason,
        })

        return {
          kind: 'reply',
          reply: { ok: false, code, error: `${check.reason}; ask again without a capability to be approved` },
        }
      }

      this.capabilities.consume(check.record)

      return this.ticket(call, check.record)
    }

    if (!approve) {
      security.record({
        client: call.client,
        cmd: call.cmd,
        command: call.id ?? call.command,
        tier: call.tier,
        source: call.source,
        allowed: false,
        code: 'denied-policy',
        reason: 'this shell has no way to ask for approval, so a mutation cannot be authorised',
      })

      return { kind: 'reply', reply: { ok: false, code: 'denied-policy', error: 'no approval channel is available' } }
    }

    const ask: ApprovalAsk = {
      id: `ask_${call.command}_${Date.now().toString(36)}`,
      client: call.client,
      tier: call.tier,
      command: call.command,
      source: call.source,
      summary: describeCall(call),
      preview: previewOf(bindingArgumentsOf(request)),
    }

    let approved = false

    try {
      approved = await withTimeout(Promise.resolve(approve(ask)), this.approvalTimeoutMs)
    } catch {
      approved = false
    }

    if (!approved) {
      security.record({
        client: call.client,
        cmd: call.cmd,
        command: call.id ?? call.command,
        tier: call.tier,
        source: call.source,
        allowed: false,
        code: 'denied-approval',
        reason: `the ${call.tier} command ${call.command} was not approved`,
      })

      return { kind: 'reply', reply: { ok: false, code: 'denied-approval', error: 'the request was not approved' } }
    }

    const record = this.capabilities.grant({ command: call.command, args: bindingArgumentsOf(request), approvalId: ask.id })

    security.record({
      client: call.client,
      cmd: call.cmd,
      command: call.id ?? call.command,
      tier: call.tier,
      source: call.source,
      allowed: true,
      code: 'approval-granted',
      approval: capabilityFingerprint(record),
      reason: `approved ${call.command}; send it again with the capability to spend it once`,
    })

    return {
      kind: 'reply',
      reply: {
        ok: false,
        code: 'approval-granted',
        error: 'approved: send the same call again with the capability',
        capability: { id: record.id, expiresAt: record.expiresAt, binding: record.binding },
      },
    }
  }

  private ticket(call: HostCall, capability?: CapabilityRecord): HostTicket {
    const { security } = this.options

    return {
      kind: 'execute',
      call,
      finish: outcome => {
        const ok = outcome?.ok !== false

        security.record({
          client: call.client,
          cmd: call.cmd,
          command: call.id ?? call.command,
          tier: call.tier,
          source: call.source,
          allowed: ok,
          code: outcome?.code ?? (ok ? 'ok' : 'execution-failed'),
          approval: capability ? capabilityFingerprint(capability) : undefined,
          reason: outcome?.reason ?? outcome?.summary ?? describeCall(call),
        })
      },
    }
  }
}

function describeCall(call: HostCall): string {
  if (call.id) {
    return call.tier === 'read' ? `read ${call.id}` : `${call.tier} ${call.id}`
  }

  return `${call.tier} ${call.cmd}`
}

function previewOf(value: unknown): string | undefined {
  try {
    const text = JSON.stringify(value)

    return text === undefined ? undefined : text.length > 200 ? `${text.slice(0, 200)}…` : text
  } catch {
    return undefined
  }
}

async function withTimeout(work: Promise<boolean>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined

  try {
    return await Promise.race([
      work,
      new Promise<boolean>(resolve => {
        timer = setTimeout(() => resolve(false), ms)
      }),
    ])
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}
