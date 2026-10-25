import { IconLoader2, IconPlayerPlay } from '@tabler/icons-react'
import { useEffect, useState } from 'react'
import { EmptyGlass, GlassButton, GlassCard, Pill } from '../../components/ui/glass.tsx'
import { jarod } from '../../lib/jarod.ts'
import { t, useT } from '../../lib/i18n.ts'
import { errorText, InlineNote } from '../settings/sections/shared.tsx'
import { type AgentInfo, type AgentResult, type HarnessId, taskWorktrees, type Worktree, worktreeName } from './workspace-model.ts'

/** Hands a task to Claude Code or Codex CLI inside a task worktree. It can take minutes; nothing runs in the main checkout. */
export function AgentsTab({ repo, worktrees, selected, onSelect, onChanged }: { repo: string; worktrees: Worktree[]; selected: string | null; onSelect: (path: string) => void; onChanged: () => void }) {
  useT()
  const [agents, setAgents] = useState<AgentInfo[]>([])
  const [harness, setHarness] = useState<HarnessId>('claude')
  const [model, setModel] = useState('')
  const [prompt, setPrompt] = useState('')
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<AgentResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const tasks = taskWorktrees(worktrees)
  const agent = agents.find(candidate => candidate.id === harness)

  useEffect(() => {
    jarod<AgentInfo[]>('codespace-agents').then(
      list => {
        setAgents(list)
        // Start on an agent that is installed.
        setHarness(current => (list.find(candidate => candidate.id === current)?.path ? current : (list.find(candidate => candidate.path)?.id ?? current)))
      },
      e => setError(errorText(e))
    )
  }, [])

  const run = async () => {
    if (!selected || !prompt.trim() || running) {
      return
    }

    setRunning(true)
    setResult(null)
    setError(null)

    try {
      const outcome = await jarod<AgentResult | null>('codespace-run-agent', repo, selected, harness, prompt.trim(), model.trim() || undefined)

      // null = the user declined the confirmation.
      if (outcome) {
        setResult(outcome)
        onChanged()
      }
    } catch (e) {
      setError(errorText(e))
    } finally {
      setRunning(false)
    }
  }

  if (tasks.length === 0) {
    return <EmptyGlass title={t('workspace.agent.needWorktree')} />
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto">
      <div className="grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1 text-[12px] text-fg-3">
          {t('workspace.agent.worktree')}
          <select value={selected ?? ''} onChange={event => onSelect(event.target.value)} className="glass-input h-9 rounded-lg px-2.5 text-[13px] text-fg outline-none">
            {tasks.map(worktree => (
              <option key={worktree.path} value={worktree.path}>
                {worktreeName(worktree)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[12px] text-fg-3">
          {t('workspace.agent')}
          <select value={harness} onChange={event => setHarness(event.target.value as HarnessId)} className="glass-input h-9 rounded-lg px-2.5 text-[13px] text-fg outline-none">
            {agents.map(candidate => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name}
                {candidate.path ? '' : ` — ${t('workspace.agent.notInstalled')}`}
              </option>
            ))}
          </select>
        </label>
      </div>

      {agent && !agent.path ? <InlineNote tone="warn">{t('workspace.agent.missing', { name: agent.name })}</InlineNote> : null}
      {agent?.path ? <InlineNote tone="info">{t('workspace.agent.path', { path: agent.path })}</InlineNote> : null}

      <label className="flex flex-col gap-1 text-[12px] text-fg-3">
        {t('workspace.agent.model')}
        <input value={model} onChange={event => setModel(event.target.value)} className="glass-input h-9 rounded-lg px-2.5 text-[13px] text-fg outline-none" />
      </label>

      <label className="flex min-h-0 flex-col gap-1 text-[12px] text-fg-3">
        {t('workspace.agent.task')}
        <textarea
          value={prompt}
          rows={6}
          placeholder={t('workspace.agent.taskPlaceholder')}
          onChange={event => setPrompt(event.target.value)}
          className="glass-input resize-y rounded-lg px-3 py-2 text-[13px] leading-6 text-fg outline-none"
        />
      </label>

      <div className="flex items-center gap-3">
        <GlassButton variant="primary" disabled={running || !agent?.path || !selected || !prompt.trim()} onClick={() => void run()}>
          {running ? <IconLoader2 className="animate-spin" /> : <IconPlayerPlay />}
          {t('workspace.agent.run')}
        </GlassButton>
        {running ? <span className="text-[12px] text-fg-3">{t('workspace.agent.running')}</span> : null}
      </div>

      {error ? <InlineNote tone="danger">{error}</InlineNote> : null}

      {result ? (
        <GlassCard className="flex flex-col gap-2 p-3">
          <div className="flex items-center gap-2">
            <Pill tone={result.ok ? 'ok' : 'danger'}>{result.ok ? t('workspace.agent.done') : t('workspace.agent.failed')}</Pill>
            {result.costUsd !== undefined ? <span className="text-[12px] text-fg-3">{t('workspace.agent.cost', { cost: result.costUsd.toFixed(4) })}</span> : null}
          </div>
          {result.error ? <InlineNote tone="danger">{result.error}</InlineNote> : null}
          {result.text ? <pre className="max-h-72 overflow-auto whitespace-pre-wrap text-[12.5px] leading-6 text-fg-2">{result.text}</pre> : null}
          {result.stderr && !result.ok ? <pre className="max-h-40 overflow-auto whitespace-pre-wrap text-[11.5px] text-fg-4">{result.stderr}</pre> : null}
          <InlineNote tone="info">{t('workspace.agent.review')}</InlineNote>
        </GlassCard>
      ) : null}
    </div>
  )
}
