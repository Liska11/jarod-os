import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AudioWsKind, AudioWsTarget, BackendRuntime, BackendState, RestRequest } from '../../shared/ipc.ts'
import { redactLine } from '../../shared/redact.ts'
import { osEnv } from '../env.ts'
import { log } from '../log.ts'
import { hermesHome, jarodOsDataDir } from '../paths.ts'
import { ensureBridgePlugin } from './bridge-plugin.ts'
import { type AttachTarget, attachTarget, foreignGateway } from './coexist.ts'
import { type CoreLocation, type JarodCore, jarodDataDir, jarodSpawnPlan, jarodWorkspace, resolveJarodCore, selectBackend } from './jarod-core.ts'
import { waitForStatus } from './probe.ts'
import { LineBuffer, parseReadyLine, readyFileName, staleReadyFiles } from './ready.ts'
import { resolveBackendRuntime } from './resolve.ts'
import { killProcessTree, windowsParentPid } from './process-tree.ts'
import { loginShellPath } from './shell-env.ts'

const READY_TIMEOUT_MS = 90_000
const STATUS_TIMEOUT_MS = 60_000
const MAX_RESTARTS = 4
const BACKOFF_MS = [1_000, 3_000, 7_000, 15_000]
const LOG_TAIL_LINES = 200
/** The Jarod core stops by itself when its input closes; this long to do it before it is killed. */
const GRACEFUL_STOP_MS = 8_000
/** Code de sortie du noyau quand il refuse de démarrer : `startupFailure` (profil déjà servi, port occupé). */
const STARTUP_REFUSED_EXIT_CODE = 3

/** La dernière raison dite par le noyau (sa ligne `[err]`) : c'est le refus à montrer, pas la ligne de sortie. */
export function lastBackendError(tail: string[]): string | undefined {
  for (let i = tail.length - 1; i >= 0; i--) {
    const line = tail[i]

    if (line?.startsWith('[err] ')) {
      const reason = redactLine(line.slice('[err] '.length).trim())

      if (reason) {
        return reason
      }
    }
  }

  return undefined
}

export type BackendListener = (state: BackendState) => void

/**
 * Owns the `hermes serve` child: resolve -> spawn -> ready -> probe -> ready state, restart with
 * bounded backoff on unexpected exit, and REST forwarding that adds the token in main (ADR-007).
 */
export class BackendManager {
  private state: BackendState = { phase: 'idle', attempt: 0, logTail: [] }
  private child: ChildProcess | null = null
  private token = ''
  /** Control socket the bridge plugin's `os_ui` tool dials, and the token it must present. */
  private control: { endpoint: () => string; token: string } | null = null
  private listeners = new Set<BackendListener>()

  /** `location` says where a packaged build keeps the Jarod core (see `resolveJarodCore`). */
  constructor(private readonly location: Pick<CoreLocation, 'packaged' | 'resourcesPath' | 'appPath'> = { packaged: false }) {}

  /** `endpoint` is a Unix socket path or a `pipe://<name>` Windows named pipe (see `shell/control-authz.ts`); a function when it is only known once the server listens. */
  setControl(endpoint: string | (() => string), token: string): void {
    this.control = { endpoint: typeof endpoint === 'function' ? endpoint : () => endpoint, token }
  }
  private stopping = false
  /** Whether the running child stops when its standard input closes (the Jarod core): it gets the chance to close its database first. */
  private gracefulStdin = false
  private startGeneration = 0
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private readonly tail: string[] = []

  getState(): BackendState {
    return { ...this.state, logTail: this.tail.slice(-LOG_TAIL_LINES) }
  }

  /** Process id of the running `hermes serve`, if any. */
  childPid(): number | null {
    return this.child?.pid ?? null
  }

  onState(listener: BackendListener): () => void {
    this.listeners.add(listener)
    listener(this.getState())

    return () => this.listeners.delete(listener)
  }

  async start(): Promise<void> {
    this.stopping = false
    await this.launch(0)
  }

