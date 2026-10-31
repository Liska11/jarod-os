import { IconBrain, IconChevronDown } from '@tabler/icons-react'
import { memo, useEffect, useRef, useState } from 'react'
import { EmptyGlass } from '../../components/ui/glass.tsx'
import { cn } from '../../lib/cn.ts'
import type { AssistantMessage, ChatMessage, ChatState, ToolMessage } from '../../lib/chat-model.ts'
import { t, useT } from '../../lib/i18n.ts'
import { ToolRow } from '../chat/ToolRow.tsx'

/*
 * The pane's Activity tab: what the model thought and which tools it used, live, in the order they happened — the reasoning and the tool calls
 * that the conversation keeps out of the way. The newest is at the bottom and the list follows it while the agent works.
 */

/** Only the last stretch is drawn: a long conversation must not make the pane heavy. */
const MAX_ITEMS = 80

export type ActivityItem = { kind: 'reasoning'; message: AssistantMessage } | { kind: 'tool'; message: ToolMessage }

/** The reasoning and tool calls of a conversation, oldest first, capped to the last `max`. */
export function activityItems(messages: readonly ChatMessage[], max = MAX_ITEMS): ActivityItem[] {
  const items: ActivityItem[] = []

  for (const message of messages) {
    if (message.role === 'assistant' && message.reasoning.trim()) {
      items.push({ kind: 'reasoning', message })
    } else if (message.role === 'tool') {
      items.push({ kind: 'tool', message })
    }
  }

  return items.slice(-max)
}

const Reasoning = memo(function Reasoning({ message }: { message: AssistantMessage }) {
  const [open, setOpen] = useState(message.streaming)

  // Open while it is being written; the person's own choice wins afterwards.
  useEffect(() => {
    if (message.streaming) {
      setOpen(true)
    }
  }, [message.streaming])

  return (
    <div className="my-2 rounded-lg border border-line bg-black/10 text-[12.5px]">
      <button type="button" aria-expanded={open} onClick={() => setOpen(v => !v)} className="flex w-full items-center gap-2 px-3 py-2 text-left text-fg-2 hover:text-fg">
        <IconBrain size={14} className={cn('shrink-0', message.streaming && 'animate-pulse text-accent-strong')} />
        <span className="flex-1">{t('pane.activity.reasoning')}</span>
        <IconChevronDown size={13} className={cn('shrink-0 transition-transform', open && 'rotate-180')} aria-hidden="true" />
      </button>
      {open && <div className="selectable max-h-[320px] overflow-y-auto px-3 pb-3 leading-relaxed whitespace-pre-wrap text-fg-3">{message.reasoning}</div>}
    </div>
  )
})

export function ActivityFeed({ chat }: { chat: ChatState | null }) {
  useT()
  const end = useRef<HTMLDivElement>(null)
  const items = activityItems(chat?.messages ?? [])
  const last = items.at(-1)
  const signature = `${items.length}:${last?.kind === 'reasoning' ? last.message.reasoning.length : last?.message.id}`

  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' })
  }, [signature])

  if (items.length === 0) {
    return <EmptyGlass className="h-full" icon={<IconBrain />} title={t('pane.activity.empty')} description={t('pane.activity.empty.hint')} />
  }

  return (
    <div>
      {items.map(item => (item.kind === 'reasoning' ? <Reasoning key={item.message.id} message={item.message} /> : <ToolRow key={item.message.id} tool={item.message} />))}
      <div ref={end} />
    </div>
  )
}
