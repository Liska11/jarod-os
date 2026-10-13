import { IconBolt, IconPuzzle } from '@tabler/icons-react'
import { useState } from 'react'
import { GlassButton, Pill, Toggle } from '../../../components/ui/glass.tsx'
import { jarod } from '../../../lib/jarod.ts'
import { useBackendData } from '../../../lib/use-async.ts'
import { notify } from '../../../store/notifications.ts'
import { reportEngineError } from './jarod-controls.tsx'
import { isUnsupported } from './providers-model.ts'
import { type ActionDraft, draftProblems, emptyAction, emptyRule, inputOf, type Plugin, pluginSummary, type Rule, type RuleDraft, ruleSummary, untrustedTools } from './rules-model.ts'
import { InlineNote, markSaved, SectionTitle, SettingsGroup, SettingsRow } from './shared.tsx'
import { t, useT } from '../../../lib/i18n.ts'

/*
 * Automation rules and user plugins.
 *   Rules: do something when a trigger fires (a schedule, a webhook, a button): ask the agent, show a notification, call a web address. The Automations page
 *   keeps the simple scheduled prompts; rules can chain several actions. Rules ask the agent in read-only mode unless you say otherwise.
 *   Plugins: code you installed that adds tools. A plugin runs in its own process with the permissions it declares; enabling one, or letting its tools run
 *   without asking, is confirmed by the engine in a native dialog.
 */

type Result = unknown

export function RulesSection() {
  useT()

  return (
    <>
      <SectionTitle title={t('settings.rules.title')} subtitle={t('settings.rules.subtitle')} />
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
      reportEngineError(t('settings.rules.automation'), error)

      return false
    } finally {
      setBusy(false)
    }
  }

  return { busy, run }
}

