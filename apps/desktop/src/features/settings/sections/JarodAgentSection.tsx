import { IconAdjustments, IconArrowDown, IconArrowUp, IconBrain, IconListCheck, IconShieldLock, IconTerminal2, IconTrash, IconWorld } from '@tabler/icons-react'
import { useState } from 'react'
import { GlassButton, Pill } from '../../../components/ui/glass.tsx'
import { jarod } from '../../../lib/jarod.ts'
import { notify } from '../../../store/notifications.ts'
import { useBackendData } from '../../../lib/use-async.ts'
import { ChipsEditor, ChoiceRow, NumberRow, reportEngineError, SwitchRow, useJarodSettings } from './jarod-controls.tsx'
import {
  DECISION_LABEL,
  domainProblem,
  type Decision,
  type FallbackEntry,
  intProblem,
  type JarodOptions,
  type JarodSettings,
  moneyProblem,
  moveItem,
  type PermissionRule,
  programProblem,
  readRootProblem,
  rootProblem,
  ruleListProblem,
  ruleToolProblem,
  TOOL_SEARCH_LABEL
} from './jarod-settings-model.ts'
import { isUnsupported } from './providers-model.ts'
import { InlineNote, SectionTitle, SettingsGroup, SettingsRow } from './shared.tsx'
import { t, useT } from '../../../lib/i18n.ts'

/*
 * Agent & security: how the Jarod agent behaves and what it may do. Every control binds to the engine's `get/set-jarod-settings`:
 *   behaviour (mode, steps, memory, learning, budget, tool search), permissions (tools allowed without asking, ordered rules), the shell guard,
 *   and the models it may fall back to. A change that gives the agent more power or sends data elsewhere is confirmed in a native dialog by the engine.
 */

export function JarodAgentSection() {
  useT()
  const api = useJarodSettings()
  const s = api.settings

  if (isUnsupported(api.error)) {
    return (
      <>
        <SectionTitle title={t('settings.agent.title')} subtitle={t('settings.agent.subtitle')} />
        <InlineNote tone="info">{t('settings.agent.otherEngine')}</InlineNote>
      </>
    )
  }

  return (
    <>
      <SectionTitle title={t('settings.agent.title')} subtitle={t('settings.agent.subtitle')} />
      {api.error && <InlineNote tone="danger">{t('settings.agent.readFailed', { error: api.error })}</InlineNote>}
      {!s && api.loading && <div className="px-1 text-[12px] text-fg-4">{t('settings.privacy.loading')}</div>}
      {s && (
        <>
          <BehaviourGroup s={s} api={api} />
          <PermissionsGroup s={s} api={api} />
          <ShellGuardGroup s={s} api={api} />
          <ConnectedBrowserGroup s={s} api={api} />
          <ModelsGroup s={s} api={api} />
        </>
      )}
    </>
  )
}

type Props = { s: JarodSettings; api: ReturnType<typeof useJarodSettings> }

