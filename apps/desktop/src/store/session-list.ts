import type { SessionListRow } from '@jarod-os/client'

/** The stored sessions this shell lists, newest first (`started_at`), optionally only the last `limit`. */
export function listedSessions(rows: readonly SessionListRow[], sources: ReadonlySet<string>, limit = Infinity): SessionListRow[] {
  return rows
    .filter(row => !row.source || sources.has(row.source))
    .sort((a, b) => (b.started_at ?? 0) - (a.started_at ?? 0))
    .slice(0, limit)
}
