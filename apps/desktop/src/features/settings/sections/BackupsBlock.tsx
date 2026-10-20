import { IconArchive, IconHistory, IconTrash } from '@tabler/icons-react'
import { useCallback, useEffect, useState } from 'react'
import type { BackupInfo, BackupsState } from '../../../../shared/backups.ts'
import { GlassButton, GlassCard, Toggle } from '../../../components/ui/glass.tsx'
import { Spinner } from '../../../components/ui/primitives.tsx'
import { formatBytes } from '../../../lib/format.ts'
import { dateLocale, type MessageKey, useT } from '../../../lib/i18n.ts'
import { SettingsBlock } from './shared.tsx'

const KEEP = [3, 5, 7, 10, 14, 30]

/**
 * Backups of the Jarod disk (electron/backups.ts): daily at startup or by hand, the newest ones kept. A restore puts a
 * backup back after keeping the current state aside, then Jarod-OS restarts. Without a Jarod disk there is nowhere
 * to keep them, and this says so.
 */
export function BackupsBlock() {
  const { t } = useT()
  const [state, setState] = useState<BackupsState | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<{ id: string; action: 'restore' | 'remove'; workspace: boolean } | null>(null)
  const [restarting, setRestarting] = useState(false)

  const refresh = useCallback(() => {
    void window.jarodOS.backups
      .state()
      .then(setState)
      .catch(() => undefined)
  }, [])

  useEffect(refresh, [refresh])

  const describe = (reason: string) => (['no-disk', 'busy'].includes(reason) ? t(`backups.error.${reason}` as MessageKey) : t('backups.error.other', { detail: reason }))

  const create = async () => {
    setBusy(true)
    setError(null)
    const result = await window.jarodOS.backups.create().catch((reason: unknown) => ({ ok: false as const, error: String(reason) }))

    if (!result.ok) {
      setError(describe(result.error))
    }

    setBusy(false)
    refresh()
  }

  const act = async () => {
    if (!confirm) {
      return
    }

    setBusy(true)
    setError(null)
    const result =
      confirm.action === 'restore'
        ? await window.jarodOS.backups.restore(confirm.id, confirm.workspace).catch((reason: unknown) => ({ ok: false as const, error: String(reason) }))
        : await window.jarodOS.backups.remove(confirm.id).catch((reason: unknown) => ({ ok: false as const, error: String(reason) }))

    if (!result.ok) {
      setError(describe(result.error))
    } else if (confirm.action === 'restore') {
      setRestarting(true)
    }

    setConfirm(null)
    setBusy(false)
    refresh()
  }

  const save = (daily: boolean, keep: number) => {
    void window.jarodOS.backups
      .settings(daily, keep)
      .then(setState)
      .catch(() => undefined)
  }

  return (
    <SettingsBlock title={t('backups.title')} label={t('backups.title')} description={t('backups.text')} keywords={t('backups.keywords')}>
      <GlassCard className="flex flex-col gap-3 p-4">
        <p className="text-[12.5px] text-fg-3">{t('backups.text')}</p>

        {state && !state.available ? (
          <p className="text-[12.5px] text-fg-2">{t('backups.needsDisk')}</p>
        ) : !state ? (
          <Spinner />
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <Toggle checked={state.daily} onChange={daily => save(daily, state.keep)} label={t('backups.daily')} />
              <label className="flex items-center gap-2 text-[12.5px] text-fg-2">
                {t('backups.keep')}
                <select value={state.keep} onChange={event => save(state.daily, Number(event.target.value))} className="glass-input h-8 rounded-lg px-2 text-[12px] outline-none">
                  {[...new Set([...KEEP, state.keep])]
                    .sort((a, b) => a - b)
                    .map(value => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                </select>
              </label>
              <span className="flex-1" />
              <GlassButton variant="primary" size="sm" disabled={busy || state.running} onClick={() => void create()}>
                {busy || state.running ? <Spinner /> : <IconArchive />}
                {busy || state.running ? t('backups.running') : t('backups.now')}
              </GlassButton>
            </div>

            {error && <p className="text-[12.5px] text-danger">{error}</p>}
            {restarting && <p className="text-[12.5px] text-ok">{t('backups.restored')}</p>}

            {state.list.length === 0 ? (
              <p className="text-[12.5px] text-fg-3">{t('backups.none')}</p>
            ) : (
              <ul className="flex flex-col divide-y divide-line">
                {state.list.map(backup => (
                  <BackupRow key={backup.id} backup={backup} disabled={busy || state.running || restarting} confirm={confirm?.id === backup.id ? confirm : null} onConfirm={setConfirm} onAct={() => void act()} />
                ))}
              </ul>
            )}
            {state.folder && <p className="selectable font-mono text-[11px] text-fg-4">{state.folder}</p>}
          </>
        )}
      </GlassCard>
    </SettingsBlock>
  )
}

function BackupRow({
  backup,
  disabled,
  confirm,
  onConfirm,
  onAct
}: {
  backup: BackupInfo
  disabled: boolean
  confirm: { id: string; action: 'restore' | 'remove'; workspace: boolean } | null
  onConfirm: (next: { id: string; action: 'restore' | 'remove'; workspace: boolean } | null) => void
  onAct: () => void
}) {
  const { t } = useT()
  const when = new Date(backup.created).toLocaleString(dateLocale(), { dateStyle: 'medium', timeStyle: 'short' })

  return (
    <li className="flex flex-col gap-2 py-2">
      <div className="flex items-center gap-3">
        <IconHistory size={15} className="shrink-0 text-fg-3" />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] text-fg">
            {when} <span className="text-[11.5px] text-fg-3">· {t(`backups.reason.${backup.reason}` as MessageKey)}</span>
          </div>
          <div className="text-[11.5px] text-fg-3">{t('backups.size', { files: backup.files, size: formatBytes(backup.bytes), linked: backup.linked })}</div>
        </div>
        <GlassButton size="sm" variant="ghost" disabled={disabled} onClick={() => onConfirm({ id: backup.id, action: 'restore', workspace: false })}>
          {t('backups.restore')}
        </GlassButton>
        <GlassButton size="icon" variant="ghost" aria-label={t('backups.remove')} disabled={disabled} onClick={() => onConfirm({ id: backup.id, action: 'remove', workspace: false })}>
          <IconTrash />
        </GlassButton>
      </div>
      {confirm && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg bg-white/5 px-3 py-2 text-[12.5px] text-fg-2">
          <span className="flex-1">{confirm.action === 'restore' ? t('backups.confirmRestore') : t('backups.confirmRemove')}</span>
          {confirm.action === 'restore' && backup.parts.includes('workspace') && (
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={confirm.workspace} onChange={event => onConfirm({ ...confirm, workspace: event.target.checked })} />
              {t('backups.withWorkspace')}
            </label>
          )}
          <GlassButton size="sm" variant="ghost" onClick={() => onConfirm(null)}>
            {t('backups.cancel')}
          </GlassButton>
          <GlassButton size="sm" variant={confirm.action === 'remove' ? 'danger' : 'primary'} disabled={disabled} onClick={onAct}>
            {confirm.action === 'restore' ? t('backups.restoreNow') : t('backups.removeNow')}
          </GlassButton>
        </div>
      )}
    </li>
  )
}
