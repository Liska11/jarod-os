/*
 * Native gestures the Jarod engine asks for (`jarod.shell` server requests, relayed by the window): file and folder pickers, confirmations, notices, the
 * clipboard, links. The engine has no window of its own, so every dialog the cordis control handlers raise (installing a skill, loading a model file,
 * restoring a backup…) is shown here, by the main process. Rules:
 *   - a dialog that asks for consent defaults to Cancel and answers `true` ONLY for the explicit action button;
 *   - paths come back from the OS dialog, never from the engine; nothing here reads or writes a file;
 *   - links are http(s)/mailto only.
 */

export interface NativeDialogs {
  open(options: { title?: string; properties: ('openFile' | 'openDirectory' | 'createDirectory')[]; filters?: { name: string; extensions: string[] }[]; defaultPath?: string }): Promise<string | null>
  save(options: { defaultPath?: string }): Promise<string | null>
  /** Index of the pressed button, or -1 when the dialog was dismissed. */
  message(options: { type: 'info' | 'question' | 'warning'; message: string; detail?: string; buttons: string[]; defaultId: number; cancelId: number }): Promise<number>
}

export interface NativeEffects {
  writeClipboard(text: string): void
  openExternal(url: string): Promise<void>
  openPath(path: string): Promise<string>
  showItemInFolder(path: string): void
  setThemeSource(source: 'dark' | 'light' | 'system'): void
  quit(): void
  relaunch(): void
  /** Restart the Jarod engine (it reopens on the active profile). The effect defers the actual restart so the answer to this gesture still gets out. */
  restartBackend(): void
  /** One tool call of the agent's browser (see ../agent-browser/host.ts): the answer is `{ ok, snapshot? }` or `{ ok: false, error }`. */
  browser(params: Record<string, unknown>): Promise<unknown>
}

export const str = (value: unknown, max = 4000): string => (typeof value === 'string' ? value.slice(0, max) : '')

function filters(value: unknown): { name: string; extensions: string[] }[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value.slice(0, 10).flatMap(item => {
    const entry = (item ?? {}) as { name?: unknown; extensions?: unknown }
    const extensions = Array.isArray(entry.extensions) ? entry.extensions.filter((e): e is string => typeof e === 'string' && /^[A-Za-z0-9]{1,12}$/.test(e)) : []

    return typeof entry.name === 'string' && extensions.length > 0 ? [{ name: entry.name.slice(0, 60), extensions }] : []
  })
}

/** The lines the user reads before an install from the registry is allowed (what, from where, which licence, which hash, which permissions). */
export function installSummaryText(summary: unknown): { message: string; detail: string } {
  const s = (summary ?? {}) as Record<string, unknown>
  const permissions = Array.isArray(s.permissions) ? s.permissions.filter((p): p is string => typeof p === 'string').slice(0, 30) : []
  const lines = [
    `Source: ${str(s.source, 300)} (revision ${str(s.revision, 80)})`,
    `Licence: ${str(s.license, 80) || 'not stated'}`,
    `SHA-256: ${str(s.sha256, 80)}`,
    `Files: ${typeof s.files === 'number' ? s.files : '?'}`,
    `Installed into: ${str(s.target, 400)}`,
    permissions.length > 0 ? `Permissions it asks for:\n  - ${permissions.join('\n  - ')}` : 'Permissions it asks for: none'
  ]

  return { message: `Install ${str(s.kind, 40)} “${str(s.name, 120) || str(s.id, 120)}”?`, detail: lines.join('\n') }
}

/** Runs one gesture. Resolves with the value the engine's handler expects (a path, a boolean, a string) or null when nothing was chosen. */
export async function runNativeGesture(kind: string, params: Record<string, unknown>, dialogs: NativeDialogs, effects: NativeEffects): Promise<unknown> {
  switch (kind) {
    case 'pickFolder':
      return dialogs.open({ title: 'Choose a folder', properties: ['openDirectory', 'createDirectory'] })
    case 'pickDestinationFolder':
      return dialogs.open({ title: str(params.title, 200) || 'Choose a folder', properties: ['openDirectory', 'createDirectory'], ...(str(params.defaultPath) ? { defaultPath: str(params.defaultPath) } : {}) })
    case 'pickFile':
      return dialogs.open({ title: str(params.title, 200) || 'Open', properties: ['openFile'], filters: filters(params.filters) })
    case 'pickSavePath':
      return dialogs.save({ defaultPath: str(params.defaultName, 260) })
    case 'confirm': {
      const action = str(params.action, 40) || 'OK'

      return (await dialogs.message({ type: 'question', message: str(params.message, 300), detail: str(params.detail, 8000), buttons: [action, 'Cancel'], defaultId: 1, cancelId: 1 })) === 0
    }
    case 'confirmInstall': {
      const { message, detail } = installSummaryText(params.summary)

      return (await dialogs.message({ type: 'warning', message, detail, buttons: ['Install', 'Cancel'], defaultId: 1, cancelId: 1 })) === 0
    }
    case 'notify':
      await dialogs.message({ type: 'info', message: str(params.message, 300), detail: str(params.detail, 3000), buttons: ['OK'], defaultId: 0, cancelId: 0 })

      return true
    case 'clipboard':
      effects.writeClipboard(str(params.text, 1_000_000))

      return true
    case 'openExternal': {
      const url = str(params.url, 2000)

      if (!/^(https?:|mailto:)/i.test(url)) {
        throw new Error('only http(s) and mailto links open')
      }

      await effects.openExternal(url)

      return true
    }
    case 'openPath':
      return effects.openPath(str(params.path, 1000))
    case 'showItemInFolder':
      effects.showItemInFolder(str(params.path, 1000))

      return true
    case 'themeSource': {
      const source = str(params.source, 10)

      if (source === 'dark' || source === 'light' || source === 'system') {
        effects.setThemeSource(source)
      }

      return true
    }
    case 'quit':
      effects.quit()

      return true
    case 'relaunch':
      effects.relaunch()

      return true
    case 'browser':
      return effects.browser(params)
    case 'restartBackend':
      effects.restartBackend()

      return true
    default:
      throw new Error(`unknown gesture: ${kind}`)
  }
}
