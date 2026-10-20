import { describe, expect, it } from 'vitest'
import { consoleProblem, logIpcFailures, Throttle, watchConsole } from './problem-log.ts'

function recorder() {
  const lines: string[] = []

  return { lines, log: (scope: string, message: string) => void lines.push(`[${scope}] ${message}`) }
}

describe('consoleProblem', () => {
  it('keeps errors and warnings, in both shapes Electron uses', () => {
    expect(consoleProblem({ level: 'error', message: 'Uncaught Error: boom', lineNumber: 12, sourceId: 'file:///C:/app/dist/renderer/assets/index-abc.js' })).toBe('error: Uncaught Error: boom (index-abc.js:12)')
    expect(consoleProblem({ level: 3, message: 'Uncaught (in promise) nope' })).toBe('error: Uncaught (in promise) nope')
    expect(consoleProblem({ level: 'warning', message: 'slow' })).toBe('warning: slow')
  })

  it('drops ordinary output', () => {
    expect(consoleProblem({ level: 'info', message: 'hello' })).toBeNull()
    expect(consoleProblem({ level: 0, message: 'debug' })).toBeNull()
  })
})

describe('watchConsole', () => {
  it('logs what a window prints as an error', () => {
    const { lines, log } = recorder()
    let listener: (...args: unknown[]) => void = () => undefined
    watchConsole({ id: 1, on: ((_: string, fn: (...args: unknown[]) => void) => void (listener = fn)) as never }, log)

    listener({ level: 'error', message: '[herald-os] Settings crashed', lineNumber: 3, sourceId: 'app.js' })
    listener({}, 1, 'just info', 1, 'app.js')

    expect(lines).toEqual(['[renderer] error: [herald-os] Settings crashed (app.js:3)'])
  })
})

describe('logIpcFailures', () => {
  it('logs a failing handler with its channel and still fails for the caller', async () => {
    const { lines, log } = recorder()
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const ipc = { handle: (channel: string, fn: (...args: unknown[]) => unknown) => void handlers.set(channel, fn) }
    logIpcFailures(ipc as never, log)

    ipc.handle('jarod-os:fs:read', async () => {
      throw new Error('ENOENT: no such file')
    })
    ipc.handle('jarod-os:ok', async () => 42)

    await expect(handlers.get('jarod-os:fs:read')!({})).rejects.toThrow('ENOENT')
    await expect(handlers.get('jarod-os:ok')!({})).resolves.toBe(42)
    expect(lines).toEqual(['[ipc] jarod-os:fs:read failed: ENOENT: no such file'])
  })
})

describe('Throttle', () => {
  it('lets a repeating line through a few times, then counts it and says so once the window ends', () => {
    let now = 0
    const throttle = new Throttle(2, 1000, () => now)
    const summaries: string[] = []
    const take = () => throttle.take('k', s => summaries.push(s))

    expect([take(), take(), take(), take()]).toEqual([true, true, false, false])
    now = 1000
    expect(take()).toBe(true)
    expect(summaries).toEqual(['(2 more held back in 1 s)'])
  })
})