function RulesBlock() {
  useT()
  const rules = useBackendData(() => jarod<{ rules: Rule[] }>('automation-list'))
  const [draft, setDraft] = useState<RuleDraft | null>(null)
  const { busy, run } = useRun(rules.reload)
  const problems = draft ? draftProblems(draft) : []

  if (isUnsupported(rules.error)) {
    return <InlineNote tone="info">{t('settings.rules.needsJarod')}</InlineNote>
  }

  const set = <K extends keyof RuleDraft>(key: K, value: RuleDraft[K]) => setDraft(current => (current ? { ...current, [key]: value } : current))
  const setAction = (index: number, action: ActionDraft) => setDraft(current => (current ? { ...current, actions: current.actions.map((a, i) => (i === index ? action : a)) } : current))
  const input = 'glass-input rounded-lg px-2.5 text-[12.5px] text-fg outline-none placeholder:text-fg-4'

  return (
    <SettingsGroup title={t('settings.rules.rules')}>
      {rules.error && <InlineNote tone="danger">{t('settings.rules.readFailed', { error: rules.error })}</InlineNote>}
      {rules.data?.rules.length === 0 && <SettingsRow icon={<IconBolt />} label={t('settings.rules.none')} description={t('settings.rules.none.hint')} keywords="automation rules empty" />}
      {rules.data?.rules.map(rule => (
        <SettingsRow key={rule.id} icon={<IconBolt />} label={rule.name} description={<span className="line-clamp-2">{ruleSummary(rule)}</span>} keywords={`automation rule ${rule.name} ${rule.trigger.kind}`}>
          <GlassButton size="sm" variant="secondary" disabled={busy} onClick={() => void run(t('settings.rules.ran'), async () => {
            const result = await jarod<{ ok: boolean; error?: string }>('automation-run', rule.id)

            if (!result.ok) {
              throw new Error(result.error ?? t('settings.rules.failed'))
            }
          })} aria-label={t('settings.rules.runNow.aria', { name: rule.name })}>
            {t('settings.rules.runNow')}
          </GlassButton>
          <GlassButton size="sm" variant="ghost" disabled={busy} onClick={() => void run(t('settings.rules.removed'), () => jarod('automation-delete', rule.id))} aria-label={t('settings.agent.remove', { name: rule.name })}>
            {t('settings.devices.ssh.remove')}
          </GlassButton>
          <Toggle checked={rule.enabled} label={t('settings.rules.toggle', { name: rule.name })} disabled={busy} onChange={value => void run(value ? t('settings.rules.on') : t('settings.rules.off'), () => jarod('automation-update', rule.id, { enabled: value }))} />
        </SettingsRow>
      ))}
      <SettingsRow
        icon={<IconBolt />}
        label={t('settings.rules.new')}
        description={t('settings.rules.new.hint')}
        keywords="automation rule new add"
        below={
          draft && (
            <form
              className="flex flex-col gap-2.5"
              onSubmit={event => {
                event.preventDefault()

                if (problems.length === 0) {
                  void run(t('settings.rules.added'), () => jarod('automation-create', inputOf(draft))).then(ok => ok && setDraft(null))
                }
              }}
            >
              <input value={draft.name} onChange={event => set('name', event.target.value)} placeholder={t('settings.devices.ssh.name')} aria-label={t('settings.rules.name.aria')} className={`${input} h-8`} />
              <div className="flex items-center gap-2">
                <select value={draft.trigger} onChange={event => set('trigger', event.target.value as RuleDraft['trigger'])} aria-label={t('settings.rules.trigger')} style={{ colorScheme: 'dark' }} className={`${input} h-8`}>
                  <option value="schedule">{t('settings.rules.trigger.schedule')}</option>
                  <option value="webhook">{t('settings.rules.trigger.webhook')}</option>
                  <option value="manual">{t('settings.rules.trigger.manual')}</option>
                </select>
                {draft.trigger === 'schedule' && <input value={draft.cron} onChange={event => set('cron', event.target.value)} aria-label={t('settings.rules.cron')} spellCheck={false} placeholder="0 9 * * 1-5" className={`${input} h-8 flex-1 font-mono`} />}
                {draft.trigger === 'webhook' && <input value={draft.hookId} onChange={event => set('hookId', event.target.value)} aria-label={t('settings.rules.hook')} spellCheck={false} placeholder={t('settings.rules.hook.placeholder')} className={`${input} h-8 flex-1 font-mono`} />}
              </div>
              {draft.actions.map((action, index) => (
                <div key={index} className="flex flex-col gap-2 rounded-lg border border-line p-2.5">
                  <div className="flex items-center gap-2">
                    <select value={action.type} onChange={event => setAction(index, emptyAction(event.target.value as ActionDraft['type']))} aria-label={t('settings.rules.actionType', { n: index + 1 })} style={{ colorScheme: 'dark' }} className={`${input} h-8`}>
                      <option value="agent">{t('settings.rules.action.agent')}</option>
                      <option value="notify">{t('settings.rules.action.notify')}</option>
                      <option value="webhook">{t('settings.rules.action.webhook')}</option>
                    </select>
                    {draft.actions.length > 1 && (
                      <GlassButton type="button" size="sm" variant="ghost" onClick={() => set('actions', draft.actions.filter((_, i) => i !== index))}>
                        {t('settings.rules.removeAction')}
                      </GlassButton>
                    )}
                  </div>
                  {action.type === 'agent' && (
                    <>
                      <textarea value={action.prompt} onChange={event => setAction(index, { ...action, prompt: event.target.value })} rows={3} placeholder={t('settings.rules.prompt.placeholder')} aria-label={t('settings.rules.prompt')} className={`${input} py-1.5`} />
                      <label className="flex items-center gap-2 text-[12px] text-fg-3">
                        <Toggle checked={action.mode === 'build'} onChange={value => setAction(index, { ...action, mode: value ? 'build' : 'plan' })} label={t('settings.rules.build')} />
                        {t('settings.rules.build.hint')}
                      </label>
                    </>
                  )}
                  {action.type === 'notify' && (
                    <>
                      <input value={action.title} onChange={event => setAction(index, { ...action, title: event.target.value })} placeholder={t('settings.rules.notify.title')} aria-label={t('settings.rules.notify.title.aria')} className={`${input} h-8`} />
                      <input value={action.body} onChange={event => setAction(index, { ...action, body: event.target.value })} placeholder={t('settings.rules.notify.text')} aria-label={t('settings.rules.notify.text.aria')} className={`${input} h-8`} />
                    </>
                  )}
                  {action.type === 'webhook' && (
                    <>
                      <input value={action.url} onChange={event => setAction(index, { ...action, url: event.target.value })} placeholder="https://…" aria-label={t('settings.devices.ssh.address')} spellCheck={false} className={`${input} h-8 font-mono`} />
                      <textarea value={action.payload} onChange={event => setAction(index, { ...action, payload: event.target.value })} rows={2} aria-label={t('settings.rules.payload')} spellCheck={false} className={`${input} py-1.5 font-mono`} />
                    </>
                  )}
                </div>
              ))}
              <div>
                <GlassButton type="button" size="sm" variant="ghost" onClick={() => set('actions', [...draft.actions, emptyAction('notify')])}>
                  {t('settings.rules.addAction')}
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
                  {t('settings.devices.cancel')}
                </GlassButton>
                <GlassButton type="submit" size="sm" variant="primary" disabled={busy || problems.length > 0}>
                  {t('settings.agent.addRule')}
                </GlassButton>
              </div>
            </form>
          )
        }
      >
        <GlassButton size="sm" variant="primary" disabled={busy} onClick={() => setDraft(emptyRule())}>
          {t('settings.rules.newButton')}
        </GlassButton>
      </SettingsRow>
    </SettingsGroup>
  )
}

