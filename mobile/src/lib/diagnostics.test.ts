import { describe, expect, it } from 'vitest'
import { batteryChecklist, bucketLabel, formatLatency, isOnePlus, isTailnetHost, linkMode, measureLatency, shortAddress } from './diagnostics.ts'

describe('link mode', () => {
  it('knows Tailscale addresses from LAN ones', () => {
    expect(isTailnetHost('100.64.0.1')).toBe(true)
    expect(isTailnetHost('100.127.255.254')).toBe(true)
    expect(isTailnetHost('100.63.0.1')).toBe(false)
    expect(isTailnetHost('100.128.0.1')).toBe(false)
    expect(isTailnetHost('192.168.1.20')).toBe(false)
    expect(isTailnetHost('[fd7a:115c:a1e0::1]')).toBe(true)
  })

  it('names the mode of the address that answered', () => {
    expect(linkMode('http://192.168.1.20:10492', true)).toBe('lan')
    expect(linkMode('http://100.101.102.103:10492', true)).toBe('tailscale')
    expect(linkMode('http://100.101.102.103:10492', false)).toBe('offline')
    expect(linkMode(undefined, true)).toBe('offline')
    expect(linkMode('', true)).toBe('offline')
  })

  it('shows an address without its scheme', () => {
    expect(shortAddress('http://192.168.1.20:10492/')).toBe('192.168.1.20:10492')
  })
})

describe('latency', () => {
  it('formats in ms then seconds, and a dash when unknown', () => {
    expect(formatLatency(42.4)).toBe('42 ms')
    expect(formatLatency(1530)).toBe('1.5 s')
    expect(formatLatency(null)).toBe('—')
  })

  it('times one call, and gives null when it fails', async () => {
    let t = 100
    const clock = () => t
    expect(await measureLatency(async () => void (t = 137), clock)).toBe(37)
    expect(
      await measureLatency(async () => {
        throw new Error('no')
      }, clock)
    ).toBeNull()
  })
})

describe('battery checklist', () => {
  const power = { ignoringBatteryOptimizations: true, powerSave: false, manufacturer: 'OnePlus', model: 'CPH2663', sdk: 36, standbyBucket: 10 }
  const byId = (p: Parameters<typeof batteryChecklist>[0]) => Object.fromEntries(batteryChecklist(p).map(c => [c.id, c.state]))

  it('ticks only what the app can read', () => {
    expect(byId(power)).toEqual({ optimization: 'ok', adaptive: 'ok', standby: 'unknown', autostart: 'unknown', saver: 'ok' })
  })

  it('asks for action when the phone restricts the app', () => {
    expect(byId({ ...power, ignoringBatteryOptimizations: false, powerSave: true, standbyBucket: 50 })).toMatchObject({ optimization: 'todo', adaptive: 'todo', saver: 'todo' })
    expect(byId({ ...power, standbyBucket: 40 }).adaptive).toBe('todo')
  })

  it('claims nothing it does not know', () => {
    expect(Object.values(byId(null)).every(s => s === 'unknown')).toBe(true)
    expect(byId({ ...power, standbyBucket: undefined }).adaptive).toBe('unknown')
  })

  it('labels the standby groups and spots OnePlus', () => {
    expect(bucketLabel(10)).toBe('actif')
    expect(bucketLabel(40)).toBe('rare')
    expect(bucketLabel(50)).toBe('restreint')
    expect(isOnePlus(power)).toBe(true)
    expect(isOnePlus({ ...power, manufacturer: 'samsung' })).toBe(false)
  })
})
