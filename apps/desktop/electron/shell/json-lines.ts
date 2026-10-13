import crypto from 'node:crypto'

/** A request line longer than this is not a request: the connection is dropped instead of buffering it. */
export const MAX_LINE_CHARS = 1_000_000

/** Splits a text stream into trimmed, non-empty lines. */
export class LineSplitter {
  private buffer = ''

  constructor(private readonly max: number = MAX_LINE_CHARS) {}

  /** The complete lines `chunk` finishes, or null once the pending line outgrows the limit (any local process can dial the socket). */
  push(chunk: string): string[] | null {
    this.buffer += chunk
    const lines: string[] = []
    let index = this.buffer.indexOf('\n')

    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)

      if (line) {
        lines.push(line)
      }

      index = this.buffer.indexOf('\n')
    }

    if (this.buffer.length > this.max) {
      this.buffer = ''

      return null
    }

    return lines
  }
}

/** Whether `supplied` is the token, compared in constant time so the answer's timing gives nothing away. */
export function sameToken(supplied: unknown, expected: string): boolean {
  if (typeof supplied !== 'string' || !expected) {
    return false
  }

  const a = crypto.createHash('sha256').update(supplied).digest()
  const b = crypto.createHash('sha256').update(expected).digest()

  return crypto.timingSafeEqual(a, b)
}
