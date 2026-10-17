import path from 'node:path'
import { redactLine } from '../shared/redact.ts'
import { hermesHome } from './paths.ts'
import { RotatingLog } from './rotating-log.ts'

const MAX_TAIL = 400
const tail: string[] = []
const MAX_LOG_BYTES = 5 * 1024 * 1024
let sink: RotatingLog | null = null

function ensureSink(): RotatingLog | null {
  if (sink) {
    return sink
  }

  // Under Vitest the log stays in memory: tests used to append to the person's real herald-os.log (HERMES_HOME).
  if (process.env.VITEST) {
    return null
  }

  sink = new RotatingLog(path.join(hermesHome(), 'logs', 'herald-os.log'), MAX_LOG_BYTES)

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
