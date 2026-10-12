import { describe, expect, it } from 'vitest'
import { androidSummary, apiAddress, apiSummary, type ApiServerStatus, baseName, emptySsh, phoneSummary, secondsLeft, sshLine, sshProblems, timeLeftText } from './devices-model.ts'

const api = (over: Partial<ApiServerStatus> = {}): ApiServerStatus => ({ enabled: false, running: false, port: 8642, host: '127.0.0.1', keyConfigured: false, error: '', ...over })

describe('API server', () => {
  it('gives the address a client uses, and says who can reach it', () => {
    expect(apiAddress(api())).toBe('http://127.0.0.1:8642/v1')
    expect(apiAddress(api({ host: '0.0.0.0' }))).toContain('<this PC’s address>:8642')
    expect(apiSummary(api({ running: true }))).toBe('Running at http://127.0.0.1:8642/v1 — this PC only.')
    expect(apiSummary(api({ running: true, host: '0.0.0.0' }))).toMatch(/open to the local network/)
  })

  it('when off: asks for a key first, or says a key is saved; an error wins', () => {
    expect(apiSummary(api())).toMatch(/Make a key first/)
    expect(apiSummary(api({ keyConfigured: true }))).toBe('Off. A key is saved.')
    expect(apiSummary(api({ error: 'port in use', running: true }))).toBe('Could not start: port in use')
  })
})

describe('phone and android', () => {
  it('says what the bridge does and how many phones are paired', () => {
    expect(phoneSummary({ running: false, port: 1, url: '', devices: [] })).toMatch(/whole local network/)
    expect(phoneSummary({ running: true, port: 8700, url: '', devices: [{ deviceId: 'a', name: 'x', pairedAt: 0, lastSeen: 0 }] })).toBe('Listening on port 8700 · 1 paired phone')
    expect(phoneSummary({ running: true, port: 8700, url: '', devices: [] })).toBe('Listening on port 8700 · 0 paired phones')
    expect(androidSummary({ state: 'ready', adb: 'C:\\adb.exe', configured: '', devices: [] })).toBe('adb found (C:\\adb.exe) · 0 devices connected')
    expect(androidSummary({ state: 'missing', adb: null, configured: 'x', devices: [] })).toMatch(/missing/)
    expect(androidSummary({ state: 'unconfigured', adb: null, configured: '', devices: [] })).toMatch(/No adb found/)
  })

  it('a pairing code counts down to expired', () => {
    expect(secondsLeft(10_000, 4_000)).toBe(6)
    expect(secondsLeft(1000, 5000)).toBe(0)
    expect(timeLeftText(125)).toBe('2 min 5 s')
    expect(timeLeftText(42)).toBe('42 s')
    expect(timeLeftText(0)).toBe('expired')
  })
})

describe('SSH hosts', () => {
  const ok = { ...emptySsh(), name: 'box', host: 'box.lan', username: 'san', keyPath: 'C:\\k\\id' }

  it('a complete declaration is fine', () => {
    expect(sshProblems(ok, [])).toEqual([])
  })

  it('names each problem: name, duplicate, host, user, port, key', () => {
    expect(sshProblems(emptySsh(), [])).toEqual(['Name: required.', 'Host: a name or address, without spaces.', 'User: required, without spaces.', 'Key: choose the private key file.'])
    expect(sshProblems(ok, ['box'])).toEqual(['A host called “box” already exists.'])
    expect(sshProblems({ ...ok, host: 'a b' }, [])).toEqual(['Host: a name or address, without spaces.'])
    for (const port of ['0', '65536', '22x', '']) expect(sshProblems({ ...ok, port }, []), port).toEqual(['Port: 1 to 65535.'])
  })

  it('shows user@host with the port only when it is not 22; key names without their folder', () => {
    expect(sshLine({ id: '1', name: 'a', host: 'h', username: 'u', port: 22, keyPath: '' })).toBe('u@h')
    expect(sshLine({ id: '1', name: 'a', host: 'h', username: 'u', port: 2222, keyPath: '' })).toBe('u@h:2222')
    expect(baseName('C:\\Users\\San\\.ssh\\id_ed25519')).toBe('id_ed25519')
    expect(baseName('/home/san/.ssh/id')).toBe('id')
    expect(baseName('id')).toBe('id')
  })
})
