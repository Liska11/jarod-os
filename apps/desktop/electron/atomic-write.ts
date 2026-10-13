import fs from 'node:fs'
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
