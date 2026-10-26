import { b64uEncode } from '@jarod-protocol'
import { describe, expect, it } from 'vitest'
import { cleanAddress, cleanAddresses, isTailnetName, MAX_URLS, refreshAddresses } from './addresses.ts'
import { isTailnetHost, linkMode } from './diagnostics.ts'
import { parsePairingLink } from './pairing-link.ts'

const k = b64uEncode(new Uint8Array(32).fill(1))
const p = b64uEncode(new Uint8Array(32).fill(2))
const qr = (u: string) => `jarod://pair#${new URLSearchParams({ v: '2', h: 'hostid', k, p, u, n: 'PC-Salon' })}`

const NAME = 'http://hp-z2i.tailb39d55.ts.net:10492'

describe('MagicDNS names', () => {
  it('knows a tailnet name: host.tailnet.ts.net, nothing else', () => {
    expect(isTailnetName('hp-z2i.tailb39d55.ts.net')).toBe(true)
    expect(isTailnetName('HP-Z2I.TAILB39D55.TS.NET')).toBe(true)
    expect(isTailnetName('a.b.c.tailb39d55.ts.net')).toBe(true)
  })

  it('refuses everything that only looks like one', () => {
    for (const bad of [
      'ts.net',
      'tailb39d55.ts.net', // the tailnet itself, not a machine
      'evil.com',
      'hp.tailb39d55.ts.net.evil.com',
      'ts.net.evil.com',
      'hp.tailb39d55.xts.net',
      'hp.tailb39d55.ts.net.', // trailing dot: refused, the PC sends none
      '-hp.tail.ts.net',
      'hp_z.tail.ts.net',
      'hp..tail.ts.net',
      'hp.tail.ts.network',
      '',
      `${'a'.repeat(64)}.tail.ts.net`
    ]) {
      expect(isTailnetName(bad), bad).toBe(false)
    }
  })
})

describe('one address', () => {
  it('keeps a private IP, a tailnet IP and a .ts.net name, as an origin', () => {
    expect(cleanAddress('http://192.168.1.42:10492')).toBe('http://192.168.1.42:10492')
    expect(cleanAddress('http://100.92.73.61:10492/')).toBe('http://100.92.73.61:10492')
    expect(cleanAddress(NAME)).toBe(NAME)
    expect(cleanAddress('  http://[fd7a:115c:a1e0::a82e:493e]:10492 ')).toBe('http://[fd7a:115c:a1e0::a82e:493e]:10492')
  })

  it('refuses a public address, a public domain, and a domain that is not .ts.net', () => {
    expect(cleanAddress('http://8.8.8.8:10492')).toBeNull()
    expect(cleanAddress('http://example.com:10492')).toBeNull()
    expect(cleanAddress('http://jarod.example.org')).toBeNull()
    expect(cleanAddress('http://hp.tailb39d55.ts.net.evil.com:10492')).toBeNull()
    expect(cleanAddress('http://ts.net:10492')).toBeNull()
    expect(cleanAddress('http://tailb39d55.ts.net:10492')).toBeNull()
    expect(cleanAddress('http://localhost.ts.net:10492')).toBeNull() // one label under ts.net: not a machine name
  })

  it('refuses https, credentials, a path and anything that is not a URL', () => {
    expect(cleanAddress('https://hp-z2i.tailb39d55.ts.net')).toBeNull()
    expect(cleanAddress('http://user:pw@hp-z2i.tailb39d55.ts.net')).toBeNull()
    expect(cleanAddress('http://hp-z2i.tailb39d55.ts.net:10492/m1')).toBeNull()
    expect(cleanAddress('javascript:alert(1)')).toBeNull()
    expect(cleanAddress('hp-z2i.tailb39d55.ts.net')).toBeNull()
    expect(cleanAddress('')).toBeNull()
  })

  it('cleans a list: no doubles, no bad ones, never more than the cap', () => {
    expect(cleanAddresses(['http://192.168.1.42:10492', 'http://192.168.1.42:10492/', 'http://8.8.8.8:1', NAME, 42, null])).toEqual(['http://192.168.1.42:10492', NAME])
    expect(cleanAddresses('http://192.168.1.42:10492')).toEqual([])
    expect(cleanAddresses(undefined)).toEqual([])
    const many = Array.from({ length: 30 }, (_, i) => `http://192.168.1.${i + 1}:10492`)
    expect(cleanAddresses(many)).toHaveLength(MAX_URLS)
  })
})

