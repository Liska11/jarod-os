import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { BackendRuntime } from '../../shared/ipc.ts'
import { osEnv } from '../env.ts'
import { hermesHome } from '../paths.ts'

const isExecutable = (file: string): boolean => {
  try {
    fs.accessSync(file, fs.constants.X_OK)

    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

/** A source checkout is usable only if it carries a venv AND the `serve` subcommand. */
function checkoutRuntime(root: string, kind: BackendRuntime['kind'], label: string): BackendRuntime | null {
  const python = path.join(root, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
  const serveModule = path.join(root, 'hermes_cli', 'subcommands', 'dashboard.py')

  if (!isExecutable(python) || !fs.existsSync(serveModule)) {
    return null
  }

  return { kind, label, root, command: [python, '-m', 'hermes_cli.main'] }
}

/** Where a GUI app should also look for `hermes`: the usual user bin dirs it does not inherit. */
export function extraHermesDirs(platform: NodeJS.Platform = process.platform, home: string = os.homedir(), env: NodeJS.ProcessEnv = process.env): string[] {
  if (platform === 'win32') {
    // install.ps1 puts the launcher in <HERMES_HOME>\bin and adds it to the user PATH, which an
    // Explorer-started app only sees after the next sign-in.
    return [path.win32.join(env.HERMES_HOME?.trim() || path.win32.join(env.LOCALAPPDATA ?? path.win32.join(home, 'AppData', 'Local'), 'hermes'), 'bin')]
  }

  return [path.join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin']
}

function pathRuntime(extraDirs: string[]): BackendRuntime | null {
  // Only `.exe`: execFile/spawn cannot start a `.cmd` shim without a shell.
  const names = process.platform === 'win32' ? ['hermes.exe'] : ['hermes']
  const dirs = [...(process.env.PATH ?? process.env.Path ?? '').split(path.delimiter), ...extraDirs].filter(Boolean)

  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name)

      if (isExecutable(candidate)) {
        return { kind: 'path', label: `hermes on PATH (${candidate})`, command: [candidate] }
      }
    }
  }

  return null
}

/**
 * Ordered ladder. Each rung is validated before it is trusted; a failed read falls to the next.
 *   1. HERALD_OS_HERMES_ROOT (explicit developer override)
 *   2. $HERMES_HOME/hermes-agent managed install (what the official installer and `hermes update` maintain)
 *   3. `hermes` shim on PATH (+ the usual user bin dirs a GUI app does not inherit)
 */
export function resolveBackendRuntime(): BackendRuntime | null {
  const envRoot = osEnv('HERMES_ROOT')?.trim()

  if (envRoot) {
    const runtime = checkoutRuntime(envRoot, 'env', `HERALD_OS_HERMES_ROOT (${envRoot})`)

    if (runtime) {
      return runtime
    }
  }

  const managed = checkoutRuntime(path.join(hermesHome(), 'hermes-agent'), 'managed', 'managed Hermes install')

  if (managed) {
    return managed
  }

  return pathRuntime(extraHermesDirs())
}
