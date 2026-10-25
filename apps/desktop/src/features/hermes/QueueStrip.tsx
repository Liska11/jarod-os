import { useStore } from '@nanostores/react'
import { IconListNumbers, IconPlayerPlay, IconX } from '@tabler/icons-react'
import { t, useT } from '../../lib/i18n.ts'
import { $activeChat, $activeChatId, $queues, clearQueue, removeQueued, resumeQueue } from '../../store/chat.ts'

/*
 * The messages waiting for the agent, above the composer. They leave one by one as each turn ends; after a stopped or failed turn the queue
 * waits (and says so) until the user resumes it or clears it.
 */
export function QueueStrip() {
  useT()
  const sessionId = useStore($activeChatId)
  const queues = useStore($queues)
  const chat = useStore($activeChat)
  const items = sessionId ? (queues[sessionId] ?? []) : []

  if (items.length === 0) {
    return null
  }

  // No turn is running yet messages remain: the queue is paused, not just waiting its turn.
  const paused = !chat?.streaming

  return (
    <div className="glass-card mb-2 rounded-xl px-3 py-2 text-[12.5px]" role="region" aria-label={t('chat.queue.title', { count: items.length })}>
      <div className="flex items-center gap-2 text-fg-3">
        <IconListNumbers size={15} stroke={1.8} />
        <span className="font-medium text-fg-2">{t('chat.queue.title', { count: items.length })}</span>
        {paused ? <span className="truncate text-warn">{t('chat.queue.paused')}</span> : null}
        <span className="flex-1" />
        {paused ? (
          <button type="button" onClick={() => void resumeQueue()} className="flex items-center gap-1 rounded-md px-2 py-0.5 text-accent hover:bg-white/8">
            <IconPlayerPlay size={13} />
            {t('chat.queue.resume')}
          </button>
        ) : null}
        <button type="button" onClick={() => void clearQueue()} className="rounded-md px-2 py-0.5 text-fg-3 hover:bg-white/8 hover:text-fg">
          {t('chat.queue.clear')}
        </button>
      </div>
      <ol className="mt-1.5 flex flex-col gap-1">
        {items.map((item, index) => (
          <li key={item.id} className="flex items-center gap-2 rounded-md bg-white/4 px-2 py-1">
            <span className="w-4 shrink-0 text-right text-fg-4">{index + 1}</span>
            <span className="min-w-0 flex-1 truncate text-fg-2" title={item.text}>
              {item.text}
            </span>
            <button type="button" aria-label={t('chat.queue.remove')} title={t('chat.queue.remove')} onClick={() => void removeQueued(item.id)} className="shrink-0 rounded p-0.5 text-fg-4 hover:bg-white/8 hover:text-fg">
              <IconX size={13} />
            </button>
          </li>
        ))}
      </ol>
    </div>
  )
}
