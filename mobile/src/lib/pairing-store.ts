/**
 * The one PC this phone is paired with. Nothing here opens anything by itself: the device key is
 * stored wrapped by the Keystore (`wrappedKey`), and the wake token lives only in the native service.
 */
export interface PairedPc {
  v: 1
  hostId: string
  /** The PC's public key (base64url), pinned at pairing. */
  hostKey: string
  name: string
  urls: string[]
  /** The address that answered last: tried first. */
  lastUrl?: string
  wrappedKey: string
  deviceName: string
  pairedAt: number
  /** The closed-app watch is on (the person can turn it off). */
  watch: boolean
}

const KEY = 'jarod.pairedPc'

export interface KeyValue {
  getItem(k: string): string | null
  setItem(k: string, v: string): void
  removeItem(k: string): void
}

export function loadPc(store: KeyValue = localStorage): PairedPc | null {
  try {
    const raw = JSON.parse(store.getItem(KEY) ?? 'null') as Partial<PairedPc> | null
    if (!raw || raw.v !== 1 || !raw.hostKey || !raw.wrappedKey || !Array.isArray(raw.urls)) return null
    return { watch: true, ...raw } as PairedPc
  } catch {
    return null
  }
}

export function savePc(pc: PairedPc, store: KeyValue = localStorage): void {
  store.setItem(KEY, JSON.stringify(pc))
}

export function forgetPc(store: KeyValue = localStorage): void {
  store.removeItem(KEY)
}

/** The last address that worked first, then the others in the PC's order. */
export function addressOrder(pc: Pick<PairedPc, 'urls' | 'lastUrl'>): string[] {
  return pc.lastUrl && pc.urls.includes(pc.lastUrl) ? [pc.lastUrl, ...pc.urls.filter(u => u !== pc.lastUrl)] : pc.urls
}
