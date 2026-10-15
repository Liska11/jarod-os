import { afterEach, describe, expect, it, vi } from 'vitest'
import { ControlSecurity, type ControlTokens } from './control-authz.ts'
import { ControlSocket } from './control-socket.ts'
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
const opened: unknown[] = []

afterEach(() => {
  opened.length = 0
})

function door(bridge?: OsCommandBridge) {
  const relayed: Array<Record<string, unknown>> = []
  const shell = {
    relay: (_window: string, command: Record<string, unknown>) => relayed.push(command),
    open: (_target: string, command: unknown) => opened.push(command)
  } as unknown as ShellHost
  const audited: Array<{ allowed: boolean; reason: string }> = []
  const security = new ControlSecurity({ tokens: TOKENS }, entry => audited.push({ allowed: entry.allowed, reason: entry.reason }))
  const socket = new ControlSocket(shell, undefined, bridge, undefined, undefined, undefined, security)

  return { socket, relayed, audited }
}

describe('the CLI door on the panel socket', () => {
  it('relays `os` for the CLI token only, and journals every attempt', async () => {
    const { socket, relayed, audited } = door()

    expect(await socket.handle({ cmd: 'os', args: ['memory.forget'] })).toEqual({ ok: false, error: 'invalid control token' })
    expect(await socket.handle({ cmd: 'os', args: ['memory.forget'], token: 'guessed' })).toEqual({ ok: false, error: 'invalid control token' })
    // The backend's token is not a licence for the CLI's door: the agent's own path is the registry.
    expect(await socket.handle({ cmd: 'os', args: ['memory.forget'], token: TOKENS.backend })).toEqual({ ok: false, error: 'the os command needs the CLI token' })
    expect(await socket.handle({ cmd: 'os', args: ['memory.forget'], token: TOKENS.cli })).toEqual({ ok: true })

    expect(relayed).toEqual([{ type: 'os', args: ['memory.forget'], payload: undefined }])
    expect(audited).toEqual([
      { allowed: false, reason: 'invalid control token' },
      { allowed: false, reason: 'invalid control token' },
      { allowed: false, reason: 'the os command needs the CLI token' },
      { allowed: true, reason: 'os runs memory.forget' }
    ])
  })

  it('refuses `os`/`os-run` with no command id, and `os-run` without a registry', async () => {
    const { socket, relayed } = door()

    expect(await socket.handle({ cmd: 'os', args: [], token: TOKENS.cli })).toEqual({ ok: false, error: 'os needs a command id' })
    expect(await socket.handle({ cmd: 'os-run', args: [], token: TOKENS.cli })).toEqual({ ok: false, error: 'os-run needs a command id' })
    expect(await socket.handle({ cmd: 'os-run', args: ['memory.forget'], token: TOKENS.cli })).toEqual({ ok: false, error: 'the command registry is not available' })
    expect(relayed).toEqual([])
  })

  it('waits for `os-run` and keeps the backend off the panel-only powers', async () => {
    const bridge = {
      run: async (command: string) => ({ requestId: 'r1', result: { ok: true, summary: `ran ${command}`, data: { command } } })
    } as unknown as OsCommandBridge
    const { socket, relayed } = door(bridge)

    expect(await socket.handle({ cmd: 'os-run', args: ['memory.forget', '{"match":"x"}'], token: TOKENS.cli })).toEqual({
      ok: true,
      summary: 'ran memory.forget',
      data: { command: 'memory.forget' }
    })
    expect(relayed).toEqual([])
    // A panel command a human would have to type: the CLI may ask, the backend may not.
    expect(await socket.handle({ cmd: 'wallpaper', wallpaper: '/tmp/a.png', token: TOKENS.backend })).toEqual({
      ok: false,
      error: 'the wallpaper command needs the CLI token'
    })
  })

  it('still lets the backend run registry commands through the bridge', async () => {
    const bridge = {
      list: async () => ({ requestId: 'r1', result: [{ id: 'memory.forget', tier: 'destructive' }] })
    } as unknown as OsCommandBridge
    const { socket } = door(bridge)
    const reply = await socket.handle({ cmd: 'ui-list', token: TOKENS.backend })

    expect(reply).toEqual({ ok: true, result: [{ id: 'memory.forget', tier: 'destructive' }] })
  })

  it('refuses a command this door does not serve, with the attempt still journalled', async () => {
    const { socket, relayed, audited } = door()

    expect(await socket.handle({ cmd: 'made-up', token: TOKENS.cli })).toEqual({ ok: false, error: 'unknown command made-up' })
    expect(relayed).toEqual([])
    // The policy does not know the CLI's command table — the dispatcher below owns it — so it lets the
    // request through and the dispatcher is what refuses. The attempt is written down either way; the
    // `allowed` field records the policy's answer, not the reply the caller got.
    expect(audited).toEqual([{ allowed: true, reason: 'made-up is a CLI command' }])
  })
})
