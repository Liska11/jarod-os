// Sentence-by-sentence speech when the backend has no streaming voice (the Jarod core answers `/api/audio/speak` only, docs/VOICE.md):
// each sentence is synthesized as soon as it closes in the streaming reply, the next one while the current one plays, so the first words
// are heard long before the reply is finished. `stop()` (barge-in) silences it at once and every synthesis still in flight is dropped
// when it lands: an old reply never starts playing again. `heard()` says what was actually started aloud, for the conversation's context.
import { sanitizeForSpeech, SentenceChunker } from './speech-text.ts'

export type SentenceSpeakerEnd = 'drained' | 'stopped' | 'error'

export interface SentenceSpeakerDeps {
  /** Text → playable audio (a data URL); rejects when synthesis fails. */
  synth: (text: string) => Promise<string>
  /** Plays one piece; resolves when it ends or is stopped. */
  play: (audio: string) => Promise<void>
  /** Silences what `play` is playing now. */
  silence: () => void
}

export interface SentenceSpeakerHandlers {
  onStart?: () => void
  onEnd?: (reason: SentenceSpeakerEnd, error?: string) => void
}

export class SentenceSpeaker {
  private readonly chunker = new SentenceChunker()
  private readonly queue: Array<{ text: string; audio: Promise<string> }> = []
  private playing = false
  private textDone = false
  private stopped = false
  private ended = false
  private started = false
  private readonly spoken: string[] = []

  constructor(
    private readonly deps: SentenceSpeakerDeps,
    private readonly handlers: SentenceSpeakerHandlers = {}
  ) {}

  feed(delta: string): void {
    if (this.stopped || this.textDone) return

    for (const sentence of this.chunker.feed(delta)) this.enqueue(sentence)
  }

  /** The reply is complete: speak what is left, then end. */
  done(): void {
    if (this.stopped || this.textDone) return

    this.textDone = true

    for (const sentence of this.chunker.flush()) this.enqueue(sentence)

    this.pump()
  }

  /** Barge-in or end of conversation: silence now; nothing queued or in flight will play. */
  stop(): void {
    if (this.stopped) return

    this.stopped = true
    this.queue.length = 0
    this.deps.silence()
    this.finish('stopped')
  }

  /** The sentences whose playback started (the person may have heard them, in part for the last one). */
  heard(): string {
    return this.spoken.join(' ')
  }

  get speaking(): boolean {
    return this.playing
  }

  private enqueue(raw: string): void {
    const text = sanitizeForSpeech(raw)

    if (!text) return

    // Synthesis starts now (in parallel with what plays); a failure is kept in the promise and reported when its turn comes.
    const audio = this.deps.synth(text)
    audio.catch(() => undefined)
    this.queue.push({ text, audio })
    this.pump()
  }

  private pump(): void {
    if (this.playing || this.stopped) return

    const next = this.queue.shift()

    if (!next) {
      if (this.textDone) this.finish('drained')

      return
    }

    this.playing = true
    void next.audio
      .then(async audio => {
        if (this.stopped) return

        if (!this.started) {
          this.started = true
          this.handlers.onStart?.()
        }

        this.spoken.push(next.text)
        await this.deps.play(audio)
      })
      .then(
        () => {
          this.playing = false
          this.pump()
        },
        error => {
          this.playing = false

          if (!this.stopped) {
            this.stopped = true
            this.queue.length = 0
            this.finish('error', error instanceof Error ? error.message : String(error))
          }
        }
      )
  }

  private finish(reason: SentenceSpeakerEnd, error?: string): void {
    if (this.ended) return

    this.ended = true
    this.handlers.onEnd?.(reason, error)
  }
}
