import dgram from 'node:dgram'
import dns from 'node:dns'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CAUTIOUS_POLICY, decideHost, DEFAULT_POLICY, isLoopback, type NetworkPolicy, OFFLINE_CODE, parsePolicy } from '../shared/network-policy.ts'
import { connectTarget, cutDisallowed, installSocketGuard, sendTarget, uninstallSocketGuard } from './net-guard.ts'
import { DEAD_PROXY, NetworkPolicyService, type NetworkSessions, type ProxyChoice, proxyFor } from './network.ts'

const off: NetworkPolicy = { ...DEFAULT_POLICY, internet: false }

describe('the policy file', () => {
  it('reads no file as the default (Internet on), and anything malformed as Internet off', () => {
    expect(parsePolicy(null)).toEqual(DEFAULT_POLICY)
    expect(parsePolicy('{')).toEqual(CAUTIOUS_POLICY)
    expect(parsePolicy('{"version":2,"internet":true}')).toEqual(CAUTIOUS_POLICY)
    expect(parsePolicy('{"version":1,"internet":"yes"}')).toEqual(CAUTIOUS_POLICY)
    expect(parsePolicy('[]')).toEqual(CAUTIOUS_POLICY)
  })

  it('keeps only valid remote hosts, in lower case, without duplicates', () => {
    const policy = parsePolicy(JSON.stringify({ version: 1, internet: false, remoteMachines: true, remoteHosts: ['100.64.0.7', 'PC-Bureau.tail1234.ts.net', 'bad host', 3, '100.64.0.7'] }))

    expect(policy.remoteHosts).toEqual(['100.64.0.7', 'pc-bureau.tail1234.ts.net'])
    expect(policy.remoteMachines).toBe(true)
    expect(policy.localCommands).toBe(false)
  })
})

describe('which hosts Jarod may reach', () => {
  it('always allows this machine', () => {
    for (const host of ['localhost', 'app.localhost', '127.0.0.1', '127.8.9.10', '::1', '[::1]', '::ffff:127.0.0.1', 'LOCALHOST.']) {
      expect(isLoopback(host), host).toBe(true)
      expect(decideHost(off, host), host).toBe('loopback')
    }
  })

  it('blocks the Internet and the local network alike when the Internet is off', () => {
    for (const host of ['example.com', '8.8.8.8', '192.168.1.20', '10.0.0.5', '100.64.0.7', 'pc-bureau', '128.0.0.1']) {
      expect(decideHost(off, host), host).toBe('blocked')
    }
  })

  it('lets through only the configured remote machines, and only while that exception is on', () => {
    const remote: NetworkPolicy = { ...off, remoteMachines: true, remoteHosts: ['100.64.0.7'] }

    expect(decideHost(remote, '100.64.0.7')).toBe('remote')
    expect(decideHost(remote, '100.64.0.8')).toBe('blocked')
    expect(decideHost({ ...remote, remoteMachines: false }, '100.64.0.7')).toBe('blocked')
  })
})

describe('web sessions', () => {
  it('use the system proxy when online, and a proxy that leads nowhere when offline', () => {
    expect(proxyFor(DEFAULT_POLICY)).toEqual({ mode: 'system' })
    expect(proxyFor(off)).toEqual({ mode: 'fixed_servers', proxyRules: DEAD_PROXY, proxyBypassRules: '' })
    expect(proxyFor({ ...off, remoteMachines: true, remoteHosts: ['100.64.0.7', 'pc.ts.net'] }).proxyBypassRules).toBe('100.64.0.7;pc.ts.net')
  })
})

