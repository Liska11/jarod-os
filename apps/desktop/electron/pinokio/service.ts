import { type ChildProcess, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { PinokioState } from '../../shared/ipc.ts'
import { killProcessTree } from '../backend/process-tree.ts'
import { osEnv } from '../env.ts'
import { log } from '../log.ts'
import { type HostMessage, PINOKIO_PORT } from './protocol.ts'

/*
 * The Pinokio engine inside Jarod-OS (ADR-022). pinokiod (MIT) installs and runs AI apps from Pinokio launcher scripts;
 * Jarod-OS ships it in `<resources>/pinokiod` (built by scripts/bundle-pinokio.mjs) and runs it on demand, in its own
 * process (host.ts), with Jarod-OS's executable in Node mode, the way it runs the Jarod core.
 *
 * pinokiod always listens on port 42000 and keeps its settings in ~/.pinokio/config.json, shared with the Pinokio
 * desktop app. So:
 * - if a pinokiod already answers on 42000 (the Pinokio app is open), Jarod-OS uses it (`external`) and never stops it;
 * - otherwise Jarod-OS starts its own, which finds the same settings and the same home folder (same apps, same tools);
 * - the two cannot run at once; the Pinokio app says so itself if opened while Jarod-OS's engine runs.
 *
 * Nothing starts at boot: the Pinokio window or the agent's tools call `start()`. Jarod-OS's quit stops its own engine,
 * which stops the apps it launched.
 */

export const PINOKIO_URL = `http://127.0.0.1:${PINOKIO_PORT}`
const START_TIMEOUT_MS = 90_000
const STOP_TIMEOUT_MS = 10_000

export interface PinokioRuntime {
  /** host.cjs, beside pinokiod's node_modules. */
  host: string
  dir: string
}

export interface RuntimeLocation {
  packaged: boolean
  resourcesPath?: string
  /** `app.getAppPath()` in development (`apps/desktop`). */
  appPath?: string
  env?: NodeJS.ProcessEnv
  exists?: (file: string) => boolean
}

/** The bundled engine, or null when this build has none. JAROD_OS_PINOKIO_RUNTIME=<folder holding host.cjs> overrides. */
export function locateRuntime(location: RuntimeLocation): PinokioRuntime | null {
  const env = location.env ?? process.env
  const exists = location.exists ?? fs.existsSync
  const dirs: string[] = []
  const override = osEnv('PINOKIO_RUNTIME', env)?.trim()

  if (override) {
    dirs.push(override)
  }

  if (location.packaged && location.resourcesPath) {
    dirs.push(path.join(location.resourcesPath, 'pinokiod'))
  } else if (location.appPath) {
    dirs.push(path.join(location.appPath, '..', '..', 'pinokio-runtime'))
  }

  for (const dir of dirs) {
    const host = path.join(dir, 'host.cjs')

    if (exists(host) && exists(path.join(dir, 'node_modules', 'pinokiod', 'package.json'))) {
      return { host, dir }
    }
  }

  return null
}

/**
 * The profile folder pinokiod sees as `~` (where it keeps `.pinokio/config.json`). JAROD_OS_PINOKIO_PROFILE points it
 * elsewhere, for tests and checks that must not touch the real settings or apps.
 */
export function pinokioProfile(env: NodeJS.ProcessEnv = process.env): string {
  return osEnv('PINOKIO_PROFILE', env)?.trim() || os.homedir()
}

/** The home folder pinokiod was given (where apps and tools live), from its settings; null before its first run. */
export function readPinokioHome(profile: string): string | null {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(profile, '.pinokio', 'config.json'), 'utf8')) as { home?: unknown }

    return typeof config.home === 'string' && config.home.trim() ? config.home : null
  } catch {
    return null
  }
}

export interface EngineIdentity {
  pinokiod: string
  pinokio?: string
}

