import { beforeEach, describe, expect, it, vi } from 'vitest'
import { isProviderConfigError, resetProviderFallback, withProviderFallback } from './provider-fallback.ts'

const restCalls: Array<{ method: string; path: string; body?: unknown }> = []
let configured = 'openai'

beforeEach(() => {
  restCalls.length = 0
  configured = 'openai'
  resetProviderFallback()
  // The renderer bridge: GET /api/config reports the provider, PUT /api/config records the switch.
  ;(globalThis as unknown as { window: unknown }).window = {
    jarodOS: {
      backend: {
        rest: async (request: { method: string; path: string; body?: { config?: { tts?: { provider?: string }; stt?: { provider?: string } } } }) => {
          restCalls.push(request)

          if (request.method === 'GET') {
            return { tts: { provider: configured }, stt: { provider: configured } }
          }

          configured = request.body?.config?.tts?.provider ?? request.body?.config?.stt?.provider ?? configured

          return { ok: true }
        }
      }
    }
  }
})

describe('isProviderConfigError', () => {
  it('recognises setup failures and ignores audio failures', () => {
    expect(isProviderConfigError(new Error('TTS configuration error (openai): neither tts.openai.api_key in config nor OPENAI_API_KEY is set'))).toBe(true)
    expect(isProviderConfigError(new Error('the Nous Tool Gateway is not available (not entitled or unreachable)'))).toBe(true)
    expect(isProviderConfigError(new Error('Audio recording is empty'))).toBe(false)
  })
})

describe('withProviderFallback', () => {
  it('switches to the free provider once and retries', async () => {
    const attempt = vi.fn<() => Promise<string>>().mockRejectedValueOnce(new Error('OPENAI_API_KEY is not set')).mockResolvedValue('spoken')
    const switched = vi.fn()

    await expect(withProviderFallback('tts', attempt, switched)).resolves.toBe('spoken')
    expect(attempt).toHaveBeenCalledTimes(2)
    expect(switched).toHaveBeenCalledWith('openai', 'edge')
    expect(restCalls.some(call => call.method === 'PUT' && JSON.stringify(call.body).includes('"edge"'))).toBe(true)
  })

  it('does not loop when the free provider itself fails', async () => {
    configured = 'edge'
    const attempt = vi.fn<() => Promise<string>>().mockRejectedValue(new Error('edge-tts is not installed'))

    await expect(withProviderFallback('tts', attempt)).rejects.toThrow('not installed')
    expect(attempt).toHaveBeenCalledTimes(1)
    expect(restCalls.filter(call => call.method === 'PUT')).toHaveLength(0)
  })

  it('rethrows non-configuration errors untouched', async () => {
    const attempt = vi.fn<() => Promise<string>>().mockRejectedValue(new Error('Audio recording is empty'))

    await expect(withProviderFallback('stt', attempt)).rejects.toThrow('empty')
    expect(restCalls).toHaveLength(0)
  })
})
