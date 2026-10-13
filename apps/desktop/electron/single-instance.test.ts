import { describe, expect, it, vi } from 'vitest'
import { claimSingleInstance } from './single-instance.ts'

describe('claimSingleInstance', () => {
  it('keeps the first instance running', () => {
    const app = { requestSingleInstanceLock: vi.fn(() => true), exit: vi.fn() }

    expect(claimSingleInstance(app)).toBe(true)
    expect(app.exit).not.toHaveBeenCalled()
  })

  it('exits a second instance at once instead of quitting through the ready cycle', () => {
    const app = { requestSingleInstanceLock: vi.fn(() => false), exit: vi.fn() }

    expect(claimSingleInstance(app)).toBe(false)
    expect(app.exit).toHaveBeenCalledWith(0)
  })
})