function PluginsBlock() {
  useT()
  const plugins = useBackendData(() => jarod<Plugin[]>('plugins-list'))
  const { busy, run } = useRun(plugins.reload)

  if (isUnsupported(plugins.error) || !plugins.data) {
    return null
  }

  return (
    <SettingsGroup title={t('settings.rules.plugins')}>
      {plugins.data.length === 0 && <SettingsRow icon={<IconPuzzle />} label={t('settings.rules.noPlugin')} description={t('settings.rules.noPlugin.hint')} keywords="plugins user empty" />}
      {plugins.data.map(plugin => {
        const open = untrustedTools(plugin)

        return (
          <SettingsRow key={plugin.id} icon={<IconPuzzle />} label={plugin.name} description={<span className="line-clamp-2">{[plugin.description, pluginSummary(plugin)].filter(Boolean).join(' — ')}</span>} keywords={`plugin ${plugin.name} ${plugin.id}`}>
            {plugin.state === 'error' && <Pill tone="danger">{t('settings.rules.error')}</Pill>}
            {plugin.state === 'active' && plugin.tools.length > 0 && (
              <GlassButton size="sm" variant="ghost" disabled={busy} onClick={() => void run(open.length ? t('settings.rules.trusted') : t('settings.rules.askAgain.done'), () => jarod('plugin-set-trust', plugin.id, [], open.length > 0))} aria-label={t(open.length ? 'settings.rules.trust.aria' : 'settings.rules.askAgain.aria', { name: plugin.name })}>
                {open.length ? t('settings.rules.trust') : t('settings.rules.askAgain')}
              </GlassButton>
            )}
            <Toggle checked={plugin.enabled} label={t('settings.rules.toggle', { name: plugin.name })} disabled={busy} onChange={value => void run(value ? t('settings.rules.pluginOn') : t('settings.rules.pluginOff'), () => jarod('plugin-set-enabled', plugin.id, value))} />
          </SettingsRow>
        )
      })}
    </SettingsGroup>
  )
}
