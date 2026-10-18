import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type BuildTools, createEnvironment, environmentVariables, isVersionRequest, listEnvironments, pickNodeRelease } from './environments.ts'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarod-env-test-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const INDEX = [
  { version: 'v24.1.0', files: ['win-x64-zip'] },
  { version: 'v22.11.0', files: ['win-x64-zip'] },
  { version: 'v22.10.0', files: ['win-x64-zip'] },
  { version: 'v20.18.0', files: ['linux-x64'] }
]

/** Stand-ins for uv, tar and the download: they leave what the real tools would. */
function fakeTools(calls: string[]): BuildTools {
  return {
    uv: 'uv',
    nodeIndex: async () => INDEX,
    download: async (url, file) => {
      calls.push(`download ${url}`)
      fs.writeFileSync(file, 'zip')
    },
    run: async (command, args) => {
      calls.push(`${path.basename(command)} ${args.join(' ')}`)

      if (command === 'uv') {
        const home = args[args.length - 1]
        fs.mkdirSync(path.join(home, 'Scripts'), { recursive: true })
        fs.writeFileSync(path.join(home, 'Scripts', 'python.exe'), '')
      }

      if (path.basename(command) === 'tar.exe') {
        expect(path.dirname(command).toLowerCase()).toMatch(/system32$/)

        const home = args[args.indexOf('-C') + 1]
        const zip = path.basename(args[args.indexOf('-xf') + 1], '.zip')
        fs.mkdirSync(path.join(home, zip), { recursive: true })
      }

      return command.endsWith('python.exe') ? 'Python 3.12.7\n' : ''
    }
  }
}

describe('environments', () => {
  it('makes a Python environment with uv and records the version it got', async () => {
    const calls: string[] = []
    const info = await createEnvironment(dir, 'site-py', 'python', '3.12', fakeTools(calls), new Date('2026-10-18T10:00:00Z'))

    expect(info).toMatchObject({ name: 'site-py', kind: 'python', requested: '3.12', version: '3.12.7' })
    expect(calls[0]).toBe(`uv venv --python 3.12 --seed ${path.join(dir, 'site-py')}`)
    expect(listEnvironments(dir).map(env => env.name)).toEqual(['site-py'])
  })

  it('unpacks the newest Node.js of the asked major version', async () => {
    const calls: string[] = []
    const info = await createEnvironment(dir, 'app-node', 'node', '22', fakeTools(calls))

    expect(info.version).toBe('22.11.0')
    expect(calls).toContain('download https://nodejs.org/dist/v22.11.0/node-v22.11.0-win-x64.zip')
    expect(fs.existsSync(path.join(dir, 'app-node', 'node'))).toBe(true)
    expect(fs.existsSync(path.join(dir, 'app-node', 'node-v22.11.0-win-x64.zip'))).toBe(false)
  })

  it('removes a failed build and lists nothing for it', async () => {
    const tools = fakeTools([])
    tools.run = async () => {
      throw new Error('uv failed: no such Python')
    }

    await expect(createEnvironment(dir, 'broken', 'python', '3.99', tools)).rejects.toThrow('no such Python')
    expect(fs.existsSync(path.join(dir, 'broken'))).toBe(false)
    expect(listEnvironments(dir)).toEqual([])
  })

  it('refuses bad names, bad versions, existing names and unknown releases', async () => {
    const tools = fakeTools([])

    await expect(createEnvironment(dir, '../x', 'python', '3.12', tools)).rejects.toThrow('bad-name')
    await expect(createEnvironment(dir, 'ok', 'python', '3.12; rm', tools)).rejects.toThrow('bad-version')
    await createEnvironment(dir, 'twice', 'python', '3.12', tools)
    await expect(createEnvironment(dir, 'twice', 'python', '3.12', tools)).rejects.toThrow('exists')
    await expect(createEnvironment(dir, 'old', 'node', '20', tools)).rejects.toThrow('no-release')
    expect(isVersionRequest('22')).toBe(true)
    expect(isVersionRequest('v22')).toBe(false)
  })

  it('picks releases by prefix, Windows builds only', () => {
    expect(pickNodeRelease(INDEX, '22.10')).toBe('22.10.0')
    expect(pickNodeRelease(INDEX, '24')).toBe('24.1.0')
    expect(pickNodeRelease(INDEX, '20')).toBeNull()
  })

  it('puts the environment first in PATH for a terminal', () => {
    const env = environmentVariables(dir, { name: 'site-py', kind: 'python', requested: '3.12', version: '3.12.7', created: '' }, { Path: 'C:\\Windows' })

    expect(env.Path?.split(path.delimiter)).toEqual([path.join(dir, 'site-py', 'Scripts'), 'C:\\Windows'])
    expect(env.VIRTUAL_ENV).toBe(path.join(dir, 'site-py'))
    expect(env.JAROD_ENVIRONMENT).toBe('site-py')
  })
})
