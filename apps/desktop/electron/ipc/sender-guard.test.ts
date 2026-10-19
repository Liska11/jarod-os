import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { isShellPage } from '../paths.ts'
import { checkSender, installIpcSenderGuard, type SenderFrame } from './sender-guard.ts'

const index = path.resolve('/opt/jarod/resources/app.asar/dist/renderer/index.html')
const packaged = (url: string) => isShellPage(url, index, undefined)
const dev = (url: string) => isShellPage(url, index, 'http://127.0.0.1:5180')
const shellFile = pathToFileURL(index).href

const top = (url: string): SenderFrame => ({ url, parent: null })
const sub = (url: string, parentUrl = shellFile): SenderFrame => ({ url, parent: top(parentUrl) })
const event = (senderFrame: SenderFrame | null) => ({ senderFrame })

describe('checkSender', () => {
  it('accepts the packaged renderer page, with or without a surface query', () => {
    expect(checkSender(event(top(shellFile)), packaged)).toEqual({ ok: true })
    expect(checkSender(event(top(`${shellFile}?surface=emoji`)), packaged)).toEqual({ ok: true })
    expect(checkSender(event(top(`${shellFile}#/settings`)), packaged)).toEqual({ ok: true })
  })

  it('accepts the dev server origin in development', () => {
    expect(checkSender(event(top('http://127.0.0.1:5180/')), dev)).toEqual({ ok: true })
    expect(checkSender(event(top('http://127.0.0.1:5180/?surface=launcher')), dev)).toEqual({ ok: true })
  })

  it('refuses an external site in a top-level frame (web view, web-app window)', () => {
    expect(checkSender(event(top('https://example.com/')), packaged)).toEqual({ ok: false, reason: 'foreign-page' })
    expect(checkSender(event(top('https://example.com/')), dev)).toEqual({ ok: false, reason: 'foreign-page' })
  })

  it('refuses other pages of the same scheme or host', () => {
    // Another file on disk, a dropped HTML file, the recovery page, another port on loopback.
    expect(checkSender(event(top(pathToFileURL(path.resolve('/tmp/evil.html')).href)), packaged).ok).toBe(false)
    expect(checkSender(event(top('data:text/html,<p>recovery</p>')), packaged).ok).toBe(false)
    expect(checkSender(event(top('http://127.0.0.1:5181/')), dev).ok).toBe(false)
    expect(checkSender(event(top(shellFile)), dev).ok).toBe(false)
    expect(checkSender(event(top('herald-plugin://widget/index.html')), packaged).ok).toBe(false)
    expect(checkSender(event(top('jarod-plugin://widget/index.html')), packaged).ok).toBe(false)
  })

  it('refuses a subframe, even one that loads the shell page itself', () => {
    expect(checkSender(event(sub('https://example.com/')), packaged)).toEqual({ ok: false, reason: 'subframe' })
    expect(checkSender(event(sub(shellFile)), packaged)).toEqual({ ok: false, reason: 'subframe' })
    expect(checkSender(event(sub('http://127.0.0.1:5180/', 'http://127.0.0.1:5180/')), dev)).toEqual({ ok: false, reason: 'subframe' })
  })

  it('refuses a missing or disposed frame', () => {
    expect(checkSender(event(null), packaged)).toEqual({ ok: false, reason: 'no-frame' })
    const disposed = {
      get senderFrame(): SenderFrame {
        throw new Error('Render frame was disposed before WebFrameMain could be accessed')
      }
    }
    expect(checkSender(disposed, packaged)).toEqual({ ok: false, reason: 'no-frame' })
  })
})

type Listener = (...args: never[]) => unknown

/** Calls a listener the stand-in kept, the way Electron would: with an event and the sent values. */
const run = (listener: Listener | undefined, ...args: unknown[]) => (listener as (...values: unknown[]) => unknown)(...args)

/** A stand-in for ipcMain: keeps the listeners it was handed so the test can call them. */
function fakeIpc() {
  const handlers = new Map<string, Listener>()
  const listeners = new Map<string, Listener>()
  const ipc = {
    handle: (channel: string, listener: Listener) => void handlers.set(channel, listener),
    handleOnce: (channel: string, listener: Listener) => void handlers.set(channel, listener),
    on(channel: string, listener: Listener) {
      listeners.set(channel, listener)
      return this
    },
    once(channel: string, listener: Listener) {
      listeners.set(channel, listener)
      return this
    }
  }

  return { ipc, handlers, listeners }
}

