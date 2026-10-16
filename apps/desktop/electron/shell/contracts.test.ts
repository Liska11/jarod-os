/**
 * The frozen contracts (contracts/v1), checked from the TypeScript side.
 *
 * Two kinds of test live here. The first walks `contracts/v1/index.json` and validates every fixture of
 * every contract against its schema: the Python suite (plugins/herald-os-bridge/tests/test_contracts.py)
 * does the same walk over the same files, so a schema and a fixture can only drift apart in both
 * languages at once. The second kind feeds the real code (`adjudicate`, `ControlSecurity`,
 * `controlEndpoint`, the journal sink) and checks what it produces against the schemas — the check that
 * fails when the code and a contract diverge.
 */

import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  adjudicate,
  BACKEND_COMMANDS,
  ControlSecurity,
  controlAuditSink,
  controlEndpoint,
  controlTokens,
  REGISTRY_COMMANDS,
  requestIdProblem,
  RETIRED_COMMANDS,
  shellCommandNames,
  shellTier,
  TYPED_REGISTRY_COMMANDS,
  type ControlContext,
  type ControlRequestShape,
  type ControlTier
} from './control-authz.ts'

// ajv is resolved from the workspace root (it is a hoisted dependency, not declared by this package).
const Ajv2020 = createRequire(import.meta.url)('ajv/dist/2020')
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../contracts/v1')
const TIERS: ControlTier[] = ['read', 'act', 'mutate', 'destructive']

interface IndexEntry {
  id: string
  status: 'frozen' | 'provisional'
  schema: string
  fixtures: string
  source: string[]
  protectedBy: string[]
}

const read = (...parts: string[]): unknown => JSON.parse(readFileSync(path.join(ROOT, ...parts), 'utf8'))
const index = read('index.json') as { contracts: IndexEntry[]; notFrozen: { area: string; reason: string }[] }

const ajv = new Ajv2020({ strict: true, allowUnionTypes: true, strictRequired: false, allErrors: true })
const validators = new Map<string, (doc: unknown) => boolean>()

for (const contract of index.contracts) {
  validators.set(contract.id, ajv.compile(read(contract.schema) as object))
}

function validatorOf(id: string): (doc: unknown) => boolean {
  const validate = validators.get(id)

  if (!validate) {
    throw new Error(`no contract ${id}`)
  }

  return validate
}

const fixture = (id: string, name: string): unknown => read('fixtures', id, `${name}.json`)

function fixtures(id: string): { name: string; valid: boolean; doc: unknown }[] {
  return readdirSync(path.join(ROOT, 'fixtures', id))
    .filter(file => file.endsWith('.json'))
    .sort()
    .map(file => ({ name: file, valid: file.startsWith('valid-'), doc: read('fixtures', id, file) }))
}

describe('contracts/v1: every fixture, in the same files the Python suite reads', () => {
  it('lists every contract with a source, a status and at least one valid and one invalid fixture', () => {
    expect(index.contracts.length).toBeGreaterThanOrEqual(16)
    expect(index.notFrozen.length).toBeGreaterThan(0)

    for (const contract of index.contracts) {
      expect(['frozen', 'provisional'], contract.id).toContain(contract.status)
      expect(contract.source.length, contract.id).toBeGreaterThan(0)
      expect(contract.protectedBy.length, contract.id).toBeGreaterThan(0)

      const files = fixtures(contract.id)

      expect(files.some(file => file.valid), `${contract.id} has no valid fixture`).toBe(true)
      expect(files.some(file => !file.valid), `${contract.id} has no invalid fixture`).toBe(true)
      expect(files.every(file => file.name.startsWith('valid-') || file.name.startsWith('invalid-')), contract.id).toBe(true)
    }
  })

  for (const contract of index.contracts) {
    describe(contract.id, () => {
      for (const file of fixtures(contract.id)) {
        it(`${file.name} is ${file.valid ? 'accepted' : 'rejected'}`, () => {
          expect(validatorOf(contract.id)(file.doc)).toBe(file.valid)
        })
      }
    })
  }

  it('uses one tier ladder everywhere it names one', () => {
    const ladders: unknown[][] = []
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) {
        node.forEach(walk)
      } else if (node && typeof node === 'object') {
        for (const [key, value] of Object.entries(node)) {
          if ((key === 'enum' || key === 'const') && Array.isArray(value) && value.includes('read') && value.includes('destructive')) {
            ladders.push(value)
          } else {
            walk(value)
          }
        }
      }
    }

    for (const contract of index.contracts) {
      walk(read(contract.schema))
    }

    expect(ladders.length).toBeGreaterThanOrEqual(4)

    for (const ladder of ladders) {
      expect(ladder).toEqual(TIERS)
    }
  })
})

