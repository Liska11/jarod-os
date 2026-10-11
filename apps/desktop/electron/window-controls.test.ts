import { describe, expect, it } from 'vitest'
import { maximizeAction } from './window-controls.ts'

describe('maximizeAction', () => {
  it('leaves fullscreen first, then toggles maximized', () => {
    expect(maximizeAction({ fullscreen: true, maximized: false })).toBe('leave-fullscreen')
    expect(maximizeAction({ fullscreen: true, maximized: true })).toBe('leave-fullscreen')
    expect(maximizeAction({ fullscreen: false, maximized: true })).toBe('unmaximize')
    expect(maximizeAction({ fullscreen: false, maximized: false })).toBe('maximize')
  })
})
