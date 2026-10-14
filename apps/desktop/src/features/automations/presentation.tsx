import { IconDatabase, IconDownload, IconEye, IconFileText, IconRefresh, IconSunrise, type IconProps } from '@tabler/icons-react'
import type React from 'react'
import { type EventAutomation, type HeraldEventName } from '../../../shared/events.ts'
import { cn } from '../../lib/cn.ts'
import { t, type MessageKey } from '../../lib/i18n.ts'
import type { CronJob } from '../../lib/rest.ts'
import type { DeliveryTarget } from './api.ts'
import { joinList } from './cron-humanize.ts'

/*
 * Presentation-only derivations for the Automations page: which glyph a job gets, how its prompt is
 * summarised into the step editor, and the shared icon tile / field chrome.
 */

type TablerIcon = React.ComponentType<IconProps>

/** Each event's name in the catalogue. `HERALD_EVENTS` keeps its English label: the main process reports it. */
const EVENT_KEY: Record<HeraldEventName, MessageKey> = {
  login: 'automation.event.login',
  wake: 'automation.event.wake',
  sleep: 'automation.event.sleep',
  lock: 'automation.event.lock',
  unlock: 'automation.event.unlock',
  returned: 'automation.event.returned',
  'battery-low': 'automation.event.batteryLow',
  'network-change': 'automation.event.networkChange',
  'theme-set': 'automation.event.themeSet',
  crash: 'automation.event.crash',
  'after-update': 'automation.event.afterUpdate'
}

/** 'When I log in', in the current language. */
export function eventLabel(event: HeraldEventName): string {
  return t(EVENT_KEY[event])
}

/** An event rule as a line: 'When a program crashes (Safari)'. */
export function ruleText(rule: Pick<EventAutomation, 'event' | 'match'>): string {
  const label = eventLabel(rule.event)
  const values = Object.values(rule.match ?? {}).filter(Boolean)

  return values.length ? t('automation.rule.withDetail', { label, detail: values.join(', ') }) : label
}

const ICON_RULES: readonly { pattern: RegExp; icon: TablerIcon }[] = [
  { pattern: /brief|morning|wake|start of day|daily digest/i, icon: IconSunrise },
  { pattern: /digest|report|summary|summar|recap|weekly|review/i, icon: IconFileText },
  { pattern: /download|organi[sz]e|clean|tidy|sort|archive/i, icon: IconDownload },
  { pattern: /backup|back up|snapshot|sync|export/i, icon: IconDatabase },
  { pattern: /check|monitor|watch|alert|health|status|ping/i, icon: IconEye }
]

export function iconForJob(job: Pick<CronJob, 'name' | 'prompt'>): TablerIcon {
  const haystack = job.name || job.prompt || ''

  return ICON_RULES.find(rule => rule.pattern.test(haystack))?.icon ?? IconRefresh
}

/** Blue-glass square with a Tabler glyph (the `.icon-tile` treatment used for app tiles). */
export function JobTile({ job, size = 44, className }: { job: Pick<CronJob, 'name' | 'prompt'>; size?: number; className?: string }) {
  const Icon = iconForJob(job)

  return (
    <span className={cn('icon-tile shrink-0', className)} style={{ width: size, height: size, borderRadius: Math.round(size * 0.24) }} aria-hidden="true">
      <Icon size={Math.round(size * 0.5)} stroke={1.7} />
    </span>
  )
}

export function GlyphTile({ icon, size = 40, className }: { icon: React.ReactNode; size?: number; className?: string }) {
  return (
    <span className={cn('icon-tile shrink-0 [&_svg]:size-5', className)} style={{ width: size, height: size, borderRadius: Math.round(size * 0.24) }} aria-hidden="true">
      {icon}
    </span>
  )
}

const cleanPrompt = (prompt: string | undefined): string => (prompt ?? '').replace(/\s+/g, ' ').trim()

