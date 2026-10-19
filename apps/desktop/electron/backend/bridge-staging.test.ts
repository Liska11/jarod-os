import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { bridgeLinkPlan, needsStaging, stageBridgePlugin } from './bridge-plugin.ts'

describe('staging for appx installs', () => {
  let dir = ''

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  const makeBundle = (): string => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-'))
    const bundle = path.join(dir, 'bundle')
    fs.mkdirSync(path.join(bundle, 'bridge'), { recursive: true })
    fs.writeFileSync(path.join(bundle, 'plugin.yaml'), 'name: herald-os-bridge\nversion: 1\n')
    fs.writeFileSync(path.join(bundle, 'bridge', 'tools.py'), 'print(1)\n')

    return bundle
  }

  it('is needed only under WindowsApps on Windows', () => {
    const packaged = 'C:\\Program Files\\WindowsApps\\Jarod.OS_0.1.0.0_x64__abc\\app\\resources'

    expect(needsStaging(packaged, 'win32')).toBe(true)
    expect(needsStaging('C:\\Users\\sam\\AppData\\Local\\Programs\\Jarod-OS\\resources', 'win32')).toBe(false)
    expect(needsStaging(packaged, 'linux')).toBe(false)
  })

  it('copies the plugin once and again only when it changes', () => {
    const bundle = makeBundle()
    const target = path.join(dir, 'data', 'bridge-plugin')

    expect(stageBridgePlugin(bundle, target)).toBe(target)
    expect(fs.readFileSync(path.join(target, 'bridge', 'tools.py'), 'utf8')).toBe('print(1)\n')
    const marker = fs.statSync(path.join(target, '.fingerprint')).mtimeMs
    stageBridgePlugin(bundle, target)
    expect(fs.statSync(path.join(target, '.fingerprint')).mtimeMs).toBe(marker)

    fs.writeFileSync(path.join(bundle, 'bridge', 'tools.py'), 'print(2)\n')
    stageBridgePlugin(bundle, target)
    expect(fs.readFileSync(path.join(target, 'bridge', 'tools.py'), 'utf8')).toBe('print(2)\n')
  })

  it('treats a link into WindowsApps as another copy of the app', () => {
    const bundled = 'C:\\Users\\sam\\AppData\\Local\\hermes\\jarod-os\\bridge-plugin'

    expect(bridgeLinkPlan({ kind: 'link', target: 'C:\\Program Files\\WindowsApps\\Old_1.0.0.0\\app\\resources\\herald-os-bridge', exists: true }, bundled)).toBe('replace')
  })
})
