import { rest } from '../lib/rest.ts'
import { failureText } from '../lib/unavailable.ts'

/** `GET /api/audio/voice-live/status`: whether GPT-Live can start on this runtime (non-secret). */
export interface LiveStatus {
  mode: 'chained' | 'gpt-live'
  available: boolean
  reason: string | null
  model: string
  voice: string
}

export async function fetchLiveStatus(): Promise<LiveStatus> {
  try {
    const raw = await rest.get<Partial<LiveStatus> & { ok?: boolean }>('/api/audio/voice-live/status')

    return {
      mode: raw.mode === 'gpt-live' ? 'gpt-live' : 'chained',
      available: Boolean(raw.available),
      reason: raw.reason ?? null,
      model: raw.model ?? 'gpt-live-1',
      voice: raw.voice ?? 'marin'
    }
  } catch (error) {
    const message = failureText(error)
    // The Jarod engine says "Not available in this version" itself (`failureText` keeps that sentence and drops the 404); a bare 404 means a Hermes runtime that predates the voice-live routes (hermes < 0.21.3).
    const reason = /404/.test(message) ? 'Hermes is older than 0.21.3; run `hermes update` for the Live engine.' : message

    return { mode: 'chained', available: false, reason, model: 'gpt-live-1', voice: 'marin' }
  }
}
