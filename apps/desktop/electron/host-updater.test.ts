import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { findBinary, flagOn, onTrial, readReply, runUpdater, updaterArgs, updaterRoot } from './host-updater.ts'

// V-21 — the shell's side of the A/B updater. The pure parts always run; the end-to-end part drives the real `jarod-updater` (a debug
// build: `cargo build -p host-updater` in host-rust, or JAROD_UPDATER_BIN) with a bundle signed in memory, and is skipped when no binary
// was built — CI has no Rust toolchain yet.

const REPO = path.resolve(__dirname, '..', '..', '..')
const DEBUG_BIN = path.join(REPO, 'host-rust', 'target', 'debug', process.platform === 'win32' ? 'jarod-updater.exe' : 'jarod-updater')
const BIN = process.env.JAROD_UPDATER_BIN ?? (fs.existsSync(DEBUG_BIN) ? DEBUG_BIN : null)
const CONTRACTS = path.join(REPO, 'contracts', 'v1')
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'jarod-host-updater-'))

afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }))

describe('the flag and the binary', () => {
  it('is off unless JAROD_HOST_UPDATER is exactly 1', () => {
    expect(flagOn({})).toBe(false)
    expect(flagOn({ JAROD_HOST_UPDATER: 'true' })).toBe(false)
    expect(flagOn({ JAROD_HOST_UPDATER: '1' })).toBe(true)
  })

  it('takes JAROD_UPDATER_BIN when it names a file, never PATH behind its back; else PATH', () => {
    // Folders without a drive letter: on Linux and macOS ':' is PATH's separator.
    const named = path.join('tools', 'jarod-updater.exe')
    const onPath = path.join('bin', process.platform === 'win32' ? 'jarod-updater.exe' : 'jarod-updater')
    const exists = (file: string) => file === named || file === onPath
    expect(findBinary({ JAROD_UPDATER_BIN: named, PATH: 'bin' }, exists)).toBe(named)
    expect(findBinary({ JAROD_UPDATER_BIN: path.join('absent.exe'), PATH: 'bin' }, exists)).toBeNull()
    expect(findBinary({ PATH: ['nothing', 'bin'].join(path.delimiter) }, exists)).toBe(onPath)
    expect(findBinary({ PATH: '' }, exists)).toBeNull()
  })

  it('finds the copy shipped in the app before PATH, never before JAROD_UPDATER_BIN', () => {
    const shipped = path.join('resources', 'updater')
    const inApp = path.join(shipped, process.platform === 'win32' ? 'jarod-updater.exe' : 'jarod-updater')
    const exists = (file: string) => file === inApp || file === path.join('bin', process.platform === 'win32' ? 'jarod-updater.exe' : 'jarod-updater')
    expect(findBinary({ PATH: 'bin' }, exists, shipped)).toBe(inApp)
    expect(findBinary({ PATH: 'bin', JAROD_UPDATER_BIN: path.join('absent.exe') }, exists, shipped)).toBeNull()
  })

  it('uses the root the launcher names, else local data on Windows, else the config folder (and always it in a test profile)', () => {
    expect(updaterRoot({ JAROD_UPDATER_ROOT: 'X', LOCALAPPDATA: 'L' }, 'C', 'win32')).toBe('X')
    expect(updaterRoot({ LOCALAPPDATA: 'L' }, 'C', 'win32')).toBe(path.win32.join('L', 'Jarod-OS', 'updates'))
    expect(updaterRoot({ LOCALAPPDATA: 'L', JAROD_OS_ISOLATED: '1' }, 'C', 'win32')).toBe(path.join('C', 'host-updater'))
    expect(updaterRoot({}, 'C', 'linux')).toBe(path.join('C', 'host-updater'))
  })

  it('is on trial only when the launcher said so, with the flag and a root', () => {
    expect(onTrial({ JAROD_HOST_UPDATER: '1', JAROD_UPDATER_TRIAL: '1', JAROD_UPDATER_ROOT: 'R' })).toBe(true)
    expect(onTrial({ JAROD_UPDATER_TRIAL: '1', JAROD_UPDATER_ROOT: 'R' })).toBe(false)
    expect(onTrial({ JAROD_HOST_UPDATER: '1', JAROD_UPDATER_TRIAL: '1' })).toBe(false)
  })

  it('builds an argument array, never a shell line', () => {
    expect(updaterArgs('rollback', { root: 'C:\\r oot', contracts: 'C:\\c', reason: 'a "b" & c' })).toEqual(['rollback', '--root', 'C:\\r oot', '--contracts', 'C:\\c', '--reason', 'a "b" & c'])
  })

  it('reads the last JSON line, and turns anything else into an io refusal', () => {
    expect(readReply('noise\n{"ok":true,"state":null}\n', '', null)).toEqual({ ok: true, state: null })
    expect(readReply('{"ok":false,"error":"untrusted","detail":"x"}', '', null)).toMatchObject({ ok: false, error: 'untrusted' })
    expect(readReply('', 'panicked', new Error('exit 101'))).toEqual({ ok: false, error: 'io', detail: 'panicked' })
    expect(readReply('[1]', '', null)).toMatchObject({ ok: false, error: 'io' })
  })
})

