import { useEffect, useRef, useState } from 'react'
import { Icon } from '../components/icons.tsx'
import { LiveTalk } from '../components/LiveTalk.tsx'
import { Markdown } from '../components/Markdown.tsx'
import { ToolGroup } from '../components/ToolGroup.tsx'
import { Button, IconButton, Sheet, StatusChip, TopBar } from '../components/ui.tsx'
import type { JarodChannel } from '../lib/channel.ts'
import { groupLines } from '../lib/chat-model.ts'
import { MODE_LABEL, type LinkMode } from '../lib/diagnostics.ts'
import { ACCEPT, formatSize, prepare } from '../lib/files.ts'
import { haptic } from '../lib/haptics.ts'
import type { PairedPc } from '../lib/pairing-store.ts'
import { stopReading } from '../lib/speech.ts'
import { type Recording, startRecording } from '../lib/voice.ts'
import type { Link } from '../App.tsx'
import type { Workspace } from '../state/useWorkspace.ts'

interface Props {
  ws: Workspace
  pc: PairedPc
  channel: JarodChannel | null
  link: Link
  mode: LinkMode
  onDiagnostic: () => void
}

const LINK_LABEL: Record<Link, string> = { online: 'Connecté', connecting: 'Connexion…', offline: 'Hors ligne' }

export function ChatView({ ws, pc, channel, link, mode, onDiagnostic }: Props) {
  const { conv, sessions, call, ensureSession, setConv, error, setError } = ws
  const [text, setText] = useState('')
  const [heard, setHeard] = useState('')
  const [recording, setRecording] = useState<Recording | null>(null)
  const [sending, setSending] = useState('')
  const [attach, setAttach] = useState(false)
  const [live, setLive] = useState(false)
  const bottom = useRef<HTMLDivElement>(null)
  const field = useRef<HTMLTextAreaElement>(null)
  const photoInput = useRef<HTMLInputElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  ws.liveRef.current = live

  useEffect(() => {
    // Braces: recent WebViews return a promise from scrollIntoView, and an effect must not.
    void bottom.current?.scrollIntoView({ block: 'end' })
  }, [conv?.lines.length, conv?.lines.at(-1)?.text])

  // The field grows with what is typed, up to a few lines.
  // biome-ignore lint/correctness/useExhaustiveDependencies: measured after each change of the text
  useEffect(() => {
    const f = field.current
    if (!f) return
    // Empty: the natural one-line height (a hidden tab measures nothing, and the first paint is early).
    f.style.height = ''
    if (text) f.style.height = `${Math.min(f.scrollHeight, 140)}px`
  }, [text])

  const send = async () => {
    const t = text.trim()
    if (!t) return
    haptic('tap')
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

  const current = sessions.find(s => s.id === conv?.sessionId)
  const busy = Boolean(sending || recording)
  const blocks = conv ? groupLines(conv.lines) : []
  const tone = link === 'online' ? 'ok' : link === 'connecting' ? 'warn' : 'off'
  const note = error || heard

  return (
    <div className="view chat">
      <TopBar
        title={current?.title || 'Nouvelle conversation'}
        sub={
          <StatusChip tone={tone} onClick={onDiagnostic}>
            {pc.name} · {link === 'online' ? MODE_LABEL[mode] : LINK_LABEL[link]}
          </StatusChip>
        }
      >
        <Button tone="tonal" icon="live" className="live-open" disabled={!channel} onClick={() => setLive(true)} feel="tap">
          Live
        </Button>
      </TopBar>

      <section className="lines" aria-live="polite">
        {!conv && (
          <div className="empty">
            <span className="empty-mark">
              <Icon name="chat" size={32} />
            </span>
            <h2>Écrivez ou parlez à Jarod</h2>
            <p>Votre PC fait le travail ; cette appli lui sert de télécommande, chiffrée de bout en bout.</p>
          </div>
        )}
        {blocks.map(b =>
          b.kind === 'tools' ? (
            <ToolGroup key={b.id} calls={b.calls} running={Boolean(conv?.running) && b === blocks.at(-1)} />
          ) : (
            <div key={b.line.id} className={`bubble ${b.line.role}`}>
              {b.line.files?.map(f => (
                <span key={`${f.name}:${f.size}`} className="file">
                  <Icon name={f.mime.startsWith('image/') ? 'camera' : 'attach'} size={16} />
                  {f.name} · {formatSize(f.size)}
                </span>
              ))}
              {b.line.role === 'assistant' ? (
                b.line.text ? (
                  <Markdown text={b.line.text} />
                ) : (
                  <span className="typing" role="status" aria-label="Jarod écrit">
                    <i />
                    <i />
                    <i />
                  </span>
                )
              ) : b.line.text ? (
                <span>{b.line.text}</span>
              ) : null}
            </div>
          )
        )}
        <div ref={bottom} />
      </section>

      {note && (
        <p className={`snack ${error ? 'danger' : ''}`} role={error ? 'alert' : 'status'}>
          <span>{note}</span>
          {error && <IconButton icon="close" label="Fermer le message" onClick={() => setError('')} />}
        </p>
      )}

      <footer className="composer">
        <input ref={photoInput} type="file" accept="image/*" capture="environment" hidden onChange={e => void sendFile(e.target.files?.[0]).finally(() => (e.target.value = ''))} />
        <input ref={fileInput} type="file" accept={ACCEPT} hidden onChange={e => void sendFile(e.target.files?.[0]).finally(() => (e.target.value = ''))} />
        <div className="composer-pill">
          <IconButton icon="add" label="Joindre une photo ou un fichier" disabled={!channel || busy} onClick={() => setAttach(true)} />
          <textarea
            ref={field}
            rows={1}
            value={text}
            placeholder={recording ? 'Enregistrement…' : sending ? `Envoi de ${sending}…` : 'Message à Jarod'}
            aria-label="Message à Jarod"
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
            <IconButton icon="stop" label="Arrêter" tone="filled" feel="warn" onClick={() => void call('chat.stop', { sessionId: conv.sessionId })} />
          ) : text.trim() ? (
            <IconButton icon="send" label="Envoyer" tone="filled" disabled={!channel} onClick={() => void send()} />
          ) : (
            <IconButton icon="mic" label={recording ? 'Envoyer le message vocal' : 'Message vocal'} tone={recording ? 'danger' : 'standard'} feel="tap" disabled={!channel} onClick={() => void toggleVoice()} />
          )}
        </div>
      </footer>

      <Sheet open={attach} onClose={() => setAttach(false)} title="Joindre">
        <div className="attach-grid">
          <button
            type="button"
            className="attach-choice"
            onClick={() => {
              setAttach(false)
              photoInput.current?.click()
            }}
          >
            <Icon name="camera" size={28} />
            Prendre une photo
          </button>
          <button
            type="button"
            className="attach-choice"
            onClick={() => {
              setAttach(false)
              fileInput.current?.click()
            }}
          >
            <Icon name="attach" size={28} />
            Choisir un fichier
          </button>
        </div>
      </Sheet>

      {live && (
        <LiveTalk
          ensureSession={ensureSession}
          call={call}
          subscribe={ws.subscribe}
          onClose={() => {
            setLive(false)
            void ws.refreshSessions()
          }}
        />
      )}
    </div>
  )
}
