import { b64uDecode, isPrivateAddress } from '@jarod-protocol'

/** What the PC's QR code says (`jarod://pair#v=2&h=…&k=…&p=…&u=…&n=…`). */
export interface PairingLink {
  hostId: string
  /** The PC's X25519 public key: pinned, the phone will talk to nothing else. */
  hostKey: Uint8Array
  hostKeyText: string
  /** The one-time code, 32 bytes. */
  code: Uint8Array
  /** Where the PC listens: LAN first, then Tailscale. Only private addresses are kept. */
  urls: string[]
  name: string
}

const B64U = /^[\w-]+$/

/**
 * Reads a pairing link, or the fragment alone. Anything malformed is refused whole: a QR code that
 * sends the phone to a public address, or carries a short key, opens nothing.
 */
export function parsePairingLink(text: string): PairingLink | null {
  const raw = text.trim()
  const hash = raw.indexOf('#')
  if (hash < 0) return null
  if (hash > 0 && !raw.toLowerCase().startsWith('jarod://pair')) return null
  const p = new URLSearchParams(raw.slice(hash + 1))
  const hostId = p.get('h') ?? ''
  const k = p.get('k') ?? ''
  const code = p.get('p') ?? ''
  if (p.get('v') !== '2' || !B64U.test(hostId) || !B64U.test(k) || !B64U.test(code)) return null
  let hostKey: Uint8Array
  let secret: Uint8Array
  try {
    hostKey = b64uDecode(k)
    secret = b64uDecode(code)
  } catch {
    return null
  }
  if (hostKey.length !== 32 || secret.length !== 32) return null
  const urls = (p.get('u') ?? '')
    .split(',')
    .map(u => u.trim())
    .filter(u => {
      try {
        const url = new URL(u)
        return url.protocol === 'http:' && !url.username && !url.password && url.pathname === '/' && isPrivateAddress(url.hostname.replace(/^\[|\]$/g, ''))
      } catch {
        return false
      }
    })
    .map(u => new URL(u).origin)
  return { hostId, hostKey, hostKeyText: k, code: secret, urls: [...new Set(urls)], name: (p.get('n') ?? '').slice(0, 60) || 'PC' }
}
