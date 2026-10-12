import { IconPlug } from '@tabler/icons-react'
import { useState } from 'react'
import { GlassButton, Pill, Toggle } from '../../../components/ui/glass.tsx'
import { jarod } from '../../../lib/jarod.ts'
import { useBackendData } from '../../../lib/use-async.ts'
import { notify } from '../../../store/notifications.ts'
import { describeServer, draftOf, draftProblems, emptyDraft, envNames, inputOf, type McpDraft, type McpServer } from './mcp-model.ts'
import { isUnsupported } from './providers-model.ts'
import { errorText, InlineNote, markSaved, SectionTitle, SettingsGroup, SettingsRow } from './shared.tsx'

/*
 * MCP servers: tools the agent can use that live in other programs (a command it starts, or a web address it calls). The Connections page lists and tests
 * them; here you add, edit and remove them. Environment values are secrets: they are shown masked and a masked value is kept as it is on save.
 */

type Result = { success: boolean; error?: string; tools?: { name: string; description: string }[] }

export function McpSection() {
  const servers = useBackendData(() => jarod<McpServer[]>('list-mcp-servers'))
  const [editing, setEditing] = useState<{ original?: string; draft: McpDraft } | null>(null)
  const [busy, setBusy] = useState(false)
  const [tests, setTests] = useState<Record<string, string>>({})

  if (isUnsupported(servers.error)) {
    return (
      <>
        <SectionTitle title="MCP servers" subtitle="Tools that live in other programs." />
        <InlineNote tone="info">MCP servers are edited here with the Jarod engine.</InlineNote>
      </>
    )
  }

  const names = (servers.data ?? []).map(server => server.name)

  const run = async (title: string, action: () => Promise<Result>): Promise<boolean> => {
    setBusy(true)

    try {
      const result = await action()

      if (!result.success) {
        throw new Error(result.error ?? 'Failed')
      }

      markSaved()
      notify({ title, level: 'success' })
      servers.reload()

      return true
    } catch (error) {
      notify({ title: 'MCP servers', body: errorText(error), level: 'error' })

      return false
    } finally {
      setBusy(false)
    }
  }

  const test = async (server: McpServer) => {
    setTests(current => ({ ...current, [server.name]: 'Testing…' }))

    try {
      const result = await jarod<Result>('test-mcp-server', server.name)

      setTests(current => ({ ...current, [server.name]: result.success ? `Works: ${result.tools?.length ?? 0} tool${result.tools?.length === 1 ? '' : 's'}${result.tools?.length ? ` (${result.tools.slice(0, 5).map(t => t.name).join(', ')}${result.tools.length > 5 ? '…' : ''})` : ''}` : `Failed: ${result.error ?? 'unknown error'}`}))
    } catch (error) {
      setTests(current => ({ ...current, [server.name]: `Failed: ${errorText(error)}` }))
    }
  }

  return (
    <>
      <SectionTitle title="MCP servers" subtitle="Tools that live in other programs: a command the agent starts, or a web address it calls." />
      {servers.error && <InlineNote tone="danger">Could not read the servers: {servers.error}</InlineNote>}
      <SettingsGroup title="Servers">
        {servers.data?.length === 0 && <SettingsRow icon={<IconPlug />} label="No MCP server yet" description="Add one to give the agent more tools." keywords="mcp servers empty" />}
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
            <GlassButton size="sm" variant="ghost" disabled={busy} onClick={() => void test(server)} aria-label={`Test ${server.name}`}>
              Test
            </GlassButton>
            <GlassButton size="sm" variant="ghost" disabled={busy} onClick={() => setEditing({ original: server.name, draft: draftOf(server) })} aria-label={`Edit ${server.name}`}>
              Edit
            </GlassButton>
            <GlassButton size="sm" variant="ghost" disabled={busy} onClick={() => void run('Server removed', () => jarod<Result>('remove-mcp-server', server.name))} aria-label={`Remove ${server.name}`}>
              Remove
            </GlassButton>
            <Toggle checked={server.enabled} label={`${server.name} on or off`} disabled={busy} onChange={value => void run(value ? 'Server on' : 'Server off', () => jarod<Result>('set-mcp-server-enabled', server.name, value))} />
          </SettingsRow>
        ))}
        <SettingsRow icon={<IconPlug />} label="Add a server" description="A program the agent starts (like npx or uvx), or a web address." keywords="mcp add server new" below={editing && <Editor key={editing.original ?? 'new'} existing={names} state={editing} busy={busy} onCancel={() => setEditing(null)} onSave={(draft, original) => run(original ? 'Server updated' : 'Server added', () => (original ? jarod<Result>('update-mcp-server', original, inputOf(draft)) : jarod<Result>('add-mcp-server', inputOf(draft)))).then(ok => ok && setEditing(null))} />}>
          <GlassButton size="sm" variant="primary" disabled={busy} onClick={() => setEditing({ draft: emptyDraft() })}>
            Add…
          </GlassButton>
        </SettingsRow>
      </SettingsGroup>
    </>
  )
}

function Editor({ state, existing, busy, onCancel, onSave }: { state: { original?: string; draft: McpDraft }; existing: string[]; busy: boolean; onCancel: () => void; onSave: (draft: McpDraft, original?: string) => Promise<unknown> }) {
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
          Name
          <input value={draft.name} onChange={event => set('name', event.target.value)} spellCheck={false} className={`${input} h-8`} placeholder="filesystem" />
        </label>
        <label className="flex flex-col gap-1 text-[11.5px] text-fg-3">
          Type
          <select value={draft.type} onChange={event => set('type', event.target.value as McpDraft['type'])} style={{ colorScheme: 'dark' }} className={`${input} h-8`}>
            <option value="stdio">Program (stdio)</option>
            <option value="http">Web address (http)</option>
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
            Command
            <input value={draft.command} onChange={event => set('command', event.target.value)} spellCheck={false} className={`${input} h-8 font-mono`} placeholder="npx" />
          </label>
          <label className="flex flex-col gap-1 text-[11.5px] text-fg-3">
            Arguments (one per line)
            <textarea value={draft.args} onChange={event => set('args', event.target.value)} rows={3} spellCheck={false} className={`${input} py-1.5 font-mono`} placeholder={'-y\n@modelcontextprotocol/server-filesystem'} />
          </label>
          <label className="flex flex-col gap-1 text-[11.5px] text-fg-3">
            Environment (NAME=value, one per line; values are secrets)
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
          Cancel
        </GlassButton>
        <GlassButton type="submit" size="sm" variant="primary" disabled={busy || problems.length > 0}>
          {state.original ? 'Save' : 'Add'}
        </GlassButton>
      </div>
    </form>
  )
}
