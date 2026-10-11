import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getFileIcon: async () => ({ isEmpty: () => true, toPNG: () => Buffer.alloc(0) }) },
  nativeImage: { createThumbnailFromPath: async () => ({ isEmpty: () => true, toPNG: () => Buffer.alloc(0) }) },
  shell: { openPath: async () => '', showItemInFolder: () => undefined }
}))

const { WindowsPlatform } = await import('./windows.ts')

// The real PowerShell scripts against the real machine: read-only, and skipped off Windows.
describe.skipIf(process.platform !== 'win32')('WindowsPlatform on Windows', () => {
  const platform = new WindowsPlatform()

  it('describes the machine', async () => {
    const info = await platform.systemInfo()

    expect(info.platform).toBe('win32')
    expect(info.osName).toMatch(/Windows/)
    expect(info.cpuCount).toBeGreaterThan(0)
  })

  it('samples CPU, memory, disks and battery', async () => {
    const stats = await platform.sampleStats()

    expect(stats.memoryTotal).toBeGreaterThan(0)
    expect(stats.disks.length).toBeGreaterThan(0)
    expect(stats.disks[0]).toMatchObject({ mount: expect.stringMatching(/^[A-Z]:\\$/) })
    expect(typeof stats.battery.present).toBe('boolean')
  }, 30_000)

  it('lists the heaviest processes with their owner', async () => {
    const rows = await platform.listProcesses('memory', 5)

    expect(rows.length).toBeGreaterThan(0)
    expect(rows.length).toBeLessThanOrEqual(5)
    expect(rows[0].rssBytes).toBeGreaterThanOrEqual(rows[rows.length - 1].rssBytes)
    expect(rows.every(row => row.pid > 0 && row.name.length > 0)).toBe(true)
  }, 60_000)

  it('lists Start-menu applications as shell:AppsFolder entries', async () => {
    const apps = await platform.listInstalledApps()

    expect(apps.length).toBeGreaterThan(0)
    expect(apps.every(app => app.path.startsWith('shell:AppsFolder\\'))).toBe(true)
  }, 40_000)

  it('reports a network interface when online and has no calendar', async () => {
    const network = await platform.networkStatus()

    expect(typeof network.online).toBe('boolean')
    expect((await platform.calendarToday()).status).toBe('unavailable')
  })

  it('reads the Recent folder and finds a file by name under home', async () => {
    const recent = await platform.recentFiles(20)

    expect(Array.isArray(recent)).toBe(true)
    expect(recent.every(file => file.kind === 'file')).toBe(true)
    expect(await platform.findFiles('', 5)).toEqual([])
  }, 60_000)

  it('refuses to change quick-panel settings and says why', async () => {
    await expect(platform.controlAction({ panel: 'wifi', action: 'scan' })).rejects.toThrow(/Windows Settings/)
    expect((await platform.controlStatus('bluetooth')).panel).toBe('bluetooth')
  })
})
