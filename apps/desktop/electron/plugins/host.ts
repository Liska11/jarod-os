import { BrowserWindow, type IpcMainInvokeEvent, ipcMain, protocol, shell } from 'electron'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import { writeFileAtomic } from '../atomic-write.ts'
import os from 'node:os'
import path from 'node:path'
import { IPC, type ShellCommand } from '../../shared/ipc.ts'
import { allowed, grantCovers, pluginCsp, type PluginGrant, type PluginMethod, type PluginView, validateManifest } from '../../shared/plugins.ts'
import { log } from '../log.ts'
import { hostPlatform } from '../platform/index.ts'
import { PLUGIN_ACTIONS } from '../shell/host-actions.ts'
import type { HostControlGate } from '../shell/host-control.ts'
import type { OsCommandBridge } from '../shell/os-control.ts'
import { WIDGET_SDK } from './sdk.ts'
import { shellConfigDir } from '../paths.ts'

/*
 * Widget plugins (ADR-019). Each lives in ~/.config/herald-os/plugins/<id>; the shell shows enabled
 * ones in sandboxed frames served from herald-plugin://<id>/ under a strict CSP, and answers their
 * messages here, checking the manifest's permissions (the renderer checks too, but main decides).
 */

const MAX_VALUE_BYTES = 64 * 1024
const MAX_STORE_BYTES = 256 * 1024

const configDir = () => shellConfigDir()
export const pluginsDir = (): string => path.join(configDir(), 'plugins')
const stateFile = () => path.join(configDir(), 'plugins.json')
const storeFile = (id: string) => path.join(configDir(), 'plugin-data', `${id}.json`)

