import { describe, expect, it } from 'vitest'
import type { Check, SystemFacts } from '../../../shared/system-audit.ts'
import { canInstall, checkDetail, checkLabel } from './DesktopSetup.tsx'

const check = (id: string, label: string): Check => ({ id, label, status: 'info', critical: false, detail: '' })

describe('checkLabel', () => {
  it('names checks from their id, telling integrated graphics apart', () => {
    expect(checkLabel(check('ram', 'Memory'))).toBe('Memory')
    expect(checkLabel(check('gpu:NVIDIA RTX', 'GPU'))).toBe('Graphics card')
    expect(checkLabel(check('gpu:Intel(R) Graphics', 'Integrated GPU'))).toBe('Integrated graphics')
    expect(checkLabel(check('npu:Intel(R) AI Boost', 'NPU'))).toBe('NPU')
  })

  it('falls back to the label main gave for a check it has no translation for', () => {
    expect(checkLabel(check('node', 'Node.js'))).toBe('Node.js')
  })
})

describe('checkDetail', () => {
  const facts: SystemFacts = {
    platform: 'win32',
    environment: 'windows',
    os: { name: 'Windows', version: '10', kernel: '10' },
    cpu: { model: 'Core Ultra 9', cores: 24, threads: 24, avx2: true, avx512: false },
    gpus: [{ name: 'Intel(R) Graphics', vendor: 'intel', vramMB: 2048, integrated: true, driver: null }],
    npus: [],
    ramMB: 65536,
    freeDiskMB: 10240,
    software: { node: '20.1.0', python: null },
    nvidiaSmi: null,
    vulkan: true
  }

  it('rebuilds the detail from the facts', () => {
    expect(checkDetail(check('cpu', 'Processor'), facts)).toBe('Core Ultra 9 · 24 cores / 24 threads · AVX2 yes · AVX-512 no')
    expect(checkDetail({ ...check('ram', 'Memory'), status: 'ok' }, facts)).toBe('64.0 GB')
    expect(checkDetail(check('gpu:Intel(R) Graphics', 'Integrated GPU'), facts)).toBe('Intel(R) Graphics · shares the system memory (up to 2.0 GB)')
    expect(checkDetail({ ...check('node', 'Node.js'), status: 'outdated' }, facts)).toBe('20.1.0 (needs 22.12 or later)')
    expect(checkDetail({ ...check('python', 'Python'), status: 'missing' }, facts)).toBe('not installed')
  })

  it('keeps the text main gave for a check it has no rule for', () => {
    expect(checkDetail({ ...check('os', 'Operating system'), detail: 'Windows 11' }, facts)).toBe('Windows 11')
  })
})

describe('canInstall', () => {
  const win = { platform: 'win32' } as SystemFacts
  const linux = { platform: 'linux' } as SystemFacts
  const missing = (id: string): Check => ({ id, label: id, status: 'missing', critical: false, detail: '' })

  it('offers an install for a missing or outdated known tool on Windows', () => {
    expect(canInstall(missing('git'), win)).toBe(true)
    expect(canInstall({ ...missing('python'), status: 'outdated' }, win)).toBe(true)
  })

  it('offers nothing for a tool it cannot install, one already there, or outside Windows', () => {
    expect(canInstall(missing('cuda'), win)).toBe(false)
    expect(canInstall({ ...missing('git'), status: 'ok' }, win)).toBe(false)
    expect(canInstall(missing('git'), linux)).toBe(false)
  })
})
