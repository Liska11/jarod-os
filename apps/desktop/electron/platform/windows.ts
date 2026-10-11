import { app, nativeImage, shell } from 'electron'
import { spawn } from 'node:child_process'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { BatteryStatus, CalendarResult, ControlAction, DiskUsage, InstalledApp, NetworkStatus, ProcessInfo, RecentFile, StatusPanelId, StatusPanelState, SystemInfo, SystemStats } from '../../shared/ipc.ts'
import { hermesHome } from '../paths.ts'
import { run } from './exec.ts'
import { findCodeEditor } from './editors.ts'
import { normaliseFileQuery, rankFiles } from './find.ts'
import { type EditorTarget, HostNotSupported, type HostPlatform } from './types.ts'
import { appIdToFile, appsFolderId, asArray, encodePowerShell, parseNetshWlan, pickInterface, type ProcessRowJson, recentTargets, startAppsToInstalled, toProcessInfo } from './windows-parse.ts'

/*
 * The shell's view of a Windows machine: what the System page, the Applications grid, the file
 * pickers and the menu bar need. Built on Windows PowerShell 5.1 (every supported Windows has it) and
 * Electron's own shell APIs. Scripts are fixed text; the only values spliced in are integers.
 */

const DISKS_AND_BATTERY = String.raw`
$disks = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object { [pscustomobject]@{ mount = ($_.DeviceID + '\'); total = [int64]$_.Size; free = [int64]$_.FreeSpace } })
$b = Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue | Select-Object -First 1
$battery = $null
if ($b) { $battery = [pscustomobject]@{ percent = [int]$b.EstimatedChargeRemaining; charging = (@(2, 6, 7, 8, 9) -contains [int]$b.BatteryStatus) } }
[pscustomobject]@{ disks = $disks; battery = $battery } | ConvertTo-Json -Compress -Depth 4
`

// Two samples of each process's cumulative CPU time 400 ms apart; the top rows get their owner.
const PROCESSES = (sortBy: 'cpu' | 'rss', limit: number) => String.raw`
$before = @{}
Get-CimInstance Win32_Process | ForEach-Object { $before[[int]$_.ProcessId] = [int64]$_.KernelModeTime + [int64]$_.UserModeTime }
$t0 = [DateTime]::UtcNow
Start-Sleep -Milliseconds 400
$procs = @(Get-CimInstance Win32_Process)
$seconds = ([DateTime]::UtcNow - $t0).TotalSeconds
$rows = @($procs | Where-Object { $_.ProcessId -ne 0 } | ForEach-Object {
  $id = [int]$_.ProcessId
  $cpu = 0.0
  if ($before.ContainsKey($id)) { $cpu = ((([int64]$_.KernelModeTime + [int64]$_.UserModeTime) - $before[$id]) / 1e7) / $seconds * 100 }
  [pscustomobject]@{ pid = $id; ppid = [int]$_.ParentProcessId; name = [string]$_.Name; path = [string]$_.ExecutablePath; rss = [int64]$_.WorkingSetSize; cpu = [math]::Round($cpu, 1); user = '' }
} | Sort-Object ${sortBy} -Descending | Select-Object -First ${limit})
foreach ($r in $rows) {
  try { $o = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $r.pid) | Invoke-CimMethod -MethodName GetOwner; if ($o -and $o.User) { $r.user = [string]$o.User } } catch { }
}
ConvertTo-Json -InputObject $rows -Compress
`

const START_APPS = String.raw`
ConvertTo-Json -InputObject @(Get-StartApps | ForEach-Object { [pscustomobject]@{ name = [string]$_.Name; id = [string]$_.AppID } }) -Compress
`

// The Recent folder keeps one shortcut per file the person opened; its write time is when.
const RECENT = String.raw`
$sh = New-Object -ComObject WScript.Shell
$dir = Join-Path $env:APPDATA 'Microsoft\Windows\Recent'
$rows = @(Get-ChildItem -LiteralPath $dir -Filter *.lnk -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 500 | ForEach-Object {
  $target = ''
  try { $target = [string]$sh.CreateShortcut($_.FullName).TargetPath } catch { }
  [pscustomobject]@{ target = $target; used = [int64]([DateTimeOffset]$_.LastWriteTime).ToUnixTimeMilliseconds() }
})
ConvertTo-Json -InputObject $rows -Compress
`

