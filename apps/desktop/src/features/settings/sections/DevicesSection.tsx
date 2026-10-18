import { IconBrandAndroid, IconDeviceMobile, IconKey, IconServer2, IconTerminal2 } from '@tabler/icons-react'
import { useEffect, useState } from 'react'
import { QrCode } from '../../../components/qr-code.tsx'
import { GlassButton, Pill, Toggle } from '../../../components/ui/glass.tsx'
import { jarod } from '../../../lib/jarod.ts'
import { useBackendData } from '../../../lib/use-async.ts'
import { notify } from '../../../store/notifications.ts'
import { reportEngineError, useJarodSettings } from './jarod-controls.tsx'
import { androidSummary, apiAddress, type ApiServerStatus, apiSummary, baseName, emptySsh, type PairingInfo, type PhoneStatus, phoneSummary, secondsLeft, type SshDraft, type SshHost, sshLine, sshProblems, type SshTest, timeLeftText } from './devices-model.ts'
import { intProblem } from './jarod-settings-model.ts'
import { isUnsupported } from './providers-model.ts'
import { errorText, InlineNote, markSaved, SectionTitle, SettingsGroup, SettingsRow } from './shared.tsx'
import { t, useT } from '../../../lib/i18n.ts'

/*
 * Devices & API: ways other things reach the agent, and machines the agent reaches.
 *   OpenAI-compatible API: lets an editor or a script talk to the agent, read-only, with a key
 *   Phone bridge: pairs a phone on your network; Android (adb): lets the agent drive a connected Android device
 *   SSH hosts: machines the agent may run commands on
 * Anything that opens a port or widens what the agent can reach is confirmed by the engine in a native dialog.
 */

export function DevicesSection() {
  useT()

  return (
    <>
      <SectionTitle title={t('settings.devices.title')} subtitle={t('settings.devices.subtitle')} />
      <ApiBlock />
      <PhoneBlock />
      <SshBlock />
    </>
  )
}

function ApiBlock() {
  useT()
  const status = useBackendData(() => jarod<ApiServerStatus>('api-server-status'))
  const settings = useJarodSettings()
  const [busy, setBusy] = useState(false)
  const [key, setKey] = useState<string | null>(null)

  if (isUnsupported(status.error)) {
    return <InlineNote tone="info">{t('settings.devices.needsJarod')}</InlineNote>
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
    <SettingsGroup title={t('settings.devices.api')}>
      {s && (
        <>
          <SettingsRow icon={<IconServer2 />} label={t('settings.devices.api.local')} description={apiSummary(s)} keywords={t('settings.devices.apiKw')}>
            <Toggle checked={s.enabled && s.running} label={t('settings.devices.api.toggle')} disabled={busy} onChange={value => void run(value ? t('settings.devices.api.on') : t('settings.devices.api.off'), () => jarod('api-server-set', value))} />
          </SettingsRow>
          <SettingsRow
            icon={<IconKey />}
            label={s.keyConfigured ? t('settings.devices.key.saved') : t('settings.devices.key.none')}
            description={t('settings.devices.key.hint')}
            keywords={t('settings.devices.keyKw')}
            below={key && <InlineNote tone="info">{t('settings.devices.key.new')} <span className="font-mono select-all">{key}</span></InlineNote>}
          >
            <GlassButton size="sm" variant={s.keyConfigured ? 'secondary' : 'primary'} disabled={busy} onClick={() => void run(t('settings.devices.key.made'), async () => setKey((await jarod<{ key: string }>('api-server-new-key')).key))}>
              {s.keyConfigured ? t('settings.devices.key.renew') : t('settings.devices.key.make')}
            </GlassButton>
          </SettingsRow>
          {api && (
            <SettingsRow icon={<IconServer2 />} label={t('settings.devices.reach')} description={t('settings.devices.reach.hint', { address: apiAddress({ host: api.host, port: api.port }) })} keywords={t('settings.devices.reachKw')}>
              <select value={api.host} disabled={busy || s.running} onChange={event => void run(t('settings.devices.settingSaved'), () => jarod('set-jarod-settings', { apiServer: { host: event.target.value } }))} aria-label={t('settings.devices.api.host')} style={{ colorScheme: 'dark' }} className="glass-input h-8 rounded-lg px-2 text-[12.5px] text-fg outline-none">
                <option value="127.0.0.1">{t('settings.devices.reach.local')}</option>
                <option value="0.0.0.0">{t('settings.devices.reach.lan')}</option>
              </select>
              <PortButton value={api.port} disabled={busy || s.running} onSave={port => run(t('settings.devices.portSaved'), () => jarod('set-jarod-settings', { apiServer: { port } }))} label={t('settings.devices.api.port')} />
            </SettingsRow>
          )}
        </>
      )}
    </SettingsGroup>
  )
}

