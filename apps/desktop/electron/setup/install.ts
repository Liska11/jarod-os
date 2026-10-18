import { execFile } from 'node:child_process'
import { INSTALLABLE_PREREQUISITES } from '../../shared/system-audit.ts'

/*
 * Installs a missing (or outdated) prerequisite from the first-run audit, on Windows. The audit used to show the command to
 * copy and nothing more. Only a closed list of tools can be installed, each by one fixed command: winget for the apps, npm for
 * pnpm, an elevated `wsl --install` for WSL. Nothing from the renderer reaches a command line except the tool's id, checked
 * against that list. The person starts each install with a button; winget accepts the publisher's license for them (the
 * button says so) and Windows asks for permission when an installer needs it.
 */

export const WINGET_IDS = {
  node: 'OpenJS.NodeJS.LTS',
  python: 'Python.Python.3.12',
  git: 'Git.Git',
  ollama: 'Ollama.Ollama',
  docker: 'Docker.DockerDesktop'
} as const

export type InstallableTool = (typeof INSTALLABLE_PREREQUISITES)[number]

export const INSTALLABLE: readonly InstallableTool[] = INSTALLABLE_PREREQUISITES

export function isInstallable(tool: unknown): tool is InstallableTool {
  return typeof tool === 'string' && (INSTALLABLE as readonly string[]).includes(tool)
}

export interface InstallResult {
  ok: boolean
  /** Installed, but Windows must restart before it works (WSL, sometimes Docker). */
  restart?: boolean
  /** Already present and current: nothing was done. */
  already?: boolean
  /** What went wrong, for the screen and the log (the end of the tool's output). */
  error?: string
}

export interface Command {
  command: string
  args: string[]
}

/** The one command for a tool; `upgrade` for an outdated one. */
export function installCommand(tool: InstallableTool, upgrade: boolean): Command {
  if (tool === 'pnpm') {
    // npm is a .cmd shim: it starts only through cmd.exe. The arguments are constants.
    return { command: 'cmd.exe', args: ['/d', '/s', '/c', 'npm install -g pnpm'] }
  }

  if (tool === 'wsl') {
    // Needs administrator rights: Windows shows its own permission prompt; -Wait so the result is known.
    return {
      command: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-Command', "$p = Start-Process -FilePath wsl.exe -ArgumentList '--install','--no-launch' -Verb RunAs -Wait -PassThru; exit $p.ExitCode"]
    }
  }

  // `install` would upgrade a package that is already there; that is the Update button's job, so it says --no-upgrade.
  return {
    command: 'winget',
    args: [
      ...(upgrade ? ['upgrade'] : ['install']),
      '--id',
      WINGET_IDS[tool],
      '--exact',
      '--source',
      'winget',
      ...(upgrade ? [] : ['--no-upgrade']),
      '--silent',
      '--disable-interactivity',
      '--accept-package-agreements',
      '--accept-source-agreements'
    ]
  }
}

/** winget's own outcome codes (HRESULTs, read unsigned). */
const WINGET_ALREADY = new Set([0x8a15002b /* no applicable upgrade */, 0x8a150061 /* already installed */])
const WINGET_RESTART = new Set([0x8a150109 /* reboot required to finish */, 3010 /* ERROR_SUCCESS_REBOOT_REQUIRED */])
const WINGET_NOT_FOUND = 0x8a150014

function tail(text: string, lines = 4): string {
  return text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !/^[-\\|/ █▒]+$/.test(line))
    .slice(-lines)
    .join(' · ')
}

/** Reads a finished command: exit code (any sign) and output → the result shown and logged. */
export function interpret(tool: InstallableTool, code: number | null, output: string): InstallResult {
  const unsigned = code === null ? null : code >>> 0

  if (unsigned === 0) return { ok: true, ...(tool === 'wsl' ? { restart: true } : {}) }
  if (unsigned !== null && WINGET_ALREADY.has(unsigned)) return { ok: true, already: true }
  if (unsigned !== null && WINGET_RESTART.has(unsigned)) return { ok: true, restart: true }
  if (unsigned === WINGET_NOT_FOUND) return { ok: false, error: 'winget does not know this package' }

  return { ok: false, error: `${code === null ? 'stopped (timeout)' : `exit code ${code}`}${output.trim() ? `: ${tail(output)}` : ''}` }
}

export type Runner = (command: Command, env: NodeJS.ProcessEnv, timeoutMs: number) => Promise<{ code: number | null; output: string }>

export const realRunner: Runner = ({ command, args }, env, timeoutMs) =>
  new Promise(resolve => {
    execFile(command, args, { env, timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
      // error.code: the exit code (a number), or a string such as ENOENT when the program itself is missing.
      const raw = (error as { code?: unknown; killed?: boolean } | null)?.code

      if (!error) {
        resolve({ code: 0, output: `${stdout}\n${stderr}` })
      } else if (typeof raw === 'number') {
        resolve({ code: raw, output: `${stdout}\n${stderr}` })
      } else if (raw === 'ENOENT') {
        resolve({ code: -1, output: `${command} is not available on this computer (winget comes with "App Installer" from the Microsoft Store)` })
      } else {
        resolve({ code: (error as { killed?: boolean }).killed ? null : -1, output: `${stdout}\n${stderr}\n${error.message}` })
      }
    })
  })

/** Docker Desktop is a large download: the slowest install gets 30 minutes. */
const TIMEOUT_MS = 30 * 60_000

export async function installPrerequisite(
  tool: InstallableTool,
  options: { upgrade?: boolean; platform?: NodeJS.Platform; env: NodeJS.ProcessEnv; run?: Runner; log: (message: string) => void }
): Promise<InstallResult> {
  if ((options.platform ?? process.platform) !== 'win32') {
    return { ok: false, error: 'automatic install is only available on Windows; use the command shown' }
  }

  const command = installCommand(tool, Boolean(options.upgrade))
  options.log(`installing ${tool}: ${command.command} ${command.args.join(' ')}`)
  const started = Date.now()
  const { code, output } = await (options.run ?? realRunner)(command, options.env, TIMEOUT_MS)
  const result = interpret(tool, code, output)
  options.log(`${tool}: ${result.ok ? (result.already ? 'already installed' : result.restart ? 'installed, restart needed' : 'installed') : `failed — ${result.error}`} (${Math.round((Date.now() - started) / 1000)} s)`)

  return result
}
