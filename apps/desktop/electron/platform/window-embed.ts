import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { app, BrowserWindow, ipcMain, screen, type WebContents } from 'electron'
import { IPC, type WebViewBounds } from '../../shared/ipc.ts'
import { isNativeAppId, type NativeAppId } from '../../shared/web-sites.ts'
import { findNativeApp, launchArgument } from '../ipc/native-apps.ts'
import { log } from '../log.ts'
import { EMBED_HOST_PS1 } from './window-embed-helper.ts'

/*
 * Desktop apps inside the right pane (Signal, MovieBox, VLC): Jarod-OS starts the app (or finds it running), takes its
 * main window, removes its frame and taskbar button, and keeps it exactly over the pane's tab as the tab moves, resizes,
 * hides and shows. The window becomes owned by the shell's window: it stays above it and minimises with it. Closing the
 * tab, or Jarod-OS, gives the window its frame back. Windows only; elsewhere the tab says so.
 */

/** Physical-pixel rectangle on the screen for a CSS rect inside `host`'s content (what the renderer measures). */
export function screenRect(host: BrowserWindow, bounds: WebViewBounds): { x: number; y: number; width: number; height: number } {
  const zoom = host.webContents.getZoomFactor() || 1
  const content = host.getContentBounds()
  const dip = {
    x: Math.round(content.x + bounds.x * zoom),
    y: Math.round(content.y + bounds.y * zoom),
    width: Math.max(1, Math.round(bounds.width * zoom)),
    height: Math.max(1, Math.round(bounds.height * zoom))
  }

  return process.platform === 'win32' ? screen.dipToScreenRect(host, dip) : dip
}

class Helper {
  private child: ChildProcessWithoutNullStreams | null = null
  private ready: Promise<void> | null = null
  private counter = 0
  private buffer = ''
  private readonly pending = new Map<string, { resolve: (value: string) => void; reject: (error: Error) => void }>()

  private start(): Promise<void> {
    if (this.ready) {
      return this.ready
    }

    const script = path.join(app.getPath('userData'), 'window-embed-host.ps1')
    fs.writeFileSync(script, EMBED_HOST_PS1, 'utf8')
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { windowsHide: true })
    this.child = child
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (text: string) => log('embed', `helper: ${text.trim()}`))
    this.ready = new Promise((resolve, reject) => {
      const onLine = (line: string) => {
        if (line === 'ready') {
          resolve()

          return
        }

        const [id, status, ...rest] = line.split(' ')
        const waiter = this.pending.get(id)

        if (waiter) {
          this.pending.delete(id)
          status === 'ok' ? waiter.resolve(rest.join(' ')) : waiter.reject(new Error(rest.join(' ') || 'failed'))
        }
      }

      child.stdout.on('data', (text: string) => {
        this.buffer += text
        let at = this.buffer.indexOf('\n')

        while (at >= 0) {
          onLine(this.buffer.slice(0, at).trim())
          this.buffer = this.buffer.slice(at + 1)
          at = this.buffer.indexOf('\n')
        }
      })
      child.on('exit', code => {
        log('embed', `helper exited (${code})`)
        reject(new Error('the window helper stopped'))

        for (const waiter of this.pending.values()) {
          waiter.reject(new Error('the window helper stopped'))
        }

        this.pending.clear()
        this.child = null
        this.ready = null
      })
    })

    return this.ready
  }

  async send(command: string): Promise<string> {
    await this.start()
    const id = String(++this.counter)

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`no answer to ${command.split(' ')[0]}`))
      }, 5000)
      this.pending.set(id, {
        resolve: value => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: error => {
          clearTimeout(timer)
          reject(error)
        }
      })
      this.child?.stdin.write(`${id} ${command}\n`)
    })
  }

  stop(): void {
    this.child?.stdin.end()
    this.child = null
  }
}

interface Embedded {
  app: NativeAppId
  hwnd: string
  host: BrowserWindow
  owner: WebContents
  bounds: WebViewBounds | null
  visible: boolean
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

export class WindowEmbeds {
  private readonly helper = new Helper()
  private readonly embedded = new Map<NativeAppId, Embedded>()
  private readonly hookedHosts = new WeakSet<BrowserWindow>()

  register(): void {
    ipcMain.handle(IPC.nativeEmbedOpen, (event, id: unknown, target: unknown) => this.open(event.sender, id, target))
    ipcMain.on(IPC.nativeEmbedBounds, (event, id: unknown, bounds: WebViewBounds, visible: boolean) => {
      if (isNativeAppId(id)) {
        void this.place(id, event.sender, bounds, Boolean(visible))
      }
    })
    ipcMain.handle(IPC.nativeEmbedRelease, (event, id: unknown) => (isNativeAppId(id) ? this.release(id, event.sender) : undefined))
    let releasedForQuit = false
    app.on('before-quit', event => {
      if (releasedForQuit || this.embedded.size === 0) {
        this.helper.stop()

        return
      }

      // Give the apps their frames back first: their windows would go down with the shell's.
      event.preventDefault()
      releasedForQuit = true
      void this.releaseAll().finally(() => app.quit())
    })
  }

