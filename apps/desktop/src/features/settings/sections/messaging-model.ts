import { t, type MessageKey } from '../../../lib/i18n.ts'

/*
 * Messaging channels (Telegram, Discord, Slack, e-mail, WhatsApp): the data side of the section. Mirrors `get-messaging-platforms` and its update/test channels.
 * A secret goes in and never comes back: the engine reports only whether a field is set.
 */

export interface MessagingEnvVar {
  key: string
  description: string
  prompt: string
  is_password: boolean
  is_set: boolean
  required: boolean
  advanced: boolean
  url: string | null
  redacted_value: string | null
}

export interface MessagingPlatform {
  id: string
  name: string
  description: string
  docs_url: string
  enabled: boolean
  configured: boolean
  gateway_running: boolean
  state?: string | null
  error_message?: string | null
  env_vars: MessagingEnvVar[]
}

export interface MessagingPlatforms {
  editable: boolean
  message?: string
  platforms: MessagingPlatform[]
}

export interface MessagingUpdate {
  env?: Record<string, string>
  clear_env?: string[]
  enabled?: boolean
}

export type Tone = 'ok' | 'warn' | 'danger' | 'muted' | 'info'

const STATE_KEY: Record<string, { label: MessageKey; tone: Tone }> = {
  connected: { label: 'messaging.state.connected', tone: 'ok' },
  configured: { label: 'messaging.state.configured', tone: 'info' },
  gateway_stopped: { label: 'messaging.state.gatewayStopped', tone: 'warn' },
  not_configured: { label: 'messaging.state.notConfigured', tone: 'warn' },
  disabled: { label: 'messaging.state.disabled', tone: 'muted' },
  error: { label: 'messaging.state.error', tone: 'danger' }
}

export function stateOf(platform: Pick<MessagingPlatform, 'state' | 'enabled'>): { label: string; tone: Tone } {
  const state = platform.state ?? (platform.enabled ? 'configured' : 'disabled')
  const known = STATE_KEY[state]

  return known ? { label: t(known.label), tone: known.tone } : { label: state.replace(/_/g, ' '), tone: 'muted' }
}

/** The fields to show first: required ones, then the others; advanced ones only on request. */
export function visibleVars(vars: readonly MessagingEnvVar[], showAdvanced: boolean): MessagingEnvVar[] {
  return vars.filter(v => showAdvanced || !v.advanced || v.required).sort((a, b) => Number(b.required) - Number(a.required))
}

/**
 * What the form sends: a typed value is written; a field the user chose to clear is cleared; everything else is left alone (an empty box next to a saved
 * secret means "keep it", not "erase it").
 */
export function updateFromDraft(draft: Readonly<Record<string, string>>, cleared: readonly string[]): MessagingUpdate | null {
  const env: Record<string, string> = {}

  for (const [key, value] of Object.entries(draft)) {
    const trimmed = value.trim()

    if (trimmed && !cleared.includes(key)) {
      env[key] = trimmed
    }
  }

  const clear_env = [...cleared]

  if (Object.keys(env).length === 0 && clear_env.length === 0) {
    return null
  }

  return { ...(Object.keys(env).length ? { env } : {}), ...(clear_env.length ? { clear_env } : {}) }
}

/** A token pasted with spaces, quotes or a line break is a copy mistake: say so before the engine does. */
export function fieldProblem(variable: MessagingEnvVar, value: string): string | null {
  const v = value.trim()

  if (!v) {
    return null
  }

  if (variable.is_password && (/[\s"'`]/.test(v) || /[^\x21-\x7e]/.test(v))) {
    return t('messaging.field.around')
  }

  if (v.length > 2000) {
    return t('messaging.field.tooLong')
  }

  return null
}

/** Cannot be switched on before it is configured; say what is missing. */
export function missingFields(platform: MessagingPlatform): string[] {
  return platform.env_vars.filter(v => v.required && !v.is_set).map(v => v.prompt || v.key)
}
