import { IconBrandUbuntu, IconDeviceDesktop, IconDownload, IconPlayerStop, IconTerminal2, IconTransfer, IconTrash } from '@tabler/icons-react'
import { useCallback, useEffect, useState } from 'react'
import type { VmsState, VmSummary } from '../../../../shared/vms.ts'
import { GlassButton, GlassCard } from '../../../components/ui/glass.tsx'
import { Spinner } from '../../../components/ui/primitives.tsx'
import { type MessageKey, useT } from '../../../lib/i18n.ts'
import { openTerminalVm } from '../../../store/terminal.ts'
import { SettingsBlock } from './shared.tsx'

const KNOWN = ['no-disk', 'busy', 'bad-name', 'exists', 'not-a-vm', 'not-confirmed', 'windows-only']

/**
 * WSL machines and the Jarod disk (electron/vms.ts): the machines of this account, where their disk is, a new one
 * installed on the Jarod disk or an existing one moved there, opened in a Terminal tab, stopped, or removed (its name
 * typed to confirm, since that erases its disk).
 */
export function VmsBlock() {
  const { t } = useT()
  const [state, setState] = useState<VmsState | null>(null)
  const [online, setOnline] = useState<Array<{ id: string; label: string }> | null>(null)
  const [distro, setDistro] = useState('')
  const [name, setName] = useState('')
  const [working, setWorking] = useState<string | null>(null)
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)

  const refresh = useCallback(() => {
    void window.jarodOS.vms
      .state()
      .then(setState)
      .catch(() => undefined)
  }, [])

  useEffect(refresh, [refresh])

  const describe = (reason: string) => (KNOWN.includes(reason) ? t(`vms.error.${reason}` as MessageKey) : t('vms.error.other', { detail: reason }))

  const act = async (label: string, work: () => Promise<{ ok: boolean; error?: string }>, done: string) => {
    setWorking(label)
    setMessage(null)
    const result = await work().catch((reason: unknown) => ({ ok: false, error: String(reason) }))
    setWorking(null)
    setMessage(result.ok ? { tone: 'ok', text: done } : { tone: 'error', text: describe(result.error ?? '') })
    refresh()

    return result.ok
  }

  const loadOnline = () => {
    setOnline([])
    void window.jarodOS.vms
      .online()
      .then(list => {
        setOnline(list)
        setDistro(list.find(item => /ubuntu-24/i.test(item.id))?.id ?? list[0]?.id ?? '')
      })
      .catch(() => setOnline([]))
  }

  const install = async () => {
    const ok = await act('install', () => window.jarodOS.vms.create(distro, name.trim()), t('vms.installed', { name: name.trim() }))

    if (ok) {
      openTerminalVm(name.trim())
      setName('')
    }
  }

  return (
    <SettingsBlock title={t('vms.title')} label={t('vms.title')} description={t('vms.text')} keywords={t('vms.keywords')}>
      <GlassCard className="flex flex-col gap-3 p-4">
        <p className="text-[12.5px] text-fg-3">{t('vms.text')}</p>

        {!state ? (
          <Spinner />
        ) : !state.available ? (
          <p className="text-[12.5px] text-fg-2">{t('vms.error.windows-only')}</p>
        ) : (
          <>
            {!state.root && <p className="text-[12.5px] text-fg-2">{t('vms.needsDisk')}</p>}

            {state.root && (
              <div className="flex flex-wrap items-center gap-2">
                {online === null ? (
                  <GlassButton size="sm" onClick={loadOnline}>
                    <IconDeviceDesktop />
                    {t('vms.new')}
                  </GlassButton>
                ) : online.length === 0 ? (
                  <span className="flex items-center gap-2 text-[12.5px] text-fg-3">
                    <Spinner /> {t('vms.loadingOnline')}
                  </span>
                ) : (
                  <>
                    <select value={distro} onChange={event => setDistro(event.target.value)} aria-label={t('vms.distro')} className="glass-input h-8 max-w-56 rounded-lg px-2 text-[12.5px] outline-none">
                      {online.map(item => (
                        <option key={item.id} value={item.id}>
                          {item.label}
                        </option>
                      ))}
                    </select>
                    <input value={name} onChange={event => setName(event.target.value.replace(/[^A-Za-z0-9._-]/g, ''))} placeholder={t('vms.name')} aria-label={t('vms.name')} className="glass-input h-8 w-36 rounded-lg px-2.5 text-[12.5px] outline-none" />
                    <span className="flex-1" />
                    <GlassButton size="sm" variant="primary" disabled={!distro || !name.trim() || Boolean(working || state.busy)} onClick={() => void install()}>
                      {working === 'install' ? <Spinner /> : <IconDownload />}
                      {working === 'install' ? t('vms.installing') : t('vms.install')}
                    </GlassButton>
                  </>
                )}
              </div>
            )}
            {working === 'install' && <p className="text-[11.5px] text-fg-3">{t('vms.installHint')}</p>}
            {message && <p className={message.tone === 'ok' ? 'text-[12.5px] text-ok' : 'text-[12.5px] text-danger'}>{message.text}</p>}

            {state.list.length === 0 ? (
              <p className="text-[12.5px] text-fg-3">{t('vms.none')}</p>
            ) : (
              <ul className="flex flex-col divide-y divide-line">
                {state.list.map(vm => (
                  <VmRow key={vm.name} vm={vm} canMove={Boolean(state.root) && !vm.onDisk} disabled={Boolean(working || state.busy)} working={working} onAct={act} />
                ))}
              </ul>
            )}
          </>
        )}
      </GlassCard>
    </SettingsBlock>
  )
}

