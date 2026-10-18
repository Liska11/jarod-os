import { type PointerEvent, useEffect, useReducer, useRef, useState } from 'react'
import type { PushedEvent } from '../lib/channel.ts'
import { LIVE_START, liveStep, PHASE_LABEL } from '../lib/live-model.ts'
import { speech } from '../lib/native.ts'
import { readAloud, speechStatus, stopReading } from '../lib/speech.ts'
import { type Recording, startRecording } from '../lib/voice.ts'
import { Markdown } from './Markdown.tsx'

interface Props {
  /** The conversation to talk in (created on the first message if there is none). */
  ensureSession: () => Promise<string | undefined>
  call: <T>(method: string, params?: Record<string, unknown>) => Promise<T | undefined>
  subscribe: (fn: (e: PushedEvent) => void) => () => void
  onClose: () => void
}

/**
 * Talking with Jarod live: hold the bubble to speak, release to send. The bubble follows the voice
 * while listening, turns while Jarod thinks, and ripples while he answers aloud. Pressing while he
 * speaks cuts him off and listens again.
 */
export function LiveTalk({ ensureSession, call, subscribe, onClose }: Props) {
  const [state, dispatch] = useReducer(liveStep, LIVE_START)
  const [level, setLevel] = useState(0)
  const recording = useRef<Recording | null>(null)
  const pressedAt = useRef(0)
  const session = useRef('')
  const phase = useRef(state.phase)
  phase.current = state.phase

  // Jarod's events for the conversation being talked in.
  useEffect(
    () =>
      subscribe(e => {
        if (e.event === 'agent' && e.data.sessionId === session.current) dispatch({ type: 'agent', data: e.data })
      }),
    [subscribe]
  )

  // The phone's voice: the "speaking" ripple starts and stops with it.
  useEffect(() => {
    const sub = speech.addListener('state', ({ speaking }) => dispatch({ type: 'speaking', on: speaking }))
    return () => void sub.then(s => s.remove())
  }, [])

  // The answer is complete: read it aloud (the setting does not apply here, live is spoken).
  useEffect(() => {
    if (state.phase !== 'reading') return
    void (async () => {
      const ok = await speechStatus().catch(() => ({ available: false }))
      if (!ok.available) return dispatch({ type: 'silent' })
      await readAloud(state.reply).catch(() => dispatch({ type: 'silent' }))
    })()
  }, [state.phase, state.reply])

  // Leaving: the microphone and the voice stop.
  useEffect(
    () => () => {
      recording.current?.cancel()
      void stopReading()
    },
    []
  )

  const press = async (e: PointerEvent<HTMLButtonElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    if (recording.current) return
    void stopReading()
    pressedAt.current = Date.now()
    dispatch({ type: 'press' })
    navigator.vibrate?.(15)
    try {
      recording.current = await startRecording(() => void release(), setLevel)
      // Released before the microphone was ready: drop it.
      if (phase.current !== 'listening') {
        recording.current.cancel()
        recording.current = null
      }
    } catch {
      dispatch({ type: 'fail', message: 'Micro indisponible : autorisez-le dans les réglages du téléphone.' })
    }
  }

  const release = async () => {
    const rec = recording.current
    recording.current = null
    setLevel(0)
    const ms = Date.now() - pressedAt.current
    dispatch({ type: 'release', ms })
    if (!rec) return
    if (ms < 400) return rec.cancel()
    try {
      const { audio, mime } = await rec.stop()
      const id = await ensureSession()
      if (!id) return dispatch({ type: 'fail', message: 'Pas de connexion au PC.' })
      session.current = id
      const r = await call<{ heard?: string }>('chat.voice', { sessionId: id, audio, mime })
      if (!r) return dispatch({ type: 'fail', message: 'Le PC n’a pas pu prendre le message.' })
      dispatch({ type: 'heard', text: r.heard ?? '' })
    } catch (err) {
      dispatch({ type: 'fail', message: (err as Error).message })
    }
  }

  // The bubble grows with the voice while listening; the other phases animate in CSS.
  const scale = state.phase === 'listening' ? 1 + level * 0.45 : 1

  return (
    <div className="live" role="dialog" aria-label="Conversation en direct">
      <header className="live-top">
        <span>Conversation en direct</span>
        <button type="button" className="icon ghost" aria-label="Fermer" onClick={onClose}>
          ✕
        </button>
      </header>

      <section className="live-text" aria-live="polite">
        {state.heard && <p className="live-heard">« {state.heard} »</p>}
        {state.reply && (
          <div className="live-reply">
            <Markdown text={state.reply} />
          </div>
        )}
      </section>

      <div className="live-stage">
        <button
          type="button"
          className={`orb ${state.phase}`}
          aria-label={PHASE_LABEL[state.phase]}
          style={{ transform: `scale(${scale.toFixed(3)})` }}
          onPointerDown={e => void press(e)}
          onPointerUp={() => void release()}
          onPointerCancel={() => void release()}
          onContextMenu={e => e.preventDefault()}
        >
          <span className="orb-core" />
          <span className="orb-ring" />
          <span className="orb-bars" aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
            <i />
          </span>
        </button>
        <p className="live-phase">{PHASE_LABEL[state.phase]}</p>
        <p className={`live-note ${state.phase === 'error' ? 'danger' : ''}`}>{state.note}</p>
      </div>
    </div>
  )
}