describe('C1 control request: the code agrees with the schema', () => {
  const tokens = controlTokens()
  const context: ControlContext = { tokens, tierOf: id => ({ 'page.open': 'read', 'memory.add': 'mutate' } as Record<string, ControlTier>)[id] }
  const withTokens = (doc: unknown): ControlRequestShape => {
    const request = { ...(doc as Record<string, unknown>) }

    if (request.token === '@backend') request.token = tokens.backend
    if (request.token === '@cli') request.token = tokens.cli

    return request as ControlRequestShape
  }

  it('never turns a well-formed request away as malformed', () => {
    for (const { name, valid, doc } of fixtures('c1-control-request').filter(file => file.valid)) {
      const request = withTokens(doc)

      expect(adjudicate(request, context).code, name).not.toBe('invalid')
      expect(requestIdProblem(request), name).toBeUndefined()
      expect(valid).toBe(true)
    }
  })

  it('always refuses a request the schema rejects', () => {
    for (const { name, doc } of fixtures('c1-control-request').filter(file => !file.valid)) {
      const request = withTokens(doc)
      const decision = adjudicate(request, context)

      expect(decision.allowed === false || requestIdProblem(request) !== undefined, `${name} was let through`).toBe(true)
    }
  })
})

describe('C1 control decision: whatever adjudicate answers is a valid decision', () => {
  const tokens = controlTokens()
  const catalogue: Record<string, ControlTier> = { 'page.open': 'read', 'memory.add': 'mutate', 'memory.forget': 'destructive' }
  const valid = validatorOf('c1-control-decision')

  it('holds across every command, token and surface', () => {
    const commands = ['', 'ui', 'ui-list', 'ui-state', 'run', 'list', 'state', 'os', 'os-run', 'made-up', ...shellCommandNames()]
    const credentials: unknown[] = [tokens.backend, tokens.cli, 'wrong', undefined, 42]
    let checked = 0

    for (const surface of ['panel', 'backend'] as const) {
      for (const catalogueReady of [true, false]) {
        const context: ControlContext = { tokens, surface, catalogueReady, tierOf: id => catalogue[id] }

        for (const cmd of commands) {
          for (const token of credentials) {
            for (const command of ['', 'page.open', 'memory.add', 'memory.forget', 'nope']) {
              const decision = adjudicate({ cmd, token, command, args: [] }, context)

              expect(valid(decision), JSON.stringify({ cmd, command, surface, decision })).toBe(true)
              checked++
            }
          }
        }
      }
    }

    expect(checked).toBeGreaterThan(1000)
  })

  it('answers a request that is not even an object with a valid refusal', () => {
    for (const request of [null, undefined, 'ui', 7, []]) {
      const decision = adjudicate(request as unknown as ControlRequestShape, { tokens })

      expect(valid(decision)).toBe(true)
      expect(decision.allowed).toBe(false)
    }
  })
})

