import { useStore } from '@nanostores/react'
import { IconCheck, IconLoader2, IconPlus, IconRefresh, IconX } from '@tabler/icons-react'
import { useEffect, useMemo, useState } from 'react'
import { t, useT } from '../../lib/i18n.ts'
import { EmptyGlass, GlassButton, GlassCard, LinkAction, PageHeader, Pill, type PillTone, SearchField, Section, Toggle } from '../../components/ui/glass.tsx'
import { cn } from '../../lib/cn.ts'
import type { CronJob } from '../../lib/rest.ts'
import { useBackendData } from '../../lib/use-async.ts'
import { onGatewayEvent } from '../../store/gateway.ts'
import { automationEnabled, createEventAutomation, deleteAutomation, duplicateAutomation, eventRuleFor, setAutomationEnabled, triggerAutomation } from '../../store/automations.ts'
import { $prefs } from '../../store/backend.ts'
import { notify } from '../../store/notifications.ts'
import { type CronJobDraft, type CronJobEdits, type CronRun, LOCAL_TARGET, cronApi, errorText, isFailedStatus, jobKey } from './api.ts'
import { AutomationDetail } from './AutomationDetail.tsx'
import { formatNextRun, formatRunDuration, formatRunTimestamp, humanizeSchedule, toMs } from './cron-humanize.ts'
import { type JobMenuAction, JobMenu } from './JobMenu.tsx'
import { type EventTrigger, NewAutomationForm } from './NewAutomationForm.tsx'
import { JobTile, ruleText } from './presentation.tsx'

const RUN_SOURCES = 5
const RUNS_PER_JOB = 10
const RUNS_COLLAPSED = 3
const RUNS_EXPANDED = 10

interface RunRow {
  key: string
  run: CronRun
  job: CronJob
  startedMs: number
  latest: boolean
}

const toast = (title: string, body: string, level: 'success' | 'error' | 'info' = 'success') => notify({ title, body, level, surface: 'automations' })

const sortByNextRun = (a: CronJob, b: CronJob) => (toMs(a.next_run_at) ?? Infinity) - (toMs(b.next_run_at) ?? Infinity)

/** What a card says about when it runs: its event for event automations, else the schedule. */
const whenText = (job: CronJob) => {
  const rule = eventRuleFor(job.id)

  return rule ? ruleText(rule) : humanizeSchedule(job)
}