describe('installIpcSenderGuard', () => {
  it('runs an invoke handler for the shell page and rejects any other sender without logging the payload', () => {
    const { ipc, handlers } = fakeIpc()
    const logger = vi.fn()
    installIpcSenderGuard(ipc as never, { isShell: packaged, logger })
    const handler = vi.fn((_event: unknown, value: string) => `got ${value}`)
    ipc.handle('fs:read', handler)

    expect(run(handlers.get('fs:read'), event(top(shellFile)), 'a')).toBe('got a')
    expect(() => run(handlers.get('fs:read'), event(top('https://evil.example/path?token=abc')), 'payload-value')).toThrow(/may not use the shell/)
    expect(() => run(handlers.get('fs:read'), event(sub(shellFile)), 'payload-value')).toThrow()
    expect(handler).toHaveBeenCalledTimes(1)

    expect(logger).toHaveBeenCalledTimes(2)
    expect(logger.mock.calls[0][0]).toBe('refused fs:read from https://evil.example (foreign-page)')
    expect(logger.mock.calls[1][0]).toBe('refused fs:read from file: (subframe)')
    for (const [line] of logger.mock.calls) {
      expect(line).not.toContain('payload-value')
      expect(line).not.toContain('token=abc')
    }
  })

  it('also guards handleOnce, on and once', () => {
    const { ipc, handlers, listeners } = fakeIpc()
    installIpcSenderGuard(ipc as never, { isShell: packaged, logger: () => undefined })
    const sent = vi.fn()
    ipc.handleOnce('once:invoke', () => 'ok')
    ipc.on('terminal:write', sent)
    ipc.once('once:send', sent)

    expect(() => run(handlers.get('once:invoke'), event(top('https://evil.example/')))).toThrow()
    run(listeners.get('terminal:write'), event(top('https://evil.example/')), 'id', 'rm -rf /')
    run(listeners.get('once:send'), event(null))
    expect(sent).not.toHaveBeenCalled()

    run(listeners.get('terminal:write'), event(top(shellFile)), 'id', 'ls')
    expect(sent).toHaveBeenCalledWith(expect.anything(), 'id', 'ls')
  })

  it('throttles repeated refusals and installs only once', () => {
    const { ipc, listeners } = fakeIpc()
    const logger = vi.fn()
    let clock = 0
    installIpcSenderGuard(ipc as never, { isShell: packaged, logger, now: () => clock })
    installIpcSenderGuard(ipc as never, { isShell: packaged, logger })
    ipc.on('web:set-bounds', () => undefined)
    const send = (frame: SenderFrame) => run(listeners.get('web:set-bounds'), event(frame))

    for (let i = 0; i < 50; i++) {
      send(top('https://evil.example/'))
    }
    expect(logger).toHaveBeenCalledTimes(1)
    clock = 10_000
    send(top('https://evil.example/'))
    expect(logger).toHaveBeenCalledTimes(2)
  })
})

describe('registrations', () => {
  // The guard wraps ipcMain when main.ts starts; a channel registered while a module is imported would
  // run before that and slip past it. Registrations must sit inside a function or a method.
  it('no module other than main.ts registers an IPC channel at import time', () => {
    const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          walk(full)
        } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && entry.name !== 'main.ts') {
          if (/^ipcMain\.(handle|handleOnce|on|once)\(/m.test(fs.readFileSync(full, 'utf8'))) {
            offenders.push(path.relative(root, full))
          }
        }
      }
    }
    walk(root)

    expect(offenders).toEqual([])
  })

  it('main.ts installs the guard before its first registration', () => {
    const main = fs.readFileSync(path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'main.ts'), 'utf8')
    const install = main.indexOf('installIpcSenderGuard(ipcMain)')
    const first = main.search(/ipcMain\.(handle|handleOnce|on|once)\(/)

    expect(install).toBeGreaterThan(-1)
    expect(install).toBeLessThan(first)
  })
})
