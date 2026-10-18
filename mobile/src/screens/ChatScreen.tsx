import { useEffect, useRef, useState } from 'react'
import type { Link } from '../App.tsx'
import { Markdown } from '../components/Markdown.tsx'
import type { JarodChannel, PushedEvent } from '../lib/channel.ts'
import { applyEvent, type Conversation, describeArgs, fromHistory, type StoredMessage } from '../lib/chat-model.ts'
import { vault } from '../lib/native.ts'
import { allowNotifications, notifyLocal } from '../lib/notify.ts'
import type { PairedPc } from '../lib/pairing-store.ts'
import { forget, setWatch } from '../lib/session.ts'
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
  const bottom = useRef<HTMLDivElement>(null)
  const sessionRef = useRef<string>('')

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
      if (pc.watch && (await allowNotifications())) await setWatch(pc, channel, true).catch(() => {})
    })()
    // biome-ignore lint/correctness/useExhaustiveDependencies: on each new channel
  }, [channel])

  useEffect(
    () =>
      subscribe(e => {
        const hidden = document.hidden
        if (e.event === 'agent') {
          setConv(c => (c ? applyEvent(c, e.data) : c))
          if (e.data.type === 'done' && hidden) void notifyLocal('Jarod a répondu', 'Ouvrez l’appli pour lire la réponse.')
        } else if (e.event === 'approval') {
          setApprovals(a => addApprovals(a, [e.data as unknown as Approval]))
          if (hidden) void notifyLocal('Jarod demande votre accord', String((e.data.call as { name?: string })?.name ?? 'Une action'))
        } else if (e.event === 'approval-cancelled') {
          // Answered elsewhere (the PC or another phone), timed out or stopped: the card goes.
          const gone = String(e.data.id ?? '')
          setApprovals(a => a.filter(x => x.id !== gone))
        } else if (e.event === 'notification') {
          if (hidden) void notifyLocal(String(e.data.title ?? 'Jarod'), String(e.data.body ?? ''))
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
        <button type="button" className="icon" aria-label="Réglages" onClick={() => setSettings(s => !s)}>
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
            <button type="button" key={s.id} className={`row ${s.id === conv?.sessionId ? 'active' : ''}`} onClick={() => void openSession(s.id)}>
              <span>{s.title || 'Sans titre'}</span>
              <small>{s.running ? 'en cours' : new Date(s.updatedAt).toLocaleString()}</small>
            </button>
          ))}
        </nav>
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
            {l.role === 'assistant' ? <Markdown text={l.text || '…'} /> : l.role === 'tool' ? <span>⚙ {l.text}</span> : <span>{l.text}</span>}
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

      <footer className="composer">
        <textarea
          rows={1}
          value={text}
          placeholder={recording ? 'Enregistrement…' : 'Message à Jarod'}
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
    </main>
  )
}
