/*
 * Devices & API: the data side of the section. Mirrors `api-server-*`, `phone-*`, `android-*` and `ssh-host*`.
 */

import { t, tn } from '../../../lib/i18n.ts'

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
  /** The agent may run commands on it (remote_exec), each one confirmed. Off unless turned on here. */
  agentExec?: boolean
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
  return `http://${status.host === '0.0.0.0' ? t('settings.devices.addressUnknown') : '127.0.0.1'}:${status.port}/v1`
}

export function apiSummary(status: ApiServerStatus): string {
  if (status.error) {
    return t('settings.devices.api.noStart', { error: status.error })
  }

  if (status.running) {
    return t(status.host === '0.0.0.0' ? 'settings.devices.api.runningLan' : 'settings.devices.api.runningLocal', { address: apiAddress(status) })
  }

  return status.keyConfigured ? t('settings.devices.api.offKey') : t('settings.devices.api.offNoKey')
}

export function phoneSummary(status: PhoneStatus['mobile']): string {
  if (!status.running) {
    return t('settings.devices.bridge.offHint')
  }

  return t('settings.devices.bridge.listening', { port: status.port, phones: tn('settings.devices.bridge.phones', status.devices.length) })
}

export function androidSummary(status: PhoneStatus['android']): string {
  switch (status.state) {
    case 'ready':
      return t('settings.devices.adb.ready', { where: status.adb ? ` (${status.adb})` : '', devices: tn('settings.devices.adb.devices', status.devices.length) })
    case 'missing':
      return t('settings.devices.adb.missing')
    default:
      return t('settings.devices.adb.none')
  }
}

export function secondsLeft(expiresAt: number, now: number): number {
  return Math.max(0, Math.round((expiresAt - now) / 1000))
}

export function timeLeftText(seconds: number): string {
  return seconds <= 0 ? t('settings.devices.expired') : seconds >= 60 ? t('settings.devices.minSec', { min: Math.floor(seconds / 60), sec: seconds % 60 }) : t('settings.devices.onlySec', { sec: seconds })
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
    out.push(t('settings.devices.ssh.nameRequired'))
  } else if (existingNames.includes(name)) {
    out.push(t('settings.devices.ssh.nameTaken', { name }))
  }

  if (!draft.host.trim() || /\s/.test(draft.host.trim())) {
    out.push(t('settings.devices.ssh.hostRequired'))
  }

  if (!draft.username.trim() || /\s/.test(draft.username.trim())) {
    out.push(t('settings.devices.ssh.userRequired'))
  }

  const port = Number(draft.port.trim())

  if (!/^\d+$/.test(draft.port.trim()) || port < 1 || port > 65535) {
    out.push(t('settings.devices.ssh.portRange'))
  }

  if (!draft.keyPath) {
    out.push(t('settings.devices.ssh.keyRequired'))
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
