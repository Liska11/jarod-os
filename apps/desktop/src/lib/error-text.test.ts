import { describe, expect, it } from 'vitest'
import { explainError } from './error-text.ts'

describe('explainError', () => {
  it("names the tool limit a provider refused (the DeepSeek / OpenAI 128 cap)", () => {
    expect(explainError(`HTTP 400: {"error":{"message":"'tools' : maximum number of items is 128","type":"invalid_request_error"}}`)).toEqual({ kind: 'tooManyTools', value: 128 })
  })

  it('tells a refused key, a missing balance and a quota apart', () => {
    expect(explainError('HTTP 401: invalid api key')?.kind).toBe('auth')
    expect(explainError('HTTP 402: Insufficient Balance')?.kind).toBe('credit')
    expect(explainError('HTTP 429: rate limit reached')?.kind).toBe('quota')
  })

  it('a server that is not there, a timeout and a provider failure', () => {
    expect(explainError('fetch failed')?.kind).toBe('unreachable')
    expect(explainError('connect ECONNREFUSED 127.0.0.1:30000')?.kind).toBe('unreachable')
    expect(explainError('The operation was aborted due to timeout')?.kind).toBe('timeout')
    expect(explainError('HTTP 503: overloaded')).toEqual({ kind: 'server', value: 503 })
  })

  it('a generic bad request is named, anything unknown or empty is left to the raw text', () => {
    expect(explainError('HTTP 400: {"error":"x"}')).toEqual({ kind: 'badRequest', value: 400 })
    expect(explainError('quelque chose d’inattendu')).toBeNull()
    expect(explainError('  ')).toBeNull()
  })
})
