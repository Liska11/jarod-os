import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import { log } from '../log.ts'
import { isShellPage } from '../paths.ts'

/**
 * One check for every IPC channel (audit A-06): a message is served only when it comes from the main
 * frame of a page of this app — the dev server's origin in development, the bundled renderer file in a
 * package (`isShellPage`). That is the main window, the floating surfaces and the emoji panel, which all
 * load the shell's page. Everything else is refused before the handler runs: a web view or a web-app
 * window showing an external site, an iframe (a widget plugin, a page embedded in the shell), a frame
 * that already went away, and a shell window that was navigated elsewhere (the recovery page).
 *
 * Today none of those can reach `ipcRenderer` (only shell windows have the preload, and their navigation
 * is locked), so this is defence in depth: if a preload ever lands where it should not, it still gets
 * nothing. The guard wraps `ipcMain` itself, so a channel registered later cannot forget it.
 */

/** What the check reads of `event.senderFrame` (a `WebFrameMain`). */
export interface SenderFrame {
  readonly url: string
  readonly parent: SenderFrame | null
}

/** What the check reads of an IPC event; both `IpcMainEvent` and `IpcMainInvokeEvent` fit. */
export interface SenderEvent {
  readonly senderFrame: SenderFrame | null
}

export type SenderVerdict = { ok: true } | { ok: false; reason: 'no-frame' | 'subframe' | 'foreign-page' }

/** Where the shell's page lives; defaults to this process's (see `isShellPage`). */
export type ShellPageTest = (url: string) => boolean

export function checkSender(event: SenderEvent, isShell: ShellPageTest = url => isShellPage(url)): SenderVerdict {
  let frame: SenderFrame | null = null

  try {
    // Reading a frame that was disposed (navigated or destroyed meanwhile) throws.
    frame = event.senderFrame
  } catch {
    frame = null
  }

  if (!frame) {
    return { ok: false, reason: 'no-frame' }
  }

  if (frame.parent) {
    return { ok: false, reason: 'subframe' }
  }

  return isShell(frame.url) ? { ok: true } : { ok: false, reason: 'foreign-page' }
}

/** The origin of a frame URL for the log: never the path or query, which may carry data. */
function originOf(event: SenderEvent): string {
  try {
    const url = event.senderFrame?.url

    if (!url) {
      return 'unknown'
    }

    const parsed = new URL(url)

    return parsed.origin === 'null' ? `${parsed.protocol}` : parsed.origin
  } catch {
    return 'unknown'
  }
}

export interface GuardOptions {
  isShell?: ShellPageTest
  logger?: (message: string) => void
  /** Clock for the log throttle. */
  now?: () => number
}

/** One line per channel, origin and reason every ten seconds: a refused sender cannot flood the log. */
const LOG_EVERY_MS = 10_000

type Guardable = Pick<IpcMain, 'handle' | 'handleOnce' | 'on' | 'once'>

const installed = new WeakSet<object>()

/**
 * Wraps `ipc.handle`, `ipc.handleOnce`, `ipc.on` and `ipc.once` so every listener registered afterwards
 * runs only for a trusted sender. A refused `invoke` rejects with a generic error; a refused `send` is
 * dropped. Refusals are logged with the channel, the sender's origin and the reason — never the payload.
 * Call it before the first registration. Installing twice is a no-op.
 */
export function installIpcSenderGuard(ipc: Guardable, options: GuardOptions = {}): void {
  if (installed.has(ipc)) {
    return
  }

  installed.add(ipc)

  const isShell = options.isShell ?? (url => isShellPage(url))
  const logger = options.logger ?? (message => log('ipc', message))
  const now = options.now ?? Date.now
  const lastLogged = new Map<string, number>()

  const refused = (channel: string, event: SenderEvent): boolean => {
    const verdict = checkSender(event, isShell)

    if (verdict.ok) {
      return false
    }

    const origin = originOf(event)
    const key = `${channel}\n${origin}\n${verdict.reason}`
    const at = now()
    const last = lastLogged.get(key)

    if (last === undefined || at - last >= LOG_EVERY_MS) {
      lastLogged.set(key, at)
      logger(`refused ${channel} from ${origin} (${verdict.reason})`)
    }

    return true
  }

  const handle = ipc.handle.bind(ipc)
  const handleOnce = ipc.handleOnce.bind(ipc)
  const on = ipc.on.bind(ipc)
  const once = ipc.once.bind(ipc)

  // The handlers type their own arguments; the guard only passes them through.
  type InvokeListener = (event: IpcMainInvokeEvent, ...args: never[]) => unknown
  type SendListener = (event: IpcMainEvent, ...args: never[]) => void

  const guardInvoke =
    (channel: string, listener: InvokeListener) =>
    (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      if (refused(channel, event)) {
        throw new Error('This sender may not use the shell.')
      }

      return listener(event, ...(args as never[]))
    }
  const guardSend =
    (channel: string, listener: SendListener) =>
    (event: IpcMainEvent, ...args: unknown[]) => {
      if (!refused(channel, event)) {
        listener(event, ...(args as never[]))
      }
    }

  ipc.handle = (channel, listener) => handle(channel, guardInvoke(channel, listener))
  ipc.handleOnce = (channel, listener) => handleOnce(channel, guardInvoke(channel, listener))
  ipc.on = ((channel: string, listener: SendListener) => on(channel, guardSend(channel, listener))) as Guardable['on']
  ipc.once = ((channel: string, listener: SendListener) => once(channel, guardSend(channel, listener))) as Guardable['once']
}
