import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ATOMIC_TMP_PREFIX, writeFileAtomic, writeTextAtomic } from './atomic-write.ts'

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

describe('writeTextAtomic (V-20, upstream #140)', () => {
  const leftovers = (dir: string) => fs.readdirSync(dir).filter(name => name.startsWith(ATOMIC_TMP_PREFIX))

  it('creates the file and its folder, and leaves no temporary behind', async () => {
    const file = path.join(tempDir(), 'memories', 'MEMORY.md')

    expect(await writeTextAtomic(file, 'first')).toBe(true)
    expect(fs.readFileSync(file, 'utf8')).toBe('first')
    expect(leftovers(path.dirname(file))).toEqual([])
  })

  it('with expect: replaces only the text it was given, otherwise writes nothing and returns false', async () => {
    const file = path.join(tempDir(), 'MEMORY.md')
    fs.writeFileSync(file, 'A')

    expect(await writeTextAtomic(file, 'A+B', { expect: 'A' })).toBe(true)
    expect(fs.readFileSync(file, 'utf8')).toBe('A+B')
    // Someone else wrote in between: the stale write is refused, the other text stays.
    expect(await writeTextAtomic(file, 'A+C', { expect: 'A' })).toBe(false)
    expect(fs.readFileSync(file, 'utf8')).toBe('A+B')
    expect(leftovers(path.dirname(file))).toEqual([])
  })

  it('expect null means only if the file is still absent', async () => {
    const file = path.join(tempDir(), 'USER.md')

    expect(await writeTextAtomic(file, 'me', { expect: null })).toBe(true)
    expect(await writeTextAtomic(file, 'other', { expect: null })).toBe(false)
    expect(fs.readFileSync(file, 'utf8')).toBe('me')
  })
})
