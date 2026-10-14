import { IconBrandDiscord, IconBrandSlack, IconBrandTelegram, IconBrandWhatsapp, IconExternalLink, IconMail, IconMessageCircle, IconPlayerPlay, IconPlayerStop, IconRefresh } from '@tabler/icons-react'
import { useState } from 'react'
import { GlassButton, Pill, Toggle } from '../../../components/ui/glass.tsx'
import { useT } from '../../../lib/i18n.ts'
import { jarod } from '../../../lib/jarod.ts'
import { useBackendData } from '../../../lib/use-async.ts'
import { notify } from '../../../store/notifications.ts'
import { fieldProblem, type MessagingPlatform, type MessagingPlatforms, missingFields, stateOf, updateFromDraft, visibleVars } from './messaging-model.ts'
import { isUnsupported } from './providers-model.ts'
import { errorText, InlineNote, markSaved, SectionTitle, SettingsGroup, SettingsRow } from './shared.tsx'
import { attempt } from '../../../lib/native.ts'

/*
 * Messaging: let the agent be reached from Telegram, Discord, Slack, e-mail and WhatsApp. Tokens go to the profile's encrypted store and never come back;
 * a field next to a saved secret stays empty unless you type a new value. Someone who writes to a channel for the first time gets a pairing code, which
 * you approve in a conversation with `/pair <code>`.
 */

const ICONS: Record<string, React.ReactNode> = { telegram: <IconBrandTelegram />, discord: <IconBrandDiscord />, slack: <IconBrandSlack />, email: <IconMail />, whatsapp: <IconBrandWhatsapp /> }

export function MessagingSection() {
  const { t } = useT()
  const data = useBackendData(() => jarod<MessagingPlatforms>('get-messaging-platforms'))
  const running = useBackendData(() => jarod<boolean>('gateway-status'))
  const [busy, setBusy] = useState(false)

  if (isUnsupported(data.error)) {
    return (
      <>
        <SectionTitle title={t('messaging.title')} subtitle={t('messaging.subtitle')} />
        <InlineNote tone="info">{t('messaging.needEngine')}</InlineNote>
      </>
    )
  }

  const reload = () => {
    data.reload()
    running.reload()
  }

  const control = async (channel: 'start-gateway' | 'stop-gateway' | 'restart-gateway', title: string) => {
    setBusy(true)

    try {
      await jarod(channel)
      notify({ title, level: 'success' })
      // The channels connect in the background: look again in a moment.
      setTimeout(reload, 1500)
    } catch (error) {
      notify({ title: t('messaging.errorTitle'), body: errorText(error), level: 'error' })
    } finally {
      setBusy(false)
      reload()
    }
  }

  return (
    <>
      <SectionTitle title={t('messaging.title')} subtitle={t('messaging.subtitle')} />
      {data.error && <InlineNote tone="danger">{t('messaging.readFailed', { error: data.error })}</InlineNote>}
      <SettingsGroup title={t('messaging.connection')}>
        <SettingsRow icon={<IconMessageCircle />} label={running.data ? t('messaging.running') : t('messaging.stopped')} description={t('messaging.connection.hint')} keywords="messaging gateways start stop restart channels">
          {running.data ? (
            <>
              <GlassButton size="sm" variant="secondary" disabled={busy} onClick={() => void control('restart-gateway', t('messaging.restarted'))}>
                <IconRefresh />
                {t('messaging.restart')}
              </GlassButton>
              <GlassButton size="sm" variant="secondary" disabled={busy} onClick={() => void control('stop-gateway', t('messaging.stoppedTitle'))}>
                <IconPlayerStop />
                {t('messaging.stop')}
              </GlassButton>
            </>
          ) : (
            <GlassButton size="sm" variant="primary" disabled={busy} onClick={() => void control('start-gateway', t('messaging.started'))}>
              <IconPlayerPlay />
              {t('messaging.start')}
            </GlassButton>
          )}
        </SettingsRow>
      </SettingsGroup>
      <SettingsGroup title={t('messaging.channels')}>
        {data.data?.platforms.map(platform => (
          <PlatformRow key={platform.id} platform={platform} onChanged={reload} />
        ))}
      </SettingsGroup>
      {data.data?.message && <div className="px-1 text-[11.5px] text-fg-4">{data.data.message}</div>}
    </>
  )
}

