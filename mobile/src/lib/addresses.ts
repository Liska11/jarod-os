import { isPrivateAddress } from '@jarod-protocol'

/** More than this is never kept: a PC has a handful of addresses, not a hundred. */
export const MAX_URLS = 8

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

/**
 * A MagicDNS name: `machine.tailnet.ts.net`, and nothing else. The suffix is matched on whole labels
 * from the right, so `x.ts.net.evil.com`, `xts.net` and a trailing dot are all refused. A name under
 * any other domain is never accepted, whatever it resolves to.
 */
export function isTailnetName(host: string): boolean {
  const h = host.toLowerCase()
  if (h.length > 253 || !h.endsWith('.ts.net')) return false
  const labels = h.split('.')
  // machine + tailnet + ts + net: the tailnet's own name (tailnet.ts.net) is not a machine.
  return labels.length >= 4 && labels.every(l => LABEL.test(l))
}

/** A host the phone may dial: a private or tailnet IP, or a tailnet name. Never the Internet. */
export const isAcceptableHost = (host: string): boolean => isPrivateAddress(host.replace(/^\[|\]$/g, '')) || isTailnetName(host)

/**
 * One address as an origin (`http://host:port`), or null. The same rules for the QR code and for the
 * list the PC sends later: plain HTTP (the channel is sealed end to end), no credentials, no path.
 */
export function cleanAddress(raw: string): string | null {
  try {
    const url = new URL(raw.trim())
    if (url.protocol !== 'http:' || url.username || url.password || url.pathname !== '/') return null
    return isAcceptableHost(url.hostname) ? url.origin : null
  } catch {
    return null
  }
}

/** A list of addresses as received: only the good ones, once each, in the PC's order, at most {@link MAX_URLS}. */
export function cleanAddresses(list: unknown): string[] {
  if (!Array.isArray(list)) return []
  const out: string[] = []
  for (const item of list) {
    const clean = typeof item === 'string' ? cleanAddress(item) : null
    if (clean && !out.includes(clean)) out.push(clean)
    if (out.length === MAX_URLS) break
  }
  return out
}

/**
 * The PC's current list of addresses (sent inside the encrypted channel after each connection) replaces
 * the remembered one, checked by the same rules as the QR code. `lastUrl`, the address that just worked,
 * stays (and is tried first) while the PC still lists it. An answer with nothing valid in it changes
 * nothing: a bad message can never leave the phone with no way to the PC. The same object comes back
 * when nothing changed, so nothing is written for nothing.
 */
export function refreshAddresses<T extends { urls: string[]; lastUrl?: string | undefined }>(pc: T, received: unknown): T {
  const urls = cleanAddresses(received)
  if (urls.length === 0) return pc
  const lastUrl = pc.lastUrl && urls.includes(pc.lastUrl) ? pc.lastUrl : undefined
  const same = urls.length === pc.urls.length && urls.every((u, i) => u === pc.urls[i])
  if (same && lastUrl === pc.lastUrl) return pc
  const next = { ...pc, urls }
  if (lastUrl) next.lastUrl = lastUrl
  else delete next.lastUrl
  return next
}
