/**
 * R2.2: the in-process door a plugin uses.
 *
 * A plugin's `run` never dialled the socket, so R2's pipeline did not see it: `plugins/host.ts` asked
 * its own yes/no question and called the bridge directly. It now goes through `submitLocal`, which is
 * the same gate minus the one thing a local caller has no use for — there is no second hop to hand a
 * capability to, so the approval is spent by the call itself. These tests hold that path to the same
 * rules: the catalogue decides the tier, the argument shapes are enforced, the person is asked by the
 * same provider, the attempt lands in the same journal, and a refusal moves nothing.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ControlSecurity, asControlTier, controlAuditSink, type ControlAuditEntry, type ControlTokens } from './control-authz.ts'
import { HostControlGate, type ApprovalAsk, type CatalogueEntry, type HostGateResult } from './host-control.ts'

const TOKENS: ControlTokens = { backend: 'backend-token-000000000001', cli: 'cli-token-00000000000001' }

const CATALOGUE: readonly CatalogueEntry[] = [
  { id: 'page.open', tier: 'read', args: [{ name: 'name', type: 'string', required: true }] },
  { id: 'memory.add', tier: 'mutate', args: [{ name: 'text', type: 'string', required: true }] },
  { id: 'memory.forget', tier: 'destructive', args: [{ name: 'match', type: 'string', required: true }] },
]

const created: string[] = []

afterEach(() => {
  while (created.length) {
    rmSync(created.pop() as string, { recursive: true, force: true })
  }
})

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'hos-local-'))

  created.push(dir)

  return dir
}

interface LocalDoor {
  gate: HostControlGate
  asks: ApprovalAsk[]
  journal: string
  answer: (value: boolean) => void
  finish: (result: HostGateResult, ok?: boolean) => void
}

function localDoor(options: { approve?: boolean; withApprover?: boolean } = {}): LocalDoor {
  const journal = path.join(tempDir(), 'control-audit.jsonl')
  const security = new ControlSecurity({ tokens: TOKENS }, controlAuditSink(journal))
  const asks: ApprovalAsk[] = []
  let answer = options.approve ?? true

  security.setCatalogue(id => asControlTier(CATALOGUE.find(entry => entry.id === id)?.tier))

  const gate = new HostControlGate({
    security,
    approve:
      (options.withApprover ?? true)
        ? async ask => {
            asks.push(ask)

            return answer
          }
        : undefined,
  })

  gate.setCatalogue(CATALOGUE)

  return {
    gate,
    asks,
    journal,
    answer: value => {
      answer = value
    },
    finish: (result, ok = true) => {
      if (result.kind === 'execute') {
        result.finish({ ok })
      }
    },
  }
}

function lines(journal: string): ControlAuditEntry[] {
  return readFileSync(journal, 'utf8')
    .trim()
    .split('\n')
    .map(line => JSON.parse(line) as ControlAuditEntry)
}

describe('the in-process door a plugin uses', () => {
  it('runs a read command without asking anyone, and journals it as the plugin', async () => {
    const door = localDoor()
    const result = await door.gate.submitLocal({ command: 'page.open', args: { name: 'memory' }, source: 'plugin:notes' })

    expect(result.kind).toBe('execute')
    door.finish(result)

    const [entry] = lines(door.journal)

    expect(entry).toMatchObject({ client: 'plugin', command: 'page.open', tier: 'read', allowed: true, code: 'ok', source: 'plugin:notes' })
    // The attempt names itself: the journal line is one a person can quote.
    expect(entry?.requestId).toMatch(/^local_[0-9a-f]{12}$/)
    expect(door.asks).toEqual([])
  })

  it('asks the person for a mutation, once, and lets the call itself spend the answer', async () => {
    const door = localDoor()
    const result = await door.gate.submitLocal({ command: 'memory.add', args: { text: 'likes tea' }, source: 'plugin:notes' })

    expect(result.kind).toBe('execute')
    expect(door.asks.map(ask => [ask.command, ask.client, ask.tier, ask.source])).toEqual([
      ['registry:memory.add', 'plugin', 'mutate', 'plugin:notes']
    ])

    door.finish(result)

    const [entry] = lines(door.journal)

    expect(entry).toMatchObject({ client: 'plugin', command: 'memory.add', tier: 'mutate', allowed: true, code: 'ok' })
    // No capability for a caller that never leaves the process: there is no second hop to hand one to.
    expect(JSON.stringify(result)).not.toContain('capability')
  })

  it('refuses the mutation when the person says no, and moves nothing', async () => {
    const door = localDoor()

    door.answer(false)

    const result = await door.gate.submitLocal({ command: 'memory.forget', args: { match: 'x' } })

    expect(result).toMatchObject({ kind: 'reply', reply: { ok: false, code: 'denied-approval' } })
    expect(lines(door.journal).map(entry => [entry.command, entry.allowed, entry.code])).toEqual([['memory.forget', false, 'denied-approval']])
  })

  it('refuses a mutation when there is no way to ask at all', async () => {
    const door = localDoor({ withApprover: false })
    const result = await door.gate.submitLocal({ command: 'memory.add', args: { text: 'x' } })

    expect(result).toMatchObject({ kind: 'reply', reply: { ok: false, code: 'denied-policy', error: 'no approval channel is available' } })
    expect(door.asks).toEqual([])
    expect(lines(door.journal).map(entry => [entry.command, entry.allowed, entry.code])).toEqual([['memory.add', false, 'denied-policy']])
  })

  it('refuses a command the catalogue does not declare, and an argument shape that does not fit', async () => {
    const door = localDoor()
    const unknown = await door.gate.submitLocal({ command: 'made.up' })
    const wrong = await door.gate.submitLocal({ command: 'memory.forget', args: {} })

    expect(unknown).toMatchObject({ kind: 'reply', reply: { ok: false, code: 'unsupported', error: 'unknown command made.up' } })
    expect(wrong).toMatchObject({ kind: 'reply', reply: { ok: false, code: 'invalid' } })
    expect(lines(door.journal).map(entry => entry.code)).toEqual(['unsupported', 'invalid'])
  })

  it('writes no secret into the journal, and no command id that was never asked for', async () => {
    const door = localDoor()
    const result = await door.gate.submitLocal({ command: 'page.open', args: { name: 'memory' } })

    door.finish(result, false)

    const raw = readFileSync(door.journal, 'utf8')

    expect(raw).not.toContain(TOKENS.backend)
    expect(raw).not.toContain(TOKENS.cli)
    expect(raw).not.toContain('cap_')
    expect(lines(door.journal)[0]?.code).toBe('execution-failed')
  })
})

/**
 * R3: the shell's own windows used to reach the registry over the generic bus (`type: 'os'`), which
 * checked nothing and wrote nothing down. They now come through the same door as a plugin, with the
 * one difference the policy allows: a plugin is code the person installed but did not write, so a
 * mutation is confirmed; a window is the person, so the click is the confirmation.
 */
