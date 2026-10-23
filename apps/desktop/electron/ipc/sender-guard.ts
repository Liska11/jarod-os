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
 * BL-01 (audit du 2026-10-19), preuve observable : les canaux enregistrés PAR le garde, et ceux qui l'étaient déjà quand il a été posé (qui
 * lui échapperaient). Le test de bout en bout compare cette liste à TOUS les gestionnaires qu'Electron connaît dans l'application réelle :
 * l'égalité prouve qu'aucun canal ne contourne le contrôle d'émetteur.
 */
export interface IpcGuardReport {
  before: string[]
  guarded: string[]
  /** Présents avant le garde mais pas des canaux de Jarod : l'événement `error` de l'émetteur, et ceux qu'Electron enregistre lui-même. */
  electron: string[]
}

/**
 * Ce qu'Electron (ou l'émetteur d'événements de Node) pose lui-même sur `ipcMain` avant tout code de l'application — mesuré dans l'application
 * réelle (BL-01, 2026-10-21) : ce ne sont pas des canaux de Jarod, le garde n'a pas à les envelopper. Toute AUTRE présence antérieure est signalée.
 */
export const ELECTRON_INTERNAL_CHANNELS: ReadonlySet<string> = new Set(['error', 'IMPORT_SHARED_TEXTURE_RELEASE_RENDERER_TO_MAIN'])

const reports = new WeakMap<object, { before: string[]; electron: string[]; guarded: Set<string> }>()

/** Ce que le garde sait de `ipc` (null s'il n'y est pas posé). */
export function ipcGuardReport(ipc: object): IpcGuardReport | null {
  const r = reports.get(ipc)

  return r ? { before: [...r.before], guarded: [...r.guarded].sort(), electron: [...r.electron] } : null
}

/** Les canaux déjà présents sur `ipc` : écouteurs (`on`) et gestionnaires (`handle`, table interne d'Electron quand elle est lisible). */
function registeredChannels(ipc: object): string[] {
  const names = new Set<string>()
  const emitter = ipc as { eventNames?: () => (string | symbol)[]; _invokeHandlers?: Map<string, unknown> }

  for (const name of emitter.eventNames?.() ?? []) {
    if (typeof name === 'string') {
      names.add(name)
    }
  }

  for (const name of emitter._invokeHandlers?.keys() ?? []) {
    names.add(name)
  }

  return [...names].sort()
}

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
  const present = registeredChannels(ipc)
  const report = { before: present.filter(c => !ELECTRON_INTERNAL_CHANNELS.has(c)), electron: present.filter(c => ELECTRON_INTERNAL_CHANNELS.has(c)), guarded: new Set<string>() }

  reports.set(ipc, report)

  // Un canal enregistré AVANT le garde lui échappe : le dire fort (le test de bout en bout l'exige vide).
  if (report.before.length > 0) {
    logger(`${report.before.length} channel(s) registered before the sender guard, NOT checked: ${report.before.join(', ')}`)
  }
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

  const note = (channel: string) => void report.guarded.add(channel)

  ipc.handle = (channel, listener) => (note(channel), handle(channel, guardInvoke(channel, listener)))
  ipc.handleOnce = (channel, listener) => (note(channel), handleOnce(channel, guardInvoke(channel, listener)))
  ipc.on = ((channel: string, listener: SendListener) => (note(channel), on(channel, guardSend(channel, listener)))) as Guardable['on']
  ipc.once = ((channel: string, listener: SendListener) => (note(channel), once(channel, guardSend(channel, listener)))) as Guardable['once']
}
