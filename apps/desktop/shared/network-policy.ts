/*
 * Jarod's Internet switch (docs/NETWORK-POLICY.md). One file, `network-policy.json` in the shell's config folder, says whether what Jarod
 * starts may reach the Internet. The shell applies it to its own web sessions and Node calls, and passes its path to the core, which applies
 * it to its sockets and its tools. This is Jarod's policy, not a disconnection: Windows and other programs keep their network.
 *
 * Same decision as `jarod-core/packages/kernel/src/network-policy.ts` (the core cannot import the shell, nor the shell the core): a change
 * here goes there too, and the two test files hold the same cases.
 */

export interface NetworkPolicy {
  version: 1
  /** Internet allowed for Jarod. */
  internet: boolean
  /** While the Internet is off: the remote machines below stay reachable (SSH, Tailscale). */
  remoteMachines: boolean
  /** Host names or IP addresses of the configured remote machines (lower case). */
  remoteHosts: string[]
  /** While the Internet is off: the agent may still run local commands and MCP servers, which Jarod cannot cut off from the network. */
  localCommands: boolean
}

export const POLICY_FILE = 'network-policy.json'

/** A first start (no file yet): everything works as before the switch existed. */
export const DEFAULT_POLICY: NetworkPolicy = { version: 1, internet: true, remoteMachines: false, remoteHosts: [], localCommands: false }

/** An unreadable or invalid file: the cautious reading, Internet off and no exception. */
export const CAUTIOUS_POLICY: NetworkPolicy = { version: 1, internet: false, remoteMachines: false, remoteHosts: [], localCommands: false }

const HOST = /^[a-z0-9]([a-z0-9.:-]{0,251}[a-z0-9])?$/

export function isPolicyHost(value: string): boolean {
  return HOST.test(value)
}

/** The policy in a file's text. `null` (no file) is the default; anything malformed is the cautious policy, never a silent "on". */
export function parsePolicy(text: string | null): NetworkPolicy {
  if (text === null) {
    return { ...DEFAULT_POLICY }
  }

  try {
    const raw = JSON.parse(text) as Record<string, unknown>

    if (!raw || typeof raw !== 'object' || raw.version !== 1 || typeof raw.internet !== 'boolean') {
      return { ...CAUTIOUS_POLICY }
    }

    const hosts = Array.isArray(raw.remoteHosts) ? raw.remoteHosts.filter((h): h is string => typeof h === 'string').map(h => h.trim().toLowerCase()).filter(isPolicyHost) : []

    return { version: 1, internet: raw.internet, remoteMachines: raw.remoteMachines === true, remoteHosts: [...new Set(hosts)].slice(0, 64), localCommands: raw.localCommands === true }
  } catch {
    return { ...CAUTIOUS_POLICY }
  }
}

/** The host part of an address, without brackets, port or trailing dot, in lower case. */
export function normalizeHost(host: string): string {
  let h = host.trim().toLowerCase()

  if (h.startsWith('[')) {
    h = h.slice(1, h.indexOf(']') > 0 ? h.indexOf(']') : undefined)
  }

  return h.replace(/\.$/, '')
}

/** This machine: `localhost`, `*.localhost`, 127.0.0.0/8, ::1 and their IPv4-mapped forms, and the unspecified address. */
export function isLoopback(host: string): boolean {
  const h = normalizeHost(host)

  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1' || h === '0:0:0:0:0:0:0:1' || h === '0.0.0.0' || h === '::') {
    return true
  }

  const v4 = h.startsWith('::ffff:') ? h.slice(7) : h

  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4)
}

export type HostVerdict = 'loopback' | 'internet' | 'remote' | 'blocked'

/** Whether Jarod may open a connection to `host` under `policy`. */
export function decideHost(policy: NetworkPolicy, host: string): HostVerdict {
  if (isLoopback(host)) {
    return 'loopback'
  }

  if (policy.internet) {
    return 'internet'
  }

  if (policy.remoteMachines && policy.remoteHosts.includes(normalizeHost(host))) {
    return 'remote'
  }

  return 'blocked'
}

/** The error every refused call carries, so the UI can recognise it and explain. */
export const OFFLINE_CODE = 'JAROD_OFFLINE'

export class OfflineError extends Error {
  readonly code = OFFLINE_CODE

  constructor(what: string) {
    super(`Internet désactivé pour Jarod : ${what} n'est pas autorisé. Réactivez-le dans la barre du haut.`)
  }
}
