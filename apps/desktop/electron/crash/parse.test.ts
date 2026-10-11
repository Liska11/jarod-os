import { describe, expect, it } from 'vitest'
import { COREDUMP_MESSAGE_ID, CRASH_QUIET_MS, parseCoredumpEntry, parseIpsReport, parseIpsTimestamp, shouldOffer } from './parse.ts'

const header = (fields: Record<string, unknown>) => JSON.stringify({ app_name: 'Safari', name: 'Safari', bug_type: '309', incident_id: 'ABC-123', timestamp: '2026-10-06 14:22:05.00 +1100', ...fields })
const body = JSON.stringify({ pid: 4242, procName: 'Safari', procPath: '/Applications/Safari.app/Contents/MacOS/Safari', exception: { type: 'EXC_BAD_ACCESS', signal: 'SIGSEGV' } }, null, 2)

describe('parseIpsReport', () => {
  it('reads the app, pid, exception and time from a crash report', () => {
    expect(parseIpsReport('Safari-2026-10-06-142205.ips', `${header({})}\n${body}`)).toEqual({
      id: 'ips:ABC-123',
      app: 'Safari',
      pid: 4242,
      exe: '/Applications/Safari.app/Contents/MacOS/Safari',
      reason: 'EXC_BAD_ACCESS (SIGSEGV)',
      at: Date.parse('2026-10-06T14:22:05.000+11:00'),
      source: 'macos'
    })
  })

  it('ignores hangs, resource reports and other file types', () => {
    expect(parseIpsReport('Safari.ips', `${header({ bug_type: '288' })}\n${body}`)).toBeNull()
    expect(parseIpsReport('JetsamEvent-2026-10-06.ips', `${header({})}\n${body}`)).toBeNull()
    expect(parseIpsReport('Safari.diag', `${header({})}\n${body}`)).toBeNull()
    expect(parseIpsReport('Safari.ips', 'not json')).toBeNull()
  })

  it('still names the program when only the header is readable', () => {
    const report = parseIpsReport('Notes.ips', header({ app_name: 'Notes', name: 'Notes' }), 1000)

    expect(report?.app).toBe('Notes')
    expect(report?.pid).toBeUndefined()
  })
})

describe('parseIpsTimestamp', () => {
  it('handles the offset and any number of fractional digits', () => {
    expect(parseIpsTimestamp('2026-10-06 14:22:05.1234 -0500')).toBe(Date.parse('2026-10-06T14:22:05.123-05:00'))
    expect(parseIpsTimestamp('2026-10-06 14:22:05 +0000')).toBe(Date.parse('2026-10-06T14:22:05.000Z'))
    expect(parseIpsTimestamp('yesterday')).toBeNull()
  })
})

describe('parseCoredumpEntry', () => {
  const entry = (fields: Record<string, string>) =>
    JSON.stringify({ MESSAGE_ID: COREDUMP_MESSAGE_ID, COREDUMP_PID: '777', COREDUMP_UID: '1000', COREDUMP_COMM: 'firefox', COREDUMP_EXE: '/usr/lib64/firefox/firefox', COREDUMP_SIGNAL_NAME: 'SIGSEGV', COREDUMP_TIMESTAMP: '1791100000000000', ...fields })

  it('reads one of our own core dumps', () => {
    expect(parseCoredumpEntry(entry({}), 1000)).toEqual({
      id: 'coredump:777:1791100000000000',
      app: 'firefox',
      pid: 777,
      exe: '/usr/lib64/firefox/firefox',
      reason: 'SIGSEGV',
      at: 1791100000000,
      source: 'coredump'
    })
  })

  it("skips other users' crashes and other journal entries", () => {
    expect(parseCoredumpEntry(entry({ COREDUMP_UID: '0' }), 1000)).toBeNull()
    expect(parseCoredumpEntry(JSON.stringify({ MESSAGE_ID: 'other', COREDUMP_COMM: 'x' }), 1000)).toBeNull()
    expect(parseCoredumpEntry('{broken', 1000)).toBeNull()
  })

  it('prefers the package name and falls back to the signal number', () => {
    const report = parseCoredumpEntry(entry({ COREDUMP_PACKAGE_NAME: 'Firefox', COREDUMP_SIGNAL_NAME: '', COREDUMP_SIGNAL: '6' }), null)

    expect(report?.app).toBe('Firefox')
    expect(report?.reason).toBe('signal 6')
  })
})

describe('shouldOffer', () => {
  const report = { id: '1', app: 'Firefox', pid: 10, exe: '/usr/bin/firefox', at: 0, source: 'coredump' as const }
  const base = { muted: [], ownPids: [], lastNotified: new Map<string, number>(), now: 1_000_000 }

  it('offers once per program per quiet window', () => {
    expect(shouldOffer(report, base)).toBe(true)
    expect(shouldOffer(report, { ...base, lastNotified: new Map([['firefox', base.now - 1000]]) })).toBe(false)
    expect(shouldOffer(report, { ...base, lastNotified: new Map([['firefox', base.now - CRASH_QUIET_MS]]) })).toBe(true)
  })

  it('stays quiet for muted programs, Jarod-OS itself and the Hermes backend', () => {
    expect(shouldOffer(report, { ...base, muted: ['firefox'] })).toBe(false)
    expect(shouldOffer(report, { ...base, muted: ['/usr/bin/firefox'] })).toBe(false)
    expect(shouldOffer({ ...report, app: 'Jarod-OS Helper (Renderer)' }, base)).toBe(false)
    expect(shouldOffer(report, { ...base, ownPids: [10] })).toBe(false)
  })
})
