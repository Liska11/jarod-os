/*
 * Jarod's own settings (`get-jarod-settings` / `set-jarod-settings` / `get-jarod-options`): the data side of the Agent & security section. The engine validates
 * every write and asks for a native confirmation when a change gives the agent more power or sends data elsewhere; the checks here only answer quickly.
 */

import { dateLocale, t, type MessageKey } from '../../../lib/i18n.ts'

export type Decision = 'allow' | 'ask' | 'deny'

export interface PermissionRule {
  tool: string
  decision: Decision
  /** Cockpit, lot 2: the rule only covers this target (a path, an app, an address; `*` = anything). */
  target?: string
  /** Cockpit, lot 2: a temporary rule stops applying at this instant (ms). */
  expiresAt?: number
  /** Configurable autonomy: with `allow`, no approval is asked inside the rule's scope (set by `jarod permissions add auto`). */
  autonomous?: true
  /** The rule only covers this operation (a tool's `mode`, `sql`…), this conversation, this many more calls. */
  operation?: string
  session?: string
  uses?: number
  id?: string
  note?: string
  createdAt?: number
  by?: 'réglages' | 'commande'
}

/** How a rule is named: its tool, and its target when it has one. Two rules never share a name. */
export const ruleKey = (rule: PermissionRule): string =>
  [rule.tool.trim(), rule.target && `→ ${rule.target}`, rule.operation && `[${rule.operation}]`, rule.session && `@${rule.session}`].filter(Boolean).join(' ')

/** A rule with another decision; "no approval" only exists with `allow`, so it is dropped otherwise (the engine refuses the pair). */
export function withDecision(rule: PermissionRule, decision: Decision): PermissionRule {
  const { autonomous, ...rest } = rule

  return decision === 'allow' && autonomous ? { ...rest, decision, autonomous } : { ...rest, decision }
}

/** The durations offered for a new rule; `0` = permanent. */
export const RULE_DURATIONS: readonly { hours: number; label: MessageKey }[] = [
  { hours: 0, label: 'settings.agent.duration.permanent' },
  { hours: 1, label: 'settings.agent.duration.hour' },
  { hours: 8, label: 'settings.agent.duration.hours8' },
  { hours: 24 * 7, label: 'settings.agent.duration.week' }
]

/** A target is optional; when given, short and without control characters (the engine checks again). */
export function ruleTargetProblem(target: string): string | null {
  const v = target.trim()

  if (!v) {
    return null
  }

  // eslint-disable-next-line no-control-regex
  return v.length > 260 || /[\u0000-\u001f]/.test(v) ? t('validate.ruleTarget') : null
}

/** "until 14:30" for a temporary rule, "expired" once it has passed, null for a permanent one. */
export function ruleExpiryText(rule: PermissionRule, now: number = Date.now()): string | null {
  if (rule.expiresAt === undefined) {
    return null
  }

  if (rule.expiresAt <= now) {
    return t('settings.agent.rule.expired')
  }

  const when = new Date(rule.expiresAt).toLocaleString(dateLocale(), { weekday: 'short', hour: '2-digit', minute: '2-digit' })

  return t('settings.agent.rule.until', { when })
}

/*
 * Rules are written by the engine's permissions service (`permissions-plan` / `permissions-apply`), the one `jarod permissions` uses: same
 * checks, same ids, same native confirmation for what gives the agent more power, and the list re-read just before writing.
 */

/** What a rule decides, as the screen offers it: "auto" is allow without approval. */
export type RuleKind = Decision | 'auto'

export const kindOf = (rule: PermissionRule): RuleKind => (rule.decision === 'allow' && rule.autonomous ? 'auto' : rule.decision)

export const RULE_KIND_LABEL: Record<RuleKind, MessageKey> = { allow: 'settings.decision.allow', auto: 'settings.agent.decision.auto', ask: 'settings.decision.ask', deny: 'settings.decision.deny' }

