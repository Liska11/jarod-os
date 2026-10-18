import { clientHandshake, type CryptoKeyPair, type HostAccept, type SecureChannel } from '@jarod-protocol'
import { sseData } from './sse.ts'

/** A pushed message from the PC: an agent event, an approval request (or its withdrawal), a notification. */
export interface PushedEvent {
  event: 'agent' | 'approval' | 'approval-cancelled' | 'notification' | string
  data: Record<string, unknown>
}

export interface ChannelOptions {
  /** Origins to try (`http://192.168.1.20:10492`…), in order of preference; "" = same origin (dev). */
  urls: string[]
  hostKey: Uint8Array
  keys: CryptoKeyPair
  /** Present only the first time: the QR code's one-time code. */
  pairingCode?: Uint8Array
  deviceName?: string
  onEvent?: (e: PushedEvent) => void
  /** The channel ended (the PC closed it, the network went, or `close()`). */
  onClose?: (reason: string) => void
  fetch?: typeof fetch
  /** How long one address gets to answer `open`. */
  openTimeoutMs?: number
}

/** The PC refused this phone: unknown or revoked key, or a spent code. Not a network problem. */
export class DeniedError extends Error {}

interface Reply {
  id: number
  result?: unknown
  error?: string
}

const RPC_TIMEOUT_MS = 120_000

/**
 * Opens the end-to-end channel to the PC: `/m1/open` on the first address that answers, the
 * `/m1/down` stream, then the protocol handshake. The PC must prove the key pinned at pairing.
 */
export async function openChannel(o: ChannelOptions): Promise<JarodChannel> {
  const f = o.fetch ?? globalThis.fetch.bind(globalThis)
  const { base, cid } = await firstToOpen(f, o.urls, o.openTimeoutMs ?? 4000)
  const abort = new AbortController()
  const down = await f(`${base}/m1/down?cid=${encodeURIComponent(cid)}`, { signal: abort.signal, cache: 'no-store' })
  if (!down.ok || !down.body) throw new Error(`Flux refusé (${down.status})`)
  const frames = sseData(down.body)

  const hs = await clientHandshake(o.keys, o.hostKey, { pairingSecret: o.pairingCode, name: o.deviceName })
  const up = (frame: string) =>
    f(`${base}/m1/up?cid=${encodeURIComponent(cid)}`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: frame
    })
  const sent = await up(JSON.stringify(hs.init))
  if (!sent.ok) throw new Error(`Envoi refusé (${sent.status})`)

  const first = await frames.next()
  if (first.done) {
    abort.abort()
    throw new Error('Le PC a fermé le canal.')
  }
  const answer = JSON.parse(first.value) as { type?: string; reason?: string }
  if (answer.type === 'denied') {
    abort.abort()
    throw new DeniedError(answer.reason ?? 'Refusé par le PC.')
  }
  if (answer.type !== 'accept') {
    abort.abort()
    throw new Error('Réponse inattendue du PC.')
  }
  let channel: SecureChannel
  try {
    channel = await hs.finish(answer as HostAccept)
  } catch (e) {
    // Not the PC whose key the QR code gave: stop here, say nothing more to it.
    abort.abort()
    throw e
  }
  return new JarodChannel(base, channel, frames, up, abort, o)
}

async function firstToOpen(f: typeof fetch, urls: string[], timeoutMs: number): Promise<{ base: string; cid: string }> {
  const list = urls.length ? urls : ['']
  const controllers = list.map(() => new AbortController())
  const attempts = list.map(async (base, i) => {
    const timer = setTimeout(() => controllers[i]!.abort(), timeoutMs)
    try {
      const res = await f(`${base}/m1/open`, { method: 'POST', signal: controllers[i]!.signal, cache: 'no-store' })
      if (!res.ok) throw new Error(`${base} : ${res.status}`)
      const { cid } = (await res.json()) as { cid?: string }
      if (!cid) throw new Error(`${base} : réponse invalide`)
      return { base, cid }
    } finally {
      clearTimeout(timer)
    }
  })
  try {
    const won = await Promise.any(attempts)
    controllers.forEach(c => c.abort())
    return won
  } catch {
    throw new Error('PC injoignable : même Wi-Fi, ou Tailscale allumé sur les deux appareils ?')
  }
}

export class JarodChannel {
  private ids = 0
  private replies = new Map<number, { resolve: (r: Reply) => void; timer: ReturnType<typeof setTimeout> }>()
  /** Frames go up one at a time: the PC checks their counters in order. */
  private queue: Promise<unknown> = Promise.resolve()
  private closed = false

  constructor(
    /** The address that answered: remembered for next time. */
    readonly base: string,
    private readonly channel: SecureChannel,
    frames: AsyncGenerator<string>,
    private readonly up: (frame: string) => Promise<Response>,
    private readonly abort: AbortController,
    private readonly o: ChannelOptions
  ) {
    void this.read(frames)
  }

  get isOpen(): boolean {
    return !this.closed
  }

  private async read(frames: AsyncGenerator<string>): Promise<void> {
    let reason = 'Le PC a fermé le canal.'
    try {
      for await (const frame of frames) {
        const msg = (await this.channel.open(frame)) as Reply & PushedEvent
        if (typeof msg.id === 'number') {
          const waiting = this.replies.get(msg.id)
          if (waiting) {
            clearTimeout(waiting.timer)
            this.replies.delete(msg.id)
            waiting.resolve(msg)
          }
        } else if (typeof msg.event === 'string') {
          this.o.onEvent?.({ event: msg.event, data: (msg.data ?? {}) as Record<string, unknown> })
        }
      }
    } catch (e) {
      reason = this.closed ? 'Fermé.' : `Canal interrompu : ${(e as Error).message}`
    }
    this.finish(reason)
  }

  private finish(reason: string): void {
    const wasOpen = !this.closed
    this.closed = true
    for (const [id, w] of this.replies) {
      clearTimeout(w.timer)
      w.resolve({ id, error: 'Canal fermé' })
    }
    this.replies.clear()
    if (wasOpen) this.o.onClose?.(reason)
  }

  /** Calls the PC. Rejects with the PC's own message when it refuses. */
  rpc<T = unknown>(method: string, params?: Record<string, unknown>, timeoutMs = RPC_TIMEOUT_MS): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Canal fermé'))
    const id = ++this.ids
    const answer = new Promise<Reply>(resolve => {
      const timer = setTimeout(() => {
        this.replies.delete(id)
        resolve({ id, error: 'Pas de réponse du PC' })
      }, timeoutMs)
      this.replies.set(id, { resolve, timer })
    })
    this.queue = this.queue.then(async () => {
      const res = await this.up(await this.channel.seal({ id, method, params }))
      if (!res.ok) throw new Error(`Envoi refusé (${res.status})`)
    }).catch(e => {
      const w = this.replies.get(id)
      if (w) {
        clearTimeout(w.timer)
        this.replies.delete(id)
        w.resolve({ id, error: (e as Error).message })
      }
    })
    return answer.then(r => {
      if (r.error !== undefined) throw new Error(r.error)
      return r.result as T
    })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.abort.abort()
    this.finish('Fermé.')
  }
}
