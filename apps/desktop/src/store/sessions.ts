import type { SessionListRow } from '@jarod-os/client'
import { atom } from 'nanostores'
import { gatewayCall, gatewayRequest, isGatewayOpen } from './gateway.ts'
import { adoptServerPins } from './pinned-sessions.ts'

export const $sessions = atom<SessionListRow[]>([])
export const $sessionsLoading = atom(false)
/** The last refresh failed: the list shown may be out of date or empty for that reason, which the rail says. */
export const $sessionsError = atom(false)

/** stored id -> runtime id, so the sidebar can highlight the live chat. */
export const $runtimeIds = atom<Record<string, string>>({})

export function rememberRuntimeId(storedId: string, runtimeId: string): void {
  $runtimeIds.set({ ...$runtimeIds.get(), [storedId]: runtimeId })
}

let inflight: Promise<void> | null = null

export function refreshSessions(): Promise<void> {
  if (!isGatewayOpen()) {
    return Promise.resolve()
  }

  if (inflight) {
    return inflight
  }

  $sessionsLoading.set(true)
  inflight = gatewayRequest('session.list', { limit: 60 })
    .then(result => {
      // Merge, don't clobber: keep rows we know about that a truncated list dropped.
      const incoming = result.sessions ?? []
      const seen = new Set(incoming.map(row => row.id))
      const kept = $sessions.get().filter(row => !seen.has(row.id))
      const merged = [...incoming, ...kept].sort((a, b) => (b.started_at ?? 0) - (a.started_at ?? 0))
      $sessions.set(merged)
      $sessionsError.set(false)
      // The core also says which conversations are pinned (an older one does not).
      adoptServerPins(incoming as ReadonlyArray<{ id: string; pinned?: boolean }>)
    })
    .catch(() => {
      // Keep the cached list; the next refresh retries (and the rail offers a retry).
      $sessionsError.set(true)
    })
    .finally(() => {
      $sessionsLoading.set(false)
      inflight = null
    })

  return inflight
}

export async function deleteSession(storedId: string): Promise<void> {
  await gatewayRequest('session.delete', { session_id: storedId })
  $sessions.set($sessions.get().filter(row => row.id !== storedId))
}

/** Gives a conversation the title the person chose: the core keeps it, then the list shown follows. Resolves with the title as kept. */
export async function renameSession(storedId: string, title: string): Promise<string> {
  const result = await gatewayCall<{ title?: string }>('session.rename', { session_id: storedId, title })
  const kept = result?.title ?? title.trim()
  $sessions.set($sessions.get().map(row => (row.id === storedId ? { ...row, title: kept } : row)))

  return kept
}
