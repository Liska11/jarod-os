import { osEnv } from './env.ts'

/*
 * Recovery when the shell's own renderer dies, and safe mode (D3 of the 2026-10-12 analysis).
 *
 * A renderer that crashes leaves a blank window. The first crash reloads the page; a second one within
 * a minute means the reload will not help, so the window shows a recovery page instead: reload anyway,
 * restart in safe mode, or quit. Safe mode starts the shell without what a person adds to it (widget
 * plugins, hook scripts, event automations), which is what most often stops a shell that used to work.
 */

export const SAFE_MODE_FLAG = '--safe-mode'
/** Links on the recovery page; main intercepts the navigation and acts. */
export const RECOVERY_SCHEME = 'jarod-recovery:'
export type RecoveryAction = 'reload' | 'safe-mode' | 'normal-mode' | 'quit'

/** `--safe-mode` on the command line, or HERALD_OS_SAFE_MODE=1. */
export function isSafeMode(argv: readonly string[] = process.argv, env: NodeJS.ProcessEnv = process.env): boolean {
  return argv.includes(SAFE_MODE_FLAG) || osEnv('SAFE_MODE', env) === '1'
}

/** The arguments to relaunch with: this process's own, with the safe-mode flag added or removed. */
export function relaunchArgs(argv: readonly string[], safe: boolean): string[] {
  const rest = argv.slice(1).filter(arg => arg !== SAFE_MODE_FLAG)

  return safe ? [...rest, SAFE_MODE_FLAG] : rest
}

/** The action a recovery-page link asks for, or null for any other URL. */
export function recoveryAction(url: string): RecoveryAction | null {
  if (!url.startsWith(RECOVERY_SCHEME)) {
    return null
  }

  const action = url.slice(RECOVERY_SCHEME.length).replace(/^\/+/, '').replace(/\/+$/, '')

  return action === 'reload' || action === 'safe-mode' || action === 'normal-mode' || action === 'quit' ? action : null
}

/** What to do after the renderer went away: a clean exit is nobody's problem, one crash reloads, two within the window show the recovery page. */
export class CrashPolicy {
  private crashes: number[] = []

  constructor(
    private readonly windowMs = 60_000,
    private readonly reloadsAllowed = 1
  ) {}

  next(reason: string, now: number): 'ignore' | 'reload' | 'recover' {
    if (reason === 'clean-exit') {
      return 'ignore'
    }

    this.crashes = [...this.crashes.filter(at => now - at < this.windowMs), now]

    return this.crashes.length <= this.reloadsAllowed ? 'reload' : 'recover'
  }
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`)

/** The page shown in place of a renderer that keeps crashing. Self-contained: no script, no network, links only. */
export function recoveryPage(reason: string, safeMode: boolean): string {
  const link = (action: RecoveryAction, label: string, primary = false) =>
    `<a class="${primary ? 'primary' : ''}" href="${RECOVERY_SCHEME}${action}">${label}</a>`
  const modeLink = safeMode ? link('normal-mode', 'Restart normally') : link('safe-mode', 'Restart in safe mode', true)

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>Jarod-OS</title><style>
body{margin:0;height:100vh;display:grid;place-items:center;background:#07080a;color:#e8e9ec;font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:520px;padding:32px}h1{font-size:22px;margin:0 0 8px}p{color:#a3a7b0;margin:0 0 20px}
code{color:#e8e9ec}nav{display:flex;gap:10px;flex-wrap:wrap}
a{padding:9px 16px;border-radius:8px;border:1px solid #2c2f36;color:#e8e9ec;text-decoration:none}
a.primary{background:#e8e9ec;color:#07080a;border-color:#e8e9ec}a:focus-visible{outline:2px solid #6aa1ff;outline-offset:2px}
</style></head><body><main>
<h1>The Jarod-OS window stopped twice</h1>
<p>Its page crashed (<code>${escapeHtml(reason)}</code>) and crashed again after a reload. Your conversations and files are safe.
${safeMode ? 'Safe mode is already on.' : 'Safe mode starts without widget plugins, hook scripts and event automations, the usual suspects.'}</p>
<nav>${modeLink}${link('reload', 'Reload')}${link('quit', 'Quit')}</nav>
</main></body></html>`
}
