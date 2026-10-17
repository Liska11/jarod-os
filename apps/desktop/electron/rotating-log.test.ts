import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RotatingLog } from './rotating-log.ts'

const dirs: string[] = []

function dir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'jarod-rotlog-'))
  dirs.push(d)

  return d
}

afterEach(() => {
  for (const d of dirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true })
  }
})

describe('RotatingLog', () => {
  it('moves the file to <name>.1 once it passes the limit and starts a new one; no line is cut', () => {
    const d = dir()
    const file = path.join(d, 'app.log')
    const log = new RotatingLog(file, 300)

    for (let i = 0; i < 30; i++) {
      log.write(`line-${i} ${'x'.repeat(20)}`)
    }

    log.close()

    const live = fs.readFileSync(file, 'utf8')
    const old = fs.readFileSync(`${file}.1`, 'utf8')

    expect(live.length).toBeLessThanOrEqual(300 + 60)
    expect(live).toContain('line-29')
    expect(old.length).toBeGreaterThan(0)

    for (const text of [live, old]) {
      for (const l of text.split('\n').filter(Boolean)) {
        expect(l).toMatch(/^line-\d+ x{20}$/)
      }
    }
  })

  it('rotates a file that is already over the limit when it is first opened', () => {
    const d = dir()
    const file = path.join(d, 'app.log')

    fs.writeFileSync(file, 'old\n'.repeat(200))

    const log = new RotatingLog(file, 300)

    log.write('fresh')
    log.close()

    expect(fs.readFileSync(file, 'utf8')).toBe('fresh\n')
    expect(fs.existsSync(`${file}.1`)).toBe(true)
  })

  it('never throws when the folder cannot be written: a log must not take the app down', () => {
    const d = dir()
    const blocker = path.join(d, 'file')

    fs.writeFileSync(blocker, '')

    const log = new RotatingLog(path.join(blocker, 'sub', 'app.log'), 100)

    expect(() => log.write('x')).not.toThrow()
    expect(() => log.close()).not.toThrow()
  })
})
