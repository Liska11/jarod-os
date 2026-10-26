import type { KeyValue } from './pairing-store.ts'

/** The look of the app, chosen on this phone only. */
export type ThemePref = 'system' | 'light' | 'dark'
export type MotionPref = 'system' | 'reduced' | 'full'
export type Scheme = 'light' | 'dark'

export interface Appearance {
  theme: ThemePref
  motion: MotionPref
  /** Android 12+: take the colours from the wallpaper (Material You). Below, or off: the fixed palette. */
  dynamic: boolean
}

export const DEFAULT_APPEARANCE: Appearance = { theme: 'system', motion: 'system', dynamic: true }

const KEY = 'jarod.appearance.v1'

const THEMES = new Set<ThemePref>(['system', 'light', 'dark'])
const MOTIONS = new Set<MotionPref>(['system', 'reduced', 'full'])

export function loadAppearance(store: KeyValue = localStorage): Appearance {
  try {
    const raw = JSON.parse(store.getItem(KEY) ?? 'null') as Partial<Appearance> | null
    if (!raw || typeof raw !== 'object') return { ...DEFAULT_APPEARANCE }
    return {
      theme: THEMES.has(raw.theme as ThemePref) ? (raw.theme as ThemePref) : DEFAULT_APPEARANCE.theme,
      motion: MOTIONS.has(raw.motion as MotionPref) ? (raw.motion as MotionPref) : DEFAULT_APPEARANCE.motion,
      dynamic: typeof raw.dynamic === 'boolean' ? raw.dynamic : DEFAULT_APPEARANCE.dynamic
    }
  } catch {
    return { ...DEFAULT_APPEARANCE }
  }
}

export function saveAppearance(a: Appearance, store: KeyValue = localStorage): void {
  try {
    store.setItem(KEY, JSON.stringify(a))
  } catch {
    // Storage refused: the choice lasts until the app closes.
  }
}

export const resolveScheme = (pref: ThemePref, systemDark: boolean): Scheme => (pref === 'system' ? (systemDark ? 'dark' : 'light') : pref)

export const resolveReducedMotion = (pref: MotionPref, systemReduced: boolean): boolean => (pref === 'system' ? systemReduced : pref === 'reduced')

/** What `JarodSystem.colors()` returns: the wallpaper's palette as roles, for both schemes. */
export interface SystemColors {
  supported: boolean
  light: Record<string, string>
  dark: Record<string, string>
}

const ROLE = /^[a-zA-Z][a-zA-Z0-9]*$/
const HEX = /^#[0-9a-fA-F]{6}$/

/**
 * The CSS variables for the wallpaper's colours in one scheme (`--c-primary`, …). Anything that is
 * not a role name with a plain #RRGGBB colour is dropped: the page never takes a value it cannot trust.
 */
export function dynamicVars(colors: SystemColors | null | undefined, scheme: Scheme): Record<string, string> {
  if (!colors?.supported) return {}
  const out: Record<string, string> = {}
  for (const [role, value] of Object.entries(colors[scheme] ?? {})) {
    if (ROLE.test(role) && HEX.test(value)) out[`--c-${role.replace(/[A-Z]/g, m => `-${m.toLowerCase()}`)}`] = value
  }
  return out
}

/** The browser's `theme-color` (the status bar tint where it applies) for a scheme. */
export const THEME_COLOR: Record<Scheme, string> = { light: '#faf9fd', dark: '#121316' }

export interface Environment {
  systemDark: boolean
  systemReduced: boolean
  colors?: SystemColors | null
}

let applied: string[] = []

/** Puts the look on the page: `data-theme`, `data-motion`, and the wallpaper's variables if wanted. */
export function applyAppearance(a: Appearance, env: Environment, root: HTMLElement = document.documentElement): Scheme {
  const scheme = resolveScheme(a.theme, env.systemDark)
  root.dataset.theme = scheme
  root.dataset.motion = resolveReducedMotion(a.motion, env.systemReduced) ? 'reduced' : 'full'
  for (const name of applied) root.style.removeProperty(name)
  const vars = a.dynamic ? dynamicVars(env.colors, scheme) : {}
  applied = Object.keys(vars)
  for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value)
  root.dataset.dynamic = applied.length ? '1' : '0'
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', vars['--c-surface'] ?? THEME_COLOR[scheme])
  return scheme
}
