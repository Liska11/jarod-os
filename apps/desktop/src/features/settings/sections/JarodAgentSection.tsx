import { IconAdjustments, IconArrowDown, IconArrowUp, IconBrain, IconListCheck, IconShieldLock, IconTerminal2, IconTrash } from '@tabler/icons-react'
import { useState } from 'react'
import { GlassButton, Pill } from '../../../components/ui/glass.tsx'
import { jarod } from '../../../lib/jarod.ts'
import { notify } from '../../../store/notifications.ts'
import { useBackendData } from '../../../lib/use-async.ts'
import { ChipsEditor, ChoiceRow, NumberRow, reportEngineError, SwitchRow, useJarodSettings } from './jarod-controls.tsx'
import {
  DECISION_LABEL,
  type Decision,
  type FallbackEntry,
  intProblem,
  type JarodOptions,
  type JarodSettings,
  moneyProblem,
  moveItem,
  type PermissionRule,
  programProblem,
  rootProblem,
  ruleListProblem,
  ruleToolProblem,
  TOOL_SEARCH_LABEL
} from './jarod-settings-model.ts'
import { isUnsupported } from './providers-model.ts'
import { InlineNote, SectionTitle, SettingsGroup, SettingsRow } from './shared.tsx'

/*
 * Agent & security: how the Jarod agent behaves and what it may do. Every control binds to the engine's `get/set-jarod-settings`:
 *   behaviour (mode, steps, memory, learning, budget, tool search), permissions (tools allowed without asking, ordered rules), the shell guard,
 *   and the models it may fall back to. A change that gives the agent more power or sends data elsewhere is confirmed in a native dialog by the engine.
 */

export function JarodAgentSection() {
  const api = useJarodSettings()
  const s = api.settings

  if (isUnsupported(api.error)) {
    return (
      <>
        <SectionTitle title="Agent & security" subtitle="How the Jarod agent behaves and what it may do." />
        <InlineNote tone="info">This engine manages these settings itself. They can only be edited here with the Jarod engine.</InlineNote>
      </>
    )
  }

  return (
    <>
      <SectionTitle title="Agent & security" subtitle="How the Jarod agent behaves and what it may do." />
      {api.error && <InlineNote tone="danger">Could not read the settings: {api.error}</InlineNote>}
      {!s && api.loading && <div className="px-1 text-[12px] text-fg-4">Loading…</div>}
      {s && (
        <>
          <BehaviourGroup s={s} api={api} />
          <PermissionsGroup s={s} api={api} />
          <ShellGuardGroup s={s} api={api} />
          <ModelsGroup s={s} api={api} />
        </>
      )}
    </>
  )
}

type Props = { s: JarodSettings; api: ReturnType<typeof useJarodSettings> }

