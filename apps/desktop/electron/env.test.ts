import { describe, expect, it } from 'vitest'
import { osEnv } from './env.ts'

describe('osEnv', () => {
  it('reads the JAROD_OS_ name', () => {
    expect(osEnv('WINDOWED', { JAROD_OS_WINDOWED: '1' })).toBe('1')
  })

  it('falls back to the pre-rename HERMES_OS_ name', () => {
    expect(osEnv('ZOOM', { HERMES_OS_ZOOM: '1.5' })).toBe('1.5')
  })

  it('prefers the new name when both are set', () => {
    expect(osEnv('SHELL_MODE', { JAROD_OS_SHELL_MODE: 'panels', HERMES_OS_SHELL_MODE: 'desktop' })).toBe('panels')
  })

  it('is undefined when neither is set', () => {
    expect(osEnv('KIOSK', {})).toBeUndefined()
  })
})
