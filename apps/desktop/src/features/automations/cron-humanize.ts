import { t, type MessageKey } from '../../lib/i18n.ts'
import type { CronJob } from '../../lib/rest.ts'

/*
 * Turns the cron backend's schedule shapes into the short human lines the Automations page shows:
 * 'Weekdays at 8:00', 'Fridays at 16:00', 'Every evening at 18:00', 'Every 6 hours', 'Once on Sep 21 at 09:00'.
 * Everything falls back to the backend's own `schedule_display` when an expression is too exotic. The
 * wording comes from the catalogue (`automation.time.*`), so the same shapes read naturally in French.
 */

const DAY_KEY: readonly MessageKey[] = [
  'automation.day.sunday',
  'automation.day.monday',
  'automation.day.tuesday',
  'automation.day.wednesday',
  'automation.day.thursday',
  'automation.day.friday',
  'automation.day.saturday'
]

const MONTH_KEY: readonly MessageKey[] = [
  'automation.month.jan',
  'automation.month.feb',
  'automation.month.mar',
  'automation.month.apr',
  'automation.month.may',
  'automation.month.jun',
  'automation.month.jul',
  'automation.month.aug',
  'automation.month.sep',
  'automation.month.oct',
  'automation.month.nov',
  'automation.month.dec'
]

const NAMED_DOW: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }

const dayName = (day: number): string => t(DAY_KEY[day] ?? 'automation.day.sunday')
const monthName = (month: number): string => t(MONTH_KEY[month] ?? 'automation.month.jan')

/** 'Fridays' in English, 'les vendredis' in French — the language decides how a repeated weekday reads. */
const dayMany = (day: number): string => t('automation.dayPlural', { day: dayName(day) })

/** ', 2027' when the year is not this one, in the language's own punctuation: ' 2027' in French. */
const yearSuffix = (year: number, current: number): string => (year === current ? '' : t('automation.time.yearSuffix', { year }))

const pad = (n: number): string => String(n).padStart(2, '0')

/** '8:00', '16:05' (24-hour, no leading zero on the hour, like the mockups). */
export function formatClockShort(hour: number, minute: number): string {
  return `${hour}:${pad(minute)}`
}

export function formatTimeOfDay(date: Date): string {
  return formatClockShort(date.getHours(), date.getMinutes())
}

/** Epoch millis from the ISO strings / epoch numbers the cron API mixes. */
export function toMs(value: string | number | null | undefined): number | undefined {
  if (value == null || value === '') {
    return undefined
  }

  if (typeof value === 'number') {
    return value < 1e12 ? value * 1000 : value
  }

  const parsed = Date.parse(value)

  return Number.isNaN(parsed) ? undefined : parsed
}

/** '1st' / '2nd' / '3rd' / '21st' in English, '1er' / '21e' in French. */
const ordinal = (n: number): string => {
  const rem10 = n % 10
  const rem100 = n % 100

  if (rem10 === 1 && rem100 !== 11) {
    return t('automation.ordinal.one', { n })
  }

  if (rem10 === 2 && rem100 !== 12) {
    return t('automation.ordinal.two', { n })
  }

  if (rem10 === 3 && rem100 !== 13) {
    return t('automation.ordinal.few', { n })
  }

  return t('automation.ordinal.other', { n })
}

/** Expand a cron day-of-week field ('1-5', 'MON,WED', '0,6', '7') into sorted day numbers, or undefined when not simple. */
function expandDow(field: string): number[] | undefined {
  const days = new Set<number>()

  for (const part of field.toLowerCase().split(',')) {
    const range = part.split('-')

    if (range.length > 2 || part.includes('/')) {
      return undefined
    }

    const bounds = range.map(token => {
      if (/^\d+$/.test(token)) {
        return Number(token) % 7
      }

      return NAMED_DOW[token.slice(0, 3)]
    })

    if (bounds.some(b => b === undefined || Number.isNaN(b))) {
      return undefined
    }

    const [start, end = start] = bounds as number[]

    if (start <= end) {
      for (let d = start; d <= end; d++) {
        days.add(d)
      }
    } else {
      for (let d = start; d <= 6; d++) {
        days.add(d)
      }

      for (let d = 0; d <= end; d++) {
        days.add(d)
      }
    }
  }

  return [...days].sort((a, b) => a - b)
}

const sameSet = (a: number[], b: number[]): boolean => a.length === b.length && a.every((v, i) => v === b[i])

/** 'files', 'files and the web', 'a, b and c' — one item takes no conjunction. */
export function joinList(items: readonly string[]): string {
  if (items.length === 0) {
    return ''
  }

  if (items.length === 1) {
    return items[0]
  }

  if (items.length === 2) {
    return t('automation.join.two', { first: items[0], second: items[1] })
  }

  return t('automation.join.many', { head: items.slice(0, -1).join(', '), last: items[items.length - 1] })
}

