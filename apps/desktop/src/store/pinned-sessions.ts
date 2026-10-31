import { atom } from 'nanostores'

const KEY = 'jarod.pinnedSessions'

function load(): Set<string> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]')

    return new Set(Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [])
  } catch {
    return new Set()
  }
}

/** Conversations the person pinned to the top of the rail. Kept on this computer only: the core has no pin of its own to ask for. */
export const $pinnedSessions = atom<ReadonlySet<string>>(load())

export function togglePinned(id: string): void {
  const next = new Set($pinnedSessions.get())

  if (!next.delete(id)) {
    next.add(id)
  }

  $pinnedSessions.set(next)

  try {
    localStorage.setItem(KEY, JSON.stringify([...next]))
  } catch {
    // Private mode or a full quota: the pin holds for this session only.
  }
}
