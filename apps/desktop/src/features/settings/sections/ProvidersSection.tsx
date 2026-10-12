import { IconCloud, IconExternalLink, IconKey, IconPlugConnected, IconRefresh, IconServer } from '@tabler/icons-react'
import { useState } from 'react'
import { GlassButton, Pill, type PillTone } from '../../../components/ui/glass.tsx'
import { cn } from '../../../lib/cn.ts'
import { rest } from '../../../lib/rest.ts'
import { useBackendData } from '../../../lib/use-async.ts'
import { notify } from '../../../store/notifications.ts'
import { addressProblem, groupProviders, isUnsupported, keyProblem, type ProviderRow, type ProvidersPayload, providerState, providerSummary, type ProviderTestResult } from './providers-model.ts'
import { errorText, InlineNote, markSaved, SectionTitle, SettingsGroup, SettingsRow } from './shared.tsx'
import { attempt } from '../../../lib/native.ts'

/*
 * Providers & keys: where the Jarod engine gets its models. Every control binds to `/api/jarod/providers`:
 *   PUT/DELETE .../{id}/key   -> save / remove the API key (encrypted on this PC; it never comes back)
 *   PUT        .../{id}       -> address and model list of a provider
 *   POST       .../{id}/test  -> ask the provider for its models with the saved key
 */

const PATH = '/api/jarod/providers'

const STATE_PILL: Record<ReturnType<typeof providerState>, { tone: PillTone; label: string }> = {
  ready: { tone: 'ok', label: 'Ready' },
  local: { tone: 'info', label: 'Local' },
  'needs-key': { tone: 'warn', label: 'Needs a key' }
}

export function ProvidersSection() {
  const providers = useBackendData(() => rest.get<ProvidersPayload>(PATH))
  const grouped = providers.data ? groupProviders(providers.data.providers) : null
  const unsupported = isUnsupported(providers.error)

  return (
    <>
      <SectionTitle title="Providers & keys" subtitle="Where Jarod gets its models. Keys are encrypted on this PC and are never shown again." />

      {unsupported && <InlineNote tone="info">This engine manages its providers itself. Providers and keys can only be edited here with the Jarod engine.</InlineNote>}
      {providers.error && !unsupported && <InlineNote tone="danger">Could not read the providers: {providers.error}</InlineNote>}
      {providers.loading && !providers.data && <div className="px-1 text-[12px] text-fg-4">Loading providers…</div>}

      {grouped && (
        <>
          <SettingsGroup title="Cloud providers">
            {grouped.cloud.map(row => (
              <ProviderItem key={row.id} row={row} onChanged={providers.reload} />
            ))}
          </SettingsGroup>
          <SettingsGroup title="Servers on this PC">
            {grouped.local.map(row => (
              <ProviderItem key={row.id} row={row} onChanged={providers.reload} />
            ))}
          </SettingsGroup>
        </>
      )}
    </>
  )
}

type Editing = 'key' | 'address' | null

