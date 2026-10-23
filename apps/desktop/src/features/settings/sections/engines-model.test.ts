import { describe, expect, it } from 'vitest'
import type { EngineEvent } from '../../../../shared/engines.ts'
import { applyEngineEvent, openApproval, stateTone, type TranscriptEntry, turnRunning } from './engines-model.ts'

const ev = (type: EngineEvent['type'], payload: Record<string, unknown> = {}): EngineEvent => ({ engine: 'dsh', sessionId: 's', type, payload })
const play = (start: TranscriptEntry[], ...events: EngineEvent[]) => events.reduce(applyEngineEvent, start)

describe('applyEngineEvent', () => {
  it('assemble la réponse, la clôt avec son stopReason, et dit quand le tour est fini', () => {
    const entries = play([{ kind: 'user', text: 'Bonjour' }], ev('message.delta', { text: 'JAROD_' }), ev('message.delta', { text: 'DSH_OK' }))
    expect(turnRunning(entries)).toBe(true)
    const done = applyEngineEvent(entries, ev('message.complete', { stopReason: 'end_turn' }))
    expect(done.at(-1)).toEqual({
      kind: 'assistant',
      text: 'JAROD_DSH_OK',
      done: true,
      stopReason: 'end_turn'
    })
    expect(turnRunning(done)).toBe(false)
  })

  it('un tour annulé sans texte se voit tout de même, comme une erreur ferme le tour', () => {
    expect(play([{ kind: 'user', text: 'x' }], ev('message.complete', { stopReason: 'cancelled' })).at(-1)).toMatchObject({ kind: 'assistant', stopReason: 'cancelled' })
    expect(turnRunning(play([{ kind: 'user', text: 'x' }], ev('error', { message: 'No API key' })))).toBe(false)
  })

  it('suit un outil jusqu’à son état final', () => {
    const entries = play(
      [],
      ev('tool.start', {
        toolCallId: 'c1',
        title: 'pwsh',
        status: 'in_progress'
      }),
      ev('tool.complete', {
        toolCallId: 'c1',
        status: 'failed',
        text: 'refusé'
      })
    )
    expect(entries).toEqual([
      {
        kind: 'tool',
        toolCallId: 'c1',
        title: 'pwsh',
        status: 'failed',
        text: 'refusé'
      }
    ])
  })

  it('présente une demande d’accord tant qu’elle est ouverte, avec la commande', () => {
    const asked = play(
      [],
      ev('approval.request', {
        requestId: 'dsh-1',
        title: 'pwsh',
        input: { command: 'Set-Content x' },
        options: [{ optionId: 'a', kind: 'allow_once', name: 'A' }]
      })
    )
    expect(openApproval(asked)).toMatchObject({
      requestId: 'dsh-1',
      input: { command: 'Set-Content x' }
    })
    const answered = applyEngineEvent(asked, ev('approval.resolved', { requestId: 'dsh-1', decision: 'deny' }))
    expect(openApproval(answered)).toBeUndefined()
  })

  it('une réponse automatique (règle) s’inscrit dans le fil : jamais silencieuse', () => {
    const entries = play(
      [],
      ev('approval.resolved', {
        title: 'pwsh',
        decision: 'deny',
        automatic: true
      })
    )
    expect(entries).toEqual([
      {
        kind: 'approval',
        requestId: '',
        title: 'pwsh',
        input: {},
        options: [],
        decision: 'deny',
        automatic: true
      }
    ])
    expect(openApproval(entries)).toBeUndefined()
  })
})

describe('stateTone', () => {
  it('ne montre « ok » que pour connecté', () => {
    expect(stateTone('connected')).toBe('ok')
    expect(stateTone('detected')).not.toBe('ok')
    expect(stateTone('failed')).toBe('danger')
  })
})
