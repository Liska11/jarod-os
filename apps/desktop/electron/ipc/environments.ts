import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { ipcMain, net, shell } from 'electron'
import type { EnvironmentResult, EnvironmentsState } from '../../shared/environments.ts'
import { IPC } from '../../shared/ipc.ts'
import { type BuildTools, createEnvironment, isEnvironmentName, listEnvironments, run } from '../environments.ts'
import { log } from '../log.ts'

/*
 * Environments of the Jarod disk (electron/environments.ts): built on request from Settings (Python with uv, Node.js
 * from nodejs.org), opened in a Terminal tab, thrown away to the Recycle Bin. One build at a time.
 */

const folder = (): string | null => {
  const root = process.env.JAROD_OS_ROOT?.trim()

  return root ? path.join(root, 'environments') : null
}

const tools: BuildTools = {
  run,
  uv: 'uv',
  nodeIndex: async () => {
    const response = await net.fetch('https://nodejs.org/dist/index.json')

    if (!response.ok) throw new Error(`nodejs.org answered ${response.status}`)

    return (await response.json()) as Array<{ version: string; files?: string[] }>
  },
  download: async (url, file) => {
    const response = await net.fetch(url)

    if (!response.ok || !response.body) throw new Error(`${url}: ${response.status}`)

    await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), fs.createWriteStream(file))
  }
}

const failure = (error: unknown): EnvironmentResult => {
  const message = error instanceof Error ? error.message : String(error)

  // uv itself is missing (it ships with Jarod's engines; the Software section installs it otherwise).
  return { ok: false, error: message.startsWith('uv failed') && /ENOENT|not recognized/.test(message) ? 'no-uv' : message }
}

export function registerEnvironmentsIpc(): void {
  let building: string | null = null

  ipcMain.handle(IPC.environmentsState, (): EnvironmentsState => {
    const dir = folder()

    return { available: Boolean(dir), folder: dir, building, list: dir ? listEnvironments(dir) : [] }
  })
  ipcMain.handle(IPC.environmentsCreate, async (_event, name: unknown, kind: unknown, version: unknown): Promise<EnvironmentResult> => {
    const dir = folder()

    if (!dir) return { ok: false, error: 'no-disk' }
    if (building) return { ok: false, error: 'busy' }
    if (kind !== 'python' && kind !== 'node') return { ok: false, error: 'bad-kind' }
    if (!isEnvironmentName(name)) return { ok: false, error: 'bad-name' }

    building = name
    const started = Date.now()

    try {
      const info = await createEnvironment(dir, name, kind, String(version), tools)
      log('environments', `built ${info.name}: ${info.kind} ${info.version} in ${Math.round((Date.now() - started) / 1000)} s`)

      return { ok: true, name: info.name }
    } catch (error) {
      log('environments', `building ${name} (${kind} ${version}) failed: ${error instanceof Error ? error.message : String(error)}`)

      return failure(error)
    } finally {
      building = null
    }
  })
  ipcMain.handle(IPC.environmentsRemove, async (_event, name: unknown): Promise<EnvironmentResult> => {
    const dir = folder()

    if (!dir || !isEnvironmentName(name) || !listEnvironments(dir).some(item => item.name === name)) return { ok: false, error: 'not-an-environment' }

    await shell.trashItem(path.join(dir, name))
    log('environments', `sent ${name} to the Recycle Bin`)

    return { ok: true }
  })
}
