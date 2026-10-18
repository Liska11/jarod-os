import { describe, expect, it } from 'vitest'
import { anyOn, badge, DEFAULT_PREFS, loadPrefs, loadSeen, mergeNews, type NewsItem, savePrefs, saveSeen, seenUpTo, toNewsItem, unreadCount } from './news.ts'
import type { KeyValue } from './pairing-store.ts'

const memory = (): KeyValue & { data: Map<string, string> } => {
  const data = new Map<string, string>()
  return { data, getItem: k => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: k => void data.delete(k) }
}

const item = (id: string, createdAt: number, more: Partial<NewsItem> = {}): NewsItem => ({
  id,
  kind: 'info',
  topic: 'other',
  title: id,
  body: '',
  createdAt,
  ...more
})

describe('notification choices', () => {
  it('everything on by default, stored on the phone only', () => {
    const s = memory()
    expect(loadPrefs(s)).toEqual(DEFAULT_PREFS)
    savePrefs({ ...DEFAULT_PREFS, reminder: false, other: false }, s)
    expect(loadPrefs(s)).toEqual({ ...DEFAULT_PREFS, reminder: false, other: false })
  })

  it('ignores what it cannot read, keeps what it can', () => {
    const s = memory()
    s.setItem('jarod.notify.v1', '{"alert":false,"task":"no","bogus":true}')
    expect(loadPrefs(s)).toEqual({ ...DEFAULT_PREFS, alert: false })
    s.setItem('jarod.notify.v1', 'not json')
    expect(loadPrefs(s)).toEqual(DEFAULT_PREFS)
  })

  it('the closed-app watch is silenced only when every kind is off', () => {
    expect(anyOn(DEFAULT_PREFS)).toBe(true)
    expect(anyOn({ task: false, reminder: false, alert: false, approval: true, other: false })).toBe(true)
    expect(anyOn({ task: false, reminder: false, alert: false, approval: false, other: false })).toBe(false)
  })
})

describe('Quoi de neuf', () => {
  it('reads the PC’s items, with or without a topic', () => {
    expect(toNewsItem({ id: 'a', kind: 'success', topic: 'task', title: 'Tâche', body: 'ok', createdAt: 5 })).toEqual({
      id: 'a',
      kind: 'success',
      topic: 'task',
      title: 'Tâche',
      body: 'ok',
      createdAt: 5
    })
    // An older PC sends no topic.
    expect(toNewsItem({ id: 'b', kind: 'error', title: 'x', createdAt: 1 })?.topic).toBe('alert')
    expect(toNewsItem({ id: 'c', kind: 'info', title: 'x', createdAt: 1 })?.topic).toBe('other')
    // "approval" is the phone's own: a PC cannot claim it.
    expect(toNewsItem({ id: 'd', kind: 'info', topic: 'approval', title: 'x', createdAt: 1 })?.topic).toBe('other')
    expect(toNewsItem({ kind: 'info', title: 'x' })).toBeNull()
    expect(toNewsItem({ id: 'e', kind: 'weird', title: 'x', createdAt: 1 })?.kind).toBe('info')
  })

  it('merges pushed and listed items once, newest first, capped', () => {
    const list = mergeNews([item('a', 1), item('b', 3)], [item('b', 3), item('c', 2)])
    expect(list.map(n => n.id)).toEqual(['b', 'c', 'a'])
    const many = mergeNews([], Array.from({ length: 70 }, (_, i) => item(`n${i}`, i)))
    expect(many).toHaveLength(50)
    expect(many[0]!.id).toBe('n69')
  })

  it('counts what came after the last look, and the look never goes back', () => {
    const list = [item('a', 10), item('b', 20), item('c', 30)]
    expect(unreadCount(list, 0)).toBe(3)
    expect(unreadCount(list, 20)).toBe(1)
    expect(seenUpTo(list, 0)).toBe(30)
    expect(seenUpTo([], 42)).toBe(42)
    expect(seenUpTo([item('old', 5)], 42)).toBe(42)
    const s = memory()
    expect(loadSeen(s)).toBe(0)
    saveSeen(30, s)
    expect(loadSeen(s)).toBe(30)
  })

  it('badge', () => {
    expect(badge(0)).toBe('')
    expect(badge(3)).toBe('3')
    expect(badge(12)).toBe('9+')
  })
})
