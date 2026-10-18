import type { KeyValue } from './pairing-store.ts'

/**
 * What a piece of news is about. The PC sorts its notifications (`notificationTopic` in
 * remote-host.ts) and says so inside the encrypted channel; approvals and the end of a run started
 * here are known by the phone itself. The wake channel never carries any of it.
 */
export type Topic = 'task' | 'reminder' | 'alert' | 'approval' | 'other'

export const TOPICS: { topic: Topic; label: string; hint: string }[] = [
  { topic: 'task', label: 'Tâches terminées', hint: 'Tâches planifiées, déclencheurs, réponses de Jarod' },
  { topic: 'reminder', label: 'Rappels', hint: 'Ce que vous avez demandé à Jarod de vous rappeler' },
  { topic: 'alert', label: 'Alertes', hint: 'Échecs, erreurs, avertissements' },
  { topic: 'approval', label: 'Demandes d’accord', hint: 'Une action attend votre décision' },
  { topic: 'other', label: 'Autres nouvelles', hint: 'Skills apprises, mises à jour, appareils' }
]

/** Which kinds may draw a notification on this phone. Stored here only: the PC never learns it. */
export type NotifyPrefs = Record<Topic, boolean>

export const DEFAULT_PREFS: NotifyPrefs = { task: true, reminder: true, alert: true, approval: true, other: true }

const PREFS_KEY = 'jarod.notify.v1'
const SEEN_KEY = 'jarod.news.seen'
/** The "Quoi de neuf" list keeps this many, newest first (the PC lists 50). */
export const MAX_NEWS = 50

export function loadPrefs(store: KeyValue = localStorage): NotifyPrefs {
  try {
    const raw = JSON.parse(store.getItem(PREFS_KEY) ?? 'null') as Record<string, unknown> | null
    if (!raw || typeof raw !== 'object') return { ...DEFAULT_PREFS }
    const out = { ...DEFAULT_PREFS }
    for (const t of Object.keys(out) as Topic[]) if (typeof raw[t] === 'boolean') out[t] = raw[t] as boolean
    return out
  } catch {
    return { ...DEFAULT_PREFS }
  }
}

export function savePrefs(prefs: NotifyPrefs, store: KeyValue = localStorage): void {
  store.setItem(PREFS_KEY, JSON.stringify(prefs))
}

/**
 * Whether the closed-app watch should show anything at all. It cannot tell kinds apart (the wake is a
 * bare counter), so it follows the choices only when every kind is off.
 */
export const anyOn = (prefs: NotifyPrefs): boolean => Object.values(prefs).some(Boolean)

/** One entry of `notifications.list`, or one pushed `notification` event. */
export interface NewsItem {
  id: string
  kind: 'info' | 'success' | 'warning' | 'error'
  topic: Topic
  title: string
  body: string
  createdAt: number
}

const KINDS = new Set(['info', 'success', 'warning', 'error'])
const PC_TOPICS = new Set<Topic>(['task', 'reminder', 'alert', 'other'])

/**
 * Reads one item as the PC sent it. An older PC sends no topic: a failure or a warning is then an
 * alert, the rest "other". Null when it is not a notification at all.
 */
export function toNewsItem(raw: Record<string, unknown>): NewsItem | null {
  if (typeof raw.id !== 'string' || !raw.id || typeof raw.title !== 'string') return null
  const kind = (KINDS.has(String(raw.kind)) ? raw.kind : 'info') as NewsItem['kind']
  const topic: Topic = PC_TOPICS.has(raw.topic as Topic) ? (raw.topic as Topic) : kind === 'error' || kind === 'warning' ? 'alert' : 'other'
  const createdAt = typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now()
  return { id: raw.id, kind, topic, title: raw.title, body: typeof raw.body === 'string' ? raw.body : '', createdAt }
}

/** Adds items not already there (the same one can come pushed and listed), newest first, capped. */
export function mergeNews(list: NewsItem[], more: NewsItem[]): NewsItem[] {
  const byId = new Map(list.map(n => [n.id, n]))
  for (const n of more) byId.set(n.id, n)
  return [...byId.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX_NEWS)
}

/** How many items arrived after the newest one the owner has seen. */
export const unreadCount = (list: NewsItem[], seenAt: number): number => list.filter(n => n.createdAt > seenAt).length

/** What to remember once the list has been looked at: the newest item's time (never going back). */
export const seenUpTo = (list: NewsItem[], seenAt: number): number => Math.max(seenAt, ...list.map(n => n.createdAt))

export function loadSeen(store: KeyValue = localStorage): number {
  const v = Number(store.getItem(SEEN_KEY) ?? 0)
  return Number.isFinite(v) && v > 0 ? v : 0
}

export function saveSeen(seenAt: number, store: KeyValue = localStorage): void {
  store.setItem(SEEN_KEY, String(seenAt))
}

/** Badge text: nothing at zero, "9+" beyond nine. */
export const badge = (n: number): string => (n <= 0 ? '' : n > 9 ? '9+' : String(n))
