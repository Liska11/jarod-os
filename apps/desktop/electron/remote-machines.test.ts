import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { remoteCommand } from './ipc/terminal.ts'
import { NetworkPolicyService, setActiveNetworkPolicy } from './network.ts'
import { compareKeys, hostPattern, knownFingerprints, parseFingerprint, parseKeyscan, parseTailscale, sshTool, tcpProbe, trustHostKeys } from './remote-machines.ts'

const dirs: string[] = []
const temp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarod-remote-'))
  dirs.push(dir)

  return dir
}

afterEach(() => {
  setActiveNetworkPolicy(null as never)
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('Tailscale', () => {
  it('reads the state, itself and its peers (online first), and tells Tailscale SSH apart', () => {
    const state = parseTailscale(
      JSON.stringify({
        BackendState: 'Running',
        Self: { HostName: 'HP-Z2', TailscaleIPs: ['100.64.0.1'] },
        Peer: {
          a: { HostName: 'vieux-pc', DNSName: 'vieux-pc.tail.ts.net.', TailscaleIPs: ['100.64.0.9'], OS: 'linux', Online: false },
          b: { HostName: 'bureau', DNSName: 'bureau.tail.ts.net.', TailscaleIPs: ['100.64.0.7', 'fd7a::7'], OS: 'windows', Online: true, sshHostKeys: ['ssh-ed25519 AAAA'] }
        }
      })
    )

    expect(state.backend).toBe('Running')
    expect(state.self).toEqual({ name: 'HP-Z2', ips: ['100.64.0.1'] })
    expect(state.peers.map(p => [p.name, p.online, p.sshHostKeys, p.dnsName])).toEqual([
      ['bureau', true, true, 'bureau.tail.ts.net'],
      ['vieux-pc', false, false, 'vieux-pc.tail.ts.net']
    ])
  })

  it('reads a stopped Tailscale (no peers, no addresses) without failing', () => {
    expect(parseTailscale('{"BackendState":"NoState","Self":{"HostName":"HP-Z2","TailscaleIPs":null},"Peer":null}')).toEqual({ backend: 'NoState', self: { name: 'HP-Z2', ips: [] }, peers: [] })
  })
})

describe('host keys', () => {
  const line = (host: string) => {
    const dir = temp()
    execFileSync(sshTool('ssh-keygen'), ['-q', '-t', 'ed25519', '-N', '', '-C', 'test', '-f', path.join(dir, 'k')], { windowsHide: true })

    return `${host} ${fs.readFileSync(path.join(dir, 'k.pub'), 'utf8').trim().split(' ').slice(0, 2).join(' ')}`
  }

  it('keeps only key lines from ssh-keyscan, and reads ssh-keygen fingerprints', () => {
    expect(parseKeyscan('# 100.64.0.7:22 SSH-2.0-OpenSSH_9.6\n100.64.0.7 ssh-ed25519 AAAAC3\n\n[h]:2222 ecdsa-sha2-nistp256 AAAAE2\nnoise')).toEqual([
      { type: 'ssh-ed25519', line: '100.64.0.7 ssh-ed25519 AAAAC3' },
      { type: 'ecdsa-sha2-nistp256', line: '[h]:2222 ecdsa-sha2-nistp256 AAAAE2' }
    ])
    expect(parseFingerprint('256 SHA256:Ab+/9= 100.64.0.7 (ED25519)')).toBe('SHA256:Ab+/9=')
    expect(hostPattern('h', 22)).toBe('h')
    expect(hostPattern('h', 2222)).toBe('[h]:2222')
  })

  it('compares scanned and known keys', () => {
    const key = { type: 'ssh-ed25519', fingerprint: 'SHA256:a', line: '' }

    expect(compareKeys([], ['SHA256:a'])).toBe('unreachable')
    expect(compareKeys([key], [])).toBe('unknown')
    expect(compareKeys([key], ['SHA256:a'])).toBe('match')
    expect(compareKeys([key], ['SHA256:b'])).toBe('changed')
  })

  it.runIf(fs.existsSync(sshTool('ssh-keygen')) || process.platform !== 'win32')('trusts a new key, then replaces a changed one, keeping the other hosts', async () => {
    const file = path.join(temp(), '.ssh', 'known_hosts')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const other = line('autre-machine')
    fs.writeFileSync(file, `${other}\n`)
    const first = line('[100.64.0.7]:2222')
    const fingerprint = parseFingerprint(execFileSync(sshTool('ssh-keygen'), ['-lf', '-'], { input: `${first}\n`, windowsHide: true }).toString()) as string

    await trustHostKeys('100.64.0.7', 2222, [{ type: 'ssh-ed25519', fingerprint, line: first }], false, file)
    expect(await knownFingerprints('100.64.0.7', 2222, file)).toEqual([fingerprint])

    const second = line('[100.64.0.7]:2222')
    const changed = parseFingerprint(execFileSync(sshTool('ssh-keygen'), ['-lf', '-'], { input: `${second}\n`, windowsHide: true }).toString()) as string
    await trustHostKeys('100.64.0.7', 2222, [{ type: 'ssh-ed25519', fingerprint: changed, line: second }], true, file)

    expect(await knownFingerprints('100.64.0.7', 2222, file)).toEqual([changed])
    expect(fs.readFileSync(file, 'utf8')).toContain(other)
  })
})

describe('the network test', () => {
  it('says whether something listens, without sending anything', async () => {
    const server = net.createServer(socket => socket.destroy())
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as net.AddressInfo).port

    expect((await tcpProbe('127.0.0.1', port)).ok).toBe(true)
    server.close()
    expect((await tcpProbe('127.0.0.1', port, 2000)).ok).toBe(false)
  })
})

describe('the SSH terminal command', () => {
  it('keeps host-key checking strict and lets no option slip in through the host or the user', () => {
    const command = remoteCommand({ host: '100.64.0.7', port: 2222, user: 'san' })

    expect(command.args).toEqual(['-o', 'StrictHostKeyChecking=yes', '-p', '2222', '--', 'san@100.64.0.7'])
    expect(() => remoteCommand({ host: '-oProxyCommand=calc', port: 22, user: 'san' })).toThrow()
    expect(() => remoteCommand({ host: 'pc', port: 22, user: '-oProxyCommand=x' })).toThrow()
    expect(() => remoteCommand({ host: 'pc bureau', port: 22, user: 'san' })).toThrow()
    expect(() => remoteCommand({ host: 'pc', port: 70000, user: 'san' })).toThrow()
    expect(() => remoteCommand({ host: 'pc', port: 22, user: 'san', identity: 'C:\\nope\\id_ed25519' })).toThrow(/introuvable/)
  })

  it('follows the Internet switch: blocked offline, allowed for a listed machine with the exception on', async () => {
    const service = new NetworkPolicyService(temp())
    service.load()
    setActiveNetworkPolicy(service)
    await service.set({ internet: false, remoteHosts: ['100.64.0.7'] })

    expect(() => remoteCommand({ host: '100.64.0.7', port: 22, user: 'san' })).toThrow(/Internet désactivé/)
    await service.set({ remoteMachines: true })
    expect(() => remoteCommand({ host: '100.64.0.7', port: 22, user: 'san' })).not.toThrow()
    expect(() => remoteCommand({ host: '100.64.0.8', port: 22, user: 'san' })).toThrow(/Internet désactivé/)
  })
})
