import { IconLock } from '@tabler/icons-react'
import { useState } from 'react'
import { GlassButton, Pill, Toggle } from '../../../components/ui/glass.tsx'
import { jarod } from '../../../lib/jarod.ts'
import { useBackendData } from '../../../lib/use-async.ts'
import { notify } from '../../../store/notifications.ts'
import { reportEngineError } from './jarod-controls.tsx'
import { isUnsupported } from './providers-model.ts'
import { InlineNote, markSaved, SectionTitle, SettingsGroup, SettingsRow } from './shared.tsx'
import { t, useT } from '../../../lib/i18n.ts'
import { draftOf, emptyVault, reachText, savePayload, VAULT_KINDS, type VaultDraft, type VaultEntry, type VaultKind, vaultProblems, type VaultStatus } from './vault-model.ts'

/*
 * Secrets: values the agent can use without ever seeing them. A secret can be sent only to the domains you list, and can be made available to shell commands
 * as an environment variable. The value is stored encrypted and is never shown again; leave the box empty when editing to keep it. Giving a secret more reach
 * (a new domain, shell access) is confirmed by the engine in a native dialog.
 */

export function VaultSection() {
  useT()
  const vault = useBackendData(() => jarod<VaultEntry[]>('vault-list'))
  // An older engine has no `vault-status`: the protection line is then left out, not guessed.
  const status = useBackendData(() => jarod<VaultStatus>('vault-status'))
  const [editing, setEditing] = useState<{ isNew: boolean; draft: VaultDraft } | null>(null)
  const [busy, setBusy] = useState(false)

  if (isUnsupported(vault.error)) {
    return (
      <>
        <SectionTitle title={t('settings.vault.title')} subtitle={t('settings.vault.subtitle')} />
        <InlineNote tone="info">{t('settings.vault.needsJarod')}</InlineNote>
      </>
    )
  }

  const names = (vault.data ?? []).map(entry => entry.name)

  const run = async (title: string, action: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true)

    try {
      await action()
      markSaved()
      notify({ title, level: 'success' })
      vault.reload()

      return true
    } catch (error) {
      reportEngineError(t('settings.vault.title'), error)

      return false
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <SectionTitle title={t('settings.vault.title')} subtitle={t('settings.vault.subtitle')} />
      {vault.error && <InlineNote tone="danger">{t('settings.vault.readFailed', { error: vault.error })}</InlineNote>}
      {status.data && (
        <InlineNote tone={status.data.encrypted && status.data.keyStore === 'dpapi' ? 'info' : 'warn'}>
          {t(status.data.encrypted ? (`settings.vault.status.${status.data.keyStore ?? 'other'}` as 'settings.vault.status.dpapi') : 'settings.vault.status.plain')}
        </InlineNote>
      )}
      <InlineNote tone="info">{t('settings.vault.sent')}</InlineNote>
      <SettingsGroup title={t('settings.vault.vault')}>
        {vault.data?.length === 0 && <SettingsRow icon={<IconLock />} label={t('settings.vault.none')} description={t('settings.vault.none.hint')} keywords="secrets vault empty" />}
        {vault.data?.map(entry => (
          <SettingsRow key={entry.name} icon={<IconLock />} label={entry.name} description={[entry.description, reachText(entry)].filter(Boolean).join(' — ')} keywords={`secret vault ${entry.name} ${entry.domains.join(' ')}`}>
            {!entry.hasValue && <Pill tone="warn">{t('settings.vault.noValue')}</Pill>}
            {entry.temporary && <Pill tone="accent">{t('settings.vault.temporaryPill')}</Pill>}
            {(entry.domains.length > 0 || entry.allowShell) && (
              <GlassButton size="sm" variant="ghost" disabled={busy} onClick={() => void run(t('settings.vault.revoked'), () => jarod('vault-revoke', entry.name))} aria-label={t('settings.vault.revoke.aria', { name: entry.name })}>
                {t('settings.vault.revoke')}
              </GlassButton>
            )}
            <GlassButton size="sm" variant="ghost" disabled={busy} onClick={() => setEditing({ isNew: false, draft: draftOf(entry) })} aria-label={t('settings.persona.edit.aria', { name: entry.name })}>
              {t('settings.persona.edit')}
            </GlassButton>
            <GlassButton size="sm" variant="ghost" disabled={busy} onClick={() => void run(t('settings.vault.removed'), () => jarod('vault-remove', entry.name))} aria-label={t('settings.agent.remove', { name: entry.name })}>
              {t('settings.devices.ssh.remove')}
            </GlassButton>
          </SettingsRow>
        ))}
        <SettingsRow icon={<IconLock />} label={editing ? (editing.isNew ? t('settings.vault.new') : t('settings.persona.edit.aria', { name: editing.draft.name })) : t('settings.vault.add')} description={t('settings.vault.add.hint')} keywords="secret vault add new" below={editing && <Form key={editing.draft.name || 'new'} state={editing} names={names} busy={busy} onCancel={() => setEditing(null)} onSave={draft => run(t('settings.vault.saved'), () => { const p = savePayload(draft); return jarod('vault-save', p.entry, p.value) }).then(ok => ok && setEditing(null))} />}>
          <GlassButton size="sm" variant="primary" disabled={busy} onClick={() => setEditing({ isNew: true, draft: emptyVault() })}>
            {t('settings.devices.addMore')}
          </GlassButton>
        </SettingsRow>
      </SettingsGroup>
    </>
  )
}

