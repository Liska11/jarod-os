import { BrowserWindow, dialog, ipcMain, net, session, type WebContents, WebContentsView } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { IPC, type WebOpenOptions, type WebViewBounds, type WebViewEvent } from '../../shared/ipc.ts'
import { isViewable } from '../../shared/viewer.ts'
import { chromeUserAgent, isSiteId, PASSKEY_GUARD, type SiteDef, SITES, siteMayOpen, sitePartition } from '../../shared/web-sites.ts'
import { log } from '../log.ts'
import { isLoopbackOrigin } from '../pinokio/guard.ts'

/*
 * Embedded web pages. Jarod-OS is a whole environment, so a web page (the provider sign-in portal,
 * for now) opens inside it rather than in the system browser. In desktop mode the page is a
 * `WebContentsView` layered over the shell window; the renderer's window manager draws the frame and
 * streams the content rect here so the page sits exactly inside it. In panels mode (niri) there is
 * no single desktop window, so the page gets a real compositor window instead.
 *
 * The guest is locked down: sandboxed, isolated, no Node, no preload, its own storage partition with
 * every permission denied, http(s) only, popups denied (same-origin ones navigate the same view).
 */

export const WEB_PARTITION = 'persist:herald-web'
const VIEWER_PARTITION = 'persist:herald-viewer'
const DETACHED_SIZE = { width: 1000, height: 720 }

const isHttp = (url: string): boolean => /^https?:\/\//i.test(url)

interface EmbeddedView {
  kind: 'view'
  id: string
  view: WebContentsView
  host: BrowserWindow
  owner: WebContents
}

interface DetachedView {
  kind: 'window'
  id: string
  win: BrowserWindow
  owner: WebContents
}

type Entry = EmbeddedView | DetachedView

export const GUEST_PREFERENCES: Electron.WebPreferences = {
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  webSecurity: true,
  allowRunningInsecureContent: false,
  webviewTag: false,
  plugins: false,
  spellcheck: false,
  partition: WEB_PARTITION
}

/** Local files: same lockdown, own partition, plus Chromium's PDF viewer plugin. */
const VIEWER_PREFERENCES: Electron.WebPreferences = { ...GUEST_PREFERENCES, plugins: true, partition: VIEWER_PARTITION }

/** Studio previews of the site Hermes is building: same lockdown, own partition so dev-server state never mixes with browsing. */
const PREVIEW_PARTITION = 'persist:herald-preview'
const PREVIEW_PREFERENCES: Electron.WebPreferences = { ...GUEST_PREFERENCES, partition: PREVIEW_PARTITION }

/** The Pinokio engine's UI and its apps: same lockdown, own partition (openPinokio). */
const PINOKIO_PARTITION = 'persist:jarod-pinokio'
const PINOKIO_PREFERENCES: Electron.WebPreferences = { ...GUEST_PREFERENCES, partition: PINOKIO_PARTITION }
let pinokioPrepared = false
/** Origins the user answered about camera/microphone this session (true: allowed). */
const pinokioMedia = new Map<string, boolean>()

/**
 * Pinokio's partition grants what its pages need and nothing else: writing to the clipboard (copying a log, a prompt),
 * downloads (an app's outputs, through the usual save dialog), and the camera/microphone for an app on this machine
 * once the user says yes (voice and video apps). Everything else is refused, like the other guests.
 */
function preparePinokioPartition(parent: BrowserWindow | null): void {
  if (pinokioPrepared) {
    return
  }

  pinokioPrepared = true
  const guest = session.fromPartition(PINOKIO_PARTITION)
  guest.setPermissionCheckHandler((_contents, permission, origin) => {
    if (permission === 'clipboard-sanitized-write') {
      return true
    }

    try {
      return permission === 'media' && pinokioMedia.get(new URL(origin).origin) === true
    } catch {
      return false
    }
  })
  guest.setDevicePermissionHandler(() => false)
  guest.setPermissionRequestHandler((_contents, permission, callback, details) => {
    if (permission === 'clipboard-sanitized-write') {
      callback(true)

      return
    }

    let origin: string

    try {
      origin = new URL(details.requestingUrl).origin
    } catch {
      callback(false)

      return
    }

    if (permission !== 'media' || !isLoopbackOrigin(origin)) {
      callback(false)

      return
    }

    const known = pinokioMedia.get(origin)

    if (known !== undefined) {
      callback(known)

      return
    }

    const options: Electron.MessageBoxOptions = {
      type: 'question',
      buttons: ['Allow', 'Deny'],
      defaultId: 1,
      cancelId: 1,
      title: 'Camera and microphone',
      message: `${origin} wants to use your camera or microphone.`,
      detail: 'This is an app started by the Pinokio engine on this computer. Jarod-OS remembers your answer until it quits.'
    }
    const answer = parent && !parent.isDestroyed() ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options)
    void answer.then(({ response }) => {
      pinokioMedia.set(origin, response === 0)
      callback(response === 0)
    })
  })
}

