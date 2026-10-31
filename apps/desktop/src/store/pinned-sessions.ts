import { atom } from 'nanostores'
import { gatewayCall } from './gateway.ts'

const KEY = 'jarod.pinnedSessions'
const MIGRATED_KEY = 'jarod.pinnedSessions.sent'

function load(): Set<string> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]')

    return new Set(Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [])
  } catch {
    return new Set()
  }
}

function save(ids: ReadonlySet<string>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify([...ids]))
  } catch {
    // Private mode or a full quota: the pin holds for this session only.
  }
}

/**
 * Conversations the person pinned to the top of the rail. The core keeps them (a pin follows the conversation to another screen or a
 * new install); this set is what the rail draws, filled from the core's list and changed at once when the person clicks.
 * A copy stays in this computer's storage so the rail is right before the first list arrives.
 */
export const $pinnedSessions = atom<ReadonlySet<string>>(load())

/** Ids whose change is on its way to the core: a list that arrives meanwhile must not undo them. */
const pending = new Set<string>()

const send = (id: string, pinned: boolean): Promise<void> => {
  pending.add(id)

  return gatewayCall('session.pin', { session_id: id, pinned })
    .then(() => undefined)
    .catch(() => undefined) // An older core, or no connection: the pin stays here and the next list says what the core holds.
    .finally(() => void pending.delete(id))
}

/**
 * A fresh session list: when the core reports pins (the field is there) it is the truth. Pins made here before the core could keep them
 * are sent up once, so nobody loses the ones they already had.
 */
export function adoptServerPins(rows: ReadonlyArray<{ id: string; pinned?: boolean }>): void {
  if (!rows.some(row => typeof row.pinned === 'boolean')) {
    return
  }

  const mine = $pinnedSessions.get()
  const next = new Set(rows.filter(row => row.pinned).map(row => row.id))
  const listed = new Set(rows.map(row => row.id))
  let sent = false

  try {
    sent = localStorage.getItem(MIGRATED_KEY) === '1'
  } catch {
    sent = true // No storage to remember it in: do not push the same pins at every list.
  }

  if (!sent) {
    for (const id of mine) {
      if (listed.has(id) && !next.has(id)) {
        next.add(id)
        void send(id, true)
      }
    }

    try {
      localStorage.setItem(MIGRATED_KEY, '1')
    } catch {
      // Nothing to do: see above.
    }
  }

  for (const id of pending) {
    if (mine.has(id)) {
      next.add(id)
    } else {
      next.delete(id)
    }
  }

  $pinnedSessions.set(next)
  save(next)
}

export function togglePinned(id: string): void {
  const next = new Set($pinnedSessions.get())
  const pinned = !next.delete(id)

  if (pinned) {
    next.add(id)
  }

  $pinnedSessions.set(next)
  save(next)
  void send(id, pinned)
}
