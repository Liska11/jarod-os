/*
 * Automation rules and user plugins: the data side of the section. Mirrors `automation-*` and `plugins-list`.
 * A rule is a trigger (a cron schedule, a webhook, or a manual button) and one or more actions (ask the agent, show a notification, call a web address).
 */

export type Trigger = { kind: 'schedule'; cron: string } | { kind: 'webhook'; hookId: string } | { kind: 'manual' }

export type Action =
  | { type: 'agent'; prompt: string; sessionId?: string; mode?: 'plan' | 'build' }
  | { type: 'notify'; title: string; body: string }
  | { type: 'webhook'; url: string; payload: unknown }

export interface Rule {
  id: string
  name: string
  enabled: boolean
  trigger: Trigger
  actions: Action[]
  createdAt: number
  updatedAt: number
}

export interface Plugin {
  id: string
  name: string
  version: string
  description: string
  author: string
  enabled: boolean
  state: 'active' | 'disabled' | 'error'
  error: string
  tools: string[]
  trusted: string[]
  permissions: string[]
  digest: string
}

export type ActionDraft =
  | { type: 'agent'; prompt: string; mode: 'plan' | 'build' }
  | { type: 'notify'; title: string; body: string }
  | { type: 'webhook'; url: string; payload: string }

export interface RuleDraft {
  name: string
  trigger: 'schedule' | 'webhook' | 'manual'
  cron: string
  hookId: string
  actions: ActionDraft[]
}

export const emptyAction = (type: ActionDraft['type']): ActionDraft => (type === 'agent' ? { type, prompt: '', mode: 'plan' } : type === 'notify' ? { type, title: '', body: '' } : { type, url: '', payload: '{}' })

export const emptyRule = (): RuleDraft => ({ name: '', trigger: 'schedule', cron: '0 9 * * *', hookId: '', actions: [emptyAction('agent')] })

const CRON_FIELD = /^(\*|\d+)(-\d+)?(\/\d+)?(,(\*|\d+)(-\d+)?(\/\d+)?)*$|^\*\/\d+$/

/** A five-field cron expression (minute hour day month weekday); the engine computes the next run and has the final word. */
export function cronProblem(text: string): string | null {
  const fields = text.trim().split(/\s+/)

  if (fields.length !== 5) {
    return 'Five fields: minute hour day-of-month month weekday, like 0 9 * * 1-5.'
  }

  const limits = [59, 23, 31, 12, 7]
  const bad = fields.findIndex((field, i) => !CRON_FIELD.test(field) || (field.match(/\d+/g) ?? []).some(n => Number(n) > limits[i]!))

  return bad < 0 ? null : `Field ${bad + 1} (“${fields[bad]}”) is not valid.`
}

export function draftProblems(draft: RuleDraft): string[] {
  const out: string[] = []

  if (!draft.name.trim()) {
    out.push('Name: required.')
  }

  if (draft.trigger === 'schedule') {
    const problem = cronProblem(draft.cron)

    if (problem) {
      out.push(`Schedule: ${problem}`)
    }
  } else if (draft.trigger === 'webhook' && !/^[A-Za-z0-9_-]{1,64}$/.test(draft.hookId.trim())) {
    out.push('Webhook name: letters, digits, _ and - (64 at most).')
  }

  if (draft.actions.length === 0) {
    out.push('Add at least one action.')
  }

  draft.actions.forEach((action, i) => {
    const n = draft.actions.length > 1 ? ` ${i + 1}` : ''

    if (action.type === 'agent' && !action.prompt.trim()) {
      out.push(`Action${n}: say what the agent should do.`)
    } else if (action.type === 'notify' && !action.title.trim()) {
      out.push(`Action${n}: the notification needs a title.`)
    } else if (action.type === 'webhook') {
      if (!/^https?:\/\//i.test(action.url.trim())) {
        out.push(`Action${n}: the address must start with http:// or https://.`)
      }

      try {
        JSON.parse(action.payload || 'null')
      } catch {
        out.push(`Action${n}: the payload is not valid JSON.`)
      }
    }
  })

  return out
}

export function inputOf(draft: RuleDraft): { name: string; trigger: Trigger; actions: Action[]; enabled: boolean } {
  const trigger: Trigger = draft.trigger === 'schedule' ? { kind: 'schedule', cron: draft.cron.trim().split(/\s+/).join(' ') } : draft.trigger === 'webhook' ? { kind: 'webhook', hookId: draft.hookId.trim() } : { kind: 'manual' }

  return {
    name: draft.name.trim(),
    enabled: true,
    trigger,
    actions: draft.actions.map((action): Action => (action.type === 'agent' ? { type: 'agent', prompt: action.prompt.trim(), mode: action.mode } : action.type === 'notify' ? { type: 'notify', title: action.title.trim(), body: action.body.trim() } : { type: 'webhook', url: action.url.trim(), payload: JSON.parse(action.payload || 'null') as unknown }))
  }
}

export function triggerText(trigger: Trigger): string {
  return trigger.kind === 'schedule' ? `on schedule ${trigger.cron}` : trigger.kind === 'webhook' ? `when webhook “${trigger.hookId}” is called` : 'by hand only'
}

export function actionText(action: Action): string {
  switch (action.type) {
    case 'agent':
      return `ask the agent${action.mode === 'build' ? ' (can change things)' : ' (read-only)'}: ${action.prompt.length > 60 ? `${action.prompt.slice(0, 59)}…` : action.prompt}`
    case 'notify':
      return `notify “${action.title}”`
    default:
      return `call ${action.url}`
  }
}

export function ruleSummary(rule: Rule): string {
  return `${triggerText(rule.trigger)} → ${rule.actions.map(actionText).join('; ')}`
}

/** Plugins run code in their own process; say what state they are in and what they may touch. */
export function pluginSummary(plugin: Plugin): string {
  const parts = [`v${plugin.version}`, plugin.author, plugin.state === 'error' ? `error: ${plugin.error}` : null, plugin.tools.length ? `${plugin.tools.length} tool${plugin.tools.length === 1 ? '' : 's'}` : null, plugin.permissions.length ? `asks for ${plugin.permissions.join(', ')}` : 'asks for no permission'].filter(Boolean)

  return parts.join(' · ')
}

export function untrustedTools(plugin: Plugin): string[] {
  return plugin.tools.filter(tool => !plugin.trusted.includes(tool))
}