function ProviderItem({ row, onChanged }: { row: ProviderRow; onChanged: () => void }) {
  const [editing, setEditing] = useState<Editing>(null)
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [test, setTest] = useState<ProviderTestResult | null>(null)
  const state = providerState(row)
  const pill = STATE_PILL[state]
  const problem = editing === 'key' ? (value ? keyProblem(value) : null) : editing === 'address' ? addressProblem(value) : null

  const close = () => {
    // The pasted key leaves memory as soon as the editor closes.
    setEditing(null)
    setValue('')
  }

  const run = async (title: string, action: () => Promise<unknown>, done?: () => void) => {
    setBusy(true)

    try {
      await action()
      markSaved()
      notify({ title, body: row.name, level: 'success' })
      done?.()
      onChanged()
    } catch (error) {
      notify({ title: `Could not update ${row.name}`, body: errorText(error), level: 'error' })
    } finally {
      setBusy(false)
    }
  }

  const saveKey = () => {
    const key = value

    return run('Key saved', () => rest.put(`${PATH}/${encodeURIComponent(row.id)}/key`, { key }), () => {
      setTest(null)
      close()
    })
  }

  const saveAddress = () =>
    run('Address saved', () => rest.put(`${PATH}/${encodeURIComponent(row.id)}`, { baseUrl: value.trim() }), () => {
      setTest(null)
      close()
    })

  const removeKey = () => run('Key removed', () => rest.del(`${PATH}/${encodeURIComponent(row.id)}/key`), () => setTest(null))

  const runTest = async () => {
    setBusy(true)
    setTest(null)

    try {
      setTest(await rest.post<ProviderTestResult>(`${PATH}/${encodeURIComponent(row.id)}/test`))
    } catch (error) {
      setTest({ ok: false, models: 0, error: errorText(error) })
    } finally {
      setBusy(false)
    }
  }

  const editor = editing && (
    <form
      className="flex flex-col gap-2"
      onSubmit={event => {
        event.preventDefault()

        if (!problem && (editing === 'address' || value.trim())) {
          void (editing === 'key' ? saveKey() : saveAddress())
        }
      }}
    >
      <label className="glass-input flex h-9 items-center gap-2 rounded-lg px-3">
        <span className="sr-only">{editing === 'key' ? `API key for ${row.name}` : `Address of ${row.name}`}</span>
        <input
          autoFocus
          // A key field is a password field: no autofill, no spellcheck, nothing remembered by the page.
          type={editing === 'key' ? 'password' : 'text'}
          autoComplete="off"
          spellCheck={false}
          value={value}
          onChange={event => setValue(event.target.value)}
          placeholder={editing === 'key' ? 'Paste the API key' : row.base_url}
          className="min-w-0 flex-1 bg-transparent font-mono text-[12.5px] outline-none placeholder:text-fg-4"
        />
      </label>
      {problem && <InlineNote tone="warn">{problem}</InlineNote>}
      {editing === 'address' && <div className="text-[11.5px] text-fg-4">Leave it empty to go back to the default address.</div>}
      <div className="flex justify-end gap-2">
        <GlassButton type="button" size="sm" variant="ghost" onClick={close} disabled={busy}>
          Cancel
        </GlassButton>
        <GlassButton type="submit" size="sm" variant="primary" disabled={busy || Boolean(problem) || (editing === 'key' && !value.trim())}>
          Save
        </GlassButton>
      </div>
    </form>
  )

  const result = test && (
    <InlineNote tone={test.ok ? 'info' : 'danger'} className={cn(editing && 'mt-2')}>
      {test.ok ? `Connected. ${test.models} model${test.models === 1 ? '' : 's'} available.` : `Test failed: ${test.error ?? 'no answer'}`}
    </InlineNote>
  )

  return (
    <SettingsRow
      icon={row.local ? <IconServer /> : <IconCloud />}
      label={row.name}
      description={providerSummary(row)}
      keywords={`${row.id} provider api key model ${row.local ? 'local server' : 'cloud'}`}
      below={
        editor || result ? (
          <>
            {editor}
            {result}
          </>
        ) : undefined
      }
    >
      <Pill tone={pill.tone} dot>
        {pill.label}
      </Pill>
      {row.key_url && state === 'needs-key' && (
        <GlassButton size="sm" variant="ghost" onClick={() => void attempt('open the link', () => window.heraldOS.shell.openExternal(row.key_url!))} aria-label={`Get an API key for ${row.name}`} title="Open the page where the key is created">
          <IconExternalLink />
        </GlassButton>
      )}
      {(state === 'ready' || row.local) && (
        <GlassButton size="sm" variant="ghost" disabled={busy} onClick={() => void runTest()} aria-label={`Test ${row.name}`} title="Ask the provider for its models">
          {busy && !editing ? <IconRefresh className="animate-spin" /> : <IconPlugConnected />}
        </GlassButton>
      )}
      {row.local && (
        <GlassButton size="sm" variant="secondary" disabled={busy} onClick={() => (setEditing('address'), setValue(''))}>
          Address
        </GlassButton>
      )}
      {row.key_source === 'vault' && (
        <GlassButton size="sm" variant="ghost" disabled={busy} onClick={() => void removeKey()} aria-label={`Remove the key of ${row.name}`}>
          Remove
        </GlassButton>
      )}
      <GlassButton size="sm" variant={state === 'needs-key' ? 'primary' : 'secondary'} disabled={busy} onClick={() => (setEditing('key'), setValue(''))} aria-label={`${row.key_source === 'vault' ? 'Replace' : 'Add'} the key of ${row.name}`} title={row.key_source === 'env' ? `Save a key here; it is used instead of ${row.env_var ?? 'the environment variable'}` : undefined}>
        <IconKey />
        {row.key_source === 'vault' ? 'Replace key' : 'Add key'}
      </GlassButton>
    </SettingsRow>
  )
}
