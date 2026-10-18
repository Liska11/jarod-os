import fs from 'node:fs'
import path from 'node:path'

/*
 * Jarod-OS on a disk of its own (docs/JAROD-DISK.md). The person picks a drive (or a folder) at setup or in Settings;
 * everything Jarod-OS owns then lives under that root:
 *
 *   <root>\.jarod-os-root.json   the marker: this folder is a Jarod root (adopted as is on a reinstall)
 *   <root>\data                  the core's profile and the shell's home (JAROD_OS_DATA, protected)
 *   <root>\workspace             the folder conversations work in (JAROD_WORKSPACE)
 *   <root>\environments, backups, sandboxes, vms
 *
 * The choice is kept in the shell's config folder (data-location.json) and applied at startup, before anything reads
 * the data paths. Variables already set in the environment (a test, a portable install) win over it. When the chosen
 * root is not there (the disk is unplugged), Jarod-OS starts on its default folders and says so: it never creates a
 * fresh, empty root in its place.
 */

export const ROOT_FOLDERS = ['data', 'workspace', 'environments', 'backups', 'sandboxes', 'vms'] as const
export const MARKER = '.jarod-os-root.json'
export const LOCATION_FILE = 'data-location.json'

export interface RootMarker {
  kind: 'jarod-os-root'
  version: 1
  created: string
}

export type DataRootState =
  /** Nothing chosen: the default folders (%LOCALAPPDATA%\Jarod-OS, Documents\Jarod-OS). */
  | { kind: 'default' }
  /** The chosen root is in use. */
  | { kind: 'root'; root: string }
  /** A root was chosen but is not reachable now: the default folders are in use meanwhile. */
  | { kind: 'missing'; root: string }
  /** The environment decides (JAROD_OS_DATA set by a test or a portable install). */
  | { kind: 'environment' }

export interface FsLike {
  existsSync: (file: string) => boolean
  readFileSync: (file: string, encoding: 'utf8') => string
}

export function readLocation(configDir: string, io: FsLike = fs): string | null {
  try {
    const parsed = JSON.parse(io.readFileSync(path.join(configDir, LOCATION_FILE), 'utf8')) as { root?: unknown }

    return typeof parsed.root === 'string' && path.win32.isAbsolute(parsed.root) ? parsed.root : null
  } catch {
    return null
  }
}

export function isRoot(root: string, io: FsLike = fs): boolean {
  try {
    const marker = JSON.parse(io.readFileSync(path.join(root, MARKER), 'utf8')) as Partial<RootMarker>

    return marker.kind === 'jarod-os-root'
  } catch {
    return false
  }
}

export function rootPaths(root: string, lib: typeof path.win32 | typeof path.posix = path): Record<(typeof ROOT_FOLDERS)[number], string> {
  return Object.fromEntries(ROOT_FOLDERS.map(name => [name, lib.join(root, name)])) as Record<(typeof ROOT_FOLDERS)[number], string>
}

/**
 * Decide where the data lives and say it through the environment (JAROD_OS_ROOT, JAROD_OS_DATA, JAROD_WORKSPACE).
 * Called once at startup, before the core or the shell's home is resolved. Returns what happened, for the log and the UI.
 */
export function applyDataRoot(configDir: string, env: NodeJS.ProcessEnv = process.env, io: FsLike = fs): DataRootState {
  if (env.JAROD_OS_DATA?.trim()) {
    return { kind: 'environment' }
  }

  const root = readLocation(configDir, io)

  if (!root) {
    return { kind: 'default' }
  }

  if (!io.existsSync(root) || !isRoot(root, io)) {
    return { kind: 'missing', root }
  }

  const paths = rootPaths(root, path.win32.isAbsolute(root) && /^[a-z]:/i.test(root) ? path.win32 : path)
  env.JAROD_OS_ROOT = root
  env.JAROD_OS_DATA = paths.data

  if (!env.JAROD_WORKSPACE?.trim()) {
    env.JAROD_WORKSPACE = paths.workspace
  }

  return { kind: 'root', root }
}
