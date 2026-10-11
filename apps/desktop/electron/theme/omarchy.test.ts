import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { isOmarchy, parseTomlStrings, readOmarchyTheme, themeColorsFromOmarchy } from './omarchy.ts'

const ALACRITTY = `
[colors.primary]
background = "#1a1b26"
foreground = "#a9b1d6"

[colors.normal]
red = "#f7768e"   # error
green = "#9ece6a"
yellow = "#e0af68"
blue = "#7aa2f7"

[colors.bright]
blue = '0x89b4fa'
`

describe('parseTomlStrings', () => {
  it('keys values by section and plainly', () => {
    const values = parseTomlStrings(ALACRITTY)
    expect(values['colors.primary.background']).toBe('#1a1b26')
    expect(values['colors.normal.red']).toBe('#f7768e')
    expect(values['colors.bright.blue']).toBe('#89b4fa')
    // The first plain key wins (normal blue, before bright blue).
    expect(values.blue).toBe('#7aa2f7')
  })
})

describe('themeColorsFromOmarchy', () => {
  it('maps an alacritty palette to Herald colours', () => {
    const colors = themeColorsFromOmarchy(parseTomlStrings(ALACRITTY))
    expect(colors).toMatchObject({ bg: '#1a1b26', fg: '#a9b1d6', accent: '#7aa2f7', accent_strong: '#89b4fa', urgent: '#f7768e', ok: '#9ece6a', warn: '#e0af68' })
  })

  it('reads a flat colors.toml', () => {
    const colors = themeColorsFromOmarchy(parseTomlStrings('accent = "#e68e0d"\nbackground = "#121212"\nforeground = "#bebebe"\ncolor1 = "#d35f5f"'))
    expect(colors).toMatchObject({ bg: '#121212', fg: '#bebebe', accent: '#e68e0d', urgent: '#d35f5f' })
  })

  it('needs a background and a foreground', () => {
    expect(themeColorsFromOmarchy({ accent: '#ffffff' })).toBeNull()
  })
})

describe('readOmarchyTheme', () => {
  // Omarchy is a Linux distribution; the fixture needs symbolic links, which Windows reserves for administrators.
  it.skipIf(process.platform === 'win32')('follows the current theme link and the background', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'omarchy-'))
    const theme = path.join(home, '.config', 'omarchy', 'themes', 'tokyo-night')
    fs.mkdirSync(theme, { recursive: true })
    fs.writeFileSync(path.join(theme, 'alacritty.toml'), ALACRITTY)
    fs.writeFileSync(path.join(theme, 'wall.png'), '')
    const current = path.join(home, '.config', 'omarchy', 'current')
    fs.mkdirSync(current, { recursive: true })
    fs.symlinkSync(theme, path.join(current, 'theme'))
    fs.symlinkSync(path.join(theme, 'wall.png'), path.join(current, 'background'))

    const found = readOmarchyTheme(home)
    expect(found?.spec.name).toBe('omarchy-tokyo-night')
    expect(found?.spec.label).toBe('Omarchy: tokyo night')
    expect(found?.spec.colors.bg).toBe('#1a1b26')
    expect(found?.spec.wallpaper).toBe(fs.realpathSync(path.join(theme, 'wall.png')))
    expect(readOmarchyTheme(path.join(home, 'nobody'))).toBeNull()
    fs.rmSync(home, { recursive: true, force: true })
  })

  it('reads Omarchy 4, which stages the theme under ~/.local/state and names it in theme.name', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'omarchy-'))
    const current = path.join(home, '.local', 'state', 'omarchy', 'current')
    fs.mkdirSync(path.join(current, 'theme'), { recursive: true })
    fs.writeFileSync(path.join(current, 'theme', 'colors.toml'), 'background = "#191724"\nforeground = "#e0def4"\naccent = "#c4a7e7"\n')
    fs.writeFileSync(path.join(current, 'theme.name'), 'rose-pine\n')

    expect(readOmarchyTheme(home)?.spec.name).toBe('omarchy-rose-pine')
    expect(readOmarchyTheme(home)?.spec.colors.accent).toBe('#c4a7e7')
    expect(isOmarchy(home, {})).toBe(true)
    expect(isOmarchy(path.join(home, 'nobody'), {})).toBe(false)
    fs.rmSync(home, { recursive: true, force: true })
  })
})
