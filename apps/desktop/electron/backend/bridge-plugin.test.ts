import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { bridgeLinkPlan, ensureBridgePlugin } from './bridge-plugin.ts'

const bundled = '/Applications/Herald OS.app/Contents/Resources/herald-os-bridge'

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
    const translocated = '/private/var/folders/x/AppTranslocation/1/d/Herald OS.app/Contents/Resources/herald-os-bridge'
    expect(bridgeLinkPlan({ kind: 'link', target: translocated, exists: true }, bundled)).toBe('replace')
    // Windows: the per-user install folder of an earlier or moved copy.
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
    const resources = path.join(root, 'Herald OS.app', 'Contents', 'Resources')
    fs.mkdirSync(path.join(resources, 'herald-os-bridge'), { recursive: true })
    fs.writeFileSync(path.join(resources, 'herald-os-bridge', 'plugin.yaml'), 'name: herald-os-bridge\n')
    process.env.HERMES_HOME = path.join(root, 'hermes')
    const calls = path.join(root, 'calls.txt')
    const runtime = { kind: 'path' as const, label: 'test', command: fakeHermes(calls) }

    await ensureBridgePlugin(runtime, resources)
    const link = path.join(root, 'hermes', 'plugins', 'herald-os-bridge')
    // Node resolves a junction's target with a trailing separator on Windows.
    expect(path.resolve(fs.readlinkSync(link))).toBe(path.join(resources, 'herald-os-bridge'))
    expect(fs.readFileSync(calls, 'utf8').trim().split('\n')).toEqual([
      'plugins enable herald-os-bridge',
      'tools enable herald_os',
      'config set tools.tool_search.enabled off'
    ])

    // Already linked: nothing to do, and Hermes is not asked again.
    await ensureBridgePlugin(runtime, resources)
    expect(fs.readFileSync(calls, 'utf8').trim().split('\n')).toHaveLength(3)
  })

  it('tries the enabling again on the next start when Hermes failed', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-'))
    const resources = path.join(root, 'Herald OS.app', 'Contents', 'Resources')
    fs.mkdirSync(path.join(resources, 'herald-os-bridge'), { recursive: true })
    fs.writeFileSync(path.join(resources, 'herald-os-bridge', 'plugin.yaml'), 'name: herald-os-bridge\n')
    process.env.HERMES_HOME = path.join(root, 'hermes')
    const calls = path.join(root, 'calls.txt')
    const failing = { kind: 'path' as const, label: 'test', command: fakeHermes(calls, 1) }

    await ensureBridgePlugin(failing, resources)
    await ensureBridgePlugin(failing, resources)
    // It stops at the first failure, and the second start tries again.
    expect(fs.readFileSync(calls, 'utf8').trim().split('\n')).toEqual(['plugins enable herald-os-bridge', 'plugins enable herald-os-bridge'])
    expect(fs.existsSync(path.join(root, 'hermes', 'herald-os', 'bridge-enabled'))).toBe(false)
  })

  it('does nothing without a bundled copy (development)', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-'))
    process.env.HERMES_HOME = path.join(root, 'hermes')
    await ensureBridgePlugin({ kind: 'path', label: 'test', command: [process.execPath, '-e', 'process.exit(1)'] }, path.join(root, 'none'))
    expect(fs.existsSync(path.join(root, 'hermes', 'plugins'))).toBe(false)
  })
})
