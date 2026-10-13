import fs from 'node:fs'
import { writeFileAtomic } from './atomic-write.ts'

/** Where the main window was and how big, so the next launch puts it back (W6 of the 2026-10-12 analysis). */
export interface SavedWindow {
  x: number
  y: number
  width: number
  height: number
  maximized: boolean
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** At least this much of the window's top strip must land on a screen, or it could not be grabbed. */
const VISIBLE_WIDTH = 160
const TITLE_STRIP = 40

export function readWindowState(file: string): SavedWindow | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<SavedWindow>
    const numbers = [raw.x, raw.y, raw.width, raw.height]

    return numbers.every(value => typeof value === 'number' && Number.isFinite(value))
      ? { x: raw.x!, y: raw.y!, width: raw.width!, height: raw.height!, maximized: raw.maximized === true }
      : null
  } catch {
    return null
  }
}

export function writeWindowState(file: string, state: SavedWindow): void {
  writeFileAtomic(file, `${JSON.stringify(state)}\n`)
}

/** Beyond this, a difference between asked and got bounds is the system placing the window, not rounding. */
const MAX_ROUNDING = 16

/**
 * What the system added to the bounds it was asked for: at fractional scales (125 %, 225 %…) Windows
 * rounds a frameless window up by a few pixels, and saving what it reports made the window grow at each
 * launch (measured: +4 px per launch at 225 %). The caller subtracts this when it saves.
 */
export function roundingDrift(asked: Rect | null, got: Rect): Rect {
  if (!asked) {
    return { x: 0, y: 0, width: 0, height: 0 }
  }

  const small = (value: number) => (Math.abs(value) <= MAX_ROUNDING ? value : 0)

  return { x: small(got.x - asked.x), y: small(got.y - asked.y), width: small(got.width - asked.width), height: small(got.height - asked.height) }
}

/** `bounds` with the system's rounding taken back out (see `roundingDrift`). */
export function withoutDrift(bounds: Rect, drift: Rect): Rect {
  return { x: bounds.x - drift.x, y: bounds.y - drift.y, width: bounds.width - drift.width, height: bounds.height - drift.height }
}

/**
 * The saved bounds, if they still fit the screens there are now: the display that holds the window's top
 * strip, the size cut to that display's work area. Null when no screen holds it any more (an unplugged
 * monitor, a smaller remote desktop), so the caller falls back to its default.
 */
export function restoreBounds(saved: SavedWindow | null, workAreas: readonly Rect[], min: { width: number; height: number }): Rect | null {
  if (!saved) {
    return null
  }

  const strip = { x: saved.x, y: saved.y, width: saved.width, height: TITLE_STRIP }
  const area = workAreas.find(candidate => {
    const width = Math.min(strip.x + strip.width, candidate.x + candidate.width) - Math.max(strip.x, candidate.x)
    const height = Math.min(strip.y + strip.height, candidate.y + candidate.height) - Math.max(strip.y, candidate.y)

    return width >= Math.min(VISIBLE_WIDTH, strip.width) && height > 0
  })

  if (!area) {
    return null
  }

  const width = Math.max(Math.min(saved.width, area.width), Math.min(min.width, area.width))
  const height = Math.max(Math.min(saved.height, area.height), Math.min(min.height, area.height))
  const x = Math.min(Math.max(saved.x, area.x), area.x + area.width - width)
  const y = Math.min(Math.max(saved.y, area.y), area.y + area.height - height)

  return { x, y, width, height }
}
