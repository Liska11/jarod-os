/*
 * What the embedded Pinokio engine (pinokiod) lets in. Upstream it listens on every interface and
 * answers anyone: its WebSocket runs shell commands on request, with no token and no Origin check, so
 * a web page in any browser (cross-site WebSocket) or a machine on the network could drive it. The
 * host (host.ts) binds it to loopback and puts this check in front of every request and upgrade:
 *
 * - Host must name this machine (localhost, 127.0.0.1, [::1], or a `*.localhost` app address, which
 *   Pinokio uses for its per-app proxies), on any port: that stops DNS rebinding;
 * - a browser request that says where it comes from (Origin) must come from such a page too; the
 *   Pinokio UI, the apps it starts and Jarod-OS's own calls (no Origin at all) pass, other sites do
 *   not. `null` origins (sandboxed frames, file:// pages) are refused.
 *
 * Pure, so it is tested without a server.
 */

export interface GuardRequest {
  method?: string
  host?: string | string[]
  origin?: string | string[]
}

export type GuardVerdict = { ok: true } | { ok: false; reason: string }

const first = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value)

/** `host[:port]` → hostname, lowercased, brackets kept for IPv6 (`[::1]`). */
export function hostnameOf(hostHeader: string): string {
  const value = hostHeader.trim().toLowerCase()

  if (value.startsWith('[')) {
    const end = value.indexOf(']')

    return end === -1 ? value : value.slice(0, end + 1)
  }

  const colon = value.indexOf(':')

  return colon === -1 ? value : value.slice(0, colon)
}

/** A name that can only mean this machine. */
export function isLoopbackName(hostname: string): boolean {
  const name = hostname.toLowerCase().replace(/\.$/, '')

  return name === 'localhost' || name === '127.0.0.1' || name === '[::1]' || name === '::1' || name.endsWith('.localhost') || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name)
}

/** An Origin header value that comes from a page served by this machine. */
export function isLoopbackOrigin(origin: string): boolean {
  let url: URL

  try {
    url = new URL(origin)
  } catch {
    return false
  }

  return (url.protocol === 'http:' || url.protocol === 'https:') && isLoopbackName(url.hostname)
}

export function checkRequest(request: GuardRequest): GuardVerdict {
  const host = first(request.host)

  if (!host || !isLoopbackName(hostnameOf(host))) {
    return { ok: false, reason: `host ${host ?? '(none)'} is not this machine` }
  }

  const origin = first(request.origin)

  if (origin !== undefined && !isLoopbackOrigin(origin)) {
    return { ok: false, reason: `origin ${origin} is not a page on this machine` }
  }

  return { ok: true }
}
