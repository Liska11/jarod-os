/**
 * R1 invariant 7, closed (mission 0b.1): the control journal never holds a secret the process knows.
 *
 * `ControlSecurity.record` used to write the caller's `cmd`, `command`, `source`, `reason` and request
 * id as they came, so a caller that put a token in one of them found it in `control-audit.jsonl`.
 * Every journal line now goes through `redactSecrets`, which masks the values this process actually
 * holds — the two tokens, every live capability and its nonce, the pipe nonce — and nothing else.
 * These tests mint real values, run the real writer to disk, and read the file back.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { asControlTier, ControlSecurity, controlAuditSink, controlTokens, redactSecrets, type ControlAuditEntry, type ControlSecret } from './control-authz.ts'
import { HostControlGate, type CatalogueEntry } from './host-control.ts'

const CATALOGUE: readonly CatalogueEntry[] = [
  { id: 'page.open', tier: 'read', args: [{ name: 'name', type: 'string', required: true }] },
  { id: 'memory.add', tier: 'mutate', args: [{ name: 'text', type: 'string', required: true }] },
]
const PIPE_NONCE = '0123456789abcdef'

const created: string[] = []

afterEach(() => {
  while (created.length) {
    rmSync(created.pop() as string, { recursive: true, force: true })
  }
})

function door() {
  const dir = mkdtempSync(path.join(tmpdir(), 'hos-redact-'))

  created.push(dir)

  const journal = path.join(dir, 'control-audit.jsonl')
  const tokens = controlTokens()
  const security = new ControlSecurity({ tokens, catalogueReady: true, tierOf: id => asControlTier(CATALOGUE.find(entry => entry.id === id)?.tier), secrets: () => [{ kind: 'nonce', value: PIPE_NONCE }] }, controlAuditSink(journal))
  const gate = new HostControlGate({ security, approve: async () => true })

  gate.setCatalogue(CATALOGUE)

  const lines = () =>
    readFileSync(journal, 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as ControlAuditEntry)

  return { tokens, security, gate, journal, lines, raw: () => readFileSync(journal, 'utf8') }
}

describe('redactSecrets', () => {
  const secrets: ControlSecret[] = [
    { kind: 'token', value: 'tokenAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
    { kind: 'capability', value: 'cap_AbCdEfGhIjKl_nonceNONCEnonce0123456789' },
    { kind: 'nonce', value: 'nonceNONCEnonce0123456789' },
  ]

  it('masks each kind, wherever it sits in the text', () => {
    expect(redactSecrets(`x ${secrets[0].value} y`, secrets)).toBe('x [REDACTED:token] y')
    expect(redactSecrets(`(${secrets[2].value})`, secrets)).toBe('([REDACTED:nonce])')
    expect(redactSecrets(`${secrets[0].value}/${secrets[0].value}`, secrets)).toBe('[REDACTED:token]/[REDACTED:token]')
  })

  it('masks a capability as the capability, not as its nonce', () => {
    expect(redactSecrets(`using ${secrets[1].value} now`, secrets)).toBe('using [REDACTED:capability] now')
  })

  it('finds a secret glued to other token characters', () => {
    expect(redactSecrets(`prefix-${secrets[0].value}-suffix`, secrets)).toBe('prefix-[REDACTED:token]-suffix')
  })

  it('leaves ordinary text alone, even when it is long and token-shaped (no guessing)', () => {
    const lookalike = 'A'.repeat(64)

    expect(redactSecrets(`${lookalike} and ${'x1y2z3'.repeat(10)}`, secrets)).toBe(`${lookalike} and ${'x1y2z3'.repeat(10)}`)
    expect(redactSecrets('memory.add from agent', secrets)).toBe('memory.add from agent')
  })

  it('does nothing without secrets, and ignores empty or very short values', () => {
    expect(redactSecrets('abc', [])).toBe('abc')
    expect(redactSecrets('a b c', [{ kind: 'token', value: '' }, { kind: 'token', value: 'a' }])).toBe('a b c')
  })

  it('cuts an oversized field before scanning, so a secret past the cut cannot survive', () => {
    const out = redactSecrets(`${'z '.repeat(3000)}${secrets[0].value}`, secrets)

    expect(out).not.toContain(secrets[0].value)
    expect(out.endsWith('…[cut]')).toBe(true)
  })
})

describe('the control journal holds no secret of this process', () => {
  it('masks the backend and CLI tokens in every free-text field', () => {
    const { tokens, security, lines, raw } = door()

    for (const [field, token] of [['cmd', tokens.backend], ['command', tokens.cli], ['source', tokens.backend], ['reason', tokens.cli], ['source', tokens.cli]] as const) {
      security.record({ client: 'unauthenticated', cmd: 'ui', allowed: false, reason: 'no', code: 'unauthenticated', [field]: `before ${token} after` })
    }

    expect(raw()).not.toContain(tokens.backend)
    expect(raw()).not.toContain(tokens.cli)

    const entries = lines()

    expect(entries).toHaveLength(5)
    expect(entries[0].cmd).toBe('before [REDACTED:token] after')
    expect(entries[1].command).toBe('before [REDACTED:token] after')
    expect(entries[2].source).toBe('before [REDACTED:token] after')
    expect(entries[3].reason).toBe('before [REDACTED:token] after')
    // The line is still written, with its decision and its readable reason.
    expect(entries.every(entry => entry.allowed === false && entry.client === 'unauthenticated')).toBe(true)
  })

  it('masks a token a caller sends through the real adjudication path', () => {
    const { tokens, security, lines, raw } = door()

    // The other door's token as the "source", the CLI token as an unknown command id: the reason
    // echoes the command id, and the source is stored as sent.
    security.check({ cmd: 'ui', command: tokens.cli, source: tokens.backend, token: tokens.backend })
    security.check({ cmd: tokens.cli, token: tokens.cli })

    expect(raw()).not.toContain(tokens.backend)
    expect(raw()).not.toContain(tokens.cli)
    expect(lines().length).toBeGreaterThanOrEqual(2)
    expect(JSON.stringify(lines())).toContain('[REDACTED:token]')
  })

  it('drops a request id that is a token instead of journalling it', () => {
    const { tokens, security, lines, raw } = door()

    security.check({ cmd: 'ui', command: 'page.open', requestId: tokens.backend, token: 'wrong' })

    expect(raw()).not.toContain(tokens.backend)
    expect(lines()[0].requestId).toBeUndefined()
  })

  it('masks the pipe nonce', () => {
    const { security, lines, raw } = door()

    security.record({ client: 'unauthenticated', cmd: 'ui', allowed: false, reason: `dial pipe://herald-os-${PIPE_NONCE}`, code: 'invalid' })

    expect(raw()).not.toContain(PIPE_NONCE)
    expect(lines()[0].reason).toBe('dial pipe://herald-os-[REDACTED:nonce]')
  })

  it('masks a live capability and its nonce, found in a field of a later attempt', async () => {
    const { tokens, security, gate, lines, raw } = door()

    const granted = await gate.submit({ cmd: 'ui', command: 'memory.add', args: { text: 'likes tea' }, token: tokens.backend })
    const capability = ((granted as { reply?: { capability?: { id?: string } } }).reply?.capability?.id ?? '') as string

    expect(capability).toMatch(/^cap_/)

    const nonce = capability.slice('cap_'.length + 12 + 1)

    security.record({ client: 'backend', cmd: 'ui', command: 'memory.add', source: capability, allowed: false, reason: `saw ${capability} and ${nonce}`, code: 'invalid' })
    // And through the gate's own path, as a caller would: the capability presented as the source.
    await gate.submit({ cmd: 'ui', command: 'memory.add', args: { text: 'likes tea' }, token: tokens.backend, source: capability, capability })

    expect(raw()).not.toContain(capability)
    expect(raw()).not.toContain(nonce)
    expect(JSON.stringify(lines())).toContain('[REDACTED:capability]')
  })

  it('keeps the entries valid against the C3 schema shape (closed field set, no secret field)', () => {
    const { tokens, security, lines } = door()

    security.check({ cmd: 'ui', command: tokens.backend, token: tokens.backend })

    for (const entry of lines()) {
      expect(Object.keys(entry).every(key => ['at', 'client', 'cmd', 'command', 'tier', 'source', 'allowed', 'reason', 'code', 'approval', 'requestId', 'surface'].includes(key))).toBe(true)
    }
  })
})
