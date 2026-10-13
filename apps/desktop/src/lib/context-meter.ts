import type { Usage } from '@herald-os/client'
import { t } from './i18n.ts'

/*
 * What the context gauge under the composer says. The core reports how many tokens the next call will occupy
 * (`context_used`) and, when it knows the model's window, the window (`context_max`).
 */

export type ContextTone = 'unknown' | 'ok' | 'warn' | 'danger'

export interface ContextView {
  /** Short text beside the bar: "8.2k / 16.4k", "8.2k tokens" or "Context". */
  label: string
  /** 0..100, or null when the window is unknown. */
  percent: number | null
  tone: ContextTone
  /** The sentence for the tooltip. */
  title: string
  /** Worth compacting now (the window is nearly full). */
  full: boolean
}

/** 950 -> "950", 8200 -> "8.2k", 16384 -> "16.4k". */
export function tokenCount(n: number): string {
  return n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(Math.round(n))
}

export function contextView(usage: Usage | null | undefined): ContextView {
  const used = typeof usage?.context_used === 'number' ? usage.context_used : null
  const max = typeof usage?.context_max === 'number' && usage.context_max > 0 ? usage.context_max : null

  if (used === null) {
    return { label: t('context.label'), percent: null, tone: 'unknown', title: t('context.unknown'), full: false }
  }

  const estimated = usage?.context_estimated ? ' (estimated)' : ''
  const compressions = usage?.compressions ? ` Compacted ${usage.compressions} time${usage.compressions === 1 ? '' : 's'}.` : ''

  if (max === null) {
    return { label: `${tokenCount(used)} tokens`, percent: null, tone: 'unknown', title: `About ${used.toLocaleString('en-US')} tokens in context${estimated}. The model's window is not known.${compressions}`, full: false }
  }

  const percent = Math.min(100, Math.round((used / max) * 1000) / 10)
  const tone: ContextTone = percent >= 90 ? 'danger' : percent >= 70 ? 'warn' : 'ok'

  return {
    label: `${tokenCount(used)} / ${tokenCount(max)}`,
    percent,
    tone,
    title: `${used.toLocaleString('en-US')} of ${max.toLocaleString('en-US')} tokens in context (${Math.round(percent)}%)${estimated}.${compressions}`,
    full: percent >= 80
  }
}
