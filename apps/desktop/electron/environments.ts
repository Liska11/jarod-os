import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/*
 * Environments on the Jarod disk (docs/JAROD-DISK.md): <root>\environments\<name>\ holds one runtime, kept out of the
 * system, with an env.json manifest that says how to build it again.
 *
 *   python  a virtual environment made by uv (uv venv --python <version>): uv fetches that Python if it is missing
 *   node    an official Node.js build from nodejs.org (the zip for Windows x64), unpacked as it is
 *
 * A terminal opened "in" an environment gets its tools first in PATH (bin/Scripts, or the Node folder).
 */

export type EnvironmentKind = 'python' | 'node'

export interface EnvironmentInfo {
  name: string
  kind: EnvironmentKind
  /** What was asked: "3.12", "22"… */
  requested: string
  /** What is installed: "3.12.7", "22.11.0" (filled once built). */
  version: string
  created: string
}

export const ENV_FILE = 'env.json'
const NAME = /^[a-z0-9][a-z0-9-]{0,47}$/

export function isEnvironmentName(name: unknown): name is string {
  return typeof name === 'string' && NAME.test(name)
}

/** A version request: "3.12", "3.12.7", "22", "22.11.0" (major, major.minor or major.minor.patch). */
export function isVersionRequest(version: unknown): version is string {
  return typeof version === 'string' && /^\d{1,2}(\.\d{1,3}){0,2}$/.test(version)
}

export function listEnvironments(dir: string): EnvironmentInfo[] {
  if (!fs.existsSync(dir)) return []

  const list: EnvironmentInfo[] = []

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue

    try {
      const info = JSON.parse(fs.readFileSync(path.join(dir, entry.name, ENV_FILE), 'utf8')) as EnvironmentInfo

      if (info.name === entry.name && info.version) list.push(info)
    } catch {
      // Not an environment, or one still being built.
    }
  }

  return list.sort((a, b) => a.name.localeCompare(b.name))
}

/** The folders a terminal puts first in PATH for this environment (Windows layout). */
export function environmentPath(dir: string, info: EnvironmentInfo): string[] {
  const home = path.join(dir, info.name)

  return info.kind === 'python' ? [path.join(home, 'Scripts')] : [path.join(home, 'node')]
}

/** The variables a terminal in this environment gets: PATH with the environment first (VIRTUAL_ENV for Python). */
export function environmentVariables(dir: string, info: EnvironmentInfo, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const key = Object.keys(base).find(name => name.toLowerCase() === 'path') ?? 'PATH'
  const env: NodeJS.ProcessEnv = { ...base, [key]: [...environmentPath(dir, info), base[key] ?? ''].filter(Boolean).join(path.delimiter), JAROD_ENVIRONMENT: info.name }

  if (info.kind === 'python') {
    env.VIRTUAL_ENV = path.join(dir, info.name)
  }

  return env
}

/** The newest Node.js release for a request ("22" → the newest 22.x), from nodejs.org's index.json. */
export function pickNodeRelease(index: Array<{ version: string; files?: string[] }>, requested: string): string | null {
  const wanted = requested.split('.')

  for (const release of index) {
    const version = release.version.replace(/^v/, '')
    const parts = version.split('.')

    if (wanted.every((part, i) => parts[i] === part) && (!release.files || release.files.includes('win-x64-zip'))) {
      return version
    }
  }

  return null
}

export type Run = (command: string, args: string[], cwd?: string) => Promise<string>

export const run: Run = (command, args, cwd) =>
  new Promise((resolve, reject) => {
    execFile(command, args, { cwd, windowsHide: true, timeout: 15 * 60_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${command} failed: ${(stderr || error.message).trim().split(/\r?\n/).slice(-3).join(' · ')}`))
      else resolve(`${stdout}\n${stderr}`)
    })
  })

export interface BuildTools {
  run: Run
  /** Downloads a URL to a file (Electron's net in the app). */
  download: (url: string, file: string) => Promise<void>
  /** nodejs.org's release index. */
  nodeIndex: () => Promise<Array<{ version: string; files?: string[] }>>
  uv: string
}

/**
 * Build an environment; its manifest is written last, so a failed build is not listed (and its folder is removed).
 * Returns the manifest.
 */
export async function createEnvironment(dir: string, name: string, kind: EnvironmentKind, requested: string, tools: BuildTools, now = new Date()): Promise<EnvironmentInfo> {
  if (!isEnvironmentName(name)) throw new Error('bad-name')
  if (!isVersionRequest(requested)) throw new Error('bad-version')

  const home = path.join(dir, name)

  if (fs.existsSync(home)) throw new Error('exists')

  await fs.promises.mkdir(home, { recursive: true })

  try {
    let version: string

    if (kind === 'python') {
      await tools.run(tools.uv, ['venv', '--python', requested, '--seed', home])
      const out = await tools.run(path.join(home, 'Scripts', 'python.exe'), ['--version'])
      version = /Python\s+(\S+)/.exec(out)?.[1] ?? requested
    } else {
      const release = pickNodeRelease(await tools.nodeIndex(), requested)

      if (!release) throw new Error('no-release')

      const zip = path.join(home, `node-v${release}-win-x64.zip`)
      await tools.download(`https://nodejs.org/dist/v${release}/node-v${release}-win-x64.zip`, zip)
      // Windows' own tar (bsdtar) unpacks zip files; named by its full path, since Git's GNU tar, often first in PATH,
      // reads "C:" as a remote host.
      await tools.run(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zip, '-C', home])
      await fs.promises.rm(zip, { force: true })
      await fs.promises.rename(path.join(home, `node-v${release}-win-x64`), path.join(home, 'node'))
      version = release
    }

    const info: EnvironmentInfo = { name, kind, requested, version, created: now.toISOString() }
    await fs.promises.writeFile(path.join(home, ENV_FILE), `${JSON.stringify(info, null, 2)}\n`, 'utf8')

    return info
  } catch (error) {
    await fs.promises.rm(home, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}