interface CpuSample {
  idle: number
  total: number
}

function cpuSample(): CpuSample {
  let idle = 0
  let total = 0

  for (const cpu of os.cpus()) {
    idle += cpu.times.idle
    total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq
  }

  return { idle, total }
}

const SKIPPED_DIRS = new Set(['appdata', 'node_modules', '.git', '$recycle.bin', 'system volume information', '__pycache__', '.venv', 'venv', '.cache'])

function ripgrep(): string | null {
  const dirs = (process.env.PATH ?? process.env.Path ?? '').split(path.delimiter)
  // Hermes's installer ships ripgrep in the tools folder of its home: tools/ripgrep-<version>-<platform>.
  let shipped: string[] = []

  try {
    shipped = fsSync
      .readdirSync(path.join(hermesHome(), 'tools'))
      .filter(name => name.startsWith('ripgrep-'))
      .sort()
      .reverse()
      .map(name => path.join(hermesHome(), 'tools', name, 'rg.exe'))
  } catch {
    // No Hermes tools folder.
  }

  const candidates = [...dirs.map(dir => path.join(dir, 'rg.exe')), ...shipped, path.join(hermesHome(), 'bin', 'rg.exe')]

  return candidates.find(candidate => fsSync.existsSync(candidate)) ?? null
}

const escapeGlob = (text: string): string => text.replace(/([\\*?[\]{}!])/g, '[$1]')

/** Without ripgrep: a bounded walk of the home folder for names containing `needle`. */
async function walkForName(root: string, needle: string, budgetMs: number, max: number): Promise<string[]> {
  const deadline = Date.now() + budgetMs
  const found: string[] = []
  const stack = [root]
  let visited = 0

  while (stack.length > 0 && Date.now() < deadline && found.length < max && visited < 200_000) {
    const dir = stack.pop() as string
    let entries: fsSync.Dirent[]

    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      visited++

      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name.toLowerCase()) && !entry.isSymbolicLink()) {
          stack.push(path.join(dir, entry.name))
        }
      } else if (entry.name.toLowerCase().includes(needle)) {
        found.push(path.join(dir, entry.name))
      }
    }
  }

  return found
}

export class WindowsPlatform implements HostPlatform {
  private previousCpu = cpuSample()
  private appsCache: { at: number; apps: InstalledApp[] } | null = null
  private storageCache: { at: number; disks: DiskUsage[]; battery: BatteryStatus } | null = null

