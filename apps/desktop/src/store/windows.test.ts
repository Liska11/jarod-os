import { beforeEach, describe, expect, it, vi } from 'vitest'

// The store reads the size of the page and the motion preference; there is no DOM in these tests.
const screen = vi.hoisted(() => {
  const size = { innerWidth: 1600, innerHeight: 900 }
  const g = globalThis as unknown as { window: Record<string, unknown>; document: unknown }
  g.document = { documentElement: { dataset: { reduceMotion: 'true' } } }
  g.window = Object.assign(size, { heraldOS: {}, addEventListener: () => undefined, removeEventListener: () => undefined, matchMedia: () => ({ matches: false, addEventListener: () => undefined, addListener: () => undefined }) })

  return size
})

import { $windows, openApp, relayoutOnResize, setBounds, toggleMaximize } from './windows.ts'

const bounds = (id: string) => $windows.get()[id].bounds

describe('floating windows', () => {
  beforeEach(() => {
    $windows.set({})
    screen.innerWidth = 1600
    screen.innerHeight = 900
  })

  it('gives a window back the size the person chose when the desktop grows back', () => {
    const id = openApp('terminal', { bounds: { x: 100, y: 100, width: 1200, height: 700 } })

    screen.innerWidth = 1024
    screen.innerHeight = 640
    relayoutOnResize()
    expect(bounds(id)).toEqual({ x: 14, y: 44, width: 996, height: 582 })

    screen.innerWidth = 1600
    screen.innerHeight = 900
    relayoutOnResize()
    expect(bounds(id)).toEqual({ x: 100, y: 100, width: 1200, height: 700 })
  })

  it('keeps what the person chose after a resize that happened in between', () => {
    const id = openApp('terminal', { bounds: { x: 100, y: 100, width: 1200, height: 700 } })

    screen.innerWidth = 1024
    screen.innerHeight = 640
    relayoutOnResize()
    setBounds(id, { x: 14, y: 44, width: 800, height: 500 })
    screen.innerWidth = 1600
    screen.innerHeight = 900
    relayoutOnResize()
    expect(bounds(id)).toEqual({ x: 14, y: 44, width: 800, height: 500 })
  })

  it('lets a small window stay small: the camera shrinks to its own minimum, not the shell\'s', () => {
    const id = openApp('camera')
    const opened = bounds(id)

    expect(opened).toMatchObject({ width: 260, height: 290 })
    setBounds(id, { ...opened, width: opened.width + 1 })
    expect(bounds(id).width).toBe(261)
    setBounds(id, { ...opened, width: 100, height: 100 })
    expect(bounds(id)).toMatchObject({ width: 200, height: 230 })
  })

  it('holds an ordinary window to the shell minimum', () => {
    const id = openApp('terminal', { bounds: { x: 100, y: 100, width: 900, height: 560 } })

    setBounds(id, { x: 100, y: 100, width: 50, height: 50 })
    expect(bounds(id)).toMatchObject({ width: 360, height: 240 })
  })

  it('restores the size the window had before it was maximized', () => {
    const id = openApp('terminal', { bounds: { x: 120, y: 90, width: 900, height: 560 } })

    toggleMaximize(id)
    expect($windows.get()[id].maximized).toBe(true)
    toggleMaximize(id)
    expect(bounds(id)).toEqual({ x: 120, y: 90, width: 900, height: 560 })
  })

  it('keeps maximized windows on the desktop area when the desktop changes', () => {
    const id = openApp('terminal', { bounds: { x: 120, y: 90, width: 900, height: 560 } })

    toggleMaximize(id)
    screen.innerWidth = 1366
    screen.innerHeight = 768
    relayoutOnResize()
    expect(bounds(id)).toEqual({ x: 14, y: 44, width: 1338, height: 710 })
  })
})
