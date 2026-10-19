type KeyValueStorage = Pick<Storage, 'length' | 'key' | 'getItem' | 'setItem' | 'removeItem'>

/** The prefix the shell saves its local settings under since the Jarod-OS rename (docs/RENAME-PLAN-JAROD-OS.md, phase 5). */
export const STORAGE_PREFIX = 'jarod-os.'

/**
 * Older prefixes, newest first. `herald-os.` is COPIED and kept, so an earlier version still finds its settings; `hermes-os.` (from
 * before the Herald OS name) is moved, as it always was. Either way a value already saved under the current prefix wins.
 */
const OLDER: ReadonlyArray<{ prefix: string; keep: boolean }> = [
  { prefix: 'herald-os.', keep: true },
  { prefix: 'hermes-os.', keep: false }
]

/** Carries shell settings saved under an older prefix over to the current one; returns how many keys were carried. */
export function migrateLegacyStorage(storage: KeyValueStorage): number {
  let carried = 0

  for (const { prefix, keep } of OLDER) {
    const keys: string[] = []

    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index)

      if (key?.startsWith(prefix)) {
        keys.push(key)
      }
    }

    for (const key of keys) {
      const next = STORAGE_PREFIX + key.slice(prefix.length)

      if (storage.getItem(next) === null) {
        storage.setItem(next, storage.getItem(key) ?? '')
        carried++
      } else if (!keep) {
        carried++ // Moved before, or already there: the older key goes all the same.
      }

      if (!keep) {
        storage.removeItem(key)
      }
    }
  }

  return carried
}

// Imported first by main.tsx: stores read their saved state while their modules load.
if (typeof window !== 'undefined' && window.localStorage) {
  migrateLegacyStorage(window.localStorage)
}