function BehaviourGroup({ s, api }: Props) {
  const { save, saving } = api

  return (
    <SettingsGroup title="Behaviour">
      <ChoiceRow
        icon={<IconAdjustments />}
        label="Mode"
        description="Build: the agent can change files and run commands. Plan: it only reads, investigates and proposes."
        keywords="agent mode build plan read-only"
        value={s.agentMode}
        options={[{ id: 'build', label: 'Build' }, { id: 'plan', label: 'Plan (read-only)' }]}
        disabled={saving}
        onChange={value => void save({ agentMode: value })}
      />
      <SwitchRow icon={<IconShieldLock />} label="Run tools without asking" description="The agent writes files, runs commands and uses the network without asking each time. Deny rules and the shell guard still apply. You will be asked to confirm when turning it on." keywords="auto approve tools yolo ask permission" value={s.autoApproveTools} disabled={saving} onChange={value => void save({ autoApproveTools: value })} />
      <NumberRow icon={<IconListCheck />} label="Steps per turn" description="How many tool calls the agent may chain before it stops and reports." keywords="max agent steps iterations limit" value={s.maxAgentSteps} validate={text => intProblem(text, 1, 500)} disabled={saving} onSave={value => save({ maxAgentSteps: value })} />
      <NumberRow
        icon={<IconBrain />}
        label="Summarise long conversations"
        description="Older turns are summarised once the history passes this many characters (0 = never)."
        keywords="compact threshold summarize history context"
        value={s.compactThreshold}
        format={value => (value === 0 ? 'off' : `${value.toLocaleString('en-US')} characters`)}
        validate={text => intProblem(text, 10_000, 5_000_000, true)}
        disabled={saving}
        onSave={value => save({ compactThreshold: value })}
      />
      <ChoiceRow
        icon={<IconBrain />}
        label="Tool search"
        description="With a small local model the agent sees only a core set of tools plus a search for the rest. Choose “Never” to show it every tool (needs a larger context)."
        keywords="tool search tools hidden local model run_shell core"
        value={s.toolSearch}
        options={(Object.keys(TOOL_SEARCH_LABEL) as JarodSettings['toolSearch'][]).map(id => ({ id, label: TOOL_SEARCH_LABEL[id] }))}
        disabled={saving}
        onChange={value => void save({ toolSearch: value })}
      />
      <SwitchRow icon={<IconBrain />} label="Use memory in conversations" description="Facts the agent remembered are added to its context." keywords="memory inject remember" value={s.memoryInject} disabled={saving} onChange={value => void save({ memoryInject: value })} />
      <SwitchRow icon={<IconBrain />} label="Title conversations" description="Ask the model for a short title after the first exchange." keywords="auto title name conversation" value={s.autoTitle} disabled={saving} onChange={value => void save({ autoTitle: value })} />
      <SwitchRow icon={<IconAdjustments />} label="Show the agent’s browser" description="When the agent browses the web, its own window is shown (it never takes the focus). Off keeps it hidden." keywords="browser visible window agent web" value={s.browserVisible} disabled={saving} onChange={value => void save({ browserVisible: value })} />
      <SwitchRow icon={<IconShieldLock />} label="Keep the agent’s browser logins" description="Cookies and sign-ins made in the agent’s browser are kept on this PC, so it can act with those accounts. It is its own session, not your browser. You will be asked to confirm when turning it on." keywords="browser persistent cookies login session" value={s.browserPersistent} disabled={saving} onChange={value => void save({ browserPersistent: value })} />
      <SettingsRow icon={<IconShieldLock />} label="Forget the agent’s browser" description="Erases its cookies, sign-ins and cache, and closes its window. Your own browsers are not touched." keywords="browser forget clear cookies">
        <GlassButton size="sm" variant="secondary" disabled={saving} onClick={() => void jarod<boolean>('agent-browser-forget').then(done => done && notify({ title: 'Browser forgotten', level: 'success' }), error => reportEngineError('Browser', error))}>
          Forget…
        </GlassButton>
      </SettingsRow>
      <SwitchRow icon={<IconBrain />} label="Learn from conversations" description="Every so often the agent reviews what happened and keeps what is worth remembering or turning into a skill." keywords="learning review curator skills" value={s.learning.enabled} disabled={saving} onChange={value => void save({ learning: { enabled: value } })} />
      <NumberRow icon={<IconBrain />} label="Review every" description="How many exchanges between two reviews." keywords="learning review every" value={s.learning.reviewEvery} format={value => `${value} exchanges`} validate={text => intProblem(text, 1, 1000)} disabled={saving || !s.learning.enabled} onSave={value => save({ learning: { reviewEvery: value } })} />
      <NumberRow icon={<IconListCheck />} label="Token limit per conversation" description="The conversation stops when it has used this many tokens (0 = no limit)." keywords="budget tokens limit session" value={s.sessionBudget.maxTokens} format={value => (value === 0 ? 'no limit' : value.toLocaleString('en-US'))} validate={text => intProblem(text, 1, 1_000_000_000, true)} disabled={saving} onSave={value => save({ sessionBudget: { maxTokens: value } })} />
      <NumberRow icon={<IconListCheck />} label="Cost limit per conversation" description="The conversation stops when it has cost this many dollars (0 = no limit)." keywords="budget cost dollars limit session" value={s.sessionBudget.maxCostUsd} format={value => (value === 0 ? 'no limit' : `$${value}`)} validate={moneyProblem} disabled={saving} onSave={value => save({ sessionBudget: { maxCostUsd: value } })} />
    </SettingsGroup>
  )
}

