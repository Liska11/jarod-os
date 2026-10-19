import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { bridgeLinkPlan, ensureBridgePlugin } from './bridge-plugin.ts'

const bundled = '/Applications/Jarod-OS.app/Contents/Resources/herald-os-bridge'

/** A stand-in for the `hermes` command: node, logging its arguments to `calls` and exiting with `code`. */
function fakeHermes(calls: string, code = 0): string[] {
  return [process.execPath, '-e', `require('fs').appendFileSync(${JSON.stringify(calls)}, process.argv.slice(1).join(' ') + '\\n'); process.exit(${code})`]
}

describe('bridgeLinkPlan', () => {
  it('links a missing plugin and keeps what the person set up', () => {
    expect(bridgeLinkPlan({ kind: 'missing' }, bundled)).toBe('create')
    expect(bridgeLinkPlan({ kind: 'folder' }, bundled)).toBe('keep')
    expect(bridgeLinkPlan({ kind: 'link', target: bundled, exists: true }, bundled)).toBe('keep')
    // A checkout's link, from npm run bootstrap.
    expect(bridgeLinkPlan({ kind: 'link', target: '/Users/sam/Herald-OS/plugins/herald-os-bridge', exists: true }, bundled)).toBe('keep')
  })

  it('moves a link that leads nowhere or into another copy of the app', () => {
    expect(bridgeLinkPlan({ kind: 'link', target: '/Users/sam/old/plugins/herald-os-bridge', exists: false }, bundled)).toBe('replace')
    const translocated = '/private/var/folders/x/AppTranslocation/1/d/Jarod-OS.app/Contents/Resources/herald-os-bridge'
    expect(bridgeLinkPlan({ kind: 'link', target: translocated, exists: true }, bundled)).toBe('replace')
    // Windows: the per-user install folder of an earlier or moved copy.
    expect(bridgeLinkPlan({ kind: 'link', target: 'C:\\Users\\sam\\AppData\\Local\\Programs\\Jarod-OS\\resources\\herald-os-bridge', exists: true }, bundled)).toBe('replace')
    // …and the folder the app had before it was renamed (an install of Herald OS, or of this app under its old name).
    expect(bridgeLinkPlan({ kind: 'link', target: 'C:\\Users\\sam\\AppData\\Local\\Programs\\Herald OS\\resources\\herald-os-bridge', exists: true }, bundled)).toBe('replace')
  })
})

