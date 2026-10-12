import { describe, expect, it } from 'vitest'
import { clampBounds, DEFAULT_MIN_SIZE, resizeBounds } from './window-geometry.ts'

// The desktop of a 1600x900 screen: 14px margin, 30px menu bar.
const AREA = { x: 14, y: 44, width: 1572, height: 842 }
const START = { x: 300, y: 100, width: 600, height: 400 }
const right = (b: { x: number; width: number }) => b.x + b.width
const bottom = (b: { y: number; height: number }) => b.y + b.height

describe('resizeBounds', () => {
  it('moves only the edge that is held', () => {
    expect(resizeBounds(START, 'e', 50, 999, AREA)).toEqual({ x: 300, y: 100, width: 650, height: 400 })
    expect(resizeBounds(START, 's', 999, 40, AREA)).toEqual({ x: 300, y: 100, width: 600, height: 440 })
    expect(resizeBounds(START, 'w', -40, 999, AREA)).toEqual({ x: 260, y: 100, width: 640, height: 400 })
    expect(resizeBounds(START, 'n', 999, -40, AREA)).toEqual({ x: 300, y: 60, width: 600, height: 440 })
    expect(resizeBounds(START, 'se', 10, 20, AREA)).toEqual({ x: 300, y: 100, width: 610, height: 420 })
    expect(resizeBounds(START, 'nw', -10, -20, AREA)).toEqual({ x: 290, y: 80, width: 610, height: 420 })
  })

  it('stops at the minimum size with the opposite edge in place, instead of sliding the window', () => {
    const west = resizeBounds(START, 'w', 500, 0, AREA)
    expect(west.width).toBe(DEFAULT_MIN_SIZE.width)
    expect(right(west)).toBe(right(START))

    const north = resizeBounds(START, 'n', 0, 300, AREA)
    expect(north.height).toBe(DEFAULT_MIN_SIZE.height)
    expect(bottom(north)).toBe(bottom(START))

    const corner = resizeBounds(START, 'nw', 900, 900, AREA)
    expect(right(corner)).toBe(right(START))
    expect(bottom(corner)).toBe(bottom(START))
  })

  it('stops at the border of the desktop with the opposite edge in place', () => {
    const east = resizeBounds(START, 'e', 1500, 0, AREA)
    expect(east.x).toBe(300)
    expect(right(east)).toBe(AREA.x + AREA.width)

    const south = resizeBounds(START, 's', 0, 1500, AREA)
    expect(south.y).toBe(100)
    expect(bottom(south)).toBe(AREA.y + AREA.height)

    const west = resizeBounds(START, 'w', -1500, 0, AREA)
    expect(right(west)).toBe(right(START))
    expect(west.x).toBe(AREA.x)

    const north = resizeBounds(START, 'n', 0, -1500, AREA)
    expect(bottom(north)).toBe(bottom(START))
    expect(north.y).toBe(AREA.y)
  })

  it('honours the minimum of the app', () => {
    const camera = { x: 700, y: 350, width: 260, height: 290 }
    const min = { width: 200, height: 230 }

    expect(resizeBounds(camera, 'e', -500, 0, AREA, min).width).toBe(200)
    expect(resizeBounds(camera, 's', 0, -500, AREA, min).height).toBe(230)
  })

  it('does not demand more than a small desktop has', () => {
    const small = { x: 14, y: 44, width: 300, height: 200 }
    const full = { x: 14, y: 44, width: 300, height: 200 }

    expect(resizeBounds(full, 'e', 100, 0, small)).toEqual(full)
    expect(resizeBounds(full, 'w', 100, 0, small)).toEqual(full)
  })
})

describe('clampBounds', () => {
  it('moves a window back inside and keeps its size when it fits', () => {
    expect(clampBounds({ x: -50, y: 20, width: 500, height: 300 }, AREA)).toEqual({ x: 14, y: 44, width: 500, height: 300 })
    expect(clampBounds({ x: 1500, y: 800, width: 500, height: 300 }, AREA)).toEqual({ x: 1086, y: 586, width: 500, height: 300 })
  })

  it('shrinks a window that is larger than the desktop, but never below the minimum', () => {
    expect(clampBounds({ x: 0, y: 0, width: 5000, height: 5000 }, AREA)).toEqual(AREA)
    expect(clampBounds({ x: 300, y: 100, width: 10, height: 10 }, AREA)).toMatchObject({ width: 360, height: 240 })
    expect(clampBounds({ x: 300, y: 100, width: 10, height: 10 }, AREA, { width: 200, height: 230 })).toMatchObject({ width: 200, height: 230 })
  })
})