export function AutomationsPage() {
  const { t } = useT()
  const jobs = useBackendData(cronApi.list)
  const targets = useBackendData(cronApi.deliveryTargets)
  // Event rules live in Jarod-OS's preferences; re-render when they change.
  useStore($prefs)

  useEffect(() => onGatewayEvent('cron.changed', () => jobs.reload()), [jobs.reload])

  const [query, setQuery] = useState('')
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [mode, setMode] = useState<'detail' | 'new'>('detail')
  const [optimistic, setOptimistic] = useState<Record<string, boolean>>({})
  const [saving, setSaving] = useState(false)
  const [creating, setCreating] = useState(false)
  const [allRuns, setAllRuns] = useState(false)

  // Fresh backend truth supersedes any optimistic toggle state.
  useEffect(() => setOptimistic({}), [jobs.data])

  const all = useMemo(() => [...(jobs.data ?? [])].sort(sortByNextRun), [jobs.data])
  const needle = query.trim().toLowerCase()
  const filtered = useMemo(
    () => (needle ? all.filter(job => [job.name, job.prompt, whenText(job), job.deliver].some(field => (field ?? '').toLowerCase().includes(needle))) : all),
    [all, needle]
  )

  const selected = (selectedKey && (filtered.find(job => jobKey(job) === selectedKey) ?? all.find(job => jobKey(job) === selectedKey))) || filtered[0] || null
  const deliveryTargets = targets.data ?? [LOCAL_TARGET]

  // Run history for the first few visible jobs (plus the selected one), merged into "Recent runs".
  const runSources = useMemo(() => {
    const picked = filtered.slice(0, RUN_SOURCES)

    if (selected && !picked.some(job => jobKey(job) === jobKey(selected))) {
      picked.push(selected)
    }

    return picked
  }, [filtered, selected])
  const runSourceKeys = runSources.map(jobKey).join('|')
  const runs = useBackendData(
    async () => {
      const results = await Promise.allSettled(runSources.map(job => cronApi.runs(job, RUNS_PER_JOB)))
      const byKey: Record<string, CronRun[]> = {}

      results.forEach((result, index) => {
        byKey[jobKey(runSources[index])] = result.status === 'fulfilled' ? result.value : []
      })

      return byKey
    },
    [runSourceKeys, jobs.data],
    { enabled: runSources.length > 0 }
  )

  const runRows = useMemo<RunRow[]>(() => {
    const rows: RunRow[] = []

    for (const job of runSources) {
      const list = runs.data?.[jobKey(job)] ?? []
      let latestMs = -Infinity

      for (const run of list) {
        latestMs = Math.max(latestMs, toMs(run.started_at) ?? -Infinity)
      }

      for (const run of list) {
        const startedMs = toMs(run.started_at)

        if (startedMs === undefined) {
          continue
        }

        rows.push({ key: `${jobKey(job)}:${run.id}`, run, job, startedMs, latest: startedMs === latestMs })
      }
    }

    return rows.sort((a, b) => b.startedMs - a.startedMs)
  }, [runSources, runs.data])

  const lastRunFor = (job: CronJob): CronRun | undefined => runs.data?.[jobKey(job)]?.[0]

  /* ---- Mutations ---------------------------------------------------------------------------- */

  // The mutations live in store/automations.ts (shared with the command registry); the page keeps
  // only the optimistic toggle and selection bookkeeping. Toasts come from the store.
  const toggleEnabled = async (job: CronJob, enabled: boolean) => {
    const key = jobKey(job)
    setOptimistic(prev => ({ ...prev, [key]: enabled }))

    try {
      await setAutomationEnabled(job, enabled)
      jobs.reload()
    } catch {
      setOptimistic(prev => {
        const next = { ...prev }
        delete next[key]

        return next
      })
    }
  }

  const runAction = async (job: CronJob, action: JobMenuAction) => {
    try {
      if (action === 'trigger') {
        await triggerAutomation(job)
      } else if (action === 'duplicate') {
        const created = await duplicateAutomation(job)

        if (created?.id) {
          setSelectedKey(jobKey({ id: created.id, profile: created.profile ?? job.profile }))
          setMode('detail')
        }
      } else {
        await deleteAutomation(job)

        if (selected && jobKey(selected) === jobKey(job)) {
          setSelectedKey(null)
        }
      }

      jobs.reload()
    } catch {
      // The store already reported the failure.
    }
  }

  const saveEdits = async (job: CronJob, edits: CronJobEdits): Promise<boolean> => {
    if (Object.keys(edits).length === 0) {
      return true
    }

    setSaving(true)

    try {
      await cronApi.update(job, edits)
      toast(job.name || t('automation.title'), t('automation.changesSaved'))
      jobs.reload()

      return true
    } catch (error) {
      toast(t('automation.saveFailed'), errorText(error), 'error')

      return false
    } finally {
      setSaving(false)
    }
  }

  const createJob = async (draft: CronJobDraft, trigger?: EventTrigger): Promise<boolean> => {
    setCreating(true)

    try {
      const created = trigger ? await createEventAutomation(draft, trigger.event, trigger.match) : await cronApi.create(draft)

      if (!trigger) {
        toast(draft.name || t('automation.title'), t('automation.created'))
      }

      if (created?.id) {
        setSelectedKey(jobKey({ id: created.id, profile: created.profile }))
      }

      setMode('detail')
      jobs.reload()

      return true
    } catch (error) {
      toast(t('automation.createFailed'), errorText(error), 'error')

      return false
    } finally {
      setCreating(false)
    }
  }

  /* ---- Render ------------------------------------------------------------------------------- */

  const initialLoading = jobs.loading && jobs.data === null
  const empty = !initialLoading && !jobs.error && all.length === 0
  const showRight = mode === 'new' || (!empty && !jobs.error)
  const newButton = (
    <GlassButton variant="primary" onClick={() => setMode('new')} aria-label={t('automation.new')}>
      <IconPlus />
      {t('automation.new')}
    </GlassButton>
  )

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        icon="automations"
        title={t('automation.title')}
        subtitle={t('automation.subtitle')}
        actions={
          <>
            <SearchField value={query} onChange={setQuery} placeholder={t('automation.search')} className="w-64" />
            {newButton}
          </>
        }
      />

      <div className="flex min-h-0 flex-1 gap-4 px-6 pb-6">
        <div className="flex min-w-0 flex-1 flex-col gap-5 overflow-y-auto pr-1">
          {jobs.error && (
            <EmptyGlass
              icon={<IconX />}
              title={t('automation.loadFailed')}
              description={jobs.error}
              action={
                <GlassButton onClick={jobs.reload}>
                  <IconRefresh />
                  {t('automation.retry')}
                </GlassButton>
              }
            />
          )}

          {initialLoading && (
            <div className="flex flex-col gap-3" aria-busy="true" aria-label={t('automation.loadingAria')}>
              {[0, 1, 2].map(i => (
                <div key={i} className="shimmer h-[84px] rounded-xl" />
              ))}
            </div>
          )}

          {empty && (
            <EmptyGlass icon={<IconRefresh />} title={t('automation.empty')} description={t('automation.empty.hint')} action={newButton} className="min-h-64" />
          )}

          {!initialLoading && !jobs.error && all.length > 0 && (
            <>
              {filtered.length === 0 ? (
                <EmptyGlass title={t('automation.noMatch', { query: query.trim() })} description={t('automation.noMatch.hint')} />
              ) : (
                <ul className="stagger flex flex-col gap-3">
                  {filtered.map(job => {
                    const key = jobKey(job)
                    const enabled = optimistic[key] ?? automationEnabled(job)
                    const active = selected ? jobKey(selected) === key && mode === 'detail' : false

                    return (
                      <li key={key}>
                        <JobCard
                          job={job}
                          enabled={enabled}
                          selected={active}
                          onSelect={() => {
                            setSelectedKey(key)
                            setMode('detail')
                          }}
                          onToggle={value => void toggleEnabled(job, value)}
                          onAction={action => void runAction(job, action)}
                        />
                      </li>
                    )
                  })}
                </ul>
              )}

              <Section
                title={t('automation.recentRuns')}
                action={
                  runRows.length > RUNS_COLLAPSED ? (
                    <LinkAction onClick={() => setAllRuns(v => !v)}>{allRuns ? t('automation.showFewer') : t('automation.viewAll')}</LinkAction>
                  ) : undefined
                }
              >
                <RecentRuns rows={runRows.slice(0, allRuns ? RUNS_EXPANDED : RUNS_COLLAPSED)} loading={runs.loading && runs.data === null} />
              </Section>
            </>
          )}
        </div>

        {showRight && (
          <div className="flex w-[430px] shrink-0 flex-col">
            {mode === 'new' ? (
              <NewAutomationForm targets={deliveryTargets} creating={creating} onCreate={createJob} onCancel={() => setMode('detail')} />
            ) : selected ? (
              <AutomationDetail
                key={jobKey(selected)}
                job={selected}
                targets={deliveryTargets}
                lastRun={lastRunFor(selected)}
                saving={saving}
                onSave={edits => saveEdits(selected, edits)}
                onAction={action => void runAction(selected, action)}
              />
            ) : initialLoading ? (
              <div className="shimmer h-full rounded-xl" />
            ) : (
              <EmptyGlass title={t('automation.select')} description={t('automation.select.hint')} className="h-full" />
            )}
          </div>
        )}
      </div>
    </div>
  )
}

