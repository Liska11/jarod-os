import { describe, expect, it } from 'vitest'
import { installCommand, installPrerequisite, interpret, isInstallable, type Runner } from './install.ts'

describe('what can be installed', () => {
  it('is a closed list: nothing else reaches a command line', () => {
    expect(['node', 'python', 'git', 'ollama', 'docker', 'pnpm', 'wsl'].every(isInstallable)).toBe(true)
    expect(isInstallable('npm')).toBe(false)
    expect(isInstallable('node & del C:\\')).toBe(false)
    expect(isInstallable({})).toBe(false)
  })

  it('uses one fixed command per tool', () => {
    expect(installCommand('node', false)).toEqual({
      command: 'winget',
      args: ['install', '--id', 'OpenJS.NodeJS.LTS', '--exact', '--source', 'winget', '--no-upgrade', '--silent', '--disable-interactivity', '--accept-package-agreements', '--accept-source-agreements']
    })
    expect(installCommand('python', true).args.slice(0, 3)).toEqual(['upgrade', '--id', 'Python.Python.3.12'])
    expect(installCommand('pnpm', false)).toEqual({ command: 'cmd.exe', args: ['/d', '/s', '/c', 'npm install -g pnpm'] })
    expect(installCommand('wsl', false).args.at(-1)).toContain('-Verb RunAs')
  })
})

describe('interpret', () => {
  it('reads winget outcomes, whatever the sign of the code', () => {
    expect(interpret('git', 0, '')).toEqual({ ok: true })
    expect(interpret('git', 0x8a150061, '')).toEqual({ ok: true, already: true })
    expect(interpret('node', -1978335189, '')).toEqual({ ok: true, already: true }) // 0x8A15002B read signed
    expect(interpret('docker', 0x8a150109, '')).toEqual({ ok: true, restart: true })
    expect(interpret('wsl', 0, '')).toEqual({ ok: true, restart: true })
    expect(interpret('git', 0x8a150014, '')).toMatchObject({ ok: false, error: 'winget does not know this package' })
  })

  it('says why an install failed, from the end of the output', () => {
    expect(interpret('python', 1603, 'Downloading…\n████\nInstaller failed with exit code: 1603\n')).toEqual({ ok: false, error: 'exit code 1603: Downloading… · Installer failed with exit code: 1603' })
    expect(interpret('docker', null, '')).toEqual({ ok: false, error: 'stopped (timeout)' })
  })
})

describe('installPrerequisite', () => {
  it('runs the command with the given environment and logs the start and the outcome', async () => {
    const seen: { command: string; path?: string }[] = []
    const log: string[] = []
    const run: Runner = async (command, env) => {
      seen.push({ command: command.command, path: env.PATH })
      return { code: 0, output: 'Successfully installed' }
    }

    const result = await installPrerequisite('git', { platform: 'win32', env: { PATH: 'C:\\fresh' }, run, log: m => log.push(m) })

    expect(result).toEqual({ ok: true })
    expect(seen).toEqual([{ command: 'winget', path: 'C:\\fresh' }])
    expect(log[0]).toMatch(/^installing git: winget install --id Git\.Git/)
    expect(log[1]).toMatch(/^git: installed \(\d+ s\)$/)
  })

  it('does nothing outside Windows', async () => {
    let ran = false
    const result = await installPrerequisite('node', { platform: 'linux', env: {}, run: async () => ((ran = true), { code: 0, output: '' }), log: () => undefined })

    expect(ran).toBe(false)
    expect(result.ok).toBe(false)
  })
})
