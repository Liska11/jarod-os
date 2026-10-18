import { existsSync, renameSync } from 'node:fs'
import path from 'node:path'
import { redactLine } from '../shared/redact.ts'
import { hermesHome } from './paths.ts'
import { RotatingLog } from './rotating-log.ts'

/** The app's log, in `<Hermes home>/logs/`. It was `herald-os.log` before the Jarod-OS name. */
export const LOG_NAME = 'jarod-os.log'
const LEGACY_NAME = 'herald-os.log'

/**
 * Renames the old `herald-os.log` (and its older generation `.1`) to the Jarod-OS name, so the history stays in one file.
 * A `jarod-os.log` that already exists is never overwritten; a failure leaves the old file where it is.
 */
export function adoptLegacyLog(dir: string): void {
  for (const suffix of ['', '.1']) {
    const legacy = path.join(dir, LEGACY_NAME + suffix)
    const current = path.join(dir, LOG_NAME + suffix)

    try {
      if (existsSync(legacy) && !existsSync(current)) {
        renameSync(legacy, current)
      }
    } catch {
      /* in use or not ours to move: the old file simply stays */
    }
  }
}

const MAX_TAIL = 400
const tail: string[] = []
const MAX_LOG_BYTES = 5 * 1024 * 1024
let sink: RotatingLog | null = null

function ensureSink(): RotatingLog | null {
  if (sink) {
    return sink
  }

  // Under Vitest the log stays in memory: tests used to append to the person's real log (HERMES_HOME).
  if (process.env.VITEST) {
    return null
  }

  const dir = path.join(hermesHome(), 'logs')
  adoptLegacyLog(dir)
  sink = new RotatingLog(path.join(dir, LOG_NAME), MAX_LOG_BYTES)

  return sink
}

export function log(scope: string, message: string): void {
  // Un journal traverse le masque avant d'être gardé en mémoire, affiché et écrit sur disque : une erreur de
  // provider ou une réponse HTTP peut citer l'en-tête refusé. Borné aussi (4 000 : une ligne reste une ligne).
  const line = `${new Date().toISOString()} [${scope}] ${redactLine(message, 4_000)}`
  tail.push(line)

  if (tail.length > MAX_TAIL) {
    tail.splice(0, tail.length - MAX_TAIL)
  }

  console.log(line)
  ensureSink()?.write(line)
}

export function logTail(lines = 120): string[] {
  return tail.slice(-lines)
}
