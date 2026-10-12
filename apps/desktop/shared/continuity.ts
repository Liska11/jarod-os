import { baseName } from './path-names.ts'

/*
 * Exclusions for "Pick up where you left off", shared by main (paths) and the renderer (chat
 * titles, calendar events). An entry is either a folder (absolute or `~/` path, with `/` or `\`,
 * a drive letter on Windows) or a word.
 */

const normalise = (text: string) => text.toLowerCase().replace(/[\s._-]+/g, ' ').trim()

/** A POSIX root, a drive (`C:\`, `C:/`, `C:`) or a UNC share (`\\server\share`). */
function isAbsolute(path: string): boolean {
  return path.startsWith('/') || path.startsWith('\\\\') || /^[A-Za-z]:([\\/]|$)/.test(path)
}

/** Windows paths are compared without regard to case or separator; POSIX ones keep both. */
function isWindowsPath(path: string): boolean {
  return path.startsWith('\\\\') || /^[A-Za-z]:([\\/]|$)/.test(path)
}

function isFolderEntry(entry: string): boolean {
  return isAbsolute(entry) || entry === '~' || entry.startsWith('~/') || entry.startsWith('~\\')
}

function expand(entry: string, home: string): string {
  const full = entry === '~' || entry.startsWith('~/') || entry.startsWith('~\\') ? home + entry.slice(1) : entry

  return full.replace(/[\\/]+$/, '') || '/'
}

/** `text` is `folder` itself or lies inside it. */
function isInside(text: string, folder: string): boolean {
  if (!isWindowsPath(folder)) {
    return text === folder || text.startsWith(`${folder}/`)
  }

  const there = text.replace(/\\/g, '/').toLowerCase()
  const root = folder.replace(/\\/g, '/').toLowerCase()

  return there === root || there.startsWith(`${root}/`)
}

/**
 * True when `text` (a path, a title, an app name) falls under one of the exclusions. A folder hides
 * everything inside it, and its name hides titles that mention it; a word hides anything that
 * contains it, ignoring case and `-`, `_`, `.` separators.
 */
export function isExcluded(text: string, exclude: readonly string[], home: string): boolean {
  if (!text) {
    return false
  }

  const haystack = normalise(text)

  for (const raw of exclude) {
    const entry = raw.trim()

    if (!entry) {
      continue
    }

    if (isFolderEntry(entry)) {
      const folder = expand(entry, home)

      if (isInside(text, folder)) {
        return true
      }

      // Short names ("src", "tmp") would hide far too much prose.
      const name = normalise(baseName(folder) === folder ? '' : baseName(folder))

      if (name.length >= 4 && !isAbsolute(text) && haystack.includes(name)) {
        return true
      }

      continue
    }

    const word = normalise(entry)

    if (word && haystack.includes(word)) {
      return true
    }
  }

  return false
}
