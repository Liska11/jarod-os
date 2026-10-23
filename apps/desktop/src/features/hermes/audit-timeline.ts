import type { ChatMessage } from '../../lib/chat-model.ts'

/*
 * V-02 — the audited timeline under each turn. The core writes one audit line per tool call that reaches its gate (reads included), and serves a
 * conversation's lines on `audit-session`. This file only decides which lines belong to which turn and how a decision reads; it fetches nothing.
 */

/** One audit line as the core serves it (`AuditEntry` plus the time it was written). Arguments and target are already masked by the core. */
export interface AuditLine {
  sessionId: string
  tool: string
  args: string
  decision: string
  ok?: boolean
  callId?: string
  tier?: 'sensible' | 'audité' | 'ordinaire'
  target?: string
  durationMs?: number
  proof?: 'verified' | 'failed' | 'unverifiable'
  at: number
}

export type DecisionKind = 'granted' | 'refused' | 'automatic' | 'plan' | 'ruleRefused' | 'ruleAllowed' | 'free' | 'cancelled' | 'invalid' | 'other'

/** The core's decisions are French literals (contract c7-tool-audit-entry); the window shows them in its own language. */
const KINDS: Record<string, DecisionKind> = {
  accordé: 'granted',
  refusé: 'refused',
  automatique: 'automatic',
  'bloqué (mode Plan)': 'plan',
  'refusé (règle)': 'ruleRefused',
  'autorisé (règle)': 'ruleAllowed',
  'sans accord': 'free',
  annulé: 'cancelled',
  'refusé (invalide)': 'invalid'
}

export const decisionKind = (decision: string): DecisionKind => KINDS[decision] ?? 'other'

/** A call that never ran: refused by the person, a rule, plan mode, or for being invalid. */
export const isRefusal = (kind: DecisionKind): boolean => kind === 'refused' || kind === 'ruleRefused' || kind === 'plan' || kind === 'invalid'

export interface TurnWindow {
  items: ChatMessage[]
  start: number
  end: number
}

/** Every tool-call id the conversation shows, all turns together. */
export function toolIdsOf(messages: ChatMessage[]): Set<string> {
  return new Set(messages.flatMap(m => (m.role === 'tool' ? [m.toolId] : [])))
}

/**
 * The lines of one turn. A line whose call the conversation shows goes with that call's turn; a line without a call id, or whose call the
 * conversation does not show (an older line, a call refused before the window heard of it), goes by time: from this turn's prompt to the next.
 */
export function linesForTurn(lines: AuditLine[], turn: TurnWindow, shownIds: Set<string>): AuditLine[] {
  const ids = toolIdsOf(turn.items)

  return lines.filter(line => (line.callId && shownIds.has(line.callId) ? ids.has(line.callId) : line.at >= turn.start && line.at < turn.end))
}

/** `850 ms`, `1.8 s`, `2 min 05 s`. */
export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${Math.max(0, Math.round(ms))} ms`
  }

  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(1)} s`
  }

  const s = Math.round(ms / 1000)

  return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`
}
