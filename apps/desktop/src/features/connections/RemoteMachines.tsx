import { useStore } from '@nanostores/react'
import { IconDeviceDesktop, IconKey, IconPlugConnected, IconRefresh, IconShieldCheck, IconTerminal2, IconTrash, IconWorld } from '@tabler/icons-react'
import { useCallback, useEffect, useState } from 'react'
import { GlassButton, GlassCard, Pill } from '../../components/ui/glass.tsx'
import { Spinner } from '../../components/ui/primitives.tsx'
import { jarod } from '../../lib/jarod.ts'
import { type MessageKey, t, useT } from '../../lib/i18n.ts'
import { useBackendData } from '../../lib/use-async.ts'
import { $network } from '../../store/network.ts'
import { $terminalRequest } from '../../store/terminal.ts'
import { openApp } from '../../store/windows.ts'
import { baseName, emptySsh, type SshDraft, type SshHost, type SshTest, sshLine, sshProblems } from '../settings/sections/devices-model.ts'
import { errorText } from '../settings/sections/shared.tsx'

/*
 * Connexions › Machines distantes (docs/REMOTE-SSH.md): Tailscale's state and its machines, the SSH targets you declared, and for each one
 * three separate checks — the network (a TCP connection), the host key (its fingerprint, confirmed before it is trusted) and the
 * authentication (the engine's fixed test command) — then a Terminal tab on it. The agent runs commands on a machine only when it is
 * enabled in Settings › Devices, one command at a time, each confirmed by the person (remote_exec, docs/REMOTE-SSH.md).
 */

type Tailscale = Awaited<ReturnType<typeof window.jarodOS.remote.tailscale>>
type Scan = Exclude<Awaited<ReturnType<typeof window.jarodOS.remote.scanKeys>>, { error: string }>

export function RemoteMachines() {
  useT()
  const hosts = useBackendData(() => jarod<SshHost[]>('ssh-hosts-list'))
  const [tailscale, setTailscale] = useState<Tailscale | null>(null)
  const [draft, setDraft] = useState<SshDraft | null>(null)
  const [error, setError] = useState<string | null>(null)
  const policy = useStore($network)
  const list = hosts.data ?? []
  const hostKey = list.map(h => h.host.toLowerCase()).sort().join(',')

  const refreshTailscale = useCallback(() => {
    setTailscale(null)
    void window.jarodOS.remote
      .tailscale()
      .then(setTailscale)
      .catch(() => setTailscale({ installed: false, backend: null, self: null, peers: [] }))
  }, [])

  useEffect(refreshTailscale, [refreshTailscale])

  // The Internet switch's "remote machines" exception covers exactly the machines declared here.
  useEffect(() => {
    if (hosts.data) void window.jarodOS.remote.syncHosts(hosts.data.map(h => h.host.toLowerCase())).catch(() => undefined)
  }, [hostKey])

  const add = async () => {
    if (!draft) return
    setError(null)

    try {
      await jarod('ssh-host-add', { name: draft.name.trim(), host: draft.host.trim(), username: draft.username.trim(), port: Number(draft.port), keyPath: draft.keyPath })
      setDraft(null)
      hosts.reload()
    } catch (reason) {
      setError(errorText(reason).replace(/^.*?\[oneai\]\s*/, ''))
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <GlassCard className="flex flex-col gap-3 p-4">
        <div className="flex items-center gap-3">
          <IconWorld size={18} className="text-fg-2" />
          <div className="min-w-0 flex-1">
            <div className="text-[13.5px] font-medium text-fg">Tailscale</div>
            <div className="text-[12px] text-fg-3">{tailscaleLine(tailscale)}</div>
          </div>
          <GlassButton size="sm" variant="ghost" onClick={refreshTailscale} aria-label={t('remote.refresh')}>
            <IconRefresh />
          </GlassButton>
        </div>
        {tailscale?.peers && tailscale.peers.length > 0 && (
          <ul className="flex flex-col divide-y divide-line">
            {tailscale.peers.map(peer => (
              <li key={`${peer.name}-${peer.ips[0] ?? ''}`} className="flex items-center gap-3 py-1.5 text-[12.5px]">
                <span className={`size-2 rounded-full ${peer.online ? 'bg-ok' : 'bg-fg-4'}`} aria-label={peer.online ? t('remote.online') : t('remote.offline')} />
                <span className="min-w-0 flex-1 truncate text-fg">
                  {peer.name} <span className="text-fg-3">· {peer.os}{peer.sshHostKeys ? ` · ${t('remote.tailscaleSsh')}` : ''}</span>
                </span>
                <span className="selectable font-mono text-[11.5px] text-fg-3">{peer.ips[0] ?? ''}</span>
                <GlassButton size="sm" variant="ghost" onClick={() => setDraft({ ...emptySsh(), name: peer.name.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 40), host: peer.ips[0] ?? peer.dnsName })}>
                  {t('remote.useAsTarget')}
                </GlassButton>
              </li>
            ))}
          </ul>
        )}
        <p className="text-[11.5px] text-fg-4">{t('remote.tailscaleNote')}</p>
      </GlassCard>

      {policy && !policy.internet && <p className="text-[12px] text-warn">{policy.remoteMachines ? t('remote.offlineAllowed') : t('remote.offlineBlocked')}</p>}

      <GlassCard className="flex flex-col gap-3 p-4">
        <div className="flex items-center gap-3">
          <IconDeviceDesktop size={18} className="text-fg-2" />
          <div className="min-w-0 flex-1 text-[13.5px] font-medium text-fg">{t('remote.targets')}</div>
          <GlassButton size="sm" variant="primary" disabled={Boolean(draft)} onClick={() => setDraft(emptySsh())}>
            {t('remote.add')}
          </GlassButton>
        </div>
        {hosts.loading && !hosts.data && <Spinner />}
        {hosts.error && <p className="text-[12px] text-danger">{hosts.error}</p>}
        {hosts.data?.length === 0 && !draft && <p className="text-[12.5px] text-fg-3">{t('remote.none')}</p>}
        {draft && <AddForm draft={draft} names={list.map(h => h.name)} onChange={setDraft} onCancel={() => setDraft(null)} onSave={() => void add()} />}
        {error && <p className="text-[12px] text-danger">{error}</p>}
        <ul className="flex flex-col divide-y divide-line">
          {list.map(host => (
            <TargetRow key={host.id} host={host} onRemoved={hosts.reload} />
          ))}
        </ul>
        <p className="text-[11.5px] text-fg-4">{t('remote.agentNote')}</p>
      </GlassCard>
    </div>
  )
}

