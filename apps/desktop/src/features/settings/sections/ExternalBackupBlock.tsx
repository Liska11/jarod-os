import { IconDeviceFloppy, IconFolder, IconHistory, IconPlayerStop } from '@tabler/icons-react'
import { useCallback, useEffect, useState } from 'react'
import { DEFAULT_PARTS, type DestinationCheck, type ExternalBackupSummary, type ExternalEstimate, type ExternalPart, type ExternalProgress, type ExternalState, OPTIONAL_PARTS } from '../../../../shared/external-backup.ts'
import { GlassButton, GlassCard, Toggle } from '../../../components/ui/glass.tsx'
import { Spinner } from '../../../components/ui/primitives.tsx'
import { formatBytes } from '../../../lib/format.ts'
import { dateLocale, type MessageKey, useT } from '../../../lib/i18n.ts'
import { SettingsBlock } from './shared.tsx'

const HOURS = [6, 12, 24, 72, 168]

/**
 * External backups (docs/BACKUP-EXTERNE.md): another disk, chosen here; what to copy, its size and what is left out, shown before
 * starting; progress and cancel; the backups found on that disk, each restorable after a confirmation. Distinct from the Jarod disk's
 * own backups above, and from moving the Jarod disk.
 */
export function ExternalBackupBlock() {
  const { t } = useT()
  const [state, setState] = useState<ExternalState | null>(null)
  const [progress, setProgress] = useState<ExternalProgress | null>(null)
  const [estimate, setEstimate] = useState<ExternalEstimate | null>(null)
  const [check, setCheck] = useState<DestinationCheck | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<string | null>(null)
  const [restarting, setRestarting] = useState(false)

  const refresh = useCallback(() => {
    void window.jarodOS.externalBackup
      .state()
      .then(next => {
        setState(next)
        setProgress(next.progress)
      })
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    refresh()

    return window.jarodOS.externalBackup.onProgress(next => {
      setProgress(next)

      if (next.operation === null) refresh()
    })
  }, [refresh])

  const partsKey = state?.settings.parts.join(',')

  useEffect(() => {
    if (!state) return
    setEstimate(null)
    void window.jarodOS.externalBackup
      .estimate(state.settings.parts)
      .then(setEstimate)
      .catch(() => undefined)

    if (state.settings.destination) {
      void window.jarodOS.externalBackup
        .check(state.settings.destination.path)
        .then(setCheck)
        .catch(() => undefined)
    }
  }, [partsKey, state?.settings.destination?.path])

  const describe = (reason: string) => {
    const key = `externalBackup.error.${reason.split(':')[0]}` as MessageKey

    return t(key) !== key ? t(key, { detail: reason.split(':').slice(1).join(':').trim() }) : t('externalBackup.error.other', { detail: reason })
  }

  const choose = async () => {
    setError(null)
    const folder = await window.jarodOS.externalBackup.choose()

    if (!folder) return
    const result = await window.jarodOS.externalBackup.setDestination(folder)

    if (!result.ok) setError(describe(result.error))
    refresh()
  }

  const options = (parts: ExternalPart[], auto = state?.settings.auto ?? { enabled: false, everyHours: 24 }) => {
    void window.jarodOS.externalBackup
      .setOptions(parts, auto)
      .then(setState)
      .catch(() => undefined)
  }

  const run = async () => {
    setError(null)
    const result = await window.jarodOS.externalBackup.run()

    if (!result.ok && result.error !== 'cancelled') setError(describe(result.error))
    refresh()
  }

  const restore = async (folder: string) => {
    setError(null)
    setConfirm(null)
    const result = await window.jarodOS.externalBackup.restore(folder)

    if (result.ok) setRestarting(true)
    else setError(describe(result.error))
    refresh()
  }

  const working = Boolean(progress?.operation)
  const destination = state?.settings.destination

  return (
    <SettingsBlock title={t('externalBackup.title')} label={t('externalBackup.title')} description={t('externalBackup.text')} keywords={t('externalBackup.keywords')}>
      <GlassCard className="flex flex-col gap-3 p-4">
        <p className="text-[12.5px] text-fg-3">{t('externalBackup.text')}</p>
        {!state ? (
          <Spinner />
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <IconFolder size={15} className="shrink-0 text-fg-3" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] text-fg" title={destination?.path}>
                  {destination ? destination.path : t('externalBackup.noDestination')}
                </div>
                {destination && <div className="text-[11.5px] text-fg-3">{t(`externalBackup.status.${state.destinationStatus}` as MessageKey, { label: destination.label || '—' })}</div>}
              </div>
              <GlassButton size="sm" variant="ghost" disabled={working} onClick={() => void choose()}>
                {destination ? t('externalBackup.change') : t('externalBackup.choose')}
              </GlassButton>
            </div>
            {check && check.warnings.length > 0 && (
              <ul className="flex flex-col gap-1 text-[11.5px] text-warn">
                {check.warnings.map(w => (
                  <li key={w}>{t(`externalBackup.warning.${w}` as MessageKey)}</li>
                ))}
              </ul>
            )}

            <fieldset className="flex flex-col gap-1.5" disabled={working}>
              <legend className="mb-1 text-[12px] text-fg-2">{t('externalBackup.content')}</legend>
              {[...DEFAULT_PARTS, ...OPTIONAL_PARTS].map(part => (
                <label key={part} className="flex items-center gap-2 text-[12.5px] text-fg-2">
                  <input
                    type="checkbox"
                    checked={state.settings.parts.includes(part)}
                    onChange={event => options(event.target.checked ? [...state.settings.parts, part] : state.settings.parts.filter(p => p !== part))}
                  />
                  {t(`externalBackup.part.${part}` as MessageKey)}
                </label>
              ))}
            </fieldset>

            <div className="rounded-lg bg-white/5 px-3 py-2 text-[11.5px] text-fg-3">
              {estimate ? t('externalBackup.estimate', { size: formatBytes(estimate.bytes), files: estimate.files }) : t('externalBackup.measuring')}
              {estimate && (
                <details className="mt-1">
                  <summary className="cursor-pointer text-fg-2">{t('externalBackup.excluded')}</summary>
                  <ul className="mt-1 list-disc pl-5">
                    {estimate.excluded.map(item => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </details>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <span className="flex items-center gap-2 text-[12.5px] text-fg-2">
                <Toggle checked={state.settings.auto.enabled} disabled={!destination} onChange={enabled => options(state.settings.parts, { ...state.settings.auto, enabled })} label={t('externalBackup.auto')} />
                {t('externalBackup.auto')}
              </span>
              <label className="flex items-center gap-2 text-[12.5px] text-fg-2">
                {t('externalBackup.every')}
                <select
                  value={state.settings.auto.everyHours}
                  onChange={event => options(state.settings.parts, { ...state.settings.auto, everyHours: Number(event.target.value) })}
                  className="glass-input h-8 rounded-lg px-2 text-[12px] outline-none"
                >
                  {HOURS.map(h => (
                    <option key={h} value={h}>
                      {t('externalBackup.hours', { hours: h })}
                    </option>
                  ))}
                </select>
              </label>
              <span className="flex-1" />
              {working ? (
                <GlassButton size="sm" variant="danger" disabled={progress?.operation !== 'backup'} onClick={() => void window.jarodOS.externalBackup.cancel()}>
                  <IconPlayerStop />
                  {t('externalBackup.cancel')}
                </GlassButton>
              ) : (
                <GlassButton size="sm" variant="primary" disabled={!destination || state.destinationStatus !== 'ok' || check?.ok === false || restarting} onClick={() => void run()}>
                  <IconDeviceFloppy />
                  {t('externalBackup.now')}
                </GlassButton>
              )}
            </div>
            {state.settings.auto.enabled && state.deferred && <p className="text-[12px] text-warn">{t(`externalBackup.deferred.${state.deferred}` as MessageKey)}</p>}
            {check && !check.ok && <p className="text-[12px] text-danger">{describe(check.problems[0] ?? 'other')}</p>}

            {working && progress && (
              <div className="flex flex-col gap-1" role="status" aria-live="polite">
                <div className="flex justify-between text-[11.5px] text-fg-2">
                  <span>{t(`externalBackup.phase.${progress.phase}` as MessageKey)}</span>
                  <span className="tabular-nums">{progress.total > 0 ? `${formatBytes(progress.done)} / ${formatBytes(progress.total)}` : ''}</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
                  <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${progress.total > 0 ? Math.min(100, (progress.done / progress.total) * 100) : 0}%` }} />
                </div>
                <div className="truncate font-mono text-[10.5px] text-fg-4" title={progress.current}>
                  {progress.current}
                </div>
              </div>
            )}

            {error && <p className="text-[12.5px] text-danger">{error}</p>}
            {restarting && <p className="text-[12.5px] text-ok">{t('externalBackup.restored')}</p>}
            {state.last && !working && (
              <p className={`text-[12px] ${state.last.ok ? 'text-fg-3' : 'text-danger'}`}>
                {state.last.ok
                  ? t('externalBackup.lastOk', { when: new Date(state.last.at).toLocaleString(dateLocale(), { dateStyle: 'medium', timeStyle: 'short' }) })
                  : t('externalBackup.lastFailed', { when: new Date(state.last.at).toLocaleString(dateLocale(), { dateStyle: 'medium', timeStyle: 'short' }), reason: describe(state.last.message) })}
              </p>
            )}

            {destination && state.destinationStatus === 'ok' && (
              <>
                <div className="mt-1 text-[12px] font-medium text-fg-2">{t('externalBackup.onDisk')}</div>
                {state.list.length === 0 ? (
                  <p className="text-[12.5px] text-fg-3">{t('externalBackup.none')}</p>
                ) : (
                  <ul className="flex flex-col divide-y divide-line">
                    {state.list.map(item => (
                      <ExternalRow key={item.folder} item={item} mine={item.instance === state.instance} disabled={working || restarting} confirming={confirm === item.folder} onConfirm={setConfirm} onRestore={() => void restore(item.folder)} />
                    ))}
                  </ul>
                )}
              </>
            )}
          </>
        )}
      </GlassCard>
    </SettingsBlock>
  )
}

function ExternalRow({ item, mine, disabled, confirming, onConfirm, onRestore }: { item: ExternalBackupSummary; mine: boolean; disabled: boolean; confirming: boolean; onConfirm: (folder: string | null) => void; onRestore: () => void }) {
  const { t } = useT()
  const when = new Date(item.created).toLocaleString(dateLocale(), { dateStyle: 'medium', timeStyle: 'short' })

  return (
    <li className="flex flex-col gap-2 py-2">
      <div className="flex items-center gap-3">
        <IconHistory size={15} className="shrink-0 text-fg-3" />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] text-fg">
            {when} <span className="text-[11.5px] text-fg-3">· {t(`externalBackup.reason.${item.reason}` as MessageKey)}{mine ? '' : ` · ${t('externalBackup.otherInstall')}`}</span>
          </div>
          <div className="text-[11.5px] text-fg-3">{t('externalBackup.size', { files: item.files, size: formatBytes(item.bytes), parts: item.parts.map(p => t(`externalBackup.part.${p}` as MessageKey)).join(', ') })}</div>
        </div>
        <GlassButton size="sm" variant="ghost" disabled={disabled} onClick={() => onConfirm(item.folder)}>
          {t('externalBackup.restore')}
        </GlassButton>
      </div>
      {confirming && (
        <div className="flex flex-col gap-2 rounded-lg bg-white/5 px-3 py-2 text-[12.5px] text-fg-2">
          <span>{t('externalBackup.confirmRestore')}</span>
          <div className="flex justify-end gap-2">
            <GlassButton size="sm" variant="ghost" onClick={() => onConfirm(null)}>
              {t('externalBackup.keep')}
            </GlassButton>
            <GlassButton size="sm" variant="primary" disabled={disabled} onClick={onRestore}>
              {t('externalBackup.restoreNow')}
            </GlassButton>
          </div>
        </div>
      )}
    </li>
  )
}
