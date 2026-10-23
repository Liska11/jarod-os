import { useStore } from '@nanostores/react'
import { IconBrain, IconEyeOff, IconFolder, IconHash, IconHistory, IconShieldLock, IconTrash, IconX } from '@tabler/icons-react'
import { useEffect, useState } from 'react'
import { GlassButton, GlassCard, LinkAction, Toggle } from '../../../components/ui/glass.tsx'
import { useLocalData } from '../../../lib/use-async.ts'
import { $env } from '../../../store/backend.ts'
import { $continuity, forgetThreads, setContinuityEnabled, setExclusions } from '../../../store/continuity.ts'
import { notify } from '../../../store/notifications.ts'
import { UnifiedAuditLog } from './UnifiedAuditLog.tsx'
import { errorText, markSaved, SectionTitle, SettingsBlock, SettingsGroup, SettingsRow } from './shared.tsx'
import { t, useT } from '../../../lib/i18n.ts'

/*
 * Privacy: what "Pick up where you left off" may look at, the raw permission policy the Jarod-OS
 * bridge plugin enforces, and the audit trail. The textarea is the source of truth; the "Ask
 * before sending" toggle in Hermes & agents edits the same file line by line.
 */

function ContinuitySettings() {
  useT()
  const continuity = useStore($continuity)
  const home = useStore($env)?.homeDir ?? ''
  const [word, setWord] = useState('')
  const add = (entries: string[]) => void setExclusions([...continuity.exclude, ...entries])
  const isFolder = (entry: string) => entry.startsWith('/') || entry.startsWith('~')

  const pickFolders = async () => {
    const picked = await window.jarodOS.fs.pickFiles({ directory: true, multiple: true })
    add(picked.map(target => (home && target.startsWith(`${home}/`) ? `~${target.slice(home.length)}` : target)))
  }

  return (
    <SettingsGroup title={t('settings.privacy.continuity')}>
      <SettingsRow
        icon={<IconBrain />}
        label={t('settings.privacy.continuity')}
        description={t('settings.privacy.continuity.hint')}
        keywords="continuity resume catch up brain context recent work suggestions welcome back"
      >
        <Toggle checked={continuity.enabled === true} onChange={enabled => void setContinuityEnabled(enabled)} label={t('settings.privacy.continuity')} />
      </SettingsRow>
      <SettingsRow
        icon={<IconEyeOff />}
        label={t('settings.privacy.never')}
        description={t('settings.privacy.never.hint')}
        keywords="exclude hide private confidential folders words clients"
        below={
          <div className="flex flex-col gap-2.5">
            {continuity.exclude.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {continuity.exclude.map(entry => (
                  <span key={entry} className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-full border border-line bg-white/6 pr-1 pl-2.5 text-[12px] text-fg-2">
                    {isFolder(entry) ? <IconFolder size={13} className="shrink-0 text-fg-3" /> : <IconHash size={13} className="shrink-0 text-fg-3" />}
                    <span className="truncate">{entry}</span>
                    <button
                      type="button"
                      aria-label={t('settings.privacy.never.remove', { entry })}
                      onClick={() => void setExclusions(continuity.exclude.filter(e => e !== entry))}
                      className="flex size-5 shrink-0 items-center justify-center rounded-full text-fg-4 hover:bg-white/10 hover:text-fg"
                    >
                      <IconX size={12} />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <form
              className="flex gap-2"
              onSubmit={event => {
                event.preventDefault()

                if (word.trim()) {
                  add([word.trim()])
                  setWord('')
                }
              }}
            >
              <input
                value={word}
                onChange={event => setWord(event.target.value)}
                placeholder={t('settings.privacy.never.placeholder')}
                aria-label={t('settings.privacy.never.aria')}
                className="glass-input h-8 min-w-0 flex-1 rounded-lg px-3 text-[12.5px] text-fg outline-none"
              />
              <GlassButton size="sm" type="submit" disabled={!word.trim()}>
                {t('settings.privacy.never.addWord')}
              </GlassButton>
            </form>
          </div>
        }
      >
        <GlassButton size="sm" onClick={() => void pickFolders()}>
          {t('settings.privacy.never.addFolder')}
        </GlassButton>
      </SettingsRow>
      <SettingsRow icon={<IconTrash />} label={t('settings.privacy.forget')} description={t('settings.privacy.forget.hint')} keywords="clear delete reset threads">
        <GlassButton size="sm" variant="ghost" disabled={!continuity.threads?.length} onClick={() => void forgetThreads()}>
          {t('settings.privacy.forget.button')}
        </GlassButton>
      </SettingsRow>
    </SettingsGroup>
  )
}

export function PrivacySection() {
  useT()
  const policy = useLocalData(() => window.jarodOS.bridge.readPolicy())
  const [draft, setDraft] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [showAudit, setShowAudit] = useState(false)
  const text = draft ?? policy.data ?? ''
  const dirty = draft !== null && draft !== policy.data

  useEffect(() => {
    setDraft(null)
  }, [policy.data])

  const save = async () => {
    setSaving(true)

    try {
      await window.jarodOS.bridge.writePolicy(text)
      markSaved()
      notify({ title: t('settings.privacy.saved'), body: t('settings.privacy.saved.body'), level: 'success' })
      policy.reload()
    } catch (error) {
      notify({ title: t('settings.privacy.saveFailed'), body: errorText(error), level: 'error' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <SectionTitle title={t('settings.privacy.title')} subtitle={t('settings.privacy.subtitle')} />

      <ContinuitySettings />

      <SettingsBlock title={t('settings.privacy.policy')} label={t('settings.privacy.policy')} description={t('settings.privacy.policy.hint')} keywords="permissions yaml tiers allow confirm deny bridge">
        <GlassCard className="flex flex-col gap-3 p-3.5">
          <div className="text-[12px] leading-snug text-fg-3">
            {t('settings.privacy.tiers')} <span className="text-fg-2">read</span> {t('settings.privacy.tiers.read')} <span className="text-fg-2">act</span> {t('settings.privacy.tiers.act')} <span className="text-fg-2">mutate</span> {t('settings.privacy.tiers.mutate')} <span className="text-fg-2">destructive</span> {t('settings.privacy.tiers.destructive')} {t('settings.privacy.tiers.takes')} <span className="font-mono text-fg-2">allow</span>, <span className="font-mono text-fg-2">confirm</span> {t('settings.privacy.tiers.or')} <span className="font-mono text-fg-2">deny</span>.
          </div>
          <textarea
            value={text}
            onChange={event => setDraft(event.target.value)}
            spellCheck={false}
            aria-label={t('settings.privacy.policy')}
            className="glass-input min-h-[260px] resize-y rounded-lg p-3 font-mono text-[12px] leading-relaxed text-fg-2 outline-none"
          />
          <div className="flex items-center justify-between gap-3">
            <span className="text-[11.5px] text-fg-4">{policy.error ? policy.error : dirty ? t('settings.privacy.unsaved') : t('settings.privacy.onDisk')}</span>
            <div className="flex items-center gap-2">
              <GlassButton size="sm" variant="ghost" disabled={!dirty} onClick={() => setDraft(null)}>
                {t('settings.privacy.revert')}
              </GlassButton>
              <GlassButton size="sm" variant="primary" disabled={!dirty || saving} onClick={() => void save()}>
                {t('settings.privacy.save')}
              </GlassButton>
            </div>
          </div>
        </GlassCard>
      </SettingsBlock>

      <SettingsGroup title={t('settings.privacy.protected')}>
        <SettingsRow
          icon={<IconShieldLock />}
          label={t('settings.privacy.protected')}
          description={t('settings.privacy.protected.hint')}
          keywords="secrets config.yaml never touched"
        />
      </SettingsGroup>

      <SettingsGroup title={t('settings.privacy.audit')}>
        <SettingsRow
          icon={<IconHistory />}
          label={t('settings.privacy.auditLog')}
          description={t('settings.privacy.auditLog.hint')}
          keywords="history activity agent bridge control mcp journal"
          below={showAudit ? <UnifiedAuditLog /> : undefined}
        >
          <LinkAction onClick={() => setShowAudit(o => !o)}>{showAudit ? t('settings.privacy.hideLog') : t('settings.privacy.viewLog')}</LinkAction>
        </SettingsRow>
      </SettingsGroup>
    </>
  )
}