function tailscaleLine(state: Tailscale | null): string {
  if (!state) return t('remote.reading')
  if (!state.installed) return t('remote.tailscale.absent')
  if (state.error) return t('remote.tailscale.unreadable', { detail: state.error })
  if (state.backend === 'Running') return t('remote.tailscale.running', { name: state.self?.name ?? '', ip: state.self?.ips[0] ?? '', count: state.peers.length })
  if (state.backend === 'NeedsLogin') return t('remote.tailscale.needsLogin')

  return t('remote.tailscale.notRunning', { state: state.backend ?? '?' })
}

function AddForm({ draft, names, onChange, onCancel, onSave }: { draft: SshDraft; names: string[]; onChange: (draft: SshDraft) => void; onCancel: () => void; onSave: () => void }) {
  const problems = sshProblems(draft, names)
  const input = 'glass-input h-8 rounded-lg px-2.5 text-[12.5px] text-fg outline-none placeholder:text-fg-4'
  const set = <K extends keyof SshDraft>(key: K, value: SshDraft[K]) => onChange({ ...draft, [key]: value })
  const pick = async () => {
    const file = await jarod<string | null>('ssh-pick-key').catch(() => null)

    if (file) set('keyPath', file)
  }

  return (
    <form
      className="flex flex-col gap-2 rounded-lg bg-white/5 p-3"
      onSubmit={event => {
        event.preventDefault()
        if (problems.length === 0) onSave()
      }}
    >
      <div className="grid grid-cols-2 gap-2">
        <input aria-label={t('remote.alias')} placeholder={t('remote.alias')} value={draft.name} onChange={event => set('name', event.target.value)} className={input} />
        <input aria-label={t('remote.address')} placeholder={t('remote.address')} value={draft.host} spellCheck={false} onChange={event => set('host', event.target.value)} className={`${input} font-mono`} />
        <input aria-label={t('remote.user')} placeholder={t('remote.user')} value={draft.username} spellCheck={false} onChange={event => set('username', event.target.value)} className={`${input} font-mono`} />
        <input aria-label={t('remote.port')} placeholder="22" value={draft.port} inputMode="numeric" onChange={event => set('port', event.target.value)} className={`${input} font-mono`} />
      </div>
      <div className="flex items-center gap-2 text-[12px] text-fg-2">
        <IconKey size={14} />
        <span className="min-w-0 flex-1 truncate">{draft.keyPath ? t('remote.keyChosen', { file: baseName(draft.keyPath) }) : t('remote.noKey')}</span>
        <GlassButton type="button" size="sm" variant="ghost" onClick={() => void pick()}>
          {t('remote.pickKey')}
        </GlassButton>
      </div>
      {problems.length > 0 && (draft.name || draft.host) && <p className="text-[11.5px] text-warn">{problems[0]}</p>}
      <div className="flex justify-end gap-2">
        <GlassButton type="button" size="sm" variant="ghost" onClick={onCancel}>
          {t('remote.cancel')}
        </GlassButton>
        <GlassButton type="submit" size="sm" variant="primary" disabled={problems.length > 0}>
          {t('remote.save')}
        </GlassButton>
      </div>
    </form>
  )
}

type Check = { state: 'idle' | 'running' | 'ok' | 'failed'; text: string }
const idle: Check = { state: 'idle', text: '' }