function dailyPrefix(hour: number): string {
  if (hour >= 5 && hour < 12) {
    return t('automation.time.everyMorning')
  }

  if (hour >= 12 && hour < 17) {
    return t('automation.time.everyAfternoon')
  }

  if (hour >= 17 && hour < 22) {
    return t('automation.time.everyEvening')
  }

  return t('automation.time.everyDay')
}

/** 'Every morning at 8:00' / 'Chaque matin à 8:00'. */
const dailyAt = (hour: number, time: string): string => t('automation.time.dailyAt', { period: dailyPrefix(hour), time })

function humanizeInterval(minutes: number): string {
  if (minutes % 1440 === 0) {
    const days = minutes / 1440

    return days === 1 ? t('automation.time.everyDay') : t('automation.time.everyNDays', { days })
  }

  if (minutes % 60 === 0) {
    const hours = minutes / 60

    return hours === 1 ? t('automation.time.everyHour') : t('automation.time.everyNHours', { hours })
  }

  return minutes === 1 ? t('automation.time.everyMinute') : t('automation.time.everyNMinutes', { minutes })
}

/** Humanize a 5+ field cron expression, or undefined when it is not one of the simple shapes. */
export function humanizeCronExpr(expr: string): string | undefined {
  const parts = expr.trim().split(/\s+/)

  if (parts.length < 5) {
    return undefined
  }

  const [minuteField, hourField, domField, monthField, dowField] = parts

  if (monthField !== '*') {
    return undefined
  }

  // Sub-daily cadences: '*/15 * * * *', '0 * * * *', '0 */6 * * *'.
  if (hourField === '*' && domField === '*' && dowField === '*') {
    if (minuteField === '*') {
      return t('automation.time.everyMinute')
    }

    const step = /^\*\/(\d+)$/.exec(minuteField)

    if (step) {
      return humanizeInterval(Number(step[1]))
    }

    if (/^\d+$/.test(minuteField)) {
      return Number(minuteField) === 0 ? t('automation.time.everyHour') : t('automation.time.hourAt', { minutes: pad(Number(minuteField)) })
    }

    return undefined
  }

  const hourStep = /^\*\/(\d+)$/.exec(hourField)

  if (hourStep && domField === '*' && dowField === '*' && /^\d+$/.test(minuteField)) {
    return humanizeInterval(Number(hourStep[1]) * 60)
  }

  if (!/^\d+$/.test(minuteField) || !/^\d+$/.test(hourField)) {
    return undefined
  }

  const time = formatClockShort(Number(hourField), Number(minuteField))

  // Monthly: '0 9 1 * *'.
  if (domField !== '*' && dowField === '*') {
    if (/^\d+$/.test(domField)) {
      return t('automation.time.monthly', { day: ordinal(Number(domField)), time })
    }

    return undefined
  }

  if (domField !== '*') {
    return undefined
  }

  if (dowField === '*') {
    return dailyAt(Number(hourField), time)
  }

  const days = expandDow(dowField)

  if (!days || days.length === 0) {
    return undefined
  }

  if (sameSet(days, [1, 2, 3, 4, 5])) {
    return t('automation.time.weekdays', { time })
  }

  if (sameSet(days, [0, 6])) {
    return t('automation.time.weekends', { time })
  }

  if (days.length === 7) {
    return dailyAt(Number(hourField), time)
  }

  const names = days.map(dayMany)
  const list = joinList(names)

  return t('automation.time.named', { names: capitalize(list), time })
}

/** 'Once on Sep 21 at 09:00' (adds the year when it is not this year). */
export function humanizeOnce(runAt: string | number): string | undefined {
  const ms = toMs(runAt)

  if (ms === undefined) {
    return undefined
  }

  const date = new Date(ms)
  const year = yearSuffix(date.getFullYear(), new Date().getFullYear())

  return t('automation.time.once', { day: date.getDate(), month: monthName(date.getMonth()), year, time: formatTimeOfDay(date) })
}

/** The card's schedule line. Falls back to the backend's display text. */
export function humanizeSchedule(job: Pick<CronJob, 'schedule' | 'schedule_display'>): string {
  const schedule = job.schedule ?? {}
  const fallback = job.schedule_display ?? schedule.display ?? schedule.expr ?? ''
  const kind = schedule.kind ?? (schedule.expr ? 'cron' : schedule.minutes != null ? 'interval' : schedule.run_at ? 'once' : undefined)

  if (kind === 'interval' && typeof schedule.minutes === 'number' && schedule.minutes > 0) {
    return humanizeInterval(schedule.minutes)
  }

  if (kind === 'once' && schedule.run_at) {
    return humanizeOnce(schedule.run_at) ?? fallback
  }

  if (kind === 'cron' && schedule.expr) {
    return humanizeCronExpr(schedule.expr) ?? (fallback && !/^[\d*\/,\-\s]+$/.test(fallback) ? capitalize(fallback) : schedule.expr)
  }

  return capitalize(fallback)
}

