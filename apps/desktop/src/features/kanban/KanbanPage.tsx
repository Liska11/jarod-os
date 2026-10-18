import { IconFolder, IconPlayerPlay, IconPlus, IconRefresh } from '@tabler/icons-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { EmptyGlass, GlassButton, GlassCard, PageHeader, Pill, type PillTone } from '../../components/ui/glass.tsx'
import { cn } from '../../lib/cn.ts'
import { jarod } from '../../lib/jarod.ts'
import { notify } from '../../store/notifications.ts'
import { t, useT } from '../../lib/i18n.ts'
import { errorText, InlineNote } from '../settings/sections/shared.tsx'
import { agoText, type Board, byColumn, COLUMNS, dispatchText, emptyTask, type Envelope, NEEDS_TEXT, STATUS_HINT, STATUS_LABEL, type Task, type TaskDetail, type TaskDraft, taskInput, taskProblems, unwrap, VERB_LABEL, type Verb, verbsFor } from './kanban-model.ts'

/*
 * Kanban: a board of tasks the agent can work on. Tasks move through To specify → Waiting/Ready → Running → To review → Done. "Run next" starts ONE task by hand:
 * the agent works on the most important ready task in its own conversation (read-only unless the task’s folder says otherwise) and the task lands in To review
 * (or Blocked if the turn failed). Nothing runs on a timer.
 */

const TONE: Record<string, PillTone> = { running: 'progress', blocked: 'danger', review: 'warn', done: 'ok', ready: 'info' }

async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  return unwrap(await jarod<Envelope<T>>(channel, ...args))
}

