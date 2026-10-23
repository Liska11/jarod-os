import { type ChildProcess, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { EngineApprovalOption, EngineEvent, EnginePermissionPolicy, EngineResult, EngineState } from '../../shared/engines.ts'
import { killProcessTree } from '../backend/process-tree.ts'
import { osEnv } from '../env.ts'
import { ACP_PROTOCOL_VERSION, AcpConnection, AcpError } from './acp-client.ts'
import { approvalOptions, approvalToolCall, permissionOutcome, translateSessionUpdate, turnEnded } from './acp-translate.ts'

/*
 * DeepSeek Harness (DSH) conduit par Jarod en ACP stdio (`dsh --profile acp`) : jamais l'application Electron DSH, jamais son
 * Web UI, jamais son option « réseau local sans authentification ». Jarod lance SON processus, sur SON dossier (`DSH_HOME` sous
 * les données de Jarod) : le profil `~/.dsh` de DSH Desktop / DSH NEXT et leurs bases ne sont ni lus ni partagés.
 */

export interface DshInstall {
  /** `lib/bin.js` du paquet `@deepseek-ai/dsh`. */
  bin: string
  version?: string
  /** D'où il vient : variable d'environnement, CLI sur le PATH, runtime embarqué par DSH NEXT / DSH Desktop. */
  source: 'env' | 'path' | 'dsh-next' | 'dsh-desktop'
  /** Le `node` à côté de la CLI (installation npm globale), s'il y en a un. */
  node?: string
}

const BIN_IN_PACKAGE = path.join('node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

function versionOf(bin: string, readFile: (file: string) => string): string | undefined {
  try {
    const version = (JSON.parse(readFile(path.join(path.dirname(bin), '..', 'package.json'))) as { version?: unknown }).version

    return typeof version === 'string' ? version : undefined
  } catch {
    return undefined
  }
}

/**
 * Où trouver DSH, sans l'exécuter : JAROD_OS_DSH_BIN, puis une CLI `dsh` sur le PATH (le `node_modules` à côté de son lanceur,
 * disposition d'une installation npm globale), puis le runtime embarqué par DSH NEXT ou DSH Desktop.
 */
export function resolveDsh(
  options: {
    env?: NodeJS.ProcessEnv
    exists?: (file: string) => boolean
    readFile?: (file: string) => string
  } = {}
): DshInstall | null {
  const env = options.env ?? process.env
  const exists = options.exists ?? fs.existsSync
  const readFile = options.readFile ?? (file => fs.readFileSync(file, 'utf8'))
  const found = (bin: string, source: DshInstall['source'], node?: string): DshInstall => ({
    bin,
    source,
    version: versionOf(bin, readFile),
    ...(node ? { node } : {})
  })

  const override = osEnv('DSH_BIN', env)?.trim()

  if (override && exists(override)) {
    return found(override, 'env')
  }

  for (const dir of (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean)) {
    if (!exists(path.join(dir, 'dsh.cmd')) && !exists(path.join(dir, 'dsh'))) {
      continue
    }

    const bin = path.join(dir, BIN_IN_PACKAGE)

    if (exists(bin)) {
      const node = path.join(dir, process.platform === 'win32' ? 'node.exe' : 'node')

      return found(bin, 'path', exists(node) ? node : undefined)
    }
  }

  const apps: Array<[string, DshInstall['source']]> = [
    ['DSH NEXT', 'dsh-next'],
    ['DSH Desktop', 'dsh-desktop']
  ]
  const roots = [env.ProgramFiles ?? env.PROGRAMFILES, env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Programs') : undefined].filter((root): root is string => Boolean(root))

  for (const [app, source] of apps) {
    for (const root of roots) {
      const bin = path.join(root, app, 'resources', 'app', BIN_IN_PACKAGE)

      if (exists(bin)) {
        return found(bin, source)
      }
    }
  }

  return null
}

/** Ce qui fait marcher Windows et Node, et rien d'autre : ni jeton interne de Jarod, ni clé de fournisseur, ni secret de l'utilisateur. */
const SYSTEM_ENV = new Set([
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'COMSPEC',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'HOME',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMW6432',
  'COMMONPROGRAMFILES',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'OS',
  'USERNAME',
  'USERDOMAIN',
  'COMPUTERNAME',
  'LANG',
  'TZ'
])

/**
 * Les préfixes des variables internes de Jarod (le nom actuel, l'ancien que `legacy-env.ts` lit encore, la passerelle Hermes).
 * L'ancien nom est reconstruit, comme dans `kernel/src/child-env.ts`, pour ne pas compter une ligne de plus au garde de renommage.
 */
const INTERNAL_PREFIX = new RegExp(`^(JAROD|${['HER', 'ALD'].join('')}|HERMES_DASHBOARD)_`, 'i')

export interface DshSpawnPlan {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
  cwd: string
}

/**
 * Le lancement : `node bin.js --profile acp` dans le dossier de travail, `DSH_HOME` propre à Jarod. L'environnement est une liste
 * blanche (SYSTEM_ENV) ; quand l'Internet de Jarod est coupé, un proxy mort coupe aussi tout client qui respecte les proxys —
 * un processus tiers peut l'ignorer (docs/NETWORK-POLICY.md, « Limits »).
 */
export function dshSpawnPlan(
  install: DshInstall,
  options: {
    home: string
    workspace: string
    env?: NodeJS.ProcessEnv
    internet: boolean
    execPath?: string
    extraArgs?: string[]
    explicitEnv?: Record<string, string>
  }
): DshSpawnPlan {
  const source = options.env ?? process.env
  const env: NodeJS.ProcessEnv = {}

  for (const [key, value] of Object.entries(source)) {
    if (SYSTEM_ENV.has(key.toUpperCase()) && value !== undefined) {
      env[key] = value
    }
  }

  // Ce que l'appelant nomme (la clé que le profil de DSH lit par `apiKeyEnv`) passe après le filtre, et rien d'autre ;
  // jamais un jeton interne de Jarod, même nommé.
  for (const [key, value] of Object.entries(options.explicitEnv ?? {})) {
    if (!INTERNAL_PREFIX.test(key) && !/CONTROL_TOKEN|GATEWAY_TOKEN/i.test(key)) {
      env[key] = value
    }
  }

  env.DSH_HOME = options.home
  env.NO_COLOR = '1'

  if (!options.internet) {
    Object.assign(env, {
      HTTP_PROXY: 'http://127.0.0.1:9',
      HTTPS_PROXY: 'http://127.0.0.1:9',
      ALL_PROXY: 'http://127.0.0.1:9',
      NO_PROXY: '127.0.0.1,localhost,::1'
    })
  }

  // Le `node` de l'installation npm, sinon celui du PATH, sinon l'exécutable de Jarod en mode Node (Electron embarque Node).
  let command = install.node ?? 'node'

  if (!install.node && options.execPath) {
    command = options.execPath
    env.ELECTRON_RUN_AS_NODE = '1'
  }

  return {
    command,
    args: [install.bin, '--profile', 'acp', ...(options.extraArgs ?? [])],
    env,
    cwd: options.workspace
  }
}

interface ApprovalWait {
  sessionId: string
  options: EngineApprovalOption[]
  resolve: (decision: { decision: 'allow' | 'deny' | 'cancel'; optionId?: string }) => void
  timer: ReturnType<typeof setTimeout>
}

export interface DshEngineDeps {
  resolve: () => DshInstall | null
  home: string
  workspace: string
  policy: () => EnginePermissionPolicy
  internet: () => boolean
  emit: (event: EngineEvent) => void
  onState: (state: { state: EngineState; error?: string }) => void
  log: (line: string) => void
  /** Pour les tests : un faux processus. */
  spawnProcess?: (plan: DshSpawnPlan) => ChildProcess
  extraArgs?: string[]
  /** Variables nommées pour ce moteur (la clé d'un fournisseur que son profil lit par `apiKeyEnv`), lues au lancement. */
  explicitEnv?: () => Record<string, string>
  execPath?: string
  approvalTimeoutMs?: number
}

/** Une demande d'accord sans réponse au bout de ce délai est retirée (refus fermé), comme chez Hermes. */
const APPROVAL_TIMEOUT_MS = 5 * 60_000

export class DshEngine {
  private child: ChildProcess | null = null
  private conn: AcpConnection | null = null
  private state: EngineState = 'stopped'
  private error: string | undefined
  private readonly inflight = new Set<string>()
  private readonly approvals = new Map<string, ApprovalWait>()
  private approvalSeq = 0
  private stopping = false
  /** Les derniers appels d'outil annoncés (titre, arguments) : une demande d'accord de DSH ne porte que leur identifiant. */
  private readonly toolCalls = new Map<string, { title: string; input: Record<string, string> }>()

  constructor(private readonly deps: DshEngineDeps) {}

  getState(): {
    state: EngineState
    error?: string
    turns: number
    pendingApprovals: number
  } {
    return {
      state: this.state,
      error: this.error,
      turns: this.inflight.size,
      pendingApprovals: this.approvals.size
    }
  }

  private set(state: EngineState, error?: string): void {
    this.state = state
    this.error = error
    this.deps.onState({ state, error })
  }

  async start(): Promise<EngineResult> {
    if (this.conn && !this.conn.isClosed) {
      return { ok: true, value: undefined }
    }

    const install = this.deps.resolve()

    if (!install) {
      this.set('absent', 'not-installed')

      return { ok: false, error: 'not-installed' }
    }

    fs.mkdirSync(this.deps.home, { recursive: true })
    fs.mkdirSync(this.deps.workspace, { recursive: true })
    const plan = dshSpawnPlan(install, {
      home: this.deps.home,
      workspace: this.deps.workspace,
      internet: this.deps.internet(),
      execPath: this.deps.execPath,
      extraArgs: this.deps.extraArgs,
      explicitEnv: this.deps.explicitEnv?.()
    })
    this.set('starting')
    this.stopping = false
    this.deps.log(`starting ${install.source} dsh ${install.version ?? '?'} (DSH_HOME ${this.deps.home})`)

    const child = this.deps.spawnProcess
      ? this.deps.spawnProcess(plan)
      : spawn(plan.command, plan.args, {
          cwd: plan.cwd,
          env: plan.env,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true
        })
    this.child = child
    const conn = new AcpConnection(child.stdout!, child.stdin!)
    this.conn = conn
    const stderrTail: string[] = []
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      stderrTail.push(...chunk.split(/\r?\n/).filter(Boolean))
      stderrTail.splice(0, Math.max(0, stderrTail.length - 20))
    })
    child.on('exit', code => {
      conn.close(new AcpError(`dsh s'est arrêté (code ${code ?? '?'})`))
      this.child = null
      this.inflight.clear()
      this.cancelApprovals()

      if (this.stopping) {
        this.set('stopped')
      } else {
        this.deps.log(`dsh exited unexpectedly (code ${code}) ${stderrTail.slice(-3).join(' | ')}`)
        this.set('failed', `exited:${code ?? '?'}`)
      }
    })
    child.on('error', error => this.set('failed', error.message))

    conn.onNotification(notification => {
      if (notification.method === 'session/update') {
        const event = translateSessionUpdate('dsh', notification.params)

        if (event?.type === 'tool.start') {
          this.toolCalls.set(String(event.payload.toolCallId), {
            title: String(event.payload.title ?? ''),
            input: (event.payload.input ?? {}) as Record<string, string>
          })

          if (this.toolCalls.size > 200) {
            this.toolCalls.delete(this.toolCalls.keys().next().value as string)
          }
        }

        if (event) {
          this.deps.emit(event)
        }
      }
    })
    conn.onRequest(async (method, params) => {
      if (method === 'session/request_permission') {
        return this.permission(params)
      }

      // fs/*, terminal/* : Jarod n'annonce pas ces capacités ; DSH ne doit pas les demander.
      throw new AcpError(`non pris en charge par Jarod : ${method}`, -32601)
    })

    try {
      const init = await conn.request<{
        protocolVersion?: unknown
        authMethods?: unknown[]
      }>('initialize', { protocolVersion: ACP_PROTOCOL_VERSION, clientCapabilities: {} }, 60_000)

      if (init.protocolVersion !== ACP_PROTOCOL_VERSION) {
        await this.stop()
        this.set('failed', `incompatible-protocol:${String(init.protocolVersion)}`)

        return {
          ok: false,
          error: `incompatible-protocol:${String(init.protocolVersion)}`
        }
      }

      if (Array.isArray(init.authMethods) && init.authMethods.length > 0) {
        // Un DSH qui exigerait une authentification ACP : Jarod n'en fournit pas, il ne fait pas semblant.
        await this.stop()
        this.set('failed', 'auth-required')

        return { ok: false, error: 'auth-required' }
      }

      this.set('connected')

      return { ok: true, value: undefined }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await this.stop()
      this.set('failed', message)

      return { ok: false, error: message }
    }
  }

  async newSession(cwd = this.deps.workspace): Promise<EngineResult<string>> {
    if (!this.conn || this.conn.isClosed) {
      return { ok: false, error: 'not-connected' }
    }

    try {
      const result = await this.conn.request<{ sessionId?: unknown }>('session/new', { cwd: path.resolve(cwd), mcpServers: [] })

      return typeof result.sessionId === 'string' ? { ok: true, value: result.sessionId } : { ok: false, error: 'no-session-id' }
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  async listSessions(): Promise<EngineResult<Array<{ sessionId: string; title?: string; updatedAt?: string }>>> {
    if (!this.conn || this.conn.isClosed) {
      return { ok: false, error: 'not-connected' }
    }

    try {
      const result = await this.conn.request<{
        sessions?: Array<Record<string, unknown>>
      }>('session/list', { cwd: path.resolve(this.deps.workspace) })

      return {
        ok: true,
        value: (result.sessions ?? []).flatMap(row =>
          typeof row.sessionId === 'string'
            ? [
                {
                  sessionId: row.sessionId,
                  title: typeof row.title === 'string' ? row.title : undefined,
                  updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : undefined
                }
              ]
            : []
        )
      }
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  async resumeSession(sessionId: string): Promise<EngineResult> {
    if (!this.conn || this.conn.isClosed) {
      return { ok: false, error: 'not-connected' }
    }

    try {
      await this.conn.request('session/resume', {
        sessionId,
        cwd: path.resolve(this.deps.workspace),
        mcpServers: []
      })

      return { ok: true, value: undefined }
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  /** Un tour : la réponse arrive en événements ; un seul tour à la fois par session (ACP). */
  prompt(sessionId: string, text: string): EngineResult {
    const conn = this.conn

    if (!conn || conn.isClosed) {
      return { ok: false, error: 'not-connected' }
    }

    if (this.inflight.has(sessionId)) {
      return { ok: false, error: 'turn-in-progress' }
    }

    this.inflight.add(sessionId)
    // Un tour peut durer : pas de délai côté Jarod, l'annulation est explicite (`cancel`).
    conn
      .request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }, 24 * 60 * 60_000)
      .then(
        result => this.deps.emit(turnEnded('dsh', sessionId, result)),
        (error: unknown) =>
          this.deps.emit({
            engine: 'dsh',
            sessionId,
            type: 'error',
            payload: {
              message: error instanceof Error ? error.message : String(error)
            }
          })
      )
      .finally(() => this.inflight.delete(sessionId))

    return { ok: true, value: undefined }
  }

  /** Annule le tour en cours : le moteur rend `stopReason: cancelled`. Les demandes d'accord de la session sont retirées. */
  cancel(sessionId: string): EngineResult {
    if (!this.conn || this.conn.isClosed) {
      return { ok: false, error: 'not-connected' }
    }

    this.conn.notify('session/cancel', { sessionId })

    for (const [requestId, wait] of this.approvals) {
      if (wait.sessionId === sessionId) {
        this.settleApproval(requestId, { decision: 'cancel' })
      }
    }

    return { ok: true, value: undefined }
  }

  respondApproval(requestId: string, decision: 'allow' | 'deny', optionId?: string): EngineResult {
    return this.settleApproval(requestId, { decision, optionId }) ? { ok: true, value: undefined } : { ok: false, error: 'unknown-request' }
  }

  /** Arrêt propre (fermer stdin : DSH vide sa persistance et sort), puis, au bout de 10 s, l'arbre de CE processus seulement. */
  async stop(): Promise<void> {
    const child = this.child

    if (!child) {
      return
    }

    this.stopping = true
    this.cancelApprovals()
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
    child.stdin?.end()
    const timer = setTimeout(() => killProcessTree(child, 'SIGKILL'), 10_000)
    await exited
    clearTimeout(timer)
  }

  private async permission(params: Record<string, unknown>): Promise<unknown> {
    const options = approvalOptions(params)
    const sessionId = typeof params.sessionId === 'string' ? params.sessionId : ''
    const policy = this.deps.policy()
    const call = approvalToolCall(params)
    const known = this.toolCalls.get(call.toolCallId)
    // Ce que la personne approuve : l'outil et ses arguments exacts (la commande), jamais une étiquette vague.
    const what = {
      toolCallId: call.toolCallId,
      title: call.title ?? known?.title ?? '',
      input: call.input ?? known?.input ?? {}
    }

    if (policy !== 'ask') {
      this.deps.emit({
        engine: 'dsh',
        sessionId,
        type: 'approval.resolved',
        payload: { ...what, decision: policy, automatic: true }
      })

      return permissionOutcome(options, policy)
    }

    const requestId = `dsh-${++this.approvalSeq}`
    const decision = await new Promise<{
      decision: 'allow' | 'deny' | 'cancel'
      optionId?: string
    }>(resolve => {
      const timer = setTimeout(() => this.settleApproval(requestId, { decision: 'cancel' }), this.deps.approvalTimeoutMs ?? APPROVAL_TIMEOUT_MS)
      this.approvals.set(requestId, { sessionId, options, resolve, timer })
      this.deps.emit({
        engine: 'dsh',
        sessionId,
        type: 'approval.request',
        payload: { requestId, ...what, options }
      })
    })
    this.deps.emit({
      engine: 'dsh',
      sessionId,
      type: 'approval.resolved',
      payload: { requestId, decision: decision.decision, automatic: false }
    })

    return permissionOutcome(options, decision.decision, decision.optionId)
  }

  private settleApproval(requestId: string, decision: { decision: 'allow' | 'deny' | 'cancel'; optionId?: string }): boolean {
    const wait = this.approvals.get(requestId)

    if (!wait) {
      return false
    }

    clearTimeout(wait.timer)
    this.approvals.delete(requestId)
    wait.resolve(decision)

    return true
  }

  private cancelApprovals(): void {
    for (const requestId of [...this.approvals.keys()]) {
      this.settleApproval(requestId, { decision: 'cancel' })
    }
  }
}
