import { describe, expect, it } from 'vitest'
import { attachTarget, foreignGateway, parseGatewayPid } from './coexist.ts'

describe('attachTarget', () => {
  it('is off unless asked for', () => {
    expect(attachTarget({})).toBeNull()
  })

  it('takes a loopback URL and a token from the environment or a file', () => {
    expect(attachTarget({ JAROD_OS_BACKEND_URL: 'http://127.0.0.1:9119/', JAROD_OS_BACKEND_TOKEN: 'secret' })).toEqual({ baseUrl: 'http://127.0.0.1:9119', token: 'secret' })
    expect(attachTarget({ JAROD_OS_BACKEND_URL: 'http://localhost:9119', JAROD_OS_BACKEND_TOKEN_FILE: '/x/token' }, file => (file === '/x/token' ? 'from-file\n' : ''))).toEqual({ baseUrl: 'http://localhost:9119', token: 'from-file' })
  })

  it('refuses anything that would send the token off the machine', () => {
    expect(() => attachTarget({ JAROD_OS_BACKEND_URL: 'http://10.0.0.5:9119', JAROD_OS_BACKEND_TOKEN: 't' })).toThrow(/this machine/)
    expect(() => attachTarget({ JAROD_OS_BACKEND_URL: 'https://127.0.0.1:9119', JAROD_OS_BACKEND_TOKEN: 't' })).toThrow(/http/)
    expect(() => attachTarget({ JAROD_OS_BACKEND_URL: 'http://127.0.0.1:9119' }, () => { throw new Error('missing') })).toThrow(/token/)
  })
})

describe('parseGatewayPid', () => {
  it('reads both formats', () => {
    expect(parseGatewayPid('{"pid": 50714, "kind": "hermes-gateway", "hermes_home": "/home/a/.hermes"}')).toEqual({ pid: 50714, home: '/home/a/.hermes' })
    expect(parseGatewayPid('1234\n')).toEqual({ pid: 1234 })
    expect(parseGatewayPid('')).toBeNull()
    expect(parseGatewayPid('{"kind": "x"}')).toBeNull()
  })
})

describe('foreignGateway', () => {
  const home = '/home/a/.hermes'
  const record = JSON.stringify({ pid: 50, hermes_home: home })
  const probe = (parent: number | null, alive = true) => ({ alive: () => alive, parentOf: () => parent, read: () => record })

  it('ignores our own gateway', () => {
    expect(foreignGateway(home, { appPid: 10, backendPid: 20 }, probe(20))).toBeNull()
    expect(foreignGateway(home, { appPid: 10, backendPid: 20 }, probe(10))).toBeNull()
  })

  it('reports one another app started', () => {
    expect(foreignGateway(home, { appPid: 10, backendPid: 20 }, probe(1))).toEqual({ pid: 50 })
  })

  it('ignores dead or other-home records', () => {
    expect(foreignGateway(home, { appPid: 10, backendPid: 20 }, probe(1, false))).toBeNull()
    expect(foreignGateway('/home/b/.hermes', { appPid: 10, backendPid: 20 }, probe(1))).toBeNull()
  })
})
