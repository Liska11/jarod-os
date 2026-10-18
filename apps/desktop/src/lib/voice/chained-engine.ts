// The free engine: microphone -> endpointed utterance -> `/api/audio/transcribe` -> Hermes turn
// (`surface: voice-live` for spoken-style replies) -> `/api/audio/speak-stream` sentence by
// sentence while the reply streams. Barge-in cuts speech and interrupts the turn.
import { rest } from '../rest.ts'
import { type CaptureFrame, MicrophoneUnavailableError, subscribeMicrophone } from './audio-capture.ts'
import { earcons } from './earcons.ts'
import { type ConversationEngine, describeTurnError, type VoiceHost } from './engine.ts'
import { bytesToBase64, concatInt16, encodeWav } from './pcm.ts'
import { withProviderFallback } from './provider-fallback.ts'
import { playDataUrl, SpeakStream, speakOnce, stopFallbackAudio, synthesize } from './speak-stream.ts'
import { SentenceSpeaker } from './sentence-speaker.ts'
import { recordFalseBargeIn, recordFirstAudio, recordStop } from '../../store/voice-metrics.ts'
import { t } from '../i18n.ts'
import { isNoiseTranscript, isStopPhrase, sanitizeForSpeech } from './speech-text.ts'
import { BARGE_IN_ENDPOINTER, DEFAULT_ENDPOINTER, Endpointer } from './vad.ts'

type Mode = 'idle' | 'listen' | 'monitor'

const PRE_ROLL_MS = 400
const MAX_CONTEXT_EXCHANGES = 6
/** Silence before a stray tone tells the user Hermes is still working. */
const THINKING_TICK_MS = 1800

interface TranscribeResult {
  ok: boolean
  transcript?: string
  provider?: string | null
}

export class ChainedEngine implements ConversationEngine {
  readonly kind = 'chained' as const

  private mode: Mode = 'idle'
  private unsubscribeMic: (() => void) | null = null
  private endpointer = new Endpointer(DEFAULT_ENDPOINTER)
  private preRoll: Int16Array[] = []
  private preRollMs = 0
  private utterance: Int16Array[] = []
  private muted = false
  private stopped = false
  private followUp = false

  private speak: SpeakStream | null = null
  private stopObserving: (() => void) | null = null
  private turnDone = false
  private replyText = ''
  private fallbackText: string | null = null
  private speechEnded = false
  private thinkingTimer: ReturnType<typeof setTimeout> | null = null
  /** `hermes`: what was said aloud (all of it, or up to an interruption); `interrupted`: the person cut it short. */
  private readonly exchanges: Array<{ user: string; hermes: string; interrupted?: boolean }> = []
  /** Sentence-by-sentence speech when the backend has no streaming voice (the Jarod core). */
  private sentences: SentenceSpeaker | null = null
  /** When the person stopped speaking (for the first-audio measure). */
  private utteranceEndAt = 0
  /** The utterance being transcribed came from an interruption (to count interruptions that held no words). */
  private fromBargeIn = false

  constructor(private readonly host: VoiceHost) {}

  async start(): Promise<void> {
    this.stopped = false

    try {
      this.unsubscribeMic = await subscribeMicrophone(frame => this.onFrame(frame))
    } catch (error) {
      throw error instanceof MicrophoneUnavailableError ? error : new Error(`Microphone failed: ${error instanceof Error ? error.message : String(error)}`)
    }

    this.beginListening(false)
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.mode = 'idle'
    this.clearThinkingTimer()
    this.unsubscribeMic?.()
    this.unsubscribeMic = null
    this.speak?.stop()
    this.speak = null
    stopFallbackAudio()
    this.stopObserving?.()
    this.stopObserving = null
  }

  setMuted(muted: boolean): void {
    this.muted = muted

    if (muted) {
      this.utterance = []
      this.preRoll = []
      this.preRollMs = 0
      this.endpointer.reset()
    }
  }

  interrupt(): void {
    if (this.mode === 'monitor' || this.speak || this.sentences) {
      this.bargeIn(false)
    }
  }

  /** Duplex listens while Jarod speaks; classic keeps the mic closed until it is done (the stop button still interrupts). */
  private whileSpeaking(): Mode {
    return this.host.prefs().duplex === false ? 'idle' : 'monitor'
  }

  // ---- listening -------------------------------------------------------------------------------