describe('the policy service', () => {
  const dirs: string[] = []
  const temp = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarod-net-'))
    dirs.push(dir)

    return dir
  }

  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
  })

  it('writes the default on a first start, so the core finds a file', () => {
    const dir = temp()
    const service = new NetworkPolicyService(dir)

    expect(service.load().internet).toBe(true)
    expect(JSON.parse(fs.readFileSync(service.file, 'utf8'))).toEqual(DEFAULT_POLICY)
  })

  it('reads a corrupt file as offline and does not overwrite it', () => {
    const dir = temp()
    fs.writeFileSync(path.join(dir, 'network-policy.json'), 'garbage')
    const service = new NetworkPolicyService(dir)

    expect(service.load().internet).toBe(false)
    expect(fs.readFileSync(service.file, 'utf8')).toBe('garbage')
  })

  it('persists a change, applies it to the sessions (cutting open connections when going offline) and survives a restart', async () => {
    const dir = temp()
    const service = new NetworkPolicyService(dir)
    service.load()
    const applied: Array<{ choice: ProxyChoice; cut: boolean }> = []
    const sessions: NetworkSessions = { apply: async (choice, cut) => void applied.push({ choice, cut }) }
    await service.attach(sessions)
    const seen: boolean[] = []
    service.onChange(policy => seen.push(policy.internet))

    await service.set({ internet: false })

    expect(applied.at(-1)).toEqual({ choice: proxyFor(off), cut: true })
    expect(seen).toEqual([false])
    expect(new NetworkPolicyService(dir).load().internet).toBe(false)
  })

  it('refuses unknown keys, wrong types and bad hosts, and changes nothing then', async () => {
    const service = new NetworkPolicyService(temp())
    service.load()

    await expect(service.set({ internet: 'no' } as never)).rejects.toThrow()
    await expect(service.set({ proxy: 'x' } as never)).rejects.toThrow(/inconnu/)
    await expect(service.set({ remoteHosts: ['a b'] })).rejects.toThrow(/invalide/)
    expect(service.get()).toEqual(DEFAULT_POLICY)
  })

  it('answers the launch checks with an OfflineError while the Internet is off', async () => {
    const service = new NetworkPolicyService(temp())
    service.load()
    await service.set({ internet: false })

    expect(() => service.assertInternet('winget')).toThrow(expect.objectContaining({ code: OFFLINE_CODE }))
    expect(() => service.assertUrl('https://nodejs.org/dist/index.json', 'Node')).toThrow(expect.objectContaining({ code: OFFLINE_CODE }))
    expect(() => service.assertUrl('http://127.0.0.1:5180/', 'local')).not.toThrow()
  })
})

describe('the socket guard', () => {
  afterEach(() => uninstallSocketGuard())

  it('finds the target of every form of connect', () => {
    expect(connectTarget([{ host: 'example.com', port: 443 }])).toBe('example.com')
    expect(connectTarget([[{ host: '8.8.8.8', port: 53 }, null]])).toBe('8.8.8.8')
    expect(connectTarget([80, 'example.org'])).toBe('example.org')
    expect(connectTarget(['8080'])).toBe('localhost')
    expect(connectTarget([{ port: 80 }])).toBe('localhost')
    expect(connectTarget(['\\\\.\\pipe\\jarod'])).toBeNull()
    expect(connectTarget([{ path: '/tmp/s.sock' }])).toBeNull()
  })

  it('lets a loopback connection through and fails a refused one before it is attempted', async () => {
    const asked: string[] = []
    installSocketGuard(host => {
      asked.push(host)

      return decideHost(off, host) !== 'blocked'
    })
    const server = net.createServer(socket => socket.end('hi'))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as net.AddressInfo).port

    const reply = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1')
      let text = ''
      socket.on('data', data => (text += data))
      socket.on('end', () => resolve(text))
      socket.on('error', reject)
    })
    server.close()

    expect(reply).toBe('hi')

    // TEST-NET-3: never routed. The guard answers at once, with the offline code.
    const error = await new Promise<NodeJS.ErrnoException>(resolve => {
      const socket = net.connect({ host: '203.0.113.9', port: 443 })
      socket.on('error', resolve)
      socket.on('connect', () => resolve(new Error('connected') as NodeJS.ErrnoException))
    })

    expect(error.code).toBe(OFFLINE_CODE)
    // Since V-05 the resolver asks too (Node looks the loopback address up before connecting): the same host, allowed twice.
    expect(new Set(asked)).toEqual(new Set(['127.0.0.1', '203.0.113.9']))
  })

  it('stops Node fetch too', async () => {
    installSocketGuard(host => decideHost(off, host) !== 'blocked')

    const failure = await fetch('http://203.0.113.9/', { signal: AbortSignal.timeout(5000) }).catch((error: Error & { cause?: { code?: string } }) => error)

    expect((failure as Error & { cause?: { code?: string } }).cause?.code).toBe(OFFLINE_CODE)
  })

  // A non-loopback address of this machine plays the remote host: allowed first, then the policy changes and the open connection is cut.
  const lan = Object.values(os.networkInterfaces())
    .flat()
    .find(entry => entry && entry.family === 'IPv4' && !entry.internal)?.address

  it.runIf(Boolean(lan))('cuts a connection that was open before the switch went off', async () => {
    let online = true
    installSocketGuard(() => online)
    const server = net.createServer(() => undefined)
    await new Promise<void>(resolve => server.listen(0, '0.0.0.0', resolve))
    const port = (server.address() as net.AddressInfo).port
    const socket = net.connect(port, lan as string)
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve())
      socket.once('error', reject)
    })
    const closed = new Promise<NodeJS.ErrnoException>(resolve => socket.once('error', resolve))

    online = false
    expect(cutDisallowed(() => online)).toBe(1)
    expect((await closed).code).toBe(OFFLINE_CODE)
    server.close()
  })
})


