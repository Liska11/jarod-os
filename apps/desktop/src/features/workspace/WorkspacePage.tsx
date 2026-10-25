import { IconBrandGithub, IconFileDiff, IconFolderOpen, IconRefresh, IconRobot } from '@tabler/icons-react'
import { useCallback, useEffect, useState } from 'react'
import { EmptyGlass, GlassButton, PageHeader, Tabs } from '../../components/ui/glass.tsx'
import { jarod } from '../../lib/jarod.ts'
import { t, useT } from '../../lib/i18n.ts'
import { errorText, InlineNote } from '../settings/sections/shared.tsx'
import { AgentsTab } from './AgentsTab.tsx'
import { ChangesTab } from './ChangesTab.tsx'
import { GithubTab } from './GithubTab.tsx'
import { taskWorktrees, type Worktree } from './workspace-model.ts'

/*
 * Workspace: code tasks, each in its own git worktree. The agent (Jarod, Claude Code or Codex) works in a task's folder, never in the main checkout;
 * the Changes tab shows what it changed and merges it once the user has read it. The repository comes from the native folder picker, never from typed text.
 */

type TabId = 'changes' | 'agents' | 'github'

export function WorkspacePage() {
  useT()
  const [repo, setRepo] = useState<string | null>(null)
  const [worktrees, setWorktrees] = useState<Worktree[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [tab, setTab] = useState<TabId>('changes')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async (folder: string | null) => {
    if (!folder) {
      setWorktrees([])

      return
    }

    setLoading(true)

    try {
      const list = await jarod<Worktree[]>('codespace-worktrees', folder)
      setWorktrees(list)
      setSelected(current => (current && list.some(worktree => worktree.path === current) ? current : (taskWorktrees(list)[0]?.path ?? null)))
      setError(null)
    } catch (e) {
      setWorktrees([])
      setError(errorText(e))
    } finally {
      setLoading(false)
    }
  }, [])

  const choose = async () => {
    try {
      const folder = await jarod<string | null>('select-folder')

      if (folder) {
        setRepo(folder)
        void load(folder)
      }
    } catch (e) {
      setError(errorText(e))
    }
  }

  // The default working folder is a fine first guess; when it is not a git repository the page simply asks for one.
  useEffect(() => {
    void jarod<string | null>('get-default-workspace').then(
      folder => {
        if (folder) {
          setRepo(folder)
          void load(folder)
        }
      },
      () => undefined
    )
  }, [load])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        icon="code"
        title={t('workspace.title')}
        subtitle={repo ?? t('workspace.subtitle')}
        actions={
          <>
            <GlassButton size="sm" variant="secondary" onClick={() => void choose()}>
              <IconFolderOpen />
              {repo ? t('workspace.changeRepo') : t('workspace.chooseRepo')}
            </GlassButton>
            {repo ? (
              <GlassButton size="sm" variant="ghost" disabled={loading} onClick={() => void load(repo)} aria-label={t('workspace.refresh')}>
                <IconRefresh />
              </GlassButton>
            ) : null}
          </>
        }
      />

      {repo ? (
        <>
          <div className="px-6 pb-3">
            <Tabs
              value={tab}
              onChange={setTab}
              tabs={[
                { id: 'changes', label: t('workspace.tab.changes'), icon: <IconFileDiff size={14} />, count: taskWorktrees(worktrees).length },
                { id: 'agents', label: t('workspace.tab.agents'), icon: <IconRobot size={14} /> },
                { id: 'github', label: t('workspace.tab.github'), icon: <IconBrandGithub size={14} /> }
              ]}
            />
          </div>
          {error ? <InlineNote tone="danger" className="px-6 pb-3">{error}</InlineNote> : null}
          <div className="min-h-0 flex-1 px-6 pb-5">
            {tab === 'changes' ? <ChangesTab repo={repo} worktrees={worktrees} selected={selected} onSelect={setSelected} onChanged={() => void load(repo)} /> : null}
            {tab === 'agents' ? <AgentsTab repo={repo} worktrees={worktrees} selected={selected} onSelect={setSelected} onChanged={() => void load(repo)} /> : null}
            {tab === 'github' ? <GithubTab repo={repo} /> : null}
          </div>
        </>
      ) : (
        <div className="px-6">
          {error ? <InlineNote tone="danger" className="pb-3">{error}</InlineNote> : null}
          <EmptyGlass
            icon={<IconFolderOpen />}
            title={t('workspace.noRepo.title')}
            description={t('workspace.noRepo.body')}
            action={
              <GlassButton variant="primary" onClick={() => void choose()}>
                <IconFolderOpen />
                {t('workspace.chooseRepo')}
              </GlassButton>
            }
          />
        </div>
      )}
    </div>
  )
}