function PermissionsGroup({ s, api }: Props) {
  const { save, saving } = api
  const [rules, setRules] = useState<PermissionRule[] | null>(null)
  const draft = rules ?? s.permissionsRules
  const [tool, setTool] = useState('')
  const [decision, setDecision] = useState<Decision>('ask')
  const toolProblem = tool.trim() ? ruleToolProblem(tool) : null
  const listProblem = ruleListProblem(draft)
  const changed = rules !== null && JSON.stringify(rules) !== JSON.stringify(s.permissionsRules)

  return (
    <>
      <SettingsGroup title="Permissions">
        <SettingsRow
          icon={<IconShieldLock />}
          label="Tools allowed without asking"
          description="Tools you chose “Always allow” for in an approval card. They can only be removed here."
          keywords="always allow tools approval remembered"
          below={<ChipsEditorReadOnly items={s.alwaysAllowTools} disabled={saving} onRemove={item => void save({ alwaysAllowTools: s.alwaysAllowTools.filter(other => other !== item) }, 'Tool removed')} />}
        />
        <SettingsRow
          icon={<IconListCheck />}
          label="Permission rules"
          description="Applied in order: the first rule that matches a tool decides. “*” matches every tool. Deny and ask rules always beat “Always allow”."
          keywords="permissions rules allow ask deny order tool"
          below={
            <div className="flex flex-col gap-2">
              {draft.length === 0 && <span className="text-[12px] text-fg-4">No rules.</span>}
              {draft.map((rule, index) => (
                <div key={rule.tool} className="flex items-center gap-2">
                  <span className="w-5 text-right text-[11px] text-fg-4">{index + 1}</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-fg-2">{rule.tool}</span>
                  <select value={rule.decision} disabled={saving} onChange={event => setRules(draft.map((r, i) => (i === index ? { ...r, decision: event.target.value as Decision } : r)))} aria-label={`Decision for ${rule.tool}`} style={{ colorScheme: 'dark' }} className="glass-input h-7 rounded-md px-1.5 text-[12px] text-fg outline-none">
                    {(Object.keys(DECISION_LABEL) as Decision[]).map(d => (
                      <option key={d} value={d}>
                        {DECISION_LABEL[d]}
                      </option>
                    ))}
                  </select>
                  <GlassButton size="sm" variant="ghost" disabled={saving || index === 0} onClick={() => setRules(moveItem(draft, index, index - 1))} aria-label={`Move ${rule.tool} up`}>
                    <IconArrowUp />
                  </GlassButton>
                  <GlassButton size="sm" variant="ghost" disabled={saving || index === draft.length - 1} onClick={() => setRules(moveItem(draft, index, index + 1))} aria-label={`Move ${rule.tool} down`}>
                    <IconArrowDown />
                  </GlassButton>
                  <GlassButton size="sm" variant="ghost" disabled={saving} onClick={() => setRules(draft.filter((_, i) => i !== index))} aria-label={`Remove the rule for ${rule.tool}`}>
                    <IconTrash />
                  </GlassButton>
                </div>
              ))}
              <form
                className="flex items-center gap-2"
                onSubmit={event => {
                  event.preventDefault()

                  if (tool.trim() && !toolProblem) {
                    setRules([...draft, { tool: tool.trim(), decision }])
                    setTool('')
                  }
                }}
              >
                <label className="glass-input flex h-8 min-w-0 flex-1 items-center rounded-lg px-2.5">
                  <span className="sr-only">Tool name for a new rule</span>
                  <input value={tool} onChange={event => setTool(event.target.value)} placeholder="Tool name, family/* or *" spellCheck={false} className="min-w-0 flex-1 bg-transparent font-mono text-[12.5px] outline-none placeholder:text-fg-4" />
                </label>
                <select value={decision} onChange={event => setDecision(event.target.value as Decision)} aria-label="Decision for the new rule" style={{ colorScheme: 'dark' }} className="glass-input h-8 rounded-lg px-2 text-[12.5px] text-fg outline-none">
                  {(Object.keys(DECISION_LABEL) as Decision[]).map(d => (
                    <option key={d} value={d}>
                      {DECISION_LABEL[d]}
                    </option>
                  ))}
                </select>
                <GlassButton type="submit" size="sm" variant="secondary" disabled={!tool.trim() || Boolean(toolProblem)}>
                  Add rule
                </GlassButton>
              </form>
              {(toolProblem || listProblem) && <InlineNote tone="warn">{toolProblem ?? listProblem}</InlineNote>}
              {changed && (
                <div className="flex justify-end gap-2">
                  <GlassButton size="sm" variant="ghost" onClick={() => setRules(null)}>
                    Discard
                  </GlassButton>
                  <GlassButton size="sm" variant="primary" disabled={saving || Boolean(listProblem)} onClick={() => void save({ permissionsRules: draft }, 'Rules saved').then(ok => ok && setRules(null))}>
                    Save rules
                  </GlassButton>
                </div>
              )}
            </div>
          }
        />
      </SettingsGroup>
    </>
  )
}

