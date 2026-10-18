import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { adoptLegacyLog, LOG_NAME } from './log.ts'

const made: string[] = []
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function logs(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'jarod-log-'))
  made.push(dir)

  return dir
}

describe('the log file name', () => {
  it('is named after Jarod-OS', () => {
    expect(LOG_NAME).toBe('jarod-os.log')
  })

  it('takes over the old herald-os.log and its older generation, so the history is kept', () => {
    const dir = logs()
    writeFileSync(path.join(dir, 'herald-os.log'), 'recent\n')
    writeFileSync(path.join(dir, 'herald-os.log.1'), 'older\n')

    adoptLegacyLog(dir)

    expect(readFileSync(path.join(dir, 'jarod-os.log'), 'utf8')).toBe('recent\n')
    expect(readFileSync(path.join(dir, 'jarod-os.log.1'), 'utf8')).toBe('older\n')
    expect(existsSync(path.join(dir, 'herald-os.log'))).toBe(false)
  })

  it('never overwrites a jarod-os.log that already exists', () => {
    const dir = logs()
    writeFileSync(path.join(dir, 'herald-os.log'), 'old\n')
    writeFileSync(path.join(dir, 'jarod-os.log'), 'current\n')

    adoptLegacyLog(dir)

    expect(readFileSync(path.join(dir, 'jarod-os.log'), 'utf8')).toBe('current\n')
    expect(readFileSync(path.join(dir, 'herald-os.log'), 'utf8')).toBe('old\n')
  })

  it('does nothing when there is no old log or no folder', () => {
    expect(() => adoptLegacyLog(path.join(tmpdir(), 'jarod-log-absent-folder'))).not.toThrow()
  })
})
