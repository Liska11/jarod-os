import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { type ControlDecision, type ControlRequestShape, ControlSecurity, type ControlTier } from './control-authz.ts'
import { attachControlShadow, ControlShadow, diffDecisions, findShadowBinary, flagOn, knownDifference, type ShadowDivergence, shadowRequest } from './control-shadow.ts'

// V-22 — the Rust adjudicator in shadow of the TypeScript door. The pure parts always run; the live part drives the real
// `jarod-control-shadow` (a debug build: `cargo build -p host-control` in host-rust, or JAROD_CONTROL_SHADOW_BIN) and is skipped when no
// binary was built — CI has no Rust toolchain yet.

const REPO = path.resolve(__dirname, '..', '..', '..', '..')
const DEBUG_BIN = path.join(REPO, 'host-rust', 'target', 'debug', process.platform === 'win32' ? 'jarod-control-shadow.exe' : 'jarod-control-shadow')
const BIN = process.env.JAROD_CONTROL_SHADOW_BIN ?? (fs.existsSync(DEBUG_BIN) ? DEBUG_BIN : null)
const CONTRACTS = path.join(REPO, 'contracts', 'v1')
const MATRIX = JSON.parse(fs.readFileSync(path.join(CONTRACTS, 'fixtures', 'c2-authorization-matrix', 'valid-current.json'), 'utf8')) as {
  registryCommands: string[]
  retiredCommands: string[]
  backendCommands: string[]
  shellCommands: { name: string; tierByAction?: { actions: Record<string, string> } }[]
}
const TOKENS = { backend: 'live-backend-token-0123456789abcdef', cli: 'live-cli-token-0123456789abcdefghijk' }
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'jarod-control-shadow-'))

afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }))

describe('the flag, the binary and what the shadow is told', () => {
  it('is off unless JAROD_HOST_CONTROL is exactly 1', () => {
    expect(flagOn({})).toBe(false)
    expect(flagOn({ JAROD_HOST_CONTROL: 'true' })).toBe(false)
    expect(flagOn({ JAROD_HOST_CONTROL: '1' })).toBe(true)
  })

  it('takes JAROD_CONTROL_SHADOW_BIN when it names a file, never PATH behind its back; else PATH', () => {
    const named = path.join('tools', 'shadow.exe')
    const onPath = path.join('bin', process.platform === 'win32' ? 'jarod-control-shadow.exe' : 'jarod-control-shadow')
    const exists = (file: string) => file === named || file === onPath
    expect(findShadowBinary({ JAROD_CONTROL_SHADOW_BIN: named, PATH: 'bin' }, exists)).toBe(named)
    expect(findShadowBinary({ JAROD_CONTROL_SHADOW_BIN: 'absent.exe', PATH: 'bin' }, exists)).toBeNull()
    expect(findShadowBinary({ PATH: ['nothing', 'bin'].join(path.delimiter) }, exists)).toBe(onPath)
  })

  it('never hands over a live token: the shadow token of the client this door recognised, and only cmd, command and args', () => {
    const shadow = { backend: 'B'.repeat(32), cli: 'C'.repeat(32) }
    const request = { cmd: 'run', command: 'x', args: ['a'], token: TOKENS.backend, capability: 'cap', source: 'me' }
    expect(shadowRequest(request, 'backend', shadow)).toEqual({ token: shadow.backend, cmd: 'run', command: 'x', args: ['a'] })
    expect(shadowRequest(request, 'cli', shadow).token).toBe(shadow.cli)
    expect(shadowRequest(request, null, shadow).token).not.toMatch(/^(B+|C+)$/)
    expect(JSON.stringify(shadowRequest(request, 'backend', shadow))).not.toContain(TOKENS.backend)
  })

  it('names the fields two decisions differ on; an absent field and undefined agree', () => {
    const ts: ControlDecision = { allowed: true, client: 'cli', reason: 'r', tier: undefined }
    expect(diffDecisions(ts, { allowed: true, client: 'cli', reason: 'r' })).toEqual([])
    expect(diffDecisions(ts, { allowed: false, client: 'cli', reason: 'x', code: 'invalid' })).toEqual(['allowed', 'code', 'reason'])
  })

  it('a known difference is the README one, with the same end; anything else is a divergence', () => {
    const ts: ControlDecision = { allowed: true, client: 'cli', reason: 'plugin is a shell command', tier: 'mutate' }
    const rust = { allowed: false, client: 'cli' as const, code: 'invalid' as const, reason: 'plugin does not know the action x' }
    expect(knownDifference({ cmd: 'plugin', args: ['frobnicate'] }, ts, rust)).toBe('readme-2-unknown-action')
    // This side's argument check accepts `plugin list`: a refusal from Rust there would be a real divergence.
    expect(knownDifference({ cmd: 'plugin', args: ['list'] }, ts, rust)).toBeNull()
    expect(knownDifference({ cmd: 'plugin', args: ['frobnicate'] }, ts, { ...rust, code: 'unsupported' })).toBeNull()
    expect(knownDifference({ cmd: 'plugin', args: ['frobnicate'] }, ts, { ...rust, client: 'backend' })).toBeNull()
  })

  it('an observer cannot change a decision, and one that throws is ignored', () => {
    const security = new ControlSecurity({ tokens: TOKENS }, () => undefined)
    const seen: ControlDecision[] = []
    security.addObserver(() => {
      throw new Error('boom')
    })
    security.addObserver((_request, decision) => seen.push(decision))
    const decision = security.adjudicateOnly({ cmd: 'list', token: TOKENS.cli })
    expect(decision).toMatchObject({ allowed: true, client: 'cli' })
    expect(seen).toEqual([decision])
    expect(security.redact(`x ${TOKENS.cli} y`)).not.toContain(TOKENS.cli)
  })

  it('with the flag off nothing is attached and nothing runs', () => {
    const security = new ControlSecurity({ tokens: TOKENS }, () => undefined)
    const added: unknown[] = []
    const door = Object.assign(security, { addObserver: (o: unknown) => added.push(o) })
    expect(attachControlShadow({ env: {}, configDir: scratch, contracts: CONTRACTS, doors: [door], log: () => undefined })).toBeNull()
    expect(added).toEqual([])
  })
})

