import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  allowed,
  describePermissions,
  grantCovers,
  handlePluginSchemes,
  PLUGIN_SCHEME,
  PLUGIN_SCHEMES,
  pluginCsp,
  pluginUrl,
  privilegedPluginSchemes,
  validateManifest
} from './plugins.ts'

const good = {
  id: 'weather-strip',
  name: 'Weather strip',
  version: '1.0.0',
  entry: 'index.html',
  placement: ['menubar', 'overview', 'sideways'],
  size: { width: 9999, height: 10 },
  permissions: ['stats', 'storage', 'run:page.open', 'stats'],
  hosts: ['api.open-meteo.com']
}

describe('validateManifest', () => {
  it('accepts a good manifest and tidies it', () => {
    const { manifest, errors } = validateManifest(good, 'weather-strip')
    expect(errors).toEqual([])
    expect(manifest?.placement).toEqual(['menubar', 'overview'])
    expect(manifest?.size).toEqual({ width: 720, height: 24 })
    expect(manifest?.permissions).toEqual(['stats', 'storage', 'run:page.open'])
  })

  it('refuses ids that do not match the folder, escaping entries and unknown permissions', () => {
    const { manifest, errors } = validateManifest({ ...good, id: 'other', entry: '../evil.html', permissions: ['fs'], hosts: ['http://x.com/path'] }, 'weather-strip')
    expect(manifest).toBeNull()
    expect(errors.join(' ')).toMatch(/must match its folder/)
    expect(errors.join(' ')).toMatch(/inside the plugin folder/)
    expect(errors.join(' ')).toMatch(/unknown permission "fs"/)
    expect(errors.join(' ')).toMatch(/host names/)
  })

  it('needs a placement and an object', () => {
    expect(validateManifest({ ...good, placement: [] }, 'weather-strip').errors).toContain('placement must name at least one of menubar, overview, panel')
    expect(validateManifest([], 'x').errors).toEqual(['manifest.json is not a JSON object'])
  })

  it('keeps the SDK host for the SDK', () => {
    expect(validateManifest({ ...good, id: 'sdk' }, 'sdk').errors).toEqual(['the id "sdk" is reserved'])
  })

  it('accepts the example widget', () => {
    const example = JSON.parse(fs.readFileSync(path.join(__dirname, '../../../examples/widgets/system-meter/manifest.json'), 'utf8'))
    expect(validateManifest(example, 'system-meter').errors).toEqual([])
  })
})

describe('grantCovers', () => {
  const manifest = validateManifest(good, 'weather-strip').manifest

  it('needs every permission and host the manifest asks for', () => {
    if (!manifest) {
      throw new Error('manifest invalid')
    }

    const grant = { permissions: ['stats', 'storage', 'run:page.open'], hosts: ['api.open-meteo.com'] }
    expect(grantCovers(grant, manifest)).toBe(true)
    expect(grantCovers(undefined, manifest)).toBe(false)
    expect(grantCovers({ ...grant, hosts: [] }, manifest)).toBe(false)
    expect(grantCovers({ ...grant, permissions: ['stats', 'storage'] }, manifest)).toBe(false)
  })
})

describe('permissions', () => {
  const manifest = validateManifest(good, 'weather-strip').manifest

  it('gates every method', () => {
    if (!manifest) {
      throw new Error('manifest invalid')
    }

    expect(allowed(manifest, 'stats')).toBe(true)
    expect(allowed(manifest, 'notify')).toBe(false)
    expect(allowed(manifest, 'storage.set')).toBe(true)
    expect(allowed(manifest, 'run', 'page.open')).toBe(true)
    expect(allowed(manifest, 'run', 'software.remove')).toBe(false)
    expect(allowed(manifest, 'run')).toBe(false)
    expect(describePermissions(manifest)).toContain('Connect to api.open-meteo.com')
  })

  it('writes a CSP that only reaches granted hosts', () => {
    expect(pluginCsp('weather-strip', ['api.open-meteo.com'])).toContain('connect-src https://api.open-meteo.com')
    expect(pluginCsp('weather-strip', [])).toContain("connect-src 'none'")
    expect(pluginCsp('weather-strip', [])).toContain("default-src 'none'")
  })
})

describe('plugin URL scheme (Jarod-OS rename, phase 3)', () => {
  it('serves widgets from jarod-plugin:// and still answers the older herald-plugin://', () => {
    expect(PLUGIN_SCHEME).toBe('jarod-plugin')
    expect(PLUGIN_SCHEMES).toEqual(['jarod-plugin', 'herald-plugin'])
  })

  it('registers every scheme as privileged, with the same privileges', () => {
    const entries = privilegedPluginSchemes()

    expect(entries.map(e => e.scheme)).toEqual(['jarod-plugin', 'herald-plugin'])
    for (const e of entries) {
      expect(e.privileges).toEqual({ standard: true, secure: true, supportFetchAPI: true })
    }
  })

  it('hands every scheme to the same handler, so an old page and a new one get the same files and the same checks', () => {
    const seen: Array<[string, unknown]> = []
    const handler = async () => new Response('x')

    handlePluginSchemes({ handle: (scheme, fn) => seen.push([scheme, fn]) }, handler)

    expect(seen.map(([s]) => s)).toEqual(['jarod-plugin', 'herald-plugin'])
    expect(seen.every(([, fn]) => fn === handler)).toBe(true)
  })

  it('a page may load its own files and the SDK under either scheme, and nothing else', () => {
    const csp = pluginCsp('weather-strip', [])

    expect(csp).toContain('script-src jarod-plugin://weather-strip herald-plugin://weather-strip jarod-plugin://sdk herald-plugin://sdk')
    expect(csp).toContain("style-src jarod-plugin://weather-strip herald-plugin://weather-strip 'unsafe-inline'")
    expect(csp).toContain('font-src jarod-plugin://weather-strip herald-plugin://weather-strip')
    expect(csp).not.toMatch(/jarod-plugin:\/\/(?!weather-strip|sdk)/)
  })

  it('the URL of a frame uses the new scheme', () => {
    expect(pluginUrl('weather-strip', 'index.html')).toBe('jarod-plugin://weather-strip/index.html')
  })
})
