import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadPc, type PairedPc, savePc } from './pairing-store.ts'
import { learnAddresses } from './session.ts'

const memory = () => {
  const m = new Map<string, string>()
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) }
}

const pc = (extra: Partial<PairedPc> = {}): PairedPc => ({
  v: 1,
  hostId: 'h',
  hostKey: 'k',
  name: 'PC-Salon',
  urls: ['http://192.168.1.42:10492', 'http://100.92.73.61:10492'],
  lastUrl: 'http://100.92.73.61:10492',
  wrappedKey: 'w',
  deviceName: 'Nord 4',
  pairedAt: 1,
  watch: false,
  ...extra
})

const NAME = 'http://hp-z2i.tailb39d55.ts.net:10492'

describe('learning the PC’s addresses after a connection', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', memory())
  })

  it('replaces the remembered list and keeps the last address that worked', () => {
    savePc(pc())
    const next = learnAddresses({ urls: ['http://192.168.1.77:10492', 'http://100.92.73.61:10492', NAME] })
    expect(next?.urls).toEqual(['http://192.168.1.77:10492', 'http://100.92.73.61:10492', NAME])
    expect(loadPc()?.urls).toEqual(next?.urls)
    expect(loadPc()?.lastUrl).toBe('http://100.92.73.61:10492')
  })

  it('follows a changed Tailscale IP', () => {
    savePc(pc())
    learnAddresses({ urls: ['http://192.168.1.42:10492', 'http://100.88.1.9:10492'] })
    expect(loadPc()?.urls).toEqual(['http://192.168.1.42:10492', 'http://100.88.1.9:10492'])
    expect(loadPc()?.lastUrl).toBeUndefined()
  })

  it('writes nothing when the list is the same', () => {
    savePc(pc())
    const before = loadPc()
    expect(learnAddresses({ urls: pc().urls })).toEqual(before)
  })

  it('ignores a hostile list (public IP, other domain) and keeps what it had', () => {
    savePc(pc())
    const next = learnAddresses({ urls: ['http://8.8.8.8:10492', 'http://jarod.example.org:10492', 'http://hp.tailb39d55.ts.net.evil.com:10492'] })
    expect(next?.urls).toEqual(pc().urls)
    expect(loadPc()?.urls).toEqual(pc().urls)
  })

  it('ignores a message without a list, and does nothing when no PC is paired', () => {
    savePc(pc())
    expect(learnAddresses({})?.urls).toEqual(pc().urls)
    vi.stubGlobal('localStorage', memory())
    expect(learnAddresses({ urls: [NAME] })).toBeNull()
  })
})