describe('the shell’s own windows', () => {
  it('runs a mutation on the person’s own click without asking twice, and journals it as that window', async () => {
    const door = localDoor()
    const result = await door.gate.submitLocal({ client: 'ui', command: 'memory.add', args: { text: 'likes tea' }, source: 'ui' })

    expect(result.kind).toBe('execute')
    door.finish(result)

    const [entry] = lines(door.journal)

    expect(entry).toMatchObject({ client: 'ui', command: 'memory.add', tier: 'mutate', allowed: true, code: 'ok', source: 'ui' })
    expect(entry?.requestId).toMatch(/^local_[0-9a-f]{12}$/)
    expect(door.asks).toEqual([])
    expect(JSON.stringify(result)).not.toContain('capability')
  })

  it('asks nobody and still refuses a command the catalogue does not declare', async () => {
    const door = localDoor({ withApprover: false })
    const unknown = await door.gate.submitLocal({ client: 'ui', command: 'made.up', source: 'ui' })

    expect(unknown).toMatchObject({ kind: 'reply', reply: { ok: false, code: 'unsupported', error: 'unknown command made.up' } })
    expect(lines(door.journal).map(entry => [entry.client, entry.command, entry.allowed, entry.code])).toEqual([['ui', 'made.up', false, 'unsupported']])
  })

  it('asks the person for a plugin and not for a window, on the very same command', async () => {
    const door = localDoor()
    const plugin = await door.gate.submitLocal({ command: 'memory.forget', args: { match: 'x' }, source: 'plugin:notes' })

    expect(door.asks.map(ask => ask.client)).toEqual(['plugin'])
    door.finish(plugin)

    const window = await door.gate.submitLocal({ client: 'ui', command: 'memory.forget', args: { match: 'x' }, source: 'ui' })

    expect(door.asks.map(ask => ask.client)).toEqual(['plugin'])
    door.finish(window)

    expect(lines(door.journal).map(entry => [entry.client, entry.command, entry.allowed, entry.code])).toEqual([
      ['plugin', 'memory.forget', true, 'ok'],
      ['ui', 'memory.forget', true, 'ok'],
    ])
  })
})