const preparedSites = new Set<string>()
/** Origins the user answered about camera/microphone this launch, per site (true: allowed). */
const siteMedia = new Map<string, boolean>()

/**
 * A site's partition (shared/web-sites.ts): the Chrome user agent, and only the permissions its definition lists —
 * notifications and clipboard writes as asked, camera/microphone once the user says yes, downloads through the save
 * dialog. Everything else is refused, like the other guests.
 */
function prepareSitePartition(site: SiteDef, parent: BrowserWindow | null): void {
  if (preparedSites.has(site.id)) {
    return
  }

  preparedSites.add(site.id)
  const guest = session.fromPartition(sitePartition(site.id))
  guest.setUserAgent(chromeUserAgent(guest.getUserAgent()))
  const grants = (permission: string): boolean =>
    (permission === 'notifications' && site.permissions.includes('notifications')) || (permission === 'clipboard-sanitized-write' && site.permissions.includes('clipboard'))
  const originOf = (url: string): string | null => {
    try {
      return new URL(url).origin
    } catch {
      return null
    }
  }

  guest.setPermissionCheckHandler((_contents, permission, origin) => {
    if (grants(permission)) {
      return true
    }

    return permission === 'media' && site.permissions.includes('media') && siteMedia.get(`${site.id} ${originOf(origin)}`) === true
  })
  guest.setDevicePermissionHandler(() => false)
  guest.setPermissionRequestHandler((_contents, permission, callback, details) => {
    if (grants(permission)) {
      callback(true)

      return
    }

    const origin = originOf(details.requestingUrl)

    if (permission !== 'media' || !site.permissions.includes('media') || !origin) {
      callback(false)

      return
    }

    const key = `${site.id} ${origin}`
    const known = siteMedia.get(key)

    if (known !== undefined) {
      callback(known)

      return
    }

    const options: Electron.MessageBoxOptions = {
      type: 'question',
      buttons: ['Allow', 'Deny'],
      defaultId: 1,
      cancelId: 1,
      title: 'Camera and microphone',
      message: `${site.name} (${origin}) wants to use your camera or microphone.`,
      detail: 'Jarod-OS remembers your answer until it quits.'
    }
    const answer = parent && !parent.isDestroyed() ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options)
    void answer.then(({ response }) => {
      siteMedia.set(key, response === 0)
      callback(response === 0)
    })
  })

  if (!site.permissions.includes('downloads')) {
    guest.on('will-download', event => event.preventDefault())
  } else {
    guest.on('will-download', (_event, item) => log('web', `${site.id}: download ${item.getFilename()}`))
  }
}

/**
 * PASSKEY_GUARD in every frame of a site's view, cross-site frames included (each is its own target: attached as it
 * starts, held until the guard is in). Through the DevTools protocol, since no preload reaches a sandboxed page's own
 * world before its scripts. Best effort: a view the guard could not reach still works, with Windows' dialog.
 */