interface State {
  enabled: Record<string, PluginGrant>
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

function writeJson(file: string, value: unknown): void {
  writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`)
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2'
}

function git(args: string[], cwd?: string): Promise<{ code: number; output: string }> {
  return new Promise(resolve => {
    execFile('git', args, { cwd, timeout: 120_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (error, stdout, stderr) => {
      resolve({ code: error ? 1 : 0, output: `${stdout}${stderr}`.trim() })
    })
  })
}

export class PluginHost {
  private revisions = new Map<string, number>()
  private watcher: fs.FSWatcher | null = null
  private changeTimer: ReturnType<typeof setTimeout> | null = null
  private changed = new Set<string>()
  private control: HostControlGate | null = null

  constructor(
    private readonly getWindows: () => BrowserWindow[],
    private readonly getMain: () => BrowserWindow | null,
    private readonly osBridge: OsCommandBridge,
    /** Safe mode: every plugin is listed, none runs. */
    private readonly safeMode = false
  ) {}

  /**
   * The gate a plugin's OS commands go through, once main has built it (R2.2). Until then
   * `runCommand` refuses: a plugin never gets an ungated path just because it asked early.
   */
  setControl(gate: HostControlGate): void {
    this.control = gate
  }

  list(): PluginView[] {
    const state = readJson<State>(stateFile(), { enabled: {} })
    let folders: string[] = []

    try {
      folders = fs.readdirSync(pluginsDir(), { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name)
    } catch {
      return []
    }

    return folders.sort().map(folder => {
      const dir = path.join(pluginsDir(), folder)
      const raw = readJson<unknown>(path.join(dir, 'manifest.json'), null)
      const { manifest, errors } = raw === null ? { manifest: null, errors: ['manifest.json is missing or not valid JSON'] } : validateManifest(raw, folder)

      if (manifest && !fs.existsSync(path.join(dir, manifest.entry))) {
        errors.push(`${manifest.entry} is missing`)
      }

      const usable = manifest && errors.length === 0 ? manifest : null

      return {
        manifest: usable ?? { id: folder, name: folder, version: '0.0.0', entry: 'index.html', placement: [], permissions: [], hosts: [] },
        enabled: !this.safeMode && Boolean(usable && grantCovers(state.enabled[folder], usable)),
        errors,
        dir,
        git: fs.existsSync(path.join(dir, '.git')),
        revision: this.revisions.get(folder) ?? 0
      }
    })
  }

  private find(id: string): PluginView | null {
    return this.list().find(plugin => plugin.manifest.id === id) ?? null
  }

  setEnabled(id: string, enabled: boolean): PluginView[] {
    const state = readJson<State>(stateFile(), { enabled: {} })
    const plugin = this.find(id)

    if (enabled) {
      if (!plugin || plugin.errors.length) {
        throw new Error(plugin ? `${id} cannot run: ${plugin.errors.join('; ')}` : `no plugin ${id}`)
      }

      // The grant is exactly what the manifest asks for now, which the person just read.
      state.enabled[id] = { permissions: [...plugin.manifest.permissions], hosts: [...plugin.manifest.hosts] }
    } else {
      delete state.enabled[id]
    }

    writeJson(stateFile(), state)
    this.broadcast()

    return this.list()
  }

  /** Clone a plugin from git into the plugins folder, validated and off. */
  async add(url: string): Promise<PluginView> {
    if (!/^(https:\/\/|git@|ssh:\/\/)[^\s]+$/.test(url)) {
      throw new Error('Give an https or ssh git URL')
    }

    const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'herald-plugin-'))

    try {
      const cloned = await git(['clone', '--depth', '1', '--', url, staging])

      if (cloned.code !== 0) {
        throw new Error(`git clone failed: ${cloned.output.trim().split('\n').pop()}`)
      }

      if (!fs.existsSync(path.join(staging, 'manifest.json'))) {
        throw new Error('Not a Jarod-OS plugin: there is no manifest.json at the top of the repository')
      }

      const raw = readJson<{ id?: unknown }>(path.join(staging, 'manifest.json'), {})
      const id = typeof raw.id === 'string' ? raw.id : ''
      const { manifest, errors } = validateManifest(raw, id)

      if (manifest && !fs.existsSync(path.join(staging, manifest.entry))) {
        errors.push(`${manifest.entry} is missing`)
      }

      if (errors.length) {
        throw new Error(`Not a Jarod-OS plugin: ${errors.join('; ')}`)
      }

      const target = path.join(pluginsDir(), id)

      if (fs.existsSync(target)) {
        throw new Error(`${id} is installed already; update it instead`)
      }

      fs.mkdirSync(pluginsDir(), { recursive: true })
      fs.cpSync(staging, target, { recursive: true })
      log('plugins', `added ${id} from ${url} (disabled)`)
      this.broadcast()

      const added = this.find(id)

      if (!added) {
        throw new Error(`${id} did not install`)
      }

      return added
    } finally {
      fs.rmSync(staging, { recursive: true, force: true })
    }
  }

  async update(id: string): Promise<PluginView> {
    const plugin = this.find(id)

    if (!plugin) {
      throw new Error(`no plugin ${id}`)
    }

    if (!fs.existsSync(path.join(plugin.dir, '.git'))) {
      throw new Error(`${id} was not installed from git`)
    }

    const pulled = await git(['pull', '--ff-only'], plugin.dir)

    if (pulled.code !== 0) {
      throw new Error(`git pull failed: ${pulled.output.trim().split('\n').pop()}`)
    }

    this.bump(id)
    this.broadcast()

    return this.find(id) ?? plugin
  }

  /** Off, its folder in the Trash (it may be the person's own work) and its stored data gone. */
  async remove(id: string): Promise<PluginView[]> {
    const plugin = this.find(id)

    if (!plugin) {
      throw new Error(`no plugin ${id}`)
    }

    this.setEnabled(id, false)

    try {
      await shell.trashItem(plugin.dir)
    } catch (error) {
      throw new Error(`could not move ${plugin.dir} to the Trash: ${error instanceof Error ? error.message : String(error)}`)
    }

    fs.rmSync(storeFile(id), { force: true })
    this.broadcast()

    return this.list()
  }

  /** One message from a widget; permissions are checked against the manifest and the grant. */
  async call(id: string, method: PluginMethod, params: Record<string, unknown> = {}): Promise<unknown> {
    const plugin = this.find(id)

    if (!plugin?.enabled) {
      throw new Error('This plugin is not enabled')
    }

    const command = method === 'run' ? String(params.command ?? '') : undefined

    if (!allowed(plugin.manifest, method, command)) {
      throw new Error(`${plugin.manifest.name} has no permission for ${method === 'run' ? `run:${command}` : method}`)
    }

    switch (method) {
      case 'stats':
        return hostPlatform().sampleStats()
      case 'notify': {
        const title = String(params.title ?? '').slice(0, 80)
        const body = String(params.body ?? '').slice(0, 280)
        this.getMain()?.webContents.send(IPC.shellCommand, { type: 'notify', args: [`${plugin.manifest.name}: ${title}`, body] } satisfies ShellCommand)

        return true
      }
      case 'storage.get': {
        const store = readJson<Record<string, unknown>>(storeFile(id), {})

        return params.key === undefined ? store : (store[String(params.key)] ?? null)
      }
      case 'storage.set': {
        const key = String(params.key ?? '').slice(0, 64)
        const value = JSON.stringify(params.value ?? null)

        if (!key || value.length > MAX_VALUE_BYTES) {
          throw new Error('storage.set needs a key and a value under 64 KB')
        }

        const store = readJson<Record<string, unknown>>(storeFile(id), {})
        store[key] = params.value ?? null

        if (JSON.stringify(store).length > MAX_STORE_BYTES) {
          throw new Error('This plugin has used its 256 KB of storage')
        }

        writeJson(storeFile(id), store)

        return true
      }
      case 'run':
        return this.runCommand(plugin, command as string, (params.args as Record<string, unknown>) ?? {})
      case 'theme':
        return null
    }
  }

  /**
   * A plugin's own door to the OS commands: the same gate every other caller goes through, and the
   * same journal (R2.2). Before this, the plugin path asked its own yes/no dialog and ran the command
   * with `osBridge.run` directly, so a plugin's mutation left no line in the control journal, skipped
   * the argument shapes and skipped the one-shot capability.
   */
  private async runCommand(plugin: PluginView, command: string, args: Record<string, unknown>): Promise<unknown> {
    const gate = this.control

    if (!gate) {
      throw new Error('The shell is not ready to run OS commands yet')
    }

    const result = await gate.submitLocal({ command, args, source: `plugin:${plugin.manifest.id}` })

    if (result.kind === 'reply') {
      throw new Error(result.reply.error ?? 'The shell refused the command')
    }

    let reply: { error?: string; result?: unknown }

    try {
      reply = await this.osBridge.run(command, args, 'plugin')
    } catch (error) {
      result.finish({ ok: false, code: 'execution-failed', reason: error instanceof Error ? error.message : String(error) })
      throw error
    }

    result.finish({ ok: reply.error === undefined, reason: reply.error })

    if (reply.error) {
      throw new Error(reply.error)
    }

    return reply.result
  }

  /** herald-plugin://<id>/<file>: an enabled plugin's own files, with its CSP; herald-plugin://sdk/widget.js. */
  registerProtocol(): void {
    protocol.handle('herald-plugin', async request => {
      const url = new URL(request.url)
      const id = url.hostname

      if (id === 'sdk') {
        return new Response(WIDGET_SDK, { headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' } })
      }

      const plugin = this.find(id)

      if (!plugin?.enabled) {
        return new Response('This plugin is not enabled', { status: 403 })
      }

      const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || plugin.manifest.entry
      const file = path.resolve(plugin.dir, relative)

      if (!file.startsWith(plugin.dir + path.sep) || file.split(path.sep).some(part => part === '.git')) {
        return new Response('Outside the plugin', { status: 403 })
      }

      try {
        const body = await fs.promises.readFile(file)
        const type = TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
        const grant = readJson<State>(stateFile(), { enabled: {} }).enabled[id]

        return new Response(body, {
          headers: {
            'content-type': type,
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
            ...(type.startsWith('text/html') ? { 'content-security-policy': pluginCsp(id, grant?.hosts ?? []) } : {})
          }
        })
      } catch {
        return new Response('Not found', { status: 404 })
      }
    })
  }

  /** Saved files reload their plugin's frames. */
  watch(): void {
    fs.mkdirSync(pluginsDir(), { recursive: true })

    try {
      this.watcher = fs.watch(pluginsDir(), { recursive: true }, (_event, filename) => {
        const id = String(filename ?? '').split(/[\\/]/)[0]

        if (!id || id.startsWith('.')) {
          return
        }

        this.changed.add(id)

        if (this.changeTimer) {
          clearTimeout(this.changeTimer)
        }

        this.changeTimer = setTimeout(() => {
          for (const changed of this.changed) {
            this.bump(changed)
          }

          this.changed.clear()
          this.broadcast()
        }, 250)
      })
    } catch (error) {
      log('plugins', `cannot watch ${pluginsDir()}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  stop(): void {
    this.watcher?.close()
  }

  private bump(id: string): void {
    this.revisions.set(id, (this.revisions.get(id) ?? 0) + 1)
  }

  private broadcast(): void {
    const plugins = this.list()

    for (const win of this.getWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(IPC.pluginsChanged, plugins)
      }
    }
  }

