/*
 * Jarod's own settings (`get-jarod-settings` / `set-jarod-settings` / `get-jarod-options`): the data side of the Agent & security section. The engine validates
 * every write and asks for a native confirmation when a change gives the agent more power or sends data elsewhere; the checks here only answer quickly.
 */

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
  rag: { enabled: boolean; embeddingsUrl: string; embeddingsModel: string; chunkSize: number; chunkOverlap: number; maxChunksPerDoc: number; topK: number }
  mobile: { port: number }
  android: { timeoutMs: number }
  apiServer: { port: number; host: '127.0.0.1' | '0.0.0.0' }
  fallbacks: FallbackEntry[]
  imageDescription: { mode: 'auto' | 'always' | 'off'; provider: string; model: string }
  learning: { enabled: boolean; reviewEvery: number }
}

export interface JarodOptions {
  providers: { id: string; name: string; local: boolean; configured: boolean; models: string[] }[]
  shells: { path: string; name: string }[]
  shellGuardText: string
}

// ---- validation (mirrors the engine) ---------------------------------------------------------

/** Why a whole number is refused, or null. `zeroOff`: 0 is allowed and means "off". */
export function intProblem(text: string, min: number, max: number, zeroOff = false): string | null {
  const t = text.trim()

  if (!/^-?\d+$/.test(t)) {
    return 'Whole number only.'
  }

  const n = Number(t)

  if (zeroOff && n === 0) {
    return null
  }

  return n >= min && n <= max ? null : `Between ${zeroOff ? '0 (off) or ' : ''}${min.toLocaleString('en-US')} and ${max.toLocaleString('en-US')}.`
}

/** A dollar amount: 0 (no limit) up to a million, at most four decimals. */
export function moneyProblem(text: string): string | null {
  const t = text.trim()

  if (!/^\d+(\.\d{1,4})?$/.test(t)) {
    return 'An amount in dollars, like 2.50 (0 = no limit).'
  }

  return Number(t) <= 1_000_000 ? null : 'At most 1,000,000.'
}

/** A permission rule's tool: a tool name, a family segment or `*`. */
export function ruleToolProblem(tool: string): string | null {
  const t = tool.trim()

  if (!t || t.length > 64) {
    return 'A tool name of 1 to 64 characters.'
  }

  return /^[A-Za-z0-9_./*-]+$/.test(t) ? null : 'Letters, digits and . _ / - only (or * for every tool).'
}

/** A program the shell guard names: a bare name or an absolute path, nothing a shell would interpret. */
export function programProblem(program: string): string | null {
  const p = program.trim()

  if (!p || p.length > 260) {
    return 'A program name or path.'
  }

  return /^[^\s"'`;&|<>*?$%(){}[\]^!]+$/.test(p) ? null : 'No space, quote or shell character.'
}

/** A writable folder: relative to the work folder, no `..`, no drive. */
export function rootProblem(root: string): string | null {
  const r = root.trim()

  if (!r || r.length > 200) {
    return 'A folder path.'
  }

  return /^([a-zA-Z]:|[\\/])/.test(r) || /(^|[\\/])\.\.([\\/]|$)/.test(r) ? 'Relative to the work folder: no “..”, no drive, no leading slash.' : null
}

/** Rules apply in order and a tool appears once. */
export function ruleListProblem(rules: readonly PermissionRule[]): string | null {
  const seen = new Set<string>()

  for (const rule of rules) {
    const tool = rule.tool.trim()

    if (seen.has(tool)) {
      return `“${tool}” appears twice.`
    }

    seen.add(tool)
  }

  return rules.length > 200 ? 'At most 200 rules.' : null
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
  return message.replace(/^.*?\[oneai\]\s*/, '').replace(/^set-jarod-settings\s*:\s*/, '')
}

/** The user pressed Cancel on the native confirmation: not an error worth a red banner. */
export function isUserRefusal(message: string): boolean {
  return /refusé par l.utilisateur/i.test(message)
}

export const DECISION_LABEL: Record<Decision, string> = { allow: 'Allow', ask: 'Ask', deny: 'Deny' }

export const TOOL_SEARCH_LABEL: Record<JarodSettings['toolSearch'], string> = { auto: 'Automatic', on: 'Always', off: 'Never (show every tool to the model)' }
