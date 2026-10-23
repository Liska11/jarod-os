import { IconChevronDown, IconShieldCheck, IconShieldX } from '@tabler/icons-react'
import { memo, useEffect, useState } from 'react'
import { cn } from '../../lib/cn.ts'
import type { ChatState } from '../../lib/chat-model.ts'
import { type MessageKey, useT } from '../../lib/i18n.ts'
import { jarod } from '../../lib/jarod.ts'
import { type AuditLine, type DecisionKind, decisionKind, type FileChange, formatDuration, isRefusal, turnSummary } from './audit-timeline.ts'

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

const STATUS_KEYS: Record<FileChange['status'], MessageKey> = {
  created: 'chat.audit.file.created',
  modified: 'chat.audit.file.modified',
  deleted: 'chat.audit.file.deleted',
  unchanged: 'chat.audit.file.unchanged'
}

const clock = (ts: number): string => new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })

/**
 * Under each turn: a result card (calls, files written, commands, refusals, failures, total time) that expands into one line per call — with what
 * its verification observed — and, V-08, the files the turn changed with their diff (from the core's checkpoints, loaded when opened).
 */
export const AuditTimeline = memo(function AuditTimeline({ lines }: { lines: AuditLine[] }) {
  const { t, tn } = useT()
  const [open, setOpen] = useState(false)

  if (lines.length === 0) {
    return null
  }

  const summary = turnSummary(lines)

  return (
    <div data-testid="audit-timeline" className="rounded-xl border border-line/70">
      <button type="button" aria-expanded={open} aria-label={open ? t('chat.audit.hide') : t('chat.audit.show')} onClick={() => setOpen(v => !v)} className="flex h-9 w-full items-center gap-2.5 rounded-xl px-3 text-left hover:bg-white/4">
        <span className={cn('flex size-5 shrink-0 items-center justify-center', summary.refused ? 'text-warn' : 'text-fg-3')}>
          {summary.refused ? <IconShieldX size={15} stroke={1.7} /> : <IconShieldCheck size={15} stroke={1.7} />}
        </span>
        <span data-testid="audit-summary" className="min-w-0 flex-1 truncate text-[11.5px] text-fg-3">
          {tn('chat.audit.count', summary.calls)}
          {summary.files > 0 && <span className="text-fg-2"> · {tn('chat.audit.filesCount', summary.files)}</span>}
          {summary.commands > 0 && <span> · {tn('chat.audit.commandsCount', summary.commands)}</span>}
          {summary.refused > 0 && <span className="text-warn"> · {tn('chat.audit.refusedCount', summary.refused)}</span>}
          {summary.failed > 0 && <span className="text-danger"> · {tn('chat.audit.failedCount', summary.failed)}</span>}
          {summary.durationMs > 0 && <span className="tabular-nums text-fg-4"> · {formatDuration(summary.durationMs)}</span>}
        </span>
        <IconChevronDown size={14} className={cn('shrink-0 text-fg-3 transition-transform duration-150', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="flex flex-col gap-2 border-t border-line/70 px-3 py-2 animate-fade-in">
          <ol className="flex flex-col gap-1">
            {lines.map((line, index) => (
              <AuditRow key={`${line.at}-${line.callId ?? index}`} line={line} />
            ))}
          </ol>
          {summary.diffCallId && <TurnChanges sessionId={lines[0]!.sessionId} callId={summary.diffCallId} />}
        </div>
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
      {line.evidence && (
        <span data-testid="audit-evidence" className={cn('col-start-2 col-end-4 min-w-0 truncate text-[11px]', line.proof === 'failed' ? 'text-danger' : 'text-fg-4')} title={line.evidence}>
          {line.evidence}
        </span>
      )}
    </li>
  )
}

/** V-08 — the files this turn changed (write_file, edit_file), asked of the core once, when the turn is opened. */
function TurnChanges({ sessionId, callId }: { sessionId: string; callId: string }) {
  const { t } = useT()
  const [files, setFiles] = useState<FileChange[] | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    let live = true
    jarod<{ files: FileChange[] }>('audit-turn-changes', sessionId, callId)
      .then(result => live && setFiles(Array.isArray(result?.files) ? result.files : []))
      .catch(() => live && setError(true))

    return () => {
      live = false
    }
  }, [sessionId, callId])

  if (error) {
    return null
  }

  return (
    <section data-testid="audit-changes" className="flex flex-col gap-1 border-t border-line/50 pt-2">
      <span className="text-[11px] font-medium text-fg-3">{t('chat.audit.changes')}</span>
      {files === null && <span className="text-[11px] text-fg-4">{t('chat.audit.changes.loading')}</span>}
      {files?.length === 0 && <span className="text-[11px] text-fg-4">{t('chat.audit.changes.none')}</span>}
      {files?.map(file => (
        <FileDiff key={file.path} file={file} />
      ))}
      {files && files.length > 0 && <span className="text-[10.5px] text-fg-4">{t('chat.audit.changes.untracked')}</span>}
    </section>
  )
}

function FileDiff({ file }: { file: FileChange }) {
  const { t } = useT()
  const [open, setOpen] = useState(false)
  const hasDiff = Boolean(file.hunks?.length)

  return (
    <div data-testid="audit-file" data-path={file.path} data-status={file.status} className="text-[11.5px]">
      <button type="button" disabled={!hasDiff} aria-expanded={open} onClick={() => setOpen(v => !v)} className={cn('flex w-full items-center gap-2 rounded-md px-1 py-0.5 text-left', hasDiff && 'hover:bg-white/4')}>
        <span className="min-w-0 flex-1 truncate font-mono text-fg-2" title={file.path}>
          {file.path}
        </span>
        <span className="text-fg-4">{t(STATUS_KEYS[file.status])}</span>
        {file.added > 0 && <span className="tabular-nums text-ok">+{file.added}</span>}
        {file.removed > 0 && <span className="tabular-nums text-danger">−{file.removed}</span>}
        {file.note && <span className="text-fg-4">{file.note}</span>}
        {hasDiff && <IconChevronDown size={12} className={cn('shrink-0 text-fg-3 transition-transform duration-150', open && 'rotate-180')} />}
      </button>
      {open && file.hunks && (
        <pre data-testid="audit-diff" className="selectable mt-1 max-h-[320px] overflow-auto rounded-lg border border-line/60 bg-black/25 p-2 font-mono text-[11px] leading-relaxed">
          {file.hunks.map((hunk, h) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the hunks of one diff never reorder
            <span key={h} className="block border-b border-line/40 pb-1 mb-1 last:mb-0 last:border-b-0 last:pb-0">
              {hunk.map((line, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: the lines of one hunk never reorder
                <span key={i} className={cn('block whitespace-pre', line.kind === 'add' ? 'bg-ok/10 text-ok' : line.kind === 'del' ? 'bg-danger/10 text-danger' : 'text-fg-3')}>
                  {line.kind === 'add' ? '+ ' : line.kind === 'del' ? '− ' : '  '}
                  {line.text}
                </span>
              ))}
            </span>
          ))}
        </pre>
      )}
    </div>
  )
}
