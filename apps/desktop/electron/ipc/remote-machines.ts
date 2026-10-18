import { randomUUID } from 'node:crypto'
import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc.ts'
import { log } from '../log.ts'
import type { NetworkPolicyService } from '../network.ts'
import { compareKeys, HOST, type HostKey, type HostKeyVerdict, knownFingerprints, scanHostKeys, tailscaleState, tcpProbe, trustHostKeys } from '../remote-machines.ts'

/*
 * Connexions › Machines distantes, main side (electron/remote-machines.ts). Every network step follows the Internet switch: a machine is
 * reachable while the Internet is off only when it is listed and the "remote machines" exception is on. Host keys are written only after
 * the person confirmed the fingerprints shown, and only the keys scanned here (kept under a one-time token): the screen cannot hand main a
 * key line of its own.
 */

const validPort = (port: unknown): port is number => Number.isInteger(port) && (port as number) >= 1 && (port as number) <= 65535

export interface ScanView {
  token: string
  verdict: HostKeyVerdict
  keys: Array<{ type: string; fingerprint: string }>
  known: string[]
}

export function registerRemoteMachinesIpc(network: NetworkPolicyService): void {
  const scans = new Map<string, { host: string; port: number; keys: HostKey[]; verdict: HostKeyVerdict; at: number }>()

  const allowed = (host: string): boolean => network.allows(host)

  ipcMain.handle(IPC.remoteTailscale, () => tailscaleState())

  ipcMain.handle(IPC.remoteProbe, async (_event, host: unknown, port: unknown) => {
    if (typeof host !== 'string' || !HOST.test(host) || !validPort(port)) return { ok: false, ms: 0, error: 'invalid' }
    if (!allowed(host)) return { ok: false, ms: 0, error: 'offline' }

    return tcpProbe(host, port)
  })

  ipcMain.handle(IPC.remoteScanKeys, async (_event, host: unknown, port: unknown): Promise<ScanView | { error: string }> => {
    if (typeof host !== 'string' || !HOST.test(host) || !validPort(port)) return { error: 'invalid' }
    if (!allowed(host)) return { error: 'offline' }

    const [keys, known] = await Promise.all([scanHostKeys(host, port), knownFingerprints(host, port)])
    const verdict = compareKeys(keys, known)
    const token = randomUUID()

    for (const [old, scan] of scans) {
      if (Date.now() - scan.at > 10 * 60_000) scans.delete(old)
    }

    scans.set(token, { host, port, keys, verdict, at: Date.now() })

    return { token, verdict, keys: keys.map(key => ({ type: key.type, fingerprint: key.fingerprint })), known }
  })

  ipcMain.handle(IPC.remoteTrustKeys, async (_event, token: unknown): Promise<{ ok: boolean; error?: string }> => {
    const scan = typeof token === 'string' ? scans.get(token) : undefined

    if (!scan || scan.keys.length === 0 || scan.verdict === 'match' || scan.verdict === 'unreachable') return { ok: false, error: 'nothing-to-trust' }

    scans.delete(token as string)

    try {
      await trustHostKeys(scan.host, scan.port, scan.keys, scan.verdict === 'changed')
      log('remote', `host key of ${scan.host}:${scan.port} ${scan.verdict === 'changed' ? 'replaced' : 'trusted'} after confirmation (${scan.keys.map(key => key.fingerprint).join(', ')})`)

      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  /** The configured machines' addresses, for the Internet switch's "remote machines" exception. */
  ipcMain.handle(IPC.remoteSyncHosts, async (_event, hosts: unknown) => {
    const list = Array.isArray(hosts) ? hosts.filter((host): host is string => typeof host === 'string' && HOST.test(host)).slice(0, 64) : []

    return network.set({ remoteHosts: list })
  })
}
