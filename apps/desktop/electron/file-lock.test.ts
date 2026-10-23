import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { lockFile } from './file-lock.ts'

/*
 * V-20 (upstream #140): the lock Hermes's memory tool takes on `MEMORY.md.lock`, taken here by the real helper and checked from a
 * second real process the way Hermes would take it (msvcrt.locking on Windows, flock elsewhere). Skipped without Python.
 */

const PY = process.platform === 'win32' ? 'python' : 'python3'

const python = (() => {
  try {
    execFileSync(PY, ['-c', 'import sys; assert sys.version_info >= (3,)'], { stdio: 'ignore' })

    return PY
  } catch {
    return null
  }
})()

/** Hermes's `_file_lock`, non-blocking: one byte with msvcrt on Windows, flock elsewhere. */
const TAKE = [
  'import os, sys',
  'fd = os.open(sys.argv[1], os.O_RDWR | os.O_CREAT)',
  'try:',
  '    import fcntl',
  '    def take():',
  '        try:',
  '            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB); return True',
  '        except BlockingIOError:',
  '            return False',
  'except ImportError:',
  '    import msvcrt',
  '    def take():',
  '        os.lseek(fd, 0, 0)',
  '        try:',
  '            msvcrt.locking(fd, msvcrt.LK_NBLCK, 1); return True',
  '        except OSError:',
  '            return False'
].join('\n')

/** Whether another process could take the lock right now. */
const freeForHermes = (lockPath: string) => execFileSync(python!, ['-c', `${TAKE}\nprint("free" if take() else "held")`, lockPath], { encoding: 'utf8' }).trim() === 'free'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarod-lock-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe.skipIf(!python)('lockFile', () => {
  const pythons = () => [python!]

  it("takes the same lock Hermes's memory tool takes, until released (twice is harmless)", async () => {
    const lockPath = path.join(dir, 'MEMORY.md.lock')
    const outcome = await lockFile(lockPath, 2000, pythons)

    expect(outcome.status).toBe('locked')
    expect(freeForHermes(lockPath)).toBe(false)

    if (outcome.status === 'locked') {
      await outcome.lock.release()
      await outcome.lock.release()
    }

    expect(freeForHermes(lockPath)).toBe(true)
  })

  it('waits for Hermes to let go, then gives up cleanly after the timeout', async () => {
    const lockPath = path.join(dir, 'USER.md.lock')
    const hermes = spawn(python!, ['-c', `${TAKE}\nimport time\nwhile not take(): time.sleep(0.005)\nprint("held", flush=True)\ntime.sleep(float(sys.argv[2]))`, lockPath, '0.8'])
    const hermesExited = new Promise(resolve => hermes.once('exit', resolve))
    await new Promise(resolve => hermes.stdout.once('data', resolve))

    const started = Date.now()

    expect(await lockFile(lockPath, 200, pythons)).toEqual({ status: 'timeout' })
    expect(Date.now() - started).toBeLessThan(5000)

    const waited = await lockFile(lockPath, 8000, pythons)

    expect(waited.status).toBe('locked')
    expect(await hermesExited).toBe(0)

    if (waited.status === 'locked') {
      await waited.lock.release()
    }
  })

  it('lets the lock go when the app holding it goes away without releasing it', async () => {
    const lockPath = path.join(dir, 'MEMORY.md.lock')
    // A real process takes the lock, then exits without releasing it: its pipe to the helper closes and the OS drops the lock.
    const script = `import { lockFile } from ${JSON.stringify(pathToFileURL(fileURLToPath(new URL('./file-lock.ts', import.meta.url))).href)}\nconst o = await lockFile(process.argv[1], 2000, () => [${JSON.stringify(python)}])\nconsole.log(o.status)\nprocess.exit(0)`
    const out = execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', script, lockPath], { encoding: 'utf8' })

    expect(out.trim()).toBe('locked')

    for (let i = 0; i < 100 && !freeForHermes(lockPath); i++) {
      await new Promise(resolve => setTimeout(resolve, 20))
    }

    expect(freeForHermes(lockPath)).toBe(true)
  })
})

describe('lockFile without Python', () => {
  it('reports the lock as unavailable rather than taken', async () => {
    expect(await lockFile(path.join(dir, 'MEMORY.md.lock'), 200, () => [])).toEqual({ status: 'unavailable', reason: 'no Python 3 interpreter found' })
    expect((await lockFile(path.join(dir, 'MEMORY.md.lock'), 200, () => [path.join(dir, 'no-python')])).status).toBe('unavailable')
  })

  it.skipIf(!python)('reports a lock file it cannot open as unavailable', async () => {
    expect((await lockFile(path.join(dir, 'missing', 'MEMORY.md.lock'), 200, () => [python!])).status).toBe('unavailable')
  })
})
