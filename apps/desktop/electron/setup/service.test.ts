import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SystemFacts } from '../../shared/system-audit.ts'
import { AuditService } from './service.ts'

const facts: SystemFacts = {
  platform: 'win32',
  environment: 'windows',
  os: { name: 'Windows', version: '10', kernel: '10' },
  cpu: { model: 'cpu', cores: 4, threads: 8, avx2: true, avx512: false },
  gpus: [],
  npus: [],
  ramMB: 16384,
  freeDiskMB: 50_000,
  software: { node: '24.0.0', wsl: 'present' },
  nvidiaSmi: null,
  vulkan: false
}

describe('AuditService', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
  })

  it('shares one run between callers, and audits again when forced', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarod-audit-svc-'))
    dirs.push(dir)
    let runs = 0
    const service = new AuditService({ configDir: dir, collect: async () => (runs++, facts) })
    const [a, b] = await Promise.all([service.get(), service.get()])
    expect(a).toBe(b)
    expect(runs).toBe(1)
    await service.get(true)
    expect(runs).toBe(2)
    expect(fs.existsSync(path.join(dir, 'system-audit.json'))).toBe(true)
  })

  it('tries again after a failed run', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarod-audit-svc-'))
    dirs.push(dir)
    let fail = true
    const service = new AuditService({
      configDir: dir,
      collect: async () => {
        if (fail) throw new Error('probe failed')
        return facts
      }
    })
    await expect(service.get()).rejects.toThrow('probe failed')
    fail = false
    await expect(service.get()).resolves.toMatchObject({ blocked: false })
  })
})
