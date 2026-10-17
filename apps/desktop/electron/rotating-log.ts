import fs from 'node:fs'
import path from 'node:path'

/**
 * Append-only text log, bounded: once the file reaches `limit` bytes it becomes `<name>.1` (one older
 * generation, replaced each time) and a new file starts. A line is never cut, and a failure to write
 * (folder missing, disk full, file locked) is swallowed: a log must never take the app down.
 */
export class RotatingLog {
  private size: number | null = null

  constructor(
    private readonly file: string,
    private readonly limit: number
  ) {}

  write(line: string): void {
    const data = `${line}\n`

    try {
      if (this.size === null) {
        fs.mkdirSync(path.dirname(this.file), { recursive: true })
        this.size = fs.existsSync(this.file) ? fs.statSync(this.file).size : 0
      }

      if (this.size >= this.limit) {
        this.rotate()
      }

      fs.appendFileSync(this.file, data)
      this.size += Buffer.byteLength(data)
    } catch {
      // Unwritable: the line stays in memory (log tail) and on the console, which is all a log may promise here.
      this.size = null
    }
  }

  /** Nothing is held open between writes; kept so callers have one place to release resources if that changes. */
  close(): void {}

  private rotate(): void {
    const old = `${this.file}.1`

    fs.rmSync(old, { force: true })
    fs.renameSync(this.file, old)
    this.size = 0
  }
}
