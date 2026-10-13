import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { writeFileAtomic } from './atomic-write.ts'

const dirs: string[] = []

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-'))
  dirs.push(dir)

  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('writeFileAtomic', () => {
  it('creates the folder and the file', () => {
    const file = path.join(tempDir(), 'nested', 'prefs.json')
    writeFileAtomic(file, '{"a":1}')

    expect(fs.readFileSync(file, 'utf8')).toBe('{"a":1}')
  })

  it('replaces an existing file and leaves no temporary file behind', () => {
    const dir = tempDir()
    const file = path.join(dir, 'prefs.json')
    fs.writeFileSync(file, 'old')
    writeFileAtomic(file, 'new')

    expect(fs.readFileSync(file, 'utf8')).toBe('new')
    expect(fs.readdirSync(dir)).toEqual(['prefs.json'])
  })
})
