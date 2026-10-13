import { exec as execShell, execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AuditReport, Check, CheckStatus, Environment, Gpu, SystemFacts } from '../../shared/system-audit.ts'
import { writeFileAtomic } from '../atomic-write.ts'

/*
 * First-run system audit (HANDOFF.md, section 7, step 1): inventory the hardware and the prerequisites, judge each one
 * (ok / missing / outdated / info), give the exact command that fixes it, and block only on what Jarod-OS cannot run
 * without. The result is kept as JSON so later launches reuse it; `force` audits again.
 *
 * Collection is one PowerShell call on Windows (CIM, PnP, the display-class registry for the real VRAM, and
 * kernel32's IsProcessorFeaturePresent for AVX2/AVX-512) plus `--version` probes run in parallel. Everything that
 * touches the machine goes through `Exec`, so the judgement is tested with canned facts.
 */

export const AUDIT_VERSION = 1
export const MIN_NODE = [22, 12, 0] as const
export const MIN_PYTHON = [3, 10, 0] as const
export const MIN_RAM_MB = 4096
export const MIN_FREE_DISK_MB = 2048

export type { AuditReport, Check, CheckStatus, Environment, Gpu, SystemFacts } from '../../shared/system-audit.ts'

export type Exec = (command: string, args: string[], timeoutMs?: number) => Promise<{ ok: boolean; stdout: string }>

/** Runs a probe. On Windows, npm/pnpm are `.cmd` shims that only start through the shell; the probes' arguments are constants. */
export const realExec: Exec = (command, args, timeoutMs = 8_000) =>
  new Promise(resolve => {
    const done = (error: Error | null, stdout: string) => resolve({ ok: !error, stdout: String(stdout ?? '') })
    if (process.platform === 'win32' && !command.endsWith('.exe')) {
      execShell([command, ...args].join(' '), { timeout: timeoutMs, windowsHide: true, encoding: 'utf8' }, done)
    } else {
      execFile(command, args, { timeout: timeoutMs, windowsHide: true, encoding: 'utf8' }, done)
    }
  })