/** First sentence of the prompt, kept short; a neutral fallback when the job has no prompt. */
export function describeJob(job: Pick<CronJob, 'prompt' | 'name'> & { script?: unknown }, max = 96): string {
  const prompt = cleanPrompt(job.prompt)

  if (!prompt) {
    return typeof job.script === 'string' && job.script ? t('automation.describe.script') : t('automation.describe.schedule')
  }

  const sentence = prompt.split(/(?<=[.!?])\s+/)[0] ?? prompt
  const text = sentence.length > max ? `${sentence.slice(0, max - 1).trimEnd()}…` : sentence

  return /[.!?…]$/.test(text) ? text : `${text}.`
}

const GATHER_RULES: readonly { pattern: RegExp; label: MessageKey }[] = [
  { pattern: /calendar|meeting|schedule|agenda|event/i, label: 'automation.gather.calendar' },
  { pattern: /\bmail\b|e-?mail|inbox|message/i, label: 'automation.gather.mail' },
  { pattern: /mission|task|todo|to-do|project/i, label: 'automation.gather.missions' },
  { pattern: /\bfiles?\b|folder|download|document|desktop/i, label: 'automation.gather.files' },
  { pattern: /\bweb\b|search|news|browse|website|internet|headline/i, label: 'automation.gather.web' },
  { pattern: /github|pull request|\bpr\b|repo/i, label: 'automation.gather.github' },
  { pattern: /slack|discord|telegram/i, label: 'automation.gather.chat' },
  { pattern: /weather|forecast/i, label: 'automation.gather.weather' },
  { pattern: /memory|remember|notes/i, label: 'automation.gather.memory' }
]

/** 'Calendar, priority mail and active missions' derived from prompt keywords, else the prompt's opening. */
export function describeGather(job: Pick<CronJob, 'prompt' | 'skills'>): string {
  const prompt = cleanPrompt(job.prompt)
  const labels = GATHER_RULES.filter(rule => rule.pattern.test(prompt)).map(rule => t(rule.label))

  if (labels.length === 0 && job.skills?.length) {
    labels.push(...job.skills.slice(0, 3))
  }

  if (labels.length > 0) {
    const list = joinList(labels)

    return list.charAt(0).toUpperCase() + list.slice(1)
  }

  if (!prompt) {
    return t('automation.gather.none')
  }

  return prompt.length > 90 ? `${prompt.slice(0, 89).trimEnd()}…` : prompt
}

export const isLocalDelivery = (deliver: string | null | undefined): boolean => !deliver || deliver === 'local'

export function describeDeliver(deliver: string | null | undefined, targets: readonly DeliveryTarget[] = []): string {
  if (isLocalDelivery(deliver)) {
    return t('automation.deliver.local')
  }

  const target = targets.find(candidate => candidate.id === deliver)

  return t('automation.deliver.sendTo', { name: target?.name ?? deliver ?? '' })
}

/* ---- Field chrome shared by the editors ------------------------------------------------------ */

export function FieldLabel({ children, htmlFor }: { children: React.ReactNode; htmlFor?: string }) {
  return (
    <label htmlFor={htmlFor} className="text-[12px] font-medium text-fg-2">
      {children}
    </label>
  )
}

export function TextInput({ className, ...props }: React.ComponentProps<'input'>) {
  return <input {...props} className={cn('glass-input h-9 w-full rounded-lg px-3 text-[13px] text-fg outline-none placeholder:text-fg-4', className)} />
}

export function TextArea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return <textarea {...props} className={cn('glass-input w-full resize-y rounded-lg px-3 py-2 text-[13px] leading-relaxed text-fg outline-none placeholder:text-fg-4', className)} />
}

export function SelectInput({ className, children, ...props }: React.ComponentProps<'select'>) {
  return (
    <select {...props} style={{ colorScheme: 'dark' }} className={cn('glass-input h-9 w-full rounded-lg px-2.5 text-[13px] text-fg outline-none', className)}>
      {children}
    </select>
  )
}

export function Hint({ children, className }: { children: React.ReactNode; className?: string }) {
  return <p className={cn('text-[11.5px] leading-snug text-fg-3', className)}>{children}</p>
}
