import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { readWindowState, restoreBounds, roundingDrift, withoutDrift, writeWindowState } from './window-state.ts'

const MIN = { width: 1024, height: 640 }
const PRIMARY = { x: 0, y: 0, width: 1920, height: 1040 }
const RIGHT = { x: 1920, y: 0, width: 2560, height: 1400 }

describe('restoreBounds', () => {
  it('puts the window back where it was', () => {
    expect(restoreBounds({ x: 100, y: 80, width: 1400, height: 900, maximized: false }, [PRIMARY], MIN)).toEqual({ x: 100, y: 80, width: 1400, height: 900 })
  })

  it('keeps a window that was on a second screen there while that screen is present', () => {
    expect(restoreBounds({ x: 2000, y: 50, width: 1600, height: 1000, maximized: false }, [PRIMARY, RIGHT], MIN)).toEqual({ x: 2000, y: 50, width: 1600, height: 1000 })
  })

  it('gives up when the screen that held it is gone', () => {
    expect(restoreBounds({ x: 2000, y: 50, width: 1600, height: 1000, maximized: false }, [PRIMARY], MIN)).toBeNull()
  })

  it('shrinks and pulls a window back inside a smaller work area', () => {
    expect(restoreBounds({ x: 1500, y: 600, width: 2400, height: 1300, maximized: false }, [PRIMARY], MIN)).toEqual({ x: 0, y: 0, width: 1920, height: 1040 })
  })

  it('refuses a window whose title strip is off every screen', () => {
    expect(restoreBounds({ x: 100, y: -500, width: 1200, height: 800, maximized: false }, [PRIMARY], MIN)).toBeNull()
  })

  it('never restores below the minimum size the window accepts', () => {
    expect(restoreBounds({ x: 10, y: 10, width: 300, height: 200, maximized: false }, [PRIMARY], MIN)).toEqual({ x: 10, y: 10, width: 1024, height: 640 })
  })

  it('has nothing to restore on a first launch', () => {
    expect(restoreBounds(null, [PRIMARY], MIN)).toBeNull()
  })
})

describe('rounding drift', () => {
  it('takes the pixels a fractional scale adds back out, so a window does not grow at each launch', () => {
    const asked = { x: 200, y: 112, width: 1300, height: 800 }
    const drift = roundingDrift(asked, { x: 200, y: 112, width: 1304, height: 802 })

    expect(withoutDrift({ x: 200, y: 112, width: 1304, height: 802 }, drift)).toEqual(asked)
  })

  it('treats a large difference as the system placing the window, not rounding', () => {
    expect(roundingDrift({ x: 0, y: 0, width: 3000, height: 2000 }, { x: 0, y: 0, width: 1920, height: 1040 })).toEqual({ x: 0, y: 0, width: 0, height: 0 })
  })

  it('has nothing to correct when nothing was restored', () => {
    expect(roundingDrift(null, { x: 5, y: 5, width: 1920, height: 1040 })).toEqual({ x: 0, y: 0, width: 0, height: 0 })
  })
})

describe('window state file', () => {
  it('round-trips, and reads a damaged file as nothing saved', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'window-state-'))
    const file = path.join(dir, 'window-state.json')

    try {
      writeWindowState(file, { x: 1, y: 2, width: 1300, height: 800, maximized: true })
      expect(readWindowState(file)).toEqual({ x: 1, y: 2, width: 1300, height: 800, maximized: true })

      fs.writeFileSync(file, '{"x": 1, "y":')
      expect(readWindowState(file)).toBeNull()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
