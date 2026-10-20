/**
 * R3: the shell bus is the shell's own UI traffic, not an execution channel.
 *
 * The command overlay (panels mode) and the control menu used to run a registry command by sending
 * `{ type: 'os', args: [id], payload }` to the Hermes window, which called `runCommand` directly:
 * nothing checked the id against the catalogue and nothing was written down. `handleShellCommand` now
 * hands such a message to the host gate (`window.jarodOS.control.run`) and runs nothing itself.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const controlRun = vi.fn(async () => ({ ok: true }))
const runCommand = vi.fn(async (_id: string, _args: Record<string, unknown>) => ({ ok: true, summary: 'ran' }))

vi.mock('./os-commands.ts', () => ({ runCommand: (id: string, args: Record<string, unknown>) => runCommand(id, args) }))
vi.mock('./backend.ts', () => ({ updatePrefs: vi.fn() }))
vi.mock('./chat.ts', () => ({ openStoredSession: vi.fn(), runSlash: vi.fn(), sendPrompt: vi.fn() }))
vi.mock('./crashes.ts', () => ({ offerCrashHelp: vi.fn() }))
vi.mock('./emoji.ts', () => ({ openEmojiPicker: vi.fn() }))
vi.mock('./notifications.ts', () => ({ $notificationsOpen: { get: () => false, set: () => undefined }, notify: vi.fn() }))
vi.mock('./status-panel.ts', () => ({ openStatusPanel: vi.fn() }))
vi.mock('./switches.ts', () => ({ $screensaverUp: { set: () => undefined } }))
vi.mock('./surface.ts', () => ({ $applicationsOpen: { set: () => undefined }, openAsk: vi.fn(), toggleCommandBar: vi.fn() }))
vi.mock('./web-windows.ts', () => ({ openWebWindow: vi.fn() }))
vi.mock('./windows.ts', () => ({ openApp: vi.fn(), showPage: vi.fn() }))
vi.mock('../lib/herald-os-cli.ts', () => ({ runJarodOsWithToast: vi.fn() }))
vi.mock('../shell/surfaces/shell-utils.ts', () => ({ composePrompt: () => '' }))

// `store/shell.ts` reads the surface from the preload at load time, so the bridge exists first.
;(globalThis as unknown as { window: unknown }).window = {
  jarodOS: { control: { run: controlRun }, shell: { surface: 'main', mode: 'panels' } }
}

const { handleShellCommand } = await import('./shell-commands.ts')

beforeEach(() => {
  controlRun.mockClear()
  runCommand.mockClear()
})

describe('handleShellCommand', () => {
  it('sends the retired `os` message through the host gate rather than running it here', () => {
    handleShellCommand({ type: 'os', args: ['page.open'], payload: { name: 'memory' } })

    expect(controlRun).toHaveBeenCalledWith('page.open', { name: 'memory' })
    // The renderer must not reach the registry itself: only the gate may.
    expect(runCommand).not.toHaveBeenCalled()
  })

  it('ignores an `os` message with no command id, and one the bus never carried', () => {
    handleShellCommand({ type: 'os' })
    handleShellCommand({ type: 'os-run', args: ['page.open'] })

    expect(controlRun).not.toHaveBeenCalled()
    expect(runCommand).not.toHaveBeenCalled()
  })
})
