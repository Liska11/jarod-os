import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { loadHaptics, saveHaptics, setHapticsEnabled } from '../lib/haptics.ts'
import { system } from '../lib/native.ts'
import { type Appearance, applyAppearance, loadAppearance, saveAppearance, type SystemColors } from '../lib/theme.ts'

interface AppearanceApi {
  appearance: Appearance
  setAppearance: (a: Appearance) => void
  /** The phone can give its wallpaper's colours (Android 12+). */
  dynamicSupported: boolean
  haptics: boolean
  setHaptics: (on: boolean) => void
}

const Ctx = createContext<AppearanceApi | null>(null)

export const useAppearance = (): AppearanceApi => {
  const v = useContext(Ctx)
  if (!v) throw new Error('useAppearance outside AppearanceProvider')
  return v
}

const query = (q: string) => window.matchMedia?.(q)

/** Applies the look to the page (and again when the system's dark mode or wallpaper changes). */
export function AppearanceProvider({ children }: { children: ReactNode }) {
  const [appearance, setAppearanceState] = useState(loadAppearance)
  const [colors, setColors] = useState<SystemColors | null>(null)
  const [haptics, setHapticsState] = useState(loadHaptics)

  const apply = useCallback((a: Appearance, c: SystemColors | null) => {
    const scheme = applyAppearance(a, { systemDark: query('(prefers-color-scheme: dark)')?.matches ?? false, systemReduced: query('(prefers-reduced-motion: reduce)')?.matches ?? false, colors: c })
    // The phone's bars take the app's scheme and tint, not the phone's own.
    const css = getComputedStyle(document.documentElement)
    void system.setBars({ scheme, status: css.getPropertyValue('--c-surface').trim(), nav: css.getPropertyValue('--c-surface-container').trim() }).catch(() => {})
  }, [])

  // The wallpaper's colours, asked of the phone now and again when the app comes back (it may have changed).
  useEffect(() => {
    const ask = () =>
      void system
        .colors()
        .then(setColors)
        .catch(() => setColors(null))
    ask()
    const onVisible = () => !document.hidden && ask()
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [])

  useEffect(() => {
    apply(appearance, colors)
    const dark = query('(prefers-color-scheme: dark)')
    const motion = query('(prefers-reduced-motion: reduce)')
    const again = () => apply(appearance, colors)
    dark?.addEventListener?.('change', again)
    motion?.addEventListener?.('change', again)
    // A rotation redraws the system bars with their own look: the app's scheme is put back.
    window.addEventListener('resize', again)
    return () => {
      dark?.removeEventListener?.('change', again)
      motion?.removeEventListener?.('change', again)
      window.removeEventListener('resize', again)
    }
  }, [appearance, colors, apply])

  const value = useMemo<AppearanceApi>(
    () => ({
      appearance,
      setAppearance: a => {
        saveAppearance(a)
        setAppearanceState(a)
      },
      dynamicSupported: Boolean(colors?.supported),
      haptics,
      setHaptics: on => {
        saveHaptics(on)
        setHapticsEnabled(on)
        setHapticsState(on)
      }
    }),
    [appearance, colors, haptics]
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

/** Before the first paint: the saved theme is on the page, so the app does not flash the wrong one. */
export function applySavedAppearance(): void {
  applyAppearance(loadAppearance(), {
    systemDark: query('(prefers-color-scheme: dark)')?.matches ?? false,
    systemReduced: query('(prefers-reduced-motion: reduce)')?.matches ?? false
  })
}