describe('the QR code', () => {
  it('carries the MagicDNS name next to the IPs', () => {
    const l = parsePairingLink(qr(`http://192.168.1.42:10492,http://100.92.73.61:10492,${NAME}`))!
    expect(l.urls).toEqual(['http://192.168.1.42:10492', 'http://100.92.73.61:10492', NAME])
  })

  it('drops a public name or a look-alike, and keeps the rest', () => {
    const l = parsePairingLink(qr(`http://192.168.1.42:10492,http://jarod.example.org:10492,http://hp.tailb39d55.ts.net.evil.com:10492,http://8.8.8.8:10492`))!
    expect(l.urls).toEqual(['http://192.168.1.42:10492'])
  })

  it('a QR with only a .ts.net name is enough to pair over the tailnet', () => {
    expect(parsePairingLink(qr(NAME))!.urls).toEqual([NAME])
  })
})

describe('the list the PC sends after a connection', () => {
  const pc = { urls: ['http://192.168.1.42:10492', 'http://100.92.73.61:10492'], lastUrl: 'http://100.92.73.61:10492' as string | undefined }

  it('follows a change of LAN address', () => {
    const next = refreshAddresses(pc, ['http://192.168.1.77:10492', 'http://100.92.73.61:10492'])
    expect(next.urls).toEqual(['http://192.168.1.77:10492', 'http://100.92.73.61:10492'])
    expect(next.lastUrl).toBe('http://100.92.73.61:10492')
  })

  it('follows a change of Tailscale address, and forgets the old one as the last used', () => {
    const next = refreshAddresses(pc, ['http://192.168.1.42:10492', 'http://100.88.1.9:10492'])
    expect(next.urls).toEqual(['http://192.168.1.42:10492', 'http://100.88.1.9:10492'])
    expect(next.lastUrl).toBeUndefined()
  })

  it('learns the MagicDNS name', () => {
    const next = refreshAddresses(pc, [...pc.urls, NAME])
    expect(next.urls).toEqual([...pc.urls, NAME])
    expect(next.lastUrl).toBe('http://100.92.73.61:10492')
  })

  it('keeps the address that worked last, still first when the order changed', () => {
    const next = refreshAddresses(pc, ['http://192.168.1.42:10492', NAME, 'http://100.92.73.61:10492'])
    expect(next.lastUrl).toBe('http://100.92.73.61:10492')
  })

  it('takes nothing from a public address or a domain that is not .ts.net', () => {
    const next = refreshAddresses(pc, ['http://192.168.1.77:10492', 'http://8.8.8.8:10492', 'http://jarod.example.org:10492', 'http://hp.tailb39d55.ts.net.evil.com'])
    expect(next.urls).toEqual(['http://192.168.1.77:10492'])
  })

  it('never wipes the list: nothing valid in the answer means nothing changes', () => {
    expect(refreshAddresses(pc, ['http://8.8.8.8:10492'])).toBe(pc)
    expect(refreshAddresses(pc, [])).toBe(pc)
    expect(refreshAddresses(pc, 'http://192.168.1.77:10492')).toBe(pc)
    expect(refreshAddresses(pc, undefined)).toBe(pc)
  })

  it('returns the same object when nothing changed (no needless write)', () => {
    expect(refreshAddresses(pc, [...pc.urls])).toBe(pc)
  })
})

describe('a MagicDNS name in the diagnostics', () => {
  it('counts as Tailscale', () => {
    expect(isTailnetHost('hp-z2i.tailb39d55.ts.net')).toBe(true)
    expect(isTailnetHost('example.com')).toBe(false)
    expect(linkMode(NAME, true)).toBe('tailscale')
    expect(linkMode('http://192.168.1.42:10492', true)).toBe('lan')
  })
})
