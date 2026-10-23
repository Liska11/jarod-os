import { execFile, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parse } from './memory-store.ts'

/*
 * V-20 (upstream #140): separate processes writing MEMORY.md back to back — Jarod-OS processes running the real memory store
 * (memory-race.worker.ts) and Python writers taking Hermes's lock (memory-race.writer.py, through Hermes's own MemoryStore when the
 * upstream checkout can be imported). No entry may go missing. Runs on Windows (msvcrt) as on Linux (flock); skipped without Python.
 */

const WORKER = fileURLToPath(new URL('./memory-race.worker.ts', import.meta.url))
const WRITER = fileURLToPath(new URL('./memory-race.writer.py', import.meta.url))
const HERMES_CHECKOUT = fileURLToPath(new URL('../../../../../upstream/hermes-agent', import.meta.url))
const COUNT = 40
const PY = process.platform === 'win32' ? 'python' : 'python3'

const hasPython = (() => {
  try {
    execFileSync(PY, ['-c', 'import sys'], { stdio: 'ignore' })

    return true
  } catch {
    return false
  }
})()

/**
 * Hermes's own MemoryStore: the Hermes installed on this computer with its venv when there is one (its real code and dependencies),
 * else the upstream checkout with the system Python. HERMES_HOME always points at the test's throwaway folder.
 */
const installed = path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'hermes', 'hermes-agent')
const hermesStore = (() => {
  const candidates: [string, string][] = [
    [path.join(installed, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'), installed],
    [PY, HERMES_CHECKOUT]
  ]

  for (const [python, checkout] of candidates) {
    if (!hasPython || !fs.existsSync(path.join(checkout, 'tools', 'memory_tool_store.py'))) {
      continue
    }

    try {
      execFileSync(python, ['-c', 'import sys; sys.path.insert(0, sys.argv[1]); from tools.memory_tool_store import MemoryStore', checkout], {
        stdio: 'ignore',
        timeout: 60_000,
        env: { ...process.env, HERMES_HOME: os.tmpdir() }
      })

      return { python, checkout }
    } catch {
      // Next candidate.
    }
  }

  return null
})()

let home: string

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'jarod-race-'))
})

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true })
})

const run = (command: string, args: string[]) =>
  new Promise<string>((resolve, reject) => {
    execFile(command, args, { env: { ...process.env, HERMES_HOME: home }, timeout: 90_000 }, (error, stdout, stderr) => (error ? reject(new Error(`${error.message}\n${stderr}`)) : resolve(stdout)))
  })

const jarod = async (prefix: string, mode: 'lock' | 'nolock' = 'lock') => {
  const { errors } = JSON.parse(await run(process.execPath, ['--experimental-strip-types', '--no-warnings', WORKER, home, prefix, String(COUNT), mode, PY])) as { errors: string[] }

  expect(errors).toEqual([])
}

const expected = (...prefixes: string[]) => prefixes.flatMap(prefix => Array.from({ length: COUNT }, (_, i) => `${prefix}-${i}`)).sort()
const onDisk = () => parse(fs.readFileSync(path.join(home, 'memories', 'MEMORY.md'), 'utf8')).sort()

describe.skipIf(!hasPython)('MEMORY.md written from several processes at once', () => {
  it('loses nothing between two Jarod-OS processes', async () => {
    await Promise.all([jarod('a'), jarod('b')])

    expect(onDisk()).toEqual(expected('a', 'b'))
  }, 120_000)

  it('loses nothing between Jarod-OS and a Python writer holding the lock as Hermes does', async () => {
    await Promise.all([jarod('a'), run(PY, [WRITER, 'h', String(COUNT)])])

    expect(onDisk()).toEqual(expected('a', 'h'))
  }, 120_000)

  it.skipIf(!hermesStore)("loses nothing between Jarod-OS and Hermes's own MemoryStore", async () => {
    await Promise.all([jarod('a'), run(hermesStore!.python, [WRITER, 'h', String(COUNT), hermesStore!.checkout])])

    expect(onDisk()).toEqual(expected('a', 'h'))
  }, 120_000)
})
