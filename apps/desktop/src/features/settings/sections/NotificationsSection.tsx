import { useStore } from '@nanostores/react'
import { type MessageKey, useT } from '../../../lib/i18n.ts'
import { IconBellRinging, IconBug, IconChecklist, IconDeviceDesktop, IconShieldCheck, IconVolumeOff, IconX } from '@tabler/icons-react'
import { useState } from 'react'
import { Toggle } from '../../../components/ui/glass.tsx'
import { $prefs } from '../../../store/backend.ts'
import { setCrashHelpEnabled, setCrashMuted } from '../../../store/crashes.ts'
import { errorText, InlineNote, markSaved, readLocalFlag, SectionTitle, SettingsGroup, SettingsRow, writeLocal } from './shared.tsx'

/*
 * Notification preferences are shell-side flags in localStorage (`jarod-os.notify.*`). The
 * notification store does not read them yet; see the page report for the proposed wiring.
 */

export const NOTIFY_KEYS = {
  toolCompletions: 'jarod-os.notify.tool-completions',
  approvals: 'jarod-os.notify.approvals',
  taskUpdates: 'jarod-os.notify.task-updates',
  nativeWhenUnfocused: 'jarod-os.notify.native-unfocused'
} as const

type NotifyKey = keyof typeof NOTIFY_KEYS

const ROWS: { key: NotifyKey; label: MessageKey; description: MessageKey; icon: React.ReactNode; keywords: MessageKey }[] = [
  { key: 'toolCompletions', label: 'notify.toolCompletions', description: 'notify.toolCompletions.desc', icon: <IconChecklist />, keywords: 'notify.kw.tools' },
  { key: 'approvals', label: 'notify.approvals', description: 'notify.approvals.desc', icon: <IconShieldCheck />, keywords: 'notify.kw.approvals' },
  { key: 'taskUpdates', label: 'notify.taskUpdates', description: 'notify.taskUpdates.desc', icon: <IconBellRinging />, keywords: 'notify.kw.tasks' },
  { key: 'nativeWhenUnfocused', label: 'notify.nativeWhenUnfocused', description: 'notify.nativeWhenUnfocused.desc', icon: <IconDeviceDesktop />, keywords: 'notify.kw.native' }
]

export function NotificationsSection() {
  const { t } = useT()
  const [flags, setFlags] = useState<Record<NotifyKey, boolean>>(() => ({
    toolCompletions: readLocalFlag(NOTIFY_KEYS.toolCompletions, true),
    approvals: readLocalFlag(NOTIFY_KEYS.approvals, true),
    taskUpdates: readLocalFlag(NOTIFY_KEYS.taskUpdates, true),
    nativeWhenUnfocused: readLocalFlag(NOTIFY_KEYS.nativeWhenUnfocused, true)
  }))

  const set = (key: NotifyKey, value: boolean) => {
    setFlags(prev => ({ ...prev, [key]: value }))
    writeLocal(NOTIFY_KEYS[key], String(value))
    markSaved()
  }

  return (
    <>
      <SectionTitle title={t('notify.title')} subtitle={t('notify.subtitle')} />

      <SettingsGroup title={t('notify.alerts')}>
        {ROWS.map(row => (
          <SettingsRow key={row.key} icon={row.icon} label={t(row.label)} description={t(row.description)} keywords={t(row.keywords)}>
            <Toggle checked={flags[row.key]} onChange={next => set(row.key, next)} label={t(row.label)} />
          </SettingsRow>
        ))}
      </SettingsGroup>

      <CrashHelpGroup />
    </>
  )
}

function CrashHelpGroup() {
  const { t } = useT()
  const { enabled, muted } = useStore($prefs).crashHelp
  const [error, setError] = useState<string | null>(null)

  const save = (work: Promise<unknown>) =>
    work.then(
      () => {
        setError(null)
        markSaved()
      },
      reason => setError(errorText(reason))
    )

  return (
    <SettingsGroup title={t('notify.crashGroup')}>
      <SettingsRow
        icon={<IconBug />}
        label={t('notify.crashOffer')}
        description={t('notify.crashOffer.desc')}
        keywords={t('notify.crashKw')}
        below={error ? <InlineNote tone="danger">{error}</InlineNote> : undefined}
      >
        <Toggle checked={enabled} onChange={next => save(setCrashHelpEnabled(next))} label={t('notify.crashOffer')} />
      </SettingsRow>
      <SettingsRow
        icon={<IconVolumeOff />}
        label={t('notify.muted')}
        description={muted.length === 0 ? t('notify.muted.none') : t('notify.muted.some')}
        keywords={t('notify.mutedKw')}
        below={
          muted.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {muted.map(app => (
                <span key={app} className="inline-flex h-7 items-center gap-1 rounded-full border border-line bg-white/6 pr-1 pl-2.5 text-[12px] text-fg-2">
                  {app}
                  <button type="button" aria-label={t('notify.unmuteAria', { name: app })} onClick={() => save(setCrashMuted(app, false))} className="flex size-5 items-center justify-center rounded-full text-fg-3 hover:bg-white/10 hover:text-fg">
                    <IconX size={12} />
                  </button>
                </span>
              ))}
            </div>
          ) : undefined
        }
      />
    </SettingsGroup>
  )
}