async function guardPasskeys(contents: WebContents, site: string): Promise<void> {
  const dbg = contents.debugger
  const guardTarget = async (session?: string) => {
    await dbg.sendCommand('Page.enable', {}, session).catch(() => undefined)
    await dbg.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: PASSKEY_GUARD, runImmediately: true }, session).catch(() => undefined)
    await dbg.sendCommand('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, session).catch(() => undefined)
  }

  try {
    if (!dbg.isAttached()) {
      dbg.attach('1.3')
    }

    dbg.on('message', (_event, method, params: { sessionId?: string }) => {
      if (method === 'Target.attachedToTarget' && params.sessionId) {
        const session = params.sessionId
        void guardTarget(session).then(() => dbg.sendCommand('Runtime.runIfWaitingForDebugger', {}, session).catch(() => undefined))
      }
    })
    await guardTarget()
  } catch (error) {
    log('web', `${site}: passkey guard unavailable: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** A preview may show http(s) pages and local files inside the project folder, nothing else. */
function previewAllows(url: string, root: string | null): boolean {
  if (isHttp(url)) {
    return true
  }

  if (!root || !url.startsWith('file://')) {
    return false
  }

  try {
    return isInside(path.normalize(decodeURIComponent(new URL(url).pathname)), root)
  } catch {
    return false
  }
}

function isInside(file: string, folder: string): boolean {
  return file === folder || file.startsWith(folder + path.sep)
}

function resolveHomePath(raw: string): string {
  return path.resolve(raw.replace(/^~(?=\/|$)/, os.homedir()))
}

function realPath(target: string): string {
  try {
    return fs.realpathSync(target)
  } catch {
    return target
  }
}

export class WebViews {
  private readonly entries = new Map<string, Entry>()
  private readonly hookedOwners = new WeakSet<WebContents>()
  private counter = 0

  /** `embed`: layer views over the sender's window (desktop mode); otherwise open real windows. */
  constructor(private readonly embed: boolean) {}

  register(): void {
    ipcMain.handle(IPC.webOpen, (event, url: string, options: WebOpenOptions = {}) => this.open(event.sender, url, options))
    ipcMain.handle(IPC.webOpenFile, (event, filePath: string, options: WebOpenOptions = {}) => this.openFile(event.sender, filePath, options))
    ipcMain.on(IPC.webSetBounds, (event, id: string, bounds: WebViewBounds, visible: boolean) => this.setBounds(event.sender, id, bounds, visible))
    ipcMain.handle(IPC.webClose, (event, id: string) => this.close(id, event.sender))
    ipcMain.handle(IPC.webOpenPreview, (event, target: string, options: WebOpenOptions = {}) => this.openPreview(event.sender, target, options))
    ipcMain.handle(IPC.webNavigate, (event, id: string, target: string) => this.navigate(event.sender, id, target))
    ipcMain.handle(IPC.webReload, (event, id: string) => {
      const contents = this.contentsFor(id, event.sender)
      contents?.reloadIgnoringCache()
    })
    ipcMain.handle(IPC.webOpenSite, (event, siteId: unknown) => this.openSite(event.sender, siteId))
    ipcMain.handle(IPC.webHistory, (event, id: string, direction: unknown) => {
      const history = this.contentsFor(id, event.sender)?.navigationHistory

      if (direction === 'back' && history?.canGoBack()) {
        history.goBack()
      } else if (direction === 'forward' && history?.canGoForward()) {
        history.goForward()
      }
    })
  }

  /** Site views by id (the Browser, the Social apps), and each owner's one view per site. */
  private readonly siteViews = new Map<string, SiteDef>()
  private readonly siteOwners = new Map<string, string>()

  /**
   * A site's page (shared/web-sites.ts): one view per site and window, in the site's own partition so its sign-in
   * stays. It shows the site's own pages and its sign-in pages; a link elsewhere goes to the Browser page (`external`).
   * Asked again for the same site, it answers with the view already open.
   */
  openSite(owner: WebContents, siteId: unknown): string {
    if (!isSiteId(siteId)) {
      throw new Error('unknown site')
    }

    const site = SITES[siteId]
    const key = `${owner.id} ${site.id}`
    const existing = this.siteOwners.get(key)

    if (existing && this.entries.has(existing)) {
      return existing
    }

    const host = BrowserWindow.fromWebContents(owner)
    prepareSitePartition(site, host)
    this.hookOwner(owner)
    const id = `web-${++this.counter}`
    const preferences: Electron.WebPreferences = { ...GUEST_PREFERENCES, partition: sitePartition(site.id) }
    const entry: Entry = this.embed && host && !host.isDestroyed() ? this.createEmbedded(id, host, owner, preferences) : this.createDetached(id, owner, site.name, preferences)
    this.entries.set(id, entry)
    this.siteViews.set(id, site)
    this.siteOwners.set(key, id)
    const contents = entry.kind === 'view' ? entry.view.webContents : entry.win.webContents
    this.guardSite(id, contents, site, preferences)
    // A blank document first: the DevTools protocol answers only once the view has one.
    void contents
      .loadURL('about:blank')
      .then(() => Promise.race([guardPasskeys(contents, site.id), new Promise(resolve => setTimeout(resolve, 3000))]))
      .then(() => contents.loadURL(site.home))
      .catch(error => log('web', `${id}: load failed: ${error instanceof Error ? error.message : String(error)}`))
    log('web', `opened site ${site.id} ${id} (${entry.kind})`)

    return id
  }

  private guardSite(id: string, contents: WebContents, site: SiteDef, preferences: Electron.WebPreferences): void {
    const elsewhere = (url: string) => {
      if (/^https?:\/\//i.test(url)) {
        this.emitFor(id, { id, type: 'external', url })
      }
    }

    contents.setWindowOpenHandler(({ url }) => {
      if (!siteMayOpen(site, url)) {
        elsewhere(url)

        return { action: 'deny' }
      }

      // The browser opens a new tab's page in place; the others keep sign-in popups (they need window.opener).
      if (site.hosts === null) {
        void contents.loadURL(url).catch(() => undefined)

        return { action: 'deny' }
      }

      return { action: 'allow', overrideBrowserWindowOptions: { width: 520, height: 720, autoHideMenuBar: true, backgroundColor: '#ffffff', webPreferences: { ...preferences } } }
    })
    contents.on('did-create-window', child => {
      child.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      child.webContents.on('will-navigate', (event, url) => {
        if (!siteMayOpen(site, url)) {
          event.preventDefault()
        }
      })
    })
    for (const name of ['will-navigate', 'will-redirect'] as const) {
      contents.on(name as 'will-navigate', (event, url) => {
        if (!siteMayOpen(site, url)) {
          event.preventDefault()

          if (name === 'will-navigate') {
            elsewhere(url)
          }
        }
      })
    }
    contents.on('will-attach-webview', event => event.preventDefault())
    contents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && (input.key === 'F12' || (input.key.toLowerCase() === 'i' && input.alt && (input.meta || input.control)))) {
        event.preventDefault()
      }
    })
    contents.on('page-title-updated', (_event, title) => this.emitFor(id, { id, type: 'title', title }))
    const reportUrl = () => {
      if (!contents.isDestroyed()) {
        this.emitFor(id, { id, type: 'url', url: contents.getURL() })
        this.emitFor(id, { id, type: 'history', canGoBack: contents.navigationHistory.canGoBack(), canGoForward: contents.navigationHistory.canGoForward() })
      }
    }
    contents.on('did-navigate', reportUrl)
    contents.on('did-navigate-in-page', reportUrl)
    contents.on('did-start-loading', () => this.emitFor(id, { id, type: 'loading', loading: true }))
    contents.on('did-stop-loading', () => this.emitFor(id, { id, type: 'loading', loading: false }))
    contents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      if (isMainFrame && code !== -3) {
        this.emitFor(id, { id, type: 'error', error: `${description} (${url})` })
      }
    })
  }

  private readonly previewRoots = new Map<string, string | null>()
  private readonly previewFolders = new Map<string, string>()
  private readonly viewerFiles = new Map<string, string>()
  private readonly pinokioViews = new Set<string>()

  /**
   * A Studio preview: a web page (usually the dev server on localhost) or a local file inside the
   * project folder (`options.root`), for static sites. Links between the project's own pages work.
   */
  openPreview(owner: WebContents, target: string, options: WebOpenOptions): string {
    const root = typeof options.root === 'string' && options.root ? resolveHomePath(options.root) : null

    if (root && !root.startsWith(os.homedir() + path.sep)) {
      throw new Error('a preview folder must be inside your home folder')
    }

    lockDownPartition(WEB_PARTITION)
    lockDownPartition(PREVIEW_PARTITION)
    confineFiles(PREVIEW_PARTITION, file => [...this.previewFolders.values()].some(folder => isInside(file, folder)))
    this.hookOwner(owner)
    const id = `web-${++this.counter}`
    const host = BrowserWindow.fromWebContents(owner)
    const title = typeof options.title === 'string' ? options.title.slice(0, 200) : 'Preview'
    const entry: Entry = this.embed && host && !host.isDestroyed() ? this.createEmbedded(id, host, owner, PREVIEW_PREFERENCES) : this.createDetached(id, owner, title, PREVIEW_PREFERENCES)
    this.entries.set(id, entry)
    this.previewRoots.set(id, root)

    if (root) {
      this.previewFolders.set(id, realPath(root))
    }
    const contents = entry.kind === 'view' ? entry.view.webContents : entry.win.webContents
    this.guardPreview(id, contents)

    try {
      this.navigate(owner, id, target)
    } catch (error) {
      this.close(id)
      throw error
    }

    log('web', `opened preview ${id} (${entry.kind}) ${target}`)

    return id
  }

  /** Point a preview somewhere else (a new dev-server port, another page of the site). */
  navigate(owner: WebContents, id: string, target: string): void {
    const contents = this.contentsFor(id, owner)
    const site = this.siteViews.get(id)

    // A site's view goes to its own pages (the browser: anywhere on the web).
    if (contents && site) {
      if (!siteMayOpen(site, target)) {
        throw new Error(`${site.name} shows its own pages only`)
      }

      void contents.loadURL(target).catch(error => log('web', `${id}: load failed: ${error instanceof Error ? error.message : String(error)}`))

      return
    }

    // A Pinokio view goes anywhere on this machine (its home page, an app's page).
    if (contents && this.pinokioViews.has(id)) {
      if (!isLoopbackOrigin(target)) {
        throw new Error('the Pinokio view shows pages on this computer only')
      }

      void contents.loadURL(target).catch(error => log('web', `${id}: load failed: ${error instanceof Error ? error.message : String(error)}`))

      return
    }

    if (!contents || !this.previewRoots.has(id)) {
      throw new Error('no such preview')
    }

    const root = this.previewRoots.get(id) ?? null
    const url = isHttp(target) ? target : target.startsWith('file://') ? target : pathToFileURL(resolveHomePath(target)).toString()

    if (!previewAllows(url, root)) {
      throw new Error('a preview shows web pages or files inside the project folder')
    }

    void contents.loadURL(url).catch(error => log('web', `${id}: load failed: ${error instanceof Error ? error.message : String(error)}`))
  }

  private guardPreview(id: string, contents: WebContents): void {
    const allowed = (url: string) => previewAllows(url, this.previewRoots.get(id) ?? null)
    contents.setWindowOpenHandler(({ url }) => {
      if (allowed(url)) {
        void contents.loadURL(url).catch(() => undefined)
      }

      return { action: 'deny' }
    })
    contents.on('will-navigate', (event, url) => {
      if (!allowed(url)) {
        event.preventDefault()
      }
    })
    contents.on('will-redirect', (event, url) => {
      if (!allowed(url)) {
        event.preventDefault()
      }
    })
    contents.on('will-attach-webview', event => event.preventDefault())
    contents.on('page-title-updated', (_event, title) => this.emitFor(id, { id, type: 'title', title }))
    const reportUrl = () => {
      if (!contents.isDestroyed()) {
        this.emitFor(id, { id, type: 'url', url: contents.getURL() })
      }
    }
    contents.on('did-navigate', reportUrl)
    contents.on('did-navigate-in-page', reportUrl)
    contents.on('did-start-loading', () => this.emitFor(id, { id, type: 'loading', loading: true }))
    contents.on('did-stop-loading', () => this.emitFor(id, { id, type: 'loading', loading: false }))
    contents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      if (isMainFrame && code !== -3) {
        this.emitFor(id, { id, type: 'error', error: `${description} (${url})` })
      }
    })
  }

  open(owner: WebContents, url: string, options: WebOpenOptions): string {
    if (typeof url !== 'string' || !isHttp(url)) {
      throw new Error('only http(s) URLs may be opened in a Jarod-OS web window')
    }

    lockDownPartition(WEB_PARTITION)
    this.hookOwner(owner)
    const id = `web-${++this.counter}`
    const host = BrowserWindow.fromWebContents(owner)
    const title = typeof options.title === 'string' ? options.title.slice(0, 200) : undefined
    const entry: Entry = this.embed && host && !host.isDestroyed() ? this.createEmbedded(id, host, owner) : this.createDetached(id, owner, title)
    this.entries.set(id, entry)
    const contents = entry.kind === 'view' ? entry.view.webContents : entry.win.webContents
    this.guard(id, contents, new URL(url).origin)
    void contents.loadURL(url).catch(error => log('web', `${id}: load failed: ${error instanceof Error ? error.message : String(error)}`))
    log('web', `opened ${id} (${entry.kind}) ${url}`)

    return id
  }

  /**
   * The Pinokio engine's UI and the AI apps it serves (ADR-022): pages on this machine only, in their own partition so
   * their sign-ins and settings never mix with browsing. A link or popup that leaves this machine goes to `onElsewhere`
   * (an ordinary, locked-down web window); a popup on this machine (an app's UI) too, as its own window.
   */
  openPinokio(owner: WebContents, url: string, options: WebOpenOptions, onElsewhere: (url: string) => void): string {
    if (typeof url !== 'string' || !isLoopbackOrigin(url)) {
      throw new Error('the Pinokio view shows pages on this computer only')
    }

    preparePinokioPartition(BrowserWindow.fromWebContents(owner))
    this.hookOwner(owner)
    const id = `web-${++this.counter}`
    const host = BrowserWindow.fromWebContents(owner)
    const title = typeof options.title === 'string' ? options.title.slice(0, 200) : 'Pinokio'
    const entry: Entry = this.embed && host && !host.isDestroyed() ? this.createEmbedded(id, host, owner, PINOKIO_PREFERENCES) : this.createDetached(id, owner, title, PINOKIO_PREFERENCES)
    this.entries.set(id, entry)
    this.pinokioViews.add(id)
    const contents = entry.kind === 'view' ? entry.view.webContents : entry.win.webContents
    this.guard(id, contents, new URL(url).origin)
    // Replaces guard()'s policies: anywhere on this machine stays in the view, the rest opens beside it.
    contents.setWindowOpenHandler(({ url: target }) => {
      if (isHttp(target)) {
        onElsewhere(target)
      }

      return { action: 'deny' }
    })
    contents.on('will-navigate', (event, target) => {
      if (!isLoopbackOrigin(target)) {
        event.preventDefault()

        if (isHttp(target)) {
          onElsewhere(target)
        }
      }
    })
    contents.on('will-redirect', (event, target) => {
      if (!isLoopbackOrigin(target)) {
        event.preventDefault()
      }
    })
    void contents.loadURL(url).catch(error => log('web', `${id}: load failed: ${error instanceof Error ? error.message : String(error)}`))
    log('web', `opened Pinokio ${id} (${entry.kind}) ${url}`)

    return id
  }

  /** Show a local file (PDF, image, text, media) inside Jarod-OS; the view can never navigate elsewhere. */
  openFile(owner: WebContents, filePath: string, options: WebOpenOptions): string {
    const resolved = typeof filePath === 'string' ? path.resolve(filePath.replace(/^~(?=\/|$)/, os.homedir())) : ''
    const stat = resolved ? fs.statSync(resolved, { throwIfNoEntry: false }) : undefined

    if (!stat?.isFile()) {
      throw new Error(`${filePath} is not a file`)
    }

    if (!isViewable(resolved)) {
      throw new Error(`Jarod-OS cannot display ${path.extname(resolved) || 'this kind of'} files yet`)
    }

    this.hookOwner(owner)
    const id = `web-${++this.counter}`
    const host = BrowserWindow.fromWebContents(owner)
    const title = typeof options.title === 'string' ? options.title.slice(0, 200) : path.basename(resolved)
    const entry: Entry = this.embed && host && !host.isDestroyed() ? this.createEmbedded(id, host, owner, VIEWER_PREFERENCES) : this.createDetached(id, owner, title, VIEWER_PREFERENCES)
    this.entries.set(id, entry)
    this.viewerFiles.set(id, realPath(resolved))
    const contents = entry.kind === 'view' ? entry.view.webContents : entry.win.webContents
    lockDownPartition(VIEWER_PARTITION)
    confineFiles(VIEWER_PARTITION, file => [...this.viewerFiles.values()].includes(file))
    const fileUrl = pathToFileURL(resolved).toString()
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    // A viewer shows one file: links inside a PDF or page never navigate the view.
    contents.on('will-navigate', (event, url) => {
      if (url !== fileUrl) {
        event.preventDefault()
      }
    })
    contents.on('will-attach-webview', event => event.preventDefault())
    contents.on('did-start-loading', () => this.emitFor(id, { id, type: 'loading', loading: true }))
    contents.on('did-stop-loading', () => this.emitFor(id, { id, type: 'loading', loading: false }))
    void contents.loadFile(resolved).catch(error => log('web', `${id}: load failed: ${error instanceof Error ? error.message : String(error)}`))
    log('web', `opened ${id} (${entry.kind}) file ${resolved}`)

    return id
  }

  private emitFor(id: string, event: WebViewEvent): void {
    const entry = this.entries.get(id)

    if (entry) {
      this.emit(entry, event)
    }
  }

  setBounds(sender: WebContents, id: string, bounds: WebViewBounds, visible: boolean): void {
    const entry = this.entries.get(id)

    if (!entry || entry.owner !== sender || entry.kind !== 'view' || entry.host.isDestroyed()) {
      return
    }

    // The renderer measures in CSS pixels; the view is placed in device-independent pixels.
    const zoom = entry.host.webContents.getZoomFactor() || 1
    const scale = (value: number) => Math.round(Number(value) * zoom)
    entry.view.setBounds({ x: scale(bounds.x), y: scale(bounds.y), width: Math.max(1, scale(bounds.width)), height: Math.max(1, scale(bounds.height)) })
    // Rounded corners follow the frame (macOS and Windows honour this; elsewhere it is a no-op).
    entry.view.setBorderRadius(Math.max(0, scale(bounds.radius ?? 0)))
    entry.view.setVisible(Boolean(visible))
  }

  close(id: string, sender?: WebContents): void {
    const entry = this.entries.get(id)

    if (!entry || (sender && entry.owner !== sender)) {
      return
    }

    this.entries.delete(id)
    this.previewRoots.delete(id)
    this.previewFolders.delete(id)
    this.viewerFiles.delete(id)
    this.pinokioViews.delete(id)
    this.siteViews.delete(id)

    for (const [key, value] of this.siteOwners) {
      if (value === id) {
        this.siteOwners.delete(key)
      }
    }

    if (entry.kind === 'view') {
      if (!entry.host.isDestroyed()) {
        entry.host.contentView.removeChildView(entry.view)
      }

      if (!entry.view.webContents.isDestroyed()) {
        entry.view.webContents.close()
      }
    } else if (!entry.win.isDestroyed()) {
      entry.win.close()
    }

    this.emit(entry, { id, type: 'closed' })
    log('web', `closed ${id}`)
  }

  /** The guest contents of a view this owner opened (for typing/editing into a web page). */
  contentsFor(id: string, owner: WebContents): WebContents | null {
    const entry = this.entries.get(id)

    if (!entry || entry.owner !== owner) {
      return null
    }

    const contents = entry.kind === 'view' ? entry.view.webContents : entry.win.webContents

    return contents.isDestroyed() ? null : contents
  }

  closeAll(owner?: WebContents): void {
    for (const [id, entry] of [...this.entries]) {
      if (!owner || entry.owner === owner) {
        this.close(id)
      }
    }
  }

  private createEmbedded(id: string, host: BrowserWindow, owner: WebContents, preferences: Electron.WebPreferences = GUEST_PREFERENCES): EmbeddedView {
    const view = new WebContentsView({ webPreferences: { ...preferences } })
    // Hidden until the renderer reports the frame's content rect, so nothing flashes at (0, 0).
    view.setVisible(false)
    view.setBounds({ x: 0, y: 0, width: 1, height: 1 })
    view.setBackgroundColor('#ffffff')
    host.contentView.addChildView(view)
    view.webContents.on('destroyed', () => this.close(id))

    return { kind: 'view', id, view, host, owner }
  }

  private createDetached(id: string, owner: WebContents, title?: string, preferences: Electron.WebPreferences = GUEST_PREFERENCES): DetachedView {
    const win = new BrowserWindow({
      ...DETACHED_SIZE,
      frame: false,
      title: title ?? 'Jarod-OS · Web',
      backgroundColor: '#ffffff',
      webPreferences: { ...preferences }
    })
    // The title is the window's identity for the compositor; the page title travels as an event.
    win.on('page-title-updated', event => event.preventDefault())
    win.on('closed', () => this.close(id))

    return { kind: 'window', id, win, owner }
  }

  /** Navigation policy and event mirroring for one guest. */
  private guard(id: string, contents: WebContents, origin: string): void {
    contents.setWindowOpenHandler(({ url }) => {
      // Same-origin popups become navigations of the same view; everything else is denied.
      if (isHttp(url) && new URL(url).origin === origin) {
        void contents.loadURL(url).catch(() => undefined)
      }

      return { action: 'deny' }
    })
    contents.on('will-navigate', (event, url) => {
      if (!isHttp(url)) {
        event.preventDefault()
      }
    })
    contents.on('will-redirect', (event, url) => {
      if (!isHttp(url)) {
        event.preventDefault()
      }
    })
    // No <webview>, no devtools shortcuts, no drag-and-drop file navigation in the guest.
    contents.on('will-attach-webview', event => event.preventDefault())
    contents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && (input.key === 'F12' || (input.key.toLowerCase() === 'i' && input.alt && (input.meta || input.control)))) {
        event.preventDefault()
      }
    })

    const entryFor = () => this.entries.get(id)
    contents.on('page-title-updated', (_event, title) => {
      const entry = entryFor()

      if (entry) {
        this.emit(entry, { id, type: 'title', title })
      }
    })
    const reportUrl = () => {
      const entry = entryFor()

      if (entry && !contents.isDestroyed()) {
        this.emit(entry, { id, type: 'url', url: contents.getURL() })
      }
    }
    contents.on('did-navigate', reportUrl)
    contents.on('did-navigate-in-page', reportUrl)
    contents.on('did-start-loading', () => {
      const entry = entryFor()

      if (entry) {
        this.emit(entry, { id, type: 'loading', loading: true })
      }
    })
    contents.on('did-stop-loading', () => {
      const entry = entryFor()

      if (entry) {
        this.emit(entry, { id, type: 'loading', loading: false })
      }
    })
  }

  private emit(entry: Entry, event: WebViewEvent): void {
    if (!entry.owner.isDestroyed()) {
      entry.owner.send(IPC.webEvent, event)
    }
  }

  /** A renderer that reloads or goes away takes its views with it. */
  private hookOwner(owner: WebContents): void {
    if (this.hookedOwners.has(owner)) {
      return
    }

    this.hookedOwners.add(owner)
    owner.on('did-navigate', () => this.closeAll(owner))
    owner.on('destroyed', () => this.closeAll(owner))
  }
}

const lockedPartitions = new Set<string>()

/** Guest partitions grant nothing: no camera, mic, notifications, clipboard, or downloads. */
export function lockDownPartition(partition: string): void {
  if (lockedPartitions.has(partition)) {
    return
  }

  lockedPartitions.add(partition)
  const guest = session.fromPartition(partition)
  guest.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  guest.setPermissionCheckHandler(() => false)
  guest.setDevicePermissionHandler(() => false)
  guest.on('will-download', event => event.preventDefault())
}

const confinedPartitions = new Set<string>()

/**
 * Electron lets a file:// page read every other file:// URL, so a previewed site or an SVG in the
 * viewer could read ~/.hermes/.env. Here a partition serves only the files `allows` accepts, judged
 * after symlinks resolve; anything else looks missing.
 */
function confineFiles(partition: string, allows: (file: string) => boolean): void {
  if (confinedPartitions.has(partition)) {
    return
  }

  confinedPartitions.add(partition)
  session.fromPartition(partition).protocol.handle('file', async request => {
    try {
      if (allows(await fs.promises.realpath(fileURLToPath(request.url)))) {
        return await net.fetch(request, { bypassCustomProtocolHandlers: true })
      }
    } catch {
      // Missing files and malformed URLs are refused like the rest.
    }

    return new Response(null, { status: 404 })
  })
}

export function registerWebIpc(embed: boolean): WebViews {
  const views = new WebViews(embed)
  views.register()

  return views
}
