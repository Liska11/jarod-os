import { atom } from 'nanostores'

/** A text to put in the chat box in place of what is there ("Edit" on a sent message): the person changes it and presses Send. */
export const $composerFill = atom<{ id: number; text: string } | null>(null)

let counter = 0

export function fillComposer(text: string): void {
  $composerFill.set({ id: ++counter, text })
}