export function KanbanPage() {
  useT()
  const [boards, setBoards] = useState<Board[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [newBoard, setNewBoard] = useState<string | null>(null)
  // The profile Jarod serves: a task created without an assignee goes to it, so that « Run next » can pick it up.
  const [served, setServed] = useState<string | null>(null)
  const current = boards.find(board => board.is_current)

  const load = useCallback(async () => {
    setLoading(true)

    try {
      const [list, items] = await Promise.all([call<Board[]>('kanban-list-boards', false), call<Task[]>('kanban-list-tasks', {})])

      setBoards(list)
      setTasks(items)
      setError(null)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    jarod<{ id: string; isActive: boolean }[]>('list-profiles').then(
      profiles => setServed(profiles.find(profile => profile.isActive)?.id ?? null),
      () => setServed(null)
    )
  }, [load])

  const columns = useMemo(() => byColumn(tasks), [tasks])

  const run = async (title: string, action: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true)

    try {
      await action()
      await load()

      return true
    } catch (e) {
      notify({ title, body: errorText(e).replace(/^.*?\[oneai\]\s*/, ''), level: 'error' })

      return false
    } finally {
      setBusy(false)
    }
  }

  const dispatch = async (dryRun: boolean) => {
    await run(t('kanban.runNext'), async () => {
      const data = await call<Parameters<typeof dispatchText>[0]>('kanban-dispatch-once', dryRun)

      setNote(dispatchText(data))
    })
  }

  return (
    <div className="page-enter relative flex h-full flex-col">
      <PageHeader
        icon="kanban"
        title={t('kanban.title')}
        subtitle={current ? `${current.name} · ${t(current.total === 1 ? 'kanban.task' : 'kanban.tasks', { count: current.total })}` : t('kanban.subtitle')}
        actions={
          <>
            {boards.length > 1 && (
              <select value={current?.slug ?? ''} onChange={event => void run(t('kanban.switchBoard'), () => call('kanban-switch-board', event.target.value))} aria-label={t('kanban.board')} style={{ colorScheme: 'dark' }} className="glass-input h-8 rounded-lg px-2 text-[12.5px] text-fg outline-none">
                {boards.map(board => (
                  <option key={board.slug} value={board.slug}>
                    {board.name}
                  </option>
                ))}
              </select>
            )}
            <GlassButton size="sm" variant="ghost" onClick={() => setNewBoard('')}>
              {t('kanban.newBoard')}
            </GlassButton>
            <GlassButton size="sm" variant="ghost" disabled={busy} onClick={() => void dispatch(true)}>
              {t('kanban.whatNext')}
            </GlassButton>
            <GlassButton size="sm" variant="secondary" disabled={busy} onClick={() => void dispatch(false)}>
              <IconPlayerPlay />
              {t('kanban.runNext')}
            </GlassButton>
            <GlassButton size="sm" variant="ghost" onClick={() => void load()} aria-label={t('kanban.refresh')}>
              <IconRefresh className={cn(loading && 'animate-spin')} />
            </GlassButton>
            <GlassButton size="sm" variant="primary" onClick={() => setCreating(true)}>
              <IconPlus />
              {t('kanban.newTask')}
            </GlassButton>
          </>
        }
      />
      <div className="flex min-h-0 flex-1 flex-col gap-3 px-6 pb-4">
        {error && <InlineNote tone="danger">{/not ported|non porté|404/.test(error) ? t('kanban.needsJarod') : t('kanban.readFailed', { error })}</InlineNote>}
        {note && <InlineNote tone="info">{note}</InlineNote>}
        {newBoard !== null && (
          <form
            className="flex items-center gap-2"
            onSubmit={event => {
              event.preventDefault()

              if (newBoard.trim()) {
                const slug = newBoard.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'board'

                void run(t('kanban.newBoard'), () => call('kanban-create-board', slug, newBoard.trim(), true)).then(ok => ok && setNewBoard(null))
              }
            }}
          >
            <label className="glass-input flex h-8 w-[240px] items-center rounded-lg px-2.5">
              <span className="sr-only">{t('kanban.boardName')}</span>
              <input autoFocus value={newBoard} onChange={event => setNewBoard(event.target.value)} placeholder={t('kanban.boardName')} maxLength={60} className="min-w-0 flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-fg-4" />
            </label>
            <GlassButton type="submit" size="sm" variant="primary" disabled={busy || !newBoard.trim()}>
              {t('settings.persona.create')}
            </GlassButton>
            <GlassButton type="button" size="sm" variant="ghost" onClick={() => setNewBoard(null)}>
              {t('settings.devices.cancel')}
            </GlassButton>
          </form>
        )}
        {creating && <NewTask onCancel={() => setCreating(false)} onCreate={draft => run(t('kanban.newTask'), () => call('kanban-create-task', taskInput(draft, served))).then(ok => ok && setCreating(false))} busy={busy} />}
        {!error && tasks.length === 0 && !loading && <EmptyGlass title={t('kanban.empty')} description={t('kanban.empty.hint')} action={<GlassButton size="sm" variant="primary" onClick={() => setCreating(true)}>{t('kanban.newTask')}</GlassButton>} />}
        {tasks.length > 0 && (
          <div className="grid min-h-0 flex-1 auto-cols-[minmax(210px,1fr)] grid-flow-col gap-3 overflow-x-auto pb-1">
            {COLUMNS.map(column => (
              <section key={column} className="flex min-h-0 flex-col gap-2" aria-label={STATUS_LABEL[column]}>
                <div className="flex items-center gap-2 px-1" title={STATUS_HINT[column]}>
                  <span className="text-[12.5px] font-medium text-fg-2">{STATUS_LABEL[column]}</span>
                  <Pill tone={TONE[column] ?? 'muted'}>{columns[column].length}</Pill>
                </div>
                <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
                  {columns[column].map(task => (
                    <GlassCard key={task.id} as="button" interactive selected={open === task.id} onClick={() => setOpen(open === task.id ? null : task.id)} className="flex flex-col gap-1 px-3 py-2.5 text-left" aria-label={t('kanban.open', { title: task.title })}>
                      <span className="line-clamp-2 text-[13px] font-medium text-fg">{task.title}</span>
                      <span className="flex items-center gap-1.5 text-[11.5px] text-fg-3">
                        {task.assignee && <span>{task.assignee}</span>}
                        {task.priority !== 0 && <span>{t('kanban.priorityN', { n: task.priority })}</span>}
                        {task.workspace_kind === 'dir' && <IconFolder size={13} />}
                      </span>
                    </GlassCard>
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
      {open && <Drawer id={open} onClose={() => setOpen(null)} onChanged={load} />}
    </div>
  )
}

function NewTask({ onCreate, onCancel, busy }: { onCreate: (draft: TaskDraft) => Promise<unknown>; onCancel: () => void; busy: boolean }) {
  useT()
  const [draft, setDraft] = useState<TaskDraft>(() => emptyTask())
  const problems = taskProblems(draft)
  const set = <K extends keyof TaskDraft>(key: K, value: TaskDraft[K]) => setDraft(current => ({ ...current, [key]: value }))
  const input = 'glass-input rounded-lg px-2.5 text-[12.5px] text-fg outline-none placeholder:text-fg-4'

  return (
    <GlassCard className="flex flex-col gap-2.5 p-3.5">
      <form
        className="flex flex-col gap-2.5"
        onSubmit={event => {
          event.preventDefault()

          if (problems.length === 0) {
            void onCreate(draft)
          }
        }}
      >
        <input autoFocus value={draft.title} onChange={event => set('title', event.target.value)} placeholder={t('settings.rules.notify.title')} aria-label={t('kanban.taskTitle')} className={`${input} h-9`} />
        <textarea value={draft.body} onChange={event => set('body', event.target.value)} rows={3} placeholder={t('kanban.details.placeholder')} aria-label={t('kanban.details')} className={`${input} py-1.5`} />
        <div className="flex flex-wrap items-center gap-2">
          <input value={draft.assignee} onChange={event => set('assignee', event.target.value)} placeholder={t('kanban.assignee.placeholder')} aria-label={t('kanban.assignee')} className={`${input} h-8 w-[200px]`} />
          <input value={draft.priority} onChange={event => set('priority', event.target.value)} aria-label={t('kanban.priority')} inputMode="numeric" className={`${input} h-8 w-[70px]`} />
          <label className="flex items-center gap-1.5 text-[12px] text-fg-2">
            <input type="checkbox" checked={draft.triage} onChange={event => set('triage', event.target.checked)} /> {t('kanban.triage')}
          </label>
          <GlassButton type="button" size="sm" variant="ghost" onClick={() => void jarod<string | null>('select-folder').then(folder => folder && set('folder', folder), e => notify({ title: t('kanban.folder'), body: errorText(e), level: 'error' }))}>
            <IconFolder />
            {draft.folder ? draft.folder : t('kanban.inFolder')}
          </GlassButton>
          {draft.folder && (
            <GlassButton type="button" size="sm" variant="ghost" onClick={() => set('folder', '')}>
              {t('kanban.noFolder')}
            </GlassButton>
          )}
        </div>
        {problems.length > 0 && draft.title.trim() && <InlineNote tone="warn">{problems.join(' ')}</InlineNote>}
        <div className="flex justify-end gap-2">
          <GlassButton type="button" size="sm" variant="ghost" onClick={onCancel}>
            {t('settings.devices.cancel')}
          </GlassButton>
          <GlassButton type="submit" size="sm" variant="primary" disabled={busy || problems.length > 0}>
            {t('kanban.addTask')}
          </GlassButton>
        </div>
      </form>
    </GlassCard>
  )
}

function Drawer({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => Promise<void> }) {
  useT()
  const [detail, setDetail] = useState<TaskDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [asking, setAsking] = useState<Verb | null>(null)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)

  const read = useCallback(async () => {
    try {
      setDetail(await call<TaskDetail>('kanban-get-task', id))
      setError(null)
    } catch (e) {
      setError(errorText(e))
    }
  }, [id])

  useEffect(() => {
    setDetail(null)
    setAsking(null)
    void read()
  }, [read])

  const apply = async (verb: Verb, value: string) => {
    setBusy(true)

    try {
      const v = value.trim()

      switch (verb) {
        case 'promote':
          await call('kanban-promote-task', id)
          break
        case 'specify':
          await call('kanban-specify-task', id)
          break
        case 'assign':
          await call('kanban-assign-task', id, v)
          break
        case 'schedule':
          await call('kanban-schedule-task', id, v)
          break
        case 'block':
          await call('kanban-block-task', id, v)
          break
        case 'unblock':
          await call('kanban-unblock-task', id)
          break
        case 'complete':
          await call('kanban-complete-task', id, v)
          break
        case 'reclaim':
          await call('kanban-reclaim-task', id, v)
          break
        case 'archive':
          await call('kanban-archive-task', id)
          break
        case 'comment':
          await call('kanban-comment-task', id, v)
          break
      }

      setAsking(null)
      setText('')
      await Promise.all([read(), onChanged()])

      if (verb === 'archive') {
        onClose()
      }
    } catch (e) {
      notify({ title: VERB_LABEL[verb], body: errorText(e).replace(/^.*?\[oneai\]\s*/, ''), level: 'error' })
    } finally {
      setBusy(false)
    }
  }

  const task = detail?.task

  return (
    <aside className="glass-card absolute top-0 right-0 bottom-0 z-20 flex w-[400px] flex-col gap-3 overflow-y-auto p-4" aria-label={t('kanban.details')}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[15px] font-semibold text-fg">{task?.title ?? t('kanban.task.one')}</div>
          {task && (
            <div className="mt-1 flex items-center gap-2 text-[12px] text-fg-3">
              <Pill tone={TONE[task.status] ?? 'muted'}>{STATUS_LABEL[task.status]}</Pill>
              {task.assignee && <span>{task.assignee}</span>}
              {task.created_at && <span>{agoText(task.created_at)}</span>}
            </div>
          )}
        </div>
        <GlassButton size="sm" variant="ghost" onClick={onClose} aria-label={t('kanban.close')}>
          ✕
        </GlassButton>
      </div>
      {error && <InlineNote tone="danger">{error}</InlineNote>}
      {task?.body && <div className="text-[12.5px] whitespace-pre-wrap text-fg-2">{task.body}</div>}
      {task?.workspace_path && <div className="text-[11.5px] text-fg-4">{t('kanban.folderIs', { path: task.workspace_path })}</div>}
      {task?.result && <InlineNote tone="info">{t('kanban.result', { text: task.result })}</InlineNote>}
      {detail?.latest_summary && !task?.result && <InlineNote tone="info">{t('kanban.lastRun', { text: detail.latest_summary })}</InlineNote>}
      {task && (
        <div className="flex flex-wrap gap-1.5">
          {verbsFor(task.status).map(verb => (
            <GlassButton key={verb} size="sm" variant={asking === verb ? 'primary' : 'secondary'} disabled={busy} onClick={() => (NEEDS_TEXT[verb] ? (setAsking(asking === verb ? null : verb), setText('')) : void apply(verb, ''))}>
              {VERB_LABEL[verb]}
            </GlassButton>
          ))}
        </div>
      )}
      {asking && NEEDS_TEXT[asking] && (
        <form
          className="flex flex-col gap-2"
          onSubmit={event => {
            event.preventDefault()

            if (NEEDS_TEXT[asking]!.optional || text.trim()) {
              void apply(asking, text)
            }
          }}
        >
          <textarea autoFocus value={text} onChange={event => setText(event.target.value)} rows={asking === 'assign' ? 1 : 3} placeholder={NEEDS_TEXT[asking]!.label} aria-label={NEEDS_TEXT[asking]!.label} className="glass-input rounded-lg px-2.5 py-1.5 text-[12.5px] text-fg outline-none placeholder:text-fg-4" />
          <div className="flex justify-end gap-2">
            <GlassButton type="button" size="sm" variant="ghost" onClick={() => setAsking(null)}>
              {t('settings.devices.cancel')}
            </GlassButton>
            <GlassButton type="submit" size="sm" variant="primary" disabled={busy || (!NEEDS_TEXT[asking]!.optional && !text.trim())}>
              {VERB_LABEL[asking]}
            </GlassButton>
          </div>
        </form>
      )}
      {detail && detail.comments.length > 0 && (
        <section className="flex flex-col gap-1.5">
          <h3 className="text-[12px] font-medium text-fg-2">{t('kanban.comments')}</h3>
          {detail.comments.map(comment => (
            <div key={comment.id} className="rounded-lg bg-white/5 px-2.5 py-1.5 text-[12.5px] text-fg-2">
              <span className="text-fg-4">
                {comment.author ?? t('kanban.someone')} · {agoText(comment.created_at)}
              </span>
              <div className="whitespace-pre-wrap">{comment.body}</div>
            </div>
          ))}
        </section>
      )}
      {detail && detail.runs.length > 0 && (
        <section className="flex flex-col gap-1.5">
          <h3 className="text-[12px] font-medium text-fg-2">{t('kanban.runs')}</h3>
          {detail.runs.map(r => (
            <div key={r.id} className="text-[12px] text-fg-3">
              {agoText(r.started_at)} · {r.status}
              {r.outcome ? ` · ${r.outcome}` : ''}
              {r.error ? ` · ${r.error}` : r.summary ? ` · ${r.summary}` : ''}
            </div>
          ))}
        </section>
      )}
    </aside>
  )
}
