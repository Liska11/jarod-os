import { useEffect, useState } from 'react'
import type { Link } from '../App.tsx'
import { ApprovalSheet, useNow } from '../components/ApprovalSheet.tsx'
import { Icon, type IconName } from '../components/icons.tsx'
import { useBackLayer } from '../components/ui.tsx'
import type { JarodChannel, PushedEvent } from '../lib/channel.ts'
import { formatCountdown, secondsLeft } from '../lib/countdown.ts'
import { linkMode } from '../lib/diagnostics.ts'
import { haptic } from '../lib/haptics.ts'
import { badge } from '../lib/news.ts'
import type { PairedPc } from '../lib/pairing-store.ts'
import type { LockDelay } from '../lib/settings.ts'
import { useWorkspace } from '../state/useWorkspace.ts'
import { ChatView } from './ChatView.tsx'
import { NewsView } from './NewsView.tsx'
import { SettingsView, type SettingsPage } from './SettingsView.tsx'
import { TasksView } from './TasksView.tsx'

export type Tab = 'chat' | 'tasks' | 'news' | 'settings'

const TABS: { tab: Tab; label: string; icon: IconName }[] = [
  { tab: 'chat', label: 'Chat', icon: 'chat' },
  { tab: 'tasks', label: 'Tâches', icon: 'tasks' },
  { tab: 'news', label: 'Nouvelles', icon: 'bell' },
  { tab: 'settings', label: 'Réglages', icon: 'settings' }
]

interface Props {
  pc: PairedPc
  channel: JarodChannel | null
  link: Link
  subscribe: (fn: (e: PushedEvent) => void) => () => void
  lockDelay: LockDelay
  onLockDelay: (d: LockDelay) => void
  onLock: () => void
  onPcChanged: (pc: PairedPc) => void
  onForgotten: () => void
}

/** The signed-in app: four tabs on a bottom bar, and the approval sheet over all of them. */
export function Shell({ pc, channel, link, subscribe, lockDelay, onLockDelay, onLock, onPcChanged, onForgotten }: Props) {
  const ws = useWorkspace({ pc, channel, subscribe })
  const [tab, setTab] = useState<Tab>('chat')
  const [page, setPage] = useState<SettingsPage | null>(null)
  // A request the owner put off ("later"): hidden until they open it again from the banner.
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const mode = linkMode(channel?.base, link === 'online')

  // Away from the chat, the back gesture returns to it before leaving the app.
  useBackLayer(tab !== 'chat', () => {
    setTab('chat')
    setPage(null)
  })

  const pick = (next: Tab) => {
    if (next === tab) {
      if (next === 'settings') setPage(null)
      return
    }
    haptic('tap')
    setTab(next)
    if (next !== 'settings') setPage(null)
  }

  const first = ws.approvals[0]
  const shown = first && !hidden.has(first.id) ? first : undefined
  // Requests that are gone from the list are forgotten here too.
  useEffect(() => {
    setHidden(h => {
      const ids = new Set(ws.approvals.map(a => a.id))
      const kept = [...h].filter(id => ids.has(id))
      return kept.length === h.size ? h : new Set(kept)
    })
  }, [ws.approvals])

  const now = useNow(Boolean(first))
  const waitingBanner = first && !shown

  return (
    <div className="app">
      <div className="app-body">
        {waitingBanner && (
          <button
            type="button"
            className="banner"
            onClick={() =>
              setHidden(h => {
                const n = new Set(h)
                n.delete(first.id)
                return n
              })
            }
          >
            <Icon name="hand" size={18} />
            <span>
              {ws.approvals.length > 1 ? `${ws.approvals.length} accords en attente` : 'Un accord en attente'} · {formatCountdown(secondsLeft(first.expiresAt, now))}
            </span>
            <span className="banner-go">Voir</span>
          </button>
        )}
        {/* The chat stays mounted behind the other tabs: a draft, a recording or a live talk are not lost. */}
        <div className={`pane ${tab === 'chat' ? '' : 'off'}`}>
          <ChatView
            ws={ws}
            pc={pc}
            channel={channel}
            link={link}
            mode={mode}
            onDiagnostic={() => {
              setTab('settings')
              setPage('diagnostic')
            }}
          />
        </div>
        {tab === 'tasks' && (
          <TasksView
            ws={ws}
            channel={channel}
            onOpen={id => {
              void ws.openSession(id)
              setTab('chat')
            }}
            onNew={() => {
              ws.newConversation()
              setTab('chat')
            }}
          />
        )}
        {tab === 'news' && <NewsView ws={ws} channel={channel} />}
        {tab === 'settings' && (
          <SettingsView
            page={page}
            onPage={setPage}
            ws={ws}
            pc={pc}
            channel={channel}
            link={link}
            mode={mode}
            lockDelay={lockDelay}
            onLockDelay={onLockDelay}
            onLock={onLock}
            onPcChanged={onPcChanged}
            onForgotten={onForgotten}
          />
        )}
      </div>

      <nav className="tabbar" aria-label="Navigation">
        {TABS.map(t => (
          <button key={t.tab} type="button" className={`tab ${tab === t.tab ? 'on' : ''}`} aria-current={tab === t.tab ? 'page' : undefined} onClick={() => pick(t.tab)}>
            <span className="tab-icon">
              <Icon name={t.icon} size={24} />
              {t.tab === 'news' && ws.unread > 0 && <span className="badge">{badge(ws.unread)}</span>}
              {t.tab === 'chat' && ws.approvals.length > 0 && <span className="badge dot-badge" aria-label="Un accord attend" />}
            </span>
            <span className="tab-label">{t.label}</span>
          </button>
        ))}
      </nav>

      <ApprovalSheet
        approval={shown}
        waiting={Math.max(0, ws.approvals.length - 1)}
        deciding={Boolean(shown && ws.deciding === shown.id)}
        onDecide={(a, ok) => void ws.decide(a, ok)}
        onClose={() => shown && setHidden(h => new Set(h).add(shown.id))}
      />
    </div>
  )
}
