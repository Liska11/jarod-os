import { IconArrowsDiff, IconBox, IconFolderOpen, IconTrash } from '@tabler/icons-react'
import { useCallback, useEffect, useState } from 'react'
import type { SandboxChangeInfo, SandboxesState, SandboxSummary } from '../../../../shared/sandboxes.ts'
import { GlassButton, GlassCard } from '../../../components/ui/glass.tsx'
import { Spinner } from '../../../components/ui/primitives.tsx'
import { cn } from '../../../lib/cn.ts'
import { dateLocale, type MessageKey, useT } from '../../../lib/i18n.ts'
import { showPage } from '../../../store/windows.ts'
import { navigate } from '../../files/files-store.ts'
import { SettingsBlock } from './shared.tsx'

const KIND_TONE: Record<SandboxChangeInfo['kind'], string> = { added: 'text-ok', modified: 'text-warn', removed: 'text-danger' }

/**
 * Sandboxes of the Jarod disk (electron/sandboxes.ts): a copy of a project to try things in, opened in Files,
 * compared with the project, its changes applied (all or some), or thrown away to the Recycle Bin.
 */
export function SandboxesBlock() {
  const { t } = useT()
  const [state, setState] = useState<SandboxesState | null>(null)
  const [source, setSource] = useState('')
  const [label, setLabel] = useState('')
  const [full, setFull] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(() => {
    void window.jarodOS.sandboxes
      .state()
      .then(setState)
      .catch(() => undefined)
  }, [])

  useEffect(refresh, [refresh])

  const describe = (reason: string) =>
    ['no-disk', 'busy', 'not-a-folder', 'overlaps', 'not-a-sandbox'].includes(reason) ? t(`sandboxes.error.${reason}` as MessageKey) : /protected|home folder/.test(reason) ? t('sandboxes.error.notEditable') : t('sandboxes.error.other', { detail: reason })

  const pick = async () => {
    const [folder] = await window.jarodOS.fs.pickFiles({ directory: true }).catch(() => [])

    if (folder) setSource(folder)
  }

  const create = async () => {
    setBusy(true)
    setError(null)
    const result = await window.jarodOS.sandboxes.create(source, label, full).catch((reason: unknown) => ({ ok: false as const, error: String(reason) }))

    if (result.ok) {
      setSource('')
      setLabel('')
    } else {
      setError(describe(result.error))
    }

    setBusy(false)
    refresh()
  }

  return (
    <SettingsBlock title={t('sandboxes.title')} label={t('sandboxes.title')} description={t('sandboxes.text')} keywords={t('sandboxes.keywords')}>
      <GlassCard className="flex flex-col gap-3 p-4">
        <p className="text-[12.5px] text-fg-3">{t('sandboxes.text')}</p>

        {state && !state.available ? (
          <p className="text-[12.5px] text-fg-2">{t('sandboxes.needsDisk')}</p>
        ) : !state ? (
          <Spinner />
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <GlassButton size="sm" onClick={() => void pick()}>
                <IconFolderOpen />
                {source ? source.split(/[\\/]/).pop() : t('sandboxes.pick')}
              </GlassButton>
              <input value={label} onChange={event => setLabel(event.target.value)} placeholder={t('sandboxes.name')} aria-label={t('sandboxes.name')} className="glass-input h-8 w-44 rounded-lg px-2.5 text-[12.5px] outline-none" />
              <label className="flex items-center gap-1.5 text-[12px] text-fg-2">
                <input type="checkbox" checked={full} onChange={event => setFull(event.target.checked)} />
                {t('sandboxes.full')}
              </label>
              <span className="flex-1" />
              <GlassButton size="sm" variant="primary" disabled={!source || busy || state.busy} onClick={() => void create()}>
                {busy ? <Spinner /> : <IconBox />}
                {busy ? t('sandboxes.creating') : t('sandboxes.create')}
              </GlassButton>
            </div>
            {source && <p className="selectable font-mono text-[11px] text-fg-3">{source}</p>}
            {error && <p className="text-[12.5px] text-danger">{error}</p>}

            {state.list.length === 0 ? (
              <p className="text-[12.5px] text-fg-3">{t('sandboxes.none')}</p>
            ) : (
              <ul className="flex flex-col divide-y divide-line">
                {state.list.map(sandbox => (
                  <SandboxRow key={sandbox.name} sandbox={sandbox} folder={state.folder ?? ''} describe={describe} onChanged={refresh} />
                ))}
              </ul>
            )}
          </>
        )}
      </GlassCard>
    </SettingsBlock>
  )
}

