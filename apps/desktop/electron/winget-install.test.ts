import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { NetworkPolicyService, setActiveNetworkPolicy } from './network.ts'
import { asControlTier, type ControlAuditEntry, ControlSecurity, controlAuditSink } from './shell/control-authz.ts'
import { hostCatalogueEntries } from './shell/host-actions.ts'
import { HostControlGate } from './shell/host-control.ts'
import type { UpdateItem } from './updates-check.ts'
import {
  confirmations,
  mockSpawner,
  parseWingetResult,
  readProgress,
  realSpawner,
  runWingetUpgrade,
  targetProblem,
  upgradeThroughGate,
  WINGET_UPGRADE_ACTION,
  type WingetSpawner,
  wingetSpawner,
  wingetUpgradeArgs
} from './winget-install.ts'

// winget is never started here: every run goes through a scripted spawner that records the arguments it was given.

const created: string[] = []

afterEach(() => {
  setActiveNetworkPolicy(null as never)
  while (created.length) fs.rmSync(created.pop() as string, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarod-winget-'))

  created.push(dir)

  return dir
}

async function internet(on: boolean): Promise<NetworkPolicyService> {
  const service = new NetworkPolicyService(tempDir())

  service.load()
  setActiveNetworkPolicy(service)
  await service.set({ internet: on })

  return service
}

/** A fake winget: prints `lines`, exits with `code`, and keeps every argument array it was started with. */
function fakeWinget(lines: string[], code: number | null): { spawner: WingetSpawner; calls: string[][] } {
  const calls: string[][] = []
  const spawner: WingetSpawner = args => {
    calls.push(args)
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: () => boolean }

    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = () => true
    setImmediate(() => {
      for (const line of lines) child.stdout.write(`${line}\r\n`)
      child.stdout.end()
      setImmediate(() => child.emit('close', code))
    })

    return child as unknown as ReturnType<WingetSpawner>
  }

  return { spawner, calls }
}

const LISTED: UpdateItem[] = [
  { name: 'Git', id: 'Git.Git', current: '2.50.0', available: '2.51.0', source: 'winget', repository: 'winget', restart: false, elevation: false },
  { name: 'Store app', id: '9NBLGGH4NNS1', current: '1.0', available: '1.1', source: 'winget', repository: 'msstore', restart: false, elevation: false }
]
const GIT = { id: 'Git.Git', version: '2.51.0', source: 'winget' }

describe('the winget command', () => {
  it('is an argument array: exact id, pinned version and source, silent, agreements only once confirmed', () => {
    expect(wingetUpgradeArgs(GIT, true)).toEqual([
      'upgrade',
      '--id',
      'Git.Git',
      '--exact',
      '--version',
      '2.51.0',
      '--source',
      'winget',
      '--silent',
      '--disable-interactivity',
      '--accept-package-agreements',
      '--accept-source-agreements'
    ])
  })

  it('does not exist without a confirmation', () => {
    expect(() => wingetUpgradeArgs(GIT, false)).toThrow(/confirmée/)
    expect(() => wingetUpgradeArgs(GIT, 'yes' as unknown as boolean)).toThrow(/confirmée/)
  })

  it('refuses ids, versions and sources that are options, shell syntax or empty', () => {
    for (const id of ['--all', '-h', 'a b', 'Git.Git;calc', 'Git.Git&calc', 'Git|x', '"Git"', '$(x)', '`x`', '', 'é', 'a'.repeat(200)]) {
      expect(targetProblem({ ...GIT, id }), id).toMatch(/identifiant/)
      expect(() => wingetUpgradeArgs({ ...GIT, id }, true)).toThrow()
    }
    for (const version of ['', '--force', '1 2', 'Unknown', '1;x']) expect(targetProblem({ ...GIT, version }), version).toMatch(/version/)
    for (const source of ['', '--all', 'a b', 'x&y']) expect(targetProblem({ ...GIT, source }), source).toMatch(/source/)
    expect(targetProblem(null)).toBeTruthy()
    expect(targetProblem(GIT)).toBeNull()
  })
})

describe('the confirmation', () => {
  it('names the exact package, version and source of the last check, and the command that will run', async () => {
    await internet(true)
    const plan = confirmations().prepare(GIT, LISTED)

    expect(plan).toMatchObject({ id: 'Git.Git', version: '2.51.0', source: 'winget', name: 'Git', current: '2.50.0' })
    expect(plan.command.slice(0, 4)).toEqual(['winget', 'upgrade', '--id', 'Git.Git'])
    expect(plan.token).toMatch(/^[0-9a-f]{32}$/)
  })

  it('refuses a package the check did not list, another version, or another source', async () => {
    await internet(true)
    const pending = confirmations()

    expect(() => pending.prepare({ ...GIT, id: 'Evil.Thing' }, LISTED)).toThrow(/ne figure pas/)
    expect(() => pending.prepare({ ...GIT, version: '9.9' }, LISTED)).toThrow(/version proposée/)
    expect(() => pending.prepare({ id: '9NBLGGH4NNS1', version: '1.1', source: 'winget' }, LISTED)).toThrow(/source msstore/)
    expect(() => pending.prepare({ ...GIT, id: '--all' }, LISTED)).toThrow(/identifiant/)
  })

  it('is refused while the Internet is off, with a clear message', async () => {
    await internet(false)

    expect(() => confirmations().prepare(GIT, LISTED)).toThrow(/Internet désactivé pour Jarod : la mise à jour de Git.Git/)
  })

  it('is spent once, and expires', async () => {
    await internet(true)
    let now = 1_000
    const pending = confirmations(() => now, 1_000)
    const plan = pending.prepare(GIT, LISTED)

    expect(pending.spend(plan.token)).toEqual(GIT)
    expect(() => pending.spend(plan.token)).toThrow(/confirmez-la/)
    expect(() => pending.spend('')).toThrow(/confirmez-la/)

    const late = pending.prepare(GIT, LISTED)
    now += 2_000
    expect(() => pending.spend(late.token)).toThrow(/expiré/)
  })
})

describe('reading how winget ended', () => {
  it('tells success, restart needed, cancellation and failure apart (codes as Node reports them, signed)', () => {
    expect(parseWingetResult(0, 'Successfully installed')).toMatchObject({ outcome: 'success', exitCode: 0 })
    expect(parseWingetResult(0, 'Installé\nRedémarrez votre ordinateur pour terminer l’installation.')).toMatchObject({ outcome: 'reboot-required' })
    expect(parseWingetResult(0, 'Successfully installed. Restart the application to complete the upgrade.')).toMatchObject({ outcome: 'success' })
    expect(parseWingetResult(0x8a150109 | 0, '')).toMatchObject({ outcome: 'reboot-required', exitCode: 0x8a150109 })
    expect(parseWingetResult(0x8a15010c | 0, '')).toMatchObject({ outcome: 'cancelled', exitCode: 0x8a15010c })
    expect(parseWingetResult(0x8a150101 | 0, '')).toMatchObject({ outcome: 'failed', message: expect.stringMatching(/en cours d’utilisation/) })
    expect(parseWingetResult(0x8a150011 | 0, '')).toMatchObject({ outcome: 'failed', message: expect.stringMatching(/empreinte/) })
  })

  it('keeps the last meaningful line of an unknown failure, and says when winget is missing', () => {
    const unknown = parseWingetResult(1603, '  ██████  50%\r\nInstaller failed with exit code: 1603\r\n')

    expect(unknown).toMatchObject({ outcome: 'failed', exitCode: 1603 })
    expect(unknown.message).toMatch(/0x643.*Installer failed with exit code: 1603/)
    expect(parseWingetResult(null, '', 'spawn winget.exe ENOENT')).toMatchObject({ outcome: 'failed', message: 'winget n’est pas installé.' })
    expect(parseWingetResult(null, '')).toMatchObject({ outcome: 'failed' })
  })

  it('follows the phases and the percentage', () => {
    let progress = readProgress('Git.Git', 'Found Git [Git.Git] Version 2.51.0\r\nDownloading https://example.test/Git.exe\r\n', null)

    expect(progress).toMatchObject({ phase: 'downloading', percent: null })
    progress = readProgress('Git.Git', '  ██████▒▒▒▒  30.0 MB / 60.0 MB', progress)
    expect(progress.percent).toBe(50)
    progress = readProgress('Git.Git', 'Successfully verified installer hash', progress)
    expect(progress.phase).toBe('verifying')
    progress = readProgress('Git.Git', 'Démarrage de l’installation du package...\r\n 80%', progress)
    expect(progress).toMatchObject({ phase: 'installing', percent: 80 })
  })
})

describe('running one upgrade (winget mocked)', () => {
  it('starts winget once with the confirmed array and reports its progress', async () => {
    await internet(true)
    const winget = fakeWinget(['Downloading x', '  10 MB / 20 MB', 'Successfully installed'], 0)
    const seen: string[] = []
    const result = await runWingetUpgrade(GIT, { spawner: winget.spawner, onProgress: progress => seen.push(progress.phase) })

    expect(result.outcome).toBe('success')
    expect(winget.calls).toEqual([wingetUpgradeArgs(GIT, true)])
    expect(seen[0]).toBe('starting')
    expect(seen).toContain('downloading')
    expect(seen.at(-1)).toBe('done')
  })

  it('reports a failure without throwing, and never starts winget while offline', async () => {
    await internet(true)
    const failing = fakeWinget(['Installer failed'], 0x8a150105 | 0)

    expect(await runWingetUpgrade(GIT, { spawner: failing.spawner })).toMatchObject({ outcome: 'failed', message: 'Le disque est plein.' })

    await internet(false)
    const never = fakeWinget([], 0)

    await expect(runWingetUpgrade(GIT, { spawner: never.spawner })).rejects.toThrow(/Internet désactivé/)
    expect(never.calls).toEqual([])
  })

  it('a spawner that throws becomes a failed result', async () => {
    await internet(true)
    const result = await runWingetUpgrade(GIT, {
      spawner: () => {
        throw new Error('spawn winget.exe ENOENT')
      }
    })

    expect(result).toMatchObject({ outcome: 'failed', message: 'winget n’est pas installé.' })
  })
})

describe('through the control gate', () => {
  function door(): { gate: HostControlGate; journal: string } {
    const journal = path.join(tempDir(), 'control-audit.jsonl')
    const catalogue = hostCatalogueEntries()
    const security = new ControlSecurity({ tokens: { backend: 'backend-token-000000000001', cli: 'cli-token-00000000000001' } }, controlAuditSink(journal))

    security.setCatalogue(id => asControlTier(catalogue.find(entry => entry.id === id)?.tier))
    const gate = new HostControlGate({ security })
    gate.setCatalogue(catalogue)

    return { gate, journal }
  }

  const lines = (journal: string): ControlAuditEntry[] =>
    fs.existsSync(journal)
      ? fs
          .readFileSync(journal, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map(line => JSON.parse(line) as ControlAuditEntry)
      : []

  it('is a mutate entry of the catalogue taking exactly id, version and source', async () => {
    expect(hostCatalogueEntries().find(entry => entry.id === WINGET_UPGRADE_ACTION)).toMatchObject({ tier: 'mutate', args: [{ name: 'id' }, { name: 'version' }, { name: 'source' }] })

    const { gate } = door()
    const extra = await gate.submitLocal({ client: 'ui', command: WINGET_UPGRADE_ACTION, args: { ...GIT, all: true }, source: 'updates' })
    const plugin = await gate.submitLocal({ client: 'plugin', command: WINGET_UPGRADE_ACTION, args: GIT, source: 'plugin:x' })

    expect(extra.kind === 'reply' && extra.reply.error).toMatch(/does not take all/)
    expect(plugin.kind).toBe('reply')
  })

  it('runs a confirmed upgrade and writes one journal line', async () => {
    await internet(true)
    const { gate, journal } = door()
    const pending = confirmations()
    const winget = fakeWinget(['Successfully installed'], 0x8a150109 | 0)
    const plan = pending.prepare(GIT, LISTED)
    const reply = await upgradeThroughGate(gate, pending, plan.token, { spawner: winget.spawner })

    expect(reply).toMatchObject({ ok: true, target: GIT, result: { outcome: 'reboot-required' } })
    expect(lines(journal)).toEqual([expect.objectContaining({ client: 'ui', command: WINGET_UPGRADE_ACTION, tier: 'mutate', allowed: true, code: 'ok', source: 'updates', reason: 'Git.Git 2.51.0 (winget): reboot-required 0x8a150109' })])
  })

  it('refuses without a confirmation, before the gate and before winget', async () => {
    await internet(true)
    const { gate, journal } = door()
    const winget = fakeWinget([], 0)

    expect(await upgradeThroughGate(gate, confirmations(), 'made-up', { spawner: winget.spawner })).toMatchObject({ ok: false, error: expect.stringMatching(/confirmez-la/) })
    expect(winget.calls).toEqual([])
    expect(lines(journal)).toEqual([])
  })

  it('refuses when the Internet was turned off after the confirmation, and journals the refusal', async () => {
    const service = await internet(true)
    const { gate, journal } = door()
    const pending = confirmations()
    const winget = fakeWinget([], 0)
    const plan = pending.prepare(GIT, LISTED)

    await service.set({ internet: false })

    expect(await upgradeThroughGate(gate, pending, plan.token, { spawner: winget.spawner })).toMatchObject({ ok: false, error: expect.stringMatching(/^Internet désactivé pour Jarod/) })
    expect(winget.calls).toEqual([])
    expect(lines(journal)).toEqual([expect.objectContaining({ command: WINGET_UPGRADE_ACTION, allowed: false, code: 'denied-policy' })])
  })

  it('journals a failed upgrade as failed', async () => {
    await internet(true)
    const { gate, journal } = door()
    const pending = confirmations()
    const plan = pending.prepare(GIT, LISTED)
    const reply = await upgradeThroughGate(gate, pending, plan.token, { spawner: fakeWinget(['boom'], 0x8a15010e | 0).spawner })

    expect(reply).toMatchObject({ ok: true, result: { outcome: 'failed' } })
    expect(lines(journal)).toEqual([expect.objectContaining({ allowed: false, code: 'execution-failed' })])
  })
})

describe('the e2e winget', () => {
  it('is used only in an isolated profile, and records its arguments', async () => {
    const dir = tempDir()
    const file = path.join(dir, 'winget.json')

    fs.writeFileSync(file, JSON.stringify({ lines: ['Successfully installed'], exitCode: 0 }))
    expect(wingetSpawner({ JAROD_WINGET_MOCK: file })).toBe(realSpawner)
    expect(wingetSpawner({ JAROD_WINGET_MOCK: file, JAROD_OS_ISOLATED: '1' })).not.toBe(realSpawner)

    await internet(true)
    expect(await runWingetUpgrade(GIT, { spawner: mockSpawner(file) })).toMatchObject({ outcome: 'success' })
    expect(JSON.parse(fs.readFileSync(`${file}.args.json`, 'utf8'))).toEqual(wingetUpgradeArgs(GIT, true))
  })
})
