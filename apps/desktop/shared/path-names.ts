/*
 * File and folder names out of a path, whatever separator the platform uses: `C:\Users\San\a.txt` and `/home/san/a.txt` both end in `a.txt`. Splitting on `/`
 * alone showed Windows users whole paths where a name belonged.
 */

const SEPARATORS = /[\\/]+/

/** The last segment of a path (trailing separators ignored); the path itself when there is no segment, so a label is never empty. */
export function baseName(path: string): string {
  return path.split(SEPARATORS).filter(Boolean).at(-1) ?? path
}

/** The path segments, without empty ones. */
export function segmentsOf(path: string): string[] {
  return path.split(SEPARATORS).filter(Boolean)
}

/** Where the last segment starts, or -1: the position of the last `/` or `\`. */
export function lastSeparator(path: string): number {
  return Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
}

/** The folder part of a path (`''` when there is none): everything before the last separator. */
export function folderPart(path: string): string {
  const at = lastSeparator(path)

  return at < 0 ? '' : path.slice(0, at)
}
