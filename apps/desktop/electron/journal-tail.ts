import fs from 'node:fs'

/** Ce qu'on lit au plus à la fin d'un journal : assez pour 500 lignes d'audit (une ligne c3 fait moins de 1 Kio). */
const TAIL_BYTES = 1024 * 1024

function readTail(file: string): string[] {
  let fd: number | null = null

  try {
    const size = fs.statSync(file).size
    const start = Math.max(0, size - TAIL_BYTES)
    const buf = Buffer.alloc(size - start)

    fd = fs.openSync(file, 'r')
    fs.readSync(fd, buf, 0, buf.length, start)

    const lines = buf.toString('utf8').split(/\r?\n/)

    // La lecture partielle commence au milieu d'une ligne : celle-là n'est jamais rendue à moitié.
    if (start > 0) {
      lines.shift()
    }

    return lines.filter(line => line.trim())
  } catch {
    return []
  } finally {
    if (fd !== null) {
      fs.closeSync(fd)
    }
  }
}

/**
 * Les `n` dernières lignes COMPLÈTES d'un journal à rotation (`<nom>` puis `<nom>.1`, comme le contrôle, l'hôte Rust et le pont l'écrivent),
 * sans le lire en entier. Absent ou illisible : aucune ligne.
 */
export function tailJournal(file: string, n: number, rotated = `${file}.1`): string[] {
  const current = readTail(file)
  const lines = current.length >= n ? current : [...readTail(rotated), ...current]

  return lines.slice(-Math.max(0, n))
}
