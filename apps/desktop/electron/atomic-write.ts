import { randomBytes } from 'node:crypto'
import fs, { readFileSync, renameSync } from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

/**
 * Writes `file` so a reader sees the old content or the new one, never half of it: the data goes to a
 * temporary file next to it, then a rename replaces the original (atomic on one volume, Windows included).
 * A crash or power cut in the middle used to leave a truncated settings file that read back as defaults.
 *
 * On Windows a rename can fail for a moment while an antivirus or indexer holds the target open; it is
 * retried briefly, then the content is written in place rather than lost.
 */
export function writeFileAtomic(file: string, data: string | Uint8Array, options: { mode?: number } = {}): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`
  fs.writeFileSync(temp, data, { mode: options.mode })

  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(temp, file)

      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code

      if ((code === 'EPERM' || code === 'EACCES' || code === 'EBUSY') && attempt < 5) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (attempt + 1))
        continue
      }

      try {
        fs.writeFileSync(file, data, { mode: options.mode })
      } finally {
        fs.rmSync(temp, { force: true })
      }

      return
    }
  }
}

/*
 * V-20 (upstream #140, fa84b92, MIT, same lineage): an async atomic text write that can also refuse to replace a file that changed
 * since it was read (`expect`), checked just before the rename. The memory page uses it, under the lock Hermes's memory tool takes.
 */

/** Prefix of the temporaries `writeTextAtomic` leaves for an instant before renaming them. */
export const ATOMIC_TMP_PREFIX = '.jarod-tmp.'

export interface AtomicWriteOptions {
  /**
   * Write only if the file still holds exactly this text (`null`: only if it does not exist),
   * checked just before the rename. A mismatch writes nothing and returns false.
   */
  expect?: string | null
}

/** Windows refuses a rename while another process has the target open (an editor, an indexer, Hermes reading it). */
const RENAME_RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES'])
const RENAME_ATTEMPTS = 6

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function renameRetrying(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await fsp.rename(from, to)

      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code

      if (process.platform !== 'win32' || attempt >= RENAME_ATTEMPTS || !code || !RENAME_RETRYABLE.has(code)) {
        throw error
      }

      await sleep(20 * 2 ** (attempt - 1))
    }
  }
}

/** Make the rename itself durable. Best effort: some filesystems refuse to fsync a folder. */
async function syncDir(dir: string): Promise<void> {
  if (process.platform === 'win32') {
    return
  }

  try {
    const handle = await fsp.open(dir, 'r')

    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch {
    // The file is already in place; only its durability across a power cut is less certain.
  }
}

function currentTextSync(file: string): string | null {
  try {
    return readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }

    throw error
  }
}

/**
 * Replace `file` with `content` so a reader sees either the old text or the new, never a
 * truncated file: write and fsync a temporary beside it, rename it over the target, then fsync the
 * folder. Follows a symlink to the real file (the link stays a link), keeps an existing file's
 * permission bits and creates a new one owner-only (0600). Hermes rewrites its memory files the
 * same way (`utils.atomic_write_text`). Returns false, writing nothing, when `expect` no longer holds.
 */
export async function writeTextAtomic(file: string, content: string, options: AtomicWriteOptions = {}): Promise<boolean> {
  const target = await fsp.realpath(file).catch(() => file)
  const dir = path.dirname(target)
  await fsp.mkdir(dir, { recursive: true })
  const mode = await fsp.stat(target).then(
    stat => stat.mode & 0o7777,
    () => 0o600
  )
  const tmp = path.join(dir, `${ATOMIC_TMP_PREFIX}${path.basename(target)}.${randomBytes(6).toString('hex')}`)

  try {
    const handle = await fsp.open(tmp, 'wx', mode)

    try {
      await handle.writeFile(content, 'utf8')
      // `open` filters the mode through the umask; set the bits exactly.
      await handle.chmod(mode)
      await handle.sync()
    } finally {
      await handle.close()
    }

    if (options.expect !== undefined) {
      // Check and rename with nothing in between, not even a turn of the event loop: a writer that
      // ignores the lock can only slip into that gap.
      if (currentTextSync(target) !== options.expect) {
        await fsp.rm(tmp, { force: true })

        return false
      }

      try {
        renameSync(tmp, target)
      } catch {
        await renameRetrying(tmp, target)
      }
    } else {
      await renameRetrying(tmp, target)
    }
  } catch (error) {
    await fsp.rm(tmp, { force: true })
    throw error
  }

  await syncDir(dir)

  return true
}
