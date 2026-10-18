import { describe, expect, it } from 'vitest'
import { nativeX25519, patchSubtle } from './x25519-shim.ts'

const real = crypto.subtle

/** A WebCrypto like an old WebView's: everything works but X25519. */
function oldWebView(): SubtleCrypto {
  const refuse = (alg: unknown) => ((typeof alg === 'string' ? alg : (alg as { name?: string })?.name) === 'X25519' ? Promise.reject(new DOMException('no', 'NotSupportedError')) : null)
  return {
    generateKey: (a: never, e: boolean, u: never) => refuse(a) ?? real.generateKey(a, e, u),
    importKey: (f: never, d: never, a: never, e: boolean, u: never) => refuse(a) ?? real.importKey(f, d, a, e, u),
    exportKey: (f: never, k: never) => real.exportKey(f, k),
    deriveBits: (a: never, k: CryptoKey, l: number) => refuse(a) ?? real.deriveBits(a, k, l)
  } as unknown as SubtleCrypto
}

const X = { name: 'X25519' } as never

describe('X25519 for old WebViews', () => {
  it('is installed only where X25519 is missing', async () => {
    expect(await nativeX25519(real)).toBe(true)
    const old = oldWebView()
    expect(await nativeX25519(old)).toBe(false)
    expect(await nativeX25519(patchSubtle(old))).toBe(true)
  })

  it('agrees with a real WebCrypto on both sides of the exchange', async () => {
    const shim = patchSubtle(oldWebView())
    const a = (await shim.generateKey(X, false, ['deriveBits'])) as CryptoKeyPair
    const b = (await real.generateKey(X, false, ['deriveBits'])) as CryptoKeyPair
    const aPub = new Uint8Array((await shim.exportKey('raw', a.publicKey)) as ArrayBuffer)
    const bPub = new Uint8Array(await real.exportKey('raw', b.publicKey))
    expect(aPub).toHaveLength(32)

    const fromShim = new Uint8Array(
      await shim.deriveBits({ name: 'X25519', public: await shim.importKey('raw', bPub, X, false, []) } as never, a.privateKey, 256)
    )
    const fromReal = new Uint8Array(await real.deriveBits({ name: 'X25519', public: await real.importKey('raw', aPub, X, false, []) } as never, b.privateKey, 256))
    expect(fromShim).toEqual(fromReal)
  })

  it('keeps JWK compatible with a real WebCrypto, and refuses to export a non-extractable key', async () => {
    const shim = patchSubtle(oldWebView())
    const pair = (await shim.generateKey(X, true, ['deriveBits'])) as CryptoKeyPair
    const jwk = (await shim.exportKey('jwk', pair.privateKey)) as JsonWebKey
    expect(jwk).toMatchObject({ kty: 'OKP', crv: 'X25519' })
    // A real WebCrypto reads it, and finds the same public key.
    const back = await real.importKey('jwk', jwk, X, true, ['deriveBits'])
    expect((await real.exportKey('jwk', back)).x).toBe(jwk.x)

    const locked = await shim.importKey('jwk', jwk, X, false, ['deriveBits'])
    await expect(shim.exportKey('jwk', locked)).rejects.toThrow('non extractible')
    // Inconsistent or foreign keys are refused.
    await expect(shim.importKey('jwk', { ...jwk, x: jwk.d }, X, false, ['deriveBits'])).rejects.toThrow()
    await expect(shim.importKey('raw', new Uint8Array(16), X, false, [])).rejects.toThrow('invalide')
  })

  it('refuses a low-order peer key (all-zero secret)', async () => {
    const shim = patchSubtle(oldWebView())
    const pair = (await shim.generateKey(X, false, ['deriveBits'])) as CryptoKeyPair
    const zero = await shim.importKey('raw', new Uint8Array(32), X, false, [])
    await expect(shim.deriveBits({ name: 'X25519', public: zero } as never, pair.privateKey, 256)).rejects.toThrow()
  })

  it('leaves the other algorithms to the WebView', async () => {
    const shim = patchSubtle(oldWebView())
    const key = await shim.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt'])
    expect((key as CryptoKey).algorithm).toMatchObject({ name: 'AES-GCM' })
  })
})
