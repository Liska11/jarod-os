import { IconLock } from '@tabler/icons-react'
import { useState } from 'react'
import { GlassButton, Pill, Toggle } from '../../../components/ui/glass.tsx'
import { jarod } from '../../../lib/jarod.ts'
import { useBackendData } from '../../../lib/use-async.ts'
import { notify } from '../../../store/notifications.ts'
import { isUnsupported } from './providers-model.ts'
import { errorText, InlineNote, markSaved, SectionTitle, SettingsGroup, SettingsRow } from './shared.tsx'
import { draftOf, emptyVault, reachText, savePayload, type VaultDraft, type VaultEntry, vaultProblems } from './vault-model.ts'

/*
 * Secrets: values the agent can use without ever seeing them. A secret can be sent only to the domains you list, and can be made available to shell commands
 * as an environment variable. The value is stored encrypted and is never shown again; leave the box empty when editing to keep it. Giving a secret more reach
 * (a new domain, shell access) is confirmed by the engine in a native dialog.
 */

export function VaultSection() {
  const vault = useBackendData(() => jarod<VaultEntry[]>('vault-list'))
  const [editing, setEditing] = useState<{ isNew: boolean; draft: VaultDraft } | null>(null)
  const [busy, setBusy] = useState(false)

  if (isUnsupported(vault.error)) {
    return (
      <>
        <SectionTitle title="Secrets" subtitle="Values the agent can use without seeing them." />
        <InlineNote tone="info">The secrets vault is edited here with the Jarod engine.</InlineNote>
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
      const message = errorText(error)

      notify(/refusé par l.utilisateur/.test(message) ? { title: 'Not changed', body: 'You cancelled the confirmation.', level: 'info' } : { title: 'Secrets', body: message.replace(/^.*?\[oneai\]\s*(coffre\s*:\s*)?/, ''), level: 'error' })

      return false
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <SectionTitle title="Secrets" subtitle="Values the agent can use without seeing them." />
      {vault.error && <InlineNote tone="danger">Could not read the vault: {vault.error}</InlineNote>}
      <SettingsGroup title="Vault">
        {vault.data?.length === 0 && <SettingsRow icon={<IconLock />} label="No secret yet" description="Add an API key or token the agent should use without ever reading it." keywords="secrets vault empty" />}
        {vault.data?.map(entry => (
          <SettingsRow key={entry.name} icon={<IconLock />} label={entry.name} description={[entry.description, reachText(entry)].filter(Boolean).join(' — ')} keywords={`secret vault ${entry.name} ${entry.domains.join(' ')}`}>
            {!entry.hasValue && <Pill tone="warn">No value</Pill>}
            <GlassButton size="sm" variant="ghost" disabled={busy} onClick={() => setEditing({ isNew: false, draft: draftOf(entry) })} aria-label={`Edit ${entry.name}`}>
              Edit
            </GlassButton>
            <GlassButton size="sm" variant="ghost" disabled={busy} onClick={() => void run('Secret removed', () => jarod('vault-remove', entry.name))} aria-label={`Remove ${entry.name}`}>
              Remove
            </GlassButton>
          </SettingsRow>
        ))}
        <SettingsRow icon={<IconLock />} label={editing ? (editing.isNew ? 'New secret' : `Edit ${editing.draft.name}`) : 'Add a secret'} description="The value is stored encrypted and never shown again." keywords="secret vault add new" below={editing && <Form key={editing.draft.name || 'new'} state={editing} names={names} busy={busy} onCancel={() => setEditing(null)} onSave={draft => run('Secret saved', () => { const p = savePayload(draft); return jarod('vault-save', p.entry, p.value) }).then(ok => ok && setEditing(null))} />}>
          <GlassButton size="sm" variant="primary" disabled={busy} onClick={() => setEditing({ isNew: true, draft: emptyVault() })}>
            Add…
          </GlassButton>
        </SettingsRow>
      </SettingsGroup>
    </>
  )
}

function Form({ state, names, busy, onCancel, onSave }: { state: { isNew: boolean; draft: VaultDraft }; names: string[]; busy: boolean; onCancel: () => void; onSave: (draft: VaultDraft) => Promise<unknown> }) {
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
          Name
          <input value={draft.name} disabled={!state.isNew} onChange={event => set('name', event.target.value)} spellCheck={false} placeholder="GithubToken" className={`${input} h-8 font-mono`} />
        </label>
        <label className="flex flex-col gap-1 text-[11.5px] text-fg-3">
          Value {state.isNew ? '' : '(leave empty to keep the saved one)'}
          <input type="password" autoComplete="off" spellCheck={false} value={draft.value} onChange={event => set('value', event.target.value)} className={`${input} h-8 font-mono`} />
        </label>
      </div>
      <label className="flex flex-col gap-1 text-[11.5px] text-fg-3">
        Description
        <input value={draft.description} onChange={event => set('description', event.target.value)} placeholder="What it is for" className={`${input} h-8`} />
      </label>
      <label className="flex flex-col gap-1 text-[11.5px] text-fg-3">
        Domains it may be sent to (spaces, commas or lines)
        <textarea value={draft.domains} onChange={event => set('domains', event.target.value)} rows={2} spellCheck={false} placeholder="api.github.com" className={`${input} py-1.5 font-mono`} />
      </label>
      <div className="flex items-center gap-3">
        <label className="flex flex-1 flex-col gap-1 text-[11.5px] text-fg-3">
          Environment variable (for shell commands)
          <input value={draft.envVar} onChange={event => set('envVar', event.target.value)} spellCheck={false} placeholder="GITHUB_TOKEN" className={`${input} h-8 font-mono`} />
        </label>
        <label className="flex items-center gap-2 text-[12px] text-fg-2">
          <Toggle checked={draft.allowShell} onChange={value => set('allowShell', value)} label="Available to shell commands" />
          Shell commands can read it
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
          Cancel
        </GlassButton>
        <GlassButton type="submit" size="sm" variant="primary" disabled={busy || problems.length > 0}>
          Save
        </GlassButton>
      </div>
    </form>
  )
}