function Form({ state, names, busy, onCancel, onSave }: { state: { isNew: boolean; draft: VaultDraft }; names: string[]; busy: boolean; onCancel: () => void; onSave: (draft: VaultDraft) => Promise<unknown> }) {
  useT()
  const [draft, setDraft] = useState(state.draft)
  const problems = vaultProblems(draft, state.isNew, names)
  const set = <K extends keyof VaultDraft>(key: K, value: VaultDraft[K]) => setDraft(current => ({ ...current, [key]: value }))
  const input = 'glass-input rounded-lg px-2.5 text-[12.5px] text-fg outline-none placeholder:text-fg-4'

  return (
    <form
      className="flex flex-col gap-2.5"
      onSubmit={event => {
        event.preventDefault()

        if (problems.length === 0) {
          void onSave(draft)
        }
      }}
    >
      <div className="grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-1 text-[11.5px] text-fg-3">
          {t('settings.devices.ssh.name')}
          <input value={draft.name} disabled={!state.isNew} onChange={event => set('name', event.target.value)} spellCheck={false} placeholder="GithubToken" className={`${input} h-8 font-mono`} />
        </label>
        <label className="flex flex-col gap-1 text-[11.5px] text-fg-3">
          {state.isNew ? t('settings.vault.value') : t('settings.vault.value.keep')}
          <input type="password" autoComplete="off" spellCheck={false} value={draft.value} onChange={event => set('value', event.target.value)} className={`${input} h-8 font-mono`} />
        </label>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-[11.5px] text-fg-3">
          {t('settings.vault.kind')}
          <select value={draft.kind} onChange={event => set('kind', event.target.value as VaultKind)} className={`${input} h-8`}>
            {VAULT_KINDS.map(kind => (
              <option key={kind} value={kind}>
                {t(`settings.vault.kind.${kind}` as 'settings.vault.kind.other')}
              </option>
            ))}
          </select>
        </label>
        {state.isNew && (
          <label className="flex items-center gap-2 pb-1 text-[12px] text-fg-2">
            <Toggle checked={draft.temporary} onChange={value => set('temporary', value)} label={t('settings.vault.temporary')} />
            {t('settings.vault.temporary.hint')}
          </label>
        )}
      </div>
      <label className="flex flex-col gap-1 text-[11.5px] text-fg-3">
        {t('settings.vault.description')}
        <input value={draft.description} onChange={event => set('description', event.target.value)} placeholder={t('settings.vault.description.placeholder')} className={`${input} h-8`} />
      </label>
      <label className="flex flex-col gap-1 text-[11.5px] text-fg-3">
        {t('settings.vault.domains')}
        <textarea value={draft.domains} onChange={event => set('domains', event.target.value)} rows={2} spellCheck={false} placeholder="api.github.com" className={`${input} py-1.5 font-mono`} />
      </label>
      <div className="flex items-center gap-3">
        <label className="flex flex-1 flex-col gap-1 text-[11.5px] text-fg-3">
          {t('settings.vault.env')}
          <input value={draft.envVar} onChange={event => set('envVar', event.target.value)} spellCheck={false} placeholder="GITHUB_TOKEN" className={`${input} h-8 font-mono`} />
        </label>
        <label className="flex items-center gap-2 text-[12px] text-fg-2">
          <Toggle checked={draft.allowShell} onChange={value => set('allowShell', value)} label={t('settings.vault.shell')} />
          {t('settings.vault.shell.hint')}
        </label>
      </div>
      {problems.length > 0 && draft.name.trim() && (
        <InlineNote tone="warn">
          {problems.map(problem => (
            <div key={problem}>{problem}</div>
          ))}
        </InlineNote>
      )}
      <div className="flex justify-end gap-2">
        <GlassButton type="button" size="sm" variant="ghost" onClick={onCancel}>
          {t('settings.devices.cancel')}
        </GlassButton>
        <GlassButton type="submit" size="sm" variant="primary" disabled={busy || problems.length > 0}>
          {t('settings.devices.save')}
        </GlassButton>
      </div>
    </form>
  )
}
