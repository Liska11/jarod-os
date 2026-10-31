import type { SessionListRow } from '@jarod-os/client'

/** The stored sessions this shell lists, newest first (`started_at`), optionally only the last `limit`. */
export function listedSessions(rows: readonly SessionListRow[], sources: ReadonlySet<string>, limit = Infinity): SessionListRow[] {
  return rows
    .filter(row => !row.source || sources.has(row.source))
    .sort((a, b) => (b.started_at ?? 0) - (a.started_at ?? 0))
    .slice(0, limit)
}

const plain = (text: string) => text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()

/** The sessions whose title (or first words) contain every word typed, without regard to case or accents. */
export function filterSessions(rows: readonly SessionListRow[], query: string): SessionListRow[] {
  const words = plain(query).split(/\s+/).filter(Boolean)

  if (words.length === 0) {
    return [...rows]
  }

  return rows.filter(row => {
    const text = plain(`${row.title ?? ''} ${row.preview ?? ''}`)

    return words.every(word => text.includes(word))
  })
}

export type SessionGroupKey = 'pinned' | 'today' | 'yesterday' | 'week' | 'older'

export interface SessionGroup {
  key: SessionGroupKey
  rows: SessionListRow[]
}

const DAY = 86_400_000
const ORDER: SessionGroupKey[] = ['pinned', 'today', 'yesterday', 'week', 'older']

/** `started_at` comes in seconds from the core and in milliseconds from some backends. */
const toMs = (stamp: number | undefined): number => (!stamp ? 0 : stamp < 1e12 ? stamp * 1000 : stamp)

/** Pinned first, then by day (today, yesterday, the last week, older); empty groups are left out and each keeps the order it came in. */
export function groupSessions(rows: readonly SessionListRow[], pinned: ReadonlySet<string>, now = Date.now()): SessionGroup[] {
  const midnight = new Date(now)
  midnight.setHours(0, 0, 0, 0)
  const today = midnight.getTime()
  const buckets: Record<SessionGroupKey, SessionListRow[]> = { pinned: [], today: [], yesterday: [], week: [], older: [] }

  for (const row of rows) {
    const at = toMs(row.started_at)
    const key: SessionGroupKey = pinned.has(row.id) ? 'pinned' : at >= today ? 'today' : at >= today - DAY ? 'yesterday' : at >= today - 6 * DAY ? 'week' : 'older'
    buckets[key].push(row)
  }

  return ORDER.filter(key => buckets[key].length > 0).map(key => ({ key, rows: buckets[key] }))
}