describe('ensureBridgePlugin', () => {
  const saved = process.env.HERMES_HOME
  let root = ''

  afterEach(() => {
    process.env.HERMES_HOME = saved
    fs.rmSync(root, { recursive: true, force: true })
  })

  it("links the app's copy into the Hermes home and enables it once", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-'))
    const resources = path.join(root, 'Jarod-OS.app', 'Contents', 'Resources')
    fs.mkdirSync(path.join(resources, 'herald-os-bridge'), { recursive: true })
    fs.writeFileSync(path.join(resources, 'herald-os-bridge', 'plugin.yaml'), 'name: herald-os-bridge\n')
    process.env.HERMES_HOME = path.join(root, 'hermes')
    const calls = path.join(root, 'calls.txt')
    const runtime = { kind: 'path' as const, label: 'test', command: fakeHermes(calls) }

    await ensureBridgePlugin(runtime, resources)
    const link = path.join(root, 'hermes', 'plugins', 'jarod-os-bridge')
    // Node resolves a junction's target with a trailing separator on Windows.
    expect(path.resolve(fs.readlinkSync(link))).toBe(path.join(resources, 'herald-os-bridge'))
    // The plugin under its Jarod-OS name; the toolset keeps its id (shared with Linux and with saved "always allow" rules).
    expect(fs.readFileSync(calls, 'utf8').trim().split('\n')).toEqual([
      'plugins enable jarod-os-bridge',
      'tools enable herald_os',
      'config set tools.tool_search.enabled off'
    ])

    // Already linked: nothing to do, and Hermes is not asked again.
    await ensureBridgePlugin(runtime, resources)
    expect(fs.readFileSync(calls, 'utf8').trim().split('\n')).toHaveLength(3)
  })

  it('tries the enabling again on the next start when Hermes failed', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-'))
    const resources = path.join(root, 'Jarod-OS.app', 'Contents', 'Resources')
    fs.mkdirSync(path.join(resources, 'herald-os-bridge'), { recursive: true })
    fs.writeFileSync(path.join(resources, 'herald-os-bridge', 'plugin.yaml'), 'name: herald-os-bridge\n')
    process.env.HERMES_HOME = path.join(root, 'hermes')
    const calls = path.join(root, 'calls.txt')
    const failing = { kind: 'path' as const, label: 'test', command: fakeHermes(calls, 1) }

    await ensureBridgePlugin(failing, resources)
    await ensureBridgePlugin(failing, resources)
    // It stops at the first failure, and the second start tries again.
    expect(fs.readFileSync(calls, 'utf8').trim().split('\n')).toEqual(['plugins enable jarod-os-bridge', 'plugins enable jarod-os-bridge'])
    expect(fs.existsSync(path.join(root, 'hermes', 'jarod-os', 'jarod-os-bridge-enabled'))).toBe(false)
  })

  describe('the link under its name before the Jarod-OS rename (phase 5)', () => {
    /** An app with its bundled copy, a fake Hermes, and an older `plugins/herald-os-bridge` set up by `make`. */
    async function start(make: (legacy: string) => void) {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-'))
      const resources = path.join(root, 'Jarod-OS.app', 'Contents', 'Resources')
      fs.mkdirSync(path.join(resources, 'herald-os-bridge'), { recursive: true })
      fs.writeFileSync(path.join(resources, 'herald-os-bridge', 'plugin.yaml'), 'name: jarod-os-bridge\n')
      process.env.HERMES_HOME = path.join(root, 'hermes')
      const legacy = path.join(root, 'hermes', 'plugins', 'herald-os-bridge')
      fs.mkdirSync(path.dirname(legacy), { recursive: true })
      make(legacy)
      const calls = path.join(root, 'calls.txt')
      await ensureBridgePlugin({ kind: 'path' as const, label: 'test', command: fakeHermes(calls) }, resources)

      return { legacy, calls }
    }

    /** A checkout of the bridge somewhere, as `bootstrap` used to link it. */
    function checkout(name: string): string {
      const dir = path.join(root, 'old-checkout', 'plugins', 'herald-os-bridge')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'plugin.yaml'), `name: ${name}\n`)

      return dir
    }

    it('removes an older link to the bridge, so Hermes does not load it twice, and leaves what it pointed at', async () => {
      let target = ''
      const { legacy } = await start(link => {
        target = checkout('herald-os-bridge')
        fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : undefined)
      })

      expect(fs.existsSync(legacy)).toBe(false)
      expect(fs.existsSync(path.join(target, 'plugin.yaml'))).toBe(true)
      expect(fs.existsSync(path.join(root, 'hermes', 'plugins', 'jarod-os-bridge'))).toBe(true)
    })

    it('removes an older link that leads nowhere', async () => {
      const { legacy } = await start(link => {
        const gone = checkout('herald-os-bridge')
        fs.symlinkSync(gone, link, process.platform === 'win32' ? 'junction' : undefined)
        fs.rmSync(gone, { recursive: true, force: true })
      })

      expect(fs.existsSync(legacy)).toBe(false)
    })

    it("keeps an older link to something that is not the bridge: it is not this app's to remove", async () => {
      const { legacy } = await start(link => {
        fs.symlinkSync(checkout('somebody-elses-plugin'), link, process.platform === 'win32' ? 'junction' : undefined)
      })

      expect(fs.lstatSync(legacy).isSymbolicLink()).toBe(true)
    })

    it("keeps an older folder of the person's own", async () => {
      const { legacy } = await start(folder => {
        fs.mkdirSync(folder)
        fs.writeFileSync(path.join(folder, 'plugin.yaml'), 'name: herald-os-bridge\n')
      })

      expect(fs.readFileSync(path.join(legacy, 'plugin.yaml'), 'utf8')).toBe('name: herald-os-bridge\n')
    })

    it('enables the renamed plugin once, even where the older one had been enabled before', async () => {
      const { calls } = await start(() => {
        // The marker of the older enabling, copied into the new folder by the phase-5 data copy.
        fs.mkdirSync(path.join(root, 'hermes', 'jarod-os'), { recursive: true })
        fs.writeFileSync(path.join(root, 'hermes', 'jarod-os', 'bridge-enabled'), '2026-10-01T00:00:00.000Z\n')
      })

      expect(fs.readFileSync(calls, 'utf8').trim().split('\n')[0]).toBe('plugins enable jarod-os-bridge')
      expect(fs.existsSync(path.join(root, 'hermes', 'jarod-os', 'jarod-os-bridge-enabled'))).toBe(true)
    })
  })

  it('does nothing without a bundled copy (development)', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-'))
    process.env.HERMES_HOME = path.join(root, 'hermes')
    await ensureBridgePlugin({ kind: 'path', label: 'test', command: [process.execPath, '-e', 'process.exit(1)'] }, path.join(root, 'none'))
    expect(fs.existsSync(path.join(root, 'hermes', 'plugins'))).toBe(false)
  })
})