  private async powershell<T>(script: string, timeoutMs = 20_000): Promise<T | null> {
    const result = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodePowerShell(script)], timeoutMs)

    if (result.code !== 0 || !result.stdout.trim()) {
      return null
    }

    try {
      return JSON.parse(result.stdout.trim().replace(/^﻿/, '')) as T
    } catch {
      return null
    }
  }

  async systemInfo(): Promise<SystemInfo> {
    const cpus = os.cpus()

    return {
      hostname: os.hostname(),
      platform: process.platform,
      arch: process.arch,
      osName: typeof os.version === 'function' ? os.version() : 'Windows',
      osVersion: os.release(),
      cpuModel: cpus[0]?.model.replace(/\s+/g, ' ').trim() ?? 'unknown',
      cpuCount: cpus.length,
      totalMemory: os.totalmem(),
      userName: os.userInfo().username,
      homeDir: os.homedir()
    }
  }

  /** Disks and battery change slowly and cost a PowerShell start: refreshed at most every 20 seconds. */
  private async storage(): Promise<{ disks: DiskUsage[]; battery: BatteryStatus }> {
    if (this.storageCache && Date.now() - this.storageCache.at < 20_000) {
      return this.storageCache
    }

    const data = await this.powershell<{ disks?: { mount: string; total: number; free: number }[] | { mount: string; total: number; free: number }; battery?: { percent: number; charging: boolean } | null }>(DISKS_AND_BATTERY)
    const disks = asArray(data?.disks)
      .filter(disk => disk.total > 0)
      .map(disk => ({ mount: disk.mount, total: disk.total, free: disk.free, used: Math.max(0, disk.total - disk.free) }))
    const battery: BatteryStatus = data?.battery ? { present: true, percent: data.battery.percent, charging: data.battery.charging } : { present: false }
    this.storageCache = { at: Date.now(), disks, battery }

    return this.storageCache
  }

  async sampleStats(): Promise<SystemStats> {
    const current = cpuSample()
    const idleDelta = current.idle - this.previousCpu.idle
    const totalDelta = current.total - this.previousCpu.total
    this.previousCpu = current
    const cpuPercent = totalDelta > 0 ? Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100)) : 0
    const total = os.totalmem()
    const free = os.freemem()
    const { disks, battery } = await this.storage()

    return {
      sampledAt: Date.now(),
      cpuPercent,
      loadAverage: [0, 0, 0],
      memoryTotal: total,
      memoryUsed: total - free,
      memoryFree: free,
      uptimeSeconds: os.uptime(),
      disks,
      battery
    }
  }

  async listProcesses(sort: 'cpu' | 'memory', limit: number): Promise<ProcessInfo[]> {
    const count = Math.max(1, Math.min(200, Math.floor(limit)))
    const rows = await this.powershell<ProcessRowJson[] | ProcessRowJson>(PROCESSES(sort === 'cpu' ? 'cpu' : 'rss', count), 40_000)

    return toProcessInfo(asArray(rows), os.cpus().length, os.totalmem())
  }

  async listInstalledApps(): Promise<InstalledApp[]> {
    if (this.appsCache && Date.now() - this.appsCache.at < 60_000) {
      return this.appsCache.apps
    }

    const rows = await this.powershell<{ name: string; id: string }[] | { name: string; id: string }>(START_APPS, 30_000)
    const apps = startAppsToInstalled(asArray(rows))
    this.appsCache = { at: Date.now(), apps }

    return apps
  }

  /** The program's own icon when the entry points at a file; packaged (Store) apps keep theirs inside the package, so they get none. */
  async appIcon(appPath: string): Promise<Buffer | null> {
    const id = appsFolderId(appPath)
    const file = id ? appIdToFile(id) : appPath

    if (!file || !fsSync.existsSync(file)) {
      return null
    }

    try {
      const icon = await app.getFileIcon(file, { size: 'large' })

      return icon.isEmpty() ? null : icon.toPNG()
    } catch {
      return null
    }
  }

  async launchApp(appPath: string): Promise<void> {
    if (appsFolderId(appPath)) {
      // explorer.exe shell:AppsFolder\<AppID> starts classic and packaged apps alike; it exits 1 even on success.
      spawn('explorer.exe', [appPath], { detached: true, stdio: 'ignore' }).unref()

      return
    }

    const error = await shell.openPath(appPath)

    if (error) {
      throw new Error(error)
    }
  }

  async revealPath(targetPath: string): Promise<void> {
    shell.showItemInFolder(targetPath)
  }

  async openIn(target: EditorTarget, targetPath: string): Promise<void> {
    if (target === 'finder') {
      shell.showItemInFolder(targetPath)

      return
    }

    if (target === 'terminal') {
      const dir = fsSync.existsSync(targetPath) && fsSync.statSync(targetPath).isDirectory() ? targetPath : path.dirname(targetPath)
      // Windows Terminal when it is installed (it is an execution alias), else a PowerShell window.
      const child = spawn('wt.exe', ['-d', dir], { detached: true, stdio: 'ignore' })
      child.on('error', () => spawn('powershell.exe', ['-NoExit'], { cwd: dir, detached: true, stdio: 'ignore' }).unref())
      child.unref()

      return
    }

    const editor = findCodeEditor(await this.listInstalledApps())
    const exe = editor.bundleId ? appIdToFile(editor.bundleId) : null

    if (!exe || !fsSync.existsSync(exe)) {
      throw new HostNotSupported(`openIn(editor) with ${editor.name}`)
    }

    spawn(exe, [targetPath], { detached: true, stdio: 'ignore' }).unref()
  }

  async networkStatus(): Promise<NetworkStatus> {
    const picked = pickInterface(os.networkInterfaces())

    if (!picked) {
      return { online: false }
    }

    const wifi = /wi-?fi|wlan|wireless|sans fil/i.test(picked.name) ? parseNetshWlan((await run('netsh.exe', ['wlan', 'show', 'interfaces'], 4000)).stdout) : null

    return { online: true, defaultInterface: picked.name, ipv4: picked.ipv4, wifi: wifi ?? undefined }
  }

  async calendarToday(): Promise<CalendarResult> {
    return { status: 'unavailable', events: [] }
  }

  private async toRecent(file: string, usedAt: number): Promise<RecentFile | null> {
    try {
      const stat = await fs.stat(file)

      return { path: file, name: path.basename(file), extension: path.extname(file).toLowerCase(), size: stat.size, modifiedAt: stat.mtimeMs, lastUsedAt: usedAt || stat.atimeMs, kind: stat.isDirectory() ? 'directory' : 'file' }
    } catch {
      return null
    }
  }

  async recentFiles(limit: number): Promise<RecentFile[]> {
    const rows = await this.powershell<{ target: string; used: number }[] | { target: string; used: number }>(RECENT, 30_000)
    const targets = recentTargets(asArray(rows), os.homedir()).slice(0, 400)
    const files = (await Promise.all(targets.map(entry => this.toRecent(entry.target, entry.used)))).filter((file): file is RecentFile => file !== null && file.kind === 'file')

    return files.sort((a, b) => b.lastUsedAt - a.lastUsedAt).slice(0, limit)
  }

  async findFiles(query: string, limit: number): Promise<RecentFile[]> {
    const name = normaliseFileQuery(query)

    if (!name) {
      return []
    }

    const home = os.homedir()
    const rg = ripgrep()
    let paths: string[]

    if (rg) {
      const result = await run(rg, ['--files', '--no-messages', '--no-ignore', '--no-config', '--iglob', `*${escapeGlob(name)}*`, '--glob', '!**/AppData/**', '--glob', '!**/node_modules/**', '--glob', '!**/.git/**', '--', home], 12_000)
      paths = result.stdout.split(/\r?\n/).filter(Boolean).slice(0, 300)
    } else {
      paths = await walkForName(home, name, 8000, 300)
    }

    const rows = (await Promise.all(paths.map(file => this.toRecent(file, 0)))).filter((file): file is RecentFile => file !== null)

    return rankFiles(name, rows, limit)
  }

  /** The shell's own thumbnail provider (the one Explorer uses). */
  async thumbnail(filePath: string, size: number): Promise<Buffer | null> {
    try {
      const image = await nativeImage.createThumbnailFromPath(filePath, { width: size, height: size })

      return image.isEmpty() ? null : image.toPNG()
    } catch {
      return null
    }
  }

  /** Quick panels are for looking on Windows: Settings and the taskbar flyouts do the changing. */
  async controlStatus(panel: StatusPanelId): Promise<StatusPanelState> {
    switch (panel) {
      case 'wifi': {
        const status = await this.networkStatus()

        return { panel, wifi: { available: Boolean(status.wifi), enabled: Boolean(status.wifi), connected: status.wifi?.ssid, networks: [] } }
      }
      case 'bluetooth':
        return { panel, bluetooth: { available: false, powered: false, devices: [] } }
      case 'audio':
        return { panel, audio: { available: false, outputs: [], inputs: [] } }
      case 'display':
        return { panel, display: { available: false, displays: [] } }
      case 'power': {
        const { battery } = await this.storage()

        return { panel, power: { available: battery.present, battery, profiles: [] } }
      }
      default:
        throw new Error(`no status for the ${panel} panel`)
    }
  }

  async controlAction(action: ControlAction): Promise<void> {
    throw new HostNotSupported(`changing ${action.panel} from Herald OS on Windows (use Windows Settings)`)
  }
}
