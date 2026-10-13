import { IconPlug } from '@tabler/icons-react'
import { useState } from 'react'
import { GlassButton, Pill, Toggle } from '../../../components/ui/glass.tsx'
import { jarod } from '../../../lib/jarod.ts'
import { useBackendData } from '../../../lib/use-async.ts'
import { notify } from '../../../store/notifications.ts'
import { describeServer, draftOf, draftProblems, emptyDraft, envNames, inputOf, type McpDraft, type McpServer } from './mcp-model.ts'
import { reportEngineError } from './jarod-controls.tsx'
import { isUnsupported } from './providers-model.ts'
import { errorText, InlineNote, markSaved, SectionTitle, SettingsGroup, SettingsRow } from './shared.tsx'
import { t, useT } from '../../../lib/i18n.ts'

/*
 * MCP servers: tools the agent can use that live in other programs (a command it starts, or a web address it calls). The Connections page lists and tests
 * them; here you add, edit and remove them. Environment values are secrets: they are shown masked and a masked value is kept as it is on save.
 */

type Result = { success: boolean; error?: string; tools?: { name: string; description: string }[] }

export function McpSection() {
  useT()
  const servers = useBackendData(() => jarod<McpServer[]>('list-mcp-servers'))
  const [editing, setEditing] = useState<{ original?: string; draft: McpDraft } | null>(null)
  const [busy, setBusy] = useState(false)
  const [tests, setTests] = useState<Record<string, string>>({})

  if (isUnsupported(servers.error)) {
    return (
      <>
        <SectionTitle title={t('settings.mcp.title')} subtitle={t('settings.mcp.subtitle.short')} />
        <InlineNote tone="info">{t('settings.mcp.needsJarod')}</InlineNote>
      </>
    )
  }

  const names = (servers.data ?? []).map(server => server.name)

  const run = async (title: string, action: () => Promise<Result>): Promise<boolean> => {
    setBusy(true)

    try {
      const result = await action()

      if (!result.success) {
        throw new Error(result.error ?? t('settings.persona.failed'))
      }

      markSaved()
      notify({ title, level: 'success' })
      servers.reload()

      return true
    } catch (error) {
      reportEngineError(t('settings.mcp.title'), error)

      return false
    } finally {
      setBusy(false)
    }
  }

  const test = async (server: McpServer) => {
    setTests(current => ({ ...current, [server.name]: t('settings.devices.ssh.testing') }))

    try {
      const result = await jarod<Result>('test-mcp-server', server.name)

      setTests(current => ({ ...current, [server.name]: result.success ? `${t(result.tools?.length === 1 ? 'settings.mcp.works.one' : 'settings.mcp.works', { count: result.tools?.length ?? 0 })}${result.tools?.length ? ` (${result.tools.slice(0, 5).map(tool => tool.name).join(', ')}${result.tools.length > 5 ? '…' : ''})` : ''}` : t('settings.devices.ssh.failed', { reason: result.error ?? t('settings.mcp.unknownError') }) }))
    } catch (error) {
      setTests(current => ({ ...current, [server.name]: t('settings.devices.ssh.failed', { reason: errorText(error) }) }))
    }
  }

  return (
    <>
      <SectionTitle title={t('settings.mcp.title')} subtitle={t('settings.mcp.subtitle')} />
      {servers.error && <InlineNote tone="danger">{t('settings.mcp.readFailed', { error: servers.error })}</InlineNote>}
      <SettingsGroup title={t('settings.mcp.servers')}>
        {servers.data?.length === 0 && <SettingsRow icon={<IconPlug />} label={t('settings.mcp.none')} description={t('settings.mcp.none.hint')} keywords="mcp servers empty" />}
        {servers.data?.map(server => (
          <SettingsRow
            key={server.name}
            icon={<IconPlug />}
            label={server.name}
            description={
              <>
                <span className="font-mono text-[11.5px]">{describeServer(server)}</span>
                {envNames(server).length > 0 && <span> · env: {envNames(server).join(', ')}</span>}
                {tests[server.name] && <span className="block text-fg-2">{tests[server.name]}</span>}
              </>
            }
            keywords={`mcp server ${server.name} ${server.type}`}
          >
            <Pill tone="muted">{server.type}</Pill>
            <GlassButton size="sm" variant="ghost" disabled={busy} onClick={() => void test(server)} aria-label={t('settings.devices.ssh.test.aria', { name: server.name })}>
              {t('settings.devices.ssh.test')}
            </GlassButton>
            <GlassButton size="sm" variant="ghost" disabled={busy} onClick={() => setEditing({ original: server.name, draft: draftOf(server) })} aria-label={t('settings.persona.edit.aria', { name: server.name })}>
              {t('settings.persona.edit')}
            </GlassButton>
            <GlassButton size="sm" variant="ghost" disabled={busy} onClick={() => void run(t('settings.mcp.removed'), () => jarod<Result>('remove-mcp-server', server.name))} aria-label={t('settings.agent.remove', { name: server.name })}>
              {t('settings.devices.ssh.remove')}
            </GlassButton>
            <Toggle checked={server.enabled} label={t('settings.rules.toggle', { name: server.name })} disabled={busy} onChange={value => void run(value ? t('settings.mcp.on') : t('settings.mcp.off'), () => jarod<Result>('set-mcp-server-enabled', server.name, value))} />
          </SettingsRow>
        ))}
        <SettingsRow icon={<IconPlug />} label={t('settings.mcp.add')} description={t('settings.mcp.add.hint')} keywords="mcp add server new" below={editing && <Editor key={editing.original ?? 'new'} existing={names} state={editing} busy={busy} onCancel={() => setEditing(null)} onSave={(draft, original) => run(original ? t('settings.mcp.updated') : t('settings.mcp.added'), () => (original ? jarod<Result>('update-mcp-server', original, inputOf(draft)) : jarod<Result>('add-mcp-server', inputOf(draft)))).then(ok => ok && setEditing(null))} />}>
          <GlassButton size="sm" variant="primary" disabled={busy} onClick={() => setEditing({ draft: emptyDraft() })}>
            {t('settings.devices.addMore')}
          </GlassButton>
        </SettingsRow>
      </SettingsGroup>
    </>
  )
}

