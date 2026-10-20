import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { BackendRuntime } from '../../shared/ipc.ts'
import { log } from '../log.ts'
import { hermesHome, jarodOsDataDir } from '../paths.ts'

/*
 * A packaged Jarod-OS carries the herald-os-bridge plugin in its resources. Hermes loads user
 * plugins from ~/.hermes/plugins, and only enabled ones, so before Hermes starts the app links its
 * copy there and turns it and its tools on: what `npm run bootstrap` does for a checkout and
 * `herald-os setup` for the Linux packages.
 */

/**
 * The plugin's name in Hermes since the Jarod-OS rename (docs/RENAME-PLAN-JAROD-OS.md, phase 5), and the name its link had before.
 * Two things keep their older names on purpose: the packaged resources folder (`herald-os-bridge`, which the Linux packages link by
 * that name) and the toolset id (`herald_os`, which Linux setup enables and saved "always allow" rules are keyed by).
 */
export const BRIDGE_PLUGIN = 'jarod-os-bridge'
const LEGACY_BRIDGE_PLUGIN = 'herald-os-bridge'
const BRIDGE_TOOLSET = 'herald_os'
const BRIDGE_NAMES = new Set([BRIDGE_PLUGIN, LEGACY_BRIDGE_PLUGIN])

/** Whether `dir` holds this bridge, under either of its names (its plugin.yaml says so). */
function isOurBridge(dir: string): boolean {
  try {
    const name = /^name:\s*["']?([\w-]+)/m.exec(fs.readFileSync(path.join(dir, 'plugin.yaml'), 'utf8'))?.[1]

    return Boolean(name && BRIDGE_NAMES.has(name))
  } catch {
    return false
  }
}

/**
 * The link under the older name, once the new one is in place: Hermes would load the bridge twice (two plugins, the same tools).
 * Only a LINK is removed, never what it points at, and only when it leads to this bridge or nowhere; a folder is the person's own.
 */
function retireLegacyLink(): void {
  const legacy = path.join(hermesHome(), 'plugins', LEGACY_BRIDGE_PLUGIN)
  const entry = readEntry(legacy)

  if (entry.kind === 'folder') {
    log('bridge', `${legacy} is a folder of your own; if it holds the bridge too, Hermes may load it twice`)

    return
  }

  if (entry.kind === 'link' && (!entry.exists || isOurBridge(entry.target))) {
    fs.rmSync(legacy, { force: true })
    log('bridge', `removed the link under the older name ${legacy} (it led to ${entry.target}, which is left as it was)`)
  }
}

export type PluginEntry = { kind: 'missing' } | { kind: 'link'; target: string; exists: boolean } | { kind: 'folder' }

/** What to do with ~/.hermes/plugins/herald-os-bridge, given the app's own copy (pure; tested). */
export function bridgeLinkPlan(entry: PluginEntry, bundled: string): 'create' | 'replace' | 'keep' {
  if (entry.kind === 'missing') {
    return 'create'
  }

  // A folder is the person's own, and a checkout's link (bootstrap, herald-os setup) stays theirs.
  if (entry.kind === 'folder' || path.resolve(entry.target) === path.resolve(bundled)) {
    return 'keep'
  }

  // A link that leads nowhere, or into another copy of the app (moved, updated, run from the DMG).
  const anotherApp = /\.app\/Contents\/Resources\/herald-os-bridge\/?$/.test(entry.target) || entry.target.startsWith('/opt/herald-os/') || /[\\/](Jarod-OS|Herald OS)[\\/]resources[\\/]herald-os-bridge[\\/]?$/i.test(entry.target) || /[\\/]WindowsApps[\\/]/i.test(entry.target)

  return !entry.exists || anotherApp ? 'replace' : 'keep'
}

/**
 * Packaged as an appx, the app lives under `...\WindowsApps\`, which other programs' processes may not
 * read (Hermes's Python gets WinError 5), so the plugin is copied out and the copy is what gets linked.
 */
export function needsStaging(resources: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' && /[\\/]WindowsApps[\\/]/i.test(resources)
}

/** A hash of every file's path and bytes: the staged copy is refreshed when, and only when, this changes. */
export function folderFingerprint(dir: string): string {
  const hash = crypto.createHash('sha1')
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name)

      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.isFile()) {
        hash.update(path.relative(dir, full).replace(/\\/g, '/')).update(fs.readFileSync(full))
      }
    }
  }
  walk(dir)

  return hash.digest('hex')
}

