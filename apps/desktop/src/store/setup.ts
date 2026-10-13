import { atom } from 'nanostores'

/** The setup wizard was asked for on demand (command `setup.open`), after first run: shown again over the desktop. */
export const $setupRequested = atom(false)

export function openSetup(): void {
  $setupRequested.set(true)
}
