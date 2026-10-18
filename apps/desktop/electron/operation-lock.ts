/*
 * One heavy operation on Jarod-OS's data at a time: a backup of the Jarod disk, an external backup, a restore. Two at once would copy a
 * state another is changing, or stop the core under the other's feet.
 */

let holder: string | null = null

/** Takes the lock for `name`; returns its release, or null (with the current holder in `busyWith()`) when another operation runs. */
export function acquireOperation(name: string): (() => void) | null {
  if (holder) return null

  holder = name

  return () => {
    if (holder === name) holder = null
  }
}

export function busyWith(): string | null {
  return holder
}