/** The durations offered in the rule form; `0` = permanent, `-1` = keep the current end (editing only). */
export const RULE_FORM_DURATIONS: readonly { hours: number; label: MessageKey }[] = [
  ...RULE_DURATIONS,
  { hours: 24 * 30, label: 'settings.agent.duration.month' }
]

export interface RuleForm {
  tool: string
  kind: RuleKind
  target: string
  operation: string
  session: string
  hours: number
  uses: string
  note: string
  /** Accept "no approval" with no bound at all (the engine refuses it otherwise). */
  broad: boolean
}

export const EMPTY_RULE_FORM: RuleForm = { tool: '', kind: 'ask', target: '', operation: '', session: '', hours: 0, uses: '', note: '', broad: false }

/** The form for an existing rule; its end is kept unless another duration is chosen. */
export function formOf(rule: PermissionRule): RuleForm {
  return {
    tool: rule.tool,
    kind: kindOf(rule),
    target: rule.target ?? '',
    operation: rule.operation ?? '',
    session: rule.session ?? '',
    hours: rule.expiresAt === undefined ? 0 : -1,
    uses: rule.uses === undefined ? '' : String(rule.uses),
    note: rule.note ?? '',
    broad: false
  }
}

export function ruleFormProblem(form: RuleForm): string | null {
  const tool = ruleToolProblem(form.tool) ?? ruleTargetProblem(form.target)

  if (tool) {
    return tool
  }

  if (form.operation.trim() && !/^[A-Za-z0-9_.*:-]+$/.test(form.operation.trim())) {
    return t('validate.ruleOperation')
  }

  if (form.session.trim() && !/^[A-Za-z0-9_-]+$/.test(form.session.trim())) {
    return t('validate.ruleSession')
  }

  if (form.uses.trim()) {
    if (!/^\d{1,6}$/.test(form.uses.trim())) {
      return t('validate.ruleUses')
    }

    if (form.kind === 'ask' || form.kind === 'deny') {
      return t('validate.ruleUsesAllowOnly')
    }
  }

  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u001f]/.test(form.note) ? t('validate.ruleTarget') : null
}

/** The actions of the engine's permissions service (`permissions-plan` / `permissions-apply`). */
export type PermissionsAction =
  | { op: 'grant'; input: Record<string, unknown> }
  | { op: 'update'; ref: string; change: Record<string, unknown> }
  | { op: 'move'; ref: string; to: number }
  | { op: 'revoke'; ref: string }

/** How a rule is named to the service: its id, or its position (1 = first) for an old rule written without one. */
export const ruleRef = (rule: PermissionRule, index: number): string => rule.id ?? String(index + 1)

const kindFields = (kind: RuleKind) => ({ decision: kind === 'auto' ? 'allow' : kind, autonomous: kind === 'auto' })

export function grantAction(form: RuleForm): PermissionsAction {
  const v = (s: string) => s.trim() || undefined

  return {
    op: 'grant',
    input: {
      tool: form.tool.trim(),
      ...kindFields(form.kind),
      ...(v(form.target) ? { target: v(form.target) } : {}),
      ...(v(form.operation) ? { operation: v(form.operation) } : {}),
      ...(v(form.session) ? { session: v(form.session) } : {}),
      ...(form.hours > 0 ? { durationMs: form.hours * 3_600_000 } : {}),
      ...(v(form.uses) ? { uses: Number(form.uses.trim()) } : {}),
      ...(v(form.note) ? { note: v(form.note) } : {}),
      ...(form.broad ? { broad: true } : {})
    }
  }
}

/** Only what the form changes; an emptied field removes that bound (`null`). */
export function updateAction(ref: string, rule: PermissionRule, form: RuleForm): Extract<PermissionsAction, { op: 'update' }> {
  const change: Record<string, unknown> = {}
  const field = (key: 'target' | 'operation' | 'session' | 'note', value: string) => {
    const next = value.trim()

    if (next !== (rule[key] ?? '')) {
      change[key] = next || null
    }
  }

  if (form.kind !== kindOf(rule)) {
    Object.assign(change, kindFields(form.kind))
  }

  field('target', form.target)
  field('operation', form.operation)
  field('session', form.session)
  field('note', form.note)

  const uses = form.uses.trim() ? Number(form.uses.trim()) : undefined

  if (uses !== rule.uses) {
    change.uses = uses ?? null
  }

  if (form.hours === 0 && rule.expiresAt !== undefined) {
    change.durationMs = null
  } else if (form.hours > 0) {
    change.durationMs = form.hours * 3_600_000
  }

  if (form.broad) {
    change.broad = true
  }

  return { op: 'update', ref, change }
}