/** The schedule string the cron REST accepts, reconstructed from a stored job (for Duplicate / edit prefill). */
export function scheduleToString(job: Pick<CronJob, 'schedule' | 'schedule_display'>): string {
  const schedule = job.schedule ?? {}

  if (schedule.kind === 'cron' && schedule.expr) {
    return schedule.expr
  }

  if (schedule.kind === 'interval' && typeof schedule.minutes === 'number') {
    const minutes = schedule.minutes

    if (minutes > 0 && minutes % 1440 === 0) {
      return `every ${minutes / 1440}d`
    }

    if (minutes > 0 && minutes % 60 === 0) {
      return `every ${minutes / 60}h`
    }

    return `every ${minutes}m`
  }

  if (schedule.kind === 'once' && schedule.run_at) {
    const ms = toMs(schedule.run_at)

    if (ms !== undefined) {
      const d = new Date(ms)

      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
    }
  }

  return job.schedule_display ?? schedule.display ?? schedule.expr ?? ''
}

const startOfDay = (date: Date): number => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()

/** 'Today, 8:00' / 'Tomorrow, 8:00' / 'Monday, 8:00' / 'Sep 21, 9:00'. */
export function formatRunMoment(ms: number, now: Date = new Date()): string {
  const date = new Date(ms)
  const dayDelta = Math.round((startOfDay(date) - startOfDay(now)) / 86_400_000)
  const time = formatTimeOfDay(date)

  if (dayDelta === 0) {
    return t('automation.time.today', { time })
  }

  if (dayDelta === 1) {
    return t('automation.time.tomorrow', { time })
  }

  if (dayDelta === -1) {
    return t('automation.time.yesterday', { time })
  }

  if (dayDelta > 1 && dayDelta < 7) {
    return t('automation.time.weekday', { weekday: capitalize(dayName(date.getDay())), time })
  }

  const year = yearSuffix(date.getFullYear(), now.getFullYear())

  return t('automation.time.date', { day: date.getDate(), month: monthName(date.getMonth()), year, time })
}

/** The third card line: 'Next run: Monday, 8:00', or 'Paused' / 'Completed' when there is no next run. */
export function formatNextRun(job: Pick<CronJob, 'next_run_at' | 'state' | 'enabled'>): string {
  if (job.state === 'paused' || job.enabled === false) {
    return t('automation.paused')
  }

  if (job.state === 'completed') {
    return t('automation.completed')
  }

  if (job.state === 'error') {
    return t('automation.needsAttention')
  }

  const ms = toMs(job.next_run_at)

  return ms === undefined ? t('automation.time.notScheduled') : t('automation.time.nextRun', { time: formatRunMoment(ms) })
}

/** 'Sep 17, 2024 8:00' for run history rows. */
export function formatRunTimestamp(ms: number): string {
  const date = new Date(ms)

  return t('automation.runTimestamp', { day: date.getDate(), month: monthName(date.getMonth()), year: date.getFullYear(), time: formatTimeOfDay(date) })
}

/** '42 seconds', '1 minute 12 seconds', '2 hours 5 minutes'. */
export function formatRunDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))

  if (total < 60) {
    return total === 1 ? t('automation.duration.second', { count: total }) : t('automation.duration.seconds', { count: total })
  }

  const minutes = Math.floor(total / 60)
  const rest = total % 60

  if (minutes < 60) {
    const m = minutes === 1 ? t('automation.duration.minute', { count: minutes }) : t('automation.duration.minutes', { count: minutes })

    return rest
      ? t('automation.duration.pair', {
          head: m,
          tail: rest === 1 ? t('automation.duration.second', { count: rest }) : t('automation.duration.seconds', { count: rest })
        })
      : m
  }

  const hours = Math.floor(minutes / 60)
  const restMinutes = minutes % 60
  const h = hours === 1 ? t('automation.duration.hour', { count: hours }) : t('automation.duration.hours', { count: hours })

  return restMinutes
    ? t('automation.duration.pair', {
        head: h,
        tail: restMinutes === 1 ? t('automation.duration.minute', { count: restMinutes }) : t('automation.duration.minutes', { count: restMinutes })
      })
    : h
}

/** 'Sydney' from 'Australia/Sydney'; 'UTC' when the zone is unknown. */
export function localTimezoneCity(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC'
    const city = zone.split('/').pop() ?? zone

    return city.replace(/_/g, ' ')
  } catch {
    return 'UTC'
  }
}

/*
 * The formats the backend accepts, shown as helper text next to schedule inputs. These are literal
 * strings a person types, not prose, so they stay the same in both languages.
 */
export const SCHEDULE_FORMATS_HINT =
  "'every 30m', 'every 6h', 'weekdays at 8:00', 'every monday 9am', 'daily at 7am', a cron expression ('0 9 * * 1-5') or a timestamp ('2026-02-03T14:00')"

function capitalize(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text
}
