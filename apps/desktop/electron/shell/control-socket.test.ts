import { afterEach, describe, expect, it, vi } from 'vitest'
import { asControlTier, ControlSecurity, type ControlAuditEntry, type ControlTier, type ControlTokens } from './control-authz.ts'
import { ControlSocket } from './control-socket.ts'
import type { ApprovalProvider, CatalogueEntry } from './host-control.ts'
import { HostControlGate } from './host-control.ts'
import type { ShellHost } from './host.ts'
import type { OsCommandBridge } from './os-control.ts'

// `control-socket.ts` pulls in the event bus, the menu extensions and the branding store, all of which
// register Electron listeners; the CLI door under test needs none of that runtime.
vi.mock('electron', () => ({
  BrowserWindow: class {},
  app: { getPath: () => '', getVersion: () => '0.0.0', on: vi.fn(), setName: vi.fn(), setPath: vi.fn() },
  dialog: { showMessageBox: vi.fn(), showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
  ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn() },
  nativeImage: { createFromPath: vi.fn() },
  powerMonitor: { on: vi.fn() },
  screen: { getPrimaryDisplay: vi.fn() },
  shell: { openExternal: vi.fn(), showItemInFolder: vi.fn() }
}))

const TOKENS: ControlTokens = { backend: 'backend-token-000000000001', cli: 'cli-token-00000000000001' }
const CATALOGUE: CatalogueEntry[] = [
  { id: 'bar.list', tier: 'read' },
  { id: 'memory.forget', tier: 'destructive', args: [{ name: 'match' }] }
]
const opened: unknown[] = []

afterEach(() => {
  opened.length = 0
})

interface DoorOptions {
  approve?: ApprovalProvider
  catalogue?: CatalogueEntry[]
  now?: () => number
}

function door(bridge?: OsCommandBridge, options: DoorOptions = {}) {
  const relayed: Array<Record<string, unknown>> = []
  const shell = {
    relay: (_window: string, command: Record<string, unknown>) => relayed.push(command),
    open: (_target: string, command: unknown) => opened.push(command)
  } as unknown as ShellHost
  const audited: ControlAuditEntry[] = []
  const security = new ControlSecurity({ tokens: TOKENS }, entry => audited.push(entry))
  const catalogue = options.catalogue ?? CATALOGUE
  const tiers = new Map<string, ControlTier>()

  for (const entry of catalogue) {
    const tier = asControlTier(entry.tier)

    if (tier) {
      tiers.set(entry.id, tier)
    }
  }

  security.setCatalogue(id => tiers.get(id))
  const gate = new HostControlGate({ security, approve: options.approve, now: options.now })

  gate.setCatalogue(catalogue)

  const socket = new ControlSocket(shell, undefined, bridge, undefined, undefined, undefined, gate)

  return { socket, relayed, audited, tiers }
}

