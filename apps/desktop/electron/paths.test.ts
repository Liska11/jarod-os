import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { isShellPage, shellConfigDir } from './paths.ts'

const index = '/Applications/Jarod-OS.app/Contents/Resources/app.asar/dist/renderer/index.html'
const page = pathToFileURL(index).href

describe('isShellPage', () => {
  it('accepts the bundled renderer with any query or hash', () => {
    expect(isShellPage(page, index, undefined)).toBe(true)
    expect(isShellPage(`${page}?surface=dock`, index, undefined)).toBe(true)
    expect(isShellPage(`${page}#/settings`, index, undefined)).toBe(true)
  })

  it('refuses every other local file and remote page in a build', () => {
    expect(isShellPage('file:///Users/me/Downloads/page.html', index, undefined)).toBe(false)
    expect(isShellPage('https://example.com/', index, undefined)).toBe(false)
    expect(isShellPage('not a url', index, undefined)).toBe(false)
  })

  it('accepts only the dev server origin in development', () => {
    const dev = 'http://127.0.0.1:5180'

    expect(isShellPage('http://127.0.0.1:5180/?surface=main', index, dev)).toBe(true)
    expect(isShellPage('http://127.0.0.1:51801/', index, dev)).toBe(false)
    expect(isShellPage(page, index, dev)).toBe(false)
  })
})

describe('shellConfigDir', () => {
  it('uses a Windows settings folder on Windows and the XDG-style folder elsewhere', () => {
    expect(shellConfigDir('win32', { APPDATA: 'C:\\Users\\San\\AppData\\Roaming' }, 'C:\\Users\\San')).toBe('C:\\Users\\San\\AppData\\Roaming\\Jarod-OS\\config')
    expect(shellConfigDir('win32', {}, 'C:\\Users\\San')).toBe('C:\\Users\\San\\AppData\\Roaming\\Jarod-OS\\config')
    expect(shellConfigDir('linux', {}, '/home/san')).toBe(path.join('/home/san', '.config', 'herald-os'))
  })

  it('follows HERALD_OS_CONFIG_DIR when set', () => {
    expect(shellConfigDir('win32', { HERALD_OS_CONFIG_DIR: 'D:\\Portable\\config' }, 'C:\\Users\\San')).toBe('D:\\Portable\\config')
  })
})
