import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

/**
 * The registered fs handlers, captured as the shell registers them: the test drives the same entry points a window
 * calls, so a guard that is not wired to a handler fails here.
 */
const handlers = new Map<string, (...args: unknown[]) => unknown>()

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: () => null },
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    }
  },
  nativeImage: { createFromPath: () => ({ getSize: () => ({ width: 0, height: 0 }) }) },
  shell: { openPath: vi.fn(async () => ''), openExternal: vi.fn(async () => {}), showItemInFolder: vi.fn(), trashItem: vi.fn(async () => {}) }
}))

vi.mock('../platform/index.ts', () => ({
  hostPlatform: () => ({ revealPath: vi.fn(), openIn: vi.fn(async () => {}), thumbnail: vi.fn(async () => ''), recentFiles: vi.fn(async () => []), findFiles: vi.fn(async () => []) })
}))

const { registerFsIpc } = await import('./fs.ts')
const { IPC } = await import('../../shared/ipc.ts')

registerFsIpc(() => null)

const call = (channel: string, ...args: unknown[]): unknown => handlers.get(channel)!(null, ...args)

describe('the file surface refuses protected paths before it touches the disk', () => {
  const home = os.homedir()
  const ssh = path.join(home, '.ssh')

  it('fsReadFile, fsReadDir and fsDirSize refuse the SSH folder', async () => {
    await expect(call(IPC.fsReadFile, path.join(ssh, 'id_ed25519'))).rejects.toThrow('protected location')
    await expect(call(IPC.fsReadDir, ssh)).rejects.toThrow('protected location')
    await expect(call(IPC.fsDirSize, ssh)).rejects.toThrow('protected location')
  })

  it('fsReveal and fsOpenIn refuse it too', () => {
    expect(() => call(IPC.fsReveal, path.join(ssh, 'id_ed25519'))).toThrow('protected location')
    expect(() => call(IPC.fsOpenIn, 'code', path.join(ssh, 'config'))).toThrow('protected location')
  })

  it('fsOpenPath refuses a protected path and anything the default action would run', async () => {
    await expect(call(IPC.fsOpenPath, path.join(ssh, 'id_ed25519'))).rejects.toThrow('protected location')
    await expect(call(IPC.fsOpenPath, path.join(home, 'Documents', 'setup.ps1'))).rejects.toThrow('program or a script')
    await expect(call(IPC.fsOpenPath, path.join(home, 'Documents', 'start.lnk'))).rejects.toThrow('program or a script')
  })

  it('still reads and opens an ordinary document in the home folder', async () => {
    const document = path.join(home, 'Documents', 'notes.md')

    await expect(call(IPC.fsOpenPath, document)).resolves.toBeUndefined()
    await expect(call(IPC.fsReadDir, home)).resolves.toBeInstanceOf(Array)
  })
})