  private beginListening(followUp: boolean): void {
    if (this.stopped) {
      return
    }

    this.followUp = followUp
    this.mode = 'listen'
    this.utterance = []
    this.endpointer = new Endpointer({
      ...DEFAULT_ENDPOINTER,
      maxWaitMs: followUp ? Math.max(1000, this.host.prefs().followUpSeconds * 1000) : DEFAULT_ENDPOINTER.maxWaitMs
    })
    this.host.setState('listening')

    if (!followUp) {
      earcons.listen()
    }
  }

  private onFrame(frame: CaptureFrame): void {
    if (this.stopped || this.muted) {
      return
    }

    if (this.mode === 'listen') {
      this.onListenFrame(frame)
    } else if (this.mode === 'monitor') {
      this.onMonitorFrame(frame)
    }
  }

  private onListenFrame(frame: CaptureFrame): void {
    const event = this.endpointer.feed(frame.level, frame.ms)

    if (this.endpointer.isSpeaking) {
      this.utterance.push(frame.pcm)
    } else {
      this.preRoll.push(frame.pcm)
      this.preRollMs += frame.ms

      while (this.preRollMs > PRE_ROLL_MS && this.preRoll.length > 1) {
        this.preRollMs -= frame.ms
        this.preRoll.shift()
      }
    }

    if (event === 'speech-start') {
      // Keep the syllable that tripped the detector.
      this.utterance = [...this.preRoll, ...this.utterance]
      this.preRoll = []
      this.preRollMs = 0
    } else if (event === 'speech-end') {
      this.utteranceEndAt = performance.now()
      const pcm = concatInt16(this.utterance)
      this.utterance = []
      this.mode = 'idle'
      void this.handleUtterance(pcm)
    } else if (event === 'timeout') {
      if (this.followUp || this.exchanges.length > 0) {
        this.host.ended('silence')
      } else {
        this.host.ended('silence')
        this.host.notify('Voice', 'Heard nothing; conversation closed.', 'info')
      }
    }
  }

  private onMonitorFrame(frame: CaptureFrame): void {
    const event = this.endpointer.feed(frame.level, frame.ms)
    this.preRoll.push(frame.pcm)
    this.preRollMs += frame.ms

    while (this.preRollMs > PRE_ROLL_MS && this.preRoll.length > 1) {
      this.preRollMs -= frame.ms
      this.preRoll.shift()
    }

    if (event === 'speech-start') {
      this.bargeIn(true)
    }
  }

  /** The user spoke over Hermes (or pressed stop): cut speech, interrupt the turn, listen. */
  private bargeIn(fromSpeech: boolean): void {
    const at = performance.now()
    this.clearThinkingTimer()
    this.speak?.stop()
    this.speak = null
    const heard = this.sentences?.heard() ?? ''
    this.sentences?.stop()
    this.sentences = null
    stopFallbackAudio()
    recordStop(performance.now() - at, fromSpeech)
    // What the person actually heard stays in the context, marked as cut short; what was generated but not said is dropped.
    const last = this.exchanges[this.exchanges.length - 1]

    if (last && !this.turnDone) {
      last.hermes = sanitizeForSpeech(heard).slice(0, 800)
      last.interrupted = true
      // Visible: the caption keeps what was said, marked as cut short.
      this.host.setCaptions({ assistant: `${last.hermes ? `${last.hermes.slice(-300)} ` : ''}— ${t('voiceOrb.interrupted')}` })
    }

    this.fromBargeIn = fromSpeech
    this.stopObserving?.()
    this.stopObserving = null

    if (!this.turnDone) {
      void this.host.interrupt()
    }

    this.turnDone = true
    this.beginListening(true)

    if (fromSpeech) {
      // The barge-in detector already heard speech: carry the utterance over without waiting for
      // the listen detector to confirm it a second time.
      this.endpointer.markSpeaking()
      this.utterance = [...this.preRoll]
      this.preRoll = []
      this.preRollMs = 0
    }
  }

  // ---- utterance -> turn -----------------------------------------------------------------------

