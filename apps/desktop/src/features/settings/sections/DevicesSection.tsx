import { IconBrandAndroid, IconDeviceMobile, IconKey, IconServer2, IconTerminal2 } from '@tabler/icons-react'
import { useEffect, useState } from 'react'
import { GlassButton, Pill, Toggle } from '../../../components/ui/glass.tsx'
import { jarod } from '../../../lib/jarod.ts'
import { useBackendData } from '../../../lib/use-async.ts'
import { notify } from '../../../store/notifications.ts'
import { reportEngineError, useJarodSettings } from './jarod-controls.tsx'
import { androidSummary, apiAddress, type ApiServerStatus, apiSummary, baseName, emptySsh, type PairingInfo, type PhoneStatus, phoneSummary, secondsLeft, type SshDraft, type SshHost, sshLine, sshProblems, type SshTest, timeLeftText } from './devices-model.ts'
import { intProblem } from './jarod-settings-model.ts'
import { isUnsupported } from './providers-model.ts'
import { errorText, InlineNote, markSaved, SectionTitle, SettingsGroup, SettingsRow } from './shared.tsx'

/*
 * Devices & API: ways other things reach the agent, and machines the agent reaches.
 *   OpenAI-compatible API: lets an editor or a script talk to the agent, read-only, with a key
 *   Phone bridge: pairs a phone on your network; Android (adb): lets the agent drive a connected Android device
 *   SSH hosts: machines the agent may run commands on
 * Anything that opens a port or widens what the agent can reach is confirmed by the engine in a native dialog.
 */

export function DevicesSection() {
  return (
    <>
      <SectionTitle title="Devices & API" subtitle="Ways other things reach the agent, and machines the agent reaches." />
      <ApiBlock />
      <PhoneBlock />
      <SshBlock />
    </>
  )
}

function ApiBlock() {
  const status = useBackendData(() => jarod<ApiServerStatus>('api-server-status'))
  const settings = useJarodSettings()
  const [busy, setBusy] = useState(false)
  const [key, setKey] = useState<string | null>(null)

  if (isUnsupported(status.error)) {
    return <InlineNote tone="info">The API and device features need the Jarod engine.</InlineNote>
  }

  const s = status.data
  const api = settings.settings?.apiServer

  const run = async (title: string, action: () => Promise<unknown>) => {
    setBusy(true)

    try {
      await action()
      markSaved()
      notify({ title, level: 'success' })
    } catch (error) {
      reportEngineError('API', error)
    } finally {
      setBusy(false)
      status.reload()
      settings.reload()
    }
  }

  return (
    <SettingsGroup title="OpenAI-compatible API">
      {s && (
        <>
          <SettingsRow icon={<IconServer2 />} label="Local API" description={apiSummary(s)} keywords="api server openai compatible chat completions open webui">
            <Toggle checked={s.enabled && s.running} label="API on or off" disabled={busy} onChange={value => void run(value ? 'API on' : 'API off', () => jarod('api-server-set', value))} />
          </SettingsRow>
          <SettingsRow
            icon={<IconKey />}
            label={s.keyConfigured ? 'API key saved' : 'No API key yet'}
            description="Every request must carry the key. Making a new key replaces the old one, which stops working. The key is shown once."
            keywords="api key new generate"
            below={key && <InlineNote tone="info">New key — copy it now, it will not be shown again: <span className="font-mono select-all">{key}</span></InlineNote>}
          >
            <GlassButton size="sm" variant={s.keyConfigured ? 'secondary' : 'primary'} disabled={busy} onClick={() => void run('New key made', async () => setKey((await jarod<{ key: string }>('api-server-new-key')).key))}>
              {s.keyConfigured ? 'Make a new key' : 'Make a key'}
            </GlassButton>
          </SettingsRow>
          {api && (
            <SettingsRow icon={<IconServer2 />} label="Who can reach it" description={`${apiAddress({ host: api.host, port: api.port })}. “Local network” lets any device on your network try (the key is still required).`} keywords="api host network localhost port">
              <select value={api.host} disabled={busy || s.running} onChange={event => void run('Setting saved', () => jarod('set-jarod-settings', { apiServer: { host: event.target.value } }))} aria-label="API host" style={{ colorScheme: 'dark' }} className="glass-input h-8 rounded-lg px-2 text-[12.5px] text-fg outline-none">
                <option value="127.0.0.1">This PC only</option>
                <option value="0.0.0.0">Local network</option>
              </select>
              <PortButton value={api.port} disabled={busy || s.running} onSave={port => run('Port saved', () => jarod('set-jarod-settings', { apiServer: { port } }))} label="API port" />
            </SettingsRow>
          )}
        </>
      )}
    </SettingsGroup>
  )
}

