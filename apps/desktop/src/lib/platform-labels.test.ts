import { afterEach, describe, expect, it } from 'vitest'
import { $env } from '../store/backend.ts'
import { deviceNoun, hostPlatform, platformOfAgent, revealLabel, shortcutLabel, voiceKeyLabel } from './platform-labels.ts'

const onPlatform = (platform: NodeJS.Platform) => $env.set({ platform, hermesHome: '/h/.hermes', homeDir: '/h', version: '0.0.0', isDev: false, shellMode: 'panels', safeMode: false, userDataDir: '/h/.config/Jarod-OS', lastCrash: null })

afterEach(() => $env.set(null))

describe('shortcutLabel', () => {
  it('spells shortcuts the Mac way on macOS', () => {
    onPlatform('darwin')

    expect(shortcutLabel('1')).toBe('⌘1')
    expect(shortcutLabel('A', { shift: true })).toBe('⌘⇧A')
  })

  it('names Ctrl on Jarod-OS Linux, which has no Command key', () => {
    onPlatform('linux')

    expect(shortcutLabel('K')).toBe('Ctrl+K')
    expect(shortcutLabel('A', { shift: true })).toBe('Ctrl+Shift+A')
  })
})

describe('voiceKeyLabel', () => {
  it('names the session hotkey on Linux, whatever the Electron hotkey says', () => {
    onPlatform('linux')

    expect(voiceKeyLabel('Alt+Space')).toBe('Super+V')
  })

  it('names the configured hotkey on macOS, and nothing when it is cleared', () => {
    onPlatform('darwin')

    expect(voiceKeyLabel('Alt+Space')).toBe('Alt+Space')
    expect(voiceKeyLabel(' ')).toBeUndefined()
  })
})

describe('hostPlatform before main reports', () => {
  it('reads the user agent of the window, and never assumes macOS', () => {
    expect(platformOfAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Electron/33')).toBe('win32')
    expect(platformOfAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130 Electron/33')).toBe('darwin')
    expect(platformOfAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130 Electron/33')).toBe('linux')
    expect(platformOfAgent('Node.js/22')).toBe('unknown')
  })

  it('uses the generic labels while nothing is known (the test runner has no OS in its user agent)', () => {
    expect(hostPlatform()).toBe('unknown')
    expect(shortcutLabel('K')).toBe('Ctrl+K')
    expect(deviceNoun()).toBe('computer')
    expect(revealLabel()).toBe('Show in Files')
  })

  it('prefers what main reported', () => {
    onPlatform('win32')

    expect(hostPlatform()).toBe('win32')
    expect(revealLabel()).toBe('Show in Explorer')
  })
})
