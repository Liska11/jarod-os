import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { jarodDataDir, jarodSpawnPlan, jarodWorkspace, resolveJarodCore, selectBackend } from './jarod-core.ts'

const present = (...files: string[]) => (file: string) => files.includes(file)

describe('resolveJarodCore', () => {
  it('installed: the core and its own runtime sit in the resources folder', () => {
    const resources = path.join('C:', 'App', 'resources')
    const gateway = path.join(resources, 'jarod-core', 'gateway.mjs')
    const core = resolveJarodCore({ packaged: true, resourcesPath: resources, platform: 'win32', env: {}, exists: present(gateway, path.join(resources, 'jarod-core', 'node.exe')) })

    expect(core).toEqual({ dir: path.join(resources, 'jarod-core'), gateway, node: path.join(resources, 'jarod-core', 'node.exe') })
  })

  it('installed without a Node of its own: Jarod-OS’s executable runs the core in Node mode', () => {
    const resources = path.join('C:', 'App', 'resources')
    const gateway = path.join(resources, 'jarod-core', 'gateway.mjs')
    const execPath = path.join('C:', 'App', 'Jarod-OS.exe')

    expect(resolveJarodCore({ packaged: true, resourcesPath: resources, platform: 'win32', env: { JAROD_OS_NODE: 'C:\\node\\node.exe' }, exists: present(gateway), execPath })).toEqual({
      dir: path.join(resources, 'jarod-core'),
      gateway,
      node: execPath,
      runAsNode: true
    })
  })

  it('installed: the runtime is the shipped one even when PATH has another node', () => {
    const resources = path.join('/opt', 'jarod-os', 'resources')
    const core = resolveJarodCore({ packaged: true, resourcesPath: resources, platform: 'linux', env: { JAROD_OS_NODE: '/usr/bin/node' }, exists: present(path.join(resources, 'jarod-core', 'gateway.mjs'), path.join(resources, 'jarod-core', 'node')) })

    expect(core?.node).toBe(path.join(resources, 'jarod-core', 'node'))
  })

  it('development checkout: the compiled core under jarod-core/dist, run by node from PATH', () => {
    const appPath = path.join('/repo', 'apps', 'desktop')
    const gateway = path.join('/repo', 'jarod-core', 'dist', 'gateway', 'gateway.mjs')

    expect(resolveJarodCore({ packaged: false, appPath, platform: 'linux', env: {}, exists: present(gateway) })).toEqual({ dir: path.dirname(gateway), gateway, node: 'node' })
    expect(resolveJarodCore({ packaged: false, appPath, platform: 'win32', env: { JAROD_OS_NODE: 'C:\\node\\node.exe' }, exists: present(gateway) })?.node).toBe('C:\\node\\node.exe')
  })

  it('JAROD_OS_JAROD_CORE wins over the default place', () => {
    const gateway = path.join('/custom', 'gateway.mjs')
    const core = resolveJarodCore({ packaged: false, appPath: path.join('/repo', 'apps', 'desktop'), platform: 'linux', env: { JAROD_OS_JAROD_CORE: '/custom' }, exists: present(gateway) })

    expect(core?.gateway).toBe(gateway)
  })

  it('null when this build has no compiled core (the Hermes ladder takes over)', () => {
    expect(resolveJarodCore({ packaged: true, resourcesPath: '/r', env: {}, exists: () => false })).toBeNull()
    expect(resolveJarodCore({ packaged: false, appPath: '/repo/apps/desktop', env: {}, exists: () => false })).toBeNull()
  })
})

describe('selectBackend', () => {
  const core = { dir: '/c', gateway: '/c/gateway.mjs', node: 'node' }

  it('the Jarod core by default when there is one, Hermes when there is not', () => {
    expect(selectBackend({}, core)).toBe('jarod')
    expect(selectBackend({}, null)).toBe('hermes')
  })

  it('JAROD_OS_BACKEND decides when set, in any case; anything else is ignored', () => {
    expect(selectBackend({ JAROD_OS_BACKEND: 'hermes' }, core)).toBe('hermes')
    expect(selectBackend({ JAROD_OS_BACKEND: ' Jarod ' }, null)).toBe('jarod')
    expect(selectBackend({ JAROD_OS_BACKEND: 'nonsense' }, core)).toBe('jarod')
  })
})

