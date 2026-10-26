import { useEffect } from 'react'
import { Icon, type IconName } from '../components/icons.tsx'
import { TopBar } from '../components/ui.tsx'
import type { JarodChannel } from '../lib/channel.ts'
import type { Topic } from '../lib/news.ts'
import type { Workspace } from '../state/useWorkspace.ts'

const TOPIC_ICON: Record<Topic, IconName> = { task: 'check', reminder: 'bell', alert: 'warning', approval: 'hand', other: 'info' }
const TOPIC_NAME: Record<Topic, string> = { task: 'Tâche', reminder: 'Rappel', alert: 'Alerte', approval: 'Accord', other: 'Autre' }

/** "Quoi de neuf": the PC's notifications, read over the encrypted channel. Showing them is what marks them seen. */
export function NewsView({ ws, channel }: { ws: Workspace; channel: JarodChannel | null }) {
  const { news, seenAt, markNewsSeen } = ws
  // Opened, and again whenever something new arrives while it is on screen.
  useEffect(markNewsSeen, [news])

  return (
    <div className="view">
      <TopBar title="Nouvelles" sub="Ce que le PC a à vous dire" />
      <div className="scroll">
        {!news.length && (
          <div className="empty">
            <span className="empty-mark">
              <Icon name="bell" size={32} />
            </span>
            <h2>Rien de neuf</h2>
            <p>{channel ? 'Le PC n’a rien signalé pour l’instant.' : 'Pas de connexion au PC : la liste vient quand il répond.'}</p>
          </div>
        )}
        <ul className="news-list">
          {news.map(n => (
            <li key={n.id} className={`news-card ${n.topic} ${n.createdAt > seenAt ? 'unread' : ''}`}>
              <span className="news-mark">
                <Icon name={TOPIC_ICON[n.topic]} size={20} />
              </span>
              <div className="news-body">
                <div className="news-line">
                  <b>{n.title}</b>
                  {n.createdAt > seenAt && <span className="new-tag">Nouveau</span>}
                </div>
                {n.body && <p>{n.body}</p>}
                <small>
                  {TOPIC_NAME[n.topic]} · {new Date(n.createdAt).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                </small>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
