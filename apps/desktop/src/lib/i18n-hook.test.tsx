// @vitest-environment jsdom
/**
 * `useT` must hand back the same `t` between renders while the language and the assistant's name stay put: components list
 * `t` in `useMemo` / `useEffect` dependencies (the Dock, the command bar), and a fresh function on every render would rerun
 * them every time. It must still change when the language changes, so those hooks pick up the new strings.
 */

import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { $prefs } from '../store/backend.ts'
import { useT } from './i18n.ts'

const initialPrefs = $prefs.get()

afterEach(() => {
  $prefs.set(initialPrefs)
})

describe('useT', () => {
  it('keeps the same t across renders, and a new one when the language changes', () => {
    $prefs.set({ ...initialPrefs, language: 'en' })
    const { result, rerender } = renderHook(() => useT())
    const first = result.current.t

    rerender()
    expect(result.current.t).toBe(first)

    act(() => $prefs.set({ ...initialPrefs, language: 'fr' }))
    expect(result.current.t).not.toBe(first)
    expect(result.current.locale).toBe('fr')
  })
})
