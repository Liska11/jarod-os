import { useState } from 'react'
import { Icon } from '../components/icons.tsx'
import { Button, Dialog, IconButton, Spinner, TopBar } from '../components/ui.tsx'
import type { JarodChannel } from '../lib/channel.ts'
import type { SessionRow, Workspace } from '../state/useWorkspace.ts'

interface Props {
  ws: Workspace
  channel: JarodChannel | null
  /** Show this conversation in the chat. */
  onOpen: (id: string) => void
  onNew: () => void
}

const when = (t: number) => new Date(t).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

/** The PC's conversations and the runs in progress: open, rename, delete (after an explicit confirmation). */
export function TasksView({ ws, channel, onOpen, onNew }: Props) {
  const [renaming, setRenaming] = useState<SessionRow | null>(null)
  const [title, setTitle] = useState('')
  const [deleting, setDeleting] = useState<SessionRow | null>(null)
  const [busy, setBusy] = useState(false)
  const running = ws.sessions.filter(s => s.running)
  const others = ws.sessions.filter(s => !s.running)

  const row = (s: SessionRow) => (
    <li key={s.id} className={`task ${s.id === ws.conv?.sessionId ? 'current' : ''}`}>
      <button type="button" className="task-main" onClick={() => onOpen(s.id)}>
        <span className="task-title">{s.title || 'Sans titre'}</span>
        <span className="task-sub">
          {s.running ? (
            <>
              <Spinner label="en cours" /> en cours
            </>
          ) : (
            when(s.updatedAt)
          )}
        </span>
      </button>
      <IconButton
        icon="edit"
        label={`Renommer ${s.title || 'la conversation'}`}
        disabled={!channel}
        onClick={() => {
          setTitle(s.title)
          setRenaming(s)
        }}
      />
      <IconButton icon="trash" label={`Supprimer ${s.title || 'la conversation'}`} disabled={!channel} onClick={() => setDeleting(s)} />
    </li>
  )

  const confirmRename = async () => {
    const next = title.trim()
    if (!renaming || !next || next === renaming.title) return setRenaming(null)
    setBusy(true)
    await ws.renameSession(renaming.id, next)
    setBusy(false)
    setRenaming(null)
  }

  const confirmDelete = async () => {
    if (!deleting) return
    setBusy(true)
    await ws.deleteSession(deleting.id)
    setBusy(false)
    setDeleting(null)
  }

  return (
    <div className="view">
      <TopBar title="Tâches" sub={`${ws.sessions.length} conversation${ws.sessions.length > 1 ? 's' : ''}${running.length ? ` · ${running.length} en cours` : ''}`}>
        <Button tone="tonal" icon="add" disabled={!channel} onClick={onNew} feel="tap">
          Nouvelle
        </Button>
      </TopBar>

      <div className="scroll">
        {!ws.sessions.length && (
          <div className="empty">
            <span className="empty-mark">
              <Icon name="tasks" size={32} />
            </span>
            <h2>Aucune conversation</h2>
            <p>{channel ? 'Écrivez à Jarod : la conversation apparaît ici, avec les tâches qu’il mène.' : 'Pas de connexion au PC : la liste vient quand il répond.'}</p>
          </div>
        )}
        {running.length > 0 && (
          <>
            <h2 className="section-label">En cours</h2>
            <ul className="task-list">{running.map(row)}</ul>
          </>
        )}
        {others.length > 0 && (
          <>
            <h2 className="section-label">{running.length ? 'Les autres' : 'Conversations'}</h2>
            <ul className="task-list">{others.map(row)}</ul>
          </>
        )}
      </div>

      <Dialog
        open={renaming !== null}
        onClose={() => setRenaming(null)}
        title="Renommer la conversation"
        actions={
          <>
            <Button tone="text" onClick={() => setRenaming(null)}>
              Annuler
            </Button>
            <Button tone="filled" disabled={busy || !title.trim()} onClick={() => void confirmRename()}>
              Renommer
            </Button>
          </>
        }
      >
        <input className="text-field" value={title} maxLength={120} aria-label="Nouveau titre" onChange={e => setTitle(e.target.value)} onKeyDown={e => e.key === 'Enter' && void confirmRename()} />
      </Dialog>

      <Dialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title="Supprimer cette conversation ?"
        actions={
          <>
            <Button tone="text" onClick={() => setDeleting(null)}>
              Annuler
            </Button>
            <Button tone="danger" disabled={busy} feel="warn" onClick={() => void confirmDelete()}>
              Supprimer définitivement
            </Button>
          </>
        }
      >
        <p>
          « {deleting?.title || 'Sans titre'} » et ses pièces jointes seront <b>effacées du PC</b>. Cette action est définitive.
        </p>
      </Dialog>
    </div>
  )
}