function VmRow({
  vm,
  canMove,
  disabled,
  working,
  onAct
}: {
  vm: VmSummary
  canMove: boolean
  disabled: boolean
  working: string | null
  onAct: (label: string, work: () => Promise<{ ok: boolean; error?: string }>, done: string) => Promise<boolean>
}) {
  const { t } = useT()
  const [removing, setRemoving] = useState(false)
  const [typed, setTyped] = useState('')
  const running = vm.state === 'Running'

  return (
    <li className="flex flex-col gap-2 py-2">
      <div className="flex items-center gap-3">
        <IconBrandUbuntu size={16} className="shrink-0 text-fg-3" />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] text-fg">
            {vm.name} <span className="text-[11.5px] text-fg-3">· {running ? t('vms.running') : t('vms.stopped')}</span>
            {vm.onDisk && <span className="ml-2 rounded bg-ok/12 px-1.5 py-0.5 text-[10.5px] text-ok">{t('vms.onDisk')}</span>}
          </div>
          {vm.location && <div className="selectable truncate font-mono text-[11px] text-fg-3">{vm.location}</div>}
        </div>
        <GlassButton size="sm" variant="ghost" onClick={() => openTerminalVm(vm.name)}>
          <IconTerminal2 />
          {t('vms.open')}
        </GlassButton>
        {running && (
          <GlassButton size="icon" variant="ghost" aria-label={t('vms.stop')} disabled={disabled} onClick={() => void onAct(`stop ${vm.name}`, () => window.jarodOS.vms.stop(vm.name), t('vms.stoppedDone', { name: vm.name }))}>
            <IconPlayerStop />
          </GlassButton>
        )}
        {canMove && (
          <GlassButton size="sm" variant="ghost" disabled={disabled} onClick={() => void onAct(`move ${vm.name}`, () => window.jarodOS.vms.move(vm.name), t('vms.moved', { name: vm.name }))}>
            {working === `move ${vm.name}` ? <Spinner /> : <IconTransfer />}
            {t('vms.move')}
          </GlassButton>
        )}
        <GlassButton size="icon" variant="ghost" aria-label={t('vms.remove')} disabled={disabled} onClick={() => setRemoving(true)}>
          <IconTrash />
        </GlassButton>
      </div>
      {removing && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg bg-danger/10 px-3 py-2 text-[12.5px] text-fg-2">
          <span className="w-full">{t('vms.confirmRemove', { name: vm.name })}</span>
          <input value={typed} onChange={event => setTyped(event.target.value)} placeholder={vm.name} aria-label={t('vms.typeName')} className="glass-input h-8 w-44 rounded-lg px-2.5 font-mono text-[12.5px] outline-none" />
          <span className="flex-1" />
          <GlassButton
            size="sm"
            variant="ghost"
            onClick={() => {
              setRemoving(false)
              setTyped('')
            }}
          >
            {t('backups.cancel')}
          </GlassButton>
          <GlassButton
            size="sm"
            variant="danger"
            disabled={typed !== vm.name || disabled}
            onClick={() => void onAct(`remove ${vm.name}`, () => window.jarodOS.vms.remove(vm.name, typed), t('vms.removed', { name: vm.name })).then(() => setRemoving(false))}
          >
            {t('vms.removeNow')}
          </GlassButton>
        </div>
      )}
    </li>
  )
}
