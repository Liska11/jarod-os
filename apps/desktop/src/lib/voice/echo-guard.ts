/*
 * Echo detection for duplex mode (docs/VOICE.md, "Echo"). An interruption detected while Jarod speaks, after which the transcription holds no
 * words, is almost always Jarod's own voice coming back through the speakers. One can be a cough or a door; several in a short stretch are the
 * echo. The guard trips once: the caller then switches to classic mode for the rest of the app run and says so. It never trips again in the same
 * run, whatever the user chooses afterwards, so the user is never asked twice.
 */

export interface EchoGuardOptions {
  /** Empty interruptions within `windowMs` that trip the guard. */
  threshold: number
  windowMs: number
}

/**
 * Three empty interruptions within a minute. A reply lasts 5 to 20 s and an echo cuts it within the first seconds, so a real echo reaches three
 * in well under a minute; noise rarely produces three barge-ins strong enough for the barge-in detector in that time. Two would switch on a
 * single cough plus one stray noise.
 */
export const ECHO_GUARD: EchoGuardOptions = { threshold: 3, windowMs: 60_000 }

export class EchoGuard {
  private times: number[] = []
  private trippedOnce = false

  constructor(private readonly options: EchoGuardOptions = ECHO_GUARD) {}

  /** An interruption whose transcript held no words, at `now` (ms). True exactly once: when it is the one that trips the guard. */
  emptyBargeIn(now: number): boolean {
    if (this.trippedOnce) {
      return false
    }

    this.times = [...this.times.filter(at => now - at < this.options.windowMs), now]

    if (this.times.length < this.options.threshold) {
      return false
    }

    this.trippedOnce = true
    this.times = []

    return true
  }

  /**
   * An interruption that held real words: the barge-ins are the person speaking, so the count starts over. Only an interruption resets it: after
   * an echo the person repeats their request (real words, but not a barge-in), and counting that as proof would hide every echo.
   */
  heardBargeIn(): void {
    this.times = []
  }

  get tripped(): boolean {
    return this.trippedOnce
  }

  /** Empty interruptions counted in the current window (for tests and the settings line). */
  get pending(): number {
    return this.times.length
  }
}
