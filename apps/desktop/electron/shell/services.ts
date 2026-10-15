import { execFile, spawn } from 'node:child_process'
import { BrowserWindow, ipcMain } from 'electron'
import { type ClipboardEntry, type HeraldOsResult, IPC, type PowerAction } from '../../shared/ipc.ts'
import { log } from '../log.ts'
import { cliActionId, POWER_ACTIONS } from './host-actions.ts'
import type { HostControlGate } from './host-control.ts'
import { powerCommand } from './power.ts'

function run(command: string, args: string[], input?: string, timeout = 60_000): Promise<HeraldOsResult> {
  return new Promise(resolve => {
    const child = execFile(command, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? ((error as NodeJS.ErrnoException & { code?: number | string }).code === 'ENOENT' ? 127 : (child.exitCode ?? 1)) : 0
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? (error?.message ?? '')) })
    })

    if (input !== undefined) {
      child.stdin?.end(input)
    }
  })
}

/**
 * Runs one `herald-os` invocation for the person at the machine, through the control gate. The verb
 * becomes a catalogue id, so an undeclared one is refused — and journalled — before any process is
 * started; a declared mutation is tiered and journalled like every other host action. Shared by the
 * window IPC below and by main's own preference path, so there is one route to the CLI, not two.
 */
export async function runCliThroughGate(gate: HostControlGate, argv: string[], source: string): Promise<HeraldOsResult> {
  const id = cliActionId(argv) ?? `cli.${String(argv[0] ?? '').trim()}`
  const gated = await gate.submitLocal({ client: 'ui', command: id, args: {}, source })

  if (gated.kind === 'reply') {
    return { code: 126, stdout: '', stderr: gated.reply.error ?? 'The shell refused that command.' }
  }

  // Long installs may exceed a minute; give package managers room.
  const timeout = argv[0] === 'install' || argv[0] === 'remove' || argv[0] === 'update' ? 20 * 60_000 : 60_000
  const result = await run('herald-os', argv, undefined, timeout)

  gated.finish({ ok: result.code === 0, reason: result.code === 0 ? undefined : `herald-os exited ${result.code}` })

  return result
}

/**
 * System services every surface can reach: the CLI and clipboard history (Linux only), power actions
 * (Linux and Windows). The CLI takes the control gate (R3.1): a window may only ask for a verb the
 * host catalogue declares, and every spawn is tiered and journalled like any other host action.
 */
export function registerServiceIpc(gate: HostControlGate): void {
  ipcMain.handle(IPC.shellHeraldOs, async (event, args: string[]): Promise<HeraldOsResult> => {
    if (process.platform !== 'linux') {
      return { code: 127, stdout: '', stderr: 'herald-os CLI is only available on Jarod-OS Linux' }
    }

    if (!Array.isArray(args) || args.some(a => typeof a !== 'string')) {
      throw new Error('herald-os arguments must be strings')
    }

    if (!BrowserWindow.fromWebContents(event.sender)) {
      return { code: 126, stdout: '', stderr: 'This window may not run the shell CLI.' }
    }

    const result = await runCliThroughGate(gate, args, 'services')
    log('services', `herald-os ${args.join(' ')} -> ${result.code}`)

    return result
  })

  ipcMain.handle(IPC.shellPower, async (event, action: PowerAction) => {
    if (!BrowserWindow.fromWebContents(event.sender)) {
      throw new Error('This window may not control the power state.')
    }

    const command = powerCommand(process.platform, action)
    const id = POWER_ACTIONS[action]

    if (!command || !id) {
      throw new Error(`power action ${String(action)} is not available on ${process.platform}`)
    }

    // Power is a host action like every other one: the window names a catalogued id, the gate tiers
    // and journals it, and only then does the machine-level command run (R3.2). The confirmation the
    // person answered in the power menu is what stands for the click.
    const gated = await gate.submitLocal({ client: 'ui', command: id, args: {}, source: 'power' })

    if (gated.kind === 'reply') {
      log('services', `power ${action} refused: ${gated.reply.error ?? 'denied'}`)

      throw new Error(gated.reply.error ?? 'The shell refused that power action.')
    }

    log('services', `power ${action}`)
    gated.finish({ ok: true })
    const child = spawn(command[0], command.slice(1), { detached: true, stdio: 'ignore' })
    child.on('error', error => log('services', `${command[0]} failed: ${error.message}`))
    child.unref()
  })

  ipcMain.handle(IPC.clipboardHistory, async (_event, limit = 50): Promise<ClipboardEntry[]> => {
    const result = await run('cliphist', ['list'], undefined, 5000)

    if (result.code !== 0) {
      return []
    }

    return result.stdout
      .split('\n')
      .filter(Boolean)
      .slice(0, Math.max(1, Math.min(200, limit)))
      .map(line => {
        const tab = line.indexOf('\t')

        return tab > 0 ? { id: line.slice(0, tab), preview: line.slice(tab + 1) } : { id: line, preview: line }
      })
  })

  ipcMain.handle(IPC.clipboardPaste, async (_event, id: string) => {
    if (!/^\d+$/.test(String(id))) {
      throw new Error('clipboard entry ids are numeric')
    }

    // cliphist decode expects the id (or the full list line) on stdin and prints the raw content.
    const decoded = await new Promise<Buffer>((resolve, reject) => {
      const child = execFile('cliphist', ['decode'], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
        if (error) {
          reject(error)
        } else {
          resolve(stdout as unknown as Buffer)
        }
      })
      child.stdin?.end(`${id}\n`)
    })

    await new Promise<void>((resolve, reject) => {
      const copy = spawn('wl-copy', [], { stdio: ['pipe', 'ignore', 'ignore'] })
      copy.on('error', reject)
      copy.on('exit', () => resolve())
      copy.stdin.end(decoded)
    })
  })
}
