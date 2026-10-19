import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

/** Variables that would let a test reach a real provider or the user's real profile: never inherited. */
const STRIPPED = /^(OPENAI|ANTHROPIC|GROQ|GEMINI|GOOGLE|OPENROUTER|NOUS|ZAI|QWEN|MISTRAL|DEEPSEEK|XAI|TELEGRAM|DISCORD|SLACK|HF|HUGGING)[A-Z_]*(KEY|TOKEN)$|^JAROD_OS_BACKEND_(URL|TOKEN)$/i

/** The prefix of every throwaway root; `global-setup.ts` checks that a run leaves none of its own behind. */
export const ROOT_PREFIX = 'jarod-e2e-'

export interface Launched {
  app: ElectronApplication
  page: Page
  root: string
  /** Closes the app; removes the root too when this launch owns it. */
  close: () => Promise<void>
}

export interface LaunchOptions {
  /** Relaunch on an existing root (same config, data and workspace; a fresh Electron profile inside it). */
  root?: string
  /** Whether `close` removes the root. True for a fresh root; for an existing one, only the last launch on it should own it. */
  own?: boolean
  /** Extra Chromium/Electron switches (the voice latency test's fake microphone). */
  args?: string[]
}

/** Ids of the processes whose command line holds `needle` (this one excluded); the needle goes through the environment. */
function processesHolding(needle: string): number[] {
  const script = 'Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($env:E2E_NEEDLE) -and $_.ProcessId -ne $PID } | ForEach-Object { $_.ProcessId }'

  try {
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 15_000, windowsHide: true, env: { ...process.env, E2E_NEEDLE: needle } })

    return out
      .split(/\r?\n/)
      .map(Number)
      .filter(pid => Number.isInteger(pid) && pid > 0 && pid !== process.pid)
  } catch {
    return []
  }
}

/**
 * Removes a throwaway root. Windows keeps files locked for a moment after Electron quits, and a child that outlived it can hold them for
 * good: retry, and stop what still carries this root on its command line (the root has a random suffix, so nothing else does). A root that
 * still cannot be removed is an error, not a silent leftover: hundreds of them had piled up in %TEMP% before.
 */
export async function removeRoot(root: string): Promise<void> {
  if (!path.basename(root).startsWith(ROOT_PREFIX) || path.dirname(path.resolve(root)) !== path.resolve(tmpdir())) {
    throw new Error(`not a throwaway e2e root: ${root}`)
  }

  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      rmSync(root, { recursive: true, force: true })
    } catch {
      /* locked: retried below */
    }

    if (!existsSync(root)) {
      return
    }

    if (attempt === 4 && process.platform === 'win32') {
      for (const pid of processesHolding(path.resolve(root))) {
        try {
          execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
        } catch {
          /* already gone */
        }
      }
    }

    await new Promise(resolve => setTimeout(resolve, 250))
  }

  throw new Error(`could not remove the e2e root ${root}`)
}

/** Starts the built shell with every data folder inside a fresh temp directory (never the real profile). */
export async function launchShell(extraEnv: Record<string, string> = {}, options: LaunchOptions = {}): Promise<Launched> {
  const root = options.root ?? mkdtempSync(path.join(tmpdir(), ROOT_PREFIX))
  const own = options.own ?? options.root === undefined
  // A relaunch keeps the root's config, data and workspace but starts Electron on a profile of its own, as before.
  const user = options.root ? mkdtempSync(path.join(root, 'user-')) : path.join(root, 'user')
  const env: Record<string, string> = {}

  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !STRIPPED.test(key)) {
      env[key] = value
    }
  }

  Object.assign(env, {
    // The Hermes home too: without it a test run wrote the app log, migrations and the bridge plugin link into the real one.
    HERMES_HOME: path.join(root, 'hermes'),
    JAROD_OS_CONFIG_DIR: path.join(root, 'config'),
    JAROD_OS_DATA: path.join(root, 'data'),
    JAROD_WORKSPACE: path.join(root, 'workspace'),
    JAROD_OS_ISOLATED: '1',
    ...extraEnv
  })

  const app = await electron.launch({ args: ['.', `--user-data-dir=${user}`, ...(options.args ?? [])], cwd: path.resolve(import.meta.dirname, '..'), env })
  const page = await app.firstWindow()

  await page.waitForLoadState('domcontentloaded')

  return {
    app,
    page,
    root,
    close: async () => {
      await app.close().catch(() => undefined)

      if (own) {
        await removeRoot(root)
      }
    }
  }
}
