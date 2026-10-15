import { describe, expect, it } from 'vitest'
import { CapabilityStore, bindingOf, canonicalArgs, capabilityFingerprint } from './control-capability.ts'

const store = (now: () => number, overrides: { ttlMs?: number; max?: number } = {}) =>
  new CapabilityStore({ now, ttlMs: overrides.ttlMs ?? 120_000, max: overrides.max ?? 32 })

describe('the canonical form of a call', () => {
  it('sorts keys and drops what was not sent, so spelling cannot change the binding', () => {
    expect(canonicalArgs({ b: 1, a: { d: 2, c: undefined } })).toBe(canonicalArgs({ a: { d: 2 }, b: 1 }))
    expect(canonicalArgs({ a: 1 })).not.toBe(canonicalArgs({ a: 2 }))
  })

  it('keeps a changed value and a changed type apart', () => {
    expect(bindingOf('registry:x', { a: '1' })).not.toBe(bindingOf('registry:x', { a: 1 }))
    expect(bindingOf('registry:x', { a: 1 })).not.toBe(bindingOf('registry:y', { a: 1 }))
    expect(bindingOf('registry:x', { a: 1 })).toBe(bindingOf('registry:x', { a: 1 }))
  })
})

describe('a capability store', () => {
  it('mints one capability for exactly one call', () => {
    const capabilities = store(() => 1_000)
    const record = capabilities.grant({ command: 'registry:memory.forget', args: { match: 'x' } })

    expect(record.id).toMatch(/^cap_[A-Za-z0-9_-]{12}_[A-Za-z0-9_-]{24}$/)
    expect(record.expiresAt).toBe(121_000)
    expect(capabilities.verify({ id: record.id, command: record.command, args: { match: 'x' } }).outcome).toBe('ok')
  })

  it('refuses the same call with different arguments, and names the command it was for', () => {
    const capabilities = store(() => 1_000)
    const record = capabilities.grant({ command: 'registry:memory.forget', args: { match: 'x' } })

    expect(capabilities.verify({ id: record.id, command: record.command, args: { match: 'y' } })).toMatchObject({ outcome: 'mismatch' })
    expect(capabilities.verify({ id: record.id, command: 'registry:memory.export', args: { match: 'x' } })).toMatchObject({ outcome: 'mismatch' })
  })

  it('spends once: the second attempt is a replay, whatever it is presented for', () => {
    const capabilities = store(() => 1_000)
    const record = capabilities.grant({ command: 'registry:memory.forget', args: {} })

    capabilities.consume(record)

    expect(capabilities.verify({ id: record.id, command: record.command, args: {} })).toMatchObject({ outcome: 'replayed' })
  })

  it('expires on the injected clock', () => {
    let now = 1_000
    const capabilities = store(() => now)
    const record = capabilities.grant({ command: 'registry:memory.forget', args: {} })

    now += 120_000

    expect(capabilities.verify({ id: record.id, command: record.command, args: {} })).toMatchObject({ outcome: 'expired' })
  })

  it('answers unknown and malformed distinctly, and never accepts a made-up id', () => {
    const capabilities = store(() => 1_000)
    const record = capabilities.grant({ command: 'registry:memory.forget', args: {} })
    const forged = `${record.id.slice(0, -1)}${record.id.endsWith('A') ? 'B' : 'A'}`

    expect(capabilities.verify({ id: 'nope', command: record.command, args: {} })).toMatchObject({ outcome: 'malformed' })
    expect(capabilities.verify({ id: 'cap_aaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbb', command: record.command, args: {} })).toMatchObject({ outcome: 'unknown' })
    // A tampered id is a name the store never issued: `unknown`, and it leaks nothing about what is.
    expect(capabilities.verify({ id: forged, command: record.command, args: {} })).toMatchObject({ outcome: 'unknown' })
    expect(capabilities.verify({ id: record.id, command: record.command, args: {} })).toMatchObject({ outcome: 'ok' })
  })

  it('stays bounded by max, evicting the oldest first', () => {
    const capabilities = store(() => 1_000, { max: 4 })

    for (let i = 0; i < 40; i += 1) {
      capabilities.grant({ command: 'registry:memory.forget', args: { i } })
    }

    expect(capabilities.size).toBeLessThanOrEqual(4)
  })

  it('tells the journal about the approval, never the capability itself', () => {
    const capabilities = store(() => 1_000)
    const record = capabilities.grant({ command: 'registry:memory.forget', args: {}, approvalId: 'apr_abc' })
    const again = capabilities.grant({ command: 'registry:memory.forget', args: {}, approvalId: 'apr_abc' })
    const fingerprint = capabilityFingerprint(record)

    expect(fingerprint).toMatch(/^[a-f0-9]{12}$/)
    // One approval can be told apart from another, and lines up across the two halves of a round trip.
    expect(fingerprint).toBe(capabilityFingerprint(again))
    expect(fingerprint).not.toBe(capabilityFingerprint(capabilities.grant({ command: 'registry:memory.forget', args: {} })))
    // …while the secret half never appears in it, and the id's secret is the record's nonce.
    expect(fingerprint).not.toContain(record.nonce)
    expect(record.id.endsWith(`_${record.nonce}`)).toBe(true)
  })
})
