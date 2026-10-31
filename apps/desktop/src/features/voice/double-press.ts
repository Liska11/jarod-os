/**
 * Tells one press from two quick ones. The single action waits `windowMs` for a second press; a second press inside the window runs the double
 * action instead and the single one never happens. Timers are injectable for the tests.
 *
 * `windowMs` is the default Windows double-click time (500 ms, `GetDoubleClickTime()`): the browser's `event.detail` counts two clicks for
 * that long, so a shorter window let the single action fire first and the double one run on top of it.
 */
export interface DoublePress {
  press(): void
  /** The second press already known to be one (the browser counted two clicks): run the double action and forget a pending single. */
  double(): void
  /** Forget a pending press (the button unmounted). */
  cancel(): void
}

export function createDoublePress(onSingle: () => void, onDouble: () => void, windowMs = 500, timers: { set: typeof setTimeout; clear: typeof clearTimeout } = { set: setTimeout, clear: clearTimeout }): DoublePress {
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
    double() {
      // No pending single: it already ran (the browser keeps counting two clicks for its own, longer, double-click time). Running the
      // double action now would stack a conversation on top of a dictation that just started.
      if (pending === null) return
      timers.clear(pending)
      pending = null
      onDouble()
    },
    cancel() {
      if (pending !== null) {
        timers.clear(pending)
        pending = null
      }
    }
  }
}
