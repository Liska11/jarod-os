/*
 * Absolute paths of either family, taken apart and put back together: POSIX (`/home/san/a`) and Windows (`C:\Users\San\a`,
 * `C:/Users/San/a`, `\\server\share\a`). The Files page did its arithmetic on `/` alone, so on Windows "up" stayed put, the
 * breadcrumb fell back to `/` and new names were joined with a `/`. Pure, no `node:path`: the renderer uses it too.
 */

export interface ParsedPath {
  /** `/`, `C:\` or `\\server\share\`; empty for a relative path. */
  root: string
  segments: string[]
  windows: boolean
}

const DRIVE = /^([A-Za-z]):(?:[\\/]|$)/
const UNC = /^[\\/]{2}([^\\/]+)[\\/]+([^\\/]+)(?:[\\/]|$)/

export function parsePath(path: string): ParsedPath {
  const drive = DRIVE.exec(path)

  if (drive) {
    return { root: `${drive[1].toUpperCase()}:\\`, segments: splitSegments(path.slice(drive[0].length)), windows: true }
  }

  const unc = UNC.exec(path)

  if (unc) {
    return { root: `\\\\${unc[1]}\\${unc[2]}\\`, segments: splitSegments(path.slice(unc[0].length)), windows: true }
  }

  if (path.startsWith('/')) {
    return { root: '/', segments: splitSegments(path), windows: false }
  }

  return { root: '', segments: splitSegments(path), windows: false }
}

function splitSegments(rest: string): string[] {
  return rest.split(/[\\/]+/).filter(segment => segment && segment !== '.')
}

export function formatPath({ root, segments, windows }: ParsedPath): string {
  return root + segments.join(windows ? '\\' : '/')
}

/** Whether `path` is a Windows path (a drive or a share). */
export function isWindowsPath(path: string): boolean {
  return parsePath(path).windows
}

/** Whether `path` is absolute in either family. */
export function isAbsolutePath(path: string): boolean {
  return parsePath(path).root !== ''
}

/** `path` without trailing separators and with its family's separator; a root stays a root (`C:\`, `/`). */
export function normalizeDir(path: string): string {
  return path ? formatPath(parsePath(path)) : path
}

/** The folder holding `path`, or null at a root. */
export function parentOf(path: string): string | null {
  const parsed = parsePath(path)

  if (!path || parsed.segments.length === 0) {
    return null
  }

  return formatPath({ ...parsed, segments: parsed.segments.slice(0, -1) }) || null
}

/** `name` inside `dir`, with the folder's own separator. */
export function joinPath(dir: string, name: string): string {
  const parsed = parsePath(dir)

  return formatPath({ ...parsed, segments: [...parsed.segments, ...splitSegments(name)] })
}

/** The segments of `path` below `base`, or null when `path` is not `base` or inside it (Windows compares without case). */
export function segmentsBelow(path: string, base: string): string[] | null {
  const a = parsePath(path)
  const b = parsePath(base)
  const fold = (value: string) => (a.windows ? value.toLowerCase() : value)

  if (a.windows !== b.windows || fold(a.root) !== fold(b.root) || a.segments.length < b.segments.length) {
    return null
  }

  return b.segments.every((segment, index) => fold(segment) === fold(a.segments[index] as string)) ? a.segments.slice(b.segments.length) : null
}

/** Characters a file name may not hold: `/` everywhere, and Windows' reserved set on a Windows path. */
export function invalidNameCharacter(name: string, windows: boolean): string | null {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what a file name may not hold.
  const match = (windows ? /[\\/:*?"<>|\u0000-\u001f]/ : /[/\u0000]/).exec(name)

  return match ? match[0] : null
}