  private async handleUtterance(pcm: Int16Array): Promise<void> {
    this.host.setState('transcribing')
    earcons.captured()
    let transcript = ''

    try {
      transcript = await this.transcribe(pcm)
    } catch (error) {
      this.host.notify('Transcription failed', error instanceof Error ? error.message : String(error), 'warn')
      this.beginListening(true)

      return
    }

    if (this.stopped) {
      return
    }

    const fromBargeIn = this.fromBargeIn
    this.fromBargeIn = false

    if (!transcript || isNoiseTranscript(transcript)) {
      // An interruption that held no words: noise, or Jarod's own voice heard through the speakers.
      if (fromBargeIn) recordFalseBargeIn()
      this.beginListening(true)

      return
    }

    if (isStopPhrase(transcript)) {
      this.host.setCaptions({ user: transcript })
      this.host.ended('stop-phrase')

      return
    }

    this.host.setCaptions({ user: transcript, assistant: '' })

    // OS commands ("open missions", "show my memory") run here, instantly and for free.
    this.host.setState('thinking')
    const intent = await this.host.runIntent(transcript)

    if (this.stopped) {
      return
    }

    if (intent.handled) {
      this.exchanges.push({ user: transcript, hermes: intent.spoken })
      this.host.setCaptions({ assistant: intent.spoken })
      this.host.setState('speaking')
      this.mode = this.whileSpeaking()
      this.endpointer = new Endpointer(BARGE_IN_ENDPOINTER)
      const signal = { stopped: false }
      this.speakWithFallback(intent.spoken, signal)
        .catch(() => undefined)
        .finally(() => {
          if (!this.stopped && (this.mode === 'monitor' || this.mode === 'idle')) {
            this.beginListening(true)
          }
        })

      return
    }

    await this.runTurn(transcript)
  }

  private async transcribe(pcm: Int16Array): Promise<string> {
    const wav = encodeWav(pcm)
    const body = { data_url: `data:audio/wav;base64,${bytesToBase64(wav)}`, mime_type: 'audio/wav' }
    const result = await withProviderFallback(
      'stt',
      () => rest.post<TranscribeResult>('/api/audio/transcribe', body),
      (from, to) => this.host.notify('Speech to text switched', `${from ?? 'The configured provider'} is not set up; using the free ${to} provider. Change it in Settings > Voice.`, 'info')
    )

    return (result?.transcript ?? '').trim()
  }

  /** Whole-utterance speech with the same free-provider fallback. */
  private speakWithFallback(text: string, signal: { stopped: boolean }): Promise<void> {
    return withProviderFallback(
      'tts',
      () => speakOnce(text, signal),
      (from, to) => this.host.notify('Text to speech switched', `${from ?? 'The configured provider'} is not set up; using the free ${to} voice. Change it in Settings > Voice.`, 'info')
    )
  }

  private voiceContext(): string | undefined {
    if (this.exchanges.length === 0) {
      return undefined
    }

    return this.exchanges
      .slice(-MAX_CONTEXT_EXCHANGES)
      .flatMap(({ user, hermes, interrupted }) => [`User: ${user}`, hermes ? `Hermes: ${hermes}${interrupted ? ' [interrupted here by the user: the rest was not heard]' : ''}` : interrupted ? 'Hermes: [interrupted by the user before saying anything]' : null])
      .filter((line): line is string => Boolean(line))
      .join('\n')
      .slice(-5000)
  }

