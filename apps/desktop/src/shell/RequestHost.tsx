import { useStore } from '@nanostores/react'
import type { ApprovalChoice, ApprovalRequestParams, ClarifyRequestParams } from '@jarod-os/client'
import { IconKey, IconLock, IconQuestionMark, IconShieldCheck } from '@tabler/icons-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '../components/ui/button.tsx'
import { Badge } from '../components/ui/primitives.tsx'
import { type MessageKey, t, useT } from '../lib/i18n.ts'
import { thisDevice } from '../lib/platform-labels.ts'
import { takeRequestFocus } from '../lib/request-focus.ts'
import { $pendingRequests, type PendingRequest, resolveRequest } from '../store/requests.ts'

/**
 * One host for every server->client question. Cards stack bottom-right; the oldest is on top so
 * the agent thread that has waited longest unblocks first. Gestures never grant approval.
 *
 * V-20 (upstream #172): no answer is ever focused. A card that arrives while someone types left "Allow once" focused, so a
 * stray Enter approved; and the next card reused the previous one (no key), focused button included, so a second Enter answered
 * it unseen. Each request now has its own card, which takes the focus itself (never an answer) only when nothing is being typed.
 */
export function RequestHost() {
  const pending = useStore($pendingRequests)
  const { tn } = useT()

  if (pending.length === 0) {
    return null
  }

  const [current, ...rest] = pending

  return (
    <div className="pointer-events-none absolute right-5 bottom-[92px] z-(--z-request) flex w-[420px] flex-col items-stretch gap-2">
      {rest.length > 0 && <div className="pointer-events-auto self-end text-[11px] text-fg-3">{tn('request.more', rest.length)}</div>}
      <FocusedCard key={current.request.id} id={current.request.id}>
        <RequestCard entry={current} />
      </FocusedCard>
    </div>
  )
}

/** The card of one request: focusable itself (Enter and Space do nothing on it), focused on arrival unless a field has the focus. */
function FocusedCard({ id, children }: { id: string; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => (ref.current ? takeRequestFocus(ref.current) : undefined), [])

  return (
    <div ref={ref} tabIndex={-1} data-request-card={id} className="float pointer-events-auto rounded-2xl p-4 animate-rise outline-none">
      {children}
    </div>
  )
}

function RequestCard({ entry }: { entry: PendingRequest }) {
  switch (entry.kind) {
    case 'approval':
      return <ApprovalCard id={entry.request.id} params={entry.request.params} />
    case 'clarify':
      return <ClarifyCard id={entry.request.id} params={entry.request.params} />
    case 'sudo':
      return <ValueCard id={entry.request.id} icon={<IconLock size={16} />} title={t('request.sudo')} description={entry.request.params.command} secret />
    case 'secret':
      return <ValueCard id={entry.request.id} icon={<IconKey size={16} />} title={entry.request.params.prompt || t('request.provide', { name: entry.request.params.env_var })} description={entry.request.params.env_var} secret />
  }
}

const CHOICE_LABEL: Record<ApprovalChoice, MessageKey> = { once: 'request.choice.once', session: 'request.choice.session', always: 'request.choice.always', deny: 'request.choice.deny' }

/** Upstream labels plugin-gated approvals `<tool> (plugin approval rule)`; the tool name is what the user needs. */
const PLUGIN_RULE_RE = /^<([a-z0-9_]+)> \(plugin approval rule\)$/i
/** Bridge actions that must never be pre-authorised; the plugin already rotates their rule key, this hides the misleading button. */
const BRIDGE_DESTRUCTIVE = new Set(['system_kill_process'])
const DESTRUCTIVE_SUMMARY_RE = /^(trash|force quit|force kill|terminate|quit)\b/i

