/*
 * Devices & API: the data side of the section. Mirrors `api-server-*`, `phone-*`, `android-*` and `ssh-host*`.
 */

export interface ApiServerStatus {
  enabled: boolean
  running: boolean
  port: number
  host: '127.0.0.1' | '0.0.0.0'
  keyConfigured: boolean
  error: string
}

export interface PhoneStatus {
  mobile: { running: boolean; port: number; url: string; devices: { deviceId: string; name: string; pairedAt: number; lastSeen: number }[] }
  android: { adb: string | null; configured: string; state: 'ready' | 'unconfigured' | 'missing'; devices: { serial: string; state: string; model: string; product: string }[] }
}

export interface SshHost {
  id: string
  name: string
  host: string
  username: string
  port: number
  keyPath: string
}

export interface SshTest {
  ok: boolean
  output: string
  message: string
  durationMs: number
}

export interface PairingInfo {
  url: string
  secret: string
  expiresAt: number
}

/** Where a client reaches the API from, given the host setting. */
export function apiAddress(status: Pick<ApiServerStatus, 'host' | 'port'>): string {
  return `http://${status.host === '0.0.0.0' ? '<this PC’s address>' : '127.0.0.1'}:${status.port}/v1`
}

export function apiSummary(status: ApiServerStatus): string {
  if (status.error) {
    return `Could not start: ${status.error}`
  }

  if (status.running) {
    return `Running at ${apiAddress(status)}${status.host === '0.0.0.0' ? ' — open to the local network' : ' — this PC only'}.`
  }

  return status.keyConfigured ? 'Off. A key is saved.' : 'Off. Make a key first: every request must carry it.'
}

export function phoneSummary(status: PhoneStatus['mobile']): string {
  if (!status.running) {
    return 'Off. Turning it on opens a port to the whole local network; a phone still needs the pairing code.'
  }

  return `Listening on port ${status.port} · ${status.devices.length} paired phone${status.devices.length === 1 ? '' : 's'}`
}

export function androidSummary(status: PhoneStatus['android']): string {
  switch (status.state) {
    case 'ready':
      return `adb found${status.adb ? ` (${status.adb})` : ''} · ${status.devices.length} device${status.devices.length === 1 ? '' : 's'} connected`
    case 'missing':
      return 'The chosen adb program is missing. Choose it again.'
    default:
      return 'No adb found. Install the Android platform tools or choose adb.exe.'
  }
}

export function secondsLeft(expiresAt: number, now: number): number {
  return Math.max(0, Math.round((expiresAt - now) / 1000))
}

export function timeLeftText(seconds: number): string {
  return seconds <= 0 ? 'expired' : seconds >= 60 ? `${Math.floor(seconds / 60)} min ${seconds % 60} s` : `${seconds} s`
}

export interface SshDraft {
  name: string
  host: string
  username: string
  port: string
  keyPath: string
}

export const emptySsh = (): SshDraft => ({ name: '', host: '', username: '', port: '22', keyPath: '' })

/** Reasons a host declaration would be refused (the engine has the final word). The key path comes from the file dialog, never from typing. */
export function sshProblems(draft: SshDraft, existingNames: readonly string[]): string[] {
  const out: string[] = []
  const name = draft.name.trim()

  if (!name) {
    out.push('Name: required.')
  } else if (existingNames.includes(name)) {
    out.push(`A host called “${name}” already exists.`)
  }

  if (!draft.host.trim() || /\s/.test(draft.host.trim())) {
    out.push('Host: a name or address, without spaces.')
  }

  if (!draft.username.trim() || /\s/.test(draft.username.trim())) {
    out.push('User: required, without spaces.')
  }

  const port = Number(draft.port.trim())

  if (!/^\d+$/.test(draft.port.trim()) || port < 1 || port > 65535) {
    out.push('Port: 1 to 65535.')
  }

  if (!draft.keyPath) {
    out.push('Key: choose the private key file.')
  }

  return out
}

export function sshLine(host: SshHost): string {
  return `${host.username}@${host.host}${host.port === 22 ? '' : `:${host.port}`}`
}

/** A key file name for display (never the full path in a list). */
export function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}
