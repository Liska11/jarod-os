import { EventEmitter } from 'node:events'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import type { EngineEvent, EnginePermissionPolicy, EngineState } from '../../shared/engines.ts'
import { DshEngine, type DshSpawnPlan, dshSpawnPlan, resolveDsh } from './dsh.ts'

const BIN = path.join('node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

describe('resolveDsh', () => {
  const pkg = (version: string) => JSON.stringify({ name: '@deepseek-ai/dsh', version })

  it('trouve la CLI sur le PATH, avec le node à côté et la version du paquet, sans l’exécuter', () => {
    // Chemin natif : sous Linux et macOS, « C: » serait coupé par le délimiteur « : » du PATH.
    const dir = path.resolve('tools', 'node')
    const files = new Set([path.join(dir, 'dsh.cmd'), path.join(dir, BIN), path.join(dir, 'node.exe')])
    const found = resolveDsh({
      env: { PATH: dir },
      exists: file => files.has(file),
      readFile: () => pkg('0.2.1-rc.2')
    })
    expect(found).toMatchObject({
      bin: path.join(dir, BIN),
      source: 'path',
      version: '0.2.1-rc.2'
    })
    expect(found?.node).toBe(process.platform === 'win32' ? path.join(dir, 'node.exe') : undefined)
  })

  it('retombe sur le runtime embarqué par DSH NEXT, et la variable d’environnement prime', () => {
    const next = path.join('C:', 'Program Files', 'DSH NEXT', 'resources', 'app', BIN)
    const files = new Set([next, 'C:/custom/bin.js'])
    expect(
      resolveDsh({
        env: { PATH: '', ProgramFiles: path.join('C:', 'Program Files') },
        exists: file => files.has(file),
        readFile: () => pkg('0.2.0-rc.2')
      })
    ).toMatchObject({ source: 'dsh-next', version: '0.2.0-rc.2' })
    expect(
      resolveDsh({
        env: {
          JAROD_OS_DSH_BIN: 'C:/custom/bin.js',
          ProgramFiles: path.join('C:', 'Program Files')
        },
        exists: file => files.has(file),
        readFile: () => pkg('9')
      })?.source
    ).toBe('env')
    expect(resolveDsh({ env: { PATH: '' }, exists: () => false })).toBeNull()
  })
})

describe('dshSpawnPlan', () => {
  const install = { bin: 'C:/dsh/lib/bin.js', source: 'path' as const }

  it('ne transmet aucun jeton de Jarod, aucune clé de fournisseur, aucun secret : seulement le système et DSH_HOME', () => {
    const plan = dshSpawnPlan(install, {
      home: 'C:/jarod/engines/dsh',
      workspace: 'C:/work',
      internet: true,
      env: {
        PATH: 'C:/bin',
        SystemRoot: 'C:/Windows',
        JAROD_GATEWAY_TOKEN: 't',
        JAROD_OS_CONTROL_TOKEN: 'c',
        HERMES_DASHBOARD_SESSION_TOKEN: 'h',
        OPENROUTER_API_KEY: 'k',
        GITHUB_TOKEN: 'g',
        DSH_HOME: 'C:/Users/me/.dsh'
      }
    })
    expect(plan.env).toEqual({
      PATH: 'C:/bin',
      SystemRoot: 'C:/Windows',
      DSH_HOME: 'C:/jarod/engines/dsh',
      NO_COLOR: '1'
    })
    expect(plan.args).toEqual(['C:/dsh/lib/bin.js', '--profile', 'acp'])
    expect(plan.cwd).toBe('C:/work')
  })

  it('ajoute les variables nommées pour le moteur, jamais un jeton interne même nommé', () => {
    const plan = dshSpawnPlan(install, {
      home: 'h',
      workspace: 'w',
      internet: true,
      env: {},
      explicitEnv: {
        DEEPSEEK_API_KEY: 'k',
        JAROD_GATEWAY_TOKEN: 't',
        HERMES_DASHBOARD_SESSION_TOKEN: 'h',
        MY_CONTROL_TOKEN: 'c'
      }
    })
    expect(plan.env).toEqual({
      DEEPSEEK_API_KEY: 'k',
      DSH_HOME: 'h',
      NO_COLOR: '1'
    })
  })

  it('coupe le réseau par un proxy mort quand l’Internet de Jarod est coupé (le bouclage reste direct)', () => {
    const plan = dshSpawnPlan(install, {
      home: 'h',
      workspace: 'w',
      internet: false,
      env: {}
    })
    expect(plan.env).toMatchObject({
      HTTPS_PROXY: 'http://127.0.0.1:9',
      https_proxy: 'http://127.0.0.1:9',
      NO_PROXY: '127.0.0.1,localhost,::1',
      // Sans elle, le fetch de Node (DSH) ignore le proxy et sort quand même.
      NODE_USE_ENV_PROXY: '1'
    })
  })

  it('lance Jarod-OS en mode Node quand aucun node n’accompagne la CLI', () => {
    expect(
      dshSpawnPlan(install, {
        home: 'h',
        workspace: 'w',
        internet: true,
        env: {},
        execPath: 'C:/Jarod-OS.exe'
      })
    ).toMatchObject({
      command: 'C:/Jarod-OS.exe',
      env: { ELECTRON_RUN_AS_NODE: '1' }
    })
    expect(
      dshSpawnPlan(
        { ...install, node: 'C:/n/node.exe' },
        {
          home: 'h',
          workspace: 'w',
          internet: true,
          env: {},
          execPath: 'C:/Jarod-OS.exe'
        }
      ).command
    ).toBe('C:/n/node.exe')
  })
})

/** Un faux `dsh --profile acp` : il lit les requêtes de Jarod et répond selon `agent`. */
function fakeChild(agent: (message: Record<string, unknown>, send: (message: object) => void, child: FakeChild) => void): FakeChild {
  const child = new EventEmitter() as FakeChild
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  Object.assign(child, { pid: 4242, killed: false })
  child.received = []
  const send = (message: object) => child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
  child.stdin.setEncoding('utf8')
  child.stdin.on('data', (chunk: string) => {
    for (const line of chunk.split('\n').filter(Boolean)) {
      const message = JSON.parse(line)
      child.received.push(message)
      agent(message, send, child)
    }
  })
  // Fermer stdin arrête un vrai `dsh` : le faux fait pareil.
  child.stdin.on('finish', () => setTimeout(() => child.emit('exit', 0, null), 1))

  return child
}

type FakeChild = ChildProcess & {
  stdin: PassThrough
  stdout: PassThrough
  stderr: PassThrough
  received: Array<Record<string, unknown>>
}

/** Un agent ACP v1 ordinaire ; `prompt` décide de ce que fait un tour. */
function standardAgent(prompt: (message: Record<string, unknown>, send: (message: object) => void) => void, init: object = { protocolVersion: 1, authMethods: [] }) {
  return (message: Record<string, unknown>, send: (message: object) => void) => {
    if (message.method === 'initialize') send({ id: message.id, result: init })
    if (message.method === 'session/new') send({ id: message.id, result: { sessionId: 'sess-1' } })
    if (message.method === 'session/prompt') prompt(message, send)
  }
}

function engineWith(agent: Parameters<typeof fakeChild>[0], policy: EnginePermissionPolicy = 'ask') {
  const events: EngineEvent[] = []
  const states: EngineState[] = []
  let child: FakeChild | null = null
  const plans: DshSpawnPlan[] = []
  const engine = new DshEngine({
    resolve: () => ({ bin: 'bin.js', source: 'path', version: '0.2.1-rc.2' }),
    home: path.join(os.tmpdir(), 'jarod-dsh-test-home'),
    workspace: path.join(os.tmpdir(), 'jarod-dsh-test-work'),
    policy: () => policy,
    internet: () => true,
    emit: event => events.push(event),
    onState: ({ state }) => states.push(state),
    log: () => undefined,
    spawnProcess: plan => {
      plans.push(plan)
      child = fakeChild(agent)

      return child
    },
    approvalTimeoutMs: 200
  })

  return {
    engine,
    events,
    states,
    plans,
    child: () => child as FakeChild | null
  }
}

const until = async (check: () => boolean, ms = 1000) => {
  const start = Date.now()

  while (!check()) {
    if (Date.now() - start > ms) throw new Error('délai dépassé')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

describe('DshEngine', () => {
  it('se connecte, ouvre une session, relaie la réponse puis la fin de tour', async () => {
    const t = engineWith(
      standardAgent((message, send) => {
        send({
          method: 'session/update',
          params: {
            sessionId: 'sess-1',
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'JAROD_DSH_OK' }
            }
          }
        })
        send({ id: message.id, result: { stopReason: 'end_turn' } })
      })
    )
    expect(await t.engine.start()).toEqual({ ok: true, value: undefined })
    expect(t.states).toEqual(['starting', 'connected'])
    const session = await t.engine.newSession()
    expect(session).toEqual({ ok: true, value: 'sess-1' })
    expect(t.engine.prompt('sess-1', 'Bonjour')).toEqual({
      ok: true,
      value: undefined
    })
    expect(t.engine.prompt('sess-1', 'encore')).toEqual({
      ok: false,
      error: 'turn-in-progress'
    })
    await until(() => t.events.some(e => e.type === 'message.complete'))
    expect(t.events.map(e => [e.type, e.payload])).toEqual([
      ['message.delta', { text: 'JAROD_DSH_OK' }],
      ['message.complete', { stopReason: 'end_turn' }]
    ])
    await t.engine.stop()
    expect(t.states.at(-1)).toBe('stopped')
  })

  it('refuse une version de protocole inconnue, et s’arrête', async () => {
    const t = engineWith(standardAgent(() => undefined, { protocolVersion: 2, authMethods: [] }))
    expect(await t.engine.start()).toEqual({
      ok: false,
      error: 'incompatible-protocol:2'
    })
    expect(t.states.at(-1)).toBe('failed')
    expect(t.child()?.stdin.writableEnded).toBe(true)
  })

  it('ne fait pas semblant de s’authentifier quand le moteur l’exige', async () => {
    const t = engineWith(
      standardAgent(() => undefined, {
        protocolVersion: 1,
        authMethods: [{ id: 'api-key' }]
      })
    )
    expect(await t.engine.start()).toEqual({
      ok: false,
      error: 'auth-required'
    })
    expect(t.child()?.received.map(m => m.method)).not.toContain('authenticate')
  })

  it('« ask » : présente la demande d’accord une fois et rend le choix de la personne au moteur', async () => {
    const t = engineWith(
      standardAgent((message, send) => {
        // Comme DSH : le `tool_call` (nom, arguments) d'abord, puis une demande qui ne porte que son identifiant.
        send({
          method: 'session/update',
          params: {
            sessionId: 'sess-1',
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'call_1',
              title: 'pwsh',
              kind: 'other',
              status: 'in_progress',
              rawInput: {
                command: 'Set-Content x.txt',
                justification: 'test',
                timeoutMs: 5
              }
            }
          }
        })
        send({
          id: 99,
          method: 'session/request_permission',
          params: {
            sessionId: 'sess-1',
            toolCall: { toolCallId: 'call_1' },
            options: [
              { optionId: 'allow-once', kind: 'allow_once', name: 'Allow' },
              { optionId: 'reject-once', kind: 'reject_once', name: 'Reject' }
            ]
          }
        })
        void message
      })
    )
    await t.engine.start()
    t.engine.prompt('sess-1', 'OUTIL')
    await until(() => t.events.some(e => e.type === 'approval.request'))
    const request = t.events.find(e => e.type === 'approval.request')!
    expect(request.payload).toMatchObject({
      toolCallId: 'call_1',
      title: 'pwsh',
      input: { command: 'Set-Content x.txt', justification: 'test' },
      options: [{ kind: 'allow_once' }, { kind: 'reject_once' }]
    })
    expect(t.engine.respondApproval(String(request.payload.requestId), 'deny')).toEqual({ ok: true, value: undefined })
    await until(() => t.child()!.received.some(m => m.id === 99))
    expect(t.child()!.received.find(m => m.id === 99)).toMatchObject({
      result: { outcome: { outcome: 'selected', optionId: 'reject-once' } }
    })
    expect(t.engine.respondApproval(String(request.payload.requestId), 'allow')).toEqual({ ok: false, error: 'unknown-request' })
    await t.engine.stop()
  })

  it('« deny » et « allow » répondent sans demander, en le disant ; jamais « toujours »', async () => {
    for (const [policy, optionId] of [
      ['deny', 'reject-once'],
      ['allow', 'allow-once']
    ] as const) {
      const t = engineWith(
        standardAgent((_message, send) =>
          send({
            id: 50,
            method: 'session/request_permission',
            params: {
              sessionId: 'sess-1',
              options: [
                { optionId: 'always', kind: 'allow_always', name: 'A' },
                { optionId: 'allow-once', kind: 'allow_once', name: 'Allow' },
                {
                  optionId: 'reject-once',
                  kind: 'reject_once',
                  name: 'Reject'
                }
              ]
            }
          })
        ),
        policy
      )
      await t.engine.start()
      t.engine.prompt('sess-1', 'OUTIL')
      await until(() => t.child()!.received.some(m => m.id === 50))
      expect(t.child()!.received.find(m => m.id === 50)).toMatchObject({
        result: { outcome: { optionId } }
      })
      expect(t.events.find(e => e.type === 'approval.resolved')?.payload).toMatchObject({ decision: policy, automatic: true })
      expect(t.events.some(e => e.type === 'approval.request')).toBe(false)
      await t.engine.stop()
    }
  })

  it('une demande sans réponse est retirée au bout du délai (refus fermé)', async () => {
    const t = engineWith(
      standardAgent((_message, send) =>
        send({
          id: 60,
          method: 'session/request_permission',
          params: {
            sessionId: 'sess-1',
            options: [{ optionId: 'allow-once', kind: 'allow_once', name: 'Allow' }]
          }
        })
      )
    )
    await t.engine.start()
    t.engine.prompt('sess-1', 'OUTIL')
    await until(() => t.child()!.received.some(m => m.id === 60), 2000)
    expect(t.child()!.received.find(m => m.id === 60)).toMatchObject({
      result: { outcome: { outcome: 'cancelled' } }
    })
    await t.engine.stop()
  })

  it('annule un tour : notification session/cancel, fin « cancelled », demandes d’accord retirées', async () => {
    let promptId: unknown
    const t = engineWith(
      standardAgent((message, send) => {
        promptId = message.id
        send({
          id: 70,
          method: 'session/request_permission',
          params: {
            sessionId: 'sess-1',
            options: [{ optionId: 'allow-once', kind: 'allow_once', name: 'Allow' }]
          }
        })
      })
    )
    const child = () => t.child()!
    await t.engine.start()
    t.engine.prompt('sess-1', 'LENT')
    await until(() => t.events.some(e => e.type === 'approval.request'))
    expect(t.engine.cancel('sess-1')).toEqual({ ok: true, value: undefined })
    await until(() => child().received.some(m => m.method === 'session/cancel') && child().received.some(m => m.id === 70))
    expect(child().received.find(m => m.id === 70)).toMatchObject({
      result: { outcome: { outcome: 'cancelled' } }
    })
    child().stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'cancelled' } })}\n`)
    await until(() => t.events.some(e => e.type === 'message.complete'))
    expect(t.events.find(e => e.type === 'message.complete')?.payload).toEqual({ stopReason: 'cancelled' })
    await t.engine.stop()
  })

  it('un arrêt inattendu du moteur est un échec visible, et le tour en cours devient une erreur', async () => {
    const t = engineWith(standardAgent(() => undefined))
    await t.engine.start()
    t.engine.prompt('sess-1', 'x')
    t.child()!.emit('exit', 1, null)
    await until(() => t.events.some(e => e.type === 'error'))
    expect(t.states.at(-1)).toBe('failed')
    expect(t.engine.getState()).toMatchObject({
      state: 'failed',
      error: 'exited:1',
      turns: 0
    })
  })

  it('sans DSH installé : absent, rien n’est lancé', async () => {
    const t = engineWith(standardAgent(() => undefined))
    const engine = new DshEngine({
      ...(
        t.engine as unknown as {
          deps: ConstructorParameters<typeof DshEngine>[0]
        }
      ).deps,
      resolve: () => null
    })
    expect(await engine.start()).toEqual({ ok: false, error: 'not-installed' })
    expect(t.plans).toHaveLength(0)
  })
})
