import { IconPalette, IconUser, IconUserPlus } from '@tabler/icons-react'
import { useEffect, useState } from 'react'
import { GlassButton, Pill } from '../../../components/ui/glass.tsx'
import { jarod } from '../../../lib/jarod.ts'
import { useBackendData } from '../../../lib/use-async.ts'
import { notify } from '../../../store/notifications.ts'
import { isUnsupported } from './providers-model.ts'
import { errorText, InlineNote, markSaved, SectionTitle, SettingsGroup, SettingsRow } from './shared.tsx'
import { t, useT } from '../../../lib/i18n.ts'

/*
 * Persona & profiles. The persona (SOUL.md) is who the agent is: tone, rules, background; it is added to every conversation of the active profile.
 * A profile is a separate agent with its own memory, skills, keys and conversations. Jarod-OS serves one profile at a time: making another one active
 * restarts the engine on it. Removing a profile moves its folder aside (profiles-supprimes), it is not erased.
 */

interface ProfileInfo {
  id: string
  name: string
  isDefault: boolean
  isActive: boolean
  model: string
  provider: string
  hasSoul: boolean
  skillCount: number
  color: string
}

type Result = { success: boolean; error?: string; id?: string }

const HEX = /^#[0-9a-fA-F]{6}$/

export function PersonaSection() {
  useT()

  return (
    <>
      <SectionTitle title={t('settings.persona.title')} subtitle={t('settings.persona.subtitle')} />
      <SoulBlock />
      <ProfilesBlock />
    </>
  )
}

function SoulBlock() {
  useT()
  const soul = useBackendData(() => jarod<string>('read-soul'))
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmReset, setConfirmReset] = useState(false)
  const loaded = soul.data

  useEffect(() => {
    if (loaded !== null) {
      setText(loaded)
    }
  }, [loaded])

  if (isUnsupported(soul.error)) {
    return <InlineNote tone="info">{t('settings.persona.needsJarod')}</InlineNote>
  }

  const dirty = loaded !== null && text !== loaded

  const run = async (title: string, action: () => Promise<unknown>) => {
    setBusy(true)

    try {
      await action()
      markSaved()
      notify({ title, level: 'success' })
      soul.reload()
    } catch (error) {
      notify({ title: t('settings.persona.persona'), body: errorText(error), level: 'error' })
    } finally {
      setBusy(false)
      setConfirmReset(false)
    }
  }

  return (
    <SettingsGroup title={t('settings.persona.persona')}>
      <SettingsRow
        icon={<IconUser />}
        label={t('settings.persona.soul')}
        description={t('settings.persona.soul.hint')}
        keywords="persona soul identity prompt instructions personality"
        below={
          <div className="flex flex-col gap-2">
            {soul.error && <InlineNote tone="danger">{t('settings.persona.readFailed', { error: soul.error })}</InlineNote>}
            <textarea value={text} onChange={event => setText(event.target.value)} rows={12} spellCheck={false} aria-label={t('settings.persona.text')} className="glass-input w-full resize-y rounded-lg px-3 py-2 font-mono text-[12.5px] leading-relaxed text-fg outline-none" placeholder={t('settings.persona.placeholder')} />
            <div className="flex items-center justify-end gap-2">
              <span className="mr-auto text-[11.5px] text-fg-4">{t('settings.agent.characters', { count: text.length.toLocaleString() })}</span>
              {confirmReset ? (
                <>
                  <GlassButton size="sm" variant="danger" disabled={busy} onClick={() => void run(t('settings.persona.erased'), () => jarod('reset-soul'))}>
                    {t('settings.persona.erase')}
                  </GlassButton>
                  <GlassButton size="sm" variant="ghost" onClick={() => setConfirmReset(false)}>
                    {t('settings.persona.keep')}
                  </GlassButton>
                </>
              ) : (
                <GlassButton size="sm" variant="ghost" disabled={busy || !loaded} onClick={() => setConfirmReset(true)}>
                  {t('settings.persona.eraseMenu')}
                </GlassButton>
              )}
              <GlassButton size="sm" variant="ghost" disabled={busy || !dirty} onClick={() => setText(loaded ?? '')}>
                {t('settings.persona.discard')}
              </GlassButton>
              <GlassButton size="sm" variant="primary" disabled={busy || !dirty} onClick={() => void run(t('settings.persona.saved'), () => jarod('write-soul', text))}>
                {t('settings.devices.save')}
              </GlassButton>
            </div>
          </div>
        }
      />
    </SettingsGroup>
  )
}