// V-05: a direct resolver call and a UDP packet used to leave (measured on 2026-10-23). Nothing here leaves the machine: a refusal
// never reaches the network, and what is allowed targets loopback.
describe('the DNS and UDP guard (V-05)', () => {
  afterEach(() => uninstallSocketGuard())

  const codeOf = (p: Promise<unknown>) => p.then(() => 'resolved', (e: NodeJS.ErrnoException) => e.code)

  it('with the Internet off, a direct name lookup is refused (callback, promise, Resolver); loopback resolves', async () => {
    installSocketGuard(host => decideHost(off, host) !== 'blocked')
    const viaCallback = await new Promise(resolve => dns.lookup('example.com', e => resolve(e ? (e as NodeJS.ErrnoException).code : 'resolved')))
    expect(viaCallback).toBe(OFFLINE_CODE)
    expect(await codeOf(dns.promises.resolveTxt('exfil.example.com'))).toBe(OFFLINE_CODE)
    expect(await codeOf(new dns.promises.Resolver().resolve4('example.com'))).toBe(OFFLINE_CODE)
    expect(await codeOf(dns.promises.lookup('localhost'))).toBe('resolved')
  })

  it('with the Internet off, a UDP packet off the machine is refused, by callback or by event; to loopback it arrives', async () => {
    installSocketGuard(host => decideHost(off, host) !== 'blocked')
    const out = dgram.createSocket('udp4')

    try {
      expect(await new Promise(resolve => out.send('x', 53, '1.1.1.1', e => resolve(e ? (e as NodeJS.ErrnoException).code : 'sent')))).toBe(OFFLINE_CODE)
      const viaEvent = new Promise(resolve => out.once('error', e => resolve((e as NodeJS.ErrnoException).code)))
      out.send('y', 53, '203.0.113.9')
      expect(await viaEvent).toBe(OFFLINE_CODE)
      const local = dgram.createSocket('udp4')
      await new Promise<void>(resolve => local.bind(0, '127.0.0.1', () => resolve()))
      const got = new Promise(resolve => local.once('message', m => resolve(String(m))))
      out.send('hello', local.address().port, '127.0.0.1')
      expect(await got).toBe('hello')
      local.close()
    } finally {
      out.close()
    }
  })

  it('finds the destination of every send form', () => {
    expect(sendTarget(['m', 53, '1.1.1.1', () => {}], undefined)).toBe('1.1.1.1')
    expect(sendTarget(['m', 0, 1, 53, 'example.com'], undefined)).toBe('example.com')
    expect(sendTarget(['m', () => {}], '203.0.113.9')).toBe('203.0.113.9')
    expect(sendTarget(['m', 53], undefined)).toBe('localhost')
  })
})
