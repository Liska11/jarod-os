/**
 * V-03 — une seule vue pour les quatre journaux d'audit de Jarod-OS. Chacun garde son format et son écrivain ; cette vue ne fait que LIRE et
 * ramener chaque ligne à une forme commune, puis les range par date, la plus récente d'abord :
 *  - `agent`      : le journal du noyau (SQLite, flux `audit`, contrat c7) — chaque appel d'outil de l'agent passé par la porte unique ;
 *  - `bridge`     : `audit.jsonl` du pont système Python (contrat c3-bridge) — chaque action système demandée par l'agent ;
 *  - `control`    : `control-audit.jsonl` (contrat c3-control), écrit par le canal de contrôle du shell ET par l'hôte Rust — chaque tentative ;
 *  - `mcp-server` : `mcp-server.log` de `jarod mcp` — chaque appel d'un client MCP externe (noms d'outils et tailles, jamais de contenu).
 * Les valeurs sont déjà masquées à l'écriture par chaque écrivain ; rien ici ne les démasque. Une ligne illisible est comptée, pas inventée.
 * Les lignes du pont et du contrôle d'une même tentative portent le même `requestId` : la vue le montre pour les rapprocher.
 */

import { decisionKind, isRefusal } from '../../hermes/audit-timeline.ts'

export type AuditSource = 'agent' | 'bridge' | 'control' | 'mcp-server'

export const AUDIT_SOURCES: readonly AuditSource[] = ['agent', 'bridge', 'control', 'mcp-server']

/** Ce que la ligne dit de l'issue : exécuté, refusé (par la personne, une règle ou le contrôle), échoué, ou décision seule (pas encore d'issue). */
export type AuditOutcome = 'ok' | 'refused' | 'failed' | 'decided'

export interface UnifiedAuditLine {
  /** Millisecondes depuis l'époque Unix. */
  at: number
  source: AuditSource
  /** L'outil ou la commande. */
  tool: string
  outcome: AuditOutcome
  /** La décision telle que l'écrivain l'a notée (« accordé », `denied`, `approval-granted`…). */
  decision: string
  /** Le palier, dans le vocabulaire de sa source (`sensible`, `mutate`…) ; null s'il n'est pas noté. */
  tier: string | null
  /** Le complément lisible : cible, résumé, raison, erreur ou tailles. Déjà masqué à la source. */
  detail: string
  sessionId?: string
  requestId?: string
  /** Catégories d'injection repérées dans le résultat (V-04, mode observation ; agent seulement). */
  injection?: string[]
}

/** Ce que la vue reçoit : les lignes de l'agent déjà décodées par le noyau, et les trois fichiers en lignes brutes. */
export interface AuditSourcesRaw {
  agent: ReadonlyArray<Record<string, unknown>>
  mcpServer: readonly string[]
  bridge: readonly string[]
  control: readonly string[]
}

export interface UnifiedAudit {
  lines: UnifiedAuditLine[]
  /** Lignes ignorées parce qu'illisibles (coupées par une rotation, par exemple), par source. */
  unreadable: Record<AuditSource, number>
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '')

const iso = (value: unknown): number | null => {
  const at = typeof value === 'string' ? Date.parse(value) : Number.NaN

  return Number.isFinite(at) ? at : null
}

function fromAgent(raw: Record<string, unknown>): UnifiedAuditLine | null {
  const at = typeof raw.at === 'number' && Number.isFinite(raw.at) ? raw.at : null
  const tool = str(raw.tool)
  const decision = str(raw.decision)

  if (at === null || !tool || !decision) {
    return null
  }

  // Même lecture que la timeline sous chaque tour (V-02) : « sans accord » est une lecture qui n'en demandait pas, pas un refus.
  const outcome: AuditOutcome = isRefusal(decisionKind(decision)) ? 'refused' : raw.ok === false ? 'failed' : raw.ok === true ? 'ok' : 'decided'
  const injection = Array.isArray(raw.injection) ? raw.injection.filter((c): c is string => typeof c === 'string') : []

  return {
    at,
    source: 'agent',
    tool,
    outcome,
    decision,
    tier: str(raw.tier) || null,
    detail: str(raw.target) || str(raw.args),
    ...(str(raw.sessionId) ? { sessionId: str(raw.sessionId) } : {}),
    ...(str(raw.callId) ? { requestId: str(raw.callId) } : {}),
    ...(injection.length ? { injection } : {})
  }
}

