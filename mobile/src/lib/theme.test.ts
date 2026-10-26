import { describe, expect, it } from 'vitest'
import { DEFAULT_APPEARANCE, dynamicVars, loadAppearance, resolveReducedMotion, resolveScheme, saveAppearance } from './theme.ts'

const memory = () => {
  const m = new Map<string, string>()
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) }
}

describe('theme', () => {
  it('follows the system unless told otherwise', () => {
    expect(resolveScheme('system', true)).toBe('dark')
    expect(resolveScheme('system', false)).toBe('light')
    expect(resolveScheme('light', true)).toBe('light')
    expect(resolveScheme('dark', false)).toBe('dark')
  })

  it('reduces motion on request or when the system asks', () => {
    expect(resolveReducedMotion('system', true)).toBe(true)
    expect(resolveReducedMotion('system', false)).toBe(false)
    expect(resolveReducedMotion('reduced', false)).toBe(true)
    expect(resolveReducedMotion('full', true)).toBe(false)
  })

  it('keeps the choices, and ignores what it does not know', () => {
    const store = memory()
    expect(loadAppearance(store)).toEqual(DEFAULT_APPEARANCE)
    saveAppearance({ theme: 'dark', motion: 'reduced', dynamic: false }, store)
    expect(loadAppearance(store)).toEqual({ theme: 'dark', motion: 'reduced', dynamic: false })
    store.setItem('jarod.appearance.v1', JSON.stringify({ theme: 'neon', motion: 3, dynamic: 'yes' }))
    expect(loadAppearance(store)).toEqual(DEFAULT_APPEARANCE)
    store.setItem('jarod.appearance.v1', '{not json')
    expect(loadAppearance(store)).toEqual(DEFAULT_APPEARANCE)
  })

  it('turns the wallpaper colours into CSS variables for one scheme', () => {
    const colors = { supported: true, light: { primary: '#1F5FD6', onPrimary: '#FFFFFF' }, dark: { primary: '#B0C6FF' } }
    expect(dynamicVars(colors, 'light')).toEqual({ '--c-primary': '#1F5FD6', '--c-on-primary': '#FFFFFF' })
    expect(dynamicVars(colors, 'dark')).toEqual({ '--c-primary': '#B0C6FF' })
  })

  it('takes no variable from an unsupported system or a doubtful value', () => {
    expect(dynamicVars({ supported: false, light: { primary: '#112233' }, dark: {} }, 'light')).toEqual({})
    expect(dynamicVars(null, 'dark')).toEqual({})
    const hostile = { supported: true, light: { primary: 'red; background:url(x)', 'bad name': '#112233', ok: '#112233' }, dark: {} }
    expect(dynamicVars(hostile, 'light')).toEqual({ '--c-ok': '#112233' })
  })
})
