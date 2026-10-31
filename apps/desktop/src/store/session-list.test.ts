import type { SessionListRow } from '@jarod-os/client'
import { describe, expect, it } from 'vitest'
import { listedSessions } from './session-list.ts'

const row = (id: string, started_at: number, source?: string): SessionListRow => ({ id, title: id, preview: '', started_at, message_count: 1, ...(source ? { source } : {}) }) as SessionListRow

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