/** Who answers on the Pinokio port: a pinokiod (its versions), something else (`foreign`), or nobody (null). */
export async function probeEngine(url: string = PINOKIO_URL, timeoutMs = 1_500): Promise<EngineIdentity | 'foreign' | null> {
  try {
    const response = await fetch(`${url}/pinokio/version`, { signal: AbortSignal.timeout(timeoutMs) })

    if (!response.ok) {
      return 'foreign'
    }

    const body = (await response.json()) as Partial<EngineIdentity>

    return typeof body.pinokiod === 'string' ? { pinokiod: body.pinokiod, pinokio: typeof body.pinokio === 'string' ? body.pinokio : undefined } : 'foreign'
  } catch (error) {
    // A reply that is not JSON: something else is there. Refused, reset or silent: nobody usable.
    return error instanceof SyntaxError ? 'foreign' : null
  }
}

export interface ServiceDeps {
  runtime: PinokioRuntime | null
  /** Jarod-OS's executable, which runs host.cjs in Node mode. */
  execPath: string
  env?: NodeJS.ProcessEnv
  probe?: typeof probeEngine
  spawnHost?: (execPath: string, host: string, env: NodeJS.ProcessEnv) => ChildProcess
  /** pinokiod asked for a page: `window` in Jarod-OS, `browser` in the system browser. */
  onOpen?: (url: string, surface: 'window' | 'browser') => void
  onState?: (state: PinokioState) => void
}

const defaultSpawn = (execPath: string, host: string, env: NodeJS.ProcessEnv): ChildProcess =>
  spawn(execPath, [host], { cwd: path.dirname(host), env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true })

export class PinokioService {
  private child: ChildProcess | null = null
  private starting: Promise<PinokioState> | null = null
  private current: PinokioState
  private readonly env: NodeJS.ProcessEnv
  private readonly probe: typeof probeEngine
  private readonly spawnHost: NonNullable<ServiceDeps['spawnHost']>

  constructor(private readonly deps: ServiceDeps) {
    this.env = deps.env ?? process.env
    this.probe = deps.probe ?? probeEngine
    this.spawnHost = deps.spawnHost ?? defaultSpawn
    this.current = { phase: deps.runtime ? 'stopped' : 'unavailable', url: PINOKIO_URL, bundled: Boolean(deps.runtime), home: readPinokioHome(pinokioProfile(this.env)) }
  }

  get state(): PinokioState {
    return this.current
  }

  private set(next: Partial<PinokioState>): PinokioState {
    this.current = { ...this.current, ...next }

    if (this.current.phase !== 'error') {
      delete this.current.error
    }

    this.deps.onState?.(this.current)

    return this.current
  }

  /** Refresh `external`/`stopped` from what answers on the port (the Pinokio app may have been opened or closed). */
  async refresh(): Promise<PinokioState> {
    if (this.child || this.starting) {
      return this.current
    }

    const found = await this.probe()

    if (found && found !== 'foreign') {
      return this.set({ phase: 'external', version: found.pinokiod, home: readPinokioHome(pinokioProfile(this.env)) })
    }

    return this.set({ phase: this.deps.runtime ? 'stopped' : 'unavailable', version: undefined })
  }

  /** Make sure an engine answers: an existing one, or Jarod-OS's own, started now. */
  start(): Promise<PinokioState> {
    if (this.current.phase === 'running' && this.child) {
      return Promise.resolve(this.current)
    }

    this.starting ??= this.doStart().finally(() => {
      this.starting = null
    })

    return this.starting
  }

