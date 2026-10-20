import { IconDownload, IconExternalLink, IconRefresh } from '@tabler/icons-react'
import { useEffect, useState } from 'react'
import { GlassButton, Pill, type PillTone } from '../../components/ui/glass.tsx'
import { Spinner } from '../../components/ui/primitives.tsx'
import { dateLocale, type MessageKey, t, useT } from '../../lib/i18n.ts'

type State = Awaited<ReturnType<typeof window.jarodOS.updates.state>>
type Category = 'windows' | 'drivers' | 'software'
type Plan = Extract<Awaited<ReturnType<typeof window.jarodOS.updates.prepareUpgrade>>, { ok: true }>['plan']
type Progress = Parameters<Parameters<typeof window.jarodOS.updates.onProgress>[0]>[0]
type Result = Extract<Awaited<ReturnType<typeof window.jarodOS.updates.upgrade>>, { ok: true }>['result']

const TONE: Record<string, PillTone> = { 'up-to-date': 'ok', available: 'warn', failed: 'danger', unsupported: 'muted', unchecked: 'muted' }
const RESULT_TONE: Record<Result['outcome'], string> = { success: 'text-ok', 'reboot-required': 'text-warn', failed: 'text-danger', cancelled: 'text-fg-3' }

/*
 * Système › Mises à jour (docs/UPDATES.md): a read-only check of Windows, drivers and the software winget knows. Windows updates and drivers
 * open in Windows' Settings. One listed program can be upgraded with winget, after the person confirmed its exact id, version and source;
 * one at a time, never all at once.
 */
