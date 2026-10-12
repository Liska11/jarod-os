/*
 * The arithmetic of the floating windows, kept free of the DOM and of the stores so it can be tested:
 * what a window may measure, where it may sit, and what dragging one of its edges does.
 */

export interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

export interface Size {
  width: number
  height: number
}

export type Edge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

/** What a window may shrink to when its app does not say otherwise. */
export const DEFAULT_MIN_SIZE: Size = { width: 360, height: 240 }

const between = (value: number, low: number, high: number): number => Math.max(low, Math.min(value, high))

/** The smallest size usable inside `area` (a desktop smaller than the app's minimum wins over it). */
function usableMin(area: Bounds, min: Size): Size {
  return { width: Math.min(min.width, area.width), height: Math.min(min.height, area.height) }
}

/** `bounds` brought inside `area`: sized between the minimum and the area, then moved until it fits. */
export function clampBounds(bounds: Bounds, area: Bounds, min: Size = DEFAULT_MIN_SIZE): Bounds {
  const least = usableMin(area, min)
  const width = between(bounds.width, least.width, area.width)
  const height = between(bounds.height, least.height, area.height)

  return {
    x: between(bounds.x, area.x, area.x + area.width - width),
    y: between(bounds.y, area.y, area.y + area.height - height),
    width,
    height
  }
}

/**
 * The window after its `edge` was dragged by (`dx`, `dy`) from `start`. The edge opposite the one held never
 * moves: past the minimum size or the border of the desktop the window simply stops, it does not slide.
 */
export function resizeBounds(start: Bounds, edge: Edge, dx: number, dy: number, area: Bounds, min: Size = DEFAULT_MIN_SIZE): Bounds {
  const least = usableMin(area, min)
  const areaRight = area.x + area.width
  const areaBottom = area.y + area.height
  const right = start.x + start.width
  const bottom = start.y + start.height
  let { x, y, width, height } = start

  if (edge.includes('e')) {
    width = between(start.width + dx, least.width, Math.max(least.width, areaRight - start.x))
  }

  if (edge.includes('w')) {
    width = between(start.width - dx, least.width, Math.max(least.width, right - area.x))
    x = right - width
  }

  if (edge.includes('s')) {
    height = between(start.height + dy, least.height, Math.max(least.height, areaBottom - start.y))
  }

  if (edge.includes('n')) {
    height = between(start.height - dy, least.height, Math.max(least.height, bottom - area.y))
    y = bottom - height
  }

  return { x, y, width, height }
}
