import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { filterAudit, unifyAudit } from './audit-view-model.ts'

// Les lignes VALIDES des contrats gelés : la vue doit lire chacune, sans en perdre une.
const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../../contracts/v1/fixtures')

function valid(contract: string): Record<string, unknown>[] {
  const dir = path.join(FIXTURES, contract)

  return fs
    .readdirSync(dir)
    .filter(name => name.startsWith('valid-'))
    .map(name => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as Record<string, unknown>)
}

const empty = { agent: [], mcpServer: [], bridge: [], control: [] }

describe('V-03 — une vue pour les quatre journaux', () => {
  it('lit chaque ligne valide des trois contrats (c7, c3-bridge, c3-control) et du journal MCP, sans ligne illisible', () => {
    const agent = valid('c7-tool-audit-entry').map((entry, i) => ({ ...entry, at: 1_000 + i }))
    const bridge = valid('c3-bridge-audit-entry').map(entry => JSON.stringify(entry))
    const control = valid('c3-control-audit-entry').map(entry => JSON.stringify(entry))
    const mcpServer = ['2026-10-23T10:00:00.000Z memory_search args=12o résultat=345o ok', '2026-10-23T10:00:01.000Z sessions_list args=2o résultat=0o erreur']

    const view = unifyAudit({ agent, bridge, control, mcpServer })

    expect(view.unreadable).toEqual({ agent: 0, bridge: 0, control: 0, 'mcp-server': 0 })
    expect(view.lines).toHaveLength(agent.length + bridge.length + control.length + mcpServer.length)
    expect(new Set(view.lines.map(l => l.source))).toEqual(new Set(['agent', 'bridge', 'control', 'mcp-server']))
  })

  it('range toutes les sources par date, la plus récente d’abord, et borne la liste', () => {
    const view = unifyAudit({
      agent: [{ sessionId: 's', tool: 'read_file', args: '{}', decision: 'automatique', ok: true, at: Date.parse('2026-10-23T10:00:02Z') }],
      bridge: [JSON.stringify({ ts: '2026-10-23T12:00:03+02:00', tool: 'system_info', tier: 'read', action: null, decision: 'allowed', ok: true, summary: null, error: null, requestId: null, args: {} })],
      control: [JSON.stringify({ at: '2026-10-23T10:00:01Z', client: 'cli', cmd: 'wallpaper', allowed: false, reason: 'no token' })],
      mcpServer: ['2026-10-23T10:00:04.000Z memory_search args=1o résultat=2o ok']
    })

    expect(view.lines.map(l => l.source)).toEqual(['mcp-server', 'bridge', 'agent', 'control'])
    expect(unifyAudit({ ...empty, mcpServer: ['2026-10-23T10:00:04.000Z a args=1o résultat=2o ok', '2026-10-23T10:00:05.000Z b args=1o résultat=2o ok'] }, 1).lines.map(l => l.tool)).toEqual(['b'])
  })

  it('l’issue se lit pareil partout : refusé, échoué, exécuté, ou décision seule', () => {
    const at = 1
    const agent = unifyAudit({
      ...empty,
      agent: [
        { sessionId: 's', tool: 'a', args: '{}', decision: 'refusé (règle)', at },
        { sessionId: 's', tool: 'b', args: '{}', decision: 'accordé', ok: false, at },
        { sessionId: 's', tool: 'c', args: '{}', decision: 'accordé', ok: true, at },
        { sessionId: 's', tool: 'd', args: '{}', decision: 'accordé', at },
        // « sans accord » : une lecture qui n'en demandait pas (V-02), jamais un refus — trouvé par l'e2e sur l'application construite.
        { sessionId: 's', tool: 'e', args: '{}', decision: 'sans accord', ok: true, at },
        { sessionId: 's', tool: 'f', args: '{}', decision: 'bloqué (mode Plan)', at }
      ]
    })
    expect(agent.lines.map(l => [l.tool, l.outcome])).toEqual([
      ['a', 'refused'],
      ['b', 'failed'],
      ['c', 'ok'],
      ['d', 'decided'],
      ['e', 'ok'],
      ['f', 'refused']
    ])

    const bridge = unifyAudit({ ...empty, bridge: valid('c3-bridge-audit-entry').map(entry => JSON.stringify(entry)) })
    expect(bridge.lines.find(l => l.tool === 'system_kill_process.kill')).toMatchObject({ outcome: 'refused', decision: 'denied' })

    const control = unifyAudit({ ...empty, control: valid('c3-control-audit-entry').map(entry => JSON.stringify(entry)) })
    expect(control.lines.filter(l => l.outcome === 'refused').length).toBeGreaterThan(0)
    expect(control.lines.find(l => l.decision === 'approval-granted')).toMatchObject({ outcome: 'ok', requestId: 'br-0123456789ab', tool: 'ui page.open' })
  })

  it('garde ce qui relie et ce qui alerte : conversation, requestId commun pont/contrôle, catégories d’injection', () => {
    const [withInjection] = valid('c7-tool-audit-entry').filter(entry => Array.isArray(entry.injection))
    const view = unifyAudit({ ...empty, agent: [{ ...withInjection, at: 1 }] })

    expect(view.lines[0]!.injection).toEqual(withInjection!.injection)
    expect(view.lines[0]!.sessionId).toBe(withInjection!.sessionId)
  })

  it('une ligne coupée ou étrangère est comptée comme illisible, jamais inventée', () => {
    const view = unifyAudit({
      agent: [{ tool: 'x' }],
      bridge: ['{"ts":"2026-10-23T10:00', '[1,2]'],
      control: ['{"at":"pas une date","cmd":"x","allowed":true}'],
      mcpServer: ['bruit sans format', '']
    })

    expect(view.lines).toEqual([])
    expect(view.unreadable).toEqual({ agent: 1, bridge: 2, control: 1, 'mcp-server': 1 })
  })

  it('filtre par source, par issue et par texte (outil, détail, identifiants)', () => {
    const { lines } = unifyAudit({
      ...empty,
      agent: [{ sessionId: 'conv-1', tool: 'run_shell', args: '{}', target: 'git status', decision: 'accordé', ok: true, at: 2 }],
      control: [JSON.stringify({ at: '2026-10-23T10:00:01Z', client: 'cli', cmd: 'wallpaper', allowed: false, reason: 'no token' })]
    })

    expect(filterAudit(lines, { sources: new Set(['control']) }).map(l => l.tool)).toEqual(['wallpaper'])
    expect(filterAudit(lines, { outcomes: new Set(['refused']) }).map(l => l.tool)).toEqual(['wallpaper'])
    expect(filterAudit(lines, { text: 'GIT STATUS' }).map(l => l.tool)).toEqual(['run_shell'])
    expect(filterAudit(lines, { text: 'conv-1' })).toHaveLength(1)
    expect(filterAudit(lines, {})).toHaveLength(2)
  })
})
