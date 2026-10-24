import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/*
 * V-21 — the A/B updater of the Rust host (host-rust/crates/host-updater, binary `jarod-updater`), behind a flag. Off unless
 * JAROD_HOST_UPDATER=1: with the flag off nothing here runs and Système › Mises à jour shows nothing new. The binary is found through
 * JAROD_UPDATER_BIN or on PATH, as `jarod-sandbox` is; it is not packaged yet. Every check that matters (signature, contract, hashes,
 * file set, version, trial, rollback) is the binary's; this side only finds it, runs it with an argument array (no shell) and reads its
 * one JSON line.
 */

export const FLAG = 'JAROD_HOST_UPDATER'
export const BIN_ENV = 'JAROD_UPDATER_BIN'
/** A public key made for one test. Passed on only by an unpackaged app, and a release build of the binary refuses it anyway. */
export const TEST_KEY_ENV = 'JAROD_UPDATER_TEST_KEY'
const BINARY = process.platform === 'win32' ? 'jarod-updater.exe' : 'jarod-updater'

export type UpdaterCommand = 'status' | 'verify' | 'install' | 'boot' | 'confirm' | 'rollback'

export interface SlotRecord {
  version: string
  validated: boolean
}

export interface UpdaterState {
  current: 'a' | 'b' | null
  previous: 'a' | 'b' | null
  slots: Record<string, SlotRecord>
  pending: { slot: 'a' | 'b'; activated_ms: number; boots: number } | null
  blocked: string[]
  history: { at_ms: number; event: string; version: string; detail: string }[]
}

export type UpdaterReply =
  | { ok: true; state?: UpdaterState; version?: string; entry?: string; files?: number; installed?: { slot: string; version: string }; restored?: string; trial?: boolean }
  | { ok: false; error: string; detail: string }

/** `resources/updater` of a packaged app: jarod-updater.exe, jarod-launcher.exe and contracts/v1 (scripts/bundle-updater.mjs). */
export function shippedDir(): string | null {
  const resources = (process as { resourcesPath?: string }).resourcesPath

  return resources ? path.join(resources, 'updater') : null
}

export function flagOn(env: NodeJS.ProcessEnv): boolean {
  return env[FLAG] === '1'
}

/**
 * The updater's root: the one `jarod-launcher` names when it started this copy; else the launcher's own default on Windows,
 * %LOCALAPPDATA%\Jarod-OS\updates (two copies of the app: local data, never roamed); `<config>/host-updater` in an isolated profile
 * (tests) and elsewhere.
 */
export function updaterRoot(env: NodeJS.ProcessEnv, configDir: string, platform: NodeJS.Platform = process.platform): string {
  if (env.JAROD_UPDATER_ROOT) return env.JAROD_UPDATER_ROOT
  if (platform === 'win32' && env.LOCALAPPDATA && env.JAROD_OS_ISOLATED !== '1') return path.win32.join(env.LOCALAPPDATA, 'Jarod-OS', 'updates')

  return path.join(configDir, 'host-updater')
}

/** Started by `jarod-launcher` as a version on trial: this copy must confirm its own health, once, when its core is ready. */
export function onTrial(env: NodeJS.ProcessEnv): boolean {
  return flagOn(env) && env.JAROD_UPDATER_TRIAL === '1' && Boolean(env.JAROD_UPDATER_ROOT)
}

/** JAROD_UPDATER_BIN when it names a file, else the copy shipped in the app (`resources/updater`), else the first on PATH; null when none. */
export function findBinary(env: NodeJS.ProcessEnv, exists: (file: string) => boolean = fs.existsSync, shipped: string | null = shippedDir()): string | null {
  const named = env[BIN_ENV]

  if (named) return exists(named) ? named : null
  if (shipped && exists(path.join(shipped, BINARY))) return path.join(shipped, BINARY)

  for (const dir of (env.PATH ?? env.Path ?? '').split(path.delimiter)) {
    if (!dir) continue
    const candidate = path.join(dir, BINARY)
    if (exists(candidate)) return candidate
  }

  return null
}

export interface RunOptions {
  root: string
  /** The contracts folder (`--contracts`); without it the binary reads JAROD_OS_CONTRACTS_DIR. */
  contracts?: string | null
  bundle?: string
  reason?: string
  testKey?: string | null
  timeoutMs?: number
}

/** The command line, as it will run: an argument array, never a shell line. */
export function updaterArgs(command: UpdaterCommand, options: RunOptions): string[] {
  const args = [command, '--root', options.root]

  if (options.contracts) args.push('--contracts', options.contracts)
  if (options.bundle) args.push('--bundle', options.bundle)
  if (options.reason) args.push('--reason', options.reason)
  if (options.testKey) args.push('--test-key', options.testKey)

  return args
}

/** The last non-empty stdout line, as the binary's reply; anything else is an `io` refusal that says what came out. */
export function readReply(stdout: string, stderr: string, failure: Error | null): UpdaterReply {
  const line = stdout.trim().split(/\r?\n/).pop() ?? ''

  try {
    const reply = JSON.parse(line) as UpdaterReply
    if (typeof reply === 'object' && reply !== null && typeof reply.ok === 'boolean') return reply
  } catch {
    // Not JSON: reported below.
  }

  return { ok: false, error: 'io', detail: (stderr.trim() || failure?.message || 'le programme de mise à jour n’a rien répondu').slice(0, 500) }
}

export function runUpdater(binary: string, command: UpdaterCommand, options: RunOptions): Promise<UpdaterReply> {
  return new Promise(resolve => {
    execFile(binary, updaterArgs(command, options), { windowsHide: true, timeout: options.timeoutMs ?? 15 * 60_000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) =>
      resolve(readReply(stdout, stderr, error))
    )
  })
}
