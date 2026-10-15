import { describe, expect, it } from 'vitest'
import { detectCompositor, knownWmAction } from './compositor.ts'

describe('detectCompositor', () => {
  it('reads the socket each compositor advertises', () => {
    expect(detectCompositor({ NIRI_SOCKET: '/run/user/1000/niri.sock' })).toBe('niri')
    expect(detectCompositor({ HYPRLAND_INSTANCE_SIGNATURE: 'abc' })).toBe('hyprland')
    expect(detectCompositor({})).toBeNull()
  })
})

describe('knownWmAction', () => {
  it('accepts exactly the actions the union names, with their arguments', () => {
    expect(knownWmAction({ type: 'focus-window', id: 0x20 })).toBe(true)
    expect(knownWmAction({ type: 'close-window', id: 3 })).toBe(true)
    expect(knownWmAction({ type: 'focus-workspace', ref: 'work' })).toBe(true)
    expect(knownWmAction({ type: 'focus-workspace', ref: 2 })).toBe(true)
    expect(knownWmAction({ type: 'move-window-to-workspace', id: 3, ref: 'work' })).toBe(true)
    expect(knownWmAction({ type: 'toggle-floating', id: 3 })).toBe(true)
    expect(knownWmAction({ type: 'fullscreen', id: 3 })).toBe(true)
    expect(knownWmAction({ type: 'maximize-column' })).toBe(true)
    expect(knownWmAction({ type: 'toggle-overview' })).toBe(true)
    expect(knownWmAction({ type: 'screenshot', what: 'select' })).toBe(true)
  })

  it('refuses anything else a window could send', () => {
    // The compositor-argv action the union used to carry: `niri msg action spawn` and
    // `hyprctl dispatch exec` both run a program, so it must not survive validation.
    expect(knownWmAction({ type: 'raw', args: ['exec', 'kitty'] })).toBe(false)
    expect(knownWmAction({ type: 'exec', args: ['kitty'] })).toBe(false)
    expect(knownWmAction({ type: 'focus-window' })).toBe(false)
    expect(knownWmAction({ type: 'focus-window', id: '0x20' })).toBe(false)
    expect(knownWmAction({ type: 'focus-workspace', ref: { name: 'work' } })).toBe(false)
    expect(knownWmAction({ type: 'move-window-to-workspace', id: 3 })).toBe(false)
    expect(knownWmAction({ type: 'screenshot', what: 'everything' })).toBe(false)
    expect(knownWmAction({ type: 'screenshot' })).toBe(false)
    expect(knownWmAction({})).toBe(false)
    expect(knownWmAction('focus-window')).toBe(false)
    expect(knownWmAction(null)).toBe(false)
    expect(knownWmAction(undefined)).toBe(false)
  })
})
