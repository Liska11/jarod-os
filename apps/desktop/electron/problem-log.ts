import type { App, IpcMain, IpcMainInvokeEvent, WebContents } from 'electron'

/*
 * Every problem the app meets reaches herald-os.log, not only the main process's own:
 * - a rejected promise nobody handled in the main process (uncaught exceptions were already logged);
 * - what a window prints as an error or a warning: uncaught exceptions and unhandled rejections of the page, the React
 *   error boundary, and the error toasts (`notify` prints them), from every window, popouts and surfaces included;
 * - every IPC call that fails, with its channel: Electron only wrote those to stderr.
 * A repeating problem is counted, not written again and again: a loop must not drown the log.
 */

type Log = (scope: string, message: string) => void

/** At most `limit` lines per key in each `windowMs`; past that, one summary line when the window ends. */
export class Throttle {
  private readonly seen = new Map<string, { since: number; count: number }>()

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now
  ) {}

  /** True when the line may be written; a line saying how many were held back comes first when a window has ended. */
  take(key: string, write: (summary: string) => void): boolean {
    const t = this.now()
    const entry = this.seen.get(key)

    if (!entry || t - entry.since >= this.windowMs) {
      if (entry && entry.count > this.limit) {
        write(`(${entry.count - this.limit} more held back in ${Math.round(this.windowMs / 1000)} s)`)
      }

      this.seen.set(key, { since: t, count: 1 })

      return true
    }

    entry.count++

    return entry.count <= this.limit
  }
}

export interface ConsoleDetails {
  level: unknown
  message: string
  lineNumber?: number
  sourceId?: string
}

/** Electron gives the level as a word (35+) or as a number (older): 2 = warning, 3 = error. */
function levelOf(level: unknown): 'error' | 'warning' | 'other' {
  if (level === 'error' || level === 3) return 'error'
  if (level === 'warning' || level === 2) return 'warning'

  return 'other'
}

/** The log line for a console message worth keeping (errors and warnings), or null. */
export function consoleProblem(details: ConsoleDetails): string | null {
  const level = levelOf(details.level)

  if (level === 'other') {
    return null
  }

  const where = details.sourceId ? ` (${details.sourceId.replace(/^.*\/(?=[^/]+$)/, '')}:${details.lineNumber ?? 0})` : ''

  return `${level}: ${details.message}${where}`
}

/** Reads a `console-message` listener's arguments in both shapes (one details event, or event + positional args). */
function detailsOf(args: unknown[]): ConsoleDetails {
  const [event, level, message, lineNumber, sourceId] = args as [Record<string, unknown> | undefined, unknown, unknown, unknown, unknown]

  if (event && typeof event.message === 'string') {
    return { level: event.level, message: event.message, lineNumber: event.lineNumber as number | undefined, sourceId: event.sourceId as string | undefined }
  }

  return { level, message: String(message ?? ''), lineNumber: lineNumber as number | undefined, sourceId: sourceId as string | undefined }
}

export function watchConsole(contents: Pick<WebContents, 'on' | 'id'>, log: Log, throttle = new Throttle(50, 60_000)): void {
  ;(contents.on as (event: string, listener: (...args: unknown[]) => void) => void)('console-message', (...args: unknown[]) => {
    const line = consoleProblem(detailsOf(args))

    if (line && throttle.take(`${contents.id}:${line.slice(0, 200)}`, summary => log('renderer', summary))) {
      log('renderer', line)
    }
  })
}

/** Wraps `ipcMain.handle` so a failing handler is logged with its channel, then fails as before for the caller. */
export function logIpcFailures(ipc: Pick<IpcMain, 'handle'>, log: Log, throttle = new Throttle(20, 60_000)): void {
  const original = ipc.handle.bind(ipc)

  ipc.handle = ((channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) =>
    original(channel, async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      try {
        return await listener(event, ...args)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)

        if (throttle.take(`${channel}:${message.slice(0, 200)}`, summary => log('ipc', `${channel}: ${summary}`))) {
          log('ipc', `${channel} failed: ${message}`)
        }

        throw error
      }
    })) as IpcMain['handle']
}

/** Installed once, before any handler is registered and any window is created. */
export function installProblemLogging(app: Pick<App, 'on'>, ipc: Pick<IpcMain, 'handle'>, log: Log): void {
  process.on('unhandledRejection', reason => log('main', `unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`))
  logIpcFailures(ipc, log)
  app.on('web-contents-created', (_event: unknown, contents: WebContents) => watchConsole(contents, log))
}
