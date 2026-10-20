import { IconCircleCheck, IconCircleX, IconClockPause, IconLoader2, IconPlayerStop } from '@tabler/icons-react'
import { useEffect, useRef, useState } from 'react'
import { GlassButton, Pill } from '../../../components/ui/glass.tsx'
import { dateLocale, type MessageKey, t, useT } from '../../../lib/i18n.ts'
import { jarod } from '../../../lib/jarod.ts'
import { useBackendData } from '../../../lib/use-async.ts'
import { reportEngineError } from './jarod-controls.tsx'
import { isUnsupported } from './providers-model.ts'
import { InlineNote, SectionTitle, SettingsGroup, SettingsRow } from './shared.tsx'

/*
 * Settings > Tasks (cockpit, lot 2): every action that went through the agent's single gate with an effect, an audited read or an
 * approval: the resolved action, its target, its steps, its status and the proof of what was observed afterwards. A live task can be
 * cancelled by its id; nothing else is sent to the engine.
 */

export type TaskStatus = 'awaiting-approval' | 'running' | 'verifying' | 'done' | 'failed' | 'refused' | 'cancelled'

export interface TaskRow {
  id: string
  sessionId: string
  tool: string
  target?: string
  summary: string
  status: TaskStatus
  steps: { at: number; step: string; detail?: string }[]
  proof?: { status: 'verified' | 'failed' | 'unverifiable'; evidence: string }
  error?: string
  createdAt: number
  endedAt?: number
}

const LIVE: ReadonlySet<TaskStatus> = new Set(['awaiting-approval', 'running', 'verifying'])

export const isLive = (task: TaskRow): boolean => LIVE.has(task.status)

const TONE: Record<TaskStatus, 'ok' | 'warn' | 'danger' | 'muted' | 'progress'> = {
  'awaiting-approval': 'warn',
  running: 'progress',
  verifying: 'progress',
  done: 'ok',
  failed: 'danger',
  refused: 'muted',
  cancelled: 'muted'
}

/** One line under the action: the tool and target, then what the proof says (or the error). */
export function taskDetail(task: TaskRow): string {
  const proof = task.proof ? t(`settings.tasks.proof.${task.proof.status}` as MessageKey, { evidence: task.proof.evidence }) : ''

  return [task.target ? `${task.tool} · ${task.target}` : task.tool, proof, task.error ?? ''].filter(Boolean).join(' — ')
}

export function TasksSection() {
  useT()
  const list = useBackendData(() => jarod<TaskRow[]>('tasks-list', 50))
  const [busy, setBusy] = useState(false)
  const tasks = list.data ?? []
  const anyLive = tasks.some(isLive)

  const reload = useRef(list.reload)
  reload.current = list.reload

  // A live task moves on its own: the list is read again every 2 s while one is running, and not otherwise.
  useEffect(() => {
    if (!anyLive) {
      return
    }

    const timer = setInterval(() => reload.current(), 2000)

    return () => clearInterval(timer)
  }, [anyLive])

  if (isUnsupported(list.error)) {
    return (
      <>
        <SectionTitle title={t('settings.tasks.title')} subtitle={t('settings.tasks.subtitle')} />
        <InlineNote tone="info">{t('settings.tasks.needsJarod')}</InlineNote>
      </>
    )
  }

  const cancel = async (task: TaskRow) => {
    setBusy(true)

    try {
      const result = await jarod<{ success: boolean; error?: string }>('task-cancel', task.id)

      if (!result.success) {
        throw new Error(result.error ?? t('settings.tasks.cancelFailed'))
      }

      list.reload()
    } catch (error) {
      reportEngineError(t('settings.tasks.title'), error)
    } finally {
      setBusy(false)
    }
  }

  const icon = (task: TaskRow) =>
    task.status === 'done' ? <IconCircleCheck /> : task.status === 'failed' ? <IconCircleX /> : task.status === 'awaiting-approval' ? <IconClockPause /> : isLive(task) ? <IconLoader2 /> : <IconPlayerStop />

  return (
    <>
      <SectionTitle title={t('settings.tasks.title')} subtitle={t('settings.tasks.subtitle')} />

      <SettingsGroup title={t('settings.tasks.recent')}>
        {tasks.length === 0 && <SettingsRow icon={<IconCircleCheck />} label={t('settings.tasks.none')} description={t('settings.tasks.none.hint')} keywords="tasks actions empty" />}
        {tasks.map(task => (
          <SettingsRow
            key={task.id}
            icon={icon(task)}
            label={task.summary}
            description={`${new Date(task.createdAt).toLocaleTimeString(dateLocale(), { hour: '2-digit', minute: '2-digit', second: '2-digit' })} · ${taskDetail(task)}`}
            keywords={`task ${task.tool} ${task.target ?? ''}`}
          >
            <Pill tone={TONE[task.status]}>{t(`settings.tasks.status.${task.status}` as MessageKey)}</Pill>
            {isLive(task) && (
              <GlassButton size="sm" variant="secondary" disabled={busy} onClick={() => void cancel(task)} aria-label={t('settings.tasks.cancel.aria', { action: task.summary })}>
                {t('settings.tasks.cancel')}
              </GlassButton>
            )}
          </SettingsRow>
        ))}
      </SettingsGroup>
    </>
  )
}
