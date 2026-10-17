import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

/** Variables that would let a test reach a real provider or the user's real profile: never inherited. */
const STRIPPED = /^(OPENAI|ANTHROPIC|GROQ|GEMINI|GOOGLE|OPENROUTER|NOUS|ZAI|QWEN|MISTRAL|DEEPSEEK|XAI|TELEGRAM|DISCORD|SLACK|HF|HUGGING)[A-Z_]*(KEY|TOKEN)$|^HERALD_OS_BACKEND_(URL|TOKEN)$/i

export interface Launched {
  app: ElectronApplication
  page: Page
  root: string
  close: () => Promise<void>
}

/** Starts the built shell with every data folder inside a fresh temp directory (never the real profile). */
export async function launchShell(extraEnv: Record<string, string> = {}): Promise<Launched> {
  const root = mkdtempSync(path.join(tmpdir(), 'jarod-e2e-'))
  const env: Record<string, string> = {}

  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !STRIPPED.test(key)) {
      env[key] = value
    }
  }

  Object.assign(env, {
    HERALD_OS_CONFIG_DIR: path.join(root, 'config'),
    JAROD_OS_DATA: path.join(root, 'data'),
    JAROD_WORKSPACE: path.join(root, 'workspace'),
    JAROD_OS_ISOLATED: '1',
    ...extraEnv
  })

  const app = await electron.launch({ args: ['.', `--user-data-dir=${path.join(root, 'user')}`], cwd: path.resolve(import.meta.dirname, '..'), env })
  const page = await app.firstWindow()

  await page.waitForLoadState('domcontentloaded')

  return {
    app,
    page,
    root,
    close: async () => {
      await app.close().catch(() => undefined)
      rmSync(root, { recursive: true, force: true })
    }
  }
}