function SandboxRow({ sandbox, folder, describe, onChanged }: { sandbox: SandboxSummary; folder: string; describe: (reason: string) => string; onChanged: () => void }) {
  const { t } = useT()
  const [changes, setChanges] = useState<SandboxChangeInfo[] | null>(null)
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState<'compare' | 'apply' | 'remove' | null>(null)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const path = `${folder}\\${sandbox.name}`

  const compare = async () => {
    setBusy('compare')
    setNote(null)
    const result = await window.jarodOS.sandboxes.compare(sandbox.name).catch((reason: unknown) => ({ ok: false as const, error: String(reason) }))
    setBusy(null)

    if (!result.ok) {
      setNote(describe(result.error))

      return
    }

    setChanges(result.changes ?? [])
    setChosen(new Set((result.changes ?? []).map(change => change.path)))
  }

  const apply = async () => {
    setBusy('apply')
    const result = await window.jarodOS.sandboxes.apply(sandbox.name, [...chosen]).catch((reason: unknown) => ({ ok: false as const, error: String(reason) }))
    setBusy(null)
    setNote(result.ok ? t('sandboxes.applied', { count: result.changes?.length ?? 0 }) : describe(result.error))

    if (result.ok) {
      setChanges(null)
    }
  }

  const remove = async () => {
    setBusy('remove')
    const result = await window.jarodOS.sandboxes.remove(sandbox.name).catch((reason: unknown) => ({ ok: false as const, error: String(reason) }))
    setBusy(null)
    setConfirmRemove(false)

    if (!result.ok) setNote(describe(result.error))

    onChanged()
  }

  const open = () => {
    navigate({ kind: 'dir', path })
    showPage('files')
  }

  return (
    <li className="flex flex-col gap-2 py-2">
      <div className="flex items-center gap-3">
        <IconBox size={15} className="shrink-0 text-fg-3" />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] text-fg">{sandbox.name}</div>
          <div className="truncate text-[11.5px] text-fg-3" title={sandbox.source}>
            {t('sandboxes.from', { source: sandbox.source, date: new Date(sandbox.created).toLocaleDateString(dateLocale(), { dateStyle: 'medium' }) })}
          </div>
        </div>
        <GlassButton size="sm" variant="ghost" onClick={open}>
          <IconFolderOpen />
          {t('sandboxes.open')}
        </GlassButton>
        <GlassButton size="sm" variant="ghost" disabled={busy !== null} onClick={() => void compare()}>
          {busy === 'compare' ? <Spinner /> : <IconArrowsDiff />}
          {t('sandboxes.compare')}
        </GlassButton>
        <GlassButton size="icon" variant="ghost" aria-label={t('sandboxes.remove')} disabled={busy !== null} onClick={() => setConfirmRemove(true)}>
          <IconTrash />
        </GlassButton>
      </div>

      {confirmRemove && (
        <div className="flex items-center gap-3 rounded-lg bg-white/5 px-3 py-2 text-[12.5px] text-fg-2">
          <span className="flex-1">{t('sandboxes.confirmRemove')}</span>
          <GlassButton size="sm" variant="ghost" onClick={() => setConfirmRemove(false)}>
            {t('backups.cancel')}
          </GlassButton>
          <GlassButton size="sm" variant="danger" disabled={busy !== null} onClick={() => void remove()}>
            {t('sandboxes.removeNow')}
          </GlassButton>
        </div>
      )}

      {changes && (
        <div className="flex flex-col gap-2 rounded-lg bg-white/5 px-3 py-2">
          {changes.length === 0 ? (
            <p className="text-[12.5px] text-fg-3">{t('sandboxes.noChanges')}</p>
          ) : (
            <>
              <ul className="max-h-56 overflow-y-auto">
                {changes.map(change => (
                  <li key={change.path}>
                    <label className="flex items-center gap-2 py-0.5 text-[12px]">
                      <input
                        type="checkbox"
                        checked={chosen.has(change.path)}
                        onChange={event => {
                          const next = new Set(chosen)

                          event.target.checked ? next.add(change.path) : next.delete(change.path)
                          setChosen(next)
                        }}
                      />
                      <span className={cn('w-16 shrink-0 text-[11px]', KIND_TONE[change.kind])}>{t(`sandboxes.kind.${change.kind}` as MessageKey)}</span>
                      <span className="selectable truncate font-mono text-[11.5px] text-fg-2">{change.path}</span>
                    </label>
                  </li>
                ))}
              </ul>
              <div className="flex items-center gap-2">
                <span className="flex-1 text-[11.5px] text-fg-3">{t('sandboxes.applyHint')}</span>
                <GlassButton size="sm" variant="ghost" onClick={() => setChanges(null)}>
                  {t('backups.cancel')}
                </GlassButton>
                <GlassButton size="sm" variant="primary" disabled={chosen.size === 0 || busy !== null} onClick={() => void apply()}>
                  {busy === 'apply' ? <Spinner /> : null}
                  {t('sandboxes.apply', { count: chosen.size })}
                </GlassButton>
              </div>
            </>
          )}
        </div>
      )}
      {note && <p className="text-[12px] text-fg-2">{note}</p>}
    </li>
  )
}
