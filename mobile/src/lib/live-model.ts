/**
 * The live conversation, as a state machine: hold to talk, release to send, Jarod answers on screen
 * and aloud. Pure, so the order of what happens is what the tests check; `LiveTalk.tsx` draws it.
 *
 *   idle ─press→ listening ─release→ sending ─heard→ thinking ─delta→ answering ─done→ reading
 *     ↑                                                                               │speaking
 *     └──────────────────────────── speech ends / nothing to read ←── speaking ←──────┘
 * A press at any moment starts listening again (it interrupts Jarod's voice).
 */
export type LivePhase = 'idle' | 'listening' | 'sending' | 'thinking' | 'answering' | 'reading' | 'speaking' | 'error'

export interface LiveState {
  phase: LivePhase
  /** What the PC heard of the last message. */
  heard: string
  /** Jarod's answer so far. */
  reply: string
  /** A short line under the bubble: a hint or what went wrong. */
  note: string
}

export type LiveEvent =
  | { type: 'press' }
  | { type: 'release'; ms: number }
  | { type: 'heard'; text: string }
  | { type: 'agent'; data: Record<string, unknown> }
  | { type: 'speaking'; on: boolean }
  /** Reading aloud could not start (no voice, switched off): the answer stays on screen. */
  | { type: 'silent' }
  | { type: 'fail'; message: string }

/** Shorter than this, a press is a tap: nothing is sent. */
export const MIN_HOLD_MS = 400

export const LIVE_START: LiveState = { phase: 'idle', heard: '', reply: '', note: 'Maintenez la bulle pour parler.' }

const BUSY: LivePhase[] = ['sending', 'thinking', 'answering']

export function liveStep(s: LiveState, e: LiveEvent): LiveState {
  switch (e.type) {
    case 'press':
      return { phase: 'listening', heard: '', reply: '', note: 'Je vous écoute… relâchez pour envoyer.' }
    case 'release':
      if (s.phase !== 'listening') return s
      if (e.ms < MIN_HOLD_MS) return { ...s, phase: 'idle', note: 'Maintenez la bulle pendant que vous parlez.' }
      return { ...s, phase: 'sending', note: 'Transcription sur le PC…' }
    case 'heard':
      if (s.phase !== 'sending') return s
      if (!e.text.trim()) return { ...s, phase: 'idle', note: 'Je n’ai rien entendu. Réessayez.' }
      return { ...s, phase: 'thinking', heard: e.text.trim(), note: '' }
    case 'agent': {
      if (!BUSY.includes(s.phase) || s.phase === 'sending') return s
      const d = e.data
      if (d.type === 'delta' && typeof d.text === 'string' && d.text) return { ...s, phase: 'answering', reply: s.reply + d.text }
      if (d.type === 'stream-reset') return { ...s, reply: '' }
      if (d.type === 'message') {
        const m = d.message as { role?: string; content?: string } | undefined
        if (m?.role === 'assistant' && m.content?.trim()) return { ...s, phase: 'answering', reply: m.content }
        return s
      }
      if (d.type === 'error') return { ...s, phase: 'error', note: String(d.error ?? 'Jarod n’a pas pu répondre.') }
      if (d.type === 'done') return s.reply.trim() ? { ...s, phase: 'reading', note: '' } : { ...s, phase: 'idle', note: 'Pas de réponse.' }
      return s
    }
    case 'speaking':
      if (e.on) return s.phase === 'reading' || s.phase === 'speaking' ? { ...s, phase: 'speaking' } : s
      return s.phase === 'speaking' || s.phase === 'reading' ? { ...s, phase: 'idle', note: 'Maintenez la bulle pour répondre.' } : s
    case 'silent':
      return s.phase === 'reading' ? { ...s, phase: 'idle', note: 'Réponse affichée (lecture à voix haute indisponible).' } : s
    case 'fail':
      return { ...s, phase: 'error', note: e.message }
  }
}

/** The bubble's label for each phase (also what a screen reader says). */
export const PHASE_LABEL: Record<LivePhase, string> = {
  idle: 'Maintenir pour parler',
  listening: 'Écoute',
  sending: 'Envoi',
  thinking: 'Jarod réfléchit',
  answering: 'Jarod répond',
  reading: 'Jarod répond',
  speaking: 'Jarod parle',
  error: 'Réessayer'
}
