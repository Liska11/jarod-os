/**
 * Tells one press from two quick ones. The single action waits `windowMs` for a second press; a second press inside the window runs the double
 * action instead and the single one never happens. Timers are injectable for the tests.
 */
export interface DoublePress {
  press(): void
  /** Forget a pending press (the button unmounted). */
  cancel(): void
}

export function createDoublePress(onSingle: () => void, onDouble: () => void, windowMs = 320, timers: { set: typeof setTimeout; clear: typeof clearTimeout } = { set: setTimeout, clear: clearTimeout }): DoublePress {
  let pending: ReturnType<typeof setTimeout> | null = null

  return {
    press() {
      if (pending !== null) {
        timers.clear(pending)
        pending = null
        onDouble()

        return
      }

      pending = timers.set(() => {
        pending = null
        onSingle()
      }, windowMs)
    },
    cancel() {
      if (pending !== null) {
        timers.clear(pending)
        pending = null
      }
    }
  }
}
