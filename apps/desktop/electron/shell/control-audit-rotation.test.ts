import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { controlAuditSink, type ControlAuditEntry } from './control-authz.ts'

const entry = (n: number) => ({ at: '2026-10-17T00:00:00.000Z', cmd: `cmd-${n}`, allowed: false, reason: 'x' }) as unknown as ControlAuditEntry

describe('controlAuditSink is bounded', () => {
  it('rotates to <name>.1 past its limit, keeps whole lines, and the newest line is in the live file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarod-ctl-'))
    const file = path.join(dir, 'control-audit.jsonl')
    const sink = controlAuditSink(file, 600)

    try {
      for (let n = 0; n < 40; n++) {
        sink(entry(n))
      }

      const live = fs.readFileSync(file, 'utf8')
      const old = fs.readFileSync(`${file}.1`, 'utf8')

      expect(live).toContain('cmd-39')
      expect(live.length).toBeLessThan(600 + 200)

      for (const l of (live + old).split('\n').filter(Boolean)) {
        expect(() => JSON.parse(l)).not.toThrow()
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