/** Every kind of request the matrix knows, on both doors: tokens right, wrong and swapped, retired, registry, shell, typed run. */
function requests(): ControlRequestShape[] {
  const out: ControlRequestShape[] = [{}, { cmd: '' }, { cmd: 'list' }, { cmd: 'list', token: 'wrong-token-wrong-token-wrong' }, { cmd: 'nope', token: TOKENS.cli }]

  for (const token of [TOKENS.backend, TOKENS.cli]) {
    for (const cmd of [...MATRIX.retiredCommands, ...MATRIX.registryCommands, ...MATRIX.backendCommands]) {
      out.push({ cmd, token }, { cmd, token, command: 'theme.set' }, { cmd, token, command: ' unknown.thing ' }, { cmd, token, command: 'host.read' })
    }
    for (const shell of MATRIX.shellCommands) {
      out.push({ cmd: shell.name, token }, { cmd: ` ${shell.name} `, token, args: [] })
      for (const action of Object.keys(shell.tierByAction?.actions ?? {})) out.push({ cmd: shell.name, token, args: [action] }, { cmd: shell.name, token, args: [1, action] })
      if (shell.tierByAction) out.push({ cmd: shell.name, token, args: ['not-an-action'] })
    }
    out.push({ cmd: 'run', token }, { cmd: 'run', token, command: '' })
  }

  return out
}

describe.skipIf(!BIN)('the real jarod-control-shadow, live', () => {
  const catalogue = new Map<string, ControlTier>([
    ['theme.set', 'mutate'],
    ['host.read', 'read'],
  ])

  const run = async (catalogueReady: boolean) => {
    const doors = [new ControlSecurity({ tokens: TOKENS }, () => undefined), new ControlSecurity({ tokens: TOKENS, surface: 'backend' }, () => undefined)]
    if (catalogueReady) for (const door of doors) door.setCatalogue(id => catalogue.get(id))
    const divergences: ShadowDivergence[] = []
    const configDir = path.join(scratch, `config-${catalogueReady}`)
    const shadow = attachControlShadow({
      env: { JAROD_HOST_CONTROL: '1', JAROD_CONTROL_SHADOW_BIN: BIN as string },
      configDir,
      contracts: CONTRACTS,
      doors,
      log: () => undefined,
    }) as ControlShadow
    expect(shadow).not.toBeNull()
    const all = requests()
    for (const door of doors) for (const request of all) door.adjudicateOnly(request)
    const expected = all.length * doors.length
    for (let i = 0; i < 200 && shadow.stats.compared < expected; i++) await new Promise(resolve => setTimeout(resolve, 25))
    const file = path.join(configDir, 'control-shadow.jsonl')
    if (fs.existsSync(file)) divergences.push(...fs.readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line)))
    const stats = shadow.stats
    shadow.stop()
    return { stats, expected, divergences, file }
  }

  it('the matrix, live: every request on both doors gets the same decision from Rust as from TypeScript (catalogue loaded)', async () => {
    const { stats, expected, divergences } = await run(true)
    expect(divergences).toEqual([])
    // `branding` and `plugin` with an unknown action, from the CLI on the panel: README difference 2, same end.
    expect(stats).toMatchObject({ compared: expected, diverged: 0, known: 2, dropped: 0 })
    expect(expected).toBeGreaterThan(300)
  })

  it('the same before the catalogue is loaded (an empty catalogue is not evidence)', async () => {
    const { stats, expected, divergences } = await run(false)
    expect(divergences).toEqual([])
    expect(stats).toMatchObject({ compared: expected, diverged: 0 })
  })

  it('a decision that differs is written down, redacted, and the door is not touched', async () => {
    const divergences: ShadowDivergence[] = []
    const shadow = new ControlShadow({ binary: BIN as string, contracts: CONTRACTS, onDivergence: entry => divergences.push(entry) })
    shadow.start()
    // A door that (wrongly) let an unknown CLI command through: Rust must disagree.
    shadow.observe('panel', { cmd: 'nope', token: TOKENS.cli }, { allowed: true, client: 'cli', reason: 'wrong' }, { tierOf: () => undefined, catalogueReady: true })
    for (let i = 0; i < 200 && divergences.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 25))
    shadow.stop()
    expect(divergences).toHaveLength(1)
    expect(divergences[0]).toMatchObject({ cmd: 'nope', fields: ['allowed', 'code', 'reason'], rust: { allowed: false, code: 'unsupported' } })
  })

  it('a binary that refuses to start only turns the shadow off', async () => {
    let stopped = ''
    const shadow = new ControlShadow({ binary: BIN as string, contracts: path.join(scratch, 'no-contracts'), onDivergence: () => undefined, onStop: reason => (stopped = reason) })
    shadow.start()
    for (let i = 0; i < 200 && !stopped; i++) await new Promise(resolve => setTimeout(resolve, 25))
    expect(stopped).toMatch(/exited with code 2/)
    expect(() => shadow.observe('panel', { cmd: 'list' }, { allowed: false, client: null, reason: 'x' }, { tierOf: () => undefined, catalogueReady: false })).not.toThrow()
    expect(shadow.stats.running).toBe(false)
  })
})
