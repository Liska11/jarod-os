import { IconExternalLink, IconRefresh, IconTerminal2 } from '@tabler/icons-react'
import { useEffect, useState } from 'react'
import { GlassButton, Pill, type PillTone } from '../../components/ui/glass.tsx'
import { Spinner } from '../../components/ui/primitives.tsx'
import { dateLocale, type MessageKey, t, useT } from '../../lib/i18n.ts'
import { $terminalRequest } from '../../store/terminal.ts'
import { openApp } from '../../store/windows.ts'

type State = Awaited<ReturnType<typeof window.heraldOS.updates.state>>
type Category = 'windows' | 'drivers' | 'software'

const TONE: Record<string, PillTone> = { 'up-to-date': 'ok', available: 'warn', failed: 'danger', unsupported: 'muted', unchecked: 'muted' }

/*
 * Système › Mises à jour (docs/UPDATES.md): a read-only check of Windows, drivers and the software winget knows. Nothing is installed from
 * here: Windows updates open in Windows' Settings; a software upgrade runs in a Terminal tab, one package at a time, chosen by the person.
 */
export function UpdatesPanel() {
  useT()
  const [state, setState] = useState<State | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void window.heraldOS.updates
      .state()
      .then(setState)
      .catch(() => undefined)
  }, [])

  const check = async () => {
    setBusy(true)
    setState(await window.heraldOS.updates.check().catch(() => state))
    setBusy(false)
  }

  const upgrade = (id: string, name: string) => {
    $terminalRequest.set({ winget: id, label: `winget · ${name}`, at: Date.now() })
    openApp('terminal')
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

      {(['windows', 'drivers', 'software'] as Category[]).map(category => {
        const result = report.categories[category]

        return (
          <div key={category} className="rounded-lg border border-line p-3">
            <div className="flex items-center gap-2">
              <span className="text-[12.5px] font-medium text-fg">{t(`updates.category.${category}` as MessageKey)}</span>
              <Pill tone={TONE[result.status] ?? 'muted'}>{t(`updates.status.${result.status}` as MessageKey, { count: result.items.length })}</Pill>
              <span className="flex-1" />
              {category !== 'software' && result.status === 'available' && (
                <GlassButton size="sm" variant="ghost" onClick={() => void window.heraldOS.updates.openWindowsUpdate()}>
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
                          {item.id} · {item.source}
                        </div>
                      </td>
                      <td className="py-1.5 pr-3 tabular-nums text-fg-2">{[item.current, item.available].filter(Boolean).join(' → ') || '—'}</td>
                      <td className="py-1.5 pr-3 text-fg-3">{[item.elevation ? t('updates.admin') : '', item.restart ? t('updates.restart') : ''].filter(Boolean).join(' · ')}</td>
                      <td className="py-1.5 text-right">
                        {item.source === 'winget' && (
                          <GlassButton size="sm" variant="ghost" disabled={state.offline} onClick={() => upgrade(item.id, item.name)}>
                            <IconTerminal2 />
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
