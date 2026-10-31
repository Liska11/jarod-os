import type { SessionListRow } from '@jarod-os/client'
import { describe, expect, it } from 'vitest'
import { filterSessions, groupSessions, listedSessions } from './session-list.ts'

const row = (id: string, started_at: number, source?: string, title = id): SessionListRow => ({ id, title, preview: '', started_at, message_count: 1, ...(source ? { source } : {}) }) as SessionListRow

describe('listedSessions', () => {
  const sources = new Set(['desktop', 'cli'])

  it('keeps the sessions of the listed sources (and those with none), newest first', () => {
    const rows = [row('old', 1, 'desktop'), row('cron', 5, 'cron'), row('new', 9, 'cli'), row('bare', 4)]

    expect(listedSessions(rows, sources).map(r => r.id)).toEqual(['new', 'bare', 'old'])
  })

  it('only the last `limit` are kept, and the input is left as it was', () => {
    const rows = [row('a', 1, 'desktop'), row('b', 2, 'desktop'), row('c', 3, 'desktop')]

    expect(listedSessions(rows, sources, 2).map(r => r.id)).toEqual(['c', 'b'])
    expect(rows.map(r => r.id)).toEqual(['a', 'b', 'c'])
  })
})

describe('filterSessions', () => {
  const rows = [row('1', 1, undefined, 'Ouverture Instagram dans le navigateur'), row('2', 2, undefined, 'Liste des applications installées'), row('3', 3, undefined, 'Salut')]

  it('every word must match, without regard to case or accents', () => {
    expect(filterSessions(rows, 'INSTAGRAM navigateur').map(r => r.id)).toEqual(['1'])
    expect(filterSessions(rows, 'installees').map(r => r.id)).toEqual(['2'])
    expect(filterSessions(rows, 'zzz')).toEqual([])
  })

  it('an empty search keeps everything', () => {
    expect(filterSessions(rows, '  ')).toHaveLength(3)
  })
})

describe('groupSessions', () => {
  // 31 Oct 2026, 15:00 local.
  const now = new Date(2026, 9, 31, 15, 0, 0).getTime()
  const at = (daysAgo: number, hour = 12) => new Date(2026, 9, 31 - daysAgo, hour, 0, 0).getTime() / 1000

  it('pinned first, then today, yesterday, the last week and older; empty groups are left out', () => {
    const rows = [row('t', at(0)), row('y', at(1)), row('w', at(4)), row('o', at(20)), row('p', at(30))]
    const groups = groupSessions(rows, new Set(['p']), now)

    expect(groups.map(g => [g.key, g.rows.map(r => r.id)])).toEqual([
      ['pinned', ['p']],
      ['today', ['t']],
      ['yesterday', ['y']],
      ['week', ['w']],
      ['older', ['o']]
    ])
    expect(groupSessions([row('t', at(0))], new Set(), now).map(g => g.key)).toEqual(['today'])
  })

  it('reads milliseconds as well as seconds', () => {
    expect(groupSessions([row('t', at(0) * 1000)], new Set(), now)[0]?.key).toBe('today')
  })
})
