import { IconBolt, IconPuzzle } from '@tabler/icons-react'
import { useState } from 'react'
import { GlassButton, Pill, Toggle } from '../../../components/ui/glass.tsx'
import { jarod } from '../../../lib/jarod.ts'
import { useBackendData } from '../../../lib/use-async.ts'
import { notify } from '../../../store/notifications.ts'
import { isUnsupported } from './providers-model.ts'
import { type ActionDraft, draftProblems, emptyAction, emptyRule, inputOf, type Plugin, pluginSummary, type Rule, type RuleDraft, ruleSummary, untrustedTools } from './rules-model.ts'
import { errorText, InlineNote, markSaved, SectionTitle, SettingsGroup, SettingsRow } from './shared.tsx'

/*
 * Automation rules and user plugins.
 *   Rules: do something when a trigger fires (a schedule, a webhook, a button): ask the agent, show a notification, call a web address. The Automations page
 *   keeps the simple scheduled prompts; rules can chain several actions. Rules ask the agent in read-only mode unless you say otherwise.
 *   Plugins: code you installed that adds tools. A plugin runs in its own process with the permissions it declares; enabling one, or letting its tools run
 *   without asking, is confirmed by the engine in a native dialog.
 */

type Result = unknown

export function RulesSection() {
  return (
    <>
      <SectionTitle title="Automation rules & plugins" subtitle="Do things on a trigger, and extend the agent with plugins." />
      <RulesBlock />
      <PluginsBlock />
    </>
  )
}

function useRun(onDone: () => void) {
  const [busy, setBusy] = useState(false)

  const run = async (title: string, action: () => Promise<Result>): Promise<boolean> => {
    setBusy(true)

    try {
      await action()
      markSaved()
      notify({ title, level: 'success' })
      onDone()

      return true
    } catch (error) {
      const message = errorText(error)

      notify(/refusé par l.utilisateur/.test(message) ? { title: 'Not changed', body: 'You cancelled the confirmation.', level: 'info' } : { title: 'Automation', body: message.replace(/^.*?\[oneai\]\s*/, ''), level: 'error' })

      return false
    } finally {
      setBusy(false)
    }
  }

  return { busy, run }
}