  /** Start (or find) the app and take its window; resolves once it sits in the pane. */
  async open(owner: WebContents, id: unknown, target: unknown): Promise<void> {
    if (process.platform !== 'win32') {
      throw new Error('apps open inside Jarod-OS on Windows only')
    }

    if (!isNativeAppId(id)) {
      throw new Error('unknown app')
    }

    const host = BrowserWindow.fromWebContents(owner)

    if (!host) {
      throw new Error('no window to hold the app')
    }

    const program = findNativeApp(id)

    if (!program) {
      throw new Error(`${id} is not installed`)
    }

    const args = launchArgument(id, target)
    const existing = this.embedded.get(id)

    if (existing && (await this.helper.send(`alive ${existing.hwnd}`)) === '1') {
      // Already in the pane: a file for VLC goes to the running VLC (it plays it in the same window).
      if (args.length > 0) {
        spawn(program, args, { detached: true, stdio: 'ignore' }).unref()
      }

      return
    }

    let hwnd = await this.helper.send(`find ${program}`)

    if (hwnd === '0' || args.length > 0) {
      const child = spawn(program, args, { detached: true, stdio: 'ignore' })
      child.on('error', error => log('embed', `${id} failed to start: ${error.message}`))
      child.unref()
      log('embed', `started ${id}`)
    }

    // The app's main window can take a while (Signal unlocks its database first).
    for (let tries = 0; hwnd === '0' && tries < 60; tries++) {
      await sleep(500)
      hwnd = await this.helper.send(`find ${program}`)
    }

    if (hwnd === '0') {
      throw new Error(`${id} did not open a window`)
    }

    // A first window may be a splash screen; wait a moment and take the largest one then.
    await sleep(800)
    const settled = await this.helper.send(`find ${program}`)
    hwnd = settled !== '0' ? settled : hwnd
    const ownerHandle = host.getNativeWindowHandle()
    const ownerHwnd = ownerHandle.length >= 8 ? ownerHandle.readBigUInt64LE(0).toString() : String(ownerHandle.readUInt32LE(0))
    await this.helper.send(`attach ${hwnd} ${ownerHwnd}`)
    const entry: Embedded = { app: id, hwnd, host, owner, bounds: existing?.bounds ?? null, visible: existing?.visible ?? false }
    this.embedded.set(id, entry)
    this.hookHost(host)
    owner.once('destroyed', () => void this.release(id))
    log('embed', `${id} window ${hwnd} is in the pane`)
    await this.apply(entry)
  }

  private async place(id: NativeAppId, sender: WebContents, bounds: WebViewBounds, visible: boolean): Promise<void> {
    const entry = this.embedded.get(id)

    if (!entry || entry.owner !== sender) {
      return
    }

    entry.bounds = bounds
    entry.visible = visible
    await this.apply(entry)
  }

  private async apply(entry: Embedded): Promise<void> {
    try {
      if (!entry.visible || !entry.bounds || entry.host.isDestroyed() || entry.host.isMinimized() || !entry.host.isVisible()) {
        await this.helper.send(`hide ${entry.hwnd}`)

        return
      }

      const rect = screenRect(entry.host, entry.bounds)
      await this.helper.send(`place ${entry.hwnd} ${rect.x} ${rect.y} ${rect.width} ${rect.height}`)
    } catch (error) {
      if (error instanceof Error && error.message === 'gone') {
        this.embedded.delete(entry.app)

        if (!entry.owner.isDestroyed()) {
          entry.owner.send(IPC.nativeEmbedGone, entry.app)
        }

        log('embed', `${entry.app} window closed`)
      }
    }
  }

  /** The shell's window moved or resized: the app follows. */
  private hookHost(host: BrowserWindow): void {
    if (this.hookedHosts.has(host)) {
      return
    }

    this.hookedHosts.add(host)
    const follow = () => {
      for (const entry of this.embedded.values()) {
        if (entry.host === host) {
          void this.apply(entry)
        }
      }
    }

    for (const name of ['move', 'resize', 'maximize', 'unmaximize', 'restore', 'minimize', 'enter-full-screen', 'leave-full-screen'] as const) {
      host.on(name as 'move', follow)
    }

    host.on('hide', follow)
    host.on('show', follow)
    // An owned window is destroyed with its owner: give every app its frame back before the shell's window goes.
    host.on('close', event => {
      if ([...this.embedded.values()].some(entry => entry.host === host)) {
        event.preventDefault()
        void this.releaseAll(host).finally(() => {
          if (!host.isDestroyed()) {
            host.close()
          }
        })
      }
    })
  }

  async release(id: NativeAppId, sender?: WebContents): Promise<void> {
    const entry = this.embedded.get(id)

    if (!entry || (sender && entry.owner !== sender)) {
      return
    }

    this.embedded.delete(id)
    await this.helper.send(`release ${entry.hwnd}`).catch(() => undefined)
    log('embed', `${id} released`)
  }

  async releaseAll(host?: BrowserWindow): Promise<void> {
    await Promise.all([...this.embedded.values()].filter(entry => !host || entry.host === host).map(entry => this.release(entry.app)))

    if (!host) {
      this.helper.stop()
    }
  }
}

export function registerWindowEmbeds(): WindowEmbeds {
  const embeds = new WindowEmbeds()
  embeds.register()

  return embeds
}