  /**
   * Plugin administration changes the machine — it clones from the network, moves folders to the
   * Trash and hands a widget a grant — so from R3.1 it asks the same gate a plugin's own OS commands
   * go through: the action has a catalogue id and a tier, its arguments are checked, the attempt lands
   * in the control journal, and an action the catalogue does not declare is refused here rather than
   * run. Only a window of this app can ask (the preload is what makes that true); a widget's sandboxed
   * frame and a web view have no such channel.
   */
  private async throughGate<T>(
    event: IpcMainInvokeEvent,
    command: string,
    args: Record<string, unknown>,
    run: () => Promise<T> | T
  ): Promise<T> {
    if (!BrowserWindow.fromWebContents(event.sender)) {
      throw new Error('This window may not change plugins.')
    }

    const gate = this.control

    if (!gate) {
      throw new Error('The shell is not ready to change plugins yet')
    }

    const result = await gate.submitLocal({ client: 'ui', command, args, source: 'plugins-admin' })

    if (result.kind === 'reply') {
      throw new Error(result.reply.error ?? 'The shell refused that change')
    }

    try {
      const value = await run()

      result.finish({ ok: true })

      return value
    } catch (error) {
      result.finish({ ok: false, code: 'execution-failed', reason: error instanceof Error ? error.message : String(error) })

      throw error
    }
  }

  registerIpc(): void {
    ipcMain.handle(IPC.pluginsList, () => this.list())
    ipcMain.handle(IPC.pluginsSetEnabled, (event, id: string, enabled: boolean) =>
      this.throughGate(event, PLUGIN_ACTIONS.setEnabled, { id: String(id), enabled: Boolean(enabled) }, () => this.setEnabled(String(id), Boolean(enabled)))
    )
    ipcMain.handle(IPC.pluginsAdd, (event, url: string) => this.throughGate(event, PLUGIN_ACTIONS.add, { url: String(url) }, () => this.add(String(url))))
    ipcMain.handle(IPC.pluginsUpdate, (event, id: string) => this.throughGate(event, PLUGIN_ACTIONS.update, { id: String(id) }, () => this.update(String(id))))
    ipcMain.handle(IPC.pluginsRemove, (event, id: string) => this.throughGate(event, PLUGIN_ACTIONS.remove, { id: String(id) }, () => this.remove(String(id))))
    ipcMain.handle(IPC.pluginCall, (_event, id: string, method: PluginMethod, params: Record<string, unknown>) => this.call(String(id), method, params ?? {}))
  }
}
