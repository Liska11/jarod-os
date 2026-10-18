import { IconAlertTriangle, IconCheck, IconDeviceFloppy, IconFolder } from '@tabler/icons-react'
import { useEffect, useState } from 'react'
import type { DataDiskApplyResult, DataDiskState, DriveInfo } from '../../../shared/data-disk.ts'
import { GlassButton } from '../../components/ui/glass.tsx'
import { Spinner } from '../../components/ui/primitives.tsx'
import { cn } from '../../lib/cn.ts'
import { formatBytes } from '../../lib/format.ts'
import { type MessageKey, useT } from '../../lib/i18n.ts'
import { diskErrorKey, recommendedDrive, rootForDrive } from './data-disk-model.ts'

/**
 * Choosing Jarod-OS's own disk (docs/JAROD-DISK.md), at first run and in Settings: the drives with their free space and
 * what to watch for, the folder Jarod-OS will use there, and whether to copy the current data in. Applying restarts
 * Jarod-OS on the new disk; the old folders stay where they were. Nothing is formatted or erased.
 */
export function DataDiskPicker({ compact = false }: { compact?: boolean }) {
  const { t } = useT()
  const [state, setState] = useState<DataDiskState | null>(null)
  const [drives, setDrives] = useState<DriveInfo[] | null>(null)
  const [drive, setDrive] = useState<DriveInfo | null>(null)
  const [root, setRoot] = useState('')
  const [move, setMove] = useState(true)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<DataDiskApplyResult | null>(null)

  useEffect(() => {
    void window.heraldOS.dataDisk
      .state()
      .then(setState)
      .catch(() => undefined)
    void window.heraldOS.dataDisk
      .drives()
      .then(list => {
        setDrives(list)
        const best = recommendedDrive(list)

        if (best) {
          setDrive(best)
          setRoot(best.suggestedRoot)
        }
      })
      .catch(() => setDrives([]))
  }, [])

  const choose = (next: DriveInfo) => {
    setRoot(rootForDrive(next, root, drive))
    setDrive(next)
    setResult(null)
  }

  const browse = async () => {
    const [folder] = await window.heraldOS.fs.pickFiles({ directory: true }).catch(() => [])

    if (folder) {
      setRoot(folder)
      setResult(null)
    }
  }

  const apply = async () => {
    setBusy(true)
    setResult(null)

    try {
      setResult(await window.heraldOS.dataDisk.apply(root.trim(), move))
    } catch (reason) {
      setResult({ ok: false, error: reason instanceof Error ? reason.message : String(reason) })
    } finally {
      setBusy(false)
    }
  }

  const current = state?.kind === 'root' ? state.root : null

  return (
    <div className="flex flex-col gap-3">
      {state?.kind === 'missing' && (
        <p className="flex items-start gap-2 rounded-lg bg-warn/12 px-3 py-2 text-[12.5px] text-warn">
          <IconAlertTriangle size={15} className="mt-0.5 shrink-0" />
          {t('disk.missing', { root: state.root })}
        </p>
      )}
      {state && (
        <p className="text-[12px] text-fg-3">
          {current ? t('disk.current.root', { root: current }) : t('disk.current.default')}{' '}
          <span className="selectable font-mono text-[11.5px] text-fg-2">{current ?? state.dataDir}</span>
        </p>
      )}

      {drives === null ? (
        <div className="flex items-center gap-2 text-[12.5px] text-fg-3">
          <Spinner /> {t('disk.reading')}
        </div>
      ) : drives.length === 0 ? (
        <p className="text-[12.5px] text-fg-3">{t('disk.noDrives')}</p>
      ) : (
        <div className={cn('grid gap-2', compact ? 'grid-cols-1' : 'grid-cols-2')} role="radiogroup" aria-label={t('disk.drives')}>
          {drives.map(item => {
            const on = drive?.letter === item.letter

            return (
              // biome-ignore lint/a11y/useSemanticElements: a card-like radio with the drive's details
              <button
                key={item.letter}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => choose(item)}
                className={cn('glass-input flex flex-col items-start gap-1 rounded-xl p-3 text-left', on ? 'border-accent-strong bg-accent/15 ring-1 ring-accent-strong' : 'hover:border-line-strong')}
              >
                <span className="flex w-full items-center gap-2 text-[13.5px] font-medium text-fg">
                  <IconDeviceFloppy size={15} />
                  {item.letter} {item.label && <span className="truncate text-fg-2">{item.label}</span>}
                  <span className="flex-1" />
                  <span className="text-[11px] font-normal text-fg-3">{item.fileSystem}</span>
                </span>
                <span className="text-[11.5px] text-fg-3">{t('disk.free', { free: formatBytes(item.free), size: formatBytes(item.size) })}</span>
                {item.warnings.length > 0 && (
                  <span className="flex flex-wrap gap-1">
                    {item.warnings.map(warning => (
                      <span key={warning} className="rounded bg-warn/12 px-1.5 py-0.5 text-[10.5px] text-warn">
                        {t(`disk.warning.${warning}` as MessageKey)}
                      </span>
                    ))}
                  </span>
                )}
              </button>
            )
          })}
        </div>
      )}

      <div className="flex items-center gap-2">
        <input
          value={root}
          onChange={event => {
            setRoot(event.target.value)
            setResult(null)
          }}
          aria-label={t('disk.folder')}
          placeholder="D:\Jarod-OS"
          spellCheck={false}
          className="glass-input h-9 min-w-0 flex-1 rounded-lg px-3 font-mono text-[12.5px] outline-none"
        />
        <GlassButton size="sm" onClick={() => void browse()}>
          <IconFolder />
          {t('disk.browse')}
        </GlassButton>
      </div>

      <label className="flex items-start gap-2 text-[12.5px] text-fg-2">
        <input type="checkbox" checked={move} onChange={event => setMove(event.target.checked)} className="mt-0.5" />
        <span>
          {t('disk.move')}
          <span className="block text-[11.5px] text-fg-3">{t('disk.move.hint')}</span>
        </span>
      </label>

      {result && !result.ok && <p className="text-[12.5px] text-danger">{describeError(result.error, t)}</p>}
      {result?.ok && (
        <p className="flex items-start gap-2 rounded-lg bg-ok/12 px-3 py-2 text-[12.5px] text-ok">
          <IconCheck size={15} className="mt-0.5 shrink-0" />
          <span>
            {result.adopted ? t('disk.done.adopted', { root: result.root }) : t('disk.done.moved', { root: result.root, files: result.copied.files, size: formatBytes(result.copied.bytes) })}
            {result.oldCopies.length > 0 && <span className="mt-1 block text-fg-2">{t('disk.done.oldCopies', { folders: result.oldCopies.join(' · ') })}</span>}
            <span className="mt-1 block text-fg-2">{t('disk.done.restarting')}</span>
          </span>
        </p>
      )}

      <div className="flex justify-end">
        <GlassButton variant="primary" disabled={busy || !root.trim() || result?.ok === true} onClick={() => void apply()}>
          {busy ? <Spinner /> : <IconDeviceFloppy />}
          {busy ? t(move ? 'disk.applying.move' : 'disk.applying') : t('disk.apply')}
        </GlassButton>
      </div>
    </div>
  )
}

function describeError(error: string, t: (key: MessageKey, vars?: Record<string, string | number>) => string): string {
  const { key, detail } = diskErrorKey(error)

  return detail ? t(key, { detail }) : t(key)
}