function BehaviourGroup({ s, api }: Props) {
  useT()
  const { save, saving } = api

  return (
    <SettingsGroup title={t('settings.agent.behaviour')}>
      <ChoiceRow
        icon={<IconAdjustments />}
        label={t('settings.agent.mode')}
        description={t('settings.agent.mode.hint')}
        keywords="agent mode build plan read-only"
        value={s.agentMode}
        options={[{ id: 'build', label: t('settings.agent.mode.build') }, { id: 'plan', label: t('settings.agent.mode.plan') }]}
        disabled={saving}
        onChange={value => void save({ agentMode: value })}
      />
      <SwitchRow icon={<IconShieldLock />} label={t('settings.agent.auto')} description={t('settings.agent.auto.hint')} keywords="auto approve tools yolo ask permission" value={s.autoApproveTools} disabled={saving} onChange={value => void save({ autoApproveTools: value })} />
      <NumberRow icon={<IconListCheck />} label={t('settings.agent.steps')} description={t('settings.agent.steps.hint')} keywords="max agent steps iterations limit" value={s.maxAgentSteps} validate={text => intProblem(text, 1, 500)} disabled={saving} onSave={value => save({ maxAgentSteps: value })} />
      <NumberRow
        icon={<IconBrain />}
        label={t('settings.agent.compact')}
        description={t('settings.agent.compact.hint')}
        keywords="compact threshold summarize history context"
        value={s.compactThreshold}
        format={value => (value === 0 ? t('settings.agent.off') : t('settings.agent.characters', { count: value.toLocaleString() }))}
        validate={text => intProblem(text, 10_000, 5_000_000, true)}
        disabled={saving}
        onSave={value => save({ compactThreshold: value })}
      />
      <ChoiceRow
        icon={<IconBrain />}
        label={t('settings.agent.toolSearch')}
        description={t('settings.agent.toolSearch.hint')}
        keywords="tool search tools hidden local model run_shell core"
        value={s.toolSearch}
        options={(Object.keys(TOOL_SEARCH_LABEL) as JarodSettings['toolSearch'][]).map(id => ({ id, label: t(TOOL_SEARCH_LABEL[id]) }))}
        disabled={saving}
        onChange={value => void save({ toolSearch: value })}
      />
      <SwitchRow icon={<IconBrain />} label={t('settings.agent.memory')} description={t('settings.agent.memory.hint')} keywords="memory inject remember" value={s.memoryInject} disabled={saving} onChange={value => void save({ memoryInject: value })} />
      <SwitchRow icon={<IconBrain />} label={t('settings.agent.titles')} description={t('settings.agent.titles.hint')} keywords="auto title name conversation" value={s.autoTitle} disabled={saving} onChange={value => void save({ autoTitle: value })} />
      <SwitchRow icon={<IconAdjustments />} label={t('settings.agent.browserShow')} description={t('settings.agent.browserShow.hint')} keywords="browser visible window agent web" value={s.browserVisible} disabled={saving} onChange={value => void save({ browserVisible: value })} />
      <SwitchRow icon={<IconShieldLock />} label={t('settings.agent.browserKeep')} description={t('settings.agent.browserKeep.hint')} keywords="browser persistent cookies login session" value={s.browserPersistent} disabled={saving} onChange={value => void save({ browserPersistent: value })} />
      <SettingsRow icon={<IconShieldLock />} label={t('settings.agent.browserForget')} description={t('settings.agent.browserForget.hint')} keywords="browser forget clear cookies">
        <GlassButton size="sm" variant="secondary" disabled={saving} onClick={() => void jarod<boolean>('agent-browser-forget').then(done => done && notify({ title: t('settings.agent.browserForgotten'), level: 'success' }), error => reportEngineError(t('settings.agent.browser'), error))}>
          {t('settings.agent.forget')}
        </GlassButton>
      </SettingsRow>
      <SwitchRow icon={<IconBrain />} label={t('settings.agent.learn')} description={t('settings.agent.learn.hint')} keywords="learning review curator skills" value={s.learning.enabled} disabled={saving} onChange={value => void save({ learning: { enabled: value } })} />
      <NumberRow icon={<IconBrain />} label={t('settings.agent.review')} description={t('settings.agent.review.hint')} keywords="learning review every" value={s.learning.reviewEvery} format={value => t('settings.agent.exchanges', { count: value })} validate={text => intProblem(text, 1, 1000)} disabled={saving || !s.learning.enabled} onSave={value => save({ learning: { reviewEvery: value } })} />
      <NumberRow icon={<IconListCheck />} label={t('settings.agent.tokens')} description={t('settings.agent.tokens.hint')} keywords="budget tokens limit session" value={s.sessionBudget.maxTokens} format={value => (value === 0 ? t('settings.agent.noLimit') : value.toLocaleString())} validate={text => intProblem(text, 1, 1_000_000_000, true)} disabled={saving} onSave={value => save({ sessionBudget: { maxTokens: value } })} />
      <NumberRow icon={<IconListCheck />} label={t('settings.agent.cost')} description={t('settings.agent.cost.hint')} keywords="budget cost dollars limit session" value={s.sessionBudget.maxCostUsd} format={value => (value === 0 ? t('settings.agent.noLimit') : `$${value}`)} validate={moneyProblem} disabled={saving} onSave={value => save({ sessionBudget: { maxCostUsd: value } })} />
    </SettingsGroup>
  )
}

