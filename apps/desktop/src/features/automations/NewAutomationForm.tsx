import { IconMessageChatbot, IconPlus, IconSparkles, IconX } from '@tabler/icons-react'
import { t, type MessageKey, useT } from '../../lib/i18n.ts'
import { useState } from 'react'
import { HERALD_EVENTS, type HeraldEventName } from '../../../shared/events.ts'
import { Chips, GlassButton, GlassCard } from '../../components/ui/glass.tsx'
import { sendPrompt } from '../../store/chat.ts'
import { showPage } from '../../store/windows.ts'
import type { CronJobDraft, DeliveryTarget } from './api.ts'
import { SCHEDULE_FORMATS_HINT, humanizeCronExpr } from './cron-humanize.ts'
import { eventLabel, FieldLabel, GlyphTile, Hint, SelectInput, TextArea, TextInput, isLocalDelivery } from './presentation.tsx'

/** Runs on an event instead of a schedule; the page turns it into a paused job plus a rule. */
export interface EventTrigger {
  event: HeraldEventName
  match?: Record<string, string>
}

const TRIGGER_MODES = [
  { id: 'schedule', label: t('automation.schedule') },
  { id: 'event', label: t('automation.trigger') }
] as const

const EVENT_CHOICES = HERALD_EVENTS.filter(event => event.automation)

/** Events that can be narrowed down, and the detail they match on. */
const MATCHES: Partial<Record<HeraldEventName, { key: string; label: MessageKey; placeholder: MessageKey }>> = {
  crash: { key: 'app', label: 'automation.match.app', placeholder: 'automation.match.app.placeholder' },
  'network-change': { key: 'wifi', label: 'automation.match.wifi', placeholder: 'automation.match.wifi.placeholder' }
}

/** Inline "New automation" form shown in the detail column. */
export function NewAutomationForm({ targets, creating, onCreate, onCancel }: { targets: readonly DeliveryTarget[]; creating: boolean; onCreate: (draft: CronJobDraft, trigger?: EventTrigger) => Promise<boolean>; onCancel: () => void }) {
  const { t } = useT()
  const [name, setName] = useState('')
  const [mode, setMode] = useState<'schedule' | 'event'>('schedule')
  const [schedule, setSchedule] = useState('')
  const [event, setEvent] = useState<HeraldEventName>('login')
  const [matchValue, setMatchValue] = useState('')
  const [prompt, setPrompt] = useState('')
  const [deliver, setDeliver] = useState('local')

  const canCreate = (mode === 'event' || schedule.trim().length > 0) && prompt.trim().length > 0 && !creating
  const preview = humanizeCronExpr(schedule.trim())
  const matcher = MATCHES[event]

  const submit = async () => {
    if (!canCreate) {
      return
    }

    const draft = { name: name.trim(), schedule: schedule.trim(), prompt: prompt.trim(), deliver }

    await (mode === 'event' ? onCreate(draft, { event, match: matcher && matchValue.trim() ? { [matcher.key]: matchValue.trim() } : undefined }) : onCreate(draft))
  }

  return (
    <GlassCard className="flex h-full min-h-0 flex-col">
      <div className="flex items-start gap-3.5 px-5 pt-5 pb-4">
        <GlyphTile icon={<IconSparkles />} size={44} />
        <div className="min-w-0 flex-1">
          <h2 className="text-[18px] leading-tight font-semibold text-fg">{t('automation.new')}</h2>
          <p className="mt-1 text-[12.5px] text-fg-3">{t('automation.subtitle')}</p>
        </div>
        <GlassButton size="icon" variant="ghost" onClick={onCancel} aria-label={t('automation.new.aria')} className="-mt-1 -mr-2">
          <IconX />
        </GlassButton>
      </div>

      <form
        className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 pb-4"
        onSubmit={event => {
          event.preventDefault()
          void submit()
        }}
      >
        <div className="flex flex-col gap-1.5">
          <FieldLabel htmlFor="new-automation-name">{t('automation.name')}</FieldLabel>
          <TextInput id="new-automation-name" value={name} onChange={e => setName(e.target.value)} placeholder={t('automation.name.placeholder')} autoFocus />
        </div>

        <div className="flex flex-col gap-1.5">
          <FieldLabel htmlFor="new-automation-schedule">{t('automation.when')}</FieldLabel>
          <Chips items={TRIGGER_MODES} value={mode} onChange={setMode} className="self-start" />
          {mode === 'schedule' ? (
            <>
              <TextInput id="new-automation-schedule" value={schedule} onChange={e => setSchedule(e.target.value)} placeholder={t('automation.schedule.placeholder')} required />
              <Hint>
                {preview ? <span className="text-accent-strong">{preview}</span> : t('automation.schedule.hint', { hint: SCHEDULE_FORMATS_HINT })}
              </Hint>
            </>
          ) : (
            <>
              <SelectInput id="new-automation-schedule" value={event} onChange={e => setEvent(e.target.value as HeraldEventName)}>
                {EVENT_CHOICES.map(choice => (
                  <option key={choice.name} value={choice.name}>
                    {eventLabel(choice.name)}
                  </option>
                ))}
              </SelectInput>
              {matcher && <TextInput aria-label={t(matcher.label)} value={matchValue} onChange={e => setMatchValue(e.target.value)} placeholder={t(matcher.placeholder)} />}
              <Hint>{t('automation.eventHint')}</Hint>
            </>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <FieldLabel htmlFor="new-automation-prompt">{t('automation.gather')}</FieldLabel>
          <TextArea id="new-automation-prompt" value={prompt} onChange={e => setPrompt(e.target.value)} rows={6} placeholder={t('automation.gather.placeholder')} required />
        </div>

        <div className="flex flex-col gap-1.5">
          <FieldLabel htmlFor="new-automation-deliver">{t('automation.deliver')}</FieldLabel>
          <SelectInput id="new-automation-deliver" value={deliver} onChange={e => setDeliver(e.target.value)}>
            {targets.map(target => (
              <option key={target.id} value={target.id} disabled={target.home_target_set === false}>
                {target.name}
                {target.home_target_set === false ? t('automation.deliver.homeMissing') : ''}
              </option>
            ))}
          </SelectInput>
          <Hint>{isLocalDelivery(deliver) ? t('automation.deliver.hint.local') : t('automation.deliver.hint.remote')}</Hint>
        </div>
      </form>

      <div className="flex items-center justify-between gap-3 border-t border-line px-5 py-3.5">
        <GlassButton
          variant="secondary"
          onClick={() => {
            showPage('hermes')
            void sendPrompt(t('automation.describePrompt'))
          }}
        >
          <IconMessageChatbot />
          {t('automation.describe')}
        </GlassButton>
        <GlassButton variant="primary" disabled={!canCreate} onClick={() => void submit()} aria-label={t('automation.new')}>
          <IconPlus />
          {creating ? t('automation.creating') : t('automation.create')}
        </GlassButton>
      </div>
    </GlassCard>
  )
}
