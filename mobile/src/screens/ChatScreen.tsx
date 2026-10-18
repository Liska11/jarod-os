import { useEffect, useRef, useState } from 'react'
import type { Link } from '../App.tsx'
import { LiveTalk } from '../components/LiveTalk.tsx'
import { Markdown } from '../components/Markdown.tsx'
import type { JarodChannel, PushedEvent } from '../lib/channel.ts'
import { applyEvent, type Conversation, describeArgs, fromHistory, type StoredMessage } from '../lib/chat-model.ts'
import { ACCEPT, formatSize, prepare } from '../lib/files.ts'
import { vault } from '../lib/native.ts'
import { badge, loadPrefs, loadSeen, mergeNews, type NewsItem, type NotifyPrefs, saveSeen, seenUpTo, TOPICS, type Topic, toNewsItem, unreadCount } from '../lib/news.ts'
import { allowNotifications, notifyLocal } from '../lib/notify.ts'
import type { PairedPc } from '../lib/pairing-store.ts'
import { forget, setNotifyPrefs, setWatch } from '../lib/session.ts'
import { readAloud, readAloudEnabled, setReadAloud, speechStatus, stopReading } from '../lib/speech.ts'
import { type Recording, startRecording } from '../lib/voice.ts'

interface SessionRow {
  id: string
  title: string
  updatedAt: number
  running?: boolean
}

interface Approval {
  id: string
  sessionId: string
  call: { name: string; args: unknown }
  description: string
  expiresAt: number
  /** Where the run started when it was not this phone: the PC's own chat, or a background task. */
  origin?: 'pc' | 'background'
}

const ORIGIN_LABEL: Record<string, string> = { pc: 'Demandé depuis le PC', background: 'Demandé par une tâche en arrière-plan' }

/** Adds requests not already shown (a request can arrive both pushed and from `approvals.pending`). */
const addApprovals = (list: Approval[], more: Approval[]): Approval[] => [...list, ...more.filter(m => !list.some(a => a.id === m.id))]

interface Props {
  pc: PairedPc
  channel: JarodChannel | null
  link: Link
  subscribe: (fn: (e: PushedEvent) => void) => () => void
  onLock: () => void
  onPcChanged: (pc: PairedPc) => void
  onForgotten: () => void
}

const LINK_LABEL: Record<Link, string> = { online: 'connecté', connecting: 'connexion…', offline: 'hors ligne' }

const TOPIC_MARK: Record<Topic, string> = { task: '✓', reminder: '⏰', alert: '⚠', approval: '✋', other: '•' }

