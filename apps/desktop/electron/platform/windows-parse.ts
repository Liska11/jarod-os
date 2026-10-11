import path from 'node:path'
import type { AudioDevice, InstalledApp, ProcessInfo } from '../../shared/ipc.ts'

/** Pure helpers of the Windows platform: no Electron, no processes. */

/** PowerShell's `-EncodedCommand` takes the script as base64 of UTF-16LE: no quoting to get wrong. */
export function encodePowerShell(script: string): string {
  return Buffer.from(`$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);\n${script}`, 'utf16le').toString('base64')
}

/** `ConvertTo-Json` writes one object where there is one element. */
export function asArray<T>(value: T | T[] | null | undefined): T[] {
  return value === null || value === undefined ? [] : Array.isArray(value) ? value : [value]
}

/** The AppIDs Windows writes for programs in a known folder, by folder GUID. */
const KNOWN_FOLDERS: Record<string, (env: NodeJS.ProcessEnv) => string | undefined> = {
  '6D809377-6AF0-444B-8957-A3773F02200E': env => env.ProgramW6432 ?? env.ProgramFiles,
  '7C5A40EF-A0FB-4BFC-874A-C0F2E0B9FA8E': env => env['ProgramFiles(x86)'],
  '1AC14E77-02E7-4E5D-B744-2EB1AE5198B7': env => (env.SystemRoot ? path.win32.join(env.SystemRoot, 'System32') : undefined),
  'D65231B0-B2F1-4857-A4CE-A8E7C6EA7D27': env => (env.SystemRoot ? path.win32.join(env.SystemRoot, 'SysWOW64') : undefined),
  'F38BF404-1D43-42F2-9305-67DE0B28FC23': env => env.SystemRoot,
  '3EB685DB-65F9-4CF6-A03A-E3EF65729F3D': env => env.APPDATA,
  'F1B32785-6FBA-4FCF-9D55-7B8E7F157091': env => env.LOCALAPPDATA,
  '62AB5D82-FDC1-4DC3-A9DD-070D1D495D97': env => env.ProgramData
}

/** `{GUID}\Sub\app.exe` -> its real path; a plain path stays; UWP ids (`Pkg!App`) have none. */
export function appIdToFile(appId: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (/^[A-Za-z]:\\/.test(appId)) {
    return appId
  }

  const match = /^\{([0-9A-Fa-f-]{36})\}\\(.+)$/.exec(appId)
  const base = match ? KNOWN_FOLDERS[match[1].toUpperCase()]?.(env) : undefined

  return match && base ? path.win32.join(base, match[2]) : null
}

const APPS_PREFIX = /^shell:AppsFolder\\/i

/** The AppID in an `InstalledApp.path` of the form `shell:AppsFolder\<AppID>`, or null for any other path. */
export function appsFolderId(appPath: string): string | null {
  return APPS_PREFIX.test(appPath) ? appPath.replace(APPS_PREFIX, '') : null
}

