import {
  b64uEncode,
  type ClientInit,
  type CryptoKeyPair,
  deviceId,
  generateKeyPair,
  hostHandshake,
  rawPublicKey,
  type SecureChannel
} from '@jarod-protocol'
import { describe, expect, it } from 'vitest'
import { DeniedError, openChannel, type PushedEvent } from './channel.ts'

/**
 * A PC in memory: the core's own handshake and channel, behind a fetch that speaks `/m1/*`. It knows
 * the devices it was told about, and answers `echo` and `boom`.
 */
async function fakePc(opts: { known?: string[]; code?: Uint8Array; reachable?: string[] } = {}) {
  const keys = await generateKeyPair(true)
  const hostKey = await rawPublicKey(keys.publicKey)
  const known = new Set(opts.known ?? [])
  const reachable = new Set(opts.reachable ?? ['http://pc'])
  const channels = new Map<string, { push: (s: string) => void; end: () => void; ch: SecureChannel | null }>()
  const seen: { method: string; params: unknown }[] = []
  let n = 0

  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const base = url.origin
    if (!reachable.has(base)) throw new TypeError('network unreachable')
    const cid = url.searchParams.get('cid') ?? ''
    if (url.pathname === '/m1/open') {
      const id = `d-${++n}`
      channels.set(id, { push: () => {}, end: () => {}, ch: null })
      return Response.json({ cid: id, v: 'jarod-relay/1' })
    }
    if (url.pathname === '/m1/down') {
      const c = channels.get(cid)!
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const enc = new TextEncoder()
          c.push = s => controller.enqueue(enc.encode(`data: ${s}\n\n`))
          c.end = () => controller.close()
          controller.enqueue(enc.encode(': canal direct\n\n'))
        }
      })
      init?.signal?.addEventListener('abort', () => {
        try {
          c.end()
        } catch {}
      })
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
    }
    if (url.pathname === '/m1/up') {
      const c = channels.get(cid)
      if (!c) return new Response(null, { status: 404 })
      const text = String(init?.body ?? '')
      if (!c.ch) {
        const init = JSON.parse(text) as ClientInit
        const h = await hostHandshake(keys, init)
        const id = await deviceId(h.clientStatic)
        const paired = opts.code && (await h.checkPairing(opts.code))
        if (!known.has(id) && !paired) {
          c.push(JSON.stringify({ type: 'denied', reason: 'Appareil inconnu ou révoqué.' }))
          c.end()
        } else {
          known.add(id)
          c.push(JSON.stringify(h.accept))
          c.ch = h.channel
        }
      } else {
        const rpc = (await c.ch.open(text)) as { id: number; method: string; params?: unknown }
        seen.push({ method: rpc.method, params: rpc.params })
        if (rpc.method === 'echo') {
          c.push(await c.ch.seal({ event: 'agent', data: { type: 'delta', text: 'bon' } }))
          c.push(await c.ch.seal({ id: rpc.id, result: rpc.params }))
        } else if (rpc.method === 'hangup') {
          c.end()
        } else {
          c.push(await c.ch.seal({ id: rpc.id, error: `Méthode inconnue : ${rpc.method}` }))
        }
      }
      return new Response(null, { status: 204 })
    }
    return new Response(null, { status: 404 })
  }) as typeof fetch

  return { keys, hostKey, known, fetchImpl, seen, reachable }
}

async function phoneKeys(): Promise<{ keys: CryptoKeyPair; id: string }> {
  const keys = await generateKeyPair()
  return { keys, id: await deviceId(await rawPublicKey(keys.publicKey)) }
}

describe('the phone side of the channel', () => {
  it('pairs with the code, calls the PC, and receives what it pushes in order', async () => {
    const code = crypto.getRandomValues(new Uint8Array(32))
    const pc = await fakePc({ code })
    const phone = await phoneKeys()
    const events: PushedEvent[] = []
    const ch = await openChannel({ urls: ['http://pc'], hostKey: pc.hostKey, keys: phone.keys, pairingCode: code, fetch: pc.fetchImpl, onEvent: e => events.push(e) })
    expect(pc.known.has(phone.id)).toBe(true)
    expect(await ch.rpc('echo', { a: 1 })).toEqual({ a: 1 })
    // The pushed delta came before the reply, and was delivered.
    expect(events).toEqual([{ event: 'agent', data: { type: 'delta', text: 'bon' } }])
    // Several calls at once still reach the PC in order.
    const all = await Promise.all([1, 2, 3, 4].map(i => ch.rpc('echo', { i })))
    expect(all).toEqual([{ i: 1 }, { i: 2 }, { i: 3 }, { i: 4 }])
    await expect(ch.rpc('nimporte')).rejects.toThrow('Méthode inconnue')
    ch.close()
    await expect(ch.rpc('echo')).rejects.toThrow('fermé')
  })

  it('comes back with its key alone', async () => {
    const phone = await phoneKeys()
    const pc = await fakePc({ known: [phone.id] })
    const ch = await openChannel({ urls: ['http://pc'], hostKey: pc.hostKey, keys: phone.keys, fetch: pc.fetchImpl })
    expect(await ch.rpc('echo', { x: 1 })).toEqual({ x: 1 })
    ch.close()
  })

  it('is told when the PC refuses it', async () => {
    const pc = await fakePc()
    const phone = await phoneKeys()
    await expect(openChannel({ urls: ['http://pc'], hostKey: pc.hostKey, keys: phone.keys, fetch: pc.fetchImpl })).rejects.toBeInstanceOf(DeniedError)
  })

  it('refuses a PC that does not hold the key from the QR code', async () => {
    const phone = await phoneKeys()
    const pc = await fakePc({ known: [phone.id] })
    const impostorKey = await rawPublicKey((await generateKeyPair(true)).publicKey)
    await expect(openChannel({ urls: ['http://pc'], hostKey: impostorKey, keys: phone.keys, fetch: pc.fetchImpl })).rejects.toThrow(/authentifié/)
  })

  it('takes the first address that answers, and says so when none does', async () => {
    const phone = await phoneKeys()
    const pc = await fakePc({ known: [phone.id], reachable: ['http://100.70.0.2:10492'] })
    const ch = await openChannel({
      urls: ['http://192.168.1.20:10492', 'http://100.70.0.2:10492'],
      hostKey: pc.hostKey,
      keys: phone.keys,
      fetch: pc.fetchImpl
    })
    expect(ch.base).toBe('http://100.70.0.2:10492')
    ch.close()
    pc.reachable.clear()
    await expect(openChannel({ urls: ['http://192.168.1.20:10492'], hostKey: pc.hostKey, keys: phone.keys, fetch: pc.fetchImpl })).rejects.toThrow(/injoignable/)
  })

  it('tells the app when the PC closes the channel, and fails what was pending', async () => {
    const phone = await phoneKeys()
    const pc = await fakePc({ known: [phone.id] })
    let closedWith = ''
    const ch = await openChannel({ urls: ['http://pc'], hostKey: pc.hostKey, keys: phone.keys, fetch: pc.fetchImpl, onClose: r => (closedWith = r) })
    await expect(ch.rpc('hangup')).rejects.toThrow('Canal fermé')
    expect(closedWith).toContain('fermé')
    expect(ch.isOpen).toBe(false)
  })
})

it('the fake PC is the real protocol (sanity: host key is 32 bytes)', async () => {
  const pc = await fakePc()
  expect(b64uEncode(pc.hostKey)).toHaveLength(43)
})
