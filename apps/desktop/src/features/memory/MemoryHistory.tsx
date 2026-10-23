import { IconArrowBackUp, IconHistory, IconTrash } from '@tabler/icons-react'
import { useState } from 'react'
import { EmptyGlass, GlassButton, Pill } from '../../components/ui/glass.tsx'
import { type MessageKey, t, useT } from '../../lib/i18n.ts'
import { jarod } from '../../lib/jarod.ts'
import { useBackendData } from '../../lib/use-async.ts'
import { notify } from '../../store/notifications.ts'
import { describeChange, type MemoryChange } from './memory-history-model.ts'

/*
 * V-18: the memory's history, as the Jarod core keeps it — every addition, edit and removal, whoever made it (the agent, `refine`,
 * this page, an import). Each line shows what changed word by word and can be undone ("Restore"); undoing is itself a change in the
 * list. "Clear history" forgets the past versions for good (native confirmation in the core).
 */

const ACTION_LABEL: Record<MemoryChange['action'], MessageKey> = {
  add: 'memoryHistory.added',
  update: 'memoryHistory.edited',
  delete: 'memoryHistory.removed'
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err))

export function MemoryHistory({ onChanged }: { onChanged: () => void }) {
  useT()
  const history = useBackendData(() => jarod<MemoryChange[]>('memory-history', null, 200))
  const [busy, setBusy] = useState(false)

  const act = async (work: () => Promise<unknown>, done: string) => {
    setBusy(true)

    try {
      const result = await work()

      if (result !== false) {
        notify({ title: done, level: 'success' })
        onChanged()
      }
    } catch (err) {
      notify({ title: t('memoryHistory.failed'), body: errorText(err), level: 'error' })
    } finally {
      setBusy(false)
      history.reload()
    }
  }

  if (history.error) {
    return <EmptyGlass icon={<IconHistory />} title={t('memoryHistory.readFailed')} description={history.error} />
  }

  const rows = history.data ?? []

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-3" aria-label={t('memoryHistory.title')} data-testid="memory-history">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[12px] text-fg-3">{t('memoryHistory.hint')}</p>
        <GlassButton size="sm" variant="ghost" disabled={busy || rows.length === 0} onClick={() => void act(() => jarod('memory-history-purge'), t('memoryHistory.purged'))}>
          <IconTrash />
          {t('memoryHistory.purge')}
        </GlassButton>
      </div>
      {history.loading && rows.length === 0 ? null : rows.length === 0 ? (
        <EmptyGlass icon={<IconHistory />} title={t('memoryHistory.empty')} description={t('memoryHistory.empty.hint')} />
      ) : (
        <ol className="flex min-h-0 flex-col gap-2 overflow-y-auto">
          {rows.map(change => {
            const { parts, typeChange } = describeChange(change)

            return (
              <li key={change.seq} className="glass rounded-xl px-3.5 py-2.5" data-testid={`memory-change-${change.seq}`} data-action={change.action}>
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-[12px] text-fg-3">
                    <Pill tone={change.action === 'delete' ? 'danger' : change.action === 'add' ? 'ok' : 'muted'}>{t(ACTION_LABEL[change.action])}</Pill>
                    <time dateTime={new Date(change.at).toISOString()}>{new Date(change.at).toLocaleString()}</time>
                    {typeChange && <span>{t('memoryHistory.type', { from: typeChange.from, to: typeChange.to })}</span>}
                  </div>
                  <GlassButton size="sm" variant="ghost" disabled={busy} onClick={() => void act(() => jarod('memory-restore', change.seq), t('memoryHistory.restored'))} aria-label={t('memoryHistory.restore.aria')}>
                    <IconArrowBackUp />
                    {t('memoryHistory.restore')}
                  </GlassButton>
                </div>
                <p className="mt-1.5 text-[12.5px] leading-relaxed whitespace-pre-wrap">
                  {parts.map((part, index) =>
                    part.kind === 'same' ? (
                      // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one diff never move
                      <span key={index}>{part.text}</span>
                    ) : part.kind === 'del' ? (
                      // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one diff never move
                      <del key={index} className="bg-danger/15 text-danger">
                        {part.text}
                      </del>
                    ) : (
                      // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one diff never move
                      <ins key={index} className="bg-ok/15 text-ok no-underline">
                        {part.text}
                      </ins>
                    )
                  )}
                </p>
              </li>
            )
          })}
        </ol>
      )}
    </section>
  )
}
