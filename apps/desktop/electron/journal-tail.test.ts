import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { tailJournal } from './journal-tail.ts'

const made: string[] = []
const dir = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'jarod-tail-'))
  made.push(d)

  return d
}

afterEach(() => {
  for (const d of made.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true })
  }
})

const lines = (...l: string[]) => l.map(x => `${x}\n`).join('')

describe('tailJournal (V-03)', () => {
  it('rend les dernières lignes, et complète par la génération tournée quand la courante est courte', () => {
    const file = path.join(dir(), 'control-audit.jsonl')
    fs.writeFileSync(`${file}.1`, lines('{"n":1}', '{"n":2}'))
    fs.writeFileSync(file, `{"n":3}\r\n{"n":4}\n`)

    expect(tailJournal(file, 2)).toEqual(['{"n":3}', '{"n":4}'])
    expect(tailJournal(file, 3)).toEqual(['{"n":2}', '{"n":3}', '{"n":4}'])
    expect(tailJournal(file, 10)).toHaveLength(4)
  })

  it('un journal absent ne rend rien et ne lève pas', () => {
    expect(tailJournal(path.join(dir(), 'absent.jsonl'), 5)).toEqual([])
  })

  it('un gros journal est lu par la fin : la ligne coupée par la fenêtre de lecture n’est jamais rendue', () => {
    const file = path.join(dir(), 'audit.jsonl')
    fs.writeFileSync(file, lines('x'.repeat(2 * 1024 * 1024), '{"fin":true}'))

    expect(tailJournal(file, 5)).toEqual(['{"fin":true}'])
  })
})
