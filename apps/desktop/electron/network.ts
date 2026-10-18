import fs from 'node:fs'
import path from 'node:path'
import { CAUTIOUS_POLICY, decideHost, isPolicyHost, type NetworkPolicy, normalizeHost, OfflineError, parsePolicy, POLICY_FILE } from '../shared/network-policy.ts'
import { writeFileAtomic } from './atomic-write.ts'

/*
 * The shell's side of the Internet switch (docs/NETWORK-POLICY.md): it owns `network-policy.json`, reads it before anything starts, applies it
 * to every web session (a proxy that leads nowhere, loopback and the allowed remote machines excepted) and to its own Node sockets, and answers
 * the checks of what it launches (downloads, `uv`, `wsl --install`, update checks). The core reads the same file on every connection.
 */

/** A proxy on the discard port of this machine: nothing listens, so a request through it fails at once, and Chromium never falls back to a direct connection. */
export const DEAD_PROXY = 'http=127.0.0.1:9;https=127.0.0.1:9;ftp=127.0.0.1:9;socks=127.0.0.1:9'

/** What a web session needs to know about the policy. */
export interface ProxyChoice {
  mode: 'system' | 'fixed_servers'
  proxyRules?: string
  proxyBypassRules?: string
}

/** The proxy settings a web session takes under `policy`. Loopback is always bypassed by Chromium (`<-loopback>` would be needed to proxy it). */
export function proxyFor(policy: NetworkPolicy): ProxyChoice {
  if (policy.internet) {
    return { mode: 'system' }
  }

  const bypass = policy.remoteMachines ? policy.remoteHosts.join(';') : ''

  return { mode: 'fixed_servers', proxyRules: DEAD_PROXY, proxyBypassRules: bypass }
}

export interface NetworkSessions {
  /** Applies a proxy choice to every web session, present and future, and drops their open connections when `cut` is set. */
  apply(choice: ProxyChoice, cut: boolean): Promise<void>
}

export class NetworkPolicyService {
  readonly file: string
  private policy: NetworkPolicy = { ...CAUTIOUS_POLICY }
  private readonly listeners = new Set<(policy: NetworkPolicy) => void>()
  private sessions: NetworkSessions | null = null

  constructor(configDir: string) {
    this.file = path.join(configDir, POLICY_FILE)
  }

  /** Reads the file (writing the default on a first start, so the core finds one). An unreadable or invalid file reads as Internet off. */
  load(): NetworkPolicy {
    let text: string | null

    try {
      text = fs.readFileSync(this.file, 'utf8')
    } catch (error) {
      text = (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : '!'
    }

    this.policy = parsePolicy(text)

    if (text === null) {
      try {
        writeFileAtomic(this.file, `${JSON.stringify(this.policy, null, 2)}\n`)
      } catch {
        // The core then finds no file and stays offline: cautious, and Settings shows the switch as it is here.
      }
    }

    return this.get()
  }

  get(): NetworkPolicy {
    return { ...this.policy, remoteHosts: [...this.policy.remoteHosts] }
  }

  /** Changes the policy: written first (the core reads the file), then applied to the web sessions, then announced. */
  async set(change: Partial<Omit<NetworkPolicy, 'version'>>): Promise<NetworkPolicy> {
    const next = validChange(this.policy, change)
    writeFileAtomic(this.file, `${JSON.stringify(next, null, 2)}\n`)
    this.policy = next
    // Offline (or a narrower exception): open connections are dropped, so a stream started before does not go on.
    await this.sessions?.apply(proxyFor(next), !next.internet)

    for (const listener of this.listeners) {
      listener(this.get())
    }

    return this.get()
  }

  /** Binds the web sessions and applies the current policy to them (before any window loads). */
  async attach(sessions: NetworkSessions): Promise<void> {
    this.sessions = sessions
    await sessions.apply(proxyFor(this.policy), false)
  }

  onChange(listener: (policy: NetworkPolicy) => void): () => void {
    this.listeners.add(listener)

    return () => this.listeners.delete(listener)
  }

  /** Whether a connection to `host` is allowed now. */
  allows(host: string): boolean {
    return decideHost(this.policy, host) !== 'blocked'
  }

  /** Throws an OfflineError when `url` may not be reached; `what` names the action for the message. */
  assertUrl(url: string, what: string): void {
    let host: string

    try {
      host = new URL(url).hostname
    } catch {
      throw new OfflineError(what)
    }

    if (!this.allows(host)) {
      throw new OfflineError(what)
    }
  }

  /** For a program Jarod launches that reaches the Internet by itself (`uv`, `wsl --install`, `winget`): refused while the Internet is off. */
  assertInternet(what: string): void {
    if (!this.policy.internet) {
      throw new OfflineError(what)
    }
  }
}

function validChange(current: NetworkPolicy, change: Partial<Omit<NetworkPolicy, 'version'>>): NetworkPolicy {
  const next = { ...current, remoteHosts: [...current.remoteHosts] }

  for (const key of Object.keys(change)) {
    if (!['internet', 'remoteMachines', 'remoteHosts', 'localCommands'].includes(key)) {
      throw new Error(`réglage réseau inconnu : ${key}`)
    }
  }

  for (const key of ['internet', 'remoteMachines', 'localCommands'] as const) {
    if (change[key] !== undefined) {
      if (typeof change[key] !== 'boolean') {
        throw new Error(`${key} : vrai ou faux attendu`)
      }

      next[key] = change[key]
    }
  }

  if (change.remoteHosts !== undefined) {
    if (!Array.isArray(change.remoteHosts) || change.remoteHosts.length > 64) {
      throw new Error('machines distantes : 64 adresses au plus')
    }

    const hosts = change.remoteHosts.map(host => (typeof host === 'string' ? normalizeHost(host) : ''))
    const bad = hosts.find(host => !isPolicyHost(host))

    if (bad !== undefined) {
      throw new Error(`adresse de machine invalide : ${String(bad).slice(0, 80)}`)
    }

    next.remoteHosts = [...new Set(hosts)]
  }

  return next
}

/** The running shell's policy, for the modules that launch downloads or programs reaching the Internet (set once in main.ts). */
let active: NetworkPolicyService | null = null

export function setActiveNetworkPolicy(service: NetworkPolicyService): void {
  active = service
}

/** Refuses (OfflineError) what needs the Internet while it is off. Without a policy (unit tests of other modules), allows. */
export function assertInternet(what: string): void {
  active?.assertInternet(what)
}

/** Refuses (OfflineError) a call to `url` the policy does not allow. */
export function assertUrl(url: string, what: string): void {
  active?.assertUrl(url, what)
}

/** Whether the Internet is on for Jarod (true without a policy). */
export function internetAllowed(): boolean {
  return active ? active.get().internet : true
}
