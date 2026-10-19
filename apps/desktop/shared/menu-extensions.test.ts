import { describe, expect, it } from 'vitest'
import { parseMenuExtensions } from './menu-extensions.ts'

describe('parseMenuExtensions', () => {
  it('reads a command entry under the Jarod-OS key, and under its older key alike (rename, phase 5)', () => {
    const { entries, errors } = parseMenuExtensions({
      entries: [
        { label: 'Notes', 'jarod-os': ['launch', 'obsidian'] },
        { label: 'Old notes', 'herald-os': ['launch', 'obsidian'] }
      ]
    })

    expect(errors).toEqual([])
    expect(entries.map(entry => entry.action)).toEqual([
      { kind: 'herald-os', argv: ['launch', 'obsidian'] },
      { kind: 'herald-os', argv: ['launch', 'obsidian'] }
    ])
  })

  it('an entry naming both command keys is one action too many', () => {
    const { entries, errors } = parseMenuExtensions({ entries: [{ label: 'Twice', 'jarod-os': ['a'], 'herald-os': ['b'] }] })

    expect(entries).toEqual([])
    expect(errors[0]).toMatch(/exactly one of "jarod-os"/)
  })

  it('reads every kind of entry', () => {
    const { entries, errors } = parseMenuExtensions({
      entries: [
        { label: 'Notes', hint: 'Obsidian', icon: 'notes', 'herald-os': ['launch', 'obsidian'] },
        { label: 'Back up photos', group: 'Trigger', exec: ['rsync', '-a', '~/Pictures/', '/mnt/backup/'] },
        { label: 'Standup doc', url: 'https://docs.example.com/standup' },
        { label: 'Missions', command: 'page.open', args: { name: 'missions' } }
      ]
    })
    expect(errors).toEqual([])
    expect(entries.map(entry => entry.action.kind)).toEqual(['herald-os', 'exec', 'url', 'command'])
    expect(entries[0]).toMatchObject({ id: 'yours-1-notes', hint: 'Obsidian', icon: 'notes' })
    expect(entries[1].group).toBe('trigger')
    expect(entries[3].action).toEqual({ kind: 'command', command: 'page.open', args: { name: 'missions' } })
  })

  it('keeps the good entries and explains the bad ones', () => {
    const { entries, errors } = parseMenuExtensions({
      entries: [
        { label: 'Fine', url: 'https://example.com' },
        { label: '', url: 'https://example.com' },
        { label: 'Both', url: 'https://example.com', exec: ['ls'] },
        { label: 'Script', url: 'javascript:alert(1)' },
        { label: 'Shell string', exec: 'rm -rf ~' },
        { label: 'Bad command', command: 'rm -rf' },
        'nope'
      ]
    })
    expect(entries.map(entry => entry.label)).toEqual(['Fine'])
    expect(errors).toHaveLength(6)
    expect(errors.join(' ')).toMatch(/exactly one/)
    expect(errors.join(' ')).toMatch(/list of words/)
  })

  it('accepts a bare list, ignores a missing file and flags the wrong shape', () => {
    expect(parseMenuExtensions([{ label: 'A', url: 'https://a.example' }]).entries).toHaveLength(1)
    expect(parseMenuExtensions(undefined)).toEqual({ entries: [], errors: [] })
    expect(parseMenuExtensions({ items: [] }).errors).toEqual(['menu.json needs an "entries" list'])
  })

  it('names unknown icons and leaves unknown groups to "Yours"', () => {
    const { entries, errors } = parseMenuExtensions({ entries: [{ label: 'A', icon: 'unicorn', group: 'elsewhere', url: 'https://a.example' }] })
    expect(entries[0].icon).toBeUndefined()
    expect(entries[0].group).toBeUndefined()
    expect(errors[0]).toMatch(/unknown icon "unicorn"/)
  })
})