const WINDOWS_PROBE = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$os = Get-CimInstance Win32_OperatingSystem
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
Add-Type -Namespace JarodAudit -Name Cpu -MemberDefinition '[DllImport("kernel32.dll")] public static extern bool IsProcessorFeaturePresent(uint f);'
$gpus = @(Get-CimInstance Win32_VideoController | ForEach-Object { @{ name = $_.Name; driver = $_.DriverVersion; adapterRam = $_.AdapterRAM } })
$vram = @(Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}\0*' | Where-Object { $_.DriverDesc } | ForEach-Object { @{ name = $_.DriverDesc; bytes = [int64]$_.'HardwareInformation.qwMemorySize' } })
$npus = @(Get-PnpDevice -Class ComputeAccelerator -PresentOnly | ForEach-Object { @{ name = $_.FriendlyName; status = [string]$_.Status } })
@{
  os = @{ name = $os.Caption; version = $os.Version; build = $os.BuildNumber }
  cpu = @{ name = $cpu.Name; cores = $cpu.NumberOfCores; threads = $cpu.NumberOfLogicalProcessors; avx2 = [JarodAudit.Cpu]::IsProcessorFeaturePresent(40); avx512 = [JarodAudit.Cpu]::IsProcessorFeaturePresent(41) }
  gpus = $gpus; vram = $vram; npus = $npus
  vulkan = Test-Path "$env:WINDIR\System32\vulkan-1.dll"
} | ConvertTo-Json -Depth 4 -Compress
`

interface WindowsProbe {
  os?: { name?: string; version?: string; build?: string }
  cpu?: { name?: string; cores?: number; threads?: number; avx2?: boolean; avx512?: boolean }
  gpus?: { name?: string; driver?: string; adapterRam?: number }[]
  vram?: { name?: string; bytes?: number }[]
  npus?: { name?: string; status?: string }[]
  vulkan?: boolean
}

export function vendorOf(name: string): Gpu['vendor'] {
  const n = name.toLowerCase()
  if (/nvidia|geforce|quadro|rtx|tesla/.test(n)) return 'nvidia'
  if (/amd|radeon|ati /.test(n)) return 'amd'
  if (/intel|iris|uhd|arc/.test(n)) return 'intel'
  return 'other'
}

/** Integrated: an Intel GPU other than Arc discrete cards, an AMD "Radeon Graphics"/Vega APU, or under 1 GiB dedicated. */
export function isIntegrated(name: string, vramMB: number | null): boolean {
  const n = name.toLowerCase()
  if (/intel/.test(n) && !/arc\s+a\d/.test(n)) return true
  if (/amd radeon\(tm\) graphics|radeon graphics$|vega \d+ graphics|radeon \d+m/.test(n)) return true
  return vramMB !== null && vramMB < 1024
}

export function parseWindowsProbe(json: string): Pick<SystemFacts, 'os' | 'cpu' | 'gpus' | 'npus' | 'vulkan'> {
  const probe = JSON.parse(json) as WindowsProbe
  const wrap = <T>(value: T | T[] | undefined): T[] => (value === undefined || value === null ? [] : Array.isArray(value) ? value : [value])
  const vram = wrap(probe.vram)
  const gpus = wrap(probe.gpus)
    .filter(g => g.name && !/basic display|remote display|virtual/i.test(g.name))
    .map(g => {
      const name = g.name ?? ''
      // AdapterRAM is a uint32 (caps at 4 GiB); the display-class registry holds the real 64-bit size.
      const bytes = vram.find(v => v.name === name)?.bytes || g.adapterRam || 0
      const vramMB = bytes > 0 ? Math.round(bytes / 1048576) : null
      return { name, vendor: vendorOf(name), vramMB, integrated: isIntegrated(name, vramMB), driver: g.driver ?? null }
    })

  return {
    os: { name: probe.os?.name ?? 'Windows', version: probe.os?.version ?? os.release(), kernel: os.release() },
    cpu: { model: probe.cpu?.name?.trim() ?? os.cpus()[0]?.model ?? 'unknown', cores: probe.cpu?.cores ?? 0, threads: probe.cpu?.threads ?? os.cpus().length, avx2: probe.cpu?.avx2 ?? null, avx512: probe.cpu?.avx512 ?? null },
    gpus,
    npus: wrap(probe.npus)
      .filter(n => n.name)
      .map(n => ({ name: n.name ?? '', ok: n.status === 'OK' })),
    vulkan: Boolean(probe.vulkan)
  }
}

export function detectEnvironment(platform: NodeJS.Platform, read: (file: string) => string | null): Environment {
  if (platform === 'win32') return 'windows'
  if (platform === 'darwin') return 'macos'
  if (read('/.dockerenv') !== null || /docker|containerd/.test(read('/proc/1/cgroup') ?? '')) return 'docker'
  if (/microsoft/i.test(read('/proc/version') ?? '')) return 'wsl2'
  return 'linux'
}

/** First dotted version in a tool's output ("v22.12.0", "Python 3.12.4", "Docker version 27.1.1, build …"). */
export function versionOf(output: string): string | null {
  return /(\d+)\.(\d+)(?:\.(\d+))?/.exec(output)?.[0] ?? null
}

export function atLeast(version: string, min: readonly number[]): boolean {
  const parts = version.split('.').map(Number)
  for (let i = 0; i < min.length; i++) {
    const have = parts[i] ?? 0
    if (have !== min[i]) return have > min[i]
  }
  return true
}

const PROBES: Record<string, [string, string[]]> = {
  node: ['node', ['--version']],
  npm: ['npm', ['--version']],
  pnpm: ['pnpm', ['--version']],
  python: [process.platform === 'win32' ? 'python' : 'python3', ['--version']],
  docker: ['docker', ['--version']],
  ollama: ['ollama', ['--version']],
  git: ['git', ['--version']]
}

export async function collectFacts(exec: Exec = realExec, options: { platform?: NodeJS.Platform; home?: string } = {}): Promise<SystemFacts> {
  const platform = options.platform ?? process.platform
  const read = (file: string) => {
    try {
      return fs.readFileSync(file, 'utf8')
    } catch {
      return null
    }
  }
  const softwareEntries = Object.entries(PROBES).map(async ([name, [cmd, args]]) => {
    const result = await exec(cmd, args)
    // The Windows Store "python" alias exits non-zero and prints nothing: absent.
    return [name, result.ok ? versionOf(result.stdout) : null] as const
  })
  const smi = exec('nvidia-smi', ['--query-gpu=name,driver_version,memory.total', '--format=csv,noheader'])
  const wsl = platform === 'win32' ? exec('wsl.exe', ['--status'], 15_000) : Promise.resolve({ ok: false, stdout: '' })

  let hardware: Pick<SystemFacts, 'os' | 'cpu' | 'gpus' | 'npus' | 'vulkan'>
  if (platform === 'win32') {
    const probe = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_PROBE], 30_000)
    try {
      hardware = parseWindowsProbe(probe.stdout.trim())
    } catch {
      hardware = fallbackHardware()
    }
  } else {
    hardware = fallbackHardware(read('/proc/cpuinfo'))
  }

  const software = Object.fromEntries(await Promise.all(softwareEntries)) as Record<string, string | null>
  software.wsl = (await wsl).ok ? 'present' : null
  const smiResult = await smi
  let freeDiskMB: number | null = null
  try {
    const stats = fs.statfsSync(options.home ?? os.homedir())
    freeDiskMB = Math.round((stats.bavail * stats.bsize) / 1048576)
  } catch {
    // unknown
  }

  return {
    platform,
    environment: detectEnvironment(platform, read),
    ...hardware,
    ramMB: Math.round(os.totalmem() / 1048576),
    freeDiskMB,
    software,
    nvidiaSmi: smiResult.ok ? smiResult.stdout.trim() || null : null
  }
}

function fallbackHardware(cpuinfo: string | null = null): Pick<SystemFacts, 'os' | 'cpu' | 'gpus' | 'npus' | 'vulkan'> {
  const flags = /^flags\s*:\s*(.*)$/m.exec(cpuinfo ?? '')?.[1]?.split(/\s+/) ?? null
  const cpus = os.cpus()
  return {
    os: { name: os.type(), version: os.version(), kernel: os.release() },
    cpu: { model: cpus[0]?.model ?? 'unknown', cores: 0, threads: cpus.length, avx2: flags ? flags.includes('avx2') : null, avx512: flags ? flags.includes('avx512f') : null },
    gpus: [],
    npus: [],
    vulkan: false
  }
}

const WINGET: Record<string, string> = {
  node: 'winget install --id OpenJS.NodeJS.LTS -e',
  pnpm: 'npm install -g pnpm',
  python: 'winget install --id Python.Python.3.12 -e',
  docker: 'winget install --id Docker.DockerDesktop -e',
  ollama: 'winget install --id Ollama.Ollama -e',
  git: 'winget install --id Git.Git -e'
}

const fixFor = (tool: string, platform: NodeJS.Platform): string | undefined => (platform === 'win32' ? WINGET[tool] : undefined)

/** Judge the facts: one check per item of the spec, critical only where Jarod-OS itself cannot run. */
export function evaluate(facts: SystemFacts): Check[] {
  const checks: Check[] = []
  const { platform, software } = facts
  const add = (check: Check) => checks.push(check)

  add({ id: 'os', label: 'Operating system', status: 'info', critical: false, detail: `${facts.os.name} ${facts.os.version} (${facts.environment})` })
  add({
    id: 'cpu',
    label: 'Processor',
    status: facts.cpu.avx2 === false ? 'outdated' : 'info',
    critical: false,
    detail: `${facts.cpu.model}, ${facts.cpu.cores || '?'} cores / ${facts.cpu.threads} threads, AVX2 ${flag(facts.cpu.avx2)}, AVX-512 ${flag(facts.cpu.avx512)}${facts.cpu.avx2 === false ? ' — local models will be slow or unavailable' : ''}`
  })
  add({
    id: 'ram',
    label: 'Memory',
    status: facts.ramMB < MIN_RAM_MB ? 'missing' : 'ok',
    critical: facts.ramMB < MIN_RAM_MB,
    detail: `${(facts.ramMB / 1024).toFixed(1)} GB${facts.ramMB < MIN_RAM_MB ? ` (Jarod-OS needs ${MIN_RAM_MB / 1024} GB)` : ''}`
  })
  if (facts.freeDiskMB !== null) {
    const low = facts.freeDiskMB < MIN_FREE_DISK_MB
    add({ id: 'disk', label: 'Free disk space', status: low ? 'missing' : 'ok', critical: low, detail: `${(facts.freeDiskMB / 1024).toFixed(1)} GB free${low ? ` (needs ${MIN_FREE_DISK_MB / 1024} GB)` : ''}` })
  }

  const dedicated = facts.gpus.filter(g => !g.integrated)
  for (const gpu of facts.gpus) {
    // An integrated GPU's registry size is the share of system memory it may borrow, not memory of its own.
    const memory = gpu.integrated ? `shares system memory${gpu.vramMB === null ? '' : ` (up to ${(gpu.vramMB / 1024).toFixed(1)} GB)`}` : gpu.vramMB === null ? 'unknown VRAM' : `${(gpu.vramMB / 1024).toFixed(1)} GB VRAM`
    add({ id: `gpu:${gpu.name}`, label: gpu.integrated ? 'Integrated GPU' : 'GPU', status: 'info', critical: false, detail: `${gpu.name}, ${memory}` })
  }
  if (facts.gpus.length === 0) add({ id: 'gpu', label: 'GPU', status: 'info', critical: false, detail: 'none detected — local models run on the CPU' })

  if (dedicated.some(g => g.vendor === 'nvidia')) {
    add(
      facts.nvidiaSmi
        ? { id: 'cuda', label: 'NVIDIA driver (CUDA)', status: 'ok', critical: false, detail: facts.nvidiaSmi }
        : { id: 'cuda', label: 'NVIDIA driver (CUDA)', status: 'missing', critical: false, detail: 'nvidia-smi does not answer: the driver is missing or broken', fix: platform === 'win32' ? 'https://www.nvidia.com/Download/index.aspx' : 'sudo ubuntu-drivers install' }
    )
  }
  if (dedicated.some(g => g.vendor === 'amd')) {
    add({ id: 'rocm', label: 'AMD GPU compute', status: 'info', critical: false, detail: platform === 'win32' ? 'ROCm is Linux-first; on Windows local models use Vulkan or DirectML' : 'install ROCm to use the GPU for local models', fix: platform === 'win32' ? undefined : 'https://rocm.docs.amd.com/projects/install-on-linux/' })
  }
  if (facts.gpus.length > 0) {
    add({ id: 'vulkan', label: 'Vulkan runtime', status: facts.vulkan ? 'ok' : 'missing', critical: false, detail: facts.vulkan ? 'present' : 'absent: update the GPU driver', fix: facts.vulkan ? undefined : 'update the GPU driver from the vendor' })
  }
  for (const npu of facts.npus) {
    add({ id: `npu:${npu.name}`, label: 'NPU', status: npu.ok ? 'ok' : 'missing', critical: false, detail: `${npu.name}${npu.ok ? '' : ': driver not working'}`, fix: npu.ok ? undefined : /intel/i.test(npu.name) ? 'https://www.intel.com/content/www/us/en/download/794734/intel-npu-driver-windows.html' : 'install the NPU driver from the vendor' })
  }
  if (facts.npus.some(n => n.ok && /intel/i.test(n.name))) {
    add({ id: 'openvino', label: 'OpenVINO', status: 'info', critical: false, detail: 'the Intel NPU runs models through OpenVINO', fix: 'pip install openvino' })
  }

  const version = (tool: string, label: string, min?: readonly number[]) => {
    const have = software[tool]
    if (!have) {
      add({ id: tool, label, status: 'missing', critical: false, detail: 'not installed', fix: fixFor(tool, platform) })
    } else if (min && !atLeast(have, min)) {
      add({ id: tool, label, status: 'outdated', critical: false, detail: `${have} (needs ${min.join('.')}+)`, fix: fixFor(tool, platform) })
    } else {
      add({ id: tool, label, status: 'ok', critical: false, detail: have })
    }
  }
  version('node', 'Node.js', MIN_NODE)
  version('npm', 'npm')
  version('pnpm', 'pnpm')
  version('git', 'Git')
  version('python', 'Python', MIN_PYTHON)
  version('ollama', 'Ollama')
  version('docker', 'Docker')
  if (platform === 'win32') {
    add({ id: 'wsl', label: 'WSL2', status: software.wsl ? 'ok' : 'missing', critical: false, detail: software.wsl ? 'present' : 'not installed (needed by Docker Desktop and Linux tools)', fix: software.wsl ? undefined : 'wsl --install' })
  }

  return checks
}

const flag = (value: boolean | null) => (value === null ? 'unknown' : value ? 'yes' : 'no')

export function auditFile(configDir: string): string {
  return path.join(configDir, 'system-audit.json')
}

/**
 * Run the audit, or reuse the saved one: idempotent, and only `force` (or a new audit format) collects again.
 * Each step is logged through `log`.
 */
export async function runAudit(options: {
  file: string
  force?: boolean
  collect?: () => Promise<SystemFacts>
  now?: () => Date
  log?: (message: string) => void
}): Promise<AuditReport> {
  const log = options.log ?? (() => undefined)
  if (!options.force) {
    try {
      const saved = JSON.parse(fs.readFileSync(options.file, 'utf8')) as AuditReport
      if (saved.version === AUDIT_VERSION && Array.isArray(saved.checks)) {
        log(`reusing the audit of ${saved.at}`)
        return saved
      }
      log('saved audit has an older format: auditing again')
    } catch {
      log('no saved audit: auditing the system')
    }
  }

  const started = Date.now()
  const facts = await (options.collect ?? (() => collectFacts()))()
  log(`facts collected in ${Date.now() - started} ms`)
  const checks = evaluate(facts)
  const report: AuditReport = { version: AUDIT_VERSION, at: (options.now?.() ?? new Date()).toISOString(), facts, checks, blocked: checks.some(c => c.critical && c.status !== 'ok') }
  for (const c of checks) if (c.status === 'missing' || c.status === 'outdated') log(`${c.critical ? 'BLOCKING ' : ''}${c.id}: ${c.status} — ${c.detail}`)
  writeFileAtomic(options.file, `${JSON.stringify(report, null, 2)}\n`)
  log(`audit saved to ${options.file}${report.blocked ? ' (first run blocked)' : ''}`)
  return report
}

/** Plain-text report: hardware, then each prerequisite with its fix. */
export function formatReport(report: AuditReport): string {
  const mark: Record<CheckStatus, string> = { ok: '[OK]', missing: '[ABSENT]', outdated: '[OUTDATED]', info: '[INFO]' }
  const lines = [`Jarod-OS system audit — ${report.at}`, '']
  for (const c of report.checks) {
    lines.push(`${mark[c.status]}${c.critical && c.status !== 'ok' ? ' [BLOCKING]' : ''} ${c.label}: ${c.detail}`)
    if (c.fix && c.status !== 'ok') lines.push(`    fix: ${c.fix}`)
  }
  lines.push('', report.blocked ? 'A critical prerequisite is missing: fix the BLOCKING lines, then run the audit again.' : 'Nothing blocks the first run.')
  return lines.join('\n')
}