/** Copy the bundled plugin to `<herald-os data dir>/bridge-plugin` unless the copy there is current; returns the copy. */
export function stageBridgePlugin(bundled: string, target: string = path.join(jarodOsDataDir(), 'bridge-plugin')): string {
  const wanted = folderFingerprint(bundled)
  const marker = path.join(target, '.fingerprint')
  let current = ''

  try {
    current = fs.readFileSync(marker, 'utf8').trim()
  } catch {
    // Not staged yet.
  }

  if (current !== wanted) {
    fs.rmSync(target, { recursive: true, force: true })
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.cpSync(bundled, target, { recursive: true })
    fs.writeFileSync(marker, `${wanted}\n`)
    log('bridge', `staged the bridge plugin at ${target}`)
  }

  return target
}

function readEntry(link: string): PluginEntry {
  try {
    if (!fs.lstatSync(link).isSymbolicLink()) {
      return { kind: 'folder' }
    }
  } catch {
    return { kind: 'missing' }
  }

  const target = path.resolve(path.dirname(link), fs.readlinkSync(link))

  return { kind: 'link', target, exists: fs.existsSync(target) }
}

function hermes(runtime: BackendRuntime, args: string[]): Promise<boolean> {
  const [command, ...head] = runtime.command

  return new Promise(resolve => {
    if (!command) {
      resolve(false)

      return
    }

    // Generous: the first Hermes command after an update finishes that update (its builds) first.
    const child = execFile(command, [...head, ...args], { cwd: runtime.root ?? undefined, env: { ...process.env, HERMES_HOME: hermesHome() }, timeout: 10 * 60_000, windowsHide: true }, error => {
      if (error) {
        log('bridge', `hermes ${args.join(' ')}: ${error.message}`)
      }

      resolve(!error)
    })
    // A closed stdin answers Hermes's override prompt "no": the bridge never replaces built-in tools.
    child.stdin?.end()
  })
}

export async function ensureBridgePlugin(runtime: BackendRuntime, resources: string = process.resourcesPath): Promise<void> {
  const packaged = path.join(resources, 'herald-os-bridge')

  if (!resources || !fs.existsSync(path.join(packaged, 'plugin.yaml'))) {
    return
  }

  let bundled = packaged

  try {
    bundled = needsStaging(resources) ? stageBridgePlugin(packaged) : packaged
  } catch (error) {
    log('bridge', `could not stage the bridge plugin: ${error instanceof Error ? error.message : String(error)}`)

    return
  }

  const link = path.join(hermesHome(), 'plugins', BRIDGE_PLUGIN)

  try {
    const entry = readEntry(link)
    const plan = bridgeLinkPlan(entry, bundled)

    // A folder of the person's own, or a checkout's link: theirs to manage. The older link still goes: two bridges would load.
    if (plan === 'keep' && !(entry.kind === 'link' && path.resolve(entry.target) === path.resolve(bundled))) {
      retireLegacyLink()

      return
    }

    if (plan !== 'keep') {
      fs.mkdirSync(path.dirname(link), { recursive: true })
      fs.rmSync(link, { force: true })
      // A junction on Windows: a symbolic link needs Developer Mode or an administrator there.
      fs.symlinkSync(bundled, link, process.platform === 'win32' ? 'junction' : undefined)
      log('bridge', `${plan === 'create' ? 'linked' : 'relinked'} ${link} -> ${bundled}`)
    }

    // Only once the new link stands: until then the older one is what keeps the bridge loaded.
    retireLegacyLink()
  } catch (error) {
    log('bridge', `could not link the bridge plugin: ${error instanceof Error ? error.message : String(error)}`)

    return
  }

  // Once: enable the plugin and its tools, and keep them directly callable (tool search would hide
  // them behind a lookup). The marker means it worked, so a failed try runs again on the next start
  // and a person who turns the plugin off later is left alone. Its name carries the plugin's: the marker of
  // the older name (copied with the rest of the folder) must not stop the renamed plugin from being enabled.
  const enabled = path.join(jarodOsDataDir(), `${BRIDGE_PLUGIN}-enabled`)

  if (fs.existsSync(enabled)) {
    return
  }

  for (const args of [
    ['plugins', 'enable', BRIDGE_PLUGIN],
    ['tools', 'enable', BRIDGE_TOOLSET],
    ['config', 'set', 'tools.tool_search.enabled', 'off']
  ]) {
    if (!(await hermes(runtime, args))) {
      return
    }
  }

  fs.mkdirSync(path.dirname(enabled), { recursive: true })
  fs.writeFileSync(enabled, `${new Date().toISOString()}\n`)
}
