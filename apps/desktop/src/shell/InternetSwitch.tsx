import { useStore } from '@nanostores/react'
import { IconWorld, IconWorldOff } from '@tabler/icons-react'
import { useEffect, useState } from 'react'
import { Toggle } from '../components/ui/glass.tsx'
import { cn } from '../lib/cn.ts'
import { t, useT } from '../lib/i18n.ts'
import { $network, bindNetwork, networkLabelKey, setNetwork } from '../store/network.ts'
import { notify } from '../store/notifications.ts'
import { useDismiss } from '../features/settings/sections/shared.tsx'

/*
 * The Internet switch of the top bar (docs/NETWORK-POLICY.md): Jarod's own access to the Internet, not the computer's connection.
 * One click on the pill opens the details: the switch itself, the remote machines exception and the local commands exception.
 */
export function InternetSwitch() {
  useT()
  const policy = useStore($network)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const ref = useDismiss(open, () => setOpen(false))

  useEffect(() => bindNetwork(), [])

  if (!policy) {
    return null
  }

  const label = t(networkLabelKey(policy))
  const change = async (next: Parameters<typeof setNetwork>[0]) => {
    setBusy(true)

    try {
      await setNetwork(next)
    } catch (error) {
      notify({ title: t('network.switch.failed'), body: error instanceof Error ? error.message : String(error), level: 'error' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t('network.switch.aria', { state: label })}
        title={label}
        onClick={() => setOpen(v => !v)}
        className={cn(
          'flex h-6 items-center gap-1.5 rounded-full border px-2 text-[11.5px] transition-colors',
          policy.internet ? 'border-transparent text-fg-2 hover:bg-white/10' : 'border-danger/60 bg-danger/20 text-fg hover:bg-danger/30'
        )}
      >
        {policy.internet ? <IconWorld size={14} aria-hidden="true" /> : <IconWorldOff size={14} aria-hidden="true" />}
        <span className={cn(policy.internet && 'sr-only')}>{label}</span>
      </button>
      {open && (
        <div role="dialog" aria-label={t('network.switch.title')} className="float animate-pop absolute top-[calc(100%+8px)] right-0 z-50 flex w-[340px] max-w-[90vw] flex-col gap-3 rounded-xl p-3.5 text-[12.5px] text-fg-2">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-[13px] font-semibold text-fg">{t('network.switch.title')}</div>
              <div className="text-[11.5px] text-fg-3">{label}</div>
            </div>
            <Toggle checked={policy.internet} disabled={busy} label={t('network.switch.title')} onChange={internet => void change({ internet })} />
          </div>
          <p className="text-[11.5px] leading-relaxed text-fg-3">{t('network.switch.scope')}</p>
          {!policy.internet && (
            <>
              <p className="text-[11.5px] leading-relaxed text-fg-3">{t('network.switch.sent')}</p>
              <div className="flex items-start justify-between gap-3 border-t border-line pt-3">
                <div>
                  <div className="text-fg">{t('network.switch.remoteMachines')}</div>
                  <div className="text-[11.5px] leading-snug text-fg-3">
                    {policy.remoteHosts.length > 0 ? t('network.switch.remoteMachines.hint', { count: policy.remoteHosts.length }) : t('network.switch.remoteMachines.none')}
                  </div>
                </div>
                <Toggle checked={policy.remoteMachines} disabled={busy || policy.remoteHosts.length === 0} label={t('network.switch.remoteMachines')} onChange={remoteMachines => void change({ remoteMachines })} />
              </div>
              <div className="flex items-start justify-between gap-3 border-t border-line pt-3">
                <div>
                  <div className="text-fg">{t('network.switch.localCommands')}</div>
                  <div className="text-[11.5px] leading-snug text-fg-3">{t('network.switch.localCommands.hint')}</div>
                </div>
                <Toggle checked={policy.localCommands} disabled={busy} label={t('network.switch.localCommands')} onChange={localCommands => void change({ localCommands })} />
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
