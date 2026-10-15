/**
 * R3.1: the host actions that are not renderer registry commands.
 *
 * Plugin administration and the `herald-os` CLI a window may spawn used to run without any policy of
 * their own: `plugins/*` did the work straight in its IPC handler, and `services.ts` spawned whatever
 * argv it was handed. Both now name a catalogued action with a tier, and both are refused — and
 * journalled — when that action is not one the host catalogue declares. These tests hold the two
 * tables and the decisions they drive; the IPC wiring that calls them is main-process Electron and is
 * covered by the typecheck.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ControlSecurity, asControlTier, controlAuditSink, type ControlAuditEntry, type ControlTokens } from './control-authz.ts'
import { PLUGIN_ACTIONS, POWER_ACTIONS, IDLE_RESTART_ACTION, cliActionId, hostCatalogueEntries, hostCatalogueTiers } from './host-actions.ts'
import { HostControlGate, type CatalogueEntry } from './host-control.ts'

const TOKENS: ControlTokens = { backend: 'backend-token-000000000001', cli: 'cli-token-00000000000001' }
const CATALOGUE: readonly CatalogueEntry[] = hostCatalogueEntries()
const created: string[] = []

afterEach(() => {
  while (created.length) {
    rmSync(created.pop() as string, { recursive: true, force: true })
  }
})

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'hos-host-actions-'))

  created.push(dir)

  return dir
}

function hostDoor(): { gate: HostControlGate; journal: string } {
  const journal = path.join(tempDir(), 'control-audit.jsonl')
  const security = new ControlSecurity({ tokens: TOKENS }, controlAuditSink(journal))

  security.setCatalogue(id => asControlTier(CATALOGUE.find(entry => entry.id === id)?.tier))

  const gate = new HostControlGate({ security })

  gate.setCatalogue(CATALOGUE)

  return { gate, journal }
}

function lines(journal: string): ControlAuditEntry[] {
  return readFileSync(journal, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as ControlAuditEntry)
}

describe('the host catalogue', () => {
  it('tiers every action it declares, and declares nothing retired', () => {
    expect(CATALOGUE.length).toBeGreaterThan(50)

    for (const entry of CATALOGUE) {
      expect(entry.id).toMatch(/^(plugin|cli|shell)\./)
      expect(asControlTier(entry.tier)).toBeDefined()
    }

    const ids = CATALOGUE.map(entry => entry.id)

    // A retired verb stays retired: nothing reopens `os` or `os-run`.
    expect(ids).not.toContain('cli.os')
    expect(ids).not.toContain('cli.os-run')
    expect(Object.keys(PLUGIN_ACTIONS).length).toBe(4)
  })

  it('keeps the dangerous verbs dangerous', () => {
    const tier = (id: string) => CATALOGUE.find(entry => entry.id === id)?.tier

    expect(tier('cli.install')).toBe('mutate')
    expect(tier('cli.update')).toBe('mutate')
    expect(tier('cli.catalog.install')).toBe('mutate')
    expect(tier('cli.catalog.list')).toBe('read')
    expect(tier('cli.catalog.remove')).toBe('destructive')
    expect(tier('cli.remove')).toBe('destructive')
    expect(tier('cli.reset')).toBe('destructive')
    expect(tier('cli.rollback')).toBe('destructive')
    expect(tier('cli.firmware')).toBe('destructive')
    expect(tier('cli.firmware.check')).toBe('read')
    expect(tier('cli.password')).toBe('destructive')
    expect(tier('cli.windows.remove')).toBe('destructive')
    expect(tier('cli.plugin.remove')).toBe('destructive')
    expect(tier('cli.theme.current')).toBe('read')
    expect(tier('plugin.remove')).toBe('destructive')
    expect(tier('plugin.add')).toBe('mutate')
  })

  it('gives the securities the same tiers, so a host action is decidable before the registry is known', () => {
    // `main.ts` seeds this lookup when the gates are built: the setup wizard may set the account
    // password on a first run, before the renderer has registered anything at all.
    const tiers = hostCatalogueTiers()

    expect(tiers.size).toBe(CATALOGUE.length)
    expect(tiers.get('cli.password')).toBe('destructive')
    expect(tiers.get('cli.install')).toBe('mutate')
    expect(tiers.get('plugin.remove')).toBe('destructive')
  })

  it('tiers the machine-level actions main performs itself', () => {
    const tier = (id: string) => CATALOGUE.find(entry => entry.id === id)?.tier

    // The idle unit restart and the power actions are main's own spawns, not CLI verbs: they must be
    // named in the same catalogue, or a window could reach a machine-level effect without a tier.
    expect(tier(IDLE_RESTART_ACTION)).toBe('mutate')
    expect(tier(POWER_ACTIONS.lock)).toBe('mutate')
    expect(tier(POWER_ACTIONS.suspend)).toBe('mutate')
    expect(tier(POWER_ACTIONS.logout)).toBe('destructive')
    expect(tier(POWER_ACTIONS.reboot)).toBe('destructive')
    expect(tier(POWER_ACTIONS.poweroff)).toBe('destructive')
    expect(Object.keys(POWER_ACTIONS)).toHaveLength(5)
  })
})

describe('cliActionId', () => {
  it('names the verb, and the sub-verb when the table refines it', () => {
    expect(cliActionId(['theme', 'current'])).toBe('cli.theme.current')
    expect(cliActionId(['firmware', 'check'])).toBe('cli.firmware.check')
    expect(cliActionId(['windows', 'remove', '--purge'])).toBe('cli.windows.remove')
    expect(cliActionId(['install', 'app', 'Signal'])).toBe('cli.install')
    expect(cliActionId(['update'])).toBe('cli.update')
    expect(cliActionId(['catalog', 'install', 'signal'])).toBe('cli.catalog.install')
    expect(cliActionId(['catalog', 'status'])).toBe('cli.catalog.status')
  })

  it('lets an unlisted sub-verb keep the verb tier rather than inventing a lower one', () => {
    // `theme set` is not in the table, so it answers to `theme` — which is `mutate`.
    expect(cliActionId(['theme', 'set', 'dracula'])).toBe('cli.theme')
    expect(cliActionId(['capture', 'region', '--ask'])).toBe('cli.capture')
  })

  it('refuses what the table does not have, including the retired verbs', () => {
    expect(cliActionId(['os', 'notify'])).toBeNull()
    expect(cliActionId(['os-run', 'page.open'])).toBeNull()
    expect(cliActionId(['definitely-not-a-verb'])).toBeNull()
    expect(cliActionId([])).toBeNull()
  })
})

describe('the gate over the host actions', () => {
  it('refuses an action the catalogue does not declare, and writes it down', async () => {
    const { gate, journal } = hostDoor()
    const refused = await gate.submitLocal({ client: 'ui', command: 'cli.os', args: {}, source: 'services' })

    expect(refused.kind).toBe('reply')
    expect(refused.kind === 'reply' ? refused.reply.code : '').toBe('unsupported')

    const [entry] = lines(journal)

    expect(entry).toMatchObject({ client: 'ui', command: 'cli.os', allowed: false, code: 'unsupported', source: 'services' })
  })

  it('lets the person’s own window install, with a journal line, and never a plugin', async () => {
    const { gate, journal } = hostDoor()
    const window = await gate.submitLocal({ client: 'ui', command: 'cli.install', args: {}, source: 'services' })

    expect(window.kind).toBe('execute')
    expect(window.kind === 'execute' ? window.call.tier : '').toBe('mutate')
    window.kind === 'execute' && window.finish({ ok: true })

    // No approver is configured here: a mutation a *plugin* asks for cannot be approved, so it cannot
    // run at all — the same catalogue that lets the window through stops the plugin.
    const plugin = await gate.submitLocal({ command: 'cli.install', args: {}, source: 'plugin:notes' })

    expect(plugin.kind).toBe('reply')
    expect(plugin.kind === 'reply' ? plugin.reply.ok : true).toBe(false)

    const [allowed, denied] = lines(journal)

    expect(allowed).toMatchObject({ client: 'ui', command: 'cli.install', tier: 'mutate', allowed: true, code: 'ok', source: 'services' })
    expect(denied).toMatchObject({ client: 'plugin', command: 'cli.install', tier: 'mutate', allowed: false, source: 'plugin:notes' })
  })

  it('checks the arguments of a plugin administration action', async () => {
    const { gate } = hostDoor()
    const missing = await gate.submitLocal({ client: 'ui', command: PLUGIN_ACTIONS.setEnabled, args: { id: 'notes' }, source: 'plugins-admin' })
    const wrongType = await gate.submitLocal({ client: 'ui', command: PLUGIN_ACTIONS.setEnabled, args: { id: 'notes', enabled: 'yes' }, source: 'plugins-admin' })
    const undeclared = await gate.submitLocal({ client: 'ui', command: PLUGIN_ACTIONS.add, args: { url: 'https://example.test/p.git', extra: 1 }, source: 'plugins-admin' })

    expect(missing.kind === 'reply' ? missing.reply.error : '').toMatch(/needs enabled/)
    expect(wrongType.kind === 'reply' ? wrongType.reply.error : '').toMatch(/enabled as a boolean/)
    expect(undeclared.kind === 'reply' ? undeclared.reply.error : '').toMatch(/does not take extra/)
  })

  it('lets the window reboot the machine, and refuses the same action from a plugin', async () => {
    const { gate, journal } = hostDoor()
    // The power menu's confirmation is the person's; the gate tiers it and writes it down.
    const window = await gate.submitLocal({ client: 'ui', command: POWER_ACTIONS.reboot, args: {}, source: 'power' })

    expect(window.kind).toBe('execute')
    expect(window.kind === 'execute' ? window.call.tier : '').toBe('destructive')
    window.kind === 'execute' && window.finish({ ok: true })

    const plugin = await gate.submitLocal({ client: 'plugin', command: POWER_ACTIONS.poweroff, args: {}, source: 'plugin:evil' })

    expect(plugin.kind).toBe('reply')
    expect(plugin.kind === 'reply' ? plugin.reply.ok : true).toBe(false)

    const idle = await gate.submitLocal({ client: 'ui', command: IDLE_RESTART_ACTION, args: {}, source: 'idle' })

    expect(idle.kind).toBe('execute')
    idle.kind === 'execute' && idle.finish({ ok: true })

    const [powered, denied, restarted] = lines(journal)

    expect(powered).toMatchObject({ client: 'ui', command: POWER_ACTIONS.reboot, tier: 'destructive', allowed: true, code: 'ok', source: 'power' })
    expect(denied).toMatchObject({ client: 'plugin', command: POWER_ACTIONS.poweroff, tier: 'destructive', allowed: false, source: 'plugin:evil' })
    expect(restarted).toMatchObject({ client: 'ui', command: IDLE_RESTART_ACTION, tier: 'mutate', allowed: true, code: 'ok', source: 'idle' })
  })
})
