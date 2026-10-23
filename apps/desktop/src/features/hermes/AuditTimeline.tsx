import { IconChevronDown, IconShieldCheck, IconShieldX } from '@tabler/icons-react'
import { memo, useEffect, useState } from 'react'
import { cn } from '../../lib/cn.ts'
import type { ChatState } from '../../lib/chat-model.ts'
import { type MessageKey, useT } from '../../lib/i18n.ts'
import { jarod } from '../../lib/jarod.ts'
import { type AuditLine, type DecisionKind, decisionKind, formatDuration, isRefusal } from './audit-timeline.ts'

/** Wait after the last change before asking the core again: a turn that runs ten tools asks once, not ten times. */
const REFRESH_MS = 300

/**
 * The conversation's audit lines, re-read when a tool call appears and when the turn ends. A backend without the channel (Hermes) answers with an
 * error: the timeline then stays empty and nothing is shown.
 */
export function useAuditLines(chat: ChatState): AuditLine[] {
  const [lines, setLines] = useState<AuditLine[]>([])
  const toolCount = chat.messages.reduce((n, m) => (m.role === 'tool' ? n + 1 : n), 0)

  // biome-ignore lint/correctness/useExhaustiveDependencies: `streaming` and `toolCount` are the triggers (a new call, the end of a turn), not inputs
  useEffect(() => {
    let live = true
    const timer = setTimeout(() => {
      jarod<AuditLine[]>('audit-session', chat.storedSessionId)
        .then(rows => live && setLines(Array.isArray(rows) ? rows : []))
        .catch(() => live && setLines([]))
    }, REFRESH_MS)

    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [chat.storedSessionId, chat.streaming, toolCount])

  return lines
}

const DECISION_KEYS: Record<DecisionKind, MessageKey> = {
  granted: 'chat.audit.decision.granted',
  refused: 'chat.audit.decision.refused',
  automatic: 'chat.audit.decision.automatic',
  plan: 'chat.audit.decision.plan',
  ruleRefused: 'chat.audit.decision.ruleRefused',
  ruleAllowed: 'chat.audit.decision.ruleAllowed',
  free: 'chat.audit.decision.free',
  cancelled: 'chat.audit.decision.cancelled',
  invalid: 'chat.audit.decision.invalid',
  other: 'chat.audit.decision.other'
}

const TIER_KEYS: Record<NonNullable<AuditLine['tier']>, MessageKey> = {
  sensible: 'chat.audit.tier.sensible',
  audité: 'chat.audit.tier.audited',
  ordinaire: 'chat.audit.tier.ordinary'
}

const PROOF_KEYS: Record<NonNullable<AuditLine['proof']>, MessageKey> = {
  verified: 'chat.audit.proof.verified',
  failed: 'chat.audit.proof.failed',
  unverifiable: 'chat.audit.proof.unverifiable'
}

const clock = (ts: number): string => new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })

/** One collapsed row under a turn: how many calls the core journaled, how many it refused; expands into one line per call. */
export const AuditTimeline = memo(function AuditTimeline({ lines }: { lines: AuditLine[] }) {
  const { t, tn } = useT()
  const [open, setOpen] = useState(false)

  if (lines.length === 0) {
    return null
  }

  const refused = lines.filter(line => isRefusal(decisionKind(line.decision))).length
  const failed = lines.filter(line => line.ok === false && !isRefusal(decisionKind(line.decision))).length

  return (
    <div data-testid="audit-timeline" className="rounded-xl border border-line/70">
      <button type="button" aria-expanded={open} aria-label={open ? t('chat.audit.hide') : t('chat.audit.show')} onClick={() => setOpen(v => !v)} className="flex h-9 w-full items-center gap-2.5 rounded-xl px-3 text-left hover:bg-white/4">
        <span className={cn('flex size-5 shrink-0 items-center justify-center', refused ? 'text-warn' : 'text-fg-3')}>
          {refused ? <IconShieldX size={15} stroke={1.7} /> : <IconShieldCheck size={15} stroke={1.7} />}
        </span>
        <span className="min-w-0 flex-1 truncate text-[11.5px] text-fg-3">
          {tn('chat.audit.count', lines.length)}
          {refused > 0 && <span className="text-warn"> · {tn('chat.audit.refusedCount', refused)}</span>}
          {failed > 0 && <span className="text-danger"> · {tn('chat.audit.failedCount', failed)}</span>}
        </span>
        <IconChevronDown size={14} className={cn('shrink-0 text-fg-3 transition-transform duration-150', open && 'rotate-180')} />
      </button>
      {open && (
        <ol className="flex flex-col gap-1 border-t border-line/70 px-3 py-2 animate-fade-in">
          {lines.map((line, index) => (
            <AuditRow key={`${line.at}-${line.callId ?? index}`} line={line} />
          ))}
        </ol>
      )}
    </div>
  )
})

function AuditRow({ line }: { line: AuditLine }) {
  const { t } = useT()
  const kind = decisionKind(line.decision)
  const refusal = isRefusal(kind)
  const detail = line.target ?? (line.args === '{}' ? '' : line.args)

  return (
    <li data-testid="audit-line" data-tool={line.tool} data-decision={kind} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-baseline gap-x-2.5 text-[11.5px]">
      <span className="tabular-nums text-fg-3">{clock(line.at)}</span>
      <span className="min-w-0 truncate" title={detail || undefined}>
        <span className="font-mono text-fg-2">{line.tool}</span>
        {detail && <span className="ml-1.5 text-fg-3">{detail}</span>}
      </span>
      <span className="flex items-center gap-1.5 whitespace-nowrap">
        <span className={cn('rounded-md px-1.5 py-px', refusal ? 'bg-warn/10 text-warn' : kind === 'cancelled' ? 'bg-white/6 text-fg-3' : 'bg-white/6 text-fg-2')}>{t(DECISION_KEYS[kind])}</span>
        {line.ok === false && !refusal && kind !== 'cancelled' && <span className="text-danger">{t('chat.audit.failed')}</span>}
        {line.proof && <span className={line.proof === 'failed' ? 'text-danger' : 'text-fg-3'}>{t(PROOF_KEYS[line.proof])}</span>}
        {line.tier && <span className="text-fg-4">{t(TIER_KEYS[line.tier])}</span>}
        {typeof line.durationMs === 'number' && <span className="tabular-nums text-fg-4">{formatDuration(line.durationMs)}</span>}
      </span>
    </li>
  )
}
