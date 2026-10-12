import { describe, expect, it } from 'vitest'
import { disabledAfterToggle, filterRegistry, filterSkills, type InstalledSkill, installOutcome, isInstalled, matchesQuery, type RegistryItem, summaryOfSkills, wasCancelled } from './skills-model.ts'

const skill = (id: string, over: Partial<InstalledSkill> = {}): InstalledSkill => ({ id, name: id, category: '', description: '', path: `C:\\skills\\${id}`, enabled: true, ...over })

describe('matchesQuery', () => {
  it('needs every word, in any field, any case; empty matches all', () => {
    expect(matchesQuery('', 'x')).toBe(true)
    expect(matchesQuery('git hub', 'GitHub helper')).toBe(true)
    expect(matchesQuery('git helper', 'GitHub', 'a helper')).toBe(true)
    expect(matchesQuery('git zzz', 'GitHub helper')).toBe(false)
    expect(matchesQuery('x', undefined)).toBe(false)
  })
})

describe('installed skills', () => {
  const list = [skill('b', { enabled: false }), skill('c', { category: 'notes', description: 'Take notes' }), skill('a')]

  it('lists enabled skills first, then by name; the search covers name, description and category', () => {
    expect(filterSkills(list, '').map(s => s.id)).toEqual(['a', 'c', 'b'])
    expect(filterSkills(list, 'notes').map(s => s.id)).toEqual(['c'])
    expect(filterSkills(list, 'take').map(s => s.id)).toEqual(['c'])
    expect(filterSkills(list, 'nothing')).toEqual([])
  })

  it('switching a skill off or on rewrites the whole disabled list, sorted, without duplicates', () => {
    expect(disabledAfterToggle(list, 'a', false)).toEqual(['a', 'b'])
    expect(disabledAfterToggle(list, 'b', true)).toEqual([])
    expect(disabledAfterToggle(list, 'b', false)).toEqual(['b'])
    expect(disabledAfterToggle([], 'x', false)).toEqual(['x'])
  })

  it('says how many are installed and how many are off', () => {
    expect(summaryOfSkills(list)).toBe('3 installed, 1 switched off')
    expect(summaryOfSkills([skill('a')])).toBe('1 installed')
    expect(summaryOfSkills([])).toBe('0 installed')
  })
})

describe('registry', () => {
  const item = (id: string, over: Partial<RegistryItem> = {}): RegistryItem => ({ id, name: id, description: '', ...over })
  const installed = { skills: ['notes', 'Calendar'], mcps: ['fs'], workflows: [] }

  it('an item is installed when its id or name is listed (skills, MCP servers); agents never', () => {
    expect(isInstalled('skills', item('notes'), installed)).toBe(true)
    expect(isInstalled('skills', item('cal', { name: 'Calendar' }), installed)).toBe(true)
    expect(isInstalled('skills', item('other'), installed)).toBe(false)
    expect(isInstalled('mcps', item('fs'), installed)).toBe(true)
    expect(isInstalled('mcps', item('notes'), installed)).toBe(false)
    expect(isInstalled('agents', item('notes'), installed)).toBe(false)
    expect(isInstalled('skills', item('notes'), null)).toBe(false)
  })

  it('filters by words over name, description, author, category and tags; not installed first', () => {
    const items = [item('zed', { tags: ['writing'] }), item('notes', { description: 'Apple notes' }), item('apple-mail', { author: 'Ann' })]

    expect(filterRegistry('skills', items, '', installed).map(i => i.id)).toEqual(['apple-mail', 'zed', 'notes'])
    expect(filterRegistry('skills', items, 'apple', installed).map(i => i.id)).toEqual(['apple-mail', 'notes'])
    expect(filterRegistry('skills', items, 'writing', installed).map(i => i.id)).toEqual(['zed'])
    expect(filterRegistry('skills', items, 'ann', installed).map(i => i.id)).toEqual(['apple-mail'])
  })
})

describe('install outcome', () => {
  it('reads the engine’s { success, error } answer; a cancelled confirmation is recognised', () => {
    expect(installOutcome({ success: true })).toEqual({ ok: true, text: 'Installed.' })
    expect(installOutcome({ success: false, error: 'Installation annulée.' })).toEqual({ ok: false, text: 'Installation annulée.' })
    expect(installOutcome(null)).toEqual({ ok: false, text: 'Install failed.' })
    expect(wasCancelled('Installation annulée.')).toBe(true)
    expect(wasCancelled('Une skill « a » existe déjà')).toBe(false)
  })
})
