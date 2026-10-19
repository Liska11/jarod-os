import { describe, expect, it } from 'vitest'
import { CrashPolicy, isSafeMode, recoveryAction, recoveryPage, relaunchArgs, SAFE_MODE_FLAG } from './recovery.ts'

describe('CrashPolicy', () => {
  it('reloads after a first crash and shows the recovery page after a second within the minute', () => {
    const policy = new CrashPolicy(60_000, 1)

    expect(policy.next('crashed', 0)).toBe('reload')
    expect(policy.next('oom', 30_000)).toBe('recover')
  })

  it('forgets crashes older than the window', () => {
    const policy = new CrashPolicy(60_000, 1)

    expect(policy.next('crashed', 0)).toBe('reload')
    expect(policy.next('crashed', 61_000)).toBe('reload')
  })

  it('ignores a clean exit', () => {
    const policy = new CrashPolicy(60_000, 1)

    expect(policy.next('clean-exit', 0)).toBe('ignore')
    expect(policy.next('crashed', 1)).toBe('reload')
  })
})

describe('safe mode', () => {
  it('is on with the flag or JAROD_OS_SAFE_MODE=1', () => {
    expect(isSafeMode(['jarod', SAFE_MODE_FLAG], {})).toBe(true)
    expect(isSafeMode(['jarod'], { JAROD_OS_SAFE_MODE: '1' })).toBe(true)
    expect(isSafeMode(['jarod'], {})).toBe(false)
  })

  it('relaunches with the same arguments, the flag added or removed once', () => {
    expect(relaunchArgs(['exe', '--user-data-dir=x'], true)).toEqual(['--user-data-dir=x', SAFE_MODE_FLAG])
    expect(relaunchArgs(['exe', SAFE_MODE_FLAG, '--user-data-dir=x'], true)).toEqual(['--user-data-dir=x', SAFE_MODE_FLAG])
    expect(relaunchArgs(['exe', SAFE_MODE_FLAG, '--user-data-dir=x'], false)).toEqual(['--user-data-dir=x'])
  })
})

describe('recovery page', () => {
  it('maps its links to actions and nothing else', () => {
    expect(recoveryAction('jarod-recovery:reload')).toBe('reload')
    expect(recoveryAction('jarod-recovery://safe-mode/')).toBe('safe-mode')
    expect(recoveryAction('jarod-recovery:format-disk')).toBeNull()
    expect(recoveryAction('https://example.com/')).toBeNull()
  })

  it('offers safe mode, or the way back from it, and escapes the reason', () => {
    expect(recoveryPage('crashed', false)).toContain('jarod-recovery:safe-mode')
    expect(recoveryPage('crashed', true)).toContain('jarod-recovery:normal-mode')
    expect(recoveryPage('<img src=x>', false)).not.toContain('<img')
  })
})