describe('the CLI door on the panel socket', () => {
  it('refuses the retired generic registry door, and journals the refusal', async () => {
    const { socket, relayed, audited } = door()

    expect(await socket.handle({ cmd: 'os', args: ['memory.forget'], token: TOKENS.cli })).toEqual({
      ok: false,
      code: 'unsupported',
      error: 'os was replaced by run/list/state'
    })
    expect(await socket.handle({ cmd: 'os-run', args: ['memory.forget'], token: TOKENS.cli })).toEqual({
      ok: false,
      code: 'unsupported',
      error: 'os-run was replaced by run/list/state'
    })

    expect(relayed).toEqual([])
    expect(audited.map(entry => [entry.cmd, entry.allowed, entry.code])).toEqual([
      ['os', false, 'unsupported'],
      ['os-run', false, 'unsupported']
    ])
  })

  it('refuses a caller with no credential, and one guessing the backend token', async () => {
    const { socket, audited } = door()

    expect(await socket.handle({ cmd: 'run', command: 'bar.list', args: {} })).toEqual({
      ok: false,
      code: 'unauthenticated',
      error: 'invalid control token'
    })
    expect(await socket.handle({ cmd: 'run', command: 'bar.list', args: {}, token: 'guessed' })).toEqual({
      ok: false,
      code: 'unauthenticated',
      error: 'invalid control token'
    })

    expect(audited.every(entry => entry.allowed === false)).toBe(true)
  })

  it('keeps the backend off the person\u2019s own surface', async () => {
    const { socket, relayed } = door()

    // The agent's path to the registry is `ui`; a panel command is the person at the keyboard.
    expect(await socket.handle({ cmd: 'wallpaper', args: ['/tmp/a.png'], wallpaper: '/tmp/a.png', token: TOKENS.backend })).toEqual({
      ok: false,
      code: 'unauthorized',
      error: 'the wallpaper command needs the CLI token'
    })
    // `os`/`os-run` were the backend's generic door; nothing replaced them for a non-CLI caller.
    expect(await socket.handle({ cmd: 'run', command: 'memory.forget', args: {}, token: TOKENS.backend })).toEqual({
      ok: false,
      code: 'unauthorized',
      error: 'the run command needs the CLI token'
    })
    expect(relayed).toEqual([])
  })

  it('refuses a command this door does not serve, without forwarding it', async () => {
    const { socket, relayed, audited } = door()

    expect(await socket.handle({ cmd: 'made-up', token: TOKENS.cli })).toEqual({
      ok: false,
      code: 'unsupported',
      error: 'unknown command made-up'
    })
    expect(relayed).toEqual([])
    // The policy owns the command table, so the refusal is recorded as a policy decision rather than
    // as an allow that a dispatcher later contradicts.
    expect(audited).toEqual([
      expect.objectContaining({ allowed: false, code: 'unsupported', reason: 'unknown command made-up' })
    ])
  })

  it('runs a read command with a credential alone', async () => {
    const run = vi.fn(async (command: string) => ({ requestId: 'r1', result: { ok: true, summary: `ran ${command}` } }))
    const bridge = { run } as unknown as OsCommandBridge
    const { socket, audited } = door(bridge)

    expect(await socket.handle({ cmd: 'run', command: 'bar.list', args: {}, token: TOKENS.cli })).toEqual({ ok: true, summary: 'ran bar.list', code: 'ok' })
    expect(run).toHaveBeenCalledTimes(1)
    expect(audited.at(-1)).toMatchObject({ allowed: true, tier: 'read' })
  })

  it('does not run a mutation when the shell has no approval channel', async () => {
    const run = vi.fn(async () => ({ requestId: 'r1', result: { ok: true } }))
    const { socket, relayed, audited } = door({ run } as unknown as OsCommandBridge)

    expect(await socket.handle({ cmd: 'run', command: 'memory.forget', args: { match: 'x' }, token: TOKENS.cli })).toEqual({
      ok: false,
      code: 'denied-policy',
      error: 'no approval channel is available'
    })

    // Zero side effects: nothing reached the registry, nothing reached the window.
    expect(run).not.toHaveBeenCalled()
    expect(relayed).toEqual([])
    expect(audited.at(-1)).toMatchObject({ allowed: false, code: 'denied-policy' })
  })

  it('refuses the mutation when the person says no', async () => {
    const run = vi.fn(async () => ({ requestId: 'r1', result: { ok: true } }))
    const { socket } = door({ run } as unknown as OsCommandBridge, { approve: () => false })
    const request = { cmd: 'run', command: 'memory.forget', args: { match: 'x' }, token: TOKENS.cli }

    expect(await socket.handle(request)).toEqual({ ok: false, code: 'denied-approval', error: 'the request was not approved' })
    expect(run).not.toHaveBeenCalled()
  })

  it('runs a mutation only once, only for the approved call, and only with the capability', async () => {
    const run = vi.fn(async () => ({ requestId: 'r1', result: { ok: true, summary: 'forgot x' } }))
    const approve = vi.fn(() => true)
    const { socket, audited } = door({ run } as unknown as OsCommandBridge, { approve })
    const request = { cmd: 'run', command: 'memory.forget', args: { match: 'x' }, token: TOKENS.cli }

    const granted = await socket.handle(request)

    // The approval is a first step, not a licence: the call has not run yet.
    expect(granted).toMatchObject({ ok: false, code: 'approval-granted' })
    expect(run).not.toHaveBeenCalled()

    const capability = (granted as { capability?: { id: string } }).capability?.id

    expect(typeof capability).toBe('string')
    expect(await socket.handle({ ...request, capability })).toMatchObject({ ok: true, code: 'ok', summary: 'forgot x' })
    expect(run).toHaveBeenCalledTimes(1)

    // The same capability again: the journal says so, and the registry is not called a second time.
    expect(await socket.handle({ ...request, capability })).toMatchObject({ ok: false, code: 'replay' })
    expect(run).toHaveBeenCalledTimes(1)

    // The same capability pointed at different arguments is not the call that was approved.
    const again = (await socket.handle(request)) as { capability?: { id: string } }

    expect(await socket.handle({ ...request, args: { match: 'y' }, capability: again.capability?.id })).toMatchObject({
      ok: false,
      code: 'capability-mismatch'
    })
    expect(run).toHaveBeenCalledTimes(1)
    expect(audited.map(entry => entry.code)).toEqual(['approval-granted', 'ok', 'replay', 'approval-granted', 'capability-mismatch'])
  })

  it('refuses a capability that has expired', async () => {
    let clock = 1_000
    const approve = vi.fn(() => true)
    const { socket } = door({ run: vi.fn(async () => ({ requestId: 'r1', result: { ok: true } })) } as unknown as OsCommandBridge, {
      approve,
      now: () => clock
    })
    const request = { cmd: 'run', command: 'memory.forget', args: { match: 'x' }, token: TOKENS.cli }
    const granted = (await socket.handle(request)) as { capability?: { id: string } }

    clock += 10 * 60_000

    expect(await socket.handle({ ...request, capability: granted.capability?.id })).toMatchObject({ ok: false, code: 'expired' })
  })

  it('still lets the backend run registry commands through the bridge', async () => {
    const bridge = {
      list: async () => ({ requestId: 'r1', result: [{ id: 'memory.forget', tier: 'destructive' }] })
    } as unknown as OsCommandBridge
    const { socket } = door(bridge)

    expect(await socket.handle({ cmd: 'ui-list', token: TOKENS.backend })).toEqual({
      ok: true,
      result: [{ id: 'memory.forget', tier: 'destructive' }],
      code: 'ok'
    })
  })
})
