import { execFile } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { extraHermesDirs } from './resolve.ts'

const FALLBACK_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']

/** The `Path` value in `reg query` output (`    Path    REG_EXPAND_SZ    C:\a;%USERPROFILE%\b`). */
export function parseRegPath(output: string): string {
  return /^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.*)$/im.exec(output)?.[1]?.trim() ?? ''
}

/** Expand `%NAME%` references (case-insensitive, like cmd.exe); unknown names stay as written. */
export function expandWindowsVars(value: string, env: NodeJS.ProcessEnv = process.env): string {
  const lookup = new Map(Object.entries(env).map(([key, val]) => [key.toLowerCase(), val ?? '']))

  return value.replace(/%([^%]+)%/g, (whole, name: string) => lookup.get(name.toLowerCase()) ?? whole)
}

/** Merge PATH lists in order, dropping empties and duplicates (case-insensitive on Windows). */
export function mergePaths(lists: string[][], caseInsensitive: boolean): string {
  const seen = new Set<string>()
  const merged: string[] = []

  for (const dir of lists.flat()) {
    const key = caseInsensitive ? dir.toLowerCase() : dir

    if (dir && !seen.has(key)) {
      seen.add(key)
      merged.push(dir)
    }
  }

  return merged.join(path.delimiter)
}

function registryPath(hive: string, timeoutMs: number): Promise<string> {
  return new Promise(resolve => {
    const child = execFile('reg.exe', ['query', hive, '/v', 'Path'], { timeout: timeoutMs, windowsHide: true }, (error, stdout) => {
      resolve(error ? '' : parseRegPath(stdout))
    })
    child.on('error', () => resolve(''))
  })
}

/**
 * An app started from Explorer carries the PATH Windows had at sign-in, so a tool installed since
 * (Hermes's own installer adds its `bin` folder to the user PATH) is invisible to it. Read the
 * current user and machine PATH from the registry and put them ahead of the inherited one.
 */
async function windowsPath(timeoutMs: number): Promise<string> {
  const [user, machine] = await Promise.all([registryPath('HKCU\\Environment', timeoutMs), registryPath('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment', timeoutMs)])
  const split = (value: string) => expandWindowsVars(value).split(path.delimiter)

  return mergePaths([split(user), (process.env.PATH ?? process.env.Path ?? '').split(path.delimiter), split(machine), extraHermesDirs()], true)
}

/**
 * GUI apps on macOS inherit a minimal PATH. The backend (and the tools the agent runs through it)
 * expect the user's login-shell PATH, so ask the login shell once and merge with sane fallbacks.
 * On Windows the equivalent is the registry's user and machine PATH.
 */
export async function loginShellPath(timeoutMs = 4000): Promise<string> {
  if (process.platform === 'win32') {
    return windowsPath(timeoutMs)
  }

  const shell = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash')
  const fromShell = await new Promise<string>(resolve => {
    const child = execFile(shell, ['-lc', 'printf "%s" "$PATH"'], { timeout: timeoutMs }, (error, stdout) => {
      resolve(error ? '' : stdout.trim())
    })
    child.on('error', () => resolve(''))
  })

  return mergePaths([fromShell.split(path.delimiter), (process.env.PATH ?? '').split(path.delimiter), [path.join(os.homedir(), '.local', 'bin')], FALLBACK_DIRS], false)
}