  private async runTurn(text: string): Promise<void> {
    this.host.setState('thinking')
    this.turnDone = false
    this.replyText = ''
    this.fallbackText = null
    this.speechEnded = false
    const previous = this.exchanges[this.exchanges.length - 1]
    const interrupted = Boolean(previous && (previous.interrupted || !previous.hermes))
    this.exchanges.push({ user: text, hermes: '' })
    this.sentences = null

    // Open the speech socket before the model answers so the first sentence plays immediately.
    const speak = new SpeakStream({
      onStart: () => {
        this.clearThinkingTimer()

        if (!this.stopped && this.speak === speak) {
          recordFirstAudio(performance.now() - this.utteranceEndAt)
          this.host.setState('speaking')
        }
      },
      onEnd: (reason, error) => {
        if (this.speak !== speak) {
          return
        }

        this.speechEnded = true

        if (reason === 'fallback') {
          // No streaming voice here (the Jarod core): speak sentence by sentence as the reply streams, instead of waiting for all of it.
          this.speechEnded = false
          this.startSentences(speak)

          return
        }

        if (reason === 'error' && error) {
          this.host.notify('Speech unavailable', error, 'warn')
        }

        this.maybeFinishTurn()
      }
    })
    this.speak = speak
    this.mode = this.whileSpeaking()
    this.endpointer = new Endpointer(BARGE_IN_ENDPOINTER)
    this.armThinkingTimer()

    const sessionId = await this.host.submit(text, { voiceContext: this.voiceContext(), interrupted })

    if (this.stopped || this.speak !== speak) {
      return
    }

    if (!sessionId) {
      speak.stop()
      this.beginListening(true)

      return
    }

    this.stopObserving = this.host.observeTurn(sessionId, {
      onDelta: (delta, full) => {
        this.clearThinkingTimer()
        this.replyText = full
        this.host.setCaptions({ assistant: sanitizeForSpeech(full).slice(-400) })

        if (this.sentences) {
          this.sentences.feed(delta)
        } else if (this.fallbackText === null) {
          speak.feed(delta)
        }
      },
      onTool: () => {
        this.armThinkingTimer()
      },
      onComplete: (full, status, error) => {
        this.clearThinkingTimer()
        this.replyText = full || this.replyText
        this.turnDone = true
        const last = this.exchanges[this.exchanges.length - 1]

        if (last) {
          last.hermes = sanitizeForSpeech(this.replyText).slice(0, 800)
        }

        // The backend answered with an error (or the assistant text is itself the error): say what
        // went wrong in plain words and show the real message, instead of a generic failure.
        if (status === 'error' || (!full.trim() && error) || /^Error:/i.test(this.replyText.trim())) {
          const described = describeTurnError(error || this.replyText)
          speak.stop()
          this.sentences?.stop()
          this.sentences = null

          // Sign-in problems surface as the OS sign-in card (opened by the auth store); no second toast.
          if (described.kind !== 'auth') {
            this.host.notify(described.title, described.body, described.fixable ? 'error' : 'warn')
          }

          this.host.setCaptions({ assistant: described.spoken })
          this.host.setState('speaking')
          const signal = { stopped: false }
          this.speakWithFallback(described.spoken, signal)
            .catch(() => undefined)
            .finally(() => {
              if (!this.stopped) {
                // A fixable setup problem will fail every turn; do not sit there listening for one.
                if (described.fixable) {
                  // Already reported above; 'unavailable' ends quietly without a second toast.
                  this.host.ended('unavailable', described.body)
                } else {
                  this.beginListening(true)
                }
              }
            })

          return
        }

        speak.done()
        this.sentences?.done()
        this.maybeFinishTurn()
      }
    })
  }

  /** Sentence-by-sentence speech for this reply (the turn's SpeakStream said the backend has no streaming voice). */
  private startSentences(speak: SpeakStream): void {
    const sentences = new SentenceSpeaker(
      { synth: synthesize, play: playDataUrl, silence: stopFallbackAudio },
      {
        onStart: () => {
          this.clearThinkingTimer()

          if (!this.stopped && this.sentences === sentences) {
            recordFirstAudio(performance.now() - this.utteranceEndAt)
            this.host.setState('speaking')
          }
        },
        onEnd: (reason, error) => {
          if (this.sentences !== sentences || reason === 'stopped') {
            return
          }

          if (reason === 'error' && error) {
            this.host.notify('Speech unavailable', error, 'warn')
          }

          this.speechEnded = true
          this.maybeFinishTurn()
        }
      }
    )
    this.sentences = sentences

    if (this.speak !== speak) {
      return
    }

    // What streamed before the fallback was known.
    if (this.replyText) {
      sentences.feed(this.replyText)
    }

    if (this.turnDone) {
      sentences.done()
    }
  }

  /** Once the turn is complete and speech has drained (or fell back), listen for a follow-up. */
  private maybeFinishTurn(): void {
    if (this.stopped || !this.turnDone || !this.speechEnded) {
      return
    }

    this.speak = null
    this.sentences = null
    this.stopObserving?.()
    this.stopObserving = null

    if (this.fallbackText !== null) {
      const text = sanitizeForSpeech(this.replyText)
      this.fallbackText = null

      if (text) {
        this.host.setState('speaking')
        const signal = { stopped: false }
        this.speakWithFallback(text, signal)
          .catch(error => this.host.notify('Speech unavailable', error instanceof Error ? error.message : String(error), 'warn'))
          .finally(() => {
            if (!this.stopped && this.mode === 'monitor') {
              this.beginListening(true)
            }
          })

        return
      }
    }

    this.beginListening(true)
  }

  private armThinkingTimer(): void {
    this.clearThinkingTimer()
    this.thinkingTimer = setTimeout(() => {
      this.thinkingTimer = null

      if (!this.stopped && !this.turnDone && !this.speak?.speaking) {
        earcons.captured()
      }
    }, THINKING_TICK_MS)
  }

  private clearThinkingTimer(): void {
    if (this.thinkingTimer) {
      clearTimeout(this.thinkingTimer)
      this.thinkingTimer = null
    }
  }
}
