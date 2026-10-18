import { atom } from 'nanostores'

/*
 * Measured, not promised (docs/VOICE.md): timings of the current app run's voice conversations, kept in memory only (no audio, no text).
 * - firstAudio: end of the person's speech → first sound of Jarod's answer;
 * - stop: a detected interruption → Jarod's audio silenced;
 * - bargeIns / falseBargeIns: interruptions, and those followed by no words (noise, or Jarod's own voice through the speakers).
 */
export interface VoiceMetrics {
  firstAudioMs: number[]
  stopMs: number[]
  bargeIns: number
  falseBargeIns: number
}

const KEEP = 20

export const $voiceMetrics = atom<VoiceMetrics>({ firstAudioMs: [], stopMs: [], bargeIns: 0, falseBargeIns: 0 })

const push = (list: number[], value: number) => [...list, Math.round(value)].slice(-KEEP)

export function recordFirstAudio(ms: number): void {
  if (ms >= 0 && ms < 120_000) $voiceMetrics.set({ ...$voiceMetrics.get(), firstAudioMs: push($voiceMetrics.get().firstAudioMs, ms) })
}

export function recordStop(ms: number, fromSpeech: boolean): void {
  const current = $voiceMetrics.get()
  $voiceMetrics.set({ ...current, stopMs: push(current.stopMs, ms), bargeIns: current.bargeIns + (fromSpeech ? 1 : 0) })
}

export function recordFalseBargeIn(): void {
  $voiceMetrics.set({ ...$voiceMetrics.get(), falseBargeIns: $voiceMetrics.get().falseBargeIns + 1 })
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null

  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)

  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2)
}