/* ---- Pieces ------------------------------------------------------------------------------------ */

function JobCard({ job, enabled, selected, onSelect, onToggle, onAction }: { job: CronJob; enabled: boolean; selected: boolean; onSelect: () => void; onToggle: (value: boolean) => void; onAction: (action: JobMenuAction) => void }) {
  const { t } = useT()
  const name = job.name || job.prompt?.slice(0, 40) || job.id
  const event = Boolean(eventRuleFor(job.id))
  const nextLine = event ? (enabled ? t('automation.job.runsWhen') : t('automation.off')) : enabled ? formatNextRun({ ...job, enabled: true, state: job.state === 'paused' ? 'scheduled' : job.state }) : t('automation.paused')

  return (
    <GlassCard interactive selected={selected} onClick={onSelect} className="flex items-center gap-3.5 p-3.5" data-os-target={`automation:${job.id}`}>
      <button type="button" className="flex min-w-0 flex-1 items-center gap-3.5 text-left" aria-label={t('automation.job.open', { name })} aria-current={selected ? 'true' : undefined}>
        <JobTile job={job} size={44} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13.5px] font-medium text-fg">{name}</span>
          <span className="block truncate text-[12px] text-fg-3">{whenText(job)}</span>
          <span className={cn('block truncate text-[12px]', job.state === 'error' ? 'text-danger' : 'text-fg-4')}>{nextLine}</span>
        </span>
      </button>
      <span className="flex shrink-0 items-center gap-1.5" onClick={event => event.stopPropagation()}>
        <Toggle checked={enabled} onChange={onToggle} label={t('automation.job.pauseResume', { action: enabled ? t('automation.job.pause') : t('automation.job.resume'), name })} />
        <JobMenu jobName={name} onAction={onAction} />
      </span>
    </GlassCard>
  )
}

