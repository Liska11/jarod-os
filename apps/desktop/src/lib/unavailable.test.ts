import { describe, expect, it } from 'vitest'
import { failureText, isNotAvailable, NOT_AVAILABLE } from './unavailable.ts'

describe('isNotAvailable / failureText', () => {
  it('recognises the engine sentence in an RPC error and in a REST error, and nothing else', () => {
    expect(isNotAvailable(new Error('Not available in this version'))).toBe(true)
    expect(isNotAvailable(new Error('GET /api/audio/voice-live/status -> 404: Not available in this version'))).toBe(true)
    expect(isNotAvailable(new Error('method not found: usage.bars'))).toBe(false)
    expect(isNotAvailable(new Error('GET /api/x -> 404: not implemented by the Jarod gateway'))).toBe(false)
    expect(isNotAvailable(undefined)).toBe(false)
    expect(isNotAvailable('Not available in this version')).toBe(true)
  })

  it('shows the clean sentence for a known gap and the real message for a failure', () => {
    expect(failureText(new Error('POST /api/mcp/servers/x/auth -> 404: Not available in this version'))).toBe(NOT_AVAILABLE)
    expect(failureText(new Error('connection refused'))).toBe('connection refused')
    expect(failureText('boom')).toBe('boom')
  })
})
