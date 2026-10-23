import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { AcpConnection } from './acp-client.ts'
import { approvalOptions, permissionOutcome, translateSessionUpdate, turnEnded } from './acp-translate.ts'

/** Les deux bouts d'un tuyau : ce que Jarod écrit (`toAgent`) et ce que l'agent répond (`fromAgent`). */
function pipePair() {
  const toAgent = new PassThrough()
  const fromAgent = new PassThrough()
  const written: Array<Record<string, unknown>> = []
  toAgent.setEncoding('utf8')
  toAgent.on('data', (chunk: string) => {
    for (const line of chunk.split('\n').filter(Boolean)) {
      written.push(JSON.parse(line))
    }
  })

  return {
    conn: new AcpConnection(fromAgent, toAgent, 1000),
    written,
    reply: (message: object) => fromAgent.write(`${JSON.stringify(message)}\n`),
    fromAgent
  }
}

const tick = () => new Promise(resolve => setTimeout(resolve, 5))

describe('AcpConnection', () => {
  it('associe une réponse à sa requête et rejette une erreur JSON-RPC', async () => {
    const { conn, written, reply } = pipePair()
    const ok = conn.request<{ protocolVersion: number }>('initialize', {
      protocolVersion: 1
    })
    const bad = conn.request('session/prompt', { sessionId: 'x' })
    await tick()
    expect(written.map(m => m.method)).toEqual(['initialize', 'session/prompt'])
    reply({
      jsonrpc: '2.0',
      id: written[1].id,
      error: { code: -32602, message: 'unknown session' }
    })
    reply({
      jsonrpc: '2.0',
      id: written[0].id,
      result: { protocolVersion: 1 }
    })
    await expect(ok).resolves.toEqual({ protocolVersion: 1 })
    await expect(bad).rejects.toThrow(/unknown session/)
  })

  it('ignore une ligne qui n’est pas du protocole, sans casser la suite', async () => {
    const { conn, written, reply, fromAgent } = pipePair()
    const pending = conn.request('session/new', {})
    await tick()
    fromAgent.write('[plugin] bonjour sur stdout\n')
    reply({ jsonrpc: '2.0', id: written[0].id, result: { sessionId: 's1' } })
    await expect(pending).resolves.toEqual({ sessionId: 's1' })
    expect(conn.strayLines).toBe(1)
  })

  it('répond aux questions de l’agent par le gestionnaire, ou -32601 sans gestionnaire', async () => {
    const { conn, written, reply } = pipePair()
    reply({ jsonrpc: '2.0', id: 7, method: 'fs/read_text_file', params: {} })
    await tick()
    expect(written[0]).toMatchObject({ id: 7, error: { code: -32601 } })
    conn.onRequest(async () => ({ outcome: { outcome: 'cancelled' } }))
    reply({
      jsonrpc: '2.0',
      id: 8,
      method: 'session/request_permission',
      params: {}
    })
    await tick()
    expect(written[1]).toMatchObject({
      id: 8,
      result: { outcome: { outcome: 'cancelled' } }
    })
  })

  it('rejette ce qui attend quand l’agent ferme sa sortie, et toute requête ensuite', async () => {
    const { conn, fromAgent } = pipePair()
    const pending = conn.request('session/prompt', {})
    fromAgent.end()
    await expect(pending).rejects.toThrow(/fermé/)
    await expect(conn.request('session/new', {})).rejects.toThrow(/fermée/)
  })

  it('abandonne une requête sans réponse au bout du délai', async () => {
    const { conn } = pipePair()
    await expect(conn.request('initialize', {}, 20)).rejects.toThrow(/pas de réponse/)
  })
})

describe('translateSessionUpdate', () => {
  const update = (u: object) => translateSessionUpdate('dsh', { sessionId: 's', update: u })

  it('traduit messages, pensées, outils et usage dans le vocabulaire du shell', () => {
    expect(
      update({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Bonjour' }
      })
    ).toEqual({
      engine: 'dsh',
      sessionId: 's',
      type: 'message.delta',
      payload: { text: 'Bonjour' }
    })
    expect(
      update({
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'hmm' }
      })?.type
    ).toBe('thinking.delta')
    expect(
      update({
        sessionUpdate: 'tool_call',
        toolCallId: 'c1',
        title: 'pwsh',
        kind: 'execute',
        status: 'in_progress',
        rawInput: { command: 'ls', timeoutMs: 5 }
      })?.payload
    ).toEqual({
      toolCallId: 'c1',
      title: 'pwsh',
      kind: 'execute',
      status: 'in_progress',
      input: { command: 'ls' }
    })
    expect(
      update({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'c1',
        status: 'failed',
        content: [{ type: 'content', content: { type: 'text', text: 'refusé' } }]
      })
    ).toMatchObject({
      type: 'tool.complete',
      payload: { status: 'failed', text: 'refusé' }
    })
    expect(
      update({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'c1',
        status: 'in_progress'
      })?.type
    ).toBe('tool.update')
    expect(update({ sessionUpdate: 'usage_update', used: 1200, size: 128000 })?.payload).toEqual({ used: 1200, size: 128000 })
  })

  it('ne fabrique rien pour une mise à jour inconnue, vide ou sans session', () => {
    expect(update({ sessionUpdate: 'config_option_update' })).toBeNull()
    expect(
      update({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'image', data: 'x' }
      })
    ).toBeNull()
    expect(
      translateSessionUpdate('dsh', {
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'x' }
        }
      })
    ).toBeNull()
  })

  it('termine un tour avec le stopReason du moteur', () => {
    expect(turnEnded('dsh', 's', { stopReason: 'cancelled' }).payload).toEqual({
      stopReason: 'cancelled'
    })
    expect(turnEnded('dsh', 's', {}).payload).toEqual({
      stopReason: 'end_turn'
    })
  })
})

describe('permissionOutcome', () => {
  const options = approvalOptions({
    options: [
      { optionId: 'allow-once', kind: 'allow_once', name: 'Allow once' },
      { optionId: 'always', kind: 'allow_always', name: 'Always' },
      { optionId: 'reject-once', kind: 'reject_once', name: 'Reject' },
      { bogus: true }
    ]
  })

  it('choisit l’option du bon genre, jamais « toujours »', () => {
    expect(options).toHaveLength(3)
    expect(permissionOutcome(options, 'allow')).toEqual({
      outcome: { outcome: 'selected', optionId: 'allow-once' }
    })
    expect(permissionOutcome(options, 'deny')).toEqual({
      outcome: { outcome: 'selected', optionId: 'reject-once' }
    })
    expect(permissionOutcome(options, 'allow', 'always')).toEqual({
      outcome: { outcome: 'selected', optionId: 'allow-once' }
    })
    expect(permissionOutcome(options, 'deny', 'allow-once')).toEqual({
      outcome: { outcome: 'selected', optionId: 'reject-once' }
    })
  })

  it('annule quand le choix voulu n’existe pas ou que la demande est retirée', () => {
    expect(permissionOutcome([{ optionId: 'r', kind: 'reject_once', name: 'r' }], 'allow')).toEqual({ outcome: { outcome: 'cancelled' } })
    expect(permissionOutcome(options, 'cancel')).toEqual({
      outcome: { outcome: 'cancelled' }
    })
  })
})
