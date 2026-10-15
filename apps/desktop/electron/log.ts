import fs from 'node:fs'
import path from 'node:path'
import { redactLine } from '../shared/redact.ts'
import { hermesHome } from './paths.ts'

const MAX_TAIL = 400
const tail: string[] = []
let stream: fs.WriteStream | null = null

function ensureStream(): fs.WriteStream | null {
  if (stream) {
    return stream
  }

  // Under Vitest the log stays in memory: tests used to append to the person's real herald-os.log (HERMES_HOME).
  if (process.env.VITEST) {
    return null
  }

  try {
    const dir = path.join(hermesHome(), 'logs')
    fs.mkdirSync(dir, { recursive: true })
    stream = fs.createWriteStream(path.join(dir, 'herald-os.log'), { flags: 'a' })
  } catch {
    stream = null
  }

  return stream
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
  ensureStream()?.write(line + '\n')
}

export function logTail(lines = 120): string[] {
  return tail.slice(-lines)
}