function PortButton({ value, onSave, disabled, label }: { value: number; onSave: (port: number) => Promise<void>; disabled?: boolean; label: string }) {
  useT()
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState('')
  const problem = editing ? intProblem(text, 1024, 65535) : null

  if (!editing) {
    return (
      <GlassButton size="sm" variant="secondary" disabled={disabled} onClick={() => (setText(String(value)), setEditing(true))} aria-label={t('settings.devices.change', { what: label })}>
        {t('settings.devices.port', { port: value })}
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
        {t('settings.devices.save')}
      </GlassButton>
      <GlassButton type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>
        ✕
      </GlassButton>
      {problem && <span className="text-[11.5px] text-warn">{problem}</span>}
    </form>
  )
}

function PhoneBlock() {
  useT()
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
      reportEngineError(t('settings.devices.phone'), error)
    } finally {
      setBusy(false)
      status.reload()
    }
  }

  const left = pairing ? secondsLeft(pairing.expiresAt, now) : 0

  return (
    <SettingsGroup title={t('settings.devices.phone')}>
      <SettingsRow icon={<IconDeviceMobile />} label={t('settings.devices.bridge')} description={phoneSummary(mobile)} keywords={t('settings.devices.bridgeKw')}>
        <Toggle checked={mobile.running} label={t('settings.devices.bridge.toggle')} disabled={busy} onChange={value => void run(value ? t('settings.devices.bridge.on') : t('settings.devices.bridge.off'), () => jarod('phone-bridge-set', value))} />
      </SettingsRow>
      {mobile.running && (
        <SettingsRow
          icon={<IconKey />}
          label={t('settings.devices.pair')}
          description={t('settings.devices.pair.hint')}
          keywords={t('settings.devices.pairKw')}
          below={pairing && (
            <div className="flex flex-col gap-2">
              {left > 0 && pairing.url && (
                // The address carries the one-time code after `#`: scanning it pairs the phone without typing anything.
                <div className="flex items-center gap-4">
                  <QrCode value={pairing.url} label={t('settings.devices.pair.qrAria')} />
                  <p className="text-[12.5px] text-fg-2">{t('settings.devices.pair.qr')}</p>
                </div>
              )}
              <InlineNote tone={left > 0 ? 'info' : 'warn'}>
                {t('settings.devices.pair.address')} <span className="font-mono select-all">{pairing.url}</span> · {t('settings.devices.pair.code')} <span className="font-mono select-all">{pairing.secret}</span> · {timeLeftText(left)}
              </InlineNote>
            </div>
          )}
        >
          <GlassButton size="sm" variant="primary" disabled={busy} onClick={() => void run(t('settings.devices.pair.ready'), async () => setPairing(await jarod<PairingInfo>('phone-pairing')))}>
            {t('settings.devices.pair.show')}
          </GlassButton>
        </SettingsRow>
      )}
      {mobile.devices.map(device => (
        <SettingsRow key={device.deviceId} icon={<IconDeviceMobile />} label={device.name || t('settings.devices.phone')} description={t('settings.devices.paired', { date: new Date(device.pairedAt).toLocaleDateString(), seen: device.lastSeen ? new Date(device.lastSeen).toLocaleString() : t('settings.devices.never') })} keywords={t('settings.devices.pairedKw', { name: device.name })}>
          <GlassButton size="sm" variant="ghost" disabled={busy} onClick={() => void run(t('settings.devices.phone.removed'), () => jarod('phone-revoke', device.deviceId))} aria-label={t('settings.devices.revoke.aria', { name: device.name || t('settings.devices.phone') })}>
            {t('settings.devices.revoke')}
          </GlassButton>
        </SettingsRow>
      ))}
      <SettingsRow icon={<IconBrandAndroid />} label={t('settings.devices.android')} description={androidSummary(android)} keywords={t('settings.devices.androidKw')}>
        <GlassButton size="sm" variant="secondary" disabled={busy} onClick={() => void run(t('settings.devices.adb.chosen'), async () => {
          const file = await jarod<string | null>('android-pick-adb')

          if (file) {
            await jarod('android-set-adb', file)
          }
        })}>
          {t('settings.devices.adb.choose')}
        </GlassButton>
        {android.configured && (
          <GlassButton size="sm" variant="ghost" disabled={busy} onClick={() => void run(t('settings.devices.adb.reset'), () => jarod('android-set-adb', ''))}>
            {t('settings.devices.adb.path')}
          </GlassButton>
        )}
      </SettingsRow>
      {android.devices.map(device => (
        <SettingsRow key={device.serial} icon={<IconBrandAndroid />} label={device.model || device.serial} description={`${device.serial} · ${device.product}`} keywords={t('settings.devices.androidKw')}>
          <Pill tone={device.state === 'device' ? 'ok' : 'warn'} dot>
            {device.state}
          </Pill>
        </SettingsRow>
      ))}
    </SettingsGroup>
  )
}

