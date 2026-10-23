import { IconLock } from '@tabler/icons-react'
import { useCallback, useEffect, useState } from 'react'
import type { ExternalState, ResticSnapshot } from '../../../../shared/external-backup.ts'
import { GlassButton, Toggle } from '../../../components/ui/glass.tsx'
import { dateLocale, type MessageKey, useT } from '../../../lib/i18n.ts'

/**
 * G4 (2026-10-21) : l'archive chiffrée restic, SOUS la sauvegarde externe. Chaque sauvegarde réussie y est archivée (dédupliquée, chiffrée).
 * La clé est rangée par Windows (DPAPI) et ne passe jamais par cet écran : on ne voit que son empreinte ; la feuille de récupération est
 * écrite par la boîte native de l'application. Restaurer un instantané passe par le même moteur que les sauvegardes ci-dessus.
 */
export function ResticArchiveBlock({ state, working, refresh, onRestarting }: { state: ExternalState; working: boolean; refresh: () => void; onRestarting: () => void }) {
  const { t } = useT()
  const r = state.restic
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const [snapshots, setSnapshots] = useState<ResticSnapshot[] | null>(null)
  const [confirm, setConfirm] = useState<string | null>(null)

  const describe = (error: string) => {
    const key = `restic.error.${error.split(':')[0]}` as MessageKey

    return t(key) !== key ? t(key) : t('restic.error.other', { detail: error })
  }

  const loadSnapshots = useCallback(() => {
    if (!r.enabled) {
      setSnapshots(null)

      return
    }

    void window.jarodOS.externalBackup.restic
      .list()
      .then(setSnapshots)
      .catch(() => setSnapshots([]))
  }, [r.enabled])

  useEffect(() => {
    loadSnapshots()
  }, [loadSnapshots, state.last?.at])

  const act = async (fn: () => Promise<{ ok: boolean; error?: string }>, done: (result: { ok: boolean; error?: string }) => string | null) => {
    setBusy(true)
    setMessage(null)

    try {
      const result = await fn()
      const text = result.ok ? done(result) : describe(result.error ?? 'other')

      if (text) setMessage({ ok: result.ok, text })
    } finally {
      setBusy(false)
      refresh()
    }
  }

  const toggle = (on: boolean) =>
    void act(
      () => (on ? window.jarodOS.externalBackup.restic.enable() : window.jarodOS.externalBackup.restic.disable()),
      result => (on ? ((result as { sheetSaved?: boolean }).sheetSaved ? t('restic.enabledWithSheet') : t('restic.enabled')) : null)
    )

  const restore = (id: string) =>
    void act(
      () => window.jarodOS.externalBackup.restic.restore(id),
      () => {
        onRestarting()

        return null
      }
    ).finally(() => setConfirm(null))

  if (!r.available && !r.enabled) {
    return <p className="text-[12px] text-fg-3">{t(`restic.unavailable.${r.reason ?? 'no-restic'}` as MessageKey)}</p>
  }

  const disabled = busy || working

  return (
    <div className="mt-2 flex flex-col gap-2 rounded-lg border border-line p-3" data-testid="restic-archive">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <IconLock size={15} />
          <div>
            <div className="text-[12.5px] font-medium text-fg">{t('restic.title')}</div>
            <div className="text-[11.5px] text-fg-3">{t('restic.text')}</div>
          </div>
        </div>
        <Toggle checked={r.enabled} disabled={disabled} onChange={toggle} label={t('restic.toggle')} />
      </div>

      {r.enabled && (
        <>
          <div className="text-[11.5px] text-fg-3">
            {t('restic.key', { fingerprint: r.keyFingerprint ?? '—' })} · <span className="font-mono">{r.repo}</span>
          </div>
          {!r.sheetSaved && (
            <div className="flex items-center justify-between gap-2 rounded-md bg-warn/10 px-2 py-1.5 text-[12px] text-warn">
              <span>{t('restic.sheetMissing')}</span>
              <GlassButton size="sm" variant="primary" disabled={disabled} onClick={() => void act(() => window.jarodOS.externalBackup.restic.saveSheet(), () => t('restic.sheetSaved'))}>
                {t('restic.saveSheet')}
              </GlassButton>
            </div>
          )}
          {r.sheetSaved && (
            <div className="flex items-center justify-between gap-2 text-[12px] text-fg-3">
              <span>{t('restic.sheetDone')}</span>
              <GlassButton size="sm" variant="ghost" disabled={disabled} onClick={() => void act(() => window.jarodOS.externalBackup.restic.saveSheet(), () => t('restic.sheetSaved'))}>
                {t('restic.saveSheetAgain')}
              </GlassButton>
            </div>
          )}
          {r.last && (
            <p className={`text-[12px] ${r.last.ok ? 'text-fg-3' : 'text-danger'}`}>
              {r.last.ok
                ? t('restic.lastOk', { when: new Date(r.last.at).toLocaleString(dateLocale(), { dateStyle: 'medium', timeStyle: 'short' }) })
                : t('restic.lastFailed', { when: new Date(r.last.at).toLocaleString(dateLocale(), { dateStyle: 'medium', timeStyle: 'short' }), reason: r.last.message })}
            </p>
          )}
          <div className="flex items-center justify-between">
            <div className="text-[12px] font-medium text-fg-2">{t('restic.snapshots')}</div>
            <GlassButton size="sm" variant="ghost" disabled={disabled} onClick={() => void act(() => window.jarodOS.externalBackup.restic.check(), () => t('restic.checkOk'))}>
              {t('restic.check')}
            </GlassButton>
          </div>
          {snapshots && snapshots.length === 0 && <p className="text-[12px] text-fg-3">{t('restic.noSnapshots')}</p>}
          {snapshots && snapshots.length > 0 && (
            <ul className="flex flex-col divide-y divide-line">
              {snapshots.map(s => (
                <li key={s.id} className="flex flex-col gap-1 py-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[12.5px] text-fg">
                      {new Date(s.time).toLocaleString(dateLocale(), { dateStyle: 'medium', timeStyle: 'short' })}{' '}
                      <span className="font-mono text-[11px] text-fg-4">{s.id.slice(0, 8)}</span>
                    </span>
                    <GlassButton size="sm" variant="ghost" disabled={disabled} onClick={() => setConfirm(s.id)}>
                      {t('restic.restore')}
                    </GlassButton>
                  </div>
                  {confirm === s.id && (
                    <div className="flex items-center justify-between gap-2 text-[12px] text-warn">
                      <span>{t('restic.confirmRestore')}</span>
                      <div className="flex gap-1.5">
                        <GlassButton size="sm" variant="ghost" onClick={() => setConfirm(null)}>
                          {t('restic.keep')}
                        </GlassButton>
                        <GlassButton size="sm" variant="primary" disabled={disabled} onClick={() => restore(s.id)}>
                          {t('restic.restoreNow')}
                        </GlassButton>
                      </div>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {message && <p className={`text-[12px] ${message.ok ? 'text-ok' : 'text-danger'}`}>{message.text}</p>}
    </div>
  )
}
