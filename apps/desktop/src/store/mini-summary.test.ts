import { describe, expect, it } from 'vitest'
import type { ChatState } from '../lib/chat-model.ts'
import { computeMiniSummary } from './mini-summary.ts'

const chat = (title: string, streaming: boolean, status?: string) => ({ title, streaming, ...(status ? { status: { kind: 'tool', text: status } } : {}) }) as unknown as ChatState
const pending = (kind: string, params: Record<string, unknown>) => ({ kind, request: { id: Math.random().toString(), params }, receivedAt: 0 }) as never

describe('le résumé de la mini-fenêtre', () => {
  it('les conversations qui répondent, les demandes en attente (la plus ancienne d’abord), les sous-agents en cours', () => {
    const s = computeMiniSummary(
      { a: chat('Rapport', true, 'lit des fichiers'), b: chat('Ancienne', false), c: chat('', true) },
      [pending('approval', { description: 'Déplacer 12 fichiers', command: 'rm -rf /' }), pending('clarify', { question: 'Quel dossier ?' })],
      { x: { status: 'running' } as never, y: { status: 'complete' } as never }
    )

    expect(s.working).toEqual([
      { title: 'Rapport', status: 'lit des fichiers' },
      { title: 'Conversation', status: '' }
    ])
    expect(s.workingCount).toBe(2)
    expect(s.waiting).toEqual([
      { kind: 'approval', text: 'Déplacer 12 fichiers' },
      { kind: 'clarify', text: 'Quel dossier ?' }
    ])
    expect(s.waitingCount).toBe(2)
    expect(s.agents).toBe(1)
  })

  it('rien d’une demande de secret ou de mot de passe ; les textes longs sont coupés', () => {
    const s = computeMiniSummary({}, [pending('secret', { prompt: 'Votre jeton', env_var: 'GITHUB_TOKEN' }), pending('approval', { description: 'y'.repeat(300) })], {})

    expect(s.waiting[0]).toEqual({ kind: 'secret', text: '' })
    expect(s.waiting[1]!.text.length).toBe(100)
    expect(s.waiting[1]!.text.endsWith('…')).toBe(true)
  })
})