function RecentRuns({ rows, loading }: { rows: RunRow[]; loading: boolean }) {
  const { t } = useT()
  if (loading) {
    return (
      <div className="flex flex-col gap-2" aria-busy="true">
        {[0, 1, 2].map(i => (
          <div key={i} className="shimmer h-12 rounded-xl" />
        ))}
      </div>
    )
  }

  if (rows.length === 0) {
    return <EmptyGlass title={t('automation.recentRuns.empty')} description={t('automation.recentRuns.empty.hint')} className="min-h-24 py-5" />
  }

  return (
    <ul className="flex flex-col gap-2">
      {rows.map(row => {
        const status = runStatus(row)
        const startedMs = row.startedMs
        const endedMs = toMs(row.run.ended_at)
        const duration = endedMs !== undefined && endedMs >= startedMs ? formatRunDuration((endedMs - startedMs) / 1000) : undefined

        return (
          <li key={row.key}>
            <GlassCard className="flex items-center gap-3 px-3.5 py-2.5">
              <RunStatusIcon status={status.kind} />
              <div className="min-w-0 flex-1">
                <div className="text-[12.5px] text-fg tabular-nums">{formatRunTimestamp(startedMs)}</div>
                <div className="truncate text-[12px] text-fg-3">{row.job.name || row.run.title || row.job.id}</div>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-0.5">
                <Pill tone={status.tone}>{status.label}</Pill>
                {duration && <span className="text-[11.5px] text-fg-4 tabular-nums">{duration}</span>}
              </div>
            </GlassCard>
          </li>
        )
      })}
    </ul>
  )
}

type RunKind = 'ok' | 'failed' | 'running'

function runStatus(row: RunRow): { kind: RunKind; label: string; tone: PillTone } {
  if (row.run.is_active) {
    return { kind: 'running', label: t('automation.runStatus.running'), tone: 'progress' }
  }

  if (row.latest && isFailedStatus(row.job.last_status)) {
    return { kind: 'failed', label: t('automation.runStatus.failed'), tone: 'danger' }
  }

  if (/error|fail/i.test(row.run.end_reason ?? '')) {
    return { kind: 'failed', label: t('automation.runStatus.failed'), tone: 'danger' }
  }

  return { kind: 'ok', label: t('automation.runStatus.ok'), tone: 'ok' }
}

function RunStatusIcon({ status }: { status: RunKind }) {
  const classes = { ok: 'bg-ok/15 text-ok', failed: 'bg-danger/15 text-danger', running: 'bg-progress/15 text-progress' }[status]

  return (
    <span className={cn('flex size-7 shrink-0 items-center justify-center rounded-full', classes)} aria-hidden="true">
      {status === 'ok' ? <IconCheck size={15} stroke={2.2} /> : status === 'failed' ? <IconX size={15} stroke={2.2} /> : <IconLoader2 size={15} className="animate-spin" />}
    </span>
  )
}
