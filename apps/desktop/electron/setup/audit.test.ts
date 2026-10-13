import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AUDIT_VERSION, atLeast, collectFacts, detectEnvironment, evaluate, type Exec, formatReport, parseWindowsProbe, runAudit, type SystemFacts, versionOf } from './audit.ts'

const facts = (over: Partial<SystemFacts> = {}): SystemFacts => ({
  platform: 'win32',
  environment: 'windows',
  os: { name: 'Windows 11 Pro', version: '10.0.26300', kernel: '10.0.26300' },
  cpu: { model: 'Intel Core Ultra 7', cores: 16, threads: 22, avx2: true, avx512: false },
  gpus: [],
  npus: [],
  ramMB: 32768,
  freeDiskMB: 200_000,
  software: { node: '24.1.0', npm: '11.0.0', pnpm: '10.0.0', git: '2.47.0', python: '3.12.4', ollama: null, docker: null, wsl: 'present' },
  nvidiaSmi: null,
  vulkan: true,
  ...over
})

const byId = (checks: ReturnType<typeof evaluate>, id: string) => checks.find(c => c.id === id)

describe('versions', () => {
  it('reads the first dotted version of a tool output', () => {
    expect(versionOf('v22.12.0\n')).toBe('22.12.0')
    expect(versionOf('Python 3.12.4')).toBe('3.12.4')
    expect(versionOf('Docker version 27.1.1, build 6312585')).toBe('27.1.1')
    expect(versionOf('')).toBeNull()
  })

  it('compares against a minimum', () => {
    expect(atLeast('22.12.0', [22, 12, 0])).toBe(true)
    expect(atLeast('22.11.9', [22, 12, 0])).toBe(false)
    expect(atLeast('24.0', [22, 12, 0])).toBe(true)
    expect(atLeast('3.9.18', [3, 10, 0])).toBe(false)
  })
})

describe('parseWindowsProbe', () => {
  it('takes the real VRAM from the registry, drops virtual adapters and wraps single objects', () => {
    const probe = JSON.stringify({
      os: { name: 'Microsoft Windows 11 Pro', version: '10.0.26300' },
      cpu: { name: ' Intel(R) Core(TM) Ultra 7 155H ', cores: 16, threads: 22, avx2: true, avx512: false },
      gpus: [
        { name: 'NVIDIA GeForce RTX 4070 Laptop GPU', driver: '32.0.15.6094', adapterRam: 4293918720 },
        { name: 'Intel(R) Arc(TM) Graphics', driver: '31.0.101.5333', adapterRam: 134217728 },
        { name: 'Microsoft Basic Display Adapter' }
      ],
      vram: [{ name: 'NVIDIA GeForce RTX 4070 Laptop GPU', bytes: 8589934592 }],
      npus: { name: 'Intel(R) AI Boost', status: 'OK' },
      vulkan: true
    })
    const parsed = parseWindowsProbe(probe)
    expect(parsed.cpu.model).toBe('Intel(R) Core(TM) Ultra 7 155H')
    expect(parsed.gpus).toHaveLength(2)
    expect(parsed.gpus[0]).toMatchObject({ vendor: 'nvidia', vramMB: 8192, integrated: false })
    expect(parsed.gpus[1]).toMatchObject({ vendor: 'intel', integrated: true })
    expect(parsed.npus).toEqual([{ name: 'Intel(R) AI Boost', ok: true }])
  })
})

describe('detectEnvironment', () => {
  const reader = (files: Record<string, string>) => (file: string) => files[file] ?? null
  it('tells WSL2, Docker and Linux apart', () => {
    expect(detectEnvironment('linux', reader({ '/proc/version': 'Linux 5.15 microsoft-standard-WSL2' }))).toBe('wsl2')
    expect(detectEnvironment('linux', reader({ '/.dockerenv': '' }))).toBe('docker')
    expect(detectEnvironment('linux', reader({}))).toBe('linux')
    expect(detectEnvironment('win32', reader({}))).toBe('windows')
  })
})

describe('evaluate', () => {
  it('blocks only on memory and disk', () => {
    const checks = evaluate(facts({ ramMB: 2048, freeDiskMB: 500, software: {} }))
    expect(checks.filter(c => c.critical).map(c => c.id).sort()).toEqual(['disk', 'ram'])
    expect(byId(checks, 'node')).toMatchObject({ status: 'missing', critical: false, fix: 'winget install --id OpenJS.NodeJS.LTS -e' })
  })

  it('flags an old Node and Python with their fix', () => {
    const checks = evaluate(facts({ software: { node: '20.11.0', python: '3.9.1', wsl: 'present' } }))
    expect(byId(checks, 'node')?.status).toBe('outdated')
    expect(byId(checks, 'python')?.status).toBe('outdated')
  })

  it('asks for the NVIDIA driver when a dedicated card has no nvidia-smi, and an NPU driver when the NPU is down', () => {
    const checks = evaluate(facts({ gpus: [{ name: 'NVIDIA GeForce RTX 4070', vendor: 'nvidia', vramMB: 8192, integrated: false, driver: null }], npus: [{ name: 'Intel(R) AI Boost', ok: false }] }))
    expect(byId(checks, 'cuda')?.status).toBe('missing')
    expect(byId(checks, 'npu:Intel(R) AI Boost')?.status).toBe('missing')
  })

  it('suggests WSL only on Windows', () => {
    expect(byId(evaluate(facts({ software: { wsl: null } })), 'wsl')).toMatchObject({ status: 'missing', fix: 'wsl --install' })
    expect(byId(evaluate(facts({ platform: 'linux', environment: 'linux' })), 'wsl')).toBeUndefined()
  })
})

describe('collectFacts', () => {
  it('treats a failing probe as absent', async () => {
    const exec: Exec = async cmd => (cmd === 'node' ? { ok: true, stdout: 'v24.1.0' } : { ok: false, stdout: '' })
    const result = await collectFacts(exec, { platform: 'linux', home: os.tmpdir() })
    expect(result.software.node).toBe('24.1.0')
    expect(result.software.python).toBeNull()
    expect(result.nvidiaSmi).toBeNull()
  })
})

describe('runAudit', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
  })

  it('saves the report, reuses it, and audits again only when forced', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarod-audit-'))
    dirs.push(dir)
    const file = path.join(dir, 'system-audit.json')
    let collected = 0
    const collect = async () => {
      collected++
      return facts()
    }
    const logs: string[] = []

    const first = await runAudit({ file, collect, log: m => logs.push(m) })
    expect(first.version).toBe(AUDIT_VERSION)
    expect(first.blocked).toBe(false)
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).at).toBe(first.at)

    await runAudit({ file, collect })
    expect(collected).toBe(1)
    await runAudit({ file, collect, force: true })
    expect(collected).toBe(2)
    expect(logs.some(l => l.includes('audit saved'))).toBe(true)
  })

  it('reports a blocked first run in plain text', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarod-audit-'))
    dirs.push(dir)
    const report = await runAudit({ file: path.join(dir, 'a.json'), collect: async () => facts({ ramMB: 1024 }) })
    expect(report.blocked).toBe(true)
    const text = formatReport(report)
    expect(text).toContain('[BLOCKING] Memory')
    expect(text).toContain('fix: winget install --id Ollama.Ollama -e')
  })
})