export function ChatScreen({ pc, channel, link, subscribe, onLock, onPcChanged, onForgotten }: Props) {
  const [sessions, setSessions] = useState<SessionRow[]>([])
  const [conv, setConv] = useState<Conversation | null>(null)
  const [approvals, setApprovals] = useState<Approval[]>([])
  const [text, setText] = useState('')
  const [drawer, setDrawer] = useState(false)
  const [settings, setSettings] = useState(false)
  const [error, setError] = useState('')
  const [heard, setHeard] = useState('')
  const [recording, setRecording] = useState<Recording | null>(null)
  const [deciding, setDeciding] = useState('')
  const [speak, setSpeak] = useState(readAloudEnabled)
  const [sending, setSending] = useState('')
  const bottom = useRef<HTMLDivElement>(null)
  const sessionRef = useRef<string>('')
  const photoInput = useRef<HTMLInputElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  /** The current conversation's last reply, read aloud once its run is done. */
  const lastReply = useRef('')
  const speakRef = useRef(speak)
  speakRef.current = speak
  // Live talk reads its own answers aloud: the transcript underneath must not read them a second time.
  const [live, setLive] = useState(false)
  const liveRef = useRef(live)
  liveRef.current = live
  const [prefs, setPrefs] = useState<NotifyPrefs>(loadPrefs)
  const [news, setNews] = useState<NewsItem[]>([])
  const [seenAt, setSeenAt] = useState(loadSeen)
  const [newsOpen, setNewsOpen] = useState(false)
  // Read by the event handler, which is subscribed once.
  const prefsRef = useRef(prefs)
  prefsRef.current = prefs

  /** A notification drawn by the phone, if the owner wants this kind (and the app is not on screen). */
  const tell = (topic: Topic, title: string, body: string) => {
    if (document.hidden && prefsRef.current[topic]) void notifyLocal(title, body)
  }

  // While "Quoi de neuf" is open, what arrives is seen.
  useEffect(() => {
    if (!newsOpen) return
    setSeenAt(at => {
      const next = seenUpTo(news, at)
      if (next !== at) saveSeen(next)
      return next
    })
  }, [newsOpen, news])

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
    setDrawer(false)
    const messages = await call<StoredMessage[]>('messages.list', { sessionId: id })
    if (messages && sessionRef.current === id) setConv(fromHistory(id, messages))
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
    const t = setInterval(() => setApprovals(a => a.filter(x => x.expiresAt > Date.now())), 5000)
    return () => clearInterval(t)
  }, [approvals.length])

  useEffect(() => {
    // Braces: recent WebViews return a promise from scrollIntoView, and an effect must not.
    void bottom.current?.scrollIntoView({ block: 'end' })
  }, [conv?.lines.length, conv?.lines.at(-1)?.text])

  const ensureSession = async (): Promise<string | undefined> => {
    if (conv) return conv.sessionId
    const s = await call<{ id: string; title: string }>('sessions.create')
    if (!s) return undefined
    sessionRef.current = s.id
    setConv({ sessionId: s.id, lines: [], running: false })
    void refreshSessions()
    return s.id
  }

  const send = async () => {
    const t = text.trim()
    if (!t) return
    const id = await ensureSession()
    if (!id) return
    setText('')
    setHeard('')
    void stopReading()
    setConv(c => (c ? { ...c, running: true } : c))
    const r = await call<{ kind: string; text?: string }>('chat.send', { sessionId: id, text: t })
    if (r?.kind === 'command' && r.text) setConv(c => (c ? { ...c, running: false, lines: [...c.lines, { id: `cmd:${Date.now()}`, role: 'assistant', text: r.text! }] } : c))
  }

  const toggleVoice = async () => {
    if (recording) {
      setRecording(null)
      try {
        const { audio, mime } = await recording.stop()
        const id = await ensureSession()
        if (!id) return
        setHeard('Transcription sur le PC…')
        const r = await call<{ kind: string; heard?: string }>('chat.voice', { sessionId: id, audio, mime })
        setHeard(r ? (r.heard ? `Entendu : « ${r.heard} »` : 'Rien entendu.') : '')
      } catch (e) {
        setError((e as Error).message)
      }
      return
    }
    try {
      const rec = await startRecording(() => void toggleVoice())
      setRecording(rec)
    } catch {
      setError('Micro indisponible : autorisez-le dans les réglages du téléphone.')
    }
  }

  /** A photo or file, with what is in the composer as its caption. */
  const sendFile = async (file: File | undefined) => {
    if (!file) return
    setSending(file.name || 'photo')
    try {
      const out = await prepare(file)
      const id = await ensureSession()
      if (!id) return
      const caption = text.trim()
      setText('')
      setHeard('')
      void stopReading()
      setConv(c => (c ? { ...c, running: true } : c))
      const r = await call<{ kind: string }>('chat.file', { sessionId: id, name: out.name, mime: out.mime, data: out.data, text: caption })
      if (r?.kind === 'busy') setError('Jarod est encore occupé : réessayez quand il aura fini.')
      if (!r || r.kind === 'busy') setConv(c => (c ? { ...c, running: false } : c))
      else setHeard(`Envoyé : ${out.name} (${formatSize(out.size)})`)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSending('')
    }
  }

  const renameSession = async (s: SessionRow) => {
    const title = window.prompt('Nouveau titre de la conversation', s.title)?.trim()
    if (!title || title === s.title) return
    if (await call('sessions.rename', { sessionId: s.id, title })) await refreshSessions()
  }

  const deleteSession = async (s: SessionRow) => {
    if (!window.confirm(`Supprimer « ${s.title || 'Sans titre'} » ? La conversation et ses pièces jointes seront effacées du PC.`)) return
    if (!(await call('sessions.delete', { sessionId: s.id }))) return
    if (sessionRef.current === s.id) {
      sessionRef.current = ''
      setConv(null)
    }
    await refreshSessions()
  }

  const decide = async (a: Approval, ok: boolean) => {
    setDeciding(a.id)
    try {
      if (ok) {
        // Accepting is a decision of its own: the owner proves they are holding the phone, now.
        const { ok: present } = await vault.confirm({ title: 'Autoriser cette action ?', subtitle: a.call.name })
        if (!present) return
      }
      const taken = await call<boolean>('approval.resolve', { id: a.id, ok })
      setApprovals(list => list.filter(x => x.id !== a.id))
      if (taken === false) setError('Cette demande a déjà été tranchée ailleurs, ou elle a expiré.')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setDeciding('')
    }
  }

  const current = sessions.find(s => s.id === conv?.sessionId)
  const unread = unreadCount(news, seenAt)

  const choose = async (topic: Topic, on: boolean) => {
    if (on && !(await allowNotifications())) return setError('Notifications refusées : autorisez-les dans les réglages du téléphone.')
    const next = { ...prefs, [topic]: on }
    setPrefs(next)
    await setNotifyPrefs(next)
  }

  return (
    <main className="chat">
      <header className="bar">
        <button type="button" className="icon" aria-label="Conversations" onClick={() => setDrawer(d => !d)}>
          ☰
        </button>
        <div className="title">
          <b>{current?.title || 'Nouvelle conversation'}</b>
          <span className={`dot ${link}`}>
            {pc.name} · {LINK_LABEL[link]}
          </span>
        </div>
        <button
          type="button"
          className="icon news-button"
          aria-label={unread ? `Quoi de neuf, ${unread} non lues` : 'Quoi de neuf'}
          onClick={() => {
            setNewsOpen(o => !o)
            setDrawer(false)
            setSettings(false)
          }}
        >
          🔔{unread > 0 && <span className="badge">{badge(unread)}</span>}
        </button>
        <button
          type="button"
          className="icon"
          aria-label="Réglages"
          onClick={() => {
            setSettings(s => !s)
            setNewsOpen(false)
          }}
        >
          ⚙
        </button>
      </header>

      {drawer && (
        <nav className="sheet">
          <button
            type="button"
            className="primary wide"
            onClick={() => {
              sessionRef.current = ''
              setConv(null)
              setDrawer(false)
            }}
          >
            Nouvelle conversation
          </button>
          {sessions.map(s => (
            <div key={s.id} className={`session ${s.id === conv?.sessionId ? 'active' : ''}`}>
              <button type="button" className="row" onClick={() => void openSession(s.id)}>
                <span>{s.title || 'Sans titre'}</span>
                <small>{s.running ? 'en cours' : new Date(s.updatedAt).toLocaleString()}</small>
              </button>
              <button type="button" className="icon ghost" aria-label={`Renommer ${s.title}`} disabled={!channel} onClick={() => void renameSession(s)}>
                ✎
              </button>
              <button type="button" className="icon ghost" aria-label={`Supprimer ${s.title}`} disabled={!channel} onClick={() => void deleteSession(s)}>
                🗑
              </button>
            </div>
          ))}
        </nav>
      )}

      {newsOpen && (
        <section className="sheet news" aria-label="Quoi de neuf">
          <h2>Quoi de neuf</h2>
          {!news.length && <p className="muted">{channel ? 'Rien de neuf sur le PC.' : 'Pas de connexion au PC : la liste vient quand il répond.'}</p>}
          {news.map(n => (
            <article key={n.id} className={`news-item ${n.topic} ${n.createdAt > seenAt ? 'unread' : ''}`}>
              <span className="mark" aria-hidden="true">
                {TOPIC_MARK[n.topic]}
              </span>
              <div>
                <b>{n.title}</b>
                {n.body && <p>{n.body}</p>}
                <small>{new Date(n.createdAt).toLocaleString()}</small>
              </div>
            </article>
          ))}
        </section>
      )}

      {settings && (
        <section className="sheet">
          <label className="switch">
            <input
              type="checkbox"
              checked={pc.watch}
              onChange={async e => {
                const on = e.target.checked
                if (on && !(await allowNotifications())) return setError('Notifications refusées : autorisez-les dans les réglages du téléphone.')
                await setWatch(pc, channel, on).catch(err => setError((err as Error).message))
                onPcChanged({ ...pc, watch: on })
              }}
            />
            <span>
              Veille quand l’appli est fermée
              <small>Le téléphone demande au PC « du nouveau ? », sans jamais recevoir le contenu. Notification permanente « Jarod veille ».</small>
            </span>
          </label>
          <label className="switch">
            <input
              type="checkbox"
              checked={speak}
              onChange={async e => {
                const on = e.target.checked
                if (on) {
                  const st = await speechStatus()
                  if (!st.available) return setError(st.reason ?? 'Lecture à voix haute indisponible sur ce téléphone.')
                } else void stopReading()
                setReadAloud(on)
                setSpeak(on)
              }}
            />
            <span>
              Lire les réponses à voix haute
              <small>Avec la synthèse vocale du téléphone et ses voix installées : rien ne part sur Internet.</small>
            </span>
          </label>
          <h2>Notifications</h2>
          <p className="fine">Choix gardés sur ce téléphone. Appli fermée, la veille ne sait pas de quoi il s’agit : elle se tait seulement si tout est décoché.</p>
          {TOPICS.map(t => (
            <label key={t.topic} className="switch">
              <input type="checkbox" checked={prefs[t.topic]} onChange={e => void choose(t.topic, e.target.checked)} />
              <span>
                {t.label}
                <small>{t.hint}</small>
              </span>
            </label>
          ))}
          <button type="button" className="ghost wide" onClick={onLock}>
            Verrouiller
          </button>
          <button
            type="button"
            className="danger wide"
            onClick={async () => {
              if (!window.confirm(`Oublier ${pc.name} ? Le PC retirera ce téléphone de sa liste.`)) return
              await forget(channel)
              onForgotten()
            }}
          >
            Oublier ce PC
          </button>
        </section>
      )}

      <section className="lines">
        {!conv && <p className="muted center-text">Écrivez ou parlez à Jarod.</p>}
        {conv?.lines.map(l => (
          <div key={l.id} className={`line ${l.role}`}>
            {l.files?.map(f => (
              <span key={`${f.name}:${f.size}`} className="file">
                {f.mime.startsWith('image/') ? '🖼' : '📎'} {f.name} · {formatSize(f.size)}
              </span>
            ))}
            {l.role === 'assistant' ? <Markdown text={l.text || '…'} /> : l.role === 'tool' ? <span>⚙ {l.text}</span> : l.text ? <span>{l.text}</span> : null}
          </div>
        ))}
        {approvals.map(a => (
          <article key={a.id} className="approval">
            <h2>Jarod demande votre accord</h2>
            {a.origin && <p className="fine">{ORIGIN_LABEL[a.origin] ?? ''}</p>}
            <p>{a.description}</p>
            <p className="tool">{a.call.name}</p>
            <pre>{describeArgs(a.call.args)}</pre>
            <p className="fine">Une décision pour cette action seulement. Sans réponse avant {new Date(a.expiresAt).toLocaleTimeString()}, c’est refusé.</p>
            <div className="actions">
              <button type="button" className="ghost" disabled={deciding === a.id} onClick={() => void decide(a, false)}>
                Refuser
              </button>
              <button type="button" className="primary" disabled={deciding === a.id} onClick={() => void decide(a, true)}>
                Autoriser
              </button>
            </div>
          </article>
        ))}
        <div ref={bottom} />
      </section>

      {(error || heard) && <p className={`note ${error ? 'danger' : ''} slim`}>{error || heard}</p>}

      <div className="live-launch">
        <button type="button" className="live-open" aria-label="Conversation en direct" disabled={!channel} onClick={() => setLive(true)}>
          <span className="live-dot" aria-hidden="true" />
          Live
        </button>
      </div>
      <footer className="composer">
        <input ref={photoInput} type="file" accept="image/*" capture="environment" hidden onChange={e => void sendFile(e.target.files?.[0]).finally(() => (e.target.value = ''))} />
        <input ref={fileInput} type="file" accept={ACCEPT} hidden onChange={e => void sendFile(e.target.files?.[0]).finally(() => (e.target.value = ''))} />
        <button type="button" className="icon ghost" aria-label="Prendre une photo" disabled={!channel || Boolean(sending || recording)} onClick={() => photoInput.current?.click()}>
          📷
        </button>
        <button type="button" className="icon ghost" aria-label="Joindre un fichier" disabled={!channel || Boolean(sending || recording)} onClick={() => fileInput.current?.click()}>
          📎
        </button>
        <textarea
          rows={1}
          value={text}
          placeholder={recording ? 'Enregistrement…' : sending ? `Envoi de ${sending}…` : 'Message à Jarod'}
          disabled={Boolean(recording)}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void send()
            }
          }}
        />
        {conv?.running ? (
          <button type="button" className="icon" aria-label="Arrêter" onClick={() => void call('chat.stop', { sessionId: conv.sessionId })}>
            ■
          </button>
        ) : text.trim() ? (
          <button type="button" className="icon primary" aria-label="Envoyer" disabled={!channel} onClick={() => void send()}>
            ➤
          </button>
        ) : (
          <button type="button" className={`icon ${recording ? 'rec' : ''}`} aria-label={recording ? 'Envoyer le message vocal' : 'Message vocal'} disabled={!channel} onClick={() => void toggleVoice()}>
            {recording ? '●' : '🎤'}
          </button>
        )}
      </footer>
      {live && (
        <LiveTalk
          ensureSession={ensureSession}
          call={call}
          subscribe={subscribe}
          onClose={() => {
            setLive(false)
            void refreshSessions()
          }}
        />
      )}
    </main>
  )
}