function RulesBlock() {
  const rules = useBackendData(() => jarod<{ rules: Rule[] }>('automation-list'))
  const [draft, setDraft] = useState<RuleDraft | null>(null)
  const { busy, run } = useRun(rules.reload)
  const problems = draft ? draftProblems(draft) : []

  if (isUnsupported(rules.error)) {
    return <InlineNote tone="info">Automation rules need the Jarod engine.</InlineNote>
  }

  const set = <K extends keyof RuleDraft>(key: K, value: RuleDraft[K]) => setDraft(current => (current ? { ...current, [key]: value } : current))
  const setAction = (index: number, action: ActionDraft) => setDraft(current => (current ? { ...current, actions: current.actions.map((a, i) => (i === index ? action : a)) } : current))
  const input = 'glass-input rounded-lg px-2.5 text-[12.5px] text-fg outline-none placeholder:text-fg-4'

  return (
    <SettingsGroup title="Rules">
      {rules.error && <InlineNote tone="danger">Could not read the rules: {rules.error}</InlineNote>}
      {rules.data?.rules.length === 0 && <SettingsRow icon={<IconBolt />} label="No rule yet" description="A rule runs its actions when its trigger fires." keywords="automation rules empty" />}
      {rules.data?.rules.map(rule => (
        <SettingsRow key={rule.id} icon={<IconBolt />} label={rule.name} description={<span className="line-clamp-2">{ruleSummary(rule)}</span>} keywords={`automation rule ${rule.name} ${rule.trigger.kind}`}>
          <GlassButton size="sm" variant="secondary" disabled={busy} onClick={() => void run('Rule ran', async () => {
            const result = await jarod<{ ok: boolean; error?: string }>('automation-run', rule.id)

            if (!result.ok) {
              throw new Error(result.error ?? 'The rule failed')
            }
          })} aria-label={`Run ${rule.name} now`}>
            Run now
          </GlassButton>
          <GlassButton size="sm" variant="ghost" disabled={busy} onClick={() => void run('Rule removed', () => jarod('automation-delete', rule.id))} aria-label={`Remove ${rule.name}`}>
            Remove
          </GlassButton>
          <Toggle checked={rule.enabled} label={`${rule.name} on or off`} disabled={busy} onChange={value => void run(value ? 'Rule on' : 'Rule off', () => jarod('automation-update', rule.id, { enabled: value }))} />
        </SettingsRow>
      ))}
      <SettingsRow
        icon={<IconBolt />}
        label="New rule"
        description="Trigger → actions."
        keywords="automation rule new add"
        below={
          draft && (
            <form
              className="flex flex-col gap-2.5"
              onSubmit={event => {
                event.preventDefault()

                if (problems.length === 0) {
                  void run('Rule added', () => jarod('automation-create', inputOf(draft))).then(ok => ok && setDraft(null))
                }
              }}
            >
              <input value={draft.name} onChange={event => set('name', event.target.value)} placeholder="Name" aria-label="Rule name" className={`${input} h-8`} />
              <div className="flex items-center gap-2">
                <select value={draft.trigger} onChange={event => set('trigger', event.target.value as RuleDraft['trigger'])} aria-label="Trigger" style={{ colorScheme: 'dark' }} className={`${input} h-8`}>
                  <option value="schedule">On a schedule</option>
                  <option value="webhook">When a webhook is called</option>
                  <option value="manual">By hand only</option>
                </select>
                {draft.trigger === 'schedule' && <input value={draft.cron} onChange={event => set('cron', event.target.value)} aria-label="Cron schedule" spellCheck={false} placeholder="0 9 * * 1-5" className={`${input} h-8 flex-1 font-mono`} />}
                {draft.trigger === 'webhook' && <input value={draft.hookId} onChange={event => set('hookId', event.target.value)} aria-label="Webhook name" spellCheck={false} placeholder="name-of-the-hook" className={`${input} h-8 flex-1 font-mono`} />}
              </div>
              {draft.actions.map((action, index) => (
                <div key={index} className="flex flex-col gap-2 rounded-lg border border-line p-2.5">
                  <div className="flex items-center gap-2">
                    <select value={action.type} onChange={event => setAction(index, emptyAction(event.target.value as ActionDraft['type']))} aria-label={`Action ${index + 1} type`} style={{ colorScheme: 'dark' }} className={`${input} h-8`}>
                      <option value="agent">Ask the agent</option>
                      <option value="notify">Show a notification</option>
                      <option value="webhook">Call a web address</option>
                    </select>
                    {draft.actions.length > 1 && (
                      <GlassButton type="button" size="sm" variant="ghost" onClick={() => set('actions', draft.actions.filter((_, i) => i !== index))}>
                        Remove action
                      </GlassButton>
                    )}
                  </div>
                  {action.type === 'agent' && (
                    <>
                      <textarea value={action.prompt} onChange={event => setAction(index, { ...action, prompt: event.target.value })} rows={3} placeholder="What should the agent do?" aria-label="Prompt" className={`${input} py-1.5`} />
                      <label className="flex items-center gap-2 text-[12px] text-fg-3">
                        <Toggle checked={action.mode === 'build'} onChange={value => setAction(index, { ...action, mode: value ? 'build' : 'plan' })} label="The agent may change things" />
                        The agent may change files and run commands (otherwise read-only)
                      </label>
                    </>
                  )}
                  {action.type === 'notify' && (
                    <>
                      <input value={action.title} onChange={event => setAction(index, { ...action, title: event.target.value })} placeholder="Title" aria-label="Notification title" className={`${input} h-8`} />
                      <input value={action.body} onChange={event => setAction(index, { ...action, body: event.target.value })} placeholder="Text" aria-label="Notification text" className={`${input} h-8`} />
                    </>
                  )}
                  {action.type === 'webhook' && (
                    <>
                      <input value={action.url} onChange={event => setAction(index, { ...action, url: event.target.value })} placeholder="https://…" aria-label="Address" spellCheck={false} className={`${input} h-8 font-mono`} />
                      <textarea value={action.payload} onChange={event => setAction(index, { ...action, payload: event.target.value })} rows={2} aria-label="JSON payload" spellCheck={false} className={`${input} py-1.5 font-mono`} />
                    </>
                  )}
                </div>
              ))}
              <div>
                <GlassButton type="button" size="sm" variant="ghost" onClick={() => set('actions', [...draft.actions, emptyAction('notify')])}>
                  Add another action
                </GlassButton>
              </div>
              {problems.length > 0 && draft.name.trim() && (
                <InlineNote tone="warn">
                  {problems.map(problem => (
                    <div key={problem}>{problem}</div>
                  ))}
                </InlineNote>
              )}
              <div className="flex justify-end gap-2">
                <GlassButton type="button" size="sm" variant="ghost" onClick={() => setDraft(null)}>
                  Cancel
                </GlassButton>
                <GlassButton type="submit" size="sm" variant="primary" disabled={busy || problems.length > 0}>
                  Add rule
                </GlassButton>
              </div>
            </form>
          )
        }
      >
        <GlassButton size="sm" variant="primary" disabled={busy} onClick={() => setDraft(emptyRule())}>
          New…
        </GlassButton>
      </SettingsRow>
    </SettingsGroup>
  )
}

function PluginsBlock() {
  const plugins = useBackendData(() => jarod<Plugin[]>('plugins-list'))
  const { busy, run } = useRun(plugins.reload)

  if (isUnsupported(plugins.error) || !plugins.data) {
    return null
  }

  return (
    <SettingsGroup title="User plugins">
      {plugins.data.length === 0 && <SettingsRow icon={<IconPuzzle />} label="No plugin installed" description="Plugins live in the profile’s plugins folder." keywords="plugins user empty" />}
      {plugins.data.map(plugin => {
        const open = untrustedTools(plugin)

        return (
          <SettingsRow key={plugin.id} icon={<IconPuzzle />} label={plugin.name} description={<span className="line-clamp-2">{[plugin.description, pluginSummary(plugin)].filter(Boolean).join(' — ')}</span>} keywords={`plugin ${plugin.name} ${plugin.id}`}>
            {plugin.state === 'error' && <Pill tone="danger">Error</Pill>}
            {plugin.state === 'active' && plugin.tools.length > 0 && (
              <GlassButton size="sm" variant="ghost" disabled={busy} onClick={() => void run(open.length ? 'Tools trusted' : 'Tools ask again', () => jarod('plugin-set-trust', plugin.id, [], open.length > 0))} aria-label={`${open.length ? 'Run without asking' : 'Ask again for'} the tools of ${plugin.name}`}>
                {open.length ? 'Trust tools…' : 'Ask again'}
              </GlassButton>
            )}
            <Toggle checked={plugin.enabled} label={`${plugin.name} on or off`} disabled={busy} onChange={value => void run(value ? 'Plugin on' : 'Plugin off', () => jarod('plugin-set-enabled', plugin.id, value))} />
          </SettingsRow>
        )
      })}
    </SettingsGroup>
  )
}