function PermissionsGroup({ s, api }: Props) {
  useT()
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
      <SettingsGroup title={t('settings.agent.permissions')}>
        <SettingsRow
          icon={<IconShieldLock />}
          label={t('settings.agent.allowed')}
          description={t('settings.agent.allowed.hint')}
          keywords="always allow tools approval remembered"
          below={<ChipsEditorReadOnly items={s.alwaysAllowTools} disabled={saving} onRemove={item => void save({ alwaysAllowTools: s.alwaysAllowTools.filter(other => other !== item) }, t('settings.agent.toolRemoved'))} />}
        />
        <SettingsRow
          icon={<IconListCheck />}
          label={t('settings.agent.rules')}
          description={t('settings.agent.rules.hint')}
          keywords="permissions rules allow ask deny order tool"
          below={
            <div className="flex flex-col gap-2">
              {draft.length === 0 && <span className="text-[12px] text-fg-4">{t('settings.agent.noRules')}</span>}
              {draft.map((rule, index) => (
                <div key={rule.tool} className="flex items-center gap-2">
                  <span className="w-5 text-right text-[11px] text-fg-4">{index + 1}</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-fg-2">{rule.tool}</span>
                  <select value={rule.decision} disabled={saving} onChange={event => setRules(draft.map((r, i) => (i === index ? { ...r, decision: event.target.value as Decision } : r)))} aria-label={t('settings.agent.decisionFor', { tool: rule.tool })} style={{ colorScheme: 'dark' }} className="glass-input h-7 rounded-md px-1.5 text-[12px] text-fg outline-none">
                    {(Object.keys(DECISION_LABEL) as Decision[]).map(d => (
                      <option key={d} value={d}>
                        {t(DECISION_LABEL[d])}
                      </option>
                    ))}
                  </select>
                  <GlassButton size="sm" variant="ghost" disabled={saving || index === 0} onClick={() => setRules(moveItem(draft, index, index - 1))} aria-label={t('settings.agent.moveUp', { name: rule.tool })}>
                    <IconArrowUp />
                  </GlassButton>
                  <GlassButton size="sm" variant="ghost" disabled={saving || index === draft.length - 1} onClick={() => setRules(moveItem(draft, index, index + 1))} aria-label={t('settings.agent.moveDown', { name: rule.tool })}>
                    <IconArrowDown />
                  </GlassButton>
                  <GlassButton size="sm" variant="ghost" disabled={saving} onClick={() => setRules(draft.filter((_, i) => i !== index))} aria-label={t('settings.agent.removeRule', { tool: rule.tool })}>
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
                  <span className="sr-only">{t('settings.agent.newRule.tool')}</span>
                  <input value={tool} onChange={event => setTool(event.target.value)} placeholder={t('settings.agent.newRule.placeholder')} spellCheck={false} className="min-w-0 flex-1 bg-transparent font-mono text-[12.5px] outline-none placeholder:text-fg-4" />
                </label>
                <select value={decision} onChange={event => setDecision(event.target.value as Decision)} aria-label={t('settings.agent.newRule.decision')} style={{ colorScheme: 'dark' }} className="glass-input h-8 rounded-lg px-2 text-[12.5px] text-fg outline-none">
                  {(Object.keys(DECISION_LABEL) as Decision[]).map(d => (
                    <option key={d} value={d}>
                      {t(DECISION_LABEL[d])}
                    </option>
                  ))}
                </select>
                <GlassButton type="submit" size="sm" variant="secondary" disabled={!tool.trim() || Boolean(toolProblem)}>
                  {t('settings.agent.addRule')}
                </GlassButton>
              </form>
              {(toolProblem || listProblem) && <InlineNote tone="warn">{toolProblem ?? listProblem}</InlineNote>}
              {changed && (
                <div className="flex justify-end gap-2">
                  <GlassButton size="sm" variant="ghost" onClick={() => setRules(null)}>
                    {t('settings.agent.discard')}
                  </GlassButton>
                  <GlassButton size="sm" variant="primary" disabled={saving || Boolean(listProblem)} onClick={() => void save({ permissionsRules: draft }, t('settings.agent.rulesSaved')).then(ok => ok && setRules(null))}>
                    {t('settings.agent.saveRules')}
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
    return <span className="text-[12px] text-fg-4">{t('settings.agent.noneYet')}</span>
  }

  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map(item => (
        <span key={item} className="flex items-center gap-1 rounded-md bg-white/8 px-2 py-1 font-mono text-[12px] text-fg-2">
          {item}
          <button type="button" disabled={disabled} onClick={() => onRemove(item)} aria-label={t('settings.agent.stopAllowing', { tool: item })} className="text-fg-4 hover:text-fg disabled:opacity-40">
            ×
          </button>
        </span>
      ))}
    </div>
  )
}

function ShellGuardGroup({ s, api }: Props) {
  useT()
  const { save, saving } = api
  const g = s.shellGuard
  const options = useBackendData(() => jarod<JarodOptions>('get-jarod-options'))
  const patch = (shellGuard: Record<string, unknown>, title = t('settings.agent.guardUpdated')) => save({ shellGuard }, title)

  return (
    <SettingsGroup title={t('settings.agent.guard')}>
      <ChoiceRow
        icon={<IconTerminal2 />}
        label={t('settings.agent.writeScope')}
        description={t('settings.agent.writeScope.hint')}
        keywords="shell guard write scope workspace confinement"
        value={g.writeScope}
        options={[{ id: 'workspace', label: t('settings.agent.writeScope.workspace') }, { id: 'off', label: t('settings.agent.writeScope.off') }]}
        disabled={saving}
        onChange={value => void patch({ writeScope: value })}
      />
      <SettingsRow icon={<IconTerminal2 />} label={t('settings.agent.writable')} description={t('settings.agent.writable.hint')} keywords="shell guard writable roots folders" below={<ChipsEditor items={g.writableRoots} validate={rootProblem} onChange={items => patch({ writableRoots: items })} disabled={saving} placeholder="build" label={t('settings.agent.writable.aria')} />} />
      <SettingsRow icon={<IconTerminal2 />} label={t('settings.agent.readable')} description={t('settings.agent.readable.hint')} keywords="shell guard read roots tools folders path scoop cargo" below={<ChipsEditor items={g.readRoots} validate={readRootProblem} onChange={items => patch({ readRoots: items })} disabled={saving} placeholder={'C:\\Users\\you\\scoop\\shims'} label={t('settings.agent.readable.aria')} />} />
      <SettingsRow icon={<IconTerminal2 />} label={t('settings.agent.denied')} description={t('settings.agent.denied.hint')} keywords="shell guard denied programs blocklist" below={<ChipsEditor items={g.deniedPrograms} validate={programProblem} onChange={items => patch({ deniedPrograms: items })} disabled={saving} placeholder="rm" label={t('settings.agent.denied.aria')} />} />
      <SettingsRow icon={<IconTerminal2 />} label={t('settings.agent.ask')} description={t('settings.agent.ask.hint')} keywords="shell guard ask programs confirm" below={<ChipsEditor items={g.askPrograms} validate={programProblem} onChange={items => patch({ askPrograms: items })} disabled={saving} placeholder="git" label={t('settings.agent.ask.aria')} />} />
      <SettingsRow icon={<IconTerminal2 />} label={t('settings.agent.only')} description={g.allowedPrograms.length === 0 ? t('settings.agent.only.empty') : t('settings.agent.only.set')} keywords="shell guard allowed programs allowlist" below={<ChipsEditor items={g.allowedPrograms} validate={programProblem} onChange={items => patch({ allowedPrograms: items })} disabled={saving} placeholder="node" label={t('settings.agent.only.aria')} />} />
      <ChoiceRow
        icon={<IconTerminal2 />}
        label={t('settings.agent.env')}
        description={t('settings.agent.env.hint')}
        keywords="shell guard environment docker local container"
        value={g.environment}
        options={[{ id: 'local', label: t('settings.agent.env.local') }, { id: 'docker', label: t('settings.agent.env.docker') }]}
        disabled={saving}
        onChange={value => void patch({ environment: value })}
      />
      {g.environment === 'docker' && (
        <>
          <SwitchRow icon={<IconTerminal2 />} label={t('settings.agent.network')} description={t('settings.agent.network.hint')} keywords="docker network" value={g.docker.network} disabled={saving} onChange={value => void patch({ docker: { network: value } })} />
        </>
      )}
      {options.data?.shellGuardText && (
        <SettingsRow icon={<IconShieldLock />} label={t('settings.agent.now')} keywords="shell guard effective policy" below={<pre className="max-h-48 overflow-auto rounded-lg bg-black/25 p-2.5 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-fg-3">{options.data.shellGuardText}</pre>}>
          <Pill tone="muted">{t('settings.agent.readOnly')}</Pill>
        </SettingsRow>
      )}
    </SettingsGroup>
  )
}

function ConnectedBrowserGroup({ s, api }: Props) {
  useT()
  const { save, saving } = api
  const c = s.connectedBrowser
  const patch = (connectedBrowser: Record<string, unknown>) => save({ connectedBrowser }, t('settings.agent.cbrowser.updated'))

  return (
    <SettingsGroup title={t('settings.agent.cbrowser')}>
      <SwitchRow icon={<IconWorld />} label={t('settings.agent.cbrowser.enable')} description={t('settings.agent.cbrowser.enable.hint')} keywords="connected browser web chrome e2 allow domains" value={c.enabled} disabled={saving} onChange={value => void patch({ enabled: value })} />
      <SettingsRow icon={<IconWorld />} label={t('settings.agent.cbrowser.allow')} description={t('settings.agent.cbrowser.allow.hint')} keywords="connected browser allowed domains allowlist" below={<ChipsEditor items={c.allowDomains} validate={domainProblem} onChange={items => patch({ allowDomains: items })} disabled={saving} placeholder="example.org" label={t('settings.agent.cbrowser.allow.aria')} />} />
      <SettingsRow icon={<IconWorld />} label={t('settings.agent.cbrowser.deny')} description={t('settings.agent.cbrowser.deny.hint')} keywords="connected browser blocked domains denylist" below={<ChipsEditor items={c.denyDomains} validate={domainProblem} onChange={items => patch({ denyDomains: items })} disabled={saving} placeholder="ads.example.org" label={t('settings.agent.cbrowser.deny.aria')} />} />
      <InlineNote tone="info">{t('settings.agent.cbrowser.note')}</InlineNote>
    </SettingsGroup>
  )
}

function ModelsGroup({ s, api }: Props) {
  useT()
  const { save, saving } = api
  const options = useBackendData(() => jarod<JarodOptions>('get-jarod-options'))
  const providers = options.data?.providers ?? []
  const name = (id: string) => providers.find(p => p.id === id)?.name ?? id
  const [added, setAdded] = useState('')
  const free = providers.filter(p => p.configured && p.id !== added && !s.fallbacks.some(f => f.provider === p.id))
  const setFallbacks = (list: FallbackEntry[]) => save({ fallbacks: list }, t('settings.agent.fallbacksSaved'))

  return (
    <SettingsGroup title={t('settings.agent.models')}>
      <SettingsRow
        icon={<IconBrain />}
        label={t('settings.agent.fallback')}
        description={t('settings.agent.fallback.hint')}
        keywords="fallbacks failover backup model provider"
        below={
          <div className="flex flex-col gap-2">
            {s.fallbacks.length === 0 && <span className="text-[12px] text-fg-4">{t('settings.agent.noFallback')}</span>}
            {s.fallbacks.map((entry, index) => (
              <div key={`${entry.provider}:${entry.model ?? ''}`} className="flex items-center gap-2">
                <span className="w-5 text-right text-[11px] text-fg-4">{index + 1}</span>
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg-2">
                  {name(entry.provider)}
                  {entry.model ? ` · ${entry.model}` : t('settings.agent.sameModel')}
                </span>
                <GlassButton size="sm" variant="ghost" disabled={saving || index === 0} onClick={() => void setFallbacks(moveItem(s.fallbacks, index, index - 1))} aria-label={t('settings.agent.moveUp', { name: name(entry.provider) })}>
                  <IconArrowUp />
                </GlassButton>
                <GlassButton size="sm" variant="ghost" disabled={saving || index === s.fallbacks.length - 1} onClick={() => void setFallbacks(moveItem(s.fallbacks, index, index + 1))} aria-label={t('settings.agent.moveDown', { name: name(entry.provider) })}>
                  <IconArrowDown />
                </GlassButton>
                <GlassButton size="sm" variant="ghost" disabled={saving} onClick={() => void setFallbacks(s.fallbacks.filter((_, i) => i !== index))} aria-label={t('settings.agent.remove', { name: name(entry.provider) })}>
                  <IconTrash />
                </GlassButton>
              </div>
            ))}
            {s.fallbacks.length < 5 && free.length > 0 && (
              <div className="flex items-center gap-2">
                <select value={added} onChange={event => setAdded(event.target.value)} aria-label={t('settings.agent.addFallback.aria')} style={{ colorScheme: 'dark' }} className="glass-input h-8 min-w-0 flex-1 rounded-lg px-2 text-[12.5px] text-fg outline-none">
                  <option value="">{t('settings.agent.addProvider')}</option>
                  {free.map(p => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                      {p.local ? t('settings.agent.onThisPc') : ''}
                    </option>
                  ))}
                </select>
                <GlassButton size="sm" variant="secondary" disabled={saving || !added} onClick={() => void setFallbacks([...s.fallbacks, { provider: added }]).then(ok => ok && setAdded(''))}>
                  {t('settings.devices.add')}
                </GlassButton>
              </div>
            )}
            {s.fallbacks.length < 5 && free.length === 0 && <span className="text-[12px] text-fg-4">{t('settings.agent.onlyKeyed')}</span>}
          </div>
        }
      />
      <SwitchRow icon={<IconBrain />} label={t('settings.agent.anthropic')} description={t('settings.agent.anthropic.hint')} keywords="anthropic claude fallback retry" value={s.anthropicFallbacks} disabled={saving} onChange={value => void save({ anthropicFallbacks: value })} />
      <ChoiceRow
        icon={<IconBrain />}
        label={t('settings.agent.images')}
        description={t('settings.agent.images.hint')}
        keywords="image description vision describe provider"
        value={s.imageDescription.mode}
        options={[{ id: 'auto', label: t('settings.agent.images.auto') }, { id: 'always', label: t('settings.agent.images.always') }, { id: 'off', label: t('settings.agent.images.off') }]}
        disabled={saving}
        onChange={value => void save({ imageDescription: { mode: value } })}
      />
      {s.imageDescription.mode !== 'off' && (
        <ChoiceRow
          icon={<IconBrain />}
          label={t('settings.agent.imageModel')}
          description={s.imageDescription.provider ? `${name(s.imageDescription.provider)}${s.imageDescription.model ? ` · ${s.imageDescription.model}` : ''}` : t('settings.agent.imageModel.none')}
          keywords="image description provider vision"
          value={s.imageDescription.provider}
          options={[{ id: '', label: t('settings.agent.none') }, ...providers.filter(p => p.configured).map(p => ({ id: p.id, label: p.name }))]}
          disabled={saving}
          onChange={value => void save({ imageDescription: { provider: value } })}
        />
      )}
    </SettingsGroup>
  )
}
