import os from 'node:os'
import path from 'node:path'

/** Whether `file` is strictly inside `root` (or, with `orEqual`, is `root`). Windows compares without case. */
export function isBelow(root: string, file: string, platform: NodeJS.Platform = process.platform, orEqual = false): boolean {
  const lib = platform === 'win32' ? path.win32 : path.posix
  const fold = (value: string) => (platform === 'win32' ? lib.normalize(value).toLowerCase() : lib.normalize(value))
  const base = fold(root).replace(/[\/]+$/, '')
  const target = fold(file)

  return (orEqual && target === base) || target.startsWith(base + lib.sep)
}

/** Locations the shell never writes to itself, whatever the person asks. */
export function protectedRoots(home: string, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string[] {
  if (platform === 'win32') {
    const lib = path.win32
    const roaming = env.APPDATA ?? lib.join(home, 'AppData', 'Roaming')
    const local = env.LOCALAPPDATA ?? lib.join(home, 'AppData', 'Local')

    return [
      lib.join(home, '.ssh'),
      lib.join(home, '.gnupg'),
      // Credential Manager and DPAPI keep their blobs and master keys in these folders.
      lib.join(roaming, 'Microsoft', 'Credentials'),
      lib.join(roaming, 'Microsoft', 'Protect'),
      lib.join(local, 'Microsoft', 'Credentials'),
      lib.join(local, 'Microsoft', 'Vault'),
      lib.join(roaming, 'gnupg'),
      env.SystemRoot ?? 'C:\Windows',
      env.ProgramFiles ?? 'C:\Program Files',
      env['ProgramFiles(x86)'] ?? 'C:\Program Files (x86)',
      env.ProgramData ?? 'C:\ProgramData'
    ]
  }

  return [path.posix.join(home, '.ssh'), path.posix.join(home, 'Library', 'Keychains'), '/System', '/usr', '/bin', '/sbin', '/private/etc', '/Library']
}

/** Temporary folders that count as the person's own space (besides home). */
export function scratchRoots(platform: NodeJS.Platform = process.platform): string[] {
  return platform === 'win32' ? [os.tmpdir()] : ['/tmp', '/private/tmp']
}

/** Throws unless `file` may be edited directly: inside home or a scratch folder, and not protected. */
export function assertWritablePath(file: string, home: string = os.homedir(), platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  if (!isBelow(home, file, platform) && !scratchRoots(platform).some(root => isBelow(root, file, platform))) {
    throw new Error('Jarod-OS only edits files inside your home folder')
  }

  if (protectedRoots(home, platform, env).some(root => isBelow(root, file, platform, true))) {
    throw new Error(`${file} is a protected location`)
  }

  return file
}

/** Project folders must be inside the home folder (or a scratch folder). */
export function isProjectLocation(root: string, home: string = os.homedir(), platform: NodeJS.Platform = process.platform): boolean {
  return isBelow(home, root, platform) || scratchRoots(platform).some(scratch => isBelow(scratch, root, platform))
}
