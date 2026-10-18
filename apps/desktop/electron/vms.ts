import { execFile } from 'node:child_process'
import path from 'node:path'

/*
 * Virtual machines on the Jarod disk (docs/JAROD-DISK.md): WSL distributions whose disk (ext4.vhdx) lives in
 * <root>\vms\<name>. Jarod-OS lists the machines of this Windows account, installs a new one there
 * (wsl --install <distro> --name <name> --location <folder> --no-launch), moves an existing one there
 * (wsl --manage <name> --move <folder>), stops one, and opens one in a Terminal tab. Removing one (wsl --unregister)
 * erases its disk: the person types its name to confirm. Docker Desktop's own distributions are left alone.
 */

export interface VmInfo {
  name: string
  state: 'Running' | 'Stopped' | string
  version: number
  default: boolean
  /** The folder holding its disk (from the registry), when known. */
  location: string | null
}

export interface OnlineDistro {
  id: string
  label: string
}

/** Managed by Docker Desktop: never listed. */
const HIDDEN = /^docker-desktop(-data)?$/i
export const VM_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/

/** `wsl --list --verbose` (WSL_UTF8=1): a header, then "* Ubuntu   Running   2". */
export function parseList(output: string): Omit<VmInfo, 'location'>[] {
  const lines = output
    .replaceAll('\u0000', '')
    .split(/\r?\n/)
    .map(line => line.trimEnd())
    .filter(Boolean)
  const vms: Omit<VmInfo, 'location'>[] = []

  for (const line of lines.slice(1)) {
    const match = /^(\*?)\s*(\S+)\s+(\S+)\s+(\d+)\s*$/.exec(line.trim())

    if (match && !HIDDEN.test(match[2])) {
      vms.push({ name: match[2], state: match[3], version: Number(match[4]), default: match[1] === '*' })
    }
  }

  return vms
}

/** `wsl --list --online`: some text, a "NAME  FRIENDLY NAME" header, then one distribution per line. */
export function parseOnline(output: string): OnlineDistro[] {
  const lines = output.replaceAll('\u0000', '').split(/\r?\n/)
  const header = lines.findIndex(line => /^\s*(NAME|NOM)\s+/i.test(line))

  if (header < 0) return []

  return lines
    .slice(header + 1)
    .map(line => /^\s*(\S+)\s+(.+?)\s*$/.exec(line))
    .filter((match): match is RegExpExecArray => Boolean(match))
    .map(match => ({ id: match[1], label: match[2] }))
}

/** The registry's Lxss entries (PowerShell ConvertTo-Json): name → base path. */
export function parseLocations(json: string): Map<string, string> {
  const map = new Map<string, string>()

  try {
    const rows = JSON.parse(json) as unknown
    const list = (Array.isArray(rows) ? rows : [rows]) as Array<{ DistributionName?: unknown; BasePath?: unknown }>

    for (const row of list) {
      if (typeof row?.DistributionName === 'string' && typeof row.BasePath === 'string') {
        map.set(row.DistributionName, row.BasePath.replace(/^\\\\\?\\/, ''))
      }
    }
  } catch {
    // No machine yet, or no registry: locations stay unknown.
  }

  return map
}

export function vmFolder(root: string, name: string): string {
  return path.join(root, 'vms', name)
}

export function isOnDisk(vm: Pick<VmInfo, 'location'>, root: string | null): boolean {
  if (!vm.location || !root) return false

  const folder = path.win32.normalize(path.win32.join(root, 'vms')).toLowerCase()

  return path.win32.normalize(vm.location).toLowerCase().startsWith(`${folder}\\`)
}

export type Wsl = (args: string[], timeoutMs?: number) => Promise<string>

/** wsl.exe with UTF-8 output; rejects with its message on failure. */
export const wsl: Wsl = (args, timeoutMs = 60_000) =>
  new Promise((resolve, reject) => {
    execFile('wsl.exe', args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, WSL_UTF8: '1' } }, (error, stdout, stderr) => {
      const text = `${stdout}\n${stderr}`.replaceAll('\u0000', '')

      if (error) reject(new Error(text.trim().split(/\r?\n/).filter(Boolean).slice(-2).join(' · ') || error.message))
      else resolve(text)
    })
  })

export function readLocations(): Promise<Map<string, string>> {
  const script = "Get-ChildItem 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss' -ErrorAction SilentlyContinue | ForEach-Object { Get-ItemProperty $_.PSPath } | Select-Object DistributionName, BasePath | ConvertTo-Json -Compress"

  return new Promise(resolve => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 20_000 }, (error, stdout) => resolve(parseLocations(error ? '' : stdout)))
  })
}

export async function listVms(run: Wsl = wsl, locations: () => Promise<Map<string, string>> = readLocations): Promise<VmInfo[]> {
  const [list, where] = await Promise.all([run(['--list', '--verbose']).catch(() => ''), locations()])

  return parseList(list).map(vm => ({ ...vm, location: where.get(vm.name) ?? null }))
}

/** The commands for each action, kept here so they are tested as written. */
export const commands = {
  install: (distro: string, name: string, folder: string) => ['--install', distro, '--name', name, '--location', folder, '--no-launch'],
  move: (name: string, folder: string) => ['--manage', name, '--move', folder],
  stop: (name: string) => ['--terminate', name],
  remove: (name: string) => ['--unregister', name]
}