  /** User-driven restart: resets the attempt budget. */
  async restart(): Promise<void> {
    log('backend', 'restart requested')
    this.clearRestartTimer()
    await this.killChild()
    this.stopping = false
    await this.launch(0)
  }

  async stop(): Promise<void> {
    this.stopping = true
    this.clearRestartTimer()
    await this.killChild()
    this.update({ phase: 'stopped', wsUrl: undefined, wsToken: undefined, baseUrl: undefined, port: undefined })
  }

  /**
   * Authenticated audio WebSocket target: the URL carries no token, the renderer offers it as a
   * WebSocket subprotocol (see `src/lib/ws-auth.ts`), exactly like the gateway socket.
   */
  audioWsUrl(kind: AudioWsKind): AudioWsTarget {
    const { port, phase } = this.state

    if (!port || phase !== 'ready') {
      throw new Error('Hermes backend is not ready')
    }

    const paths: Record<AudioWsKind, string> = { 'speak-stream': '/api/audio/speak-stream' }

    return { url: `ws://127.0.0.1:${port}${paths[kind]}`, token: this.token, auth: this.state.wsAuth }
  }

  async rest<T>(request: RestRequest): Promise<T> {
    const { baseUrl } = this.state

    if (!baseUrl || this.state.phase !== 'ready') {
      throw new Error('Hermes backend is not ready')
    }

    if (!request.path.startsWith('/api/')) {
      throw new Error(`refusing REST path outside /api: ${request.path}`)
    }

    const url = new URL(baseUrl + request.path)

    for (const [key, value] of Object.entries(request.query ?? {})) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value))
      }
    }

    const response = await fetch(url, {
      method: request.method,
      headers: {
        'X-Hermes-Session-Token': this.token,
        ...(request.body === undefined ? {} : { 'Content-Type': 'application/json' })
      },
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
      signal: AbortSignal.timeout(60_000)
    })

    const text = await response.text()

    if (!response.ok) {
      let detail = response.statusText

      try {
        const parsed = JSON.parse(text) as { detail?: unknown; error?: unknown }
        detail = String(parsed.detail ?? parsed.error ?? detail)
      } catch {
        detail = text || detail
      }

      throw new Error(`${request.method} ${request.path} -> ${response.status}: ${redactLine(detail)}`)
    }

    return (text ? JSON.parse(text) : null) as T
  }

  private async launch(attempt: number): Promise<void> {
    const generation = ++this.startGeneration
    this.update({ phase: attempt === 0 ? 'resolving' : 'restarting', attempt, error: undefined, errorKind: undefined })

    let attach: AttachTarget | null

    try {
      attach = attachTarget()
    } catch (error) {
      this.update({ phase: 'failed', error: redactLine(error instanceof Error ? error.message : String(error)) })

      return
    }

    if (attach) {
      await this.attach(attach, attempt, generation)

      return
    }

    const core = resolveJarodCore({ ...this.location, env: process.env })
    let runtime: BackendRuntime | null

    if (selectBackend(process.env, core) === 'jarod') {
      if (!core) {
        this.update({ phase: 'failed', error: 'JAROD_OS_BACKEND=jarod, but this build has no compiled Jarod core. Build it with `npm run bundle:core`, or unset JAROD_OS_BACKEND.' })

        return
      }

      runtime = { kind: 'jarod', label: 'the Jarod core built into Jarod-OS', root: core.dir, command: [core.node, core.gateway] }
    } else {
      runtime = resolveBackendRuntime()
    }

    if (!runtime) {
      this.update({
        phase: 'failed',
        error:
          'No backend found: this build has no Jarod core and no Hermes runtime was found. Install Hermes Agent (curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash) or set JAROD_OS_HERMES_ROOT.'
      })

      return
    }

    this.update({ runtime, phase: 'starting' })

    try {
      if (runtime.kind !== 'jarod') {
        await ensureBridgePlugin(runtime)
      }

      const port = await this.spawnServe(runtime, generation, runtime.kind === 'jarod' ? core : null)

      if (generation !== this.startGeneration) {
        return
      }

      const baseUrl = `http://127.0.0.1:${port}`
      await waitForStatus(baseUrl, this.token, STATUS_TIMEOUT_MS)

      if (generation !== this.startGeneration) {
        return
      }

      const wsUrl = `ws://127.0.0.1:${port}/api/ws`
      // Le noyau Jarod lit le jeton en sous-protocole ; un `hermes serve` local ne l'accepte qu'en `?token=`.
      const wsAuth = runtime.kind === 'jarod' ? 'subprotocol' : 'query'
      this.update({ phase: 'ready', port, baseUrl, wsUrl, wsToken: this.token, wsAuth, error: undefined, sharedGateway: this.sharedGateway()?.pid })
      log('backend', `ready on ${baseUrl} via ${runtime.label}`)
    } catch (error) {
      if (generation !== this.startGeneration) {
        return
      }

      const message = redactLine(error instanceof Error ? error.message : String(error))
      log('backend', `start failed: ${message}`)
      await this.killChild()

      // Le noyau a déjà dit pourquoi il refuse (code 3) : relancer ne ferait que répéter le même refus.
      if (this.state.errorKind === 'refused') {
        return
      }

      this.scheduleRestart(attempt, message)
    }
  }

  /** Use a backend that is already running (JAROD_OS_BACKEND_URL) instead of starting a second one. */
  private async attach(target: AttachTarget, attempt: number, generation: number): Promise<void> {
    this.token = target.token
    this.update({ runtime: { kind: 'attached', label: `the Hermes backend at ${target.baseUrl}`, command: [] }, phase: 'starting' })

    try {
      await waitForStatus(target.baseUrl, this.token, STATUS_TIMEOUT_MS)

      if (generation !== this.startGeneration) {
        return
      }

      // It did not get our control socket in its environment; the bridge plugin reads this instead.
      if (this.control) {
        const file = path.join(jarodOsDataDir(), 'control.json')
        fs.mkdirSync(jarodOsDataDir(), { recursive: true })
        fs.writeFileSync(file, JSON.stringify({ socket: this.control.endpoint(), token: this.control.token }), { mode: 0o600 })
        fs.chmodSync(file, 0o600)
      }

      const url = new URL(target.baseUrl)
      const port = Number(url.port) || 80
      // Un backend rejoint par JAROD_OS_BACKEND_URL est un Hermes (« the Hermes backend at … ») : `?token=`.
      this.update({ phase: 'ready', port, baseUrl: target.baseUrl, wsUrl: `ws://${url.host}/api/ws`, wsToken: this.token, wsAuth: 'query', error: undefined, sharedGateway: undefined })
      log('backend', `attached to ${target.baseUrl}`)
    } catch (error) {
      if (generation === this.startGeneration) {
        this.scheduleRestart(attempt, redactLine(`could not reach ${target.baseUrl}: ${error instanceof Error ? error.message : String(error)}`))
      }
    }
  }

  /** Another app's messaging gateway on this Hermes home (Hermes Desktop, say), for Settings to mention. */
  sharedGateway(): { pid: number } | null {
    return foreignGateway(hermesHome(), { appPid: process.pid, backendPid: this.child?.pid ?? null }, { alive: isProcessAlive, parentOf: parentPid })
  }

  private async spawnServe(runtime: BackendRuntime, generation: number, core: JarodCore | null): Promise<number> {
    this.token = crypto.randomBytes(32).toString('base64url')
    const dataDir = jarodOsDataDir()
    const readyFile = path.join(dataDir, readyFileName(process.pid))
    fs.mkdirSync(dataDir, { recursive: true })
    fs.rmSync(readyFile, { force: true })

    for (const name of staleReadyFiles(fs.readdirSync(dataDir), process.pid, isProcessAlive)) {
      fs.rmSync(path.join(dataDir, name), { force: true })
    }

    let command: string
    let args: string[]
    let env: NodeJS.ProcessEnv
    let cwd: string | undefined

    if (core) {
      // The Jarod core: its own profile and working folder, the token the shell will present, and an input that stays open (closing it is how it is stopped).
      const jarodData = jarodDataDir()
      const workspace = jarodWorkspace()
      fs.mkdirSync(path.join(jarodData, 'profile'), { recursive: true })
      fs.mkdirSync(workspace, { recursive: true })
      const plan = jarodSpawnPlan(core, { token: this.token, dataDir: jarodData, workspace, env: process.env })
      command = plan.command
      args = plan.args
      // V-12 : la porte de contrôle du shell, comme pour le backend Hermes. Sans elle, le registre des capacités ne voyait ni la surface du
      // shell ni le registre de la fenêtre, et le cœur ne pouvait pas demander au shell de démarrer Pinokio. Le cœur ne la transmet à aucun
      // de ses enfants (kernel/child-env.ts retire ces deux variables).
      env = { ...plan.env, ...(this.control ? { JAROD_OS_CONTROL_SOCKET: this.control.endpoint(), JAROD_OS_CONTROL_TOKEN: this.control.token } : {}) }
      cwd = plan.cwd
    } else {
      const [executable, ...head] = runtime.command
      command = executable as string
      args = [...head, 'serve', '--host', '127.0.0.1', '--port', '0']
      cwd = runtime.root ?? undefined
      env = {
        ...process.env,
        PATH: await loginShellPath(),
        HERMES_HOME: hermesHome(),
        // Sessions start in the user's world, not inside the runtime checkout.
        TERMINAL_CWD: osEnv('DEFAULT_CWD') || os.homedir(),
        HERMES_DASHBOARD_SESSION_TOKEN: this.token,
        // The loopback token exemption, in-process cron ticker and orphan reaping upstream key on
        // this flag; Jarod-OS spawns and owns the backend exactly the way Desktop does.
        HERMES_DESKTOP: '1',
        HERALD_OS: '1',
        HERMES_PARENT_PID: String(process.pid),
        HERMES_DESKTOP_READY_FILE: readyFile,
        PYTHONUNBUFFERED: '1',
        ...(this.control ? { JAROD_OS_CONTROL_SOCKET: this.control.endpoint(), JAROD_OS_CONTROL_TOKEN: this.control.token } : {})
      }
      delete env.ELECTRON_RUN_AS_NODE
    }

    this.gracefulStdin = Boolean(core)
    log('backend', `spawning ${[command, ...args].join(' ')} (cwd ${cwd ?? process.cwd()})`)
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: [core ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      detached: false,
      windowsHide: true
    })
    this.child = child

    return new Promise<number>((resolve, reject) => {
      let settled = false
      const stdout = new LineBuffer()
      const stderr = new LineBuffer()
      const settle = (fn: () => void) => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          clearInterval(filePoll)
          fs.rmSync(readyFile, { force: true })
          fn()
        }
      }
      const timer = setTimeout(() => settle(() => reject(new Error('timed out waiting for HERMES_BACKEND_READY from the backend'))), READY_TIMEOUT_MS)
      // Fallback for interpreters whose fd 1 is not our pipe: upstream also publishes the port in a ready file.
      const filePoll = setInterval(() => {
        try {
          const parsed = JSON.parse(fs.readFileSync(readyFile, 'utf8')) as { port?: unknown }

          if (typeof parsed.port === 'number') {
            settle(() => resolve(parsed.port as number))
          }
        } catch {
          // Not written yet.
        }
      }, 500)

      child.stdout?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => {
        for (const line of stdout.push(chunk)) {
          this.record(`[out] ${line}`)
          const port = parseReadyLine(line)

          if (port !== null) {
            settle(() => resolve(port))
          }
        }
      })
      child.stderr?.setEncoding('utf8')
      child.stderr?.on('data', (chunk: string) => {
        for (const line of stderr.push(chunk)) {
          this.record(`[err] ${line}`)
        }
      })
      child.on('error', error => settle(() => reject(error)))
      child.on('exit', (code, signal) => {
        for (const line of [...stdout.flush(), ...stderr.flush()]) {
          this.record(line)
        }

        log('backend', `serve exited code=${code} signal=${signal}`)

        if (this.child === child) {
          this.child = null
        }

        // Le noyau refuse par un code 3 et explique pourquoi sur stderr (profil déjà servi, port pris) : relancer
        // répéterait le même refus. On garde sa raison, et on ne boucle pas.
        if (code === STARTUP_REFUSED_EXIT_CODE && this.state.phase !== 'ready') {
          this.clearRestartTimer()
          const reason = lastBackendError(this.tail) ?? 'the backend refused to start'
          this.update({ phase: 'failed', error: reason, errorKind: 'refused', wsUrl: undefined, wsToken: undefined, baseUrl: undefined, port: undefined })
          settle(() => reject(new Error(reason)))

          return
        }

        settle(() => reject(new Error(`the backend exited early (code ${code ?? 'null'}, signal ${signal ?? 'none'})`)))

        if (settled && generation === this.startGeneration && !this.stopping && this.state.phase === 'ready') {
          this.scheduleRestart(this.state.attempt, `backend exited unexpectedly (code ${code ?? 'null'})`)
        }
      })
    })
  }

  private scheduleRestart(previousAttempt: number, reason: string): void {
    if (this.stopping) {
      return
    }

    const next = previousAttempt + 1

    if (next > MAX_RESTARTS) {
      this.update({ phase: 'failed', error: reason, wsUrl: undefined, wsToken: undefined, baseUrl: undefined, port: undefined })

      return
    }

    const delay = BACKOFF_MS[Math.min(next - 1, BACKOFF_MS.length - 1)]
    log('backend', `restart ${next}/${MAX_RESTARTS} in ${delay}ms: ${reason}`)
    this.update({ phase: 'restarting', attempt: next, error: reason, wsUrl: undefined, wsToken: undefined, baseUrl: undefined, port: undefined })
    this.clearRestartTimer()
    this.restartTimer = setTimeout(() => void this.launch(next), delay)
  }

  private clearRestartTimer(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
  }

  private async killChild(): Promise<void> {
    const child = this.child
    this.child = null
    // Any in-flight launch belongs to a previous generation now.
    this.startGeneration++

    if (!child || child.exitCode !== null) {
      return
    }

    // The Jarod core closes its database when its input ends; killing it outright would not give it the chance.
    const graceful = this.gracefulStdin && Boolean(child.stdin)

    await new Promise<void>(resolve => {
      const force = setTimeout(() => {
        try {
          killProcessTree(child, 'SIGKILL')
        } catch {
          // Already gone.
        }

        resolve()
      }, graceful ? GRACEFUL_STOP_MS : 4000)
      child.once('exit', () => {
        clearTimeout(force)
        resolve()
      })

      try {
        if (graceful) {
          child.stdin?.end()
        } else {
          killProcessTree(child, 'SIGTERM')
        }
      } catch {
        clearTimeout(force)
        resolve()
      }
    })
  }

  private record(line: string): void {
    // Le journal est affiché dans Réglages et transmis au disque : il traverse le masque ici, une fois, pour tous.
    const safe = redactLine(line, 4_000)
    this.tail.push(safe)

    if (this.tail.length > LOG_TAIL_LINES * 2) {
      this.tail.splice(0, this.tail.length - LOG_TAIL_LINES)
    }

    log('serve', safe)
  }

  private update(patch: Partial<BackendState>): void {
    this.state = { ...this.state, ...patch }
    const snapshot = this.getState()

    for (const listener of this.listeners) {
      listener(snapshot)
    }
  }
}

function parentPid(pid: number): number | null {
  try {
    if (process.platform === 'linux') {
      // /proc/<pid>/stat: "pid (comm) state ppid …"; comm may contain spaces, so split after the ")".
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')

      return Number(fields[1]) || null
    }

    if (process.platform === 'win32') {
      return windowsParentPid(pid)
    }

    const out = execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 })

    return Number(out.trim()) || null
  } catch {
    return null
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)

    return true
  } catch (error) {
    // EPERM: alive, owned by someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}