function PlatformRow({ platform, onChanged }: { platform: MessagingPlatform; onChanged: () => void }) {
  const { t } = useT()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [cleared, setCleared] = useState<string[]>([])
  const [advanced, setAdvanced] = useState(false)
  const [busy, setBusy] = useState(false)
  const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null)
  const state = stateOf(platform)
  const vars = visibleVars(platform.env_vars, advanced)
  const problems = Object.fromEntries(platform.env_vars.map(v => [v.key, fieldProblem(v, draft[v.key] ?? '')]))
  const anyProblem = Object.values(problems).some(Boolean)
  const update = updateFromDraft(draft, cleared)
  const missing = missingFields(platform)

  const run = async (title: string, action: () => Promise<unknown>) => {
    setBusy(true)

    try {
      await action()
      markSaved()
      notify({ title, body: platform.name, level: 'success' })
      onChanged()
    } catch (error) {
      notify({ title: t('messaging.updateFailed', { name: platform.name }), body: errorText(error), level: 'error' })
    } finally {
      setBusy(false)
    }
  }

  const close = () => {
    setOpen(false)
    setDraft({})
    setCleared([])
  }

  return (
    <SettingsRow
      icon={ICONS[platform.id] ?? <IconMessageCircle />}
      label={platform.name}
      description={platform.error_message ? `${platform.description} — ${platform.error_message}` : platform.description}
      keywords={`messaging ${platform.id} bot token channel`}
      below={
        open && (
          <form
            className="flex flex-col gap-3"
            onSubmit={event => {
              event.preventDefault()

              if (update && !anyProblem) {
                void run(t('messaging.saved'), () => jarod('update-messaging-platform', platform.id, update)).then(close)
              }
            }}
          >
            {vars.map(v => (
              <label key={v.key} className="flex flex-col gap-1 text-[11.5px] text-fg-3">
                <span>
                  {v.prompt || v.key}
                  {v.required ? ' *' : ''}
                  {v.is_set && !cleared.includes(v.key) ? t('messaging.savedMark') : ''}
                </span>
                <span className="flex items-center gap-2">
                  <input
                    type={v.is_password ? 'password' : 'text'}
                    autoComplete="off"
                    spellCheck={false}
                    value={draft[v.key] ?? ''}
                    disabled={cleared.includes(v.key)}
                    onChange={event => setDraft(current => ({ ...current, [v.key]: event.target.value }))}
                    placeholder={v.is_set ? t('messaging.leaveEmpty') : v.description}
                    className="glass-input h-8 min-w-0 flex-1 rounded-lg px-2.5 font-mono text-[12.5px] text-fg outline-none placeholder:text-fg-4"
                  />
                  {v.is_set && (
                    <GlassButton type="button" size="sm" variant="ghost" onClick={() => setCleared(current => (current.includes(v.key) ? current.filter(k => k !== v.key) : [...current, v.key]))}>
                      {cleared.includes(v.key) ? t('messaging.keep') : t('messaging.clear')}
                    </GlassButton>
                  )}
                  {v.url && (
                    <GlassButton type="button" size="sm" variant="ghost" onClick={() => void attempt('open the link', () => window.heraldOS.shell.openExternal(v.url!))} aria-label={t('messaging.whereToFind', { field: v.prompt || v.key })}>
                      <IconExternalLink />
                    </GlassButton>
                  )}
                </span>
                {problems[v.key] && <InlineNote tone="warn">{problems[v.key]}</InlineNote>}
              </label>
            ))}
            {platform.env_vars.some(v => v.advanced && !v.required) && (
              <button type="button" onClick={() => setAdvanced(a => !a)} className="self-start text-[12px] text-accent-strong">
                {advanced ? t('messaging.hideAdvanced') : t('messaging.showAdvanced')}
              </button>
            )}
            {test && <InlineNote tone={test.ok ? 'info' : 'warn'}>{test.message}</InlineNote>}
            <div className="flex items-center justify-end gap-2">
              {platform.docs_url && (
                <GlassButton type="button" size="sm" variant="ghost" onClick={() => void attempt('open the link', () => window.heraldOS.shell.openExternal(platform.docs_url))}>
                  {t('messaging.setupGuide')}
                </GlassButton>
              )}
              <GlassButton type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void jarod<{ ok: boolean; message: string }>('test-messaging-platform', platform.id).then(setTest, error => setTest({ ok: false, message: errorText(error) }))}>
                {t('messaging.checkStatus')}
              </GlassButton>
              <GlassButton type="button" size="sm" variant="ghost" onClick={close}>
                {t('messaging.cancel')}
              </GlassButton>
              <GlassButton type="submit" size="sm" variant="primary" disabled={busy || !update || anyProblem}>
                {t('messaging.save')}
              </GlassButton>
            </div>
          </form>
        )
      }
    >
      <Pill tone={state.tone} dot>
        {state.label}
      </Pill>
      <GlassButton size="sm" variant="secondary" onClick={() => (open ? close() : setOpen(true))} aria-label={t('messaging.setUpAria', { name: platform.name })}>
        {open ? t('messaging.close') : platform.configured ? t('messaging.edit') : t('messaging.setUp')}
      </GlassButton>
      <Toggle
        checked={platform.enabled}
        label={t('messaging.toggleAria', { name: platform.name })}
        disabled={busy || (!platform.enabled && missing.length > 0)}
        onChange={value => void run(value ? t('messaging.switchedOn') : t('messaging.switchedOff'), () => jarod('set-platform-enabled', platform.id, value))}
      />
    </SettingsRow>
  )
}