function TargetRow({ host, onRemoved }: { host: SshHost; onRemoved: () => void }) {
  useT()
  const [network, setNetwork] = useState<Check>(idle)
  const [auth, setAuth] = useState<Check>(idle)
  const [scan, setScan] = useState<Scan | null>(null)
  const [keyCheck, setKeyCheck] = useState<Check>(idle)

  const probe = async () => {
    setNetwork({ state: 'running', text: t('remote.checking') })
    const r = await window.jarodOS.remote.probe(host.host, host.port)
    setNetwork(r.ok ? { state: 'ok', text: t('remote.network.ok', { ms: r.ms }) } : { state: 'failed', text: t(`remote.network.${r.error === 'offline' ? 'offline' : r.error === 'timeout' ? 'timeout' : 'failed'}` as MessageKey, { detail: r.error ?? '' }) })
  }

  const keys = async () => {
    setKeyCheck({ state: 'running', text: t('remote.checking') })
    const r = await window.jarodOS.remote.scanKeys(host.host, host.port)

    if ('error' in r) {
      setKeyCheck({ state: 'failed', text: t(r.error === 'offline' ? 'remote.network.offline' : 'remote.keys.failed') })

      return
    }

    setScan(r)
    setKeyCheck({ state: r.verdict === 'match' ? 'ok' : 'failed', text: t(`remote.keys.${r.verdict}` as MessageKey) })
  }

  const trust = async () => {
    if (!scan) return
    const r = await window.jarodOS.remote.trustKeys(scan.token)
    setScan(null)
    setKeyCheck(r.ok ? { state: 'ok', text: t('remote.keys.trusted') } : { state: 'failed', text: r.error ?? '' })
  }

  const test = async () => {
    setAuth({ state: 'running', text: t('remote.checking') })

    try {
      const r = await jarod<SshTest>('ssh-host-test', host.id)
      setAuth(r.ok ? { state: 'ok', text: t('remote.auth.ok', { ms: r.durationMs }) } : { state: 'failed', text: t('remote.auth.failed', { reason: r.message || t('remote.noAnswer') }) })
    } catch (reason) {
      setAuth({ state: 'failed', text: errorText(reason) })
    }
  }

  const terminal = () => {
    $terminalRequest.set({ ssh: { host: host.host, port: host.port, user: host.username, identity: host.keyPath }, label: `${host.name} (${t('remote.remoteTag')})`, at: Date.now() })
    openApp('terminal')
  }

  const remove = async () => {
    await jarod('ssh-host-remove', host.id).catch(() => undefined)
    onRemoved()
  }

  return (
    <li className="flex flex-col gap-2 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <IconDeviceDesktop size={15} className="shrink-0 text-fg-3" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] text-fg">
            {host.name} <Pill tone="muted">{t('remote.remoteTag')}</Pill>
          </div>
          <div className="selectable truncate font-mono text-[11.5px] text-fg-3">
            {sshLine(host)} · {baseName(host.keyPath)}
          </div>
        </div>
        <GlassButton size="sm" variant="ghost" onClick={() => void probe()}>
          <IconPlugConnected />
          {t('remote.network')}
        </GlassButton>
        <GlassButton size="sm" variant="ghost" onClick={() => void keys()}>
          <IconShieldCheck />
          {t('remote.keys')}
        </GlassButton>
        <GlassButton size="sm" variant="ghost" onClick={() => void test()}>
          <IconKey />
          {t('remote.auth')}
        </GlassButton>
        <GlassButton size="sm" variant="primary" onClick={terminal}>
          <IconTerminal2 />
          {t('remote.terminal')}
        </GlassButton>
        <GlassButton size="icon" variant="ghost" aria-label={t('remote.remove', { name: host.name })} onClick={() => void remove()}>
          <IconTrash />
        </GlassButton>
      </div>
      {[network, keyCheck, auth]
        .filter(check => check.state !== 'idle')
        .map((check, index) => (
          <p key={index} className={`text-[12px] ${check.state === 'ok' ? 'text-ok' : check.state === 'failed' ? 'text-danger' : 'text-fg-3'}`} role="status">
            {check.text}
          </p>
        ))}
      {scan && (scan.verdict === 'unknown' || scan.verdict === 'changed') && (
        <div className="flex flex-col gap-2 rounded-lg bg-white/5 px-3 py-2 text-[12.5px] text-fg-2">
          <span>{t(scan.verdict === 'changed' ? 'remote.keys.confirmChanged' : 'remote.keys.confirmNew', { host: host.host })}</span>
          <ul className="selectable font-mono text-[11.5px] text-fg">
            {scan.keys.map(key => (
              <li key={key.fingerprint}>
                {key.type} {key.fingerprint}
              </li>
            ))}
          </ul>
          {scan.verdict === 'changed' && (
            <div className="text-[11.5px] text-fg-3">
              {t('remote.keys.previous')}
              <ul className="selectable font-mono">
                {scan.known.map(fingerprint => (
                  <li key={fingerprint}>{fingerprint}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="flex justify-end gap-2">
            <GlassButton size="sm" variant="ghost" onClick={() => setScan(null)}>
              {t('remote.keys.reject')}
            </GlassButton>
            <GlassButton size="sm" variant={scan.verdict === 'changed' ? 'danger' : 'primary'} onClick={() => void trust()}>
              {t(scan.verdict === 'changed' ? 'remote.keys.replace' : 'remote.keys.trust')}
            </GlassButton>
          </div>
        </div>
      )}
    </li>
  )
}
