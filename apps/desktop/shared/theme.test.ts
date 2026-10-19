import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { contrast, HERALD_SKIN, hermesSkinYaml, isOurSkin, luminance, mix, paletteVars, parseHex, schemeOf, terminalColors, themeColorsFromSkin, themeFromPixels, themeSlug, skinToSelect, toHex, type ThemeColors, validateTheme, wallpaperTint } from './theme.ts'

const OCEAN: ThemeColors = { bg: '#04113f', bg2: '#0a2a96', surface: '#0b1c5a', fg: '#e9eefb', fg_dim: '#9fb0dc', accent: '#4d92ff', accent_strong: '#5296ff', border_active: '#4d92ff', border_inactive: '#1c2c66', urgent: '#ff6b6b', ok: '#36e6a6', warn: '#f2c25e' }
const PAPER: ThemeColors = { ...OCEAN, bg: '#f4f1ea', bg2: '#ebe5d8', surface: '#ffffff', fg: '#25221c', fg_dim: '#6b6456', accent: '#b4532a', accent_strong: '#9c4522' }

/** A w x h RGBA image: `paint(x, y)` gives each pixel's colour. */
function image(w: number, h: number, paint: (x: number, y: number) => string): Uint8ClampedArray {
  const data = new Uint8ClampedArray(w * h * 4)

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const { r, g, b } = parseHex(paint(x, y))!
      data.set([r, g, b, 255], (y * w + x) * 4)
    }
  }

  return data
}

describe('colour maths', () => {
  it('parses, mixes and measures colours', () => {
    expect(parseHex('#abc')).toEqual({ r: 170, g: 187, b: 204 })
    expect(parseHex('nope')).toBeNull()
    expect(toHex({ r: 300, g: -4, b: 15.6 })).toBe('#ff0010')
    expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080')
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 0)
    expect(luminance('#ffffff')).toBeCloseTo(1)
  })
})

describe('paletteVars', () => {
  it('derives every shell token, and opaque glass for panels mode', () => {
    const glass = paletteVars(OCEAN)
    const panels = paletteVars(OCEAN, { panels: true })

    expect(glass['--color-bg']).toBe('#04113f')
    expect(glass['color-scheme']).toBe('dark')
    expect(glass['--color-accent-fg']).toBe('#ffffff')
    expect(glass['--color-white']).toBeUndefined()
    expect(glass['--color-glass']).toMatch(/0\.74\)$/)
    expect(panels['--color-glass']).toMatch(/0\.95\)$/)
  })

  it('swaps white and black overlays for light themes', () => {
    const vars = paletteVars(PAPER)

    expect(schemeOf(PAPER)).toBe('light')
    expect(vars['color-scheme']).toBe('light')
    expect(vars['--color-white']).toBe(PAPER.fg)
    expect(vars['--color-black']).toBe('#ffffff')
  })
})

describe('themeFromPixels', () => {
  it('makes a dark theme with a readable accent from a dark image', () => {
    // Mostly deep navy with an orange sunset band.
    const spec = themeFromPixels(
      image(40, 40, (_x, y) => (y < 8 ? '#ff8a2a' : '#0b1430')),
      { name: 'dusk', label: 'Dusk' }
    )

    expect(validateTheme(spec)).toBeNull()
    expect(spec.shell?.scheme).toBe('dark')
    expect(schemeOf(spec.colors)).toBe('dark')
    expect(contrast(spec.colors.accent, spec.colors.bg)).toBeGreaterThanOrEqual(3)
    expect(contrast(spec.colors.fg, spec.colors.bg)).toBeGreaterThanOrEqual(7)
    // The accent keeps the orange's hue.
    const { r, b } = parseHex(spec.colors.accent)!
    expect(r).toBeGreaterThan(b)
    expect(spec.terminal?.palette).toHaveLength(16)
  })

  it('makes a light theme from a light image, and can be forced dark', () => {
    const pixels = image(30, 30, x => (x < 6 ? '#2a7d5f' : '#f2efe6'))

    expect(themeFromPixels(pixels, { name: 'sage' }).shell?.scheme).toBe('light')
    expect(themeFromPixels(pixels, { name: 'sage', scheme: 'dark' }).shell?.scheme).toBe('dark')
  })

  it('falls back to the Herald blue for a greyscale image', () => {
    const spec = themeFromPixels(
      image(20, 20, x => (x % 2 ? '#202020' : '#303030')),
      { name: 'mono' }
    )

    expect(spec.colors.accent).not.toBe('#202020')
    expect(contrast(spec.colors.accent, spec.colors.bg)).toBeGreaterThanOrEqual(3)
    expect(() => themeFromPixels(new Uint8ClampedArray(16), { name: 'empty' })).toThrow(/no visible pixels/)
  })
})