function ProfilesBlock() {
  useT()
  const profiles = useBackendData(() => jarod<ProfileInfo[]>('list-profiles'))
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)

  if (isUnsupported(profiles.error)) {
    return null
  }

  const run = async (title: string, action: () => Promise<unknown>) => {
    setBusy(true)

    try {
      const result = (await action()) as Result | boolean | undefined

      if (result && typeof result === 'object' && result.success === false) {
        throw new Error(result.error ?? t('settings.persona.failed'))
      }

      markSaved()
      notify({ title, level: 'success' })
      profiles.reload()
    } catch (error) {
      notify({ title: t('settings.persona.profiles'), body: errorText(error), level: 'error' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingsGroup title={t('settings.persona.profiles')}>
      {profiles.error && <InlineNote tone="danger">{t('settings.persona.profilesFailed', { error: profiles.error })}</InlineNote>}
      {profiles.data?.map(profile => (
        <ProfileRow key={profile.id} profile={profile} busy={busy} run={run} />
      ))}
      <SettingsRow icon={<IconUserPlus />} label={t('settings.persona.new')} description={t('settings.persona.new.hint')} keywords="profile new create agent">
        <form
          className="flex items-center gap-2"
          onSubmit={event => {
            event.preventDefault()

            if (name.trim()) {
              void run(t('settings.persona.created'), () => jarod('create-profile', name.trim(), null)).then(() => setName(''))
            }
          }}
        >
          <label className="glass-input flex h-8 w-[200px] items-center rounded-lg px-2.5">
            <span className="sr-only">{t('settings.persona.new.name')}</span>
            <input value={name} onChange={event => setName(event.target.value)} maxLength={80} placeholder={t('settings.devices.ssh.name')} className="min-w-0 flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-fg-4" />
          </label>
          <GlassButton type="submit" size="sm" variant="primary" disabled={busy || !name.trim()}>
            {t('settings.persona.create')}
          </GlassButton>
        </form>
      </SettingsRow>
    </SettingsGroup>
  )
}

function ProfileRow({ profile, busy, run }: { profile: ProfileInfo; busy: boolean; run: (title: string, action: () => Promise<unknown>) => Promise<void> }) {
  const [editing, setEditing] = useState(false)
  const [label, setLabel] = useState(profile.name)
  const [color, setColor] = useState(HEX.test(profile.color) ? profile.color : '#2f7dff')
  const [confirm, setConfirm] = useState<'switch' | 'delete' | null>(null)
  useT()

  const details = [profile.id !== profile.name ? profile.id : null, profile.isActive && profile.provider ? `${profile.provider} · ${profile.model || t('settings.persona.defaultModel')}` : null, t(profile.skillCount === 1 ? 'settings.persona.skill' : 'settings.persona.skills', { count: profile.skillCount }), profile.hasSoul ? t('settings.persona.hasSoul') : null].filter(Boolean).join(' · ')

  return (
    <SettingsRow
      icon={<IconUser />}
      label={profile.name}
      description={details}
      keywords={`profile ${profile.id}`}
      below={
        (editing || confirm) && (
          <div className="flex flex-col gap-2">
            {editing && (
              <form
                className="flex flex-wrap items-center gap-2"
                onSubmit={event => {
                  event.preventDefault()

                  if (label.trim()) {
                    void run(t('settings.persona.updated'), async () => {
                      if (label.trim() !== profile.name) {
                        await jarod('set-profile-name', profile.id, label.trim())
                      }

                      if (HEX.test(color) && color !== profile.color) {
                        await jarod('set-profile-color', profile.id, color)
                      }
                    }).then(() => setEditing(false))
                  }
                }}
              >
                <label className="glass-input flex h-8 min-w-[180px] flex-1 items-center rounded-lg px-2.5">
                  <span className="sr-only">{t('settings.persona.displayName')}</span>
                  <input value={label} onChange={event => setLabel(event.target.value)} maxLength={80} className="min-w-0 flex-1 bg-transparent text-[12.5px] outline-none" />
                </label>
                <label className="flex items-center gap-1.5 text-[12px] text-fg-3">
                  <IconPalette size={15} />
                  <input type="color" value={color} onChange={event => setColor(event.target.value)} aria-label={t('settings.persona.colour')} className="h-8 w-10 cursor-pointer rounded bg-transparent" />
                </label>
                <GlassButton type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>
                  {t('settings.devices.cancel')}
                </GlassButton>
                <GlassButton type="submit" size="sm" variant="primary" disabled={busy || !label.trim()}>
                  {t('settings.devices.save')}
                </GlassButton>
              </form>
            )}
            {confirm === 'switch' && (
              <InlineNote tone="warn">
                {t('settings.persona.switchWarn', { name: profile.name })}
                <span className="ml-2 inline-flex gap-2">
                  <GlassButton size="sm" variant="primary" disabled={busy} onClick={() => void run(t('settings.persona.switching'), () => jarod('set-active-profile', profile.id)).then(() => setConfirm(null))}>
                    {t('settings.persona.switch')}
                  </GlassButton>
                  <GlassButton size="sm" variant="ghost" onClick={() => setConfirm(null)}>
                    {t('settings.devices.cancel')}
                  </GlassButton>
                </span>
              </InlineNote>
            )}
            {confirm === 'delete' && (
              <InlineNote tone="warn">
                {t('settings.persona.deleteWarn', { name: profile.name })}
                <span className="ml-2 inline-flex gap-2">
                  <GlassButton size="sm" variant="danger" disabled={busy} onClick={() => void run(t('settings.persona.removed'), () => jarod('delete-profile', profile.id)).then(() => setConfirm(null))}>
                    {t('settings.devices.ssh.remove')}
                  </GlassButton>
                  <GlassButton size="sm" variant="ghost" onClick={() => setConfirm(null)}>
                    {t('settings.devices.cancel')}
                  </GlassButton>
                </span>
              </InlineNote>
            )}
          </div>
        )
      }
    >
      {profile.isActive && (
        <Pill tone="ok" dot>
          {t('settings.persona.active')}
        </Pill>
      )}
      {!profile.isActive && (
        <GlassButton size="sm" variant="secondary" disabled={busy} onClick={() => setConfirm('switch')} aria-label={t('settings.persona.makeActive.aria', { name: profile.name })}>
          {t('settings.persona.makeActive')}
        </GlassButton>
      )}
      <GlassButton size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(e => !e)} aria-label={t('settings.persona.edit.aria', { name: profile.name })}>
        {t('settings.persona.edit')}
      </GlassButton>
      {!profile.isDefault && !profile.isActive && (
        <GlassButton size="sm" variant="ghost" disabled={busy} onClick={() => setConfirm('delete')} aria-label={t('settings.agent.remove', { name: profile.name })}>
          {t('settings.persona.removeMenu')}
        </GlassButton>
      )}
    </SettingsRow>
  )
}