describe('C1 control endpoint: what the host announces', () => {
  const valid = validatorOf('c1-control-endpoint')

  it('is a pipe name on Windows and a socket path elsewhere, never TCP', () => {
    const named = controlEndpoint({ platform: 'win32', runtimeDir: 'C:\\run', dataDir: 'C:\\data', nonce: '0123456789abcdef' })
    const derived = controlEndpoint({ platform: 'win32', runtimeDir: 'C:\\run', dataDir: 'C:\\data' })
    const unix = controlEndpoint({ platform: 'linux', runtimeDir: '/run/user/1000', dataDir: '/home/a/.local/share' })
    const mac = controlEndpoint({ platform: 'darwin', runtimeDir: '/tmp/u', dataDir: '/Users/a' })

    for (const target of [named, derived, unix, mac]) {
      expect(valid(target.endpoint), target.endpoint).toBe(true)
      expect(target.endpoint.startsWith('tcp:')).toBe(false)
    }

    expect(named.endpoint).toBe('pipe://herald-os-0123456789abcdef')
  })

  it('refuses a nonce that is not 16 lowercase hex characters', () => {
    for (const nonce of ['', 'short', '0123456789ABCDEF', '../../evil', '0123456789abcdef0']) {
      expect(() => controlEndpoint({ platform: 'win32', runtimeDir: '', dataDir: '', nonce })).toThrow()
    }
  })
})

describe('C2 authorization matrix: the code is the golden file, set for set', () => {
  const golden = fixture('c2-authorization-matrix', 'valid-current') as {
    registryCommands: string[]
    typedRegistryCommands: string[]
    retiredCommands: string[]
    backendCommands: string[]
    shellCommands: { name: string; tier?: ControlTier; tierByAction?: { defaultAction: string; actions: Record<string, ControlTier> } }[]
  }
  const sorted = (items: Iterable<string>): string[] => [...items].sort()

  it('has the same command sets', () => {
    expect(sorted(REGISTRY_COMMANDS)).toEqual(sorted(golden.registryCommands))
    expect(sorted(TYPED_REGISTRY_COMMANDS)).toEqual(sorted(golden.typedRegistryCommands))
    expect(sorted(RETIRED_COMMANDS)).toEqual(sorted(golden.retiredCommands))
    expect(sorted(BACKEND_COMMANDS)).toEqual(sorted(golden.backendCommands))
    expect(sorted(shellCommandNames())).toEqual(sorted(golden.shellCommands.map(command => command.name)))
  })

  it('gives every shell command the tier the golden file states', () => {
    for (const command of golden.shellCommands) {
      if (command.tier) {
        expect(shellTier(command.name, { args: [] }), command.name).toBe(command.tier)
      } else if (command.tierByAction) {
        const { defaultAction, actions } = command.tierByAction

        expect(shellTier(command.name, { args: [] }), `${command.name} (default)`).toBe(actions[defaultAction])

        for (const [action, tier] of Object.entries(actions)) {
          expect(shellTier(command.name, { args: [action, 'target'] }), `${command.name} ${action}`).toBe(tier)
        }
      }
    }
  })

  it('opens each door only to its own token', () => {
    const tokens = controlTokens()
    const tierOf = () => 'read' as ControlTier
    const panel: ControlContext = { tokens, surface: 'panel', catalogueReady: true, tierOf }
    const backend: ControlContext = { tokens, surface: 'backend', catalogueReady: true, tierOf }
    const call = (cmd: string, token: string, context: ControlContext) => adjudicate({ cmd, token, command: 'page.open', args: ['x', 'y'] }, context)
    const everyCommand = new Set([...golden.registryCommands, ...golden.typedRegistryCommands, ...golden.shellCommands.map(command => command.name)])

    for (const cmd of everyCommand) {
      if (golden.registryCommands.includes(cmd)) {
        expect(call(cmd, tokens.backend, panel).allowed, `panel ${cmd} backend`).toBe(true)
        expect(call(cmd, tokens.cli, panel), `panel ${cmd} cli`).toMatchObject({ allowed: false, code: 'unauthorized' })
      } else {
        expect(call(cmd, tokens.cli, panel).allowed, `panel ${cmd} cli`).toBe(true)
        expect(call(cmd, tokens.backend, panel), `panel ${cmd} backend`).toMatchObject({ allowed: false, code: 'unauthorized' })
      }

      expect(call(cmd, tokens.cli, backend).allowed, `backend surface ${cmd} cli`).toBe(false)

      if (golden.backendCommands.includes(cmd)) {
        expect(call(cmd, tokens.backend, backend).allowed, `backend surface ${cmd} backend`).toBe(true)
      } else {
        expect(call(cmd, tokens.backend, backend), `backend surface ${cmd} backend`).toMatchObject({ allowed: false, code: 'unsupported' })
      }
    }

    for (const cmd of golden.retiredCommands) {
      for (const [context, label] of [[panel, 'panel'], [backend, 'backend']] as const) {
        for (const token of [tokens.backend, tokens.cli]) {
          expect(call(cmd, token, context), `${label} ${cmd}`).toMatchObject({ allowed: false, code: 'unsupported' })
        }
      }
    }
  })
})