function ApprovalCard({ id, params }: { id: string; params: ApprovalRequestParams }) {
  const bridgeTool = PLUGIN_RULE_RE.exec(params.command ?? '')?.[1] ?? null
  const toolName = params.tool_name ?? bridgeTool
  const destructive = Boolean(bridgeTool) && (BRIDGE_DESTRUCTIVE.has(bridgeTool!) || DESTRUCTIVE_SUMMARY_RE.test(params.description ?? ''))
  const choices = (params.choices?.length ? params.choices : (['once', 'deny'] as ApprovalChoice[])).filter(choice => {
    if (choice === 'always') {
      return params.allow_permanent !== false && !destructive
    }

    if (choice === 'session') {
      return params.allow_session !== false && !destructive
    }

    return true
  })

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 text-accent">
          <IconShieldCheck size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[13px] font-medium">
            {bridgeTool ? t('request.actOnDevice', { thisDevice: thisDevice() }) : t('request.permission')}
            {toolName && <Badge tone={destructive ? 'danger' : 'accent'}>{toolName.replace(/^system_/, '').replace(/_/g, ' ')}</Badge>}
          </div>
          {params.description && <div className="mt-1 text-[12.5px] text-fg-2">{params.description}</div>}
        </div>
      </div>
      {params.command && !bridgeTool && (
        <pre className="selectable max-h-40 overflow-auto rounded-md bg-surface px-3 py-2 font-mono text-[12px] leading-relaxed text-fg hairline whitespace-pre-wrap">{params.command}</pre>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        {choices.map(choice => (
          <Button
            key={choice}
            variant={choice === 'deny' ? 'danger' : choice === 'once' ? 'primary' : 'secondary'}
            size="sm"
            onClick={() => resolveRequest(id, { choice })}
          >
            {t(CHOICE_LABEL[choice])}
          </Button>
        ))}
      </div>
    </div>
  )
}

function ClarifyCard({ id, params }: { id: string; params: ClarifyRequestParams }) {
  const questions = params.questions?.length ? params.questions : [{ qid: '_single', question: params.question ?? t('request.needInfo'), choices: params.choices ?? null, multi_select: Boolean(params.multi_select) }]
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const single = questions.length === 1 && questions[0].qid === '_single'
  const set = (qid: string, value: string) => setAnswers(prev => ({ ...prev, [qid]: value }))
  const submit = () => {
    if (single) {
      resolveRequest(id, { answer: answers._single ?? '' })
    } else {
      resolveRequest(id, { answers })
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 text-info">
          <IconQuestionMark size={16} />
        </span>
        <div className="text-[13px] font-medium">{t('attention.question')}</div>
      </div>
      {questions.map(question => (
        <div key={question.qid} className="flex flex-col gap-2">
          <div className="text-[12.5px] text-fg-2">{question.question}</div>
          {question.choices?.length ? (
            <div className="flex flex-wrap gap-1.5">
              {question.choices.map(choice => {
                const selected = question.multi_select ? (answers[question.qid] ?? '').split('\n').includes(choice) : answers[question.qid] === choice

                return (
                  <button
                    key={choice}
                    type="button"
                    onClick={() => {
                      if (!question.multi_select) {
                        set(question.qid, choice)

                        return
                      }

                      const current = (answers[question.qid] ?? '').split('\n').filter(Boolean)
                      set(question.qid, (current.includes(choice) ? current.filter(c => c !== choice) : [...current, choice]).join('\n'))
                    }}
                    className={`rounded-sm px-2.5 py-1 text-[12px] transition-colors ${selected ? 'bg-accent text-accent-fg' : 'bg-surface-2 text-fg-2 hover:bg-surface-3'}`}
                  >
                    {choice}
                  </button>
                )
              })}
            </div>
          ) : null}
          <input
            value={answers[question.qid] ?? ''}
            onChange={event => set(question.qid, event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter') {
                submit()
              }
            }}
            placeholder={question.choices?.length ? t('request.orType') : t('request.type')}
            className="h-8 rounded-sm bg-surface px-2.5 text-[12.5px] outline-none hairline focus:shadow-[0_0_0_1px_var(--color-accent)]"
          />
        </div>
      ))}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={() => resolveRequest(id, single ? { answer: '' } : {})}>
          {t('request.skip')}
        </Button>
        <Button variant="primary" size="sm" onClick={submit}>
          {t('request.answer')}
        </Button>
      </div>
    </div>
  )
}

function ValueCard({ id, icon, title, description, secret }: { id: string; icon: React.ReactNode; title: string; description?: string; secret?: boolean }) {
  const [value, setValue] = useState('')

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 text-warn">{icon}</span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium">{title}</div>
          {description && <pre className="selectable mt-1 max-h-24 overflow-auto font-mono text-[12px] whitespace-pre-wrap text-fg-2">{description}</pre>}
        </div>
      </div>
      <input
        type={secret ? 'password' : 'text'}
        value={value}
        onChange={event => setValue(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter') {
            resolveRequest(id, { value })
          }
        }}
        className="h-8 rounded-sm bg-surface px-2.5 text-[12.5px] outline-none hairline focus:shadow-[0_0_0_1px_var(--color-accent)]"
      />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={() => resolveRequest(id, { value: '' })}>
          {t('request.cancel')}
        </Button>
        <Button variant="primary" size="sm" onClick={() => resolveRequest(id, { value })}>
          {t('request.continue')}
        </Button>
      </div>
    </div>
  )
}
