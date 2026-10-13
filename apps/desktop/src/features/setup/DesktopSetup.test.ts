import { describe, expect, it } from 'vitest'
import type { Check } from '../../../shared/system-audit.ts'
import { checkLabel } from './DesktopSetup.tsx'

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