  private async doStart(): Promise<PinokioState> {
    const found = await this.probe()

    if (found === 'foreign') {
      return this.set({ phase: 'error', error: `Port ${PINOKIO_PORT} is used by another program, so the Pinokio engine cannot start.` })
    }

    if (found) {
      log('pinokio', `using the engine already running on port ${PINOKIO_PORT} (pinokiod ${found.pinokiod})`)

      return this.set({ phase: 'external', version: found.pinokiod, home: readPinokioHome(pinokioProfile(this.env)) })
    }

    const runtime = this.deps.runtime

    if (!runtime) {
      return this.set({ phase: 'unavailable' })
    }

    this.set({ phase: 'starting' })
    const profile = osEnv('PINOKIO_PROFILE', this.env)?.trim()
    const env: NodeJS.ProcessEnv = {
      ...this.env,
      ELECTRON_RUN_AS_NODE: '1',
      // pinokiod writes its own logs (home/logs); ours only need what it prints before that.
      ...(profile ? { USERPROFILE: profile, HOME: profile } : {})
    }

    let child: ChildProcess

    try {
      child = this.spawnHost(this.deps.execPath, runtime.host, env)
    } catch (error) {
      return this.set({ phase: 'error', error: `The Pinokio engine could not start: ${(error as Error).message}` })
    }

    this.child = child
    log('pinokio', `starting the engine (pid ${child.pid ?? '?'}) from ${runtime.dir}`)
    let agentStack = false
    const echo = (stream: NodeJS.ReadableStream | null, level: string) => {
      stream?.setEncoding('utf8')
      stream?.on('data', (chunk: string) => {
        // node-pty's helper that lists a closing console's processes fails when the shell is already gone (pinokiod's short
        // start-up shells): a harmless crash of that helper, not of the engine. One line instead of its stack.
        if (chunk.includes('conpty_console_list_agent')) {
          agentStack = true
          log('pinokio', 'node-pty: console list helper could not attach (the shell had already exited; harmless)')

          return
        }

        // The rest of that stack, when it arrives in later chunks.
        if (agentStack && /^\s*(var consoleProcessList|\^|Error: AttachConsole failed|at |Node\.js v)/.test(chunk)) {
          return
        }

        agentStack = false

        for (const line of chunk.split(/\r?\n/)) {
          if (line.trim()) {
            log('pinokio', `${level}${line.slice(0, 2_000)}`)
          }
        }
      })
    }
    echo(child.stdout, '')
    echo(child.stderr, '! ')

    return new Promise<PinokioState>(resolve => {
      let settled = false
      const settle = (state: PinokioState) => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          resolve(state)
        }
      }
      const timer = setTimeout(() => {
        killProcessTree(child, 'SIGKILL')
        settle(this.set({ phase: 'error', error: 'The Pinokio engine did not answer in time.' }))
      }, START_TIMEOUT_MS)

      child.on('message', (message: HostMessage) => {
        switch (message?.type) {
          case 'ready':
            log('pinokio', `engine ready: pinokiod ${message.version}, home ${message.home ?? '(not chosen yet)'}`)
            settle(this.set({ phase: 'running', version: message.version, home: message.home ?? readPinokioHome(pinokioProfile(this.env)) }))

            return
          case 'error':
            settle(this.set({ phase: 'error', error: message.message }))

            return
          case 'open':
            if (/^https?:\/\//i.test(message.url)) {
              this.deps.onOpen?.(message.url, message.surface)
            }

            return
          case 'quit':
            void this.stop()

            return
          case 'restart':
            void this.stop().then(() => this.start())

            return
          default:
            return
        }
      })
      child.on('error', error => {
        log('pinokio', `engine process error: ${error.message}`)
        settle(this.set({ phase: 'error', error: error.message }))
      })
      child.on('exit', (code, signal) => {
        if (this.child === child) {
          this.child = null
        }

        log('pinokio', `engine exited (${signal ?? code})`)
        // stop() reports `stopped` itself once the process is gone.
        if (this.current.phase === 'starting') {
          settle(this.set({ phase: 'error', error: `The Pinokio engine stopped while starting (${signal ?? code}).` }))
        } else if (this.current.phase !== 'stopping' && this.current.phase !== 'error') {
          this.set({ phase: 'stopped', version: undefined })
        }
      })
    })
  }

  /** Stop Jarod-OS's own engine and every app it started. An engine Jarod-OS did not start is left alone. */
  async stop(): Promise<PinokioState> {
    const child = this.child

    if (!child) {
      return this.current.phase === 'external' ? this.current : this.set({ phase: this.deps.runtime ? 'stopped' : 'unavailable', version: undefined })
    }

    this.set({ phase: 'stopping' })

    await new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        log('pinokio', 'engine did not stop in time; ending its process tree')
        killProcessTree(child, 'SIGKILL')
        resolve()
      }, STOP_TIMEOUT_MS)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })

      try {
        child.send({ type: 'stop' })
      } catch {
        killProcessTree(child, 'SIGKILL')
      }
    })

    this.child = null

    return this.set({ phase: 'stopped', version: undefined })
  }

  /** For main's quit: true when an engine of ours is still running. */
  get owned(): boolean {
    return this.child !== null
  }
}
