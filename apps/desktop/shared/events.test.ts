import { describe, expect, it } from 'vitest'
import { describeRule, type EventAutomation, hookEnv, isEventName, matchesRule } from './events.ts'

const crash = (app: string) => ({ name: 'crash' as const, at: Date.parse('2026-10-06T07:00:00Z'), detail: { app, pid: '42' } })

describe('event rules', () => {
  const rule: EventAutomation = { event: 'crash', jobId: 'job1', enabled: true, match: { app: 'safari' } }

  it('matches the event and its details, case-insensitively', () => {
    expect(matchesRule(rule, crash('Safari'))).toBe(true)
    expect(matchesRule(rule, crash('Safari Technology Preview'))).toBe(true)
    expect(matchesRule(rule, crash('Mail'))).toBe(false)
    expect(matchesRule({ ...rule, match: undefined }, crash('Mail'))).toBe(true)
  })

  it('ignores rules that are off or wait for another event', () => {
    expect(matchesRule({ ...rule, enabled: false }, crash('Safari'))).toBe(false)
    expect(matchesRule({ ...rule, event: 'login' }, crash('Safari'))).toBe(false)
  })

  it('reads like a sentence', () => {
    expect(describeRule(rule)).toBe('When a program crashes (safari)')
    expect(describeRule({ event: 'login' })).toBe('When I log in')
    expect(isEventName('battery-low')).toBe(true)
    expect(isEventName('reboot')).toBe(false)
  })
})

describe('hookEnv', () => {
  it('gives hooks the event, its time, its JSON and each detail', () => {
    const env = hookEnv({ name: 'network-change', at: Date.parse('2026-10-06T07:00:00Z'), detail: { online: 'true', wifi: 'Home 5G', 'away-minutes': '3' } })

    expect(env.JAROD_EVENT).toBe('network-change')
    expect(env.JAROD_EVENT_AT).toBe('2026-10-06T07:00:00.000Z')
    expect(env.JAROD_EVENT_WIFI).toBe('Home 5G')
    expect(env.JAROD_EVENT_AWAY_MINUTES).toBe('3')
    expect(JSON.parse(env.JAROD_EVENT_JSON).detail.online).toBe('true')
  })

  it('still sets the older HERALD_EVENT names, with the same values, for hooks written before the rename', () => {
    const env = hookEnv({ name: 'network-change', at: Date.parse('2026-10-06T07:00:00Z'), detail: { wifi: 'Home 5G' } })

    for (const suffix of ['', '_AT', '_JSON', '_WIFI']) {
      expect(env[`HERALD_EVENT${suffix}`], suffix).toBe(env[`JAROD_EVENT${suffix}`])
    }
    expect(Object.keys(env).filter(k => !k.startsWith('JAROD_EVENT') && !k.startsWith('HERALD_EVENT'))).toEqual([])
  })
})
