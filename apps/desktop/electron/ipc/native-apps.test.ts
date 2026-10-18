import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ ipcMain: { handle: () => undefined } }))
vi.mock('../log.ts', () => ({ log: () => undefined }))

const { findNativeApp, launchArgument, wingetInstall } = await import('./native-apps.ts')
const { fileOfMediaUrl, mediaUrl, parseRange } = await import('./media.ts')

describe('native apps', () => {
  const env = { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local', ProgramFiles: 'C:\\Program Files' }

  it('finds Signal and VLC where their installers put them', () => {
    const present = new Set(['C:\\Users\\me\\AppData\\Local\\Programs\\signal-desktop\\Signal.exe', 'C:\\Program Files\\VideoLAN\\VLC\\vlc.exe'])

    expect(findNativeApp('signal', env, file => present.has(file), 'win32')).toBe('C:\\Users\\me\\AppData\\Local\\Programs\\signal-desktop\\Signal.exe')
    expect(findNativeApp('vlc', env, file => present.has(file), 'win32')).toBe('C:\\Program Files\\VideoLAN\\VLC\\vlc.exe')
    expect(findNativeApp('brave', env, file => present.has(file), 'win32')).toBeNull()
    expect(findNativeApp('vlc', env, () => true, 'linux')).toBeNull()
  })

  it('hands over only a web page to Brave and an existing file to VLC', () => {
    expect(launchArgument('brave', 'https://example.com/')).toEqual(['https://example.com/'])
    expect(launchArgument('brave', '--disable-web-security')).toEqual([])
    expect(launchArgument('vlc', 'C:\\Films\\a.mkv', () => true)).toEqual(['--', 'C:\\Films\\a.mkv'])
    expect(launchArgument('vlc', '--extraintf=http', () => true)).toEqual([])
    expect(launchArgument('vlc', 'C:\\missing.mkv', () => false)).toEqual([])
    expect(launchArgument('signal', 'anything')).toEqual([])
  })

  it('finds MovieBox GUI, which winget does not carry', () => {
    expect(findNativeApp('moviebox', env, file => file === 'C:\\Program Files\\MovieBox GUI\\moviebox-gui.exe', 'win32')).toBe('C:\\Program Files\\MovieBox GUI\\moviebox-gui.exe')
    expect(wingetInstall('moviebox')).toBeNull()
  })

  it('installs with winget, exact id, without upgrading', () => {
    const { command, args } = wingetInstall('signal') ?? { command: '', args: [] }

    expect(command).toBe('winget')
    expect(args).toEqual(expect.arrayContaining(['install', '--id', 'OpenWhisperSystems.Signal', '--exact', '--no-upgrade', '--silent']))
  })
})

describe('jarod-media', () => {
  it('round-trips a file path through its URL', () => {
    const file = 'C:\\Vidéos\\été 2026\\a #1.mp4'

    expect(fileOfMediaUrl(mediaUrl(file))).toBe(file)
    expect(fileOfMediaUrl('jarod-media://other/abc')).toBeNull()
    expect(fileOfMediaUrl('file:///C:/a.mp4')).toBeNull()
  })

  it('reads byte ranges', () => {
    expect(parseRange('bytes=0-', 1000)).toEqual({ start: 0, end: 999 })
    expect(parseRange('bytes=100-199', 1000)).toEqual({ start: 100, end: 199 })
    expect(parseRange('bytes=900-5000', 1000)).toEqual({ start: 900, end: 999 })
    expect(parseRange('bytes=-100', 1000)).toEqual({ start: 900, end: 999 })
    expect(parseRange('bytes=2000-', 1000)).toBeNull()
    expect(parseRange(null, 1000)).toBeNull()
    expect(parseRange('items=0-1', 1000)).toBeNull()
  })
})