function ChipsEditorReadOnly({ items, onRemove, disabled }: { items: readonly string[]; onRemove: (item: string) => void; disabled?: boolean }) {
  if (items.length === 0) {
    return <span className="text-[12px] text-fg-4">None yet.</span>
  }

  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map(item => (
        <span key={item} className="flex items-center gap-1 rounded-md bg-white/8 px-2 py-1 font-mono text-[12px] text-fg-2">
          {item}
          <button type="button" disabled={disabled} onClick={() => onRemove(item)} aria-label={`Stop allowing ${item} without asking`} className="text-fg-4 hover:text-fg disabled:opacity-40">
            ×
          </button>
        </span>
      ))}
    </div>
  )
}

function ShellGuardGroup({ s, api }: Props) {
  const { save, saving } = api
  const g = s.shellGuard
  const options = useBackendData(() => jarod<JarodOptions>('get-jarod-options'))
  const patch = (shellGuard: Record<string, unknown>, title = 'Shell guard updated') => save({ shellGuard }, title)

  return (
    <SettingsGroup title="Shell guard">
      <ChoiceRow
        icon={<IconTerminal2 />}
        label="Where commands may write"
        description="“Work folder only” stops commands from writing outside the work folder (and the folders listed below)."
        keywords="shell guard write scope workspace confinement"
        value={g.writeScope}
        options={[{ id: 'workspace', label: 'Work folder only' }, { id: 'off', label: 'Anywhere' }]}
        disabled={saving}
        onChange={value => void patch({ writeScope: value })}
      />
      <SettingsRow icon={<IconTerminal2 />} label="Extra writable folders" description="Relative to the work folder, for example build or dist." keywords="shell guard writable roots folders" below={<ChipsEditor items={g.writableRoots} validate={rootProblem} onChange={items => patch({ writableRoots: items })} disabled={saving} placeholder="build" label="writable folders" />} />
      <SettingsRow icon={<IconTerminal2 />} label="Programs always refused" description="Commands starting with one of these never run." keywords="shell guard denied programs blocklist" below={<ChipsEditor items={g.deniedPrograms} validate={programProblem} onChange={items => patch({ deniedPrograms: items })} disabled={saving} placeholder="rm" label="refused programs" />} />
      <SettingsRow icon={<IconTerminal2 />} label="Programs that always ask" description="Each use is confirmed, even when tools run without asking." keywords="shell guard ask programs confirm" below={<ChipsEditor items={g.askPrograms} validate={programProblem} onChange={items => patch({ askPrograms: items })} disabled={saving} placeholder="git" label="programs that ask" />} />
      <SettingsRow icon={<IconTerminal2 />} label="Only these programs" description={g.allowedPrograms.length === 0 ? 'Empty: every program that is not refused may run.' : 'Only the programs below may run.'} keywords="shell guard allowed programs allowlist" below={<ChipsEditor items={g.allowedPrograms} validate={programProblem} onChange={items => patch({ allowedPrograms: items })} disabled={saving} placeholder="node" label="allowed programs" />} />
      <ChoiceRow
        icon={<IconTerminal2 />}
        label="Run commands"
        description="In a Docker container keeps them off your system. Needs Docker installed."
        keywords="shell guard environment docker local container"
        value={g.environment}
        options={[{ id: 'local', label: 'On this PC' }, { id: 'docker', label: 'In Docker' }]}
        disabled={saving}
        onChange={value => void patch({ environment: value })}
      />
      {g.environment === 'docker' && (
        <>
          <SwitchRow icon={<IconTerminal2 />} label="Container network" description="Let commands in the container reach the network." keywords="docker network" value={g.docker.network} disabled={saving} onChange={value => void patch({ docker: { network: value } })} />
        </>
      )}
      {options.data?.shellGuardText && (
        <SettingsRow icon={<IconShieldLock />} label="What applies right now" keywords="shell guard effective policy" below={<pre className="max-h-48 overflow-auto rounded-lg bg-black/25 p-2.5 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-fg-3">{options.data.shellGuardText}</pre>}>
          <Pill tone="muted">Read-only</Pill>
        </SettingsRow>
      )}
    </SettingsGroup>
  )
}

