import { IconGitBranch, IconGitMerge, IconPlus } from '@tabler/icons-react'
import { useCallback, useEffect, useState } from 'react'
import { EmptyGlass, GlassButton, GlassCard, Pill } from '../../components/ui/glass.tsx'
import { cn } from '../../lib/cn.ts'
import { jarod } from '../../lib/jarod.ts'
import { t, useT } from '../../lib/i18n.ts'
import { notify } from '../../store/notifications.ts'
import { errorText, InlineNote } from '../settings/sections/shared.tsx'
import { branchProblem, type DiffResult, mainBranch, patchLines, shortHead, STATUS_TONE, statusKind, taskWorktrees, type Worktree, worktreeName } from './workspace-model.ts'

const LINE_CLASS = { add: 'bg-ok/10 text-ok', remove: 'bg-danger/10 text-danger', hunk: 'text-accent', meta: 'text-fg-4', context: 'text-fg-2' } as const

/** The task worktrees on the left, the selected one's diff on the right, with the merge once it has been read. */
export function ChangesTab({ repo, worktrees, selected, onSelect, onChanged }: { repo: string; worktrees: Worktree[]; selected: string | null; onSelect: (path: string) => void; onChanged: () => void }) {
  useT()
  const [diff, setDiff] = useState<DiffResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [creating, setCreating] = useState<string | null>(null)
  const tasks = taskWorktrees(worktrees)
  const current = tasks.find(worktree => worktree.path === selected) ?? null
  const target = mainBranch(worktrees)

  const loadDiff = useCallback(async () => {
    if (!current) {
      setDiff(null)

      return
    }

    try {
      setDiff(await jarod<DiffResult>('codespace-diff', repo, current.path))
      setError(null)
    } catch (e) {
      setDiff(null)
      setError(errorText(e))
    }
  }, [repo, current])

  useEffect(() => {
    void loadDiff()
  }, [loadDiff])

  const create = async () => {
    const name = (creating ?? '').trim()

    if (branchProblem(name)) {
      return
    }

    setBusy(true)

    try {
      const made = await jarod<{ path: string; branch: string } | null>('codespace-create-worktree', repo, name)

      if (made) {
        setCreating(null)
        onSelect(made.path)
        onChanged()
        notify({ title: t('workspace.title'), body: t('workspace.created', { branch: made.branch }), level: 'info' })
      }
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const merge = async () => {
    if (!current?.branch) {
      return
    }

    setBusy(true)

    try {
      const merged = await jarod<{ into: string } | null>('codespace-merge', repo, current.branch)

      if (merged) {
        notify({ title: t('workspace.title'), body: t('workspace.merged', { into: merged.into }), level: 'info' })
        onChanged()
      }
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const problem = creating === null ? null : branchProblem(creating)

  return (
    <div className="grid h-full min-h-0 grid-cols-[260px_minmax(0,1fr)] gap-4">
      <div className="flex min-h-0 flex-col gap-2 overflow-y-auto">
        <GlassButton size="sm" variant="secondary" onClick={() => setCreating(creating === null ? '' : null)}>
          <IconPlus />
          {t('workspace.newTask')}
        </GlassButton>
        {creating !== null ? (
          <GlassCard className="flex flex-col gap-2 p-2.5">
            <input
              autoFocus
              value={creating}
              placeholder={t('workspace.branchName')}
              aria-label={t('workspace.branchName')}
              onChange={event => setCreating(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter') void create()
              }}
              className="glass-input h-8 rounded-lg px-2.5 text-[12.5px] outline-none"
            />
            {problem === 'invalid' ? <InlineNote tone="warn">{t('workspace.branchInvalid')}</InlineNote> : null}
            <GlassButton size="sm" variant="primary" disabled={busy || problem !== null} onClick={() => void create()}>
              {t('workspace.create')}
            </GlassButton>
          </GlassCard>
        ) : null}
        {tasks.length === 0 ? (
          <EmptyGlass title={t('workspace.noTasks')} description={t('workspace.noTasks.body')} className="min-h-32" />
        ) : (
          tasks.map(worktree => (
            <GlassCard key={worktree.path} as="button" interactive selected={worktree.path === selected} onClick={() => onSelect(worktree.path)} className="flex flex-col gap-0.5 px-3 py-2 text-left">
              <span className="flex items-center gap-1.5 text-[13px] text-fg">
                <IconGitBranch size={14} />
                <span className="truncate">{worktreeName(worktree)}</span>
              </span>
              <span className="text-[11px] text-fg-4">{shortHead(worktree.head)}</span>
            </GlassCard>
          ))
        )}
      </div>

      <div className="flex min-h-0 flex-col gap-3">
        {!current ? (
          <EmptyGlass title={t('workspace.select')} className="flex-1" />
        ) : (
          <>
            <div className="flex items-center gap-2">
              <span className="truncate text-[14px] font-medium text-fg">{worktreeName(current)}</span>
              {diff ? <Pill tone="muted">{t('workspace.files', { count: diff.files.length })}</Pill> : null}
              <span className="flex-1" />
              <GlassButton size="sm" variant="primary" disabled={busy || !current.branch} onClick={() => void merge()}>
                <IconGitMerge />
                {target ? t('workspace.merge', { branch: target }) : t('workspace.mergeHere')}
              </GlassButton>
            </div>
            {error ? <InlineNote tone="danger">{error}</InlineNote> : null}
            {diff && diff.files.length === 0 ? <EmptyGlass title={t('workspace.noChanges')} className="flex-1" /> : null}
            {diff && diff.files.length > 0 ? (
              <>
                <div className="flex flex-wrap gap-1.5">
                  {diff.files.map(file => {
                    const kind = statusKind(file.status)

                    return (
                      <Pill key={file.path} tone={STATUS_TONE[kind]} className="max-w-full" >
                        <span className="truncate" title={t(`workspace.status.${kind}`)}>
                          {file.path}
                        </span>
                      </Pill>
                    )
                  })}
                </div>
                <pre className="glass-card min-h-0 flex-1 overflow-auto rounded-xl p-3 font-mono text-[12px] leading-[1.55]">
                  {patchLines(diff.patch).map((line, index) => (
                    <div key={index} className={cn('whitespace-pre px-1', LINE_CLASS[line.kind])}>
                      {line.text || ' '}
                    </div>
                  ))}
                </pre>
                {diff.truncated ? <InlineNote tone="info">{t('workspace.truncated')}</InlineNote> : null}
              </>
            ) : null}
          </>
        )}
      </div>
    </div>
  )
}