describe('data folders', () => {
  it('Windows: %LOCALAPPDATA%\\Jarod-OS, the folder the launcher already used; JAROD_OS_DATA overrides', () => {
    expect(jarodDataDir({ LOCALAPPDATA: 'C:\\Users\\moi\\AppData\\Local' }, 'win32', 'C:\\Users\\moi')).toBe('C:\\Users\\moi\\AppData\\Local\\Jarod-OS')
    expect(jarodDataDir({}, 'win32', 'C:\\Users\\moi')).toBe('C:\\Users\\moi\\AppData\\Local\\Jarod-OS')
    expect(jarodDataDir({ JAROD_OS_DATA: 'E:\\D' }, 'win32', 'C:\\Users\\moi')).toBe('E:\\D')
  })

  it('Linux and macOS follow their conventions', () => {
    expect(jarodDataDir({}, 'linux', '/home/moi')).toBe(path.join('/home/moi', '.local', 'share', 'jarod-os'))
    expect(jarodDataDir({ XDG_DATA_HOME: '/data' }, 'linux', '/home/moi')).toBe(path.join('/data', 'jarod-os'))
    expect(jarodDataDir({}, 'darwin', '/Users/moi')).toBe(path.join('/Users/moi', 'Library', 'Application Support', 'Jarod-OS', 'core'))
  })

  it('the working folder is JAROD_WORKSPACE, else Documents/Jarod-OS', () => {
    expect(jarodWorkspace({ JAROD_WORKSPACE: 'D:\\JAROD-OS' }, 'C:\\Users\\moi')).toBe('D:\\JAROD-OS')
    expect(jarodWorkspace({}, '/home/moi')).toBe(path.join('/home/moi', 'Documents', 'Jarod-OS'))
  })
})

describe('jarodSpawnPlan', () => {
  const core = { dir: path.join('/r', 'jarod-core'), gateway: path.join('/r', 'jarod-core', 'gateway.mjs'), node: path.join('/r', 'jarod-core', 'node') }

  it('runs the shipped runtime on the core with the profile, token and working folder it was given, and stops with its input', () => {
    const plan = jarodSpawnPlan(core, { token: 'tok', dataDir: path.join('/d', 'Jarod-OS'), workspace: '/w', env: { PATH: '/bin', OPENAI_API_KEY: 'k' } })

    expect(plan.command).toBe(core.node)
    expect(plan.args).toEqual([core.gateway, '--init', '--exit-on-stdin-close', '--workspace', '/w'])
    expect(plan.cwd).toBe(core.dir)
    expect(plan.env).toMatchObject({ JAROD_HOME: path.join('/d', 'Jarod-OS', 'profile'), JAROD_GATEWAY_TOKEN: 'tok', PATH: '/bin', OPENAI_API_KEY: 'k' })
  })

  it('asks Electron to behave as Node when it is the runtime', () => {
    const plan = jarodSpawnPlan({ ...core, node: path.join('/r', 'Jarod-OS'), runAsNode: true }, { token: 'tok', dataDir: '/d', workspace: '/w', env: {} })

    expect(plan.command).toBe(path.join('/r', 'Jarod-OS'))
    expect(plan.env.ELECTRON_RUN_AS_NODE).toBe('1')
  })

  it('does not hand the core anything meant for Hermes or for Electron-as-node, nor a fixed port', () => {
    const plan = jarodSpawnPlan(core, {
      token: 'tok',
      dataDir: '/d',
      workspace: '/w',
      env: { ELECTRON_RUN_AS_NODE: '1', HERMES_DASHBOARD_SESSION_TOKEN: 'hermes-token', JAROD_GATEWAY_PORT: '9999', JAROD_GATEWAY_TOKEN: 'old' }
    })

    expect(plan.env.ELECTRON_RUN_AS_NODE).toBeUndefined()
    expect(plan.env.HERMES_DASHBOARD_SESSION_TOKEN).toBeUndefined()
    expect(plan.env.JAROD_GATEWAY_PORT).toBeUndefined()
    expect(plan.env.JAROD_GATEWAY_TOKEN).toBe('tok')
  })
})
