import { afterEach, describe, expect, it, vi } from 'vitest'

const handlers = new Map<string, (...args: unknown[]) => unknown>()
const recentFiles = vi.fn(async () => [{ path: 'C:\\real\\private-plans.docx' }])
const findFiles = vi.fn(async () => [{ path: 'C:\\real\\plans.docx' }])

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: () => null },
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
  ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => void handlers.set(channel, handler) },
  nativeImage: { createFromPath: () => ({ getSize: () => ({ width: 0, height: 0 }) }) },
  shell: { openPath: vi.fn(async () => ''), openExternal: vi.fn(async () => {}), showItemInFolder: vi.fn(), trashItem: vi.fn(async () => {}) }
}))

vi.mock('../platform/index.ts', () => ({
  hostPlatform: () => ({ revealPath: vi.fn(), openIn: vi.fn(async () => {}), thumbnail: vi.fn(async () => ''), recentFiles, findFiles })
}))

const { registerFsIpc } = await import('./fs.ts')
const { IPC } = await import('../../shared/ipc.ts')

registerFsIpc(() => null)

const call = (channel: string, ...args: unknown[]): unknown => handlers.get(channel)!(null, ...args)

describe('an isolated profile never reads the real one through the recent and find surfaces', () => {
  afterEach(() => {
    delete process.env.JAROD_OS_ISOLATED
    recentFiles.mockClear()
    findFiles.mockClear()
  })

  it('without isolation the host platform answers', async () => {
    expect(await call(IPC.fsRecent, 4)).toHaveLength(1)
    expect(await call(IPC.fsFind, 'plans', 4)).toHaveLength(1)
  })

  it('with JAROD_OS_ISOLATED=1 both return nothing and the platform is never asked', async () => {
    process.env.JAROD_OS_ISOLATED = '1'
    expect(await call(IPC.fsRecent, 4)).toEqual([])
    expect(await call(IPC.fsFind, 'plans', 4)).toEqual([])
    expect(recentFiles).not.toHaveBeenCalled()
    expect(findFiles).not.toHaveBeenCalled()
  })

  it('JAROD_OS_ISOLATED=0 does not isolate', async () => {
    process.env.JAROD_OS_ISOLATED = '0'
    expect(await call(IPC.fsRecent, 4)).toHaveLength(1)
  })
})
