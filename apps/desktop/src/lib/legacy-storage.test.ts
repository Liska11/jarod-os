import { describe, expect, it } from 'vitest'
import { migrateLegacyStorage, STORAGE_PREFIX } from './legacy-storage.ts'

function memoryStorage(entries: Record<string, string>) {
  const data = new Map(Object.entries(entries))

  return {
    data,
    get length() {
      return data.size
    },
    key: (index: number) => [...data.keys()][index] ?? null,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key)
  }
}

describe('migrateLegacyStorage', () => {
  it('saves the shell settings under the Jarod-OS prefix (rename, phase 5)', () => {
    expect(STORAGE_PREFIX).toBe('jarod-os.')
  })

  it('moves hermes-os. keys to the current prefix and leaves other keys alone', () => {
    const storage = memoryStorage({ 'hermes-os.panels': '{"today":true}', 'hermes-os.a11y.text-size': 'large', other: '1' })

    expect(migrateLegacyStorage(storage)).toBe(2)
    expect(Object.fromEntries(storage.data)).toEqual({ other: '1', 'jarod-os.panels': '{"today":true}', 'jarod-os.a11y.text-size': 'large' })
  })

  it('COPIES herald-os. keys to the current prefix and keeps them, for an earlier version', () => {
    const storage = memoryStorage({ 'herald-os.panels': '{"today":true}', 'herald-os.notify.approvals': 'false' })

    expect(migrateLegacyStorage(storage)).toBe(2)
    expect(Object.fromEntries(storage.data)).toEqual({
      'herald-os.panels': '{"today":true}',
      'herald-os.notify.approvals': 'false',
      'jarod-os.panels': '{"today":true}',
      'jarod-os.notify.approvals': 'false'
    })
  })

  it('keeps a value already saved under the new name, whatever the older one says', () => {
    const storage = memoryStorage({ 'hermes-os.panels': 'oldest', 'herald-os.a11y.text-size': 'old', 'jarod-os.panels': 'new', 'jarod-os.a11y.text-size': 'new' })

    migrateLegacyStorage(storage)

    expect(storage.data.get('jarod-os.panels')).toBe('new')
    expect(storage.data.get('jarod-os.a11y.text-size')).toBe('new')
  })

  it('copies once: a herald-os. value changed later by an earlier version does not overwrite the Jarod-OS one', () => {
    const storage = memoryStorage({ 'herald-os.panels': 'first' })

    migrateLegacyStorage(storage)
    storage.setItem('herald-os.panels', 'changed by an earlier version')
    migrateLegacyStorage(storage)

    expect(storage.data.get('jarod-os.panels')).toBe('first')
  })

  it('copies the one key saved with a colon (the recent emojis) to the current prefix too', () => {
    const storage = memoryStorage({ 'herald-os:emoji-recent': '["🙂"]' })

    expect(migrateLegacyStorage(storage)).toBe(1)
    expect(storage.data.get('jarod-os.emoji-recent')).toBe('["🙂"]')
    expect(storage.data.get('herald-os:emoji-recent')).toBe('["🙂"]')
  })

  it('does nothing when there is nothing older', () => {
    expect(migrateLegacyStorage(memoryStorage({ 'jarod-os.panels': 'x' }))).toBe(0)
  })
})
