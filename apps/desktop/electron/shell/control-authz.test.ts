import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { adjudicate, ControlSecurity, controlAuditSink, controlEndpoint, type ControlAuditEntry, type ControlTokens } from './control-authz.ts'

const TOKENS: ControlTokens = { backend: 'backend-token', cli: 'cli-token' }
const CONTEXT = { tokens: TOKENS }

const CATALOGUE: Record<string, 'read' | 'act' | 'mutate' | 'destructive'> = {
  'page.open': 'read',
  'memory.add': 'mutate',
  'memory.forget': 'destructive',
}

describe('control authorization: who may use which command', () => {
  it('refuses a request with no token at all', () => {
    const decision = adjudicate({ cmd: 'ui', command: 'page.open' }, CONTEXT)

    expect(decision.allowed).toBe(false)
    expect(decision.client).toBeNull()
    expect(decision.reason).toMatch(/token/i)
  })

  it('refuses a wrong, empty or non-string token', () => {
    for (const token of ['', 'nope', 42, null, { token: 'backend-token' }, ['backend-token']]) {
      expect(adjudicate({ cmd: 'ui', token }, CONTEXT).allowed).toBe(false)
      expect(adjudicate({ cmd: 'os', token }, CONTEXT).allowed).toBe(false)
    }
  })

  it('lets the backend token drive the command registry and nothing else', () => {
    for (const cmd of ['ui', 'ui-list', 'ui-state']) {
      expect(adjudicate({ cmd, command: 'page.open', token: TOKENS.backend }, CONTEXT)).toMatchObject({ allowed: true, client: 'backend' })
    }
    // R1: a child process that read the backend's token could otherwise run the registry's own
    // commands and skip the approval gate in the tool layer.
    for (const cmd of ['notify', 'plugin', 'launch', 'page', 'wallpaper']) {
      const decision = adjudicate({ cmd, command: 'page.open', args: ['page.open', '{}'], token: TOKENS.backend }, CONTEXT)
      expect(decision.allowed).toBe(false)
      expect(decision.client).toBe('backend')
      expect(decision.reason).toMatch(/CLI token/)
    }
    // R2: the generic registry door is retired for every caller, the backend's own token included.
    for (const cmd of ['os', 'os-run']) {
      const decision = adjudicate({ cmd, args: ['page.open', '{}'], token: TOKENS.backend }, CONTEXT)
      expect(decision.allowed).toBe(false)
      expect(decision.client).toBe('backend')
      expect(decision.code).toBe('unsupported')
      expect(decision.reason).toMatch(/replaced by run\/list\/state/)
    }
  })

  it('lets the CLI token use its own surface and nothing of the registry', () => {
    for (const cmd of ['notify', 'page', 'open', 'launch', 'wallpaper', 'theme', 'plugin', 'event', 'switches']) {
      expect(adjudicate({ cmd, command: 'page.open', args: ['page.open', '{}'], token: TOKENS.cli }, CONTEXT)).toMatchObject({ allowed: true, client: 'cli' })
    }
    for (const cmd of ['ui', 'ui-list', 'ui-state']) {
      expect(adjudicate({ cmd, token: TOKENS.cli }, CONTEXT).allowed).toBe(false)
    }
  })

  it('refuses a request with no cmd', () => {
    expect(adjudicate({ cmd: '', token: TOKENS.cli }, CONTEXT).allowed).toBe(false)
  })
})

describe('control authorization: the typed registry surface', () => {
  const context = { tokens: TOKENS, catalogueReady: true, tierOf: (id: string) => CATALOGUE[id] }

  it('reads the command id for `run` from the request, and its tier from the catalogue', () => {
    expect(adjudicate({ cmd: 'run', command: 'page.open', args: {}, token: TOKENS.cli }, context)).toMatchObject({ allowed: true, tier: 'read' })
    expect(adjudicate({ cmd: 'run', command: 'memory.forget', args: {}, token: TOKENS.cli }, context)).toMatchObject({ allowed: true, tier: 'destructive' })
    expect(adjudicate({ cmd: 'run', args: {}, token: TOKENS.cli }, context)).toMatchObject({ allowed: false, code: 'invalid' })
  })

  it('reads nothing back into the registry for `list` and `state`', () => {
    for (const cmd of ['list', 'state']) {
      expect(adjudicate({ cmd, token: TOKENS.cli }, context)).toMatchObject({ allowed: true, tier: 'read' })
    }
  })

  it('refuses an id the shell does not know once the catalogue is there', () => {
    const decision = adjudicate({ cmd: 'run', command: 'made.up', args: {}, token: TOKENS.cli }, context)

    expect(decision.allowed).toBe(false)
    expect(decision.code).toBe('unsupported')
    expect(decision.reason).toMatch(/unknown command/)
  })

  it('allows the id while the renderer has not registered the catalogue yet, but not the run itself', () => {
    const starting = { tokens: TOKENS, catalogueReady: false, tierOf: () => undefined }

    expect(adjudicate({ cmd: 'run', command: 'page.open', args: {}, token: TOKENS.cli }, starting)).toMatchObject({ allowed: true, tier: undefined })
  })

  it('keeps the registry on the CLI token: the backend has `ui` for that', () => {
    const decision = adjudicate({ cmd: 'run', command: 'page.open', args: {}, token: TOKENS.backend }, context)

    expect(decision.allowed).toBe(false)
    expect(decision.code).toBe('unauthorized')
    expect(decision.reason).toMatch(/CLI token/)
  })
})

