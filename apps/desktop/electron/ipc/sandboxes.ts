import path from 'node:path'
import { ipcMain, shell } from 'electron'
import { IPC } from '../../shared/ipc.ts'
import type { SandboxResult, SandboxesState } from '../../shared/sandboxes.ts'
import { log } from '../log.ts'
import { applySandbox, compareSandbox, createSandbox, listSandboxes, sandboxPath } from '../sandboxes.ts'
import { assertWritablePath } from './path-guard.ts'

/*
 * Sandboxes of the Jarod disk (electron/sandboxes.ts): copies of a project in <JAROD_OS_ROOT>\sandboxes to try things
 * in, compared with and applied to their project, or thrown away (to the Recycle Bin). A project must be a folder
 * Jarod-OS may edit (home or the Jarod disk), since applying writes into it.
 */

const folder = (env: NodeJS.ProcessEnv = process.env): string | null => {
  const root = env.JAROD_OS_ROOT?.trim()

  return root ? path.join(root, 'sandboxes') : null
}

const failure = (error: unknown): SandboxResult => ({ ok: false, error: error instanceof Error ? error.message : String(error) })

export function registerSandboxesIpc(): void {
  let busy = false

  const guarded = async (work: (dir: string) => Promise<SandboxResult>): Promise<SandboxResult> => {
    const dir = folder()

    if (!dir) return { ok: false, error: 'no-disk' }
    if (busy) return { ok: false, error: 'busy' }

    busy = true

    try {
      return await work(dir)
    } catch (error) {
      log('sandboxes', `failed: ${error instanceof Error ? error.message : String(error)}`)

      return failure(error)
    } finally {
      busy = false
    }
  }

  ipcMain.handle(IPC.sandboxesState, (): SandboxesState => {
    const dir = folder()

    return { available: Boolean(dir), folder: dir, busy, list: dir ? listSandboxes(dir) : [] }
  })
  ipcMain.handle(IPC.sandboxesCreate, (_event, source: unknown, label: unknown, full: unknown) =>
    guarded(async dir => {
      if (typeof source !== 'string') throw new Error('not-a-folder')

      assertWritablePath(path.join(source, 'x'))
      const info = await createSandbox(dir, source, typeof label === 'string' ? label : '', full === true)
      log('sandboxes', `created ${info.name} from ${source}${info.full ? ' (full copy)' : ''}`)

      return { ok: true, name: info.name, path: path.join(dir, info.name) }
    })
  )
  ipcMain.handle(IPC.sandboxesCompare, (_event, name: unknown) =>
    guarded(async dir => ({ ok: true, changes: await compareSandbox(dir, String(name)) }))
  )
  ipcMain.handle(IPC.sandboxesApply, (_event, name: unknown, only: unknown) =>
    guarded(async dir => {
      const info = listSandboxes(dir).find(item => item.name === name)

      if (!info) throw new Error('not-a-sandbox')

      assertWritablePath(path.join(info.source, 'x'))
      const paths = Array.isArray(only) ? only.filter((item): item is string => typeof item === 'string') : undefined
      const applied = await applySandbox(dir, info.name, file => shell.trashItem(file), paths)
      log('sandboxes', `applied ${applied.length} change(s) from ${info.name} to ${info.source}`)

      return { ok: true, changes: applied }
    })
  )
  ipcMain.handle(IPC.sandboxesRemove, (_event, name: unknown) =>
    guarded(async dir => {
      const target = sandboxPath(dir, String(name))
      await shell.trashItem(target)
      log('sandboxes', `sent ${name} to the Recycle Bin`)

      return { ok: true }
    })
  )
}
