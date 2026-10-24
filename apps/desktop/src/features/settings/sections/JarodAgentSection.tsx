import { IconAdjustments, IconArrowDown, IconArrowUp, IconBrain, IconHandStop, IconListCheck, IconShieldCheck, IconShieldLock, IconSettings, IconTerminal2, IconTrash, IconWorld, IconBolt } from '@tabler/icons-react'
import { useState } from 'react'
import { GlassButton, Pill } from '../../../components/ui/glass.tsx'
import { jarod } from '../../../lib/jarod.ts'
import { notify } from '../../../store/notifications.ts'
import { useBackendData } from '../../../lib/use-async.ts'
import { ChipsEditor, ChoiceRow, NumberRow, reportEngineError, SwitchRow, useJarodSettings } from './jarod-controls.tsx'
import {
  ACCESS_PROFILES,
  type AccessProfile,
  domainProblem,
  CAPABILITIES,
  type Capability,
  type FallbackEntry,
  intProblem,
  type JarodOptions,
  type JarodSettings,
  moneyProblem,
  moveItem,
  programProblem,
  readRootProblem,
  rootProblem,
  TOOL_SEARCH_LABEL
} from './jarod-settings-model.ts'
import { isUnsupported } from './providers-model.ts'
import { PermissionRulesEditor } from './PermissionRulesEditor.tsx'
import { InlineNote, RadioCard, SectionTitle, SettingsBlock, SettingsGroup, SettingsRow } from './shared.tsx'
import { type MessageKey, t, useT } from '../../../lib/i18n.ts'

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
          <AccessProfileGroup s={s} api={api} />
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

const PROFILE_ICON: Record<AccessProfile, React.ReactNode> = { ask: <IconHandStop />, approve: <IconShieldCheck />, full: <IconBolt />, custom: <IconSettings /> }

/**
 * V-09 — le préréglage de profil d'accès, au-dessus des règles. Le moteur décide et demande la confirmation native pour tout ce qui donne plus
 * de pouvoir (elle nomme les limites dures) ; l'écran ne fait que choisir.
 */
function AccessProfileGroup({ s, api }: Props) {
  useT()
  const { save, saving } = api
  const current = s.accessProfile ?? 'custom'

  return (
    <SettingsBlock title={t('settings.agent.profile')} label={t('settings.agent.profile')} description={t('settings.agent.profile.limits')} keywords="access profile ask approve full custom hard limits autonomy permissions">
      <div className="flex flex-col gap-2" data-testid="access-profiles">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {ACCESS_PROFILES.map(id => (
            <RadioCard
              key={id}
              icon={PROFILE_ICON[id]}
              label={t(`settings.agent.profile.${id}`)}
              description={t(`settings.agent.profile.${id}.hint`)}
              selected={current === id}
              disabled={saving}
              onSelect={() => void save({ accessProfile: id })}
            />
          ))}
        </div>
        <div className="px-0.5 text-[11.5px] leading-snug text-fg-4">{t('settings.agent.profile.limits')}</div>
      </div>
    </SettingsBlock>
  )
}

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
      <SwitchRow
        icon={<IconShieldLock />}
        label={t('settings.agent.auto')}
        description={(s.accessProfile ?? 'custom') === 'custom' ? t('settings.agent.auto.hint') : t('settings.agent.auto.profile')}
        keywords="auto approve tools yolo ask permission"
        value={s.autoApproveTools}
        disabled={saving || (s.accessProfile ?? 'custom') !== 'custom'}
        onChange={value => void save({ autoApproveTools: value })}
      />
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

  return (
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
        keywords="permissions rules allow ask deny order tool autonomy uses duration revoke jarod permissions"
        below={<PermissionRulesEditor rules={s.permissionsRules} reload={api.reload} />}
      />
    </SettingsGroup>
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
        <SwitchRow icon={<IconTerminal2 />} label={t('settings.agent.network')} description={t('settings.agent.network.hint')} keywords="docker network" value={g.docker.network} disabled={saving} onChange={value => void patch({ docker: { network: value } })} />
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

/** V-19: one row per capability — a provider (configured ones only) and a model; saving or removing writes `capabilityRouting`. */
function CapabilityRows({ s, api, providers }: Props & { providers: JarodOptions['providers'] }) {
  useT()

  return (
    <SettingsRow
      icon={<IconBrain />}
      label={t('settings.agent.capability')}
      description={t('settings.agent.capability.hint')}
      keywords="capability routing vision code long context model per task"
      below={
        <div className="flex flex-col gap-2.5">
          {CAPABILITIES.map(cap => (
            <CapabilityRow key={cap} cap={cap} s={s} api={api} providers={providers} />
          ))}
        </div>
      }
    />
  )
}

function CapabilityRow({ cap, s, api, providers }: Props & { cap: Capability; providers: JarodOptions['providers'] }) {
  useT()
  const current = s.capabilityRouting?.[cap]
  const [provider, setProvider] = useState(current?.provider ?? '')
  const [model, setModel] = useState(current?.model ?? '')
  const usable = providers.filter(p => p.configured || p.id === current?.provider)
  const models = providers.find(p => p.id === provider)?.models ?? []
  const input = 'glass-input h-8 min-w-0 rounded-lg px-2 text-[12.5px] text-fg outline-none'
  const dirty = provider !== (current?.provider ?? '') || model !== (current?.model ?? '')

  return (
    <div className="flex flex-col gap-1" data-testid={`capability-${cap}`} data-route={current ? `${current.provider}:${current.model}` : ''}>
      <div className="text-[12px] text-fg-2">
        {t(`settings.agent.capability.${cap}` as MessageKey)} <span className="text-fg-4">· {t(`settings.agent.capability.${cap}.hint` as MessageKey)}</span>
      </div>
      <div className="flex items-center gap-2">
        <select value={provider} onChange={event => (setProvider(event.target.value), setModel(''))} aria-label={t(`settings.agent.capability.${cap}` as MessageKey)} style={{ colorScheme: 'dark' }} className={`${input} flex-1`}>
          <option value="">{t('settings.agent.capability.none')}</option>
          {usable.map(p => (
            <option key={p.id} value={p.id}>
              {p.name}
              {p.local ? t('settings.agent.onThisPc') : ''}
            </option>
          ))}
        </select>
        <input value={model} onChange={event => setModel(event.target.value)} disabled={!provider} list={`capability-models-${cap}`} placeholder={t('settings.agent.capability.model')} aria-label={`${t(`settings.agent.capability.${cap}` as MessageKey)} · ${t('settings.agent.capability.model')}`} spellCheck={false} className={`${input} flex-1 font-mono`} />
        <datalist id={`capability-models-${cap}`}>
          {models.map(m => (
            <option key={m} value={m} />
          ))}
        </datalist>
        {provider ? (
          <GlassButton size="sm" variant="secondary" disabled={api.saving || !model.trim() || !dirty} onClick={() => void api.save({ capabilityRouting: { [cap]: { provider, model: model.trim() } } }, t('settings.agent.capability.saved'))}>
            {t('settings.devices.save')}
          </GlassButton>
        ) : (
          <GlassButton size="sm" variant="ghost" disabled={api.saving || !current} onClick={() => void api.save({ capabilityRouting: { [cap]: null } }, t('settings.agent.capability.removed'))}>
            {t('settings.devices.ssh.remove')}
          </GlassButton>
        )}
      </div>
    </div>
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
      <CapabilityRows s={s} api={api} providers={providers} />
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
