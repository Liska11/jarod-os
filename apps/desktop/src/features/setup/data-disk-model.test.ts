import { describe, expect, it } from 'vitest'
import type { DriveInfo } from '../../../shared/data-disk.ts'
import { diskErrorKey, recommendedDrive, rootForDrive } from './data-disk-model.ts'

const drive = (letter: string, free: number, warnings: DriveInfo['warnings'] = [], system = false): DriveInfo => ({
  letter,
  label: '',
  fileSystem: 'NTFS',
  free,
  size: free * 2,
  kind: 'fixed',
  system,
  warnings,
  suggestedRoot: `${letter}\\Jarod-OS`
})

describe('recommendedDrive', () => {
  it('offers the roomiest drive with nothing to warn about', () => {
    expect(recommendedDrive([drive('C:', 900, ['system'], true), drive('D:', 100), drive('E:', 500)])?.letter).toBe('E:')
  })

  it('falls back to a non-system drive, then to nothing', () => {
    expect(recommendedDrive([drive('C:', 900, ['system'], true), drive('E:', 10, ['removable'])])?.letter).toBe('E:')
    expect(recommendedDrive([drive('C:', 900, ['system'], true)])).toBeNull()
    expect(recommendedDrive([])).toBeNull()
  })
})

describe('rootForDrive', () => {
  it('follows the drive unless the person typed their own folder', () => {
    expect(rootForDrive(drive('E:', 1), 'D:\\Jarod-OS', drive('D:', 1))).toBe('E:\\Jarod-OS')
    expect(rootForDrive(drive('E:', 1), '', null)).toBe('E:\\Jarod-OS')
    expect(rootForDrive(drive('E:', 1), 'F:\\Mine', drive('D:', 1))).toBe('F:\\Mine')
  })
})

describe('diskErrorKey', () => {
  it('names the known reasons and keeps a copy failure’s words', () => {
    expect(diskErrorKey('occupied')).toEqual({ key: 'disk.error.occupied' })
    expect(diskErrorKey('2 file(s) did not copy')).toEqual({ key: 'disk.error.copy', detail: '2 file(s) did not copy' })
  })
})
