import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { osEnv } from '../env.ts'

/*
 * The Jarod core: the backend Jarod-OS ships with (`jarod-core/` in this repository, compiled to one file by
 * `jarod-core/scripts/bundle-gateway.mjs`). It answers the same protocol as `hermes serve`, so the shell talks to it the
 * same way. Hermes stays available as an option: JAROD_OS_BACKEND=hermes, or no core in the build.
 */

export type BackendChoice = 'jarod' | 'hermes'

export interface JarodCore {
  /**
   * The JavaScript runtime that runs the gateway: a `node` shipped beside it, else (installed) Jarod-OS's own executable in Node mode,
   * else `node` from PATH in a development checkout.
   */
  node: string
  /** `node` is the Electron executable: it runs the gateway with ELECTRON_RUN_AS_NODE=1 (the installer then carries no second Node, ~90 MB). */
  runAsNode?: boolean
  gateway: string
  /** Where the compiled core sits (`<resources>/jarod-core` installed, `<repo>/jarod-core/dist/gateway` in development). */
  dir: string
}

export interface CoreLocation {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  /** `app.isPackaged`. */
  packaged: boolean
  /** `process.resourcesPath` when packaged. */
  resourcesPath?: string
  /** `app.getAppPath()` in development (`apps/desktop`). */
  appPath?: string
  exists?: (file: string) => boolean
  /** `process.execPath`: the Electron executable, which can run the core in Node mode when no Node is shipped. */
  execPath?: string
}

const nodeName = (platform: NodeJS.Platform): string => (platform === 'win32' ? 'node.exe' : 'node')

/** The compiled core to run, or null when this build has none. JAROD_OS_JAROD_CORE=<folder holding gateway.mjs> overrides the search. */
export function resolveJarodCore(location: CoreLocation): JarodCore | null {
  const env = location.env ?? process.env
  const platform = location.platform ?? process.platform
  const exists = location.exists ?? fs.existsSync
  const override = osEnv('JAROD_CORE', env)?.trim()
  const candidates: { dir: string; shipped: boolean }[] = []

  if (override) {
    candidates.push({ dir: override, shipped: false })
  }

  if (location.packaged && location.resourcesPath) {
    candidates.push({ dir: path.join(location.resourcesPath, 'jarod-core'), shipped: true })
  } else if (location.appPath) {
    candidates.push({ dir: path.join(location.appPath, '..', '..', 'jarod-core', 'dist', 'gateway'), shipped: false })
  }

  for (const { dir, shipped } of candidates) {
    const gateway = path.join(dir, 'gateway.mjs')

    if (!exists(gateway)) {
      continue
    }

    const shippedNode = path.join(dir, nodeName(platform))

    if (exists(shippedNode)) {
      return { dir, gateway, node: shippedNode }
    }

    // Installed without a Node of its own (bundle-core.mjs checked that the core's native module loads in Electron's): Jarod-OS runs it.
    if (shipped) {
      return { dir, gateway, node: location.execPath ?? process.execPath, runAsNode: true }
    }

    return { dir, gateway, node: osEnv('NODE', env)?.trim() || nodeName(platform) }
  }

  return null
}

/**
 * Which backend to start. JAROD_OS_BACKEND=jarod|hermes decides when set (a forced `jarod` without a core is reported by the caller);
 * otherwise the Jarod core when this build has one, Hermes when it does not.
 */
export function selectBackend(env: NodeJS.ProcessEnv, core: JarodCore | null): BackendChoice {
  const wanted = osEnv('BACKEND', env)?.trim().toLowerCase()

  if (wanted === 'hermes' || wanted === 'jarod') {
    return wanted
  }

  return core ? 'jarod' : 'hermes'
}

/** Where Jarod-OS keeps its own data: the kernel profile (`profile/`), the private Hermes-style home (`herald-home/`) and the gateway log. */
export function jarodDataDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home: string = os.homedir()): string {
  const override = env.JAROD_OS_DATA?.trim()

  if (override) {
    return override
  }

  if (platform === 'win32') {
    return path.win32.join(env.LOCALAPPDATA ?? path.win32.join(home, 'AppData', 'Local'), 'Jarod-OS')
  }

  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Jarod-OS', 'core')
  }

  return path.join(env.XDG_DATA_HOME?.trim() || path.join(home, '.local', 'share'), 'jarod-os')
}

/** The folder every conversation works in (the kernel's file tools stay inside it): JAROD_WORKSPACE, else `Documents/Jarod-OS`. */
export function jarodWorkspace(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  return env.JAROD_WORKSPACE?.trim() || path.join(home, 'Documents', 'Jarod-OS')
}

export interface SpawnPlan {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
  cwd: string
}

/**
 * How to start the core. The profile is a folder of its own under `dataDir`; the token is the one the shell will present; the core exits when its standard
 * input closes (the only clean stop on Windows, and it never outlives the app). Provider keys (OPENAI_API_KEY…) pass through from the environment.
 */
export function jarodSpawnPlan(core: JarodCore, options: { token: string; dataDir: string; workspace: string; env: NodeJS.ProcessEnv }): SpawnPlan {
  const env: NodeJS.ProcessEnv = { ...options.env, JAROD_HOME: path.join(options.dataDir, 'profile'), JAROD_GATEWAY_TOKEN: options.token }

  if (core.runAsNode) {
    env.ELECTRON_RUN_AS_NODE = '1'
  } else {
    delete env.ELECTRON_RUN_AS_NODE
  }

  delete env.HERMES_DASHBOARD_SESSION_TOKEN
  delete env.JAROD_GATEWAY_PORT

  return {
    command: core.node,
    args: [core.gateway, '--init', '--exit-on-stdin-close', '--workspace', options.workspace],
    env,
    cwd: core.dir
  }
}

/**
 * The core's maintenance mode (external backups): `gateway.mjs --db-snapshot <source> <copy>` copies a database, same key, without the
 * vault's values. Run while the core is stopped; nothing else starts (no network, no profile lock). Resolves with how many values were
 * left out; rejects with the core's one-line reason.
 */
export function runDbSnapshot(core: JarodCore, src: string, dest: string, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const childEnv: NodeJS.ProcessEnv = { ...env }

  if (core.runAsNode) {
    childEnv.ELECTRON_RUN_AS_NODE = '1'
  } else {
    delete childEnv.ELECTRON_RUN_AS_NODE
  }

  delete childEnv.JAROD_GATEWAY_TOKEN

  return new Promise((resolve, reject) => {
    execFile(core.node, [core.gateway, '--db-snapshot', src, dest], { cwd: core.dir, env: childEnv, windowsHide: true, timeout: 30 * 60_000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      const line = String(stdout).trim().split(/\r?\n/).at(-1) ?? ''
      let answer: { ok?: boolean; removed?: number; error?: string } = {}

      try {
        answer = JSON.parse(line) as typeof answer
      } catch {
        // No answer: the error below says why.
      }

      if (answer.ok && typeof answer.removed === 'number') resolve(answer.removed)
      else reject(new Error(`copie de la base refusée par le moteur : ${answer.error ?? (error ? error.message : 'réponse illisible')}`))
    })
  })
}