function SshBlock() {
  useT()
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
      notify({ title: t('settings.devices.ssh'), body: errorText(error).replace(/^.*?\[oneai\]\s*/, ''), level: 'error' })

      return false
    } finally {
      setBusy(false)
    }
  }

  const test = async (host: SshHost) => {
    setTests(current => ({ ...current, [host.id]: t('settings.devices.ssh.testing') }))

    try {
      const r = await jarod<SshTest>('ssh-host-test', host.id)

      setTests(current => ({ ...current, [host.id]: r.ok ? t('settings.devices.ssh.connected', { ms: r.durationMs }) : t('settings.devices.ssh.failed', { reason: r.message || t('settings.devices.ssh.noAnswer') }) }))
    } catch (error) {
      setTests(current => ({ ...current, [host.id]: t('settings.devices.ssh.failed', { reason: errorText(error) }) }))
    }
  }

  const set = <K extends keyof SshDraft>(key: K, value: SshDraft[K]) => setDraft(current => (current ? { ...current, [key]: value } : current))
  const input = 'glass-input h-8 rounded-lg px-2.5 text-[12.5px] text-fg outline-none placeholder:text-fg-4'

  return (
    <SettingsGroup title={t('settings.devices.ssh')}>
      {hosts.data?.length === 0 && <SettingsRow icon={<IconTerminal2 />} label={t('settings.devices.ssh.none')} description={t('settings.devices.ssh.none.hint')} keywords={t('settings.devices.sshNoneKw')} />}
      {hosts.data?.map(host => (
        <SettingsRow key={host.id} icon={<IconTerminal2 />} label={host.name} description={`${sshLine(host)} · ${t('settings.devices.ssh.key', { file: baseName(host.keyPath) })} · ${host.agentExec ? t('settings.devices.ssh.agent.enabled') : t('settings.devices.ssh.agent.disabled')}${tests[host.id] ? ` · ${tests[host.id]}` : ''}`} keywords={t('settings.devices.sshHostKw', { name: host.name, address: host.host })}>
          <Toggle
            checked={host.agentExec === true}
            label={t('settings.devices.ssh.agent.aria', { name: host.name })}
            disabled={busy}
            onChange={value => void run(value ? t('settings.devices.ssh.agent.on', { name: host.name }) : t('settings.devices.ssh.agent.off', { name: host.name }), () => jarod('ssh-host-exec-set', host.id, value))}
          />
          <GlassButton size="sm" variant="ghost" disabled={busy} onClick={() => void test(host)} aria-label={t('settings.devices.ssh.test.aria', { name: host.name })}>
            {t('settings.devices.ssh.test')}
          </GlassButton>
          <GlassButton size="sm" variant="ghost" disabled={busy} onClick={() => void run(t('settings.devices.ssh.removed'), () => jarod('ssh-host-remove', host.id))} aria-label={t('settings.devices.ssh.remove.aria', { name: host.name })}>
            {t('settings.devices.ssh.remove')}
          </GlassButton>
        </SettingsRow>
      ))}
      <SettingsRow
        icon={<IconTerminal2 />}
        label={t('settings.devices.ssh.add')}
        description={t('settings.devices.ssh.add.hint')}
        keywords={t('settings.devices.sshAddKw')}
        below={
          draft && (
            <form
              className="flex flex-col gap-2.5"
              onSubmit={event => {
                event.preventDefault()

                if (problems.length === 0) {
                  void run(t('settings.devices.ssh.added'), () => jarod('ssh-host-add', { name: draft.name.trim(), host: draft.host.trim(), username: draft.username.trim(), port: Number(draft.port), keyPath: draft.keyPath })).then(ok => ok && setDraft(null))
                }
              }}
            >
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <input value={draft.name} onChange={event => set('name', event.target.value)} placeholder={t('settings.devices.ssh.name')} aria-label={t('settings.devices.ssh.name.aria')} className={input} />
                <input value={draft.host} onChange={event => set('host', event.target.value)} placeholder={t('settings.devices.ssh.address')} aria-label={t('settings.devices.ssh.address.aria')} spellCheck={false} className={input} />
                <input value={draft.username} onChange={event => set('username', event.target.value)} placeholder={t('settings.devices.ssh.user')} aria-label={t('settings.devices.ssh.user')} spellCheck={false} className={input} />
                <input value={draft.port} onChange={event => set('port', event.target.value)} placeholder={t('settings.devices.ssh.port')} aria-label={t('settings.devices.ssh.port')} inputMode="numeric" className={input} />
              </div>
              <div className="flex items-center gap-2 text-[12px] text-fg-3">
                <span className="min-w-0 flex-1 truncate">{draft.keyPath ? t('settings.devices.ssh.keyChosen', { file: baseName(draft.keyPath) }) : t('settings.devices.ssh.noKey')}</span>
                <GlassButton type="button" size="sm" variant="secondary" onClick={() => void jarod<string | null>('ssh-pick-key').then(file => file && set('keyPath', file), error => notify({ title: t('settings.devices.ssh.keyTitle'), body: errorText(error), level: 'error' }))}>
                  {t('settings.devices.ssh.chooseKey')}
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
                  {t('settings.devices.add')}
                </GlassButton>
              </div>
            </form>
          )
        }
      >
        <GlassButton size="sm" variant="primary" disabled={busy} onClick={() => setDraft(emptySsh())}>
          {t('settings.devices.addMore')}
        </GlassButton>
      </SettingsRow>
    </SettingsGroup>
  )
}
