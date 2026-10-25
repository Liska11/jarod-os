import { IconExternalLink, IconGitPullRequest, IconCircleDot } from '@tabler/icons-react'
import { useCallback, useEffect, useState } from 'react'
import { Chips, EmptyGlass, GlassButton, GlassCard, Pill, Tabs } from '../../components/ui/glass.tsx'
import { jarod } from '../../lib/jarod.ts'
import { t, useT } from '../../lib/i18n.ts'
import { errorText, InlineNote } from '../settings/sections/shared.tsx'
import { GITHUB_STATE_TONE, type GithubRow, parseGithubRows } from './workspace-model.ts'

type Kind = 'prs' | 'issues'
type State = 'open' | 'closed' | 'merged' | 'all'

/** Pull requests and issues of the repository, read through the GitHub CLI already signed in on this machine. */
export function GithubTab({ repo }: { repo: string }) {
  useT()
  const [kind, setKind] = useState<Kind>('prs')
  const [state, setState] = useState<State>('open')
  const [rows, setRows] = useState<GithubRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setRows(null)
    setError(null)

    try {
      setRows(parseGithubRows(await jarod<unknown>('codespace-github-list', repo, kind, state)))
    } catch (e) {
      setRows([])
      setError(errorText(e))
    }
  }, [repo, kind, state])

  useEffect(() => {
    void load()
  }, [load])

  // Issues have no "merged" state.
  const states: { id: State; label: string }[] = [
    { id: 'open', label: t('workspace.gh.open') },
    { id: 'closed', label: t('workspace.gh.closed') },
    ...(kind === 'prs' ? [{ id: 'merged' as const, label: t('workspace.gh.merged') }] : []),
    { id: 'all', label: t('workspace.gh.all') }
  ]

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <Tabs
          value={kind}
          onChange={next => {
            setKind(next)
            setState(current => (next === 'issues' && current === 'merged' ? 'open' : current))
          }}
          tabs={[
            { id: 'prs', label: t('workspace.gh.prs'), icon: <IconGitPullRequest size={14} /> },
            { id: 'issues', label: t('workspace.gh.issues'), icon: <IconCircleDot size={14} /> }
          ]}
        />
        <Chips items={states} value={state} onChange={setState} />
      </div>

      {error ? <InlineNote tone="warn">{t('workspace.gh.unavailable')} ({error})</InlineNote> : null}

      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
        {rows === null ? <InlineNote tone="info">{t('workspace.gh.loading')}</InlineNote> : null}
        {rows && rows.length === 0 && !error ? <EmptyGlass title={t('workspace.gh.empty')} /> : null}
        {rows?.map(row => (
          <GlassCard key={row.number} className="flex items-center gap-3 px-3 py-2.5">
            <span className="w-12 shrink-0 text-right text-[12px] tabular-nums text-fg-4">#{row.number}</span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] text-fg">{row.title}</div>
              <div className="flex flex-wrap items-center gap-1.5 text-[11.5px] text-fg-3">
                {row.author ? <span>{t('workspace.gh.by', { author: row.author })}</span> : null}
                {row.headRefName ? <span className="truncate text-fg-4">{row.headRefName}</span> : null}
                {row.labels.map(label => (
                  <Pill key={label} tone="muted">
                    {label}
                  </Pill>
                ))}
              </div>
            </div>
            <Pill tone={GITHUB_STATE_TONE[row.state] ?? 'muted'}>{row.state.toLowerCase()}</Pill>
            {row.url ? (
              <GlassButton size="icon" variant="ghost" aria-label={t('workspace.gh.openInBrowser')} onClick={() => void window.jarodOS.shell.openExternal(row.url)}>
                <IconExternalLink />
              </GlassButton>
            ) : null}
          </GlassCard>
        ))}
      </div>
    </div>
  )
}
