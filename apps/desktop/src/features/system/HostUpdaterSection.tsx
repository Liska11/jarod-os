import { IconArrowBackUp, IconCheck, IconPackageImport } from '@tabler/icons-react'
import { useEffect, useState } from 'react'
import { GlassButton, Pill } from '../../components/ui/glass.tsx'
import { Spinner } from '../../components/ui/primitives.tsx'
import { t, useT } from '../../lib/i18n.ts'

type View = Awaited<ReturnType<typeof window.jarodOS.hostUpdater.state>>
type Action = Awaited<ReturnType<typeof window.jarodOS.hostUpdater.install>>

/*
 * V-21 — Jarod-OS's own update, A/B, behind JAROD_HOST_UPDATER (electron/ipc/host-updater.ts). Hidden while the flag is off. Shows which slot
 * runs, the one on trial, the blocked versions; installs a signed bundle the person picks, and closes a trial either way.
 */
export function HostUpdaterSection() {
  useT()
  const [view, setView] = useState<View | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    void window.jarodOS.hostUpdater
      .state()
      .then(setView)
      .catch(() => undefined)
  }, [])

  if (!view?.enabled) return null

  const run = async (step: () => Promise<Action>) => {
    setBusy(true)
    setNote(null)
    const reply = await step().catch((cause: Error) => ({ ok: false as const, error: cause.message, view }))
    setBusy(false)
    if (reply.view) setView(reply.view)
    setNote(reply.ok ? { ok: true, text: reply.message ?? '' } : { ok: false, text: reply.error })
  }

  const state = view.state
  const current = state?.current ? state.slots[state.current] : null
  const trial = state?.pending ? state.slots[state.pending.slot] : null
  const previous = state?.previous ? state.slots[state.previous] : null

  return (
    <div role="region" aria-label={t('hostUpdater.title')} className="flex flex-col gap-2 rounded-lg border border-line p-3 text-[12px]">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[12.5px] font-medium text-fg">{t('hostUpdater.title')}</span>
        <Pill tone="muted">{t('hostUpdater.flag')}</Pill>
        <span className="flex-1" />
        <GlassButton size="sm" variant="ghost" disabled={busy || !view.binary || Boolean(trial)} onClick={() => void run(() => window.jarodOS.hostUpdater.install())}>
          {busy ? <Spinner /> : <IconPackageImport />}
          {t('hostUpdater.install')}
        </GlassButton>
      </div>
      {view.error && <p className="text-danger">{view.error}</p>}
      {state && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
          <dt className="text-fg-3">{t('hostUpdater.current')}</dt>
          <dd className="font-mono text-fg">{current ? `${current.version} (${state.current?.toUpperCase()})${current.validated ? '' : ` · ${t('hostUpdater.unvalidated')}`}` : t('hostUpdater.none')}</dd>
          <dt className="text-fg-3">{t('hostUpdater.previous')}</dt>
          <dd className="font-mono text-fg">{previous ? `${previous.version} (${state.previous?.toUpperCase()})` : t('hostUpdater.none')}</dd>
          {state.blocked.length > 0 && (
            <>
              <dt className="text-fg-3">{t('hostUpdater.blocked')}</dt>
              <dd className="font-mono text-fg">{state.blocked.join(', ')}</dd>
            </>
          )}
        </dl>
      )}
      {trial && (
        <div role="status" aria-label={t('hostUpdater.trialAria')} className="flex flex-wrap items-center gap-2 rounded border border-warn px-2 py-1.5">
          <span className="text-fg">{t('hostUpdater.trial', { version: trial.version })}</span>
          <span className="flex-1" />
          <GlassButton size="sm" variant="primary" disabled={busy} onClick={() => void run(() => window.jarodOS.hostUpdater.confirm())}>
            <IconCheck />
            {t('hostUpdater.confirm')}
          </GlassButton>
          <GlassButton size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => window.jarodOS.hostUpdater.rollback())}>
            <IconArrowBackUp />
            {t('hostUpdater.rollback')}
          </GlassButton>
        </div>
      )}
      {note && (
        <p role={note.ok ? 'status' : 'alert'} className={note.ok ? 'text-ok' : 'text-danger'}>
          {note.text}
        </p>
      )}
      <p className="text-[11.5px] text-fg-4">{t('hostUpdater.notes')}</p>
    </div>
  )
}
