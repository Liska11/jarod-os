import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Whether `file` is strictly inside `root` (or, with `orEqual`, is `root`). Windows compares without case. */
export function isBelow(root: string, file: string, platform: NodeJS.Platform = process.platform, orEqual = false): boolean {
  const lib = platform === 'win32' ? path.win32 : path.posix
  const fold = (value: string) => (platform === 'win32' ? lib.normalize(value).toLowerCase() : lib.normalize(value))
  const base = fold(root).replace(/[/]+$/, '')
  const target = fold(file)

  return (orEqual && target === base) || target.startsWith(base + lib.sep)
}

/** Suffixes whose default action runs code instead of showing the file. Mirrors the kernel list (plugins/tools/src/system/act.ts). */
export const EXECUTABLE_SUFFIXES = new Set([
  '.exe', '.com', '.scr', '.bat', '.cmd', '.msi', '.msp', '.msc', '.cpl', '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh', '.ps1', '.psm1', '.hta', '.reg',
  '.jar', '.dll', '.lnk', '.url', '.appref-ms', '.application', '.gadget', '.sh', '.bash', '.zsh', '.command', '.app'
])

/**
 * Windows drops a trailing dot or space in every component it opens, so `…\.ssh.\x` opens `…\.ssh\x`
 * and `PROGRA~1` names `Program Files`. Detection happens on the raw string: normalization would keep
 * the decoy anyway, and resolving would already be too late.
 */
export function hasDecoyComponent(file: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== 'win32') {
    return false
  }

  return file.split(/[\\/]+/).some(segment => {
    if (!segment || segment === '.' || segment === '..') {
      return false
    }

    return /[. ]$/.test(segment)
  })
}

/**
 * `file` with every existing prefix resolved: junctions, symlinks and 8.3 short names all come back in
 * their real form, so a comparison against a protected root cannot be fooled by a link. A tail that does
 * not exist yet is kept verbatim.
 */
export function resolveRealPath(file: string, platform: NodeJS.Platform = process.platform): string {
  const lib = platform === 'win32' ? path.win32 : path.posix
  const absolute = lib.resolve(file)
  let current = absolute
  const tail: string[] = []

  for (;;) {
    try {
      const real = fs.realpathSync.native(current)

      return tail.length > 0 ? lib.join(real, ...tail.reverse()) : real
    } catch {
      const parent = lib.dirname(current)

      if (parent === current) {
        return absolute
      }

      tail.push(lib.basename(current))
      current = parent
    }
  }
}

