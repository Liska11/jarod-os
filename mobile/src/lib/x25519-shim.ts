import { x25519 } from '@noble/curves/ed25519.js'

/**
 * X25519 for WebViews older than Chrome 133, whose WebCrypto lacks it (Android 9 phones stay on
 * such versions). The protocol file is the core's own and calls `crypto.subtle` for X25519; this
 * fills in exactly those calls — generateKey, importKey, exportKey, deriveBits for `X25519` — with
 * @noble/curves (audited, constant-time). Everything else (AES-GCM, HKDF, HMAC, SHA-256) stays the
 * WebView's. Installed only when the WebView refuses X25519 itself.
 *
 * A key made here is "non-extractable" the way WebCrypto's is: exportKey refuses it. Its bytes live
 * in a private field rather than in the browser's key store; the device key at rest is still wrapped
 * by the Android Keystore.
 */
class ShimKey {
  readonly algorithm = { name: 'X25519' }
  readonly #bytes: Uint8Array

  constructor(
    readonly type: 'public' | 'private',
    bytes: Uint8Array,
    readonly extractable: boolean,
    readonly usages: string[]
  ) {
    this.#bytes = bytes.slice()
  }

  static bytes(key: ShimKey): Uint8Array {
    return key.#bytes
  }
}

const b64u = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const unb64u = (text: string) => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4)), c => c.charCodeAt(0))
const toBytes = (data: BufferSource): Uint8Array =>
  data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)

const isX25519 = (alg: unknown) => (typeof alg === 'string' ? alg : (alg as { name?: string } | null)?.name)?.toUpperCase() === 'X25519'

/** True when the WebView does X25519 by itself. */
export async function nativeX25519(subtle: SubtleCrypto = crypto.subtle): Promise<boolean> {
  try {
    await subtle.generateKey({ name: 'X25519' } as never, false, ['deriveBits'])
    return true
  } catch {
    return false
  }
}

/** Wraps `subtle` so that X25519 works. Returns the same object, patched. */
export function patchSubtle(subtle: SubtleCrypto): SubtleCrypto {
  const s = subtle as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>
  const generateKey = s.generateKey!.bind(subtle)
  const importKey = s.importKey!.bind(subtle)
  const exportKey = s.exportKey!.bind(subtle)
  const deriveBits = s.deriveBits!.bind(subtle)

  s.generateKey = async (alg, extractable, usages) => {
    if (!isX25519(alg)) return generateKey(alg, extractable, usages)
    const secret = x25519.utils.randomSecretKey()
    return {
      privateKey: new ShimKey('private', secret, Boolean(extractable), ['deriveBits']),
      publicKey: new ShimKey('public', x25519.getPublicKey(secret), true, [])
    }
  }

  s.importKey = async (format, data, alg, extractable, usages) => {
    if (!isX25519(alg)) return importKey(format, data, alg, extractable, usages)
    if (format === 'raw') {
      const raw = toBytes(data as BufferSource)
      if (raw.length !== 32) throw new DOMException('Clé X25519 invalide', 'DataError')
      return new ShimKey('public', raw, true, [])
    }
    if (format === 'jwk') {
      const jwk = data as { kty?: string; crv?: string; x?: string; d?: string }
      if (jwk.kty !== 'OKP' || jwk.crv !== 'X25519') throw new DOMException('JWK X25519 attendue', 'DataError')
      if (jwk.d) {
        const secret = unb64u(jwk.d)
        if (secret.length !== 32) throw new DOMException('Clé X25519 invalide', 'DataError')
        if (jwk.x && b64u(x25519.getPublicKey(secret)) !== jwk.x) throw new DOMException('JWK incohérente', 'DataError')
        return new ShimKey('private', secret, Boolean(extractable), ['deriveBits'])
      }
      if (!jwk.x) throw new DOMException('JWK sans clé', 'DataError')
      return new ShimKey('public', unb64u(jwk.x), true, [])
    }
    throw new DOMException(`Format ${String(format)} non pris en charge pour X25519`, 'NotSupportedError')
  }

  s.exportKey = async (format, key) => {
    if (!(key instanceof ShimKey)) return exportKey(format, key)
    if (!key.extractable) throw new DOMException('Clé non extractible', 'InvalidAccessError')
    const bytes = ShimKey.bytes(key)
    if (format === 'raw' && key.type === 'public') return bytes.slice().buffer
    if (format === 'jwk') {
      return key.type === 'private'
        ? { kty: 'OKP', crv: 'X25519', x: b64u(x25519.getPublicKey(bytes)), d: b64u(bytes), ext: true, key_ops: ['deriveBits'] }
        : { kty: 'OKP', crv: 'X25519', x: b64u(bytes), ext: true, key_ops: [] }
    }
    throw new DOMException(`Format ${String(format)} non pris en charge pour X25519`, 'NotSupportedError')
  }

  s.deriveBits = async (alg, key, length) => {
    if (!isX25519(alg)) return deriveBits(alg, key, length)
    const peer = (alg as { public?: unknown }).public
    if (!(key instanceof ShimKey) || key.type !== 'private' || !(peer instanceof ShimKey) || peer.type !== 'public') {
      throw new DOMException('Clés X25519 attendues', 'InvalidAccessError')
    }
    // Rejects low-order peer keys (an all-zero shared secret), as WebCrypto does.
    const shared = x25519.getSharedSecret(ShimKey.bytes(key), ShimKey.bytes(peer))
    const bytes = typeof length === 'number' ? length / 8 : 32
    return shared.slice(0, bytes).buffer
  }
  return subtle
}

/** Installs the fallback when the WebView has no X25519. Says which it is, for the logs. */
export async function ensureX25519(): Promise<'native' | 'fallback'> {
  if (await nativeX25519()) return 'native'
  patchSubtle(crypto.subtle)
  return 'fallback'
}
