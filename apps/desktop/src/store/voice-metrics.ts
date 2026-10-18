import { atom } from 'nanostores'

/*
 * Measured, not promised (docs/VOICE.md): timings of the current app run's voice conversations, kept in memory only (no audio, no text).
 * Every turn timing starts at the end of the person's speech (the endpointer's speech-end):
 * - transcriptMs: → transcript back from speech to text;
 * - firstTokenMs: → first text of the model's answer;
 * - firstAudioMs: → first sound of Jarod's answer;
 * - stop: a detected interruption → Jarod's audio silenced;
 * - bargeIns / falseBargeIns: interruptions, and those followed by no words (noise, or Jarod's own voice through the speakers).
 * `lastTurn` is the breakdown of the latest turn (the end-to-end test reads it from the orb).
 */
export interface VoiceTurnTiming {
  transcriptMs: number | null
  firstTokenMs: number | null
  firstAudioMs: number | null
}

export interface VoiceMetrics {
  transcriptMs: number[]
  firstTokenMs: number[]
  firstAudioMs: number[]
  stopMs: number[]
  bargeIns: number
  falseBargeIns: number
  lastTurn: VoiceTurnTiming | null
}

const KEEP = 20
const MAX_MS = 120_000

const EMPTY: VoiceMetrics = { transcriptMs: [], firstTokenMs: [], firstAudioMs: [], stopMs: [], bargeIns: 0, falseBargeIns: 0, lastTurn: null }

export const $voiceMetrics = atom<VoiceMetrics>(EMPTY)

const push = (list: number[], value: number) => [...list, Math.round(value)].slice(-KEEP)
const valid = (ms: number) => ms >= 0 && ms < MAX_MS

/** A new turn: its breakdown starts empty (a turn that never reaches the model keeps nulls). */
export function beginTurnTiming(): void {
  $voiceMetrics.set({ ...$voiceMetrics.get(), lastTurn: { transcriptMs: null, firstTokenMs: null, firstAudioMs: null } })
}

function recordStage(stage: keyof VoiceTurnTiming, ms: number): void {
  if (!valid(ms)) return

  const current = $voiceMetrics.get()
  const lastTurn = current.lastTurn ?? { transcriptMs: null, firstTokenMs: null, firstAudioMs: null }
  $voiceMetrics.set({ ...current, [stage]: push(current[stage], ms), lastTurn: { ...lastTurn, [stage]: Math.round(ms) } })
}

export function recordTranscript(ms: number): void {
  recordStage('transcriptMs', ms)
}

export function recordFirstToken(ms: number): void {
  recordStage('firstTokenMs', ms)
}

export function recordFirstAudio(ms: number): void {
  recordStage('firstAudioMs', ms)
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
