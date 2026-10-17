/*
 * Jarod's own settings (`get-jarod-settings` / `set-jarod-settings` / `get-jarod-options`): the data side of the Agent & security section. The engine validates
 * every write and asks for a native confirmation when a change gives the agent more power or sends data elsewhere; the checks here only answer quickly.
 */

import { dateLocale, t, type MessageKey } from '../../../lib/i18n.ts'

export type Decision = 'allow' | 'ask' | 'deny'

export interface PermissionRule {
  tool: string
  decision: Decision
}

export interface ShellGuard {
  writeScope: 'off' | 'workspace'
  writableRoots: string[]
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
    const tool = rule.tool.trim()

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
