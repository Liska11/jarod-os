import { execFile } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

/*
 * Remote machines (docs/REMOTE-SSH.md): Tailscale's state and peers (read from the local Tailscale service, nothing is installed, no account
 * connected), a network test (TCP) kept apart from the authentication test (the core's fixed SSH test), and the host keys: read with
 * ssh-keyscan, shown as SHA256 fingerprints, written to the person's known_hosts only after they confirm. Verification is never turned off.
 */

export interface TailscalePeer {
  name: string
  dnsName: string
  ips: string[]
  os: string
  online: boolean
  /** Tailscale SSH offered by that machine (distinct from an OpenSSH server reached over Tailscale). */
  sshHostKeys: boolean
}

export interface TailscaleState {
  installed: boolean
  /** Running, NeedsLogin, Stopped, NoState, Starting… as Tailscale says it; null when not installed or unreadable. */
  backend: string | null
  self: { name: string; ips: string[] } | null
  peers: TailscalePeer[]
  error?: string
}

const SSH_DIR = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'OpenSSH')

export function sshTool(name: 'ssh' | 'ssh-keyscan' | 'ssh-keygen'): string {
  const exe = path.join(SSH_DIR, `${name}.exe`)

  return process.platform === 'win32' && fs.existsSync(exe) ? exe : name
}

export function tailscaleExe(env: NodeJS.ProcessEnv = process.env): string | null {
  const candidates = [path.join(env.ProgramFiles ?? 'C:\\Program Files', 'Tailscale', 'tailscale.exe'), path.join(env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Tailscale', 'tailscale.exe')]

  return candidates.find(file => fs.existsSync(file)) ?? null
}

/** `tailscale status --json` → what the screen shows. */
export function parseTailscale(json: string): Omit<TailscaleState, 'installed'> {
  const raw = JSON.parse(json) as {
    BackendState?: string
    Self?: { HostName?: string; TailscaleIPs?: string[] | null }
    Peer?: Record<string, { HostName?: string; DNSName?: string; TailscaleIPs?: string[] | null; OS?: string; Online?: boolean; sshHostKeys?: string[] | null }> | null
  }
  const peers = Object.values(raw.Peer ?? {}).map(peer => ({
    name: String(peer.HostName ?? ''),
    dnsName: String(peer.DNSName ?? '').replace(/\.$/, ''),
    ips: (peer.TailscaleIPs ?? []).map(String),
    os: String(peer.OS ?? ''),
    online: peer.Online === true,
    sshHostKeys: Array.isArray(peer.sshHostKeys) && peer.sshHostKeys.length > 0
  }))

  return {
    backend: typeof raw.BackendState === 'string' ? raw.BackendState : null,
    self: raw.Self ? { name: String(raw.Self.HostName ?? ''), ips: (raw.Self.TailscaleIPs ?? []).map(String) } : null,
    peers: peers.sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name))
  }
}

const run = (file: string, args: string[], options: { timeout: number; input?: string } = { timeout: 15_000 }): Promise<{ code: number; stdout: string; stderr: string }> =>
  new Promise(resolve => {
    const child = execFile(file, args, { windowsHide: true, timeout: options.timeout, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof (error as { code?: unknown }).code === 'number' ? ((error as { code: number }).code) : 1) : 0, stdout: String(stdout), stderr: String(stderr || (error && !stdout ? error.message : '')) })
    })

    if (options.input !== undefined) {
      child.stdin?.end(options.input)
    }
  })

/** Reads Tailscale's state from its local service (no network of Jarod's own). Never logs in, never changes anything. */
export async function tailscaleState(): Promise<TailscaleState> {
  const exe = tailscaleExe()

  if (!exe) return { installed: false, backend: null, self: null, peers: [] }

  const result = await run(exe, ['status', '--json'], { timeout: 10_000 })

  try {
    return { installed: true, ...parseTailscale(result.stdout) }
  } catch {
    return { installed: true, backend: null, self: null, peers: [], error: result.stderr.trim().slice(0, 300) || 'état illisible' }
  }
}

/** Host names and addresses SSH may target: no spaces, no option-looking leading dash. */
export const HOST = /^(?!-)[A-Za-z0-9.:_[\]-]{1,253}$/