describe('control authorization: every attempt is audited', () => {
  function security(written: ControlAuditEntry[], overrides: Partial<{ catalogueReady: boolean }> = {}) {
    return new ControlSecurity(
      { tokens: TOKENS, catalogueReady: true, tierOf: (id: string) => CATALOGUE[id], ...overrides },
      entry => written.push(entry)
    )
  }

  it('records an allowed request, a refused one and an unauthenticated one', () => {
    const written: ControlAuditEntry[] = []
    const check = security(written)

    expect(check.check({ cmd: 'ui', command: 'page.open', args: { name: 'missions' }, token: TOKENS.backend }).allowed).toBe(true)
    expect(check.check({ cmd: 'ui', command: 'page.open', args: {}, token: TOKENS.backend }).allowed).toBe(true)
    expect(check.check({ cmd: 'os', args: ['page.open', '{}'], token: TOKENS.backend }).allowed).toBe(false)
    expect(check.check({ cmd: 'ui', command: 'page.open', token: 'nope' }).allowed).toBe(false)

    expect(written.map(entry => [entry.cmd, entry.client, entry.allowed])).toEqual([
      ['ui', 'backend', true],
      ['ui', 'backend', true],
      ['os', 'backend', false],
      ['ui', 'unauthenticated', false],
    ])
  })

  it('never writes a token, and keeps the request to the facts that matter', () => {
    const written: ControlAuditEntry[] = []
    const check = security(written)

    check.check({ cmd: 'ui', command: 'memory.add', args: { text: 'secret phrase' }, source: 'agent', token: TOKENS.backend })

    const [entry] = written
    expect(entry.tier).toBe('mutate')
    expect(entry.command).toBe('memory.add')
    expect(entry.source).toBe('agent')
    expect(entry.at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(JSON.stringify(entry)).not.toContain(TOKENS.backend)
    expect(JSON.stringify(entry)).not.toContain(TOKENS.cli)
    expect(JSON.stringify(entry)).not.toContain('secret phrase')
  })

  it('records a line that was never a request, without the line itself', () => {
    const written: ControlAuditEntry[] = []
    const check = security(written)

    check.malformed('invalid JSON')

    expect(written).toHaveLength(1)
    expect(written[0]).toMatchObject({ client: 'unauthenticated', cmd: '', allowed: false, reason: 'invalid JSON' })
    expect(written[0].at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })
})

describe('control authorization: the desktop server guards the backend surface', () => {
  const backendSurface = { tokens: TOKENS, surface: 'backend' as const, catalogueReady: true, tierOf: (id: string) => CATALOGUE[id] }

  it('lets the backend token use what main serves there, and nothing else', () => {
    for (const cmd of ['ui', 'ui-list', 'ui-state', 'page', 'notify', 'voice']) {
      expect(adjudicate({ cmd, command: 'page.open', args: ['page.open', '{}'], token: TOKENS.backend }, backendSurface).allowed).toBe(true)
    }

    // R1: `os`/`os-run` run a registry command, so they are the CLI's door whatever the surface is.
    // R2 retires them outright: the door is `run`, and it is the CLI's wherever it is reached from.
    for (const cmd of ['os', 'os-run']) {
      const decision = adjudicate({ cmd, args: ['page.open', '{}'], token: TOKENS.backend }, backendSurface)

      expect(decision.allowed).toBe(false)
      expect(decision.client).toBe('backend')
      expect(decision.code).toBe('unsupported')
      expect(decision.reason).toMatch(/replaced by run\/list\/state/)
    }

    // The typed spellings main serves are the backend's; they keep the same tier rules as the panel.
    expect(adjudicate({ cmd: 'run', command: 'page.open', args: {}, token: TOKENS.backend }, backendSurface)).toMatchObject({ allowed: true, tier: 'read' })
    expect(adjudicate({ cmd: 'run', command: 'page.open', args: {}, token: TOKENS.cli }, backendSurface)).toMatchObject({ allowed: false, code: 'unauthorized' })

    // A command main does not serve is refused here, so the journal records a refusal instead of an
    // allow that the dispatcher then answers with `unknown command`.
    for (const cmd of ['plugin', 'launch', 'wallpaper', 'made-up']) {
      const decision = adjudicate({ cmd, token: TOKENS.backend }, backendSurface)

      expect(decision.allowed).toBe(false)
      expect(decision.client).toBe('backend')
      expect(decision.reason).toMatch(/unknown command/)
    }
  })

  it('refuses the CLI token there, so one door does not open the other', () => {
    const decision = adjudicate({ cmd: 'page', args: ['missions'], token: TOKENS.cli }, backendSurface)

    expect(decision.allowed).toBe(false)
    expect(decision.client).toBe('cli')
    expect(decision.reason).toMatch(/backend token/)
  })
})

describe('control audit journal', () => {
  it('appends one line per attempt, and stays quiet when it cannot write', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'control-audit-'))
    const file = path.join(directory, 'nested', 'control-audit.jsonl')
    const check = new ControlSecurity({ tokens: TOKENS }, controlAuditSink(file))

    check.check({ cmd: 'ui', command: 'page.open', token: TOKENS.backend })
    check.check({ cmd: 'ui', command: 'page.open', token: 'nope' })
    check.malformed('invalid JSON')

    const lines = readFileSync(file, 'utf8').trim().split('\n')

    expect(lines).toHaveLength(3)
    expect(JSON.parse(lines[0])).toMatchObject({ cmd: 'ui', client: 'backend', allowed: true, command: 'page.open' })
    expect(JSON.parse(lines[1])).toMatchObject({ cmd: 'ui', client: 'unauthenticated', allowed: false })
    expect(JSON.parse(lines[2])).toMatchObject({ cmd: '', client: 'unauthenticated', allowed: false, reason: 'invalid JSON' })
    expect(readFileSync(file, 'utf8')).not.toContain(TOKENS.backend)
    expect(readFileSync(file, 'utf8')).not.toContain(TOKENS.cli)

    // A journal that cannot be written is a gap in the record, not a decision: the sink never throws.
    const cannotWrite = controlAuditSink(path.join(file, 'impossible', 'control-audit.jsonl'))

    expect(() => cannotWrite({ at: 'now', client: 'cli', cmd: 'notify', allowed: true, reason: 'x' })).not.toThrow()
  })
})