/** A rule that no longer applies: past its end, or with no use left. */
export function ruleSpentText(rule: PermissionRule, now: number = Date.now()): string | null {
  if (rule.expiresAt !== undefined && rule.expiresAt <= now) {
    return t('settings.agent.rule.expired')
  }

  return rule.uses !== undefined && rule.uses <= 0 ? t('settings.agent.rule.spent') : null
}

export interface ShellGuard {
  writeScope: 'off' | 'workspace'
  writableRoots: string[]
  readRoots: string[]
  allowedPrograms: string[]
  deniedPrograms: string[]
  askPrograms: string[]
  environment: 'local' | 'docker'
  docker: { image: string; network: boolean; memory: string; cpus: number }
}

export interface ConnectedBrowserSettings {
  enabled: boolean
  allowDomains: string[]
  denyDomains: string[]
}

export interface FallbackEntry {
  provider: string
  model?: string
}

export interface JarodSettings {
  autoApproveTools: boolean
  alwaysAllowTools: string[]
  disabledSkills: string[]
  agentMode: 'build' | 'plan'
  maxAgentSteps: number
  compactThreshold: number
  memoryInject: boolean
  browserVisible: boolean
  browserPersistent: boolean
  autoTitle: boolean
  anthropicFallbacks: boolean
  toolSearch: 'auto' | 'on' | 'off'
  sessionBudget: { maxTokens: number; maxCostUsd: number }
  permissionsRules: PermissionRule[]
  shellGuard: ShellGuard
  connectedBrowser: ConnectedBrowserSettings
  rag: { enabled: boolean; embeddingsUrl: string; embeddingsModel: string; chunkSize: number; chunkOverlap: number; maxChunksPerDoc: number; topK: number }
  mobile: { port: number }
  /** Approval requests also offered to the paired phone app; the first answer wins. */
  phoneApprovals: boolean
  /** Cockpit, lot 4: the billion-context history compression proxy (loopback only), for the named providers. */
  contextProxy: { enabled: boolean; url: string; providers: string[] }
  android: { timeoutMs: number }
  apiServer: { port: number; host: '127.0.0.1' | '0.0.0.0' }
  fallbacks: FallbackEntry[]
  imageDescription: { mode: 'auto' | 'always' | 'off'; provider: string; model: string }
  learning: { enabled: boolean; reviewEvery: number }
  voice: { sttProvider: string; sttModel: string; ttsVoice: string; ttsRate: number }
}

export interface JarodOptions {
  providers: { id: string; name: string; local: boolean; configured: boolean; models: string[] }[]
  shells: { path: string; name: string }[]
  shellGuardText: string
}

// ---- validation (mirrors the engine) ---------------------------------------------------------

const num = (value: number): string => value.toLocaleString(dateLocale() ?? 'en-US')

/** Why a whole number is refused, or null. `zeroOff`: 0 is allowed and means "off". */
export function intProblem(text: string, min: number, max: number, zeroOff = false): string | null {
  const value = text.trim()

  if (!/^-?\d+$/.test(value)) {
    return t('validate.int')
  }

  const n = Number(value)

  if (zeroOff && n === 0) {
    return null
  }

  return n >= min && n <= max ? null : t(zeroOff ? 'validate.intRangeOff' : 'validate.intRange', { min: num(min), max: num(max) })
}

/** A dollar amount: 0 (no limit) up to a million, at most four decimals. */
export function moneyProblem(text: string): string | null {
  const value = text.trim()

  if (!/^\d+(\.\d{1,4})?$/.test(value)) {
    return t('validate.money')
  }

  return Number(value) <= 1_000_000 ? null : t('validate.moneyMax')
}

