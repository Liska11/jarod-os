import { describe, expect, it } from 'vitest'
import { isConnecting } from './use-async.ts'

describe('isConnecting', () => {
  it('is true until the first gateway.ready, for data that is due', () => {
    expect(isConnecting(0, true)).toBe(true)
    expect(isConnecting(1, true)).toBe(false)
    expect(isConnecting(7, true)).toBe(false)
  })

  it('is false for data that is switched off, whatever the connection', () => {
    expect(isConnecting(0, false)).toBe(false)
  })
})
