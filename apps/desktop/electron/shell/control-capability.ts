/**
 * One-shot capabilities: the shell's answer to "this exact action was approved".
 *
 * A token says *who* is asking, and a token can be copied; an approval says *what* was approved, once.
 * R2 asked for the second half: a mutation needs an approval the host itself witnessed, carried by a
 * capability that names the command, is bound to the arguments, expires, and can be spent only once.
 *
 * The store is deliberately free of Electron, sockets and disk: policy lives in `host-control.ts`,
 * and this file only mints, checks and burns. That keeps it testable and portable (a Rust port is a
 * `struct CapabilityStore` plus a `HashMap`, with the same four checks).
 */

import crypto from 'node:crypto'
import { sameToken } from './json-lines.ts'

/** What the host recorded when it approved one action. */
export interface CapabilityRecord {
  /** The capability itself, `cap_<id>_<nonce>`; never written to the journal. */
  id: string
  /** The approval this came from, for the journal: one approval, one capability. */
  approvalId: string
  /** The canonical call name the capability is for (`registry:memory.forget`). */
  command: string
  /** sha256 over the command and the canonical argument JSON: a different call needs its own. */
  binding: string
  /** The secret half, compared in constant time and never logged. */
  nonce: string
  issuedAt: number
  expiresAt: number
  usedAt?: number
}

export type CapabilityOutcome = 'ok' | 'unknown' | 'expired' | 'replayed' | 'mismatch' | 'malformed'

export interface CapabilityCheck {
  outcome: CapabilityOutcome
  record?: CapabilityRecord
  reason: string
}

export interface CapabilityStoreOptions {
  /** Injectable clock so expiry is testable without waiting. */
  now?: () => number
  /** How long an approved action stays offerable; short, because it is spent in the next round trip. */
  ttlMs?: number
  /** Bounded so a caller cannot grow the shell's memory by asking for approvals. */
  max?: number
}

/**
 * The canonical form of a call's arguments: sorted keys, no `undefined`, so two spellings of the same
 * object bind to the same capability and a changed value does not.
 */
export function canonicalArgs(value: unknown): string {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) {
      return node.map(walk)
    }

    if (node && typeof node === 'object') {
      const out: Record<string, unknown> = {}

      for (const key of Object.keys(node as Record<string, unknown>).sort()) {
        const child = (node as Record<string, unknown>)[key]

        if (child !== undefined) {
          out[key] = walk(child)
        }
      }

      return out
    }

    return node ?? null
  }

  try {
    return JSON.stringify(walk(value ?? {}))
  } catch {
    // A value that cannot be serialised cannot be bound, so it binds to nothing an approval could name.
    return 'unserialisable'
  }
}

/** The binding of one call: its name and its arguments, together, hashed. */
export function bindingOf(command: string, args: unknown): string {
  return crypto.createHash('sha256').update(`${command}\u0000${canonicalArgs(args)}`).digest('hex')
}

/**
 * What the journal may say about a capability: enough to line an approval up with its use, and nothing
 * that would let a reader spend it. The nonce is the secret and stays out.
 */
export function capabilityFingerprint(record: CapabilityRecord): string {
  return crypto.createHash('sha256').update(record.approvalId).digest('hex').slice(0, 12)
}

/**
 * The id is `cap_<12 base64url chars from 9 bytes>_<nonce>`. The first segment's length is fixed, so
 * the nonce can be recovered exactly even though base64url itself may emit `_`.
 */
const ID_PREFIX = 'cap_'
const ID_BYTES = 9
const ID_SEGMENT = Math.ceil(ID_BYTES / 3) * 4

export class CapabilityStore {
  private readonly records = new Map<string, CapabilityRecord>()
  private readonly now: () => number
  private readonly ttlMs: number
  private readonly max: number
  private counter = 0

  constructor(options: CapabilityStoreOptions = {}) {
    this.now = options.now ?? (() => Date.now())
    this.ttlMs = options.ttlMs ?? 120_000
    this.max = options.max ?? 32
  }

  get size(): number {
    this.prune()

    return this.records.size
  }

  /** Mint a capability for exactly this call. The caller has already witnessed the approval. */
  grant(input: { command: string; args: unknown; approvalId?: string }): CapabilityRecord {
    this.prune()

    while (this.records.size >= this.max) {
      const oldest = this.records.keys().next().value

      if (oldest === undefined) {
        break
      }

      this.records.delete(oldest)
    }

    const issuedAt = this.now()
    const nonce = crypto.randomBytes(18).toString('base64url')
    const record: CapabilityRecord = {
      id: `${ID_PREFIX}${crypto.randomBytes(ID_BYTES).toString('base64url')}_${nonce}`,
      approvalId: input.approvalId ?? `ap_${crypto.randomBytes(9).toString('base64url')}_${++this.counter}`,
      command: input.command,
      binding: bindingOf(input.command, input.args),
      nonce,
      issuedAt,
      expiresAt: issuedAt + this.ttlMs,
    }

    this.records.set(record.id, record)

    return record
  }

  /**
   * Can this capability run this call? Order matters and is the whole policy: a spent capability is
   * spent whatever it is presented for, an expired one is expired, and a call that does not match the
   * binding was never approved. Nothing here spends it — `consume` does, after execution is decided.
   */
  verify(input: { id: unknown; command: string; args: unknown }): CapabilityCheck {
    const id = typeof input.id === 'string' ? input.id.trim() : ''

    if (!id?.startsWith('cap_')) {
      return { outcome: 'malformed', reason: 'a capability looks like cap_<id>_<nonce>' }
    }

    this.prune()

    const record = this.records.get(id)

    if (!record) {
      return { outcome: 'unknown', reason: 'no such capability (already spent, or never issued)' }
    }

    // Constant-time on the secret half; the rest is a name, not a credential.
    const presented = id.slice(ID_PREFIX.length + ID_SEGMENT + 1)

    if (!sameToken(presented, record.nonce)) {
      return { outcome: 'malformed', reason: 'the capability does not match its record' }
    }

    if (record.usedAt !== undefined) {
      return { outcome: 'replayed', record, reason: 'this capability has already been spent' }
    }

    if (this.now() >= record.expiresAt) {
      return { outcome: 'expired', record, reason: 'this capability has expired' }
    }

    if (record.command !== input.command) {
      return { outcome: 'mismatch', record, reason: `this capability is for ${record.command}, not ${input.command}` }
    }

    if (record.binding !== bindingOf(input.command, input.args)) {
      return { outcome: 'mismatch', record, reason: 'the arguments changed since this capability was issued' }
    }

    return { outcome: 'ok', record, reason: 'approved for this call' }
  }

  /** Burn a capability: it can be spent once, by one caller, for one call. */
  consume(record: CapabilityRecord): void {
    this.records.set(record.id, { ...record, usedAt: this.now() })
  }

  /**
   * Keep the map bounded without losing an answer a caller still needs: a record is forgotten only an
   * hour after it expired (or was spent), so a late attempt is told `expired` or `replayed` rather
   * than `unknown`. `grant` evicts the oldest record at `max`, which is the real memory bound.
   */
  prune(): void {
    const now = this.now()

    for (const [id, record] of this.records) {
      const ended = record.usedAt ?? record.expiresAt

      if (now - ended > 3_600_000) {
        this.records.delete(id)
      }
    }
  }
}