function Editor({ state, existing, busy, onCancel, onSave }: { state: { original?: string; draft: McpDraft }; existing: string[]; busy: boolean; onCancel: () => void; onSave: (draft: McpDraft, original?: string) => Promise<unknown> }) {
  useT()
  const [draft, setDraft] = useState(state.draft)
  const problems = draftProblems(draft, existing, state.original)
  const set = <K extends keyof McpDraft>(key: K, value: McpDraft[K]) => setDraft(current => ({ ...current, [key]: value }))
  const input = 'glass-input rounded-lg px-2.5 text-[12.5px] text-fg outline-none placeholder:text-fg-4'

  return (
    <form
      className="flex flex-col gap-2.5"
      onSubmit={event => {
        event.preventDefault()

        if (problems.length === 0) {
          void onSave(draft, state.original)
        }
      }}
    >
      <div className="grid grid-cols-[1fr_auto] gap-2">
        <label className="flex flex-col gap-1 text-[11.5px] text-fg-3">
          {t('settings.devices.ssh.name')}
          <input value={draft.name} onChange={event => set('name', event.target.value)} spellCheck={false} className={`${input} h-8`} placeholder="filesystem" />
        </label>
        <label className="flex flex-col gap-1 text-[11.5px] text-fg-3">
          {t('settings.mcp.type')}
          <select value={draft.type} onChange={event => set('type', event.target.value as McpDraft['type'])} style={{ colorScheme: 'dark' }} className={`${input} h-8`}>
            <option value="stdio">{t('settings.mcp.type.stdio')}</option>
            <option value="http">{t('settings.mcp.type.http')}</option>
          </select>
        </label>
      </div>
      {draft.type === 'http' ? (
        <label className="flex flex-col gap-1 text-[11.5px] text-fg-3">
          URL
          <input value={draft.url} onChange={event => set('url', event.target.value)} spellCheck={false} className={`${input} h-8 font-mono`} placeholder="https://example.org/mcp" />
        </label>
      ) : (
        <>
          <label className="flex flex-col gap-1 text-[11.5px] text-fg-3">
            {t('settings.mcp.command')}
            <input value={draft.command} onChange={event => set('command', event.target.value)} spellCheck={false} className={`${input} h-8 font-mono`} placeholder="npx" />
          </label>
          <label className="flex flex-col gap-1 text-[11.5px] text-fg-3">
            {t('settings.mcp.args')}
            <textarea value={draft.args} onChange={event => set('args', event.target.value)} rows={3} spellCheck={false} className={`${input} py-1.5 font-mono`} placeholder={'-y\n@modelcontextprotocol/server-filesystem'} />
          </label>
          <label className="flex flex-col gap-1 text-[11.5px] text-fg-3">
            {t('settings.mcp.env')}
            <textarea value={draft.env} onChange={event => set('env', event.target.value)} rows={3} spellCheck={false} className={`${input} py-1.5 font-mono`} placeholder="API_KEY=…" />
          </label>
        </>
      )}
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
          {state.original ? t('settings.devices.save') : t('settings.devices.add')}
        </GlassButton>
      </div>
    </form>
  )
}