describe.skipIf(!BIN)('the real jarod-updater, end to end', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const testKey = path.join(scratch, 'test.pub')
  fs.writeFileSync(testKey, publicKey.export({ type: 'spki', format: 'pem' }))
  const root = path.join(scratch, 'updates')
  const base = { root, contracts: CONTRACTS, testKey }

  const bundle = (version: string, signer = privateKey): string => {
    const dir = path.join(scratch, `bundle-${version}-${Math.random().toString(36).slice(2)}`)
    const files: [string, string][] = [
      ['bin/jarod-os.exe', `host ${version}`],
      ['resources/gateway.mjs', `kernel ${version}`]
    ]
    for (const [file, text] of files) {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
      fs.writeFileSync(path.join(dir, file), text)
    }
    const manifest = Buffer.from(
      JSON.stringify({
        schema: 1,
        product: 'jarod-os',
        version,
        channel: 'stable',
        createdAt: '2026-10-24T12:00:00Z',
        entry: 'bin/jarod-os.exe',
        files: files.map(([file, text]) => ({ path: file, sha256: createHash('sha256').update(text).digest('hex'), size: Buffer.byteLength(text) }))
      })
    )
    fs.writeFileSync(path.join(dir, 'manifest.json'), manifest)
    fs.writeFileSync(path.join(dir, 'manifest.sig'), sign('sha256', manifest, signer).toString('base64'))
    return dir
  }

  it('installs, puts the second version on trial, confirms it, then rolls a third one back', async () => {
    const bin = BIN as string

    expect(await runUpdater(bin, 'status', base)).toMatchObject({ ok: true, state: { current: null } })
    expect(await runUpdater(bin, 'install', { ...base, bundle: bundle('1.0.0') })).toMatchObject({ ok: true, installed: { version: '1.0.0' }, state: { pending: null } })

    const second = bundle('1.1.0')
    expect(await runUpdater(bin, 'verify', { ...base, bundle: second })).toMatchObject({ ok: true, version: '1.1.0', files: 2 })
    const trial = await runUpdater(bin, 'install', { ...base, bundle: second })
    expect(trial).toMatchObject({ ok: true, installed: { version: '1.1.0' } })
    expect(trial.ok && trial.state?.pending?.slot).toBe(trial.ok && trial.installed?.slot)

    const confirmed = await runUpdater(bin, 'confirm', base)
    expect(confirmed.ok && confirmed.state?.pending).toBeNull()

    expect(await runUpdater(bin, 'install', { ...base, bundle: bundle('2.0.0') })).toMatchObject({ ok: true })
    expect(await runUpdater(bin, 'rollback', { ...base, reason: 'test' })).toMatchObject({ ok: true, restored: '1.1.0', state: { blocked: ['2.0.0'] } })
  })

  it('refuses a bundle signed by anyone else, and a bundle edited after signing', async () => {
    const bin = BIN as string
    const stranger = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey

    expect(await runUpdater(bin, 'verify', { ...base, bundle: bundle('9.0.0', stranger) })).toMatchObject({ ok: false, error: 'untrusted' })

    const edited = bundle('9.0.0')
    fs.writeFileSync(path.join(edited, 'bin', 'jarod-os.exe'), 'not what was signed')
    expect(await runUpdater(bin, 'verify', { ...base, bundle: edited })).toMatchObject({ ok: false, error: 'tampered' })
  })
})
