import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { PinokioState } from '../../shared/ipc.ts'
import { locateRuntime, PinokioService, readPinokioHome } from './service.ts'

class FakeChild extends EventEmitter {
  pid = 4242
  stdout = null
  stderr = null
  sent: unknown[] = []
  send(message: unknown): boolean {
    this.sent.push(message)

    if ((message as { type?: string }).type === 'stop') {
      queueMicrotask(() => this.emit('exit', 0, null))
    }

    return true
  }
}

const runtime = { host: path.join('rt', 'host.cjs'), dir: 'rt' }

function service(options: { probe?: Awaited<ReturnType<typeof import('./service.ts').probeEngine>>; withRuntime?: boolean } = {}) {
  const child = new FakeChild()
  const states: PinokioState[] = []
  const opened: string[] = []
  const spawnHost = vi.fn((_exec: string, _host: string, _env: NodeJS.ProcessEnv) => child as unknown as ChildProcess)
  const svc = new PinokioService({
    runtime: options.withRuntime === false ? null : runtime,
    execPath: 'Jarod-OS.exe',
    env: { JAROD_OS_PINOKIO_PROFILE: path.join(os.tmpdir(), 'jarod-pinokio-none') },
    probe: async () => options.probe ?? null,
    spawnHost,
    onState: state => states.push(state),
    onOpen: url => opened.push(url)
  })

  return { svc, child, states, opened, spawnHost }
}

describe('locateRuntime', () => {
  it('finds the shipped engine, or the development one, or none', () => {
    const files = new Set([path.join('res', 'pinokiod', 'host.cjs'), path.join('res', 'pinokiod', 'node_modules', 'pinokiod', 'package.json')])
    const exists = (file: string) => files.has(file)
    expect(locateRuntime({ packaged: true, resourcesPath: 'res', env: {}, exists })).toEqual({ host: path.join('res', 'pinokiod', 'host.cjs'), dir: path.join('res', 'pinokiod') })
    expect(locateRuntime({ packaged: false, appPath: path.join('repo', 'apps', 'desktop'), env: {}, exists })).toBeNull()
    // host.cjs without pinokiod beside it is not a runtime.
    expect(locateRuntime({ packaged: true, resourcesPath: 'res', env: {}, exists: file => file.endsWith('host.cjs') })).toBeNull()
  })
})

describe('readPinokioHome', () => {
  it("reads the home folder from pinokiod's settings", () => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'jarod-pinokio-'))
    expect(readPinokioHome(profile)).toBeNull()
    fs.mkdirSync(path.join(profile, '.pinokio'))
    fs.writeFileSync(path.join(profile, '.pinokio', 'config.json'), JSON.stringify({ home: 'C:\\pinokio' }))
    expect(readPinokioHome(profile)).toBe('C:\\pinokio')
    fs.rmSync(profile, { recursive: true, force: true })
  })
})

describe('PinokioService', () => {
  it('starts its own engine in Node mode and reports it running', async () => {
    const { svc, child, spawnHost } = service()
    const started = svc.start()
    await vi.waitFor(() => expect(spawnHost).toHaveBeenCalled())
    const [exec, host, env] = spawnHost.mock.calls[0]
    expect(exec).toBe('Jarod-OS.exe')
    expect(host).toBe(runtime.host)
    expect(env.ELECTRON_RUN_AS_NODE).toBe('1')
    // The test profile replaces ~ for pinokiod only.
    expect(env.USERPROFILE).toContain('jarod-pinokio-none')
    child.emit('message', { type: 'ready', port: 42000, version: '8.2.2', home: 'C:\\pinokio' })
    await expect(started).resolves.toMatchObject({ phase: 'running', version: '8.2.2', home: 'C:\\pinokio' })
    expect(svc.owned).toBe(true)
  })

  it('starts only once when asked twice', async () => {
    const { svc, child, spawnHost } = service()
    const a = svc.start()
    const b = svc.start()
    await vi.waitFor(() => expect(spawnHost).toHaveBeenCalledTimes(1))
    child.emit('message', { type: 'ready', port: 42000, version: '8.2.2', home: null })
    await Promise.all([a, b])
    await svc.start()
    expect(spawnHost).toHaveBeenCalledTimes(1)
  })

  it("uses the Pinokio app's engine when one answers, and never stops it", async () => {
    const { svc, spawnHost } = service({ probe: { pinokiod: '8.2.0', pinokio: '8.2.0' } })
    await expect(svc.start()).resolves.toMatchObject({ phase: 'external', version: '8.2.0' })
    expect(spawnHost).not.toHaveBeenCalled()
    await expect(svc.stop()).resolves.toMatchObject({ phase: 'external' })
  })

  it('reports a port taken by another program instead of starting', async () => {
    const { svc, spawnHost } = service({ probe: 'foreign' })
    await expect(svc.start()).resolves.toMatchObject({ phase: 'error' })
    expect(spawnHost).not.toHaveBeenCalled()
  })

  it('is unavailable in a build without the engine', async () => {
    const { svc } = service({ withRuntime: false })
    expect(svc.state.phase).toBe('unavailable')
    await expect(svc.start()).resolves.toMatchObject({ phase: 'unavailable' })
  })

  it('reports an engine that dies while starting', async () => {
    const { svc, child, spawnHost } = service()
    const started = svc.start()
    await vi.waitFor(() => expect(spawnHost).toHaveBeenCalled())
    child.emit('exit', 1, null)
    await expect(started).resolves.toMatchObject({ phase: 'error' })
  })

  it('stops through the host (which stops the apps) and passes page requests on', async () => {
    const { svc, child, spawnHost, opened } = service()
    const started = svc.start()
    await vi.waitFor(() => expect(spawnHost).toHaveBeenCalled())
    child.emit('message', { type: 'ready', port: 42000, version: '8.2.2', home: null })
    await started
    child.emit('message', { type: 'open', url: 'http://127.0.0.1:7860', surface: 'window' })
    child.emit('message', { type: 'open', url: 'javascript:alert(1)', surface: 'window' })
    expect(opened).toEqual(['http://127.0.0.1:7860'])
    await expect(svc.stop()).resolves.toMatchObject({ phase: 'stopped' })
    expect(child.sent).toEqual([{ type: 'stop' }])
    expect(svc.owned).toBe(false)
  })
})