describe('C3 control audit entry: what the real journal writes', () => {
  it('is valid on every line, and carries no token, capability or nonce', () => {
    const tokens = controlTokens()
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'contract-audit-')), 'nested', 'control-audit.jsonl')
    const security = new ControlSecurity(
      { tokens, surface: 'backend', catalogueReady: true, tierOf: id => ({ 'page.open': 'read', 'memory.add': 'mutate' } as Record<string, ControlTier>)[id] },
      controlAuditSink(file)
    )
    const capability = 'cap_AbCdEfGhIjKl_Zk3Qm9vX1pL7wR4tY8uN2cB6hJ5aD0eF'

    security.check({ cmd: 'ui', command: 'page.open', args: { name: 'a' }, source: 'agent', token: tokens.backend, requestId: 'br-0123456789ab' })
    security.check({ cmd: 'run', command: 'memory.add', args: { text: 'x' }, token: tokens.backend, capability })
    security.check({ cmd: 'ui', command: 'page.open', token: tokens.cli })
    security.check({ cmd: 'ui', command: 'page.open', token: `${tokens.backend}x` })
    security.check({ cmd: 'os', token: tokens.backend })
    security.check({ cmd: '   ', token: tokens.backend })
    security.check({ cmd: 'ui', token: tokens.backend, requestId: 'two words' })
    security.malformed('invalid JSON')
    security.record({ client: 'backend', cmd: 'ui', command: 'memory.add', tier: 'mutate', allowed: true, reason: 'approved', code: 'approval-granted', approval: '0123456789ab' })

    const text = readFileSync(file, 'utf8')
    const lines = text.trim().split('\n')
    const valid = validatorOf('c3-control-audit-entry')

    expect(lines).toHaveLength(9)

    for (const line of lines) {
      expect(valid(JSON.parse(line)), line).toBe(true)
    }

    for (const secret of [tokens.backend, tokens.cli, capability, 'Zk3Qm9vX1pL7wR4tY8uN2cB6hJ5aD0eF']) {
      expect(text).not.toContain(secret)
    }
  })

  it('rejects the journal line that contains a token, in every form it can take', () => {
    const valid = validatorOf('c3-control-audit-entry')
    const invalid = fixtures('c3-control-audit-entry').filter(file => !file.valid && file.name.match(/token|capability|nonce/))

    expect(invalid.map(file => file.name)).toEqual(
      expect.arrayContaining(['invalid-contains-token-field.json', 'invalid-contains-capability-field.json', 'invalid-contains-nonce-field.json', 'invalid-token-in-reason.json', 'invalid-token-in-command.json'])
    )

    for (const file of invalid) {
      expect(valid(file.doc), file.name).toBe(false)
    }
  })
})
