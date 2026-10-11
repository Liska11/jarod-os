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
import { appIdToFile, appsFolderId, asArray, type AudioRowJson, audioDevices, encodePowerShell, endpointGuid, parseNetshWlan, pickInterface, type ProcessRowJson, recentTargets, startAppsToInstalled, toProcessInfo } from './windows-parse.ts'

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

// The audio endpoints through Core Audio COM (Windows has no volume cmdlet). `Set` takes the endpoint
// GUID (validated before it is spliced in), a percent and a mute flag; -1 leaves a value alone.
const AUDIO_TYPES = String.raw`
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
namespace HeraldPanel {
  [Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioEndpointVolume {
    [PreserveSig] int _0(); [PreserveSig] int _1(); [PreserveSig] int _2(); [PreserveSig] int _3();
    [PreserveSig] int SetMasterVolumeLevelScalar(float level, ref Guid ctx);
    [PreserveSig] int _5();
    [PreserveSig] int GetMasterVolumeLevelScalar(out float level);
    [PreserveSig] int _7(); [PreserveSig] int _8(); [PreserveSig] int _9(); [PreserveSig] int _10();
    [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid ctx);
    [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
  }
  [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice {
    [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object endpoint);
    [PreserveSig] int OpenPropertyStore(int access, out IntPtr store);
    [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
  }
  [Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceCollection {
    [PreserveSig] int GetCount(out int count);
    [PreserveSig] int Item(int index, out IMMDevice device);
  }
  [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator {
    [PreserveSig] int EnumAudioEndpoints(int flow, int stateMask, out IMMDeviceCollection devices);
    [PreserveSig] int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice device);
  }
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumerator { }
  public static class Panel {
    static IAudioEndpointVolume Volume(IMMDevice device) {
      Guid iid = typeof(IAudioEndpointVolume).GUID;
      object endpoint;
      if (device.Activate(ref iid, 23, IntPtr.Zero, out endpoint) != 0) return null;
      return (IAudioEndpointVolume)endpoint;
    }
    static string IdOf(IMMDevice device) { string id; device.GetId(out id); return id; }
    // One "id|level|muted|default" line per active endpoint of the flow (0 playback, 1 capture).
    public static string[] List(int flow) {
      var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumerator();
      string defaultId = "";
      IMMDevice def;
      if (enumerator.GetDefaultAudioEndpoint(flow, 1, out def) == 0) defaultId = IdOf(def);
      IMMDeviceCollection devices;
      var lines = new List<string>();
      if (enumerator.EnumAudioEndpoints(flow, 1, out devices) != 0) return lines.ToArray();
      int count; devices.GetCount(out count);
      for (int i = 0; i < count; i++) {
        IMMDevice device;
        if (devices.Item(i, out device) != 0) continue;
        var volume = Volume(device);
        if (volume == null) continue;
        float level; bool muted;
        volume.GetMasterVolumeLevelScalar(out level); volume.GetMute(out muted);
        string id = IdOf(device);
        lines.Add(id + "|" + ((int)Math.Round(level * 100)).ToString() + "|" + (muted ? "1" : "0") + "|" + (id == defaultId ? "1" : "0"));
      }
      return lines.ToArray();
    }
    public static bool Set(int flow, string guid, int percent, int mute) {
      var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumerator();
      IMMDeviceCollection devices;
      if (enumerator.EnumAudioEndpoints(flow, 1, out devices) != 0) return false;
      int count; devices.GetCount(out count);
      for (int i = 0; i < count; i++) {
        IMMDevice device;
        if (devices.Item(i, out device) != 0) continue;
        if (!IdOf(device).ToLowerInvariant().EndsWith("." + guid)) continue;
        var volume = Volume(device);
        if (volume == null) return false;
        Guid ctx = Guid.Empty;
        if (percent >= 0) volume.SetMasterVolumeLevelScalar(percent / 100f, ref ctx);
        if (mute >= 0) volume.SetMute(mute == 1, ref ctx);
        return true;
      }
      return false;
    }
  }
}
'@
function DeviceName([string]$flow, [string]$id) {
  $guid = ($id -split '\.')[-1]
  $key = "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio\$flow\$guid\Properties"
  try {
    $p = Get-ItemProperty -LiteralPath $key -ErrorAction Stop
    $what = [string]$p.'{a45c254e-df1c-4efd-8020-67d146a850e0},2'
    $adapter = [string]$p.'{b3f8fa53-0004-438e-9003-51a46e139bfc},6'
    if ($what -and $adapter) { return "$what ($adapter)" }
    if ($what) { return $what }
  } catch { }
  return $guid
}
function Rows([int]$flow, [string]$name) {
  return @([HeraldPanel.Panel]::List($flow) | ForEach-Object {
    $f = $_ -split '\|'
    [pscustomobject]@{ id = $f[0]; name = (DeviceName $name $f[0]); level = [int]$f[1]; muted = ($f[2] -eq '1'); isDefault = ($f[3] -eq '1') }
  })
}
`

const AUDIO_STATE = AUDIO_TYPES + String.raw`
[pscustomobject]@{ outputs = (Rows 0 'Render'); inputs = (Rows 1 'Capture') } | ConvertTo-Json -Compress -Depth 4
`

/** `guid` is validated by `endpointGuid`; the numbers are integers. */
const AUDIO_SET = (flow: 0 | 1, guid: string, percent: number, mute: number) =>
  AUDIO_TYPES +
  String.raw`
if (-not [HeraldPanel.Panel]::Set(${flow}, '${guid}', ${percent}, ${mute})) { throw 'That audio device is not available.' }
'{}'
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
      case 'audio': {
        const data = await this.powershell<{ outputs?: AudioRowJson[] | AudioRowJson; inputs?: AudioRowJson[] | AudioRowJson }>(AUDIO_STATE, 30_000)
        const outputs = audioDevices(asArray(data?.outputs))
        const inputs = audioDevices(asArray(data?.inputs))

        return { panel, audio: { available: outputs.length + inputs.length > 0, outputs, inputs } }
      }
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
    if (action.panel === 'audio' && action.action === 'volume') {
      return this.setVolume(action)
    }

    const what = action.panel === 'audio' && action.action === 'default' ? 'the default audio device' : action.panel
    throw new HostNotSupported(`changing ${what} from Jarod-OS on Windows (use Windows Settings)`)
  }

  /** Volume and mute of one endpoint; without an id, the default device of that kind. */
  private async setVolume(action: Extract<ControlAction, { panel: 'audio'; action: 'volume' }>): Promise<void> {
    const flow = action.kind === 'input' ? 1 : 0
    let id = action.id

    if (!id) {
      const state = await this.controlStatus('audio')
      const devices = state.panel === 'audio' ? (flow === 1 ? state.audio.inputs : state.audio.outputs) : []
      id = devices.find(device => device.isDefault)?.id ?? devices[0]?.id
    }

    const guid = id ? endpointGuid(id) : null

    if (!guid) {
      throw new Error('No audio device to change.')
    }

    const percent = typeof action.percent === 'number' && Number.isFinite(action.percent) ? Math.max(0, Math.min(100, Math.round(action.percent))) : -1
    const mute = typeof action.muted === 'boolean' ? (action.muted ? 1 : 0) : -1

    if (percent < 0 && mute < 0) {
      return
    }

    const done = await this.powershell<Record<string, never>>(AUDIO_SET(flow, guid, percent, mute), 30_000)

    if (done === null) {
      throw new Error('Windows did not accept the audio change.')
    }
  }
}
