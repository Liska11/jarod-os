import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const handlers = new Map<string, (...args: unknown[]) => unknown>()
const listed = { name: 'Notes', path: path.join(process.cwd(), 'fake-apps', 'Notes.exe'), bundleId: undefined as string | undefined }

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: () => null },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    }
  }
}))

vi.mock('../platform/index.ts', () => ({
  hostPlatform: () => ({ listInstalledApps: async () => [listed], launchApp: vi.fn(async () => {}), appIcon: vi.fn(async () => Buffer.from('icon')) })
}))

const { registerAppsIpc } = await import('./apps.ts')
const { IPC } = await import('../../shared/ipc.ts')

registerAppsIpc()

const call = (channel: string, ...args: unknown[]): unknown => handlers.get(channel)!(null, ...args)

describe('the icon surface only answers for an application the catalog lists', () => {
  it('refuses a path the model wrote before any extractor runs', async () => {
    await expect(call(IPC.appsIcon, path.join(process.cwd(), 'fake-downloads', 'setup.lnk'))).rejects.toThrow('not an application installed on this machine')
  })

  it('still renders the icon of a listed application', async () => {
    await expect(call(IPC.appsIcon, listed.path)).resolves.toMatch(/^data:image\/png/)
  })
})
