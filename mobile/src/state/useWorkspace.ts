import { useEffect, useRef, useState } from 'react'
import type { JarodChannel, PushedEvent } from '../lib/channel.ts'
import { applyEvent, type Conversation, fromHistory, type StoredMessage } from '../lib/chat-model.ts'
import { haptic } from '../lib/haptics.ts'
import { vault } from '../lib/native.ts'
import { loadPrefs, loadSeen, mergeNews, type NewsItem, type NotifyPrefs, saveSeen, seenUpTo, type Topic, toNewsItem, unreadCount } from '../lib/news.ts'
import { allowNotifications, notifyLocal } from '../lib/notify.ts'
import type { PairedPc } from '../lib/pairing-store.ts'
import { setNotifyPrefs, setWatch } from '../lib/session.ts'
import { readAloud, readAloudEnabled, stopReading } from '../lib/speech.ts'

export interface SessionRow {
  id: string
  title: string
  updatedAt: number
  running?: boolean
}

export interface Approval {
  id: string
  sessionId: string
  call: { name: string; args: unknown }
  description: string
  expiresAt: number
  /** When the phone first saw it: the start of the countdown ring. */
  seenAt?: number
  /** Where the run started when it was not this phone: the PC's own chat, or a background task. */
  origin?: 'pc' | 'background'
}

/** Adds requests not already shown (a request can arrive both pushed and from `approvals.pending`). */
export const addApprovals = (list: Approval[], more: Approval[]): Approval[] => [
  ...list,
  ...more.filter(m => !list.some(a => a.id === m.id)).map(m => ({ ...m, seenAt: m.seenAt ?? Date.now() }))
]

interface Options {
  pc: PairedPc
  channel: JarodChannel | null
  subscribe: (fn: (e: PushedEvent) => void) => () => void
}

/**
 * Everything the screens share about the PC: its conversations, the one open, the approvals waiting,
 * the news and the notification choices. The protocol calls are the same as ever; only where they
 * live has changed (they used to be one big screen).
 */