function PortButton({ value, onSave, disabled, label }: { value: number; onSave: (port: number) => Promise<void>; disabled?: boolean; label: string }) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState('')
  const problem = editing ? intProblem(text, 1024, 65535) : null

  if (!editing) {
    return (
      <GlassButton size="sm" variant="secondary" disabled={disabled} onClick={() => (setText(String(value)), setEditing(true))} aria-label={`Change ${label}`}>
        Port {value}
      </GlassButton>
    )
  }

  return (
    <form
      className="flex items-center gap-1.5"
      onSubmit={event => {
        event.preventDefault()

        if (!problem) {
          void onSave(Number(text)).then(() => setEditing(false))
        }
      }}
    >
      <input autoFocus value={text} onChange={event => setText(event.target.value)} aria-label={label} inputMode="numeric" className="glass-input h-8 w-[84px] rounded-lg px-2 font-mono text-[12.5px] text-fg outline-none" />
      <GlassButton type="submit" size="sm" variant="primary" disabled={Boolean(problem)}>
        Save
      </GlassButton>
      <GlassButton type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>
        ✕
      </GlassButton>
      {problem && <span className="text-[11.5px] text-warn">{problem}</span>}
    </form>
  )
}

function PhoneBlock() {
  const status = useBackendData(() => jarod<PhoneStatus>('phone-status'))
  const [busy, setBusy] = useState(false)
  const [pairing, setPairing] = useState<PairingInfo | null>(null)
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    if (!pairing) {
      return
    }

    const timer = setInterval(() => setNow(Date.now()), 1000)

    return () => clearInterval(timer)
  }, [pairing])

  if (!status.data) {
    return null
  }

  const { mobile, android } = status.data

  const run = async (title: string, action: () => Promise<unknown>) => {
    setBusy(true)

    try {
      await action()
      markSaved()
      notify({ title, level: 'success' })
    } catch (error) {
      reportEngineError('Phone', error)
    } finally {
      setBusy(false)
      status.reload()
    }
  }

  const left = pairing ? secondsLeft(pairing.expiresAt, now) : 0

  return (
    <SettingsGroup title="Phone">
      <SettingsRow icon={<IconDeviceMobile />} label="Phone bridge" description={phoneSummary(mobile)} keywords="phone mobile bridge pair">
        <Toggle checked={mobile.running} label="Phone bridge on or off" disabled={busy} onChange={value => void run(value ? 'Phone bridge on' : 'Phone bridge off', () => jarod('phone-bridge-set', value))} />
      </SettingsRow>
      {mobile.running && (
        <SettingsRow
          icon={<IconKey />}
          label="Pair a phone"
          description="Open the address on the phone and type the code. The code works once and expires."
          keywords="phone pair code"
          below={pairing && (
            <InlineNote tone={left > 0 ? 'info' : 'warn'}>
              Address <span className="font-mono select-all">{pairing.url}</span> · code <span className="font-mono select-all">{pairing.secret}</span> · {timeLeftText(left)}
            </InlineNote>
          )}
        >
          <GlassButton size="sm" variant="primary" disabled={busy} onClick={() => void run('Pairing code ready', async () => setPairing(await jarod<PairingInfo>('phone-pairing')))}>
            Show a code
          </GlassButton>
        </SettingsRow>
      )}
      {mobile.devices.map(device => (
        <SettingsRow key={device.deviceId} icon={<IconDeviceMobile />} label={device.name || 'Phone'} description={`Paired ${new Date(device.pairedAt).toLocaleDateString()} · last seen ${device.lastSeen ? new Date(device.lastSeen).toLocaleString() : 'never'}`} keywords={`phone paired ${device.name}`}>
          <GlassButton size="sm" variant="ghost" disabled={busy} onClick={() => void run('Phone removed', () => jarod('phone-revoke', device.deviceId))} aria-label={`Revoke ${device.name || 'phone'}`}>
            Revoke
          </GlassButton>
        </SettingsRow>
      ))}
      <SettingsRow icon={<IconBrandAndroid />} label="Android (adb)" description={androidSummary(android)} keywords="android adb device platform tools">
        <GlassButton size="sm" variant="secondary" disabled={busy} onClick={() => void run('adb chosen', async () => {
          const file = await jarod<string | null>('android-pick-adb')

          if (file) {
            await jarod('android-set-adb', file)
          }
        })}>
          Choose adb…
        </GlassButton>
        {android.configured && (
          <GlassButton size="sm" variant="ghost" disabled={busy} onClick={() => void run('adb reset', () => jarod('android-set-adb', ''))}>
            Use the one on PATH
          </GlassButton>
        )}
      </SettingsRow>
      {android.devices.map(device => (
        <SettingsRow key={device.serial} icon={<IconBrandAndroid />} label={device.model || device.serial} description={`${device.serial} · ${device.product}`} keywords={`android ${device.serial}`}>
          <Pill tone={device.state === 'device' ? 'ok' : 'warn'} dot>
            {device.state}
          </Pill>
        </SettingsRow>
      ))}
    </SettingsGroup>
  )
}