describe('control endpoint', () => {
  it('is a named pipe on Windows, never a loopback port', () => {
    const resolved = controlEndpoint({ platform: 'win32', runtimeDir: 'C:\\runtime', dataDir: 'C:\\data' })

    expect(resolved.kind).toBe('pipe')
    expect(resolved.endpoint).toMatch(/^pipe:\/\/herald-os-[0-9a-f]{16}$/)
    expect(resolved.endpoint).not.toMatch(/tcp:\/\//)
    expect(resolved.path).toBe(`\\\\.\\pipe\\${resolved.endpoint.slice('pipe://'.length)}`)
  })

  it('is a unix socket path everywhere else', () => {
    const resolved = controlEndpoint({ platform: 'linux', runtimeDir: '/run/user/1000', dataDir: '/home/u/.local/share' })

    expect(resolved.kind).toBe('unix')
    expect(resolved.path).toBe('/run/user/1000/herald-os/control.sock')
    expect(resolved.endpoint).toBe(resolved.path)
  })

  it('gives two profiles two pipes, so one cannot dial the other', () => {
    const a = controlEndpoint({ platform: 'win32', runtimeDir: 'C:\\runtime', dataDir: 'C:\\data-a' })
    const b = controlEndpoint({ platform: 'win32', runtimeDir: 'C:\\runtime', dataDir: 'C:\\data-b' })

    expect(a.endpoint).not.toBe(b.endpoint)
    expect(controlEndpoint({ platform: 'win32', runtimeDir: 'C:\\runtime', dataDir: 'C:\\data-a' }).endpoint).toBe(a.endpoint)
  })
})