/** What the apps IPC accepts as an application: an absolute path or a `shell:AppsFolder\` entry (no quotes or wildcards). */
export function isAppsFolderPath(value: string): boolean {
  return APPS_PREFIX.test(value) && !/["<>|*?\r\n]/.test(value) && value.length < 1024
}

/** `Get-StartApps` rows -> apps; the first entry of a name wins (installers add several). */
export function startAppsToInstalled(rows: { name?: string; id?: string }[]): InstalledApp[] {
  const found = new Map<string, InstalledApp>()

  for (const row of rows) {
    const name = row.name?.trim()
    const id = row.id?.trim()

    if (name && id && !found.has(name.toLowerCase())) {
      found.set(name.toLowerCase(), { name, path: `shell:AppsFolder\\${id}`, bundleId: id })
    }
  }

  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** `netsh wlan show interfaces` -> the connection, whatever the language. Null without a radio or a link. */
export function parseNetshWlan(text: string): { connected: boolean; ssid?: string; interface?: string } | null {
  const ssid = /^\s*SSID\s*:\s*(.+?)\s*$/m.exec(text)?.[1]

  if (!ssid) {
    return null
  }

  return { connected: true, ssid, interface: /^\s*(?:Name|Nom)\s*:\s*(.+?)\s*$/m.exec(text)?.[1] }
}

const VIRTUAL_ADAPTER = /vethernet|virtualbox|vmware|hyper-v|tailscale|zerotier|wsl|loopback|bluetooth|docker|vpn|tap-|tunnel/i

/** The interface a person is online through: the first up, non-virtual one with an IPv4 address. */
export function pickInterface(interfaces: Record<string, { address: string; family: string | number; internal: boolean }[] | undefined>): { name: string; ipv4: string } | null {
  const candidates: { name: string; ipv4: string }[] = []

  for (const [name, addresses] of Object.entries(interfaces)) {
    const ipv4 = (addresses ?? []).find(a => (a.family === 'IPv4' || a.family === 4) && !a.internal && !a.address.startsWith('169.254.'))

    if (ipv4) {
      candidates.push({ name, ipv4: ipv4.address })
    }
  }

  return candidates.find(c => !VIRTUAL_ADAPTER.test(c.name)) ?? candidates[0] ?? null
}

export interface ProcessRowJson {
  pid: number
  ppid: number
  name: string
  path?: string
  rss: number
  cpu: number
  user?: string
}

/** The PROCESSES script's rows -> `ProcessInfo`; CPU arrives summed over cores and is scaled to the machine. */
export function toProcessInfo(rows: ProcessRowJson[], logicalCpus: number, totalMemory: number): ProcessInfo[] {
  const cores = Math.max(1, logicalCpus)

  return rows.map(row => ({
    pid: row.pid,
    ppid: row.ppid,
    user: row.user ?? '',
    cpuPercent: Math.round(Math.min(100, row.cpu / cores) * 10) / 10,
    memPercent: totalMemory > 0 ? Math.round((row.rss / totalMemory) * 1000) / 10 : 0,
    rssBytes: row.rss,
    command: row.path || row.name,
    name: row.name
  }))
}

/** Paths of the Recent-folder shortcuts' targets that are real files or folders under `home`, newest first, deduplicated. */
export function recentTargets(rows: { target?: string; used?: number }[], home: string): { target: string; used: number }[] {
  const seen = new Set<string>()
  const out: { target: string; used: number }[] = []
  const root = home.toLowerCase().replace(/[\\/]+$/, '') + '\\'

  for (const row of [...rows].sort((a, b) => (b.used ?? 0) - (a.used ?? 0))) {
    const target = row.target?.trim()

    if (!target || !target.toLowerCase().startsWith(root) || /\\(AppData|node_modules|\.git)\\/i.test(target) || seen.has(target.toLowerCase())) {
      continue
    }

    seen.add(target.toLowerCase())
    out.push({ target, used: row.used ?? 0 })
  }

  return out
}

export interface AudioRowJson {
  id?: string
  name?: string
  level?: number
  muted?: boolean
  isDefault?: boolean
}

/** The GUID at the end of an endpoint id (`{0.0.0.00000000}.{guid}`), lowercase and braced, or null. */
export function endpointGuid(id: string): string | null {
  const match = /\.(\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\})$/i.exec(id.trim())

  return match ? match[1].toLowerCase() : null
}

/** Quick-panel audio devices from the COM script's rows: default first, then by name; rows without an id are dropped. */
export function audioDevices(rows: AudioRowJson[]): AudioDevice[] {
  return rows
    .filter(row => typeof row.id === 'string' && row.id.length > 0)
    .map(row => ({
      id: row.id as string,
      name: (row.name ?? '').trim() || 'Audio device',
      isDefault: Boolean(row.isDefault),
      volume: Math.max(0, Math.min(100, Math.round(Number(row.level) || 0))),
      muted: Boolean(row.muted)
    }))
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name))
}