describe('themes on disk', () => {
  it('every built-in theme.json is valid', () => {
    const root = path.resolve(__dirname, '..', '..', '..', 'linux', 'themes')
    const names = fs.readdirSync(root).filter(name => fs.existsSync(path.join(root, name, 'theme.json')))

    expect(names.length).toBeGreaterThanOrEqual(4)

    for (const name of names) {
      const spec = JSON.parse(fs.readFileSync(path.join(root, name, 'theme.json'), 'utf8'))
      expect(validateTheme(spec), name).toBeNull()
      expect(spec.name, name).toBe(name)
      expect(contrast(spec.colors.fg, spec.colors.bg), `${name} text contrast`).toBeGreaterThanOrEqual(7)
      expect(contrast(spec.colors.accent, spec.colors.bg), `${name} accent contrast`).toBeGreaterThanOrEqual(2.5)
    }
  })

  it('validateTheme names what is wrong', () => {
    expect(validateTheme({ name: 'Bad Name', colors: OCEAN })).toMatch(/name/)
    expect(validateTheme({ name: 'ok', colors: { ...OCEAN, accent: 'blue' } })).toMatch(/accent/)
    expect(themeSlug('  Calm Green!! ')).toBe('calm-green')
  })
})

describe('Hermes skins', () => {
  it('writes a skin Hermes can load', () => {
    const yaml = hermesSkinYaml('Herald Ocean', OCEAN)

    expect(yaml).toContain('name: jarod-os')
    expect(yaml).toContain('  ui_accent: "#4d92ff"')
    expect(yaml).toContain('  status_bar_bg: "#0a2a96"')
  })

  it('the skin is jarod-os since the rename, and the older herald-os counts as ours (rename, phase 5)', () => {
    expect(HERALD_SKIN).toBe('jarod-os')
    expect(isOurSkin('jarod-os')).toBe(true)
    expect(isOurSkin('herald-os')).toBe(true)
    expect(isOurSkin('ares')).toBe(false)
    expect(isOurSkin(undefined)).toBe(false)
  })

  it('points Hermes at the Jarod-OS skin when none, the default or the older one of ours is set, never over a choice of the person', () => {
    expect(skinToSelect('')).toBe('jarod-os')
    expect(skinToSelect('default')).toBe('jarod-os')
    expect(skinToSelect('herald-os')).toBe('jarod-os')
    expect(skinToSelect('jarod-os')).toBeNull()
    expect(skinToSelect('ares')).toBeNull()
  })

  it('reads a Hermes skin back into Herald colours', () => {
    const colors = themeColorsFromSkin({ colors: { ui_accent: '#ffbf00', banner_text: '#fff8dc', status_bar_bg: '#1a1a2e', ui_error: '#ef5350' } })

    expect(colors?.accent).toBe('#ffbf00')
    expect(colors?.urgent).toBe('#ef5350')
    expect(themeColorsFromSkin({ colors: { ui_accent: '#ffbf00' } })).toBeNull()
  })

  it('tints the wallpaper and the terminal', () => {
    expect(wallpaperTint(null)).toBeNull()
    expect(wallpaperTint(PAPER)?.light).toBe(true)
    expect(terminalColors(OCEAN).foreground).toBe(OCEAN.fg)
  })
})