/** Locations the shell never writes to itself, whatever the person asks. */
export function protectedRoots(home: string, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string[] {
  if (platform === 'win32') {
    const lib = path.win32
    const roaming = env.APPDATA ?? lib.join(home, 'AppData', 'Roaming')
    const local = env.LOCALAPPDATA ?? lib.join(home, 'AppData', 'Local')
    // The shell's own state (policy rules, audit log, preferences, the secret vault) and the kernel's
    // profile (jarod.db, db.key.dpapi) live here: nothing in the window may rewrite them.
    const hermes = env.HERMES_HOME?.trim() || lib.join(local, 'hermes')
    const jarodData = env.JAROD_OS_DATA?.trim() || lib.join(local, 'Jarod-OS')

    const programData = env.ProgramData ?? 'C:\\ProgramData'

    return [
      lib.join(home, '.ssh'),
      lib.join(home, '.gnupg'),
      // Credential Manager, DPAPI and the certificate stores keep their blobs and master keys in these folders.
      lib.join(roaming, 'Microsoft', 'Credentials'),
      lib.join(roaming, 'Microsoft', 'Protect'),
      lib.join(roaming, 'Microsoft', 'SystemCertificates'),
      lib.join(local, 'Microsoft', 'Credentials'),
      lib.join(local, 'Microsoft', 'Vault'),
      lib.join(roaming, 'gnupg'),
      // Machine-wide cryptographic material (DPAPI machine keys, catalog stores).
      lib.join(programData, 'Microsoft', 'Crypto'),
      lib.join(hermes, 'jarod-os'),
      // Its name before the Jarod-OS rename: the copy leaves it in place, with the same audit log and policy in it.
      lib.join(hermes, 'herald-os'),
      lib.join(hermes, 'vault'),
      jarodData,
      env.SystemRoot ?? 'C:\\Windows',
      env.ProgramFiles ?? 'C:\\Program Files',
      env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
      programData
    ]
  }

  const hermes = env.HERMES_HOME?.trim() || path.posix.join(home, '.hermes')

  return [
    path.posix.join(home, '.ssh'),
    path.posix.join(home, 'Library', 'Keychains'),
    path.posix.join(hermes, 'jarod-os'),
    path.posix.join(hermes, 'herald-os'),
    path.posix.join(hermes, 'vault'),
    env.JAROD_OS_DATA?.trim() || path.posix.join(home, '.jarod-os'),
    '/System', '/usr', '/bin', '/sbin', '/private/etc', '/Library'
  ]
}

/** Temporary folders that count as the person's own space (besides home). */
export function scratchRoots(platform: NodeJS.Platform = process.platform): string[] {
  return platform === 'win32' ? [os.tmpdir()] : ['/tmp', '/private/tmp']
}

/**
 * The lexically identical check, but on the real path: a junction or symlink that leads into a protected
 * folder is refused, and so is a Windows name trick (`…\.ssh.\x`). Returns `file` unchanged, so callers
 * keep acting on the path the person sees.
 */
export function assertNotProtected(file: string, home: string = os.homedir(), platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  if (hasDecoyComponent(file, platform)) {
    throw new Error(`${file} hides behind a Windows name trick (a component ends with a dot or a space)`)
  }

  const real = resolveRealPath(file, platform)

  if (protectedRoots(home, platform, env).some(root => isBelow(resolveRealPath(root, platform), real, platform, true))) {
    throw new Error(`${file} is a protected location`)
  }

  return file
}

/**
 * The person's own space: home, the scratch folders, and Jarod-OS's own disk (JAROD_OS_ROOT, data-root.ts) when it has
 * one. Its `data` folder stays protected (protectedRoots), the rest (workspace, environments, backups…) is theirs.
 */
export function ownRoots(home: string, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string[] {
  const jarodRoot = env.JAROD_OS_ROOT?.trim()

  return [home, ...scratchRoots(platform), ...(jarodRoot ? [jarodRoot] : [])]
}

/** Throws unless `file` may be edited directly: inside home, a scratch folder or the Jarod disk, and not protected. */
export function assertWritablePath(file: string, home: string = os.homedir(), platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  const real = resolveRealPath(file, platform)

  if (!ownRoots(home, platform, env).some(root => isBelow(resolveRealPath(root, platform), real, platform))) {
    throw new Error('Jarod-OS only edits files inside your home folder or its own disk')
  }

  return assertNotProtected(file, home, platform, env)
}

/**
 * Throws unless `file` may be read or shown. Reads stay allowed outside home (a workspace on another
 * drive is legitimate), but never inside a protected location and never through a name trick.
 */
export function assertReadablePath(file: string, home: string = os.homedir(), platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  return assertNotProtected(file, home, platform, env)
}

/**
 * Throws unless `file` may be handed to the shell's default action. A program, a script or a shortcut
 * would be executed by that action: naming the application to open it in is the only safe way.
 */
export function assertOpenablePath(file: string, home: string = os.homedir(), platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  const checked = assertReadablePath(file, home, platform, env)
  const lib = platform === 'win32' ? path.win32 : path.posix

  if (EXECUTABLE_SUFFIXES.has(lib.extname(checked).toLowerCase())) {
    throw new Error(`${checked} is a program or a script: opening it would run it`)
  }

  return checked
}

/** Project folders must be inside the home folder, a scratch folder or the Jarod disk. */
export function isProjectLocation(root: string, home: string = os.homedir(), platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): boolean {
  const real = resolveRealPath(root, platform)

  return ownRoots(home, platform, env).some(own => isBelow(resolveRealPath(own, platform), real, platform))
}