/** A permission rule's tool: a tool name, a family segment or `*`. */
export function ruleToolProblem(tool: string): string | null {
  const value = tool.trim()

  if (!value || value.length > 64) {
    return t('validate.tool')
  }

  return /^[A-Za-z0-9_./*-]+$/.test(value) ? null : t('validate.toolChars')
}

/** A program the shell guard names: a bare name or an absolute path, nothing a shell would interpret. */
export function programProblem(program: string): string | null {
  const p = program.trim()

  if (!p || p.length > 260) {
    return t('validate.program')
  }

  return /^[^\s"'`;&|<>*?$%(){}[\]^!]+$/.test(p) ? null : t('validate.programChars')
}

/** A tools folder the confined command may read and run (never write): an absolute path, no `..`, no wildcard (the guard checks the real folder on every command). */
export function readRootProblem(root: string): string | null {
  const r = root.trim()

  if (!r || r.length > 260) {
    return t('validate.readRoot')
  }

  if (!/^([a-zA-Z]:[\\/]|\\\\|\/)/.test(r)) {
    return t('validate.readRootAbsolute')
  }

  // biome-ignore lint/suspicious/noControlCharactersInRegex: intended, rejects input that contains control characters
  if (/(^|[\\/])\.\.([\\/]|$)/.test(r) || /[*?<>|"\u0000-\u001f]/.test(r)) {
    return t('validate.readRootChars')
  }

  return null
}

/** A domain for the connected browser: a full lowercase domain, no wildcard, port, path or IP address (mirrors the engine). */
export function domainProblem(domain: string): string | null {
  const d = domain.trim().toLowerCase()

  if (!d || d.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(d)) {
    return t('validate.domain')
  }

  return /^\d+$/.test(d.slice(d.lastIndexOf('.') + 1)) ? t('validate.domainIp') : null
}

/** A writable folder: relative to the work folder, no `..`, no drive. */
export function rootProblem(root: string): string | null {
  const r = root.trim()

  if (!r || r.length > 200) {
    return t('validate.root')
  }

  return /^([a-zA-Z]:|[\\/])/.test(r) || /(^|[\\/])\.\.([\\/]|$)/.test(r) ? t('validate.rootRelative') : null
}

/** Rules apply in order and a tool appears once. */
export function ruleListProblem(rules: readonly PermissionRule[]): string | null {
  const seen = new Set<string>()

  for (const rule of rules) {
    const tool = ruleKey(rule)

    if (seen.has(tool)) {
      return t('validate.ruleTwice', { tool })
    }

    seen.add(tool)
  }

  return rules.length > 200 ? t('validate.rulesMax') : null
}

export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  if (from < 0 || from >= items.length || to < 0 || to >= items.length || from === to) {
    return [...items]
  }

  const next = [...items]
  const [item] = next.splice(from, 1)

  next.splice(to, 0, item as T)

  return next
}

// ---- engine messages -------------------------------------------------------------------------

/** "[oneai] réglage « x » : …" and transport prefixes dropped: what is left is the sentence for the user. */
export function settingErrorText(message: string): string {
  return message.replace(/^.*?\[oneai\]\s*/, '').replace(/^(set-jarod-settings|coffre)\s*:\s*/, '')
}

/** The user pressed Cancel on the native confirmation: not an error worth a red banner. */
export function isUserRefusal(message: string): boolean {
  return /refusé par l.utilisateur/i.test(message)
}

/** Each decision's name in the catalogue. */
export const DECISION_LABEL: Record<Decision, MessageKey> = { allow: 'settings.decision.allow', ask: 'settings.decision.ask', deny: 'settings.decision.deny' }

/** Each tool-search mode's name in the catalogue. */
export const TOOL_SEARCH_LABEL: Record<JarodSettings['toolSearch'], MessageKey> = { auto: 'settings.toolSearch.auto', on: 'settings.toolSearch.on', off: 'settings.toolSearch.off' }