function fromBridge(raw: Record<string, unknown>): UnifiedAuditLine | null {
  const at = iso(raw.ts)
  const tool = str(raw.tool)

  if (at === null || !tool) {
    return null
  }

  const decision = str(raw.decision)
  const refused = decision === 'denied' || decision.startsWith('refus') || decision.startsWith('block')
  const outcome: AuditOutcome = refused ? 'refused' : raw.ok === true ? 'ok' : 'failed'
  const action = str(raw.action)

  return {
    at,
    source: 'bridge',
    tool: action ? `${tool}.${action}` : tool,
    outcome,
    decision,
    tier: str(raw.tier) || null,
    detail: str(raw.error) || str(raw.summary),
    ...(str(raw.requestId) ? { requestId: str(raw.requestId) } : {})
  }
}

function fromControl(raw: Record<string, unknown>): UnifiedAuditLine | null {
  const at = iso(raw.at)
  // `cmd` vide est une ligne valide : la tentative d'une requête illisible, refusée — à montrer, pas à taire.
  const cmd = str(raw.cmd) || '(requête illisible)'

  if (at === null || typeof raw.cmd !== 'string' || typeof raw.allowed !== 'boolean') {
    return null
  }

  const command = str(raw.command)
  const surface = str(raw.surface)
  const who = [str(raw.client), surface === 'backend' ? 'rust' : surface].filter(Boolean).join(' · ')

  return {
    at,
    source: 'control',
    tool: command ? `${cmd} ${command}` : cmd,
    outcome: raw.allowed ? 'ok' : 'refused',
    decision: str(raw.code) || (raw.allowed ? 'allowed' : 'refused'),
    tier: str(raw.tier) || null,
    detail: [who, str(raw.reason)].filter(Boolean).join(' — '),
    ...(str(raw.requestId) ? { requestId: str(raw.requestId) } : {})
  }
}

/** `2026-10-23T10:00:00.000Z memory_search args=12o résultat=345o ok` (cli/src/mcp-server.ts, `fileAudit`). */
const MCP_LINE = /^(\S+) (\S+) args=(\d+)o résultat=(\d+)o (ok|erreur)$/

function fromMcpServer(line: string): UnifiedAuditLine | null {
  const m = MCP_LINE.exec(line.trim())
  const at = m ? iso(m[1]) : null

  if (!m || at === null) {
    return null
  }

  return {
    at,
    source: 'mcp-server',
    tool: m[2]!,
    outcome: m[5] === 'ok' ? 'ok' : 'failed',
    decision: m[5]!,
    tier: 'read',
    detail: `args ${m[3]} o, résultat ${m[4]} o`
  }
}

function parseJsonLine(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line)

    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** Les quatre journaux en une liste, la plus récente d'abord, bornée à `limit` lignes. */
export function unifyAudit(raw: AuditSourcesRaw, limit = 500): UnifiedAudit {
  const unreadable: Record<AuditSource, number> = { agent: 0, bridge: 0, control: 0, 'mcp-server': 0 }
  const lines: UnifiedAuditLine[] = []
  const keep = (source: AuditSource, line: UnifiedAuditLine | null) => (line ? lines.push(line) : unreadable[source]++)

  for (const entry of raw.agent) {
    keep('agent', fromAgent(entry))
  }

  for (const text of raw.bridge.filter(l => l.trim())) {
    const parsed = parseJsonLine(text)
    keep('bridge', parsed ? fromBridge(parsed) : null)
  }

  for (const text of raw.control.filter(l => l.trim())) {
    const parsed = parseJsonLine(text)
    keep('control', parsed ? fromControl(parsed) : null)
  }

  for (const text of raw.mcpServer.filter(l => l.trim())) {
    keep('mcp-server', fromMcpServer(text))
  }

  // Tri stable : à la même milliseconde, l'ordre d'écriture de chaque source est conservé.
  lines.sort((a, b) => b.at - a.at)

  return { lines: lines.slice(0, Math.max(0, limit)), unreadable }
}

/** Le filtre de la vue : les sources cochées, les issues retenues, et un texte cherché dans l'outil, le détail et les identifiants. */
export function filterAudit(lines: readonly UnifiedAuditLine[], filter: { sources?: ReadonlySet<AuditSource>; outcomes?: ReadonlySet<AuditOutcome>; text?: string }): UnifiedAuditLine[] {
  const needle = filter.text?.trim().toLowerCase() ?? ''

  return lines.filter(
    line =>
      (!filter.sources || filter.sources.has(line.source)) &&
      (!filter.outcomes || filter.outcomes.has(line.outcome)) &&
      (!needle || [line.tool, line.detail, line.decision, line.sessionId ?? '', line.requestId ?? ''].some(v => v.toLowerCase().includes(needle)))
  )
}