/** A TCP connection to host:port, closed at once: is something listening there? (No byte sent, no authentication.) */
export function tcpProbe(host: string, port: number, timeoutMs = 5000): Promise<{ ok: boolean; ms: number; error?: string }> {
  return new Promise(resolve => {
    const started = Date.now()
    const socket = net.connect({ host, port })
    const done = (ok: boolean, error?: string) => {
      socket.destroy()
      resolve({ ok, ms: Date.now() - started, ...(error ? { error } : {}) })
    }
    socket.setTimeout(timeoutMs, () => done(false, 'timeout'))
    socket.once('connect', () => done(true))
    socket.once('error', (error: NodeJS.ErrnoException) => done(false, error.code ?? error.message))
  })
}

export interface HostKey {
  type: string
  fingerprint: string
  /** The known_hosts line, as ssh-keyscan gave it. */
  line: string
}

/** known_hosts' way of naming a host on a non-default port. */
export const hostPattern = (host: string, port: number) => (port === 22 ? host : `[${host}]:${port}`)

/** `ssh-keyscan` lines (comments dropped) → keys with their SHA256 fingerprints (`ssh-keygen -lf -`). */
export function parseKeyscan(keyscan: string): Array<Omit<HostKey, 'fingerprint'>> {
  return keyscan
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .map(line => ({ type: line.split(/\s+/)[1] ?? '', line }))
    .filter(key => /^(ssh-|ecdsa-|sk-)/.test(key.type))
}

/** `ssh-keygen -lf` output: "256 SHA256:abc… host (ED25519)" → fingerprint. */
export function parseFingerprint(text: string): string | null {
  return /(SHA256:[A-Za-z0-9+/=]+)/.exec(text)?.[1] ?? null
}

async function fingerprintOf(line: string): Promise<string | null> {
  const result = await run(sshTool('ssh-keygen'), ['-lf', '-'], { timeout: 10_000, input: `${line}\n` })

  return parseFingerprint(result.stdout)
}

export async function scanHostKeys(host: string, port: number): Promise<HostKey[]> {
  const result = await run(sshTool('ssh-keyscan'), ['-T', '6', '-p', String(port), '--', host], { timeout: 15_000 })
  const keys: HostKey[] = []

  for (const key of parseKeyscan(result.stdout)) {
    const fingerprint = await fingerprintOf(key.line)

    if (fingerprint) keys.push({ ...key, fingerprint })
  }

  return keys
}

export function knownHostsFile(home = os.homedir()): string {
  return path.join(home, '.ssh', 'known_hosts')
}

/** The fingerprints known_hosts holds for this host (hashed entries included: ssh-keygen -F finds them). */
export async function knownFingerprints(host: string, port: number, file = knownHostsFile()): Promise<string[]> {
  if (!fs.existsSync(file)) return []

  const result = await run(sshTool('ssh-keygen'), ['-F', hostPattern(host, port), '-f', file], { timeout: 10_000 })
  const lines = result.stdout.split(/\r?\n/).filter(line => line.trim() && !line.startsWith('#'))
  const out: string[] = []

  for (const line of lines) {
    const fingerprint = await fingerprintOf(line)

    if (fingerprint) out.push(fingerprint)
  }

  return out
}

export type HostKeyVerdict = 'unknown' | 'match' | 'changed' | 'unreachable'

export function compareKeys(scanned: HostKey[], known: string[]): HostKeyVerdict {
  if (scanned.length === 0) return 'unreachable'
  if (known.length === 0) return 'unknown'

  return scanned.some(key => known.includes(key.fingerprint)) ? 'match' : 'changed'
}

/**
 * Writes the scanned keys of host:port to known_hosts, after the person confirmed their fingerprints. A changed key first has the old
 * entries removed with `ssh-keygen -R` (which keeps a known_hosts.old copy). Only lines this process scanned are ever written.
 */
export async function trustHostKeys(host: string, port: number, keys: HostKey[], replace: boolean, file = knownHostsFile()): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true })

  if (replace && fs.existsSync(file)) {
    const removed = await run(sshTool('ssh-keygen'), ['-R', hostPattern(host, port), '-f', file], { timeout: 10_000 })

    if (removed.code !== 0) throw new Error(`l’ancienne clé n’a pas pu être retirée : ${removed.stderr.trim().slice(0, 200)}`)
  }

  const text = keys.map(key => key.line).join('\n')
  const existing = fs.existsSync(file) ? await fs.promises.readFile(file, 'utf8') : ''
  await fs.promises.appendFile(file, `${existing && !existing.endsWith('\n') ? '\n' : ''}${text}\n`)
}