export function UpdatesPanel() {
  useT()
  const [state, setState] = useState<State | null>(null)
  const [busy, setBusy] = useState(false)
  const [plan, setPlan] = useState<Plan | null>(null)
  const [progress, setProgress] = useState<Progress | null>(null)
  const [outcome, setOutcome] = useState<{ name: string; result: Result } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void window.jarodOS.updates
      .state()
      .then(next => {
        setState(next)
        setProgress(next.upgrading)
      })
      .catch(() => undefined)

    return window.jarodOS.updates.onProgress(next => setProgress(next.phase === 'done' ? null : next))
  }, [])

  const check = async () => {
    setBusy(true)
    setState(await window.jarodOS.updates.check().catch(() => state))
    setBusy(false)
  }

  // Step 1: main says exactly what would run, or why not. Nothing is installed yet.
  const prepare = async (id: string, version: string | null, source: string) => {
    setError(null)
    setOutcome(null)
    const reply = await window.jarodOS.updates.prepareUpgrade({ id, version: version ?? '', source }).catch((cause: Error) => ({ ok: false as const, error: cause.message }))

    if (reply.ok) setPlan(reply.plan)
    else setError(reply.error)
  }

  // Step 2: the person confirmed this plan; it runs once.
  const confirm = async (confirmed: Plan) => {
    setPlan(null)
    setProgress({ id: confirmed.id, phase: 'starting', percent: null, line: '' })
    const reply = await window.jarodOS.updates.upgrade(confirmed.token).catch((cause: Error) => ({ ok: false as const, error: cause.message }))
    setProgress(null)

    if (reply.ok) {
      setOutcome({ name: confirmed.name, result: reply.result })
      setState(reply.state)
    } else {
      setError(reply.error)
    }
  }

  if (!state) return <Spinner />

  const report = state.report
  const when = report.checkedAt ? new Date(report.checkedAt).toLocaleString(dateLocale(), { dateStyle: 'medium', timeStyle: 'short' }) : null

  return (
    <section className="flex flex-col gap-3" aria-label={t('updates.title')}>
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-[13px] font-semibold text-fg">{t('updates.title')}</h3>
        <span className="text-[12px] text-fg-3">{when ? t(state.offline ? 'updates.lastOld' : 'updates.last', { when }) : t('updates.never')}</span>
        <span className="flex-1" />
        <GlassButton size="sm" variant="primary" disabled={busy || state.running || state.offline || !state.windows} onClick={() => void check()}>
          {busy || state.running ? <Spinner /> : <IconRefresh />}
          {busy || state.running ? t('updates.checking') : t('updates.check')}
        </GlassButton>
      </div>
      {state.offline && <p className="text-[12px] text-warn">{t('updates.offline')}</p>}
      {!state.windows && <p className="text-[12px] text-fg-3">{t('updates.windowsOnly')}</p>}
      {(busy || state.running) && <p className="text-[12px] text-fg-3">{t('updates.slow')}</p>}

      {plan && (
        <div role="alertdialog" aria-label={t('updates.confirm.title')} className="flex flex-col gap-2 rounded-lg border border-warn p-3 text-[12px]">
          <div className="text-[12.5px] font-semibold text-fg">{t('updates.confirm.title')}</div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
            <dt className="text-fg-3">{t('updates.confirm.name')}</dt>
            <dd className="text-fg">{plan.name}</dd>
            <dt className="text-fg-3">{t('updates.confirm.id')}</dt>
            <dd className="selectable font-mono text-fg">{plan.id}</dd>
            <dt className="text-fg-3">{t('updates.confirm.version')}</dt>
            <dd className="font-mono text-fg">{plan.current ? `${plan.current} → ${plan.version}` : plan.version}</dd>
            <dt className="text-fg-3">{t('updates.confirm.source')}</dt>
            <dd className="font-mono text-fg">{plan.source}</dd>
          </dl>
          <code className="selectable rounded bg-surface-2 px-2 py-1 font-mono text-[11px] break-all text-fg-2">{plan.command.join(' ')}</code>
          <p className="text-fg-3">{t('updates.confirm.notes')}</p>
          <div className="flex flex-wrap gap-2">
            <GlassButton size="sm" variant="primary" onClick={() => void confirm(plan)}>
              <IconDownload />
              {t('updates.confirm.go', { id: plan.id, version: plan.version })}
            </GlassButton>
            <GlassButton size="sm" variant="ghost" onClick={() => setPlan(null)}>
              {t('updates.confirm.cancel')}
            </GlassButton>
          </div>
        </div>
      )}

      {progress && (
        <div role="status" aria-label={t('updates.progress.aria')} className="flex flex-col gap-1 rounded-lg border border-line p-3 text-[12px]">
          <div className="flex items-center gap-2 text-fg">
            <Spinner />
            <span>{t(`updates.phase.${progress.phase}` as MessageKey, { id: progress.id })}</span>
            {progress.percent !== null && <span className="tabular-nums text-fg-3">{progress.percent} %</span>}
          </div>
          {progress.percent !== null && (
            <div className="h-1 overflow-hidden rounded bg-surface-2">
              <div className="h-full bg-accent transition-[width]" style={{ width: `${progress.percent}%` }} />
            </div>
          )}
          {progress.line && <div className="truncate font-mono text-[11px] text-fg-4">{progress.line}</div>}
        </div>
      )}

      {outcome && (
        <p role="status" aria-label={t('updates.result.aria')} className={`text-[12px] ${RESULT_TONE[outcome.result.outcome]}`}>
          {t(`updates.result.${outcome.result.outcome}` as MessageKey, { name: outcome.name })} {outcome.result.message}
        </p>
      )}
      {error && (
        <p role="alert" className="text-[12px] text-danger">
          {error}
        </p>
      )}

      {(['windows', 'drivers', 'software'] as Category[]).map(category => {
        const result = report.categories[category]

        return (
          <div key={category} className="rounded-lg border border-line p-3">
            <div className="flex items-center gap-2">
              <span className="text-[12.5px] font-medium text-fg">{t(`updates.category.${category}` as MessageKey)}</span>
              <Pill tone={TONE[result.status] ?? 'muted'}>{t(`updates.status.${result.status}` as MessageKey, { count: result.items.length })}</Pill>
              <span className="flex-1" />
              {category !== 'software' && result.status === 'available' && (
                <GlassButton size="sm" variant="ghost" onClick={() => void window.jarodOS.updates.openWindowsUpdate()}>
                  <IconExternalLink />
                  {t('updates.openWindowsUpdate')}
                </GlassButton>
              )}
            </div>
            {result.error && <p className="mt-1 text-[11.5px] text-danger">{result.error}</p>}
            {result.items.length > 0 && (
              <table className="mt-2 w-full text-[12px]">
                <thead className="text-left text-[11px] text-fg-4">
                  <tr>
                    <th className="py-1 pr-3 font-normal">{t('updates.col.name')}</th>
                    <th className="py-1 pr-3 font-normal">{t('updates.col.versions')}</th>
                    <th className="py-1 pr-3 font-normal">{t('updates.col.notes')}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {result.items.map(item => (
                    <tr key={`${item.id}-${item.name}`} className="border-t border-line">
                      <td className="py-1.5 pr-3 text-fg">
                        <div className="max-w-[420px] truncate" title={item.name}>
                          {item.name}
                        </div>
                        <div className="selectable font-mono text-[10.5px] text-fg-4">
                          {item.id} · {item.repository ?? item.source}
                        </div>
                      </td>
                      <td className="py-1.5 pr-3 tabular-nums text-fg-2">{[item.current, item.available].filter(Boolean).join(' → ') || '—'}</td>
                      <td className="py-1.5 pr-3 text-fg-3">{[item.elevation ? t('updates.admin') : '', item.restart ? t('updates.restart') : ''].filter(Boolean).join(' · ')}</td>
                      <td className="py-1.5 text-right">
                        {item.source === 'winget' && (
                          <GlassButton
                            size="sm"
                            variant="ghost"
                            disabled={state.offline || Boolean(progress) || !item.available}
                            title={state.offline ? t('updates.upgradeOffline') : undefined}
                            aria-label={t('updates.upgradeAria', { name: item.name })}
                            onClick={() => void prepare(item.id, item.available, item.repository ?? 'winget')}
                          >
                            <IconDownload />
                            {t('updates.upgrade')}
                          </GlassButton>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )
      })}
      <ul className="list-disc pl-5 text-[11.5px] text-fg-4">
        {(report.coverage.length ? report.coverage : [t('updates.coverageUnknown')]).map(line => (
          <li key={line}>{line}</li>
        ))}
        <li>{t('updates.noAuto')}</li>
      </ul>
    </section>
  )
}