export function useWorkspace({ pc, channel, subscribe }: Options) {
  const [sessions, setSessions] = useState<SessionRow[]>([])
  const [conv, setConv] = useState<Conversation | null>(null)
  const [approvals, setApprovals] = useState<Approval[]>([])
  const [error, setError] = useState('')
  const [deciding, setDeciding] = useState('')
  const [prefs, setPrefs] = useState<NotifyPrefs>(loadPrefs)
  const [news, setNews] = useState<NewsItem[]>([])
  const [seenAt, setSeenAt] = useState(loadSeen)
  const sessionRef = useRef<string>('')
  /** The current conversation's last reply, read aloud once its run is done. */
  const lastReply = useRef('')
  const [speak, setSpeak] = useState(readAloudEnabled)
  const speakRef = useRef(speak)
  speakRef.current = speak
  // Live talk reads its own answers aloud: the transcript underneath must not read them a second time.
  const liveRef = useRef(false)
  // Read by the event handler, which is subscribed once.
  const prefsRef = useRef(prefs)
  prefsRef.current = prefs

  /** A notification drawn by the phone, if the owner wants this kind (and the app is not on screen). */
  const tell = (topic: Topic, title: string, body: string) => {
    if (document.hidden && prefsRef.current[topic]) void notifyLocal(title, body)
  }

  const call = async <T,>(method: string, params?: Record<string, unknown>): Promise<T | undefined> => {
    if (!channel) {
      setError('Pas de connexion au PC.')
      return undefined
    }
    try {
      setError('')
      return await channel.rpc<T>(method, params)
    } catch (e) {
      setError((e as Error).message)
      return undefined
    }
  }

  const refreshSessions = async () => {
    const list = await call<SessionRow[]>('sessions.list')
    if (list) setSessions(list)
    return list ?? []
  }

  const openSession = async (id: string) => {
    sessionRef.current = id
    const messages = await call<StoredMessage[]>('messages.list', { sessionId: id })
    if (messages && sessionRef.current === id) setConv(fromHistory(id, messages))
  }

  const newConversation = () => {
    sessionRef.current = ''
    setConv(null)
  }

  // Connected (again): the list, the conversation, and the watch for when the app is closed.
  useEffect(() => {
    if (!channel) return
    void (async () => {
      const list = await refreshSessions()
      const id = sessionRef.current || list[0]?.id
      if (id) await openSession(id)
      // Requests offered while the app was closed (the wake told us something waits). An older PC does not know the method.
      const waiting = await channel.rpc<Approval[]>('approvals.pending').catch(() => [] as Approval[])
      if (waiting.length) setApprovals(a => addApprovals(a, waiting))
      const listed = await channel.rpc<Record<string, unknown>[]>('notifications.list').catch(() => [] as Record<string, unknown>[])
      const items = (Array.isArray(listed) ? listed : []).map(toNewsItem).filter((n): n is NewsItem => n !== null)
      if (items.length) setNews(n => mergeNews(n, items))
      if (pc.watch && (await allowNotifications())) await setWatch(pc, channel, true).catch(() => {})
    })()
    // biome-ignore lint/correctness/useExhaustiveDependencies: on each new channel
  }, [channel])

  useEffect(
    () =>
      subscribe(e => {
        if (e.event === 'agent') {
          setConv(c => (c ? applyEvent(c, e.data) : c))
          if (e.data.sessionId === sessionRef.current) {
            const m = e.data.message as { role?: string; content?: string } | undefined
            if (e.data.type === 'message' && m?.role === 'assistant' && m.content?.trim()) lastReply.current = m.content
            if (e.data.type === 'done' && lastReply.current && speakRef.current && !liveRef.current && !document.hidden) {
              void readAloud(lastReply.current).catch(err => setError((err as Error).message))
            }
            if (e.data.type === 'done') lastReply.current = ''
          }
          if (e.data.type === 'done') tell('task', 'Jarod a répondu', 'Ouvrez l’appli pour lire la réponse.')
        } else if (e.event === 'approval') {
          setApprovals(a => addApprovals(a, [e.data as unknown as Approval]))
          haptic('warn')
          tell('approval', 'Jarod demande votre accord', String((e.data.call as { name?: string })?.name ?? 'Une action'))
        } else if (e.event === 'approval-cancelled') {
          // Answered elsewhere (the PC or another phone), timed out or stopped: the card goes.
          const gone = String(e.data.id ?? '')
          setApprovals(a => a.filter(x => x.id !== gone))
        } else if (e.event === 'notification') {
          const n = toNewsItem(e.data)
          if (!n) return
          setNews(list => mergeNews(list, [n]))
          tell(n.topic, n.title || 'Jarod', n.body)
        }
      }),
    [subscribe]
  )

  // Expired requests go: the PC has refused them by now.
  useEffect(() => {
    if (!approvals.length) return
    const t = setInterval(() => setApprovals(a => (a.some(x => x.expiresAt <= Date.now()) ? a.filter(x => x.expiresAt > Date.now()) : a)), 1000)
    return () => clearInterval(t)
  }, [approvals.length])

  const ensureSession = async (): Promise<string | undefined> => {
    if (conv) return conv.sessionId
    const s = await call<{ id: string; title: string }>('sessions.create')
    if (!s) return undefined
    sessionRef.current = s.id
    setConv({ sessionId: s.id, lines: [], running: false })
    void refreshSessions()
    return s.id
  }

  const renameSession = async (id: string, title: string): Promise<boolean> => {
    if (!(await call('sessions.rename', { sessionId: id, title }))) return false
    await refreshSessions()
    return true
  }

  const deleteSession = async (id: string): Promise<boolean> => {
    if (!(await call('sessions.delete', { sessionId: id }))) return false
    if (sessionRef.current === id) newConversation()
    await refreshSessions()
    return true
  }

  const decide = async (a: Approval, ok: boolean): Promise<void> => {
    setDeciding(a.id)
    try {
      if (ok) {
        // Accepting is a decision of its own: the owner proves they are holding the phone, now.
        const { ok: present } = await vault.confirm({ title: 'Autoriser cette action ?', subtitle: a.call.name })
        if (!present) return
      }
      const taken = await call<boolean>('approval.resolve', { id: a.id, ok })
      haptic(ok ? 'confirm' : 'tap')
      setApprovals(list => list.filter(x => x.id !== a.id))
      if (taken === false) setError('Cette demande a déjà été tranchée ailleurs, ou elle a expiré.')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setDeciding('')
    }
  }

  const choose = async (topic: Topic, on: boolean) => {
    if (on && !(await allowNotifications())) return setError('Notifications refusées : autorisez-les dans les réglages du téléphone.')
    const next = { ...prefs, [topic]: on }
    setPrefs(next)
    await setNotifyPrefs(next)
  }

  /** What arrives while the news is on screen is seen. */
  const markNewsSeen = () =>
    setSeenAt(at => {
      const next = seenUpTo(news, at)
      if (next !== at) saveSeen(next)
      return next
    })

  return {
    subscribe,
    sessions,
    conv,
    setConv,
    approvals,
    error,
    setError,
    deciding,
    prefs,
    news,
    seenAt,
    unread: unreadCount(news, seenAt),
    speak,
    setSpeak,
    liveRef,
    sessionRef,
    call,
    refreshSessions,
    openSession,
    newConversation,
    ensureSession,
    renameSession,
    deleteSession,
    decide,
    choose,
    markNewsSeen
  }
}

export type Workspace = ReturnType<typeof useWorkspace>
