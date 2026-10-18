import { b64uDecode, type CryptoKeyPair, exportKeyPair, generateKeyPair, importKeyPair } from '@jarod-protocol'
import { type ChannelOptions, type JarodChannel, openChannel } from './channel.ts'
import { isNative, vault, wake } from './native.ts'
import type { PairingLink } from './pairing-link.ts'
import { addressOrder, forgetPc, type PairedPc, savePc } from './pairing-store.ts'

type Handlers = Pick<ChannelOptions, 'onEvent' | 'onClose'>

/** In a desktop browser with the dev proxy, the PC is the page's own origin. */
const devUrls = (urls: string[]) => (!isNative && import.meta.env.DEV ? [''] : urls)

/**
 * Pairs this phone with the PC of the QR code. The device key is wrapped by the Keystore before
 * anything else (the phone asks for the fingerprint, face or PIN), so it is never stored in clear.
 */
export async function pair(link: PairingLink, deviceName: string, handlers: Handlers): Promise<{ pc: PairedPc; keys: CryptoKeyPair; channel: JarodChannel }> {
  const fresh = await generateKeyPair(true)
  const jwk = await exportKeyPair(fresh)
  const { blob } = await vault.seal({ plaintext: jwk, title: 'Protéger la clé de ce téléphone', subtitle: `Association avec ${link.name}` })
  // From here on the key is used non-extractable: the page itself cannot read it back.
  const keys = await importKeyPair(jwk)
  const channel = await openChannel({
    urls: devUrls(link.urls),
    hostKey: link.hostKey,
    keys,
    pairingCode: link.code,
    deviceName,
    ...handlers
  })
  const pc: PairedPc = {
    v: 1,
    hostId: link.hostId,
    hostKey: link.hostKeyText,
    name: link.name,
    urls: link.urls,
    lastUrl: channel.base || undefined,
    wrappedKey: blob,
    deviceName,
    pairedAt: Date.now(),
    watch: true
  }
  savePc(pc)
  return { pc, keys, channel }
}

/** Biometric unlock: the Keystore unwraps the device key, for this session only. */
export async function unlock(pc: PairedPc): Promise<CryptoKeyPair> {
  const { plaintext } = await vault.open({ blob: pc.wrappedKey, title: 'Déverrouiller Jarod', subtitle: pc.name })
  return importKeyPair(plaintext)
}

export async function connect(pc: PairedPc, keys: CryptoKeyPair, handlers: Handlers): Promise<JarodChannel> {
  const channel = await openChannel({ urls: devUrls(addressOrder(pc)), hostKey: b64uDecode(pc.hostKey), keys, ...handlers })
  if (channel.base && channel.base !== pc.lastUrl) savePc({ ...pc, lastUrl: channel.base })
  return channel
}

/**
 * Turns the closed-app watch on with a fresh wake token (the old one stops working on the PC), or
 * off. The service only ever learns "there is news".
 */
export async function setWatch(pc: PairedPc, channel: JarodChannel | null, on: boolean): Promise<void> {
  savePc({ ...pc, watch: on })
  if (!on || !channel) {
    if (!on) await wake.stop()
    return
  }
  const { token, seq } = await channel.rpc<{ token: string; seq: number }>('wake.register')
  await wake.start({ urls: addressOrder(pc), token, seq, title: 'Jarod a du nouveau', text: 'Ouvrez l’appli pour voir.' })
}

/** Forgets the PC: tells it (if it can still be reached), stops the watch, wipes the key. */
export async function forget(channel: JarodChannel | null): Promise<void> {
  try {
    await channel?.rpc('device.leave', undefined, 5000)
  } catch {
    // Unreachable: the PC still lists the phone until it is removed there.
  }
  channel?.close()
  await wake.stop().catch(() => {})
  await vault.wipe().catch(() => {})
  forgetPc()
}