function SshBlock() {
  const hosts = useBackendData(() => jarod<SshHost[]>('ssh-hosts-list'))
  const [draft, setDraft] = useState<SshDraft | null>(null)
  const [busy, setBusy] = useState(false)
  const [tests, setTests] = useState<Record<string, string>>({})
  const names = (hosts.data ?? []).map(h => h.name)
  const problems = draft ? sshProblems(draft, names) : []

  const run = async (title: string, action: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true)

    try {
      await action()
      markSaved()
      notify({ title, level: 'success' })
      hosts.reload()

      return true
    } catch (error) {
      notify({ title: 'SSH hosts', body: errorText(error).replace(/^.*?\[oneai\]\s*/, ''), level: 'error' })

      return false
    } finally {
      setBusy(false)
    }
  }

  const test = async (host: SshHost) => {
    setTests(current => ({ ...current, [host.id]: 'Testing…' }))

    try {
      const r = await jarod<SshTest>('ssh-host-test', host.id)

      setTests(current => ({ ...current, [host.id]: r.ok ? `Connected in ${r.durationMs} ms.` : `Failed: ${r.message || 'no answer'}` }))
    } catch (error) {
      setTests(current => ({ ...current, [host.id]: `Failed: ${errorText(error)}` }))
    }
  }

  const set = <K extends keyof SshDraft>(key: K, value: SshDraft[K]) => setDraft(current => (current ? { ...current, [key]: value } : current))
  const input = 'glass-input h-8 rounded-lg px-2.5 text-[12.5px] text-fg outline-none placeholder:text-fg-4'

  return (
    <SettingsGroup title="SSH hosts">
      {hosts.data?.length === 0 && <SettingsRow icon={<IconTerminal2 />} label="No host declared" description="The agent can run commands on a machine you declare here. Only a key file is used, never a password." keywords="ssh hosts empty" />}
      {hosts.data?.map(host => (
        <SettingsRow key={host.id} icon={<IconTerminal2 />} label={host.name} description={`${sshLine(host)} · key ${baseName(host.keyPath)}${tests[host.id] ? ` · ${tests[host.id]}` : ''}`} keywords={`ssh host ${host.name} ${host.host}`}>
          <GlassButton size="sm" variant="ghost" disabled={busy} onClick={() => void test(host)} aria-label={`Test ${host.name}`}>
            Test
          </GlassButton>
          <GlassButton size="sm" variant="ghost" disabled={busy} onClick={() => void run('Host removed', () => jarod('ssh-host-remove', host.id))} aria-label={`Remove ${host.name}`}>
            Remove
          </GlassButton>
        </SettingsRow>
      ))}
      <SettingsRow
        icon={<IconTerminal2 />}
        label="Add a host"
        description="Name, address, user and the private key file (chosen in the file dialog)."
        keywords="ssh host add key"
        below={
          draft && (
            <form
              className="flex flex-col gap-2.5"
              onSubmit={event => {
                event.preventDefault()

                if (problems.length === 0) {
                  void run('Host added', () => jarod('ssh-host-add', { name: draft.name.trim(), host: draft.host.trim(), username: draft.username.trim(), port: Number(draft.port), keyPath: draft.keyPath })).then(ok => ok && setDraft(null))
                }
              }}
            >
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <input value={draft.name} onChange={event => set('name', event.target.value)} placeholder="Name" aria-label="Host name" className={input} />
                <input value={draft.host} onChange={event => set('host', event.target.value)} placeholder="Address" aria-label="Host address" spellCheck={false} className={input} />
                <input value={draft.username} onChange={event => set('username', event.target.value)} placeholder="User" aria-label="User" spellCheck={false} className={input} />
                <input value={draft.port} onChange={event => set('port', event.target.value)} placeholder="Port" aria-label="Port" inputMode="numeric" className={input} />
              </div>
              <div className="flex items-center gap-2 text-[12px] text-fg-3">
                <span className="min-w-0 flex-1 truncate">{draft.keyPath ? `Key: ${baseName(draft.keyPath)}` : 'No key chosen'}</span>
                <GlassButton type="button" size="sm" variant="secondary" onClick={() => void jarod<string | null>('ssh-pick-key').then(file => file && set('keyPath', file), error => notify({ title: 'SSH key', body: errorText(error), level: 'error' }))}>
                  Choose key…
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
                  Cancel
                </GlassButton>
                <GlassButton type="submit" size="sm" variant="primary" disabled={busy || problems.length > 0}>
                  Add
                </GlassButton>
              </div>
            </form>
          )
        }
      >
        <GlassButton size="sm" variant="primary" disabled={busy} onClick={() => setDraft(emptySsh())}>
          Add…
        </GlassButton>
      </SettingsRow>
    </SettingsGroup>
  )
}