function ModelsGroup({ s, api }: Props) {
  const { save, saving } = api
  const options = useBackendData(() => jarod<JarodOptions>('get-jarod-options'))
  const providers = options.data?.providers ?? []
  const name = (id: string) => providers.find(p => p.id === id)?.name ?? id
  const [added, setAdded] = useState('')
  const free = providers.filter(p => p.configured && p.id !== added && !s.fallbacks.some(f => f.provider === p.id))
  const setFallbacks = (list: FallbackEntry[]) => save({ fallbacks: list }, 'Fallbacks saved')

  return (
    <SettingsGroup title="Models">
      <SettingsRow
        icon={<IconBrain />}
        label="If the model fails, try"
        description="When the current model errors (quota, outage, refused key) the conversation continues on the next one. A fallback that is not on this PC is confirmed first, because the conversation would be sent to it."
        keywords="fallbacks failover backup model provider"
        below={
          <div className="flex flex-col gap-2">
            {s.fallbacks.length === 0 && <span className="text-[12px] text-fg-4">No fallback.</span>}
            {s.fallbacks.map((entry, index) => (
              <div key={`${entry.provider}:${entry.model ?? ''}`} className="flex items-center gap-2">
                <span className="w-5 text-right text-[11px] text-fg-4">{index + 1}</span>
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg-2">
                  {name(entry.provider)}
                  {entry.model ? ` · ${entry.model}` : ' · same model name'}
                </span>
                <GlassButton size="sm" variant="ghost" disabled={saving || index === 0} onClick={() => void setFallbacks(moveItem(s.fallbacks, index, index - 1))} aria-label={`Move ${name(entry.provider)} up`}>
                  <IconArrowUp />
                </GlassButton>
                <GlassButton size="sm" variant="ghost" disabled={saving || index === s.fallbacks.length - 1} onClick={() => void setFallbacks(moveItem(s.fallbacks, index, index + 1))} aria-label={`Move ${name(entry.provider)} down`}>
                  <IconArrowDown />
                </GlassButton>
                <GlassButton size="sm" variant="ghost" disabled={saving} onClick={() => void setFallbacks(s.fallbacks.filter((_, i) => i !== index))} aria-label={`Remove ${name(entry.provider)}`}>
                  <IconTrash />
                </GlassButton>
              </div>
            ))}
            {s.fallbacks.length < 5 && free.length > 0 && (
              <div className="flex items-center gap-2">
                <select value={added} onChange={event => setAdded(event.target.value)} aria-label="Provider to add as a fallback" style={{ colorScheme: 'dark' }} className="glass-input h-8 min-w-0 flex-1 rounded-lg px-2 text-[12.5px] text-fg outline-none">
                  <option value="">Add a provider…</option>
                  {free.map(p => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                      {p.local ? ' (on this PC)' : ''}
                    </option>
                  ))}
                </select>
                <GlassButton size="sm" variant="secondary" disabled={saving || !added} onClick={() => void setFallbacks([...s.fallbacks, { provider: added }]).then(ok => ok && setAdded(''))}>
                  Add
                </GlassButton>
              </div>
            )}
            {s.fallbacks.length < 5 && free.length === 0 && <span className="text-[12px] text-fg-4">Only providers with a key (or on this PC) can be added.</span>}
          </div>
        }
      />
      <SwitchRow icon={<IconBrain />} label="Anthropic fallbacks" description="Claude only: let the API retry a refused request on a fallback model." keywords="anthropic claude fallback retry" value={s.anthropicFallbacks} disabled={saving} onChange={value => void save({ anthropicFallbacks: value })} />
      <ChoiceRow
        icon={<IconBrain />}
        label="Describe images for text-only models"
        description="When the conversation’s model cannot see images, they are described by another model. A provider that is not on this PC is confirmed first."
        keywords="image description vision describe provider"
        value={s.imageDescription.mode}
        options={[{ id: 'auto', label: 'When needed' }, { id: 'always', label: 'Always' }, { id: 'off', label: 'Never' }]}
        disabled={saving}
        onChange={value => void save({ imageDescription: { mode: value } })}
      />
      {s.imageDescription.mode !== 'off' && (
        <ChoiceRow
          icon={<IconBrain />}
          label="Model that describes images"
          description={s.imageDescription.provider ? `${name(s.imageDescription.provider)}${s.imageDescription.model ? ` · ${s.imageDescription.model}` : ''}` : 'None chosen: images are not described.'}
          keywords="image description provider vision"
          value={s.imageDescription.provider}
          options={[{ id: '', label: 'None' }, ...providers.filter(p => p.configured).map(p => ({ id: p.id, label: p.name }))]}
          disabled={saving}
          onChange={value => void save({ imageDescription: { provider: value } })}
        />
      )}
    </SettingsGroup>
  )
}
