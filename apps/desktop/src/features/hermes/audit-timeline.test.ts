import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../../lib/chat-model.ts'
import { type AuditLine, decisionKind, formatDuration, isRefusal, linesForTurn, toolIdsOf, turnSummary } from './audit-timeline.ts'

const tool = (toolId: string, ts: number): ChatMessage => ({ id: `t-${toolId}`, role: 'tool', toolId, name: 'read_file', running: false, ts })
const line = (at: number, callId?: string, decision = 'sans accord'): AuditLine => ({ sessionId: 's', tool: 'read_file', args: '{}', decision, at, ...(callId ? { callId } : {}) })

describe('linesForTurn', () => {
  const first = { items: [tool('c1', 100)], start: 90, end: 200 }
  const second = { items: [tool('c2', 250)], start: 200, end: Number.POSITIVE_INFINITY }
  const shown = toolIdsOf([...first.items, ...second.items])

  it('puts a line with the call id of a shown tool under that tool’s turn, whatever its time', () => {
    const late = line(5_000, 'c1')

    expect(linesForTurn([late], first, shown)).toEqual([late])
    expect(linesForTurn([late], second, shown)).toEqual([])
  })

  it('places a line without a call id, or with an id the conversation does not show, by time', () => {
    const older = line(150)
    const unknown = line(210, 'c-refused-early')

    expect(linesForTurn([older, unknown], first, shown)).toEqual([older])
    expect(linesForTurn([older, unknown], second, shown)).toEqual([unknown])
  })
})

describe('decisions', () => {
  it('maps every literal of the contract, and only refusals are refusals', () => {
    expect(['accordé', 'refusé', 'automatique', 'bloqué (mode Plan)', 'refusé (règle)', 'autorisé (règle)', 'sans accord', 'annulé', 'refusé (invalide)'].map(decisionKind)).not.toContain('other')
    expect(decisionKind('inventé')).toBe('other')
    expect(['refusé', 'refusé (règle)', 'bloqué (mode Plan)', 'refusé (invalide)'].every(d => isRefusal(decisionKind(d)))).toBe(true)
    expect(['accordé', 'automatique', 'autorisé (règle)', 'sans accord', 'annulé'].some(d => isRefusal(decisionKind(d)))).toBe(false)
  })
})

describe('formatDuration', () => {
  it('reads in ms, s, then minutes', () => {
    expect(formatDuration(850)).toBe('850 ms')
    expect(formatDuration(1830)).toBe('1.8 s')
    expect(formatDuration(125_000)).toBe('2 min 05 s')
  })
})

describe('turnSummary (V-08)', () => {
  const at = (tool: string, decision: string, extra: Partial<AuditLine> = {}): AuditLine => ({ sessionId: 's', tool, args: '{}', decision, at: 1, ...extra })

  it('fichiers distincts écrits, commandes lancées, refus, échecs, durée totale ; l’appel qui retrouve le tour', () => {
    const s = turnSummary([
      at('read_file', 'sans accord', { durationMs: 10 }),
      at('write_file', 'accordé', { callId: 'w1', target: 'a.txt', ok: true, durationMs: 100 }),
      at('edit_file', 'automatique', { callId: 'w2', target: 'a.txt', ok: true, durationMs: 50 }),
      at('write_file', 'accordé', { callId: 'w3', target: 'b.txt', ok: false }),
      at('write_file', 'refusé', { callId: 'w4', target: 'c.txt' }),
      at('run_shell', 'accordé', { callId: 'r1', ok: true, durationMs: 840 }),
      at('run_shell', 'annulé', { callId: 'r2' })
    ])

    expect(s).toEqual({ calls: 7, refused: 1, failed: 1, files: 1, commands: 1, durationMs: 1000, diffCallId: 'w1' })
  })

  it('rien d’écrit : aucun appel pour les changements', () => {
    expect(turnSummary([at('read_file', 'sans accord')])).toMatchObject({ files: 0, diffCallId: null })
  })
})
