import { b64uEncode } from '@jarod-protocol'
import { describe, expect, it } from 'vitest'
import { parsePairingLink } from './pairing-link.ts'

const k = b64uEncode(new Uint8Array(32).fill(1))
const p = b64uEncode(new Uint8Array(32).fill(2))
const link = (extra: Record<string, string> = {}) =>
  `jarod://pair#${new URLSearchParams({ v: '2', h: 'hostid', k, p, u: 'http://192.168.1.20:10492,http://100.101.1.2:10492', n: 'PC-Salon', ...extra })}`

describe('pairing link', () => {
  it('reads what the PC shows', () => {
    const l = parsePairingLink(link())!
    expect(l.hostId).toBe('hostid')
    expect(l.hostKey).toHaveLength(32)
    expect(l.code).toHaveLength(32)
    expect(l.urls).toEqual(['http://192.168.1.20:10492', 'http://100.101.1.2:10492'])
    expect(l.name).toBe('PC-Salon')
  })

  it('keeps only private plain addresses: a QR code cannot send the phone to the Internet', () => {
    const l = parsePairingLink(link({ u: 'http://8.8.8.8:10492,https://192.168.1.2,http://user:pw@10.0.0.1:1,http://10.0.0.2:10492/x,http://10.0.0.3:10492,javascript:alert(1)' }))!
    expect(l.urls).toEqual(['http://10.0.0.3:10492'])
  })

  it('refuses anything malformed', () => {
    expect(parsePairingLink('')).toBeNull()
    expect(parsePairingLink('https://evil.example/#v=2')).toBeNull()
    expect(parsePairingLink(link({ v: '1' }))).toBeNull()
    expect(parsePairingLink(link({ k: b64uEncode(new Uint8Array(16)) }))).toBeNull()
    expect(parsePairingLink(link({ p: 'pas base64!' }))).toBeNull()
    expect(parsePairingLink(link({ h: '' }))).toBeNull()
  })

  it('accepts the fragment alone (pasted)', () => {
    expect(parsePairingLink(link().slice(link().indexOf('#')))).not.toBeNull()
  })
})
