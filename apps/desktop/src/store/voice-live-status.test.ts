import { beforeEach, describe, expect, it, vi } from 'vitest'

const get = vi.fn()

vi.mock('../lib/rest.ts', () => ({ rest: { get: (...args: unknown[]) => get(...args) } }))

const { fetchLiveStatus } = await import('./voice-live-status.ts')

describe('fetchLiveStatus', () => {
  beforeEach(() => {
    get.mockReset()
  })

  it('says "Not available in this version" when the Jarod engine has no GPT-Live', async () => {
    get.mockImplementation(() => Promise.reject(new Error('GET /api/audio/voice-live/status -> 404: Not available in this version')))

    expect(await fetchLiveStatus()).toMatchObject({ mode: 'chained', available: false, reason: 'Not available in this version' })
  })

  it('keeps the old-Hermes hint for a bare 404, and the message for any other failure', async () => {
    get.mockRejectedValueOnce(new Error('GET /api/audio/voice-live/status -> 404: Not Found'))
    expect((await fetchLiveStatus()).reason).toContain('older than 0.21.3')

    get.mockRejectedValueOnce(new Error('connection refused'))
    expect((await fetchLiveStatus()).reason).toBe('connection refused')
  })

  it('passes a live status through', async () => {
    get.mockResolvedValue({ mode: 'gpt-live', available: true, model: 'm', voice: 'v' })

    expect(await fetchLiveStatus()).toEqual({ mode: 'gpt-live', available: true, reason: null, model: 'm', voice: 'v' })
  })
})
