// 30/10 (idée vue dans brahma-ai-evo) : la bulle flottante n'apparaît que lorsque Jarod est réduit ; un clic ouvre le chat compact sous elle,
// toujours au premier plan ; « Agrandir » rend exactement la fenêtre d'avant.
import { describe, expect, it } from 'vitest'
import { COMPACT_OPACITY, COMPACT_SIZE, CompactChat, compactBounds } from './compact-chat.ts'
import { MINI_SIZE, MiniWindow } from './mini-window.ts'

function fakeWin(start: { bounds: { x: number; y: number; width: number; height: number }; maximized?: boolean; fullscreen?: boolean }) {
  const st = { opacity: 1, bounds: start.bounds, maximized: start.maximized ?? false, fullscreen: start.fullscreen ?? false, onTop: false, minimized: true, visible: true }
  return {
    st,
    getNormalBounds: () => st.bounds,
    isMaximized: () => st.maximized,
    isFullScreen: () => st.fullscreen,
    isMinimized: () => st.minimized,
    setFullScreen: (v: boolean) => void (st.fullscreen = v),
    unmaximize: () => void (st.maximized = false),
    maximize: () => void (st.maximized = true),
    restore: () => void (st.minimized = false),
    setBounds: (b: typeof st.bounds) => void (st.bounds = b),
    setAlwaysOnTop: (v: boolean) => void (st.onTop = v),
    setOpacity: (v: number) => void (st.opacity = v),
    isVisible: () => st.visible,
    show: () => void (st.visible = true),
    focus: () => undefined
  }
}

const area = { x: 0, y: 0, width: 1920, height: 1040 }

describe('chat compact', () => {
  it('se colle à la bulle : au-dessus si elle est en bas, dessous si elle est en haut, du côté où elle est', () => {
    const bubble = (x: number, y: number) => ({ x, y, ...MINI_SIZE })
    const low = compactBounds(area, bubble(1800, 940))
    expect(low).toEqual({ x: 1800 + MINI_SIZE.width - COMPACT_SIZE.width, y: 940 - 8 - COMPACT_SIZE.height, width: COMPACT_SIZE.width, height: COMPACT_SIZE.height })
    const high = compactBounds(area, bubble(40, 30))
    expect(high).toEqual({ x: 40, y: 30 + MINI_SIZE.height + 8, width: COMPACT_SIZE.width, height: COMPACT_SIZE.height })
    // sans bulle montrée : en bas à droite ; sur un petit écran : toujours dans la zone de travail
    expect(compactBounds(area).x + COMPACT_SIZE.width).toBeLessThanOrEqual(1920)
    const small = compactBounds({ x: 0, y: 0, width: 800, height: 600 }, bubble(700, 500))
    expect(small.y).toBeGreaterThanOrEqual(0)
    expect(small.y + small.height).toBeLessThanOrEqual(600)
    expect(small.x + small.width).toBeLessThanOrEqual(800)
  })

  it('translucide pendant le chat compact, opaque de nouveau à l’agrandissement', () => {
    const win = fakeWin({ bounds: { x: 0, y: 0, width: 1200, height: 800 } })
    const c = new CompactChat({ window: () => win as never, workArea: () => area, notify: () => undefined })
    c.enter()
    expect(win.st.opacity).toBe(COMPACT_OPACITY)
    expect(c.open).toBe(true)
    c.leave()
    expect(win.st.opacity).toBe(1)
    expect(c.open).toBe(false)
  })

  it('entrer : petite fenêtre au premier plan, la page est prévenue ; agrandir : la place, la taille et le plein écran d’avant', () => {
    const win = fakeWin({ bounds: { x: 10, y: 20, width: 1600, height: 900 }, fullscreen: true })
    const notified: boolean[] = []
    const c = new CompactChat({ window: () => win as never, workArea: () => area, notify: on => notified.push(on) })
    c.enter()
    expect(c.active).toBe(true)
    expect(win.st.onTop).toBe(true)
    expect(win.st.fullscreen).toBe(false)
    expect(win.st.bounds).toEqual(compactBounds(area, null))
    c.leave()
    expect(c.active).toBe(false)
    expect(win.st.onTop).toBe(false)
    expect(win.st.bounds).toEqual({ x: 10, y: 20, width: 1600, height: 900 })
    expect(win.st.fullscreen).toBe(true)
    expect(notified).toEqual([true, false])
  })

  it('deux clics sur la bulle gardent la fenêtre d’origine (pas la petite)', () => {
    const win = fakeWin({ bounds: { x: 1, y: 2, width: 1200, height: 800 } })
    const c = new CompactChat({ window: () => win as never, workArea: () => area, notify: () => undefined })
    c.enter()
    c.enter()
    c.leave()
    expect(win.st.bounds).toEqual({ x: 1, y: 2, width: 1200, height: 800 })
  })
})

describe('bulle flottante : visible seulement quand on le demande', () => {
  it('créée cachée, montrée puis cachée par setVisible', () => {
    let shown = 0
    let hidden = 0
    let visible = false
    const handlers: Record<string, () => void> = {}
    const win = {
      isDestroyed: () => false,
      isVisible: () => visible,
      showInactive: () => void (shown++, (visible = true)),
      hide: () => void (hidden++, (visible = false)),
      setAlwaysOnTop: () => undefined,
      once: (ev: string, fn: () => void) => void (handlers[ev] = fn),
      on: () => undefined,
      blur: () => undefined,
      loadFile: () => Promise.resolve(),
      webContents: { on: () => undefined, setWindowOpenHandler: () => undefined, send: () => undefined }
    }
    const mini = new MiniWindow({ createWindow: () => win as never, workArea: () => area, preloadPath: 'p', page: { file: 'f' }, openMain: () => undefined })
    mini.setEnabled(true)
    handlers['ready-to-show']?.()
    expect(shown).toBe(0)
    mini.setVisible(true)
    expect(shown).toBe(1)
    mini.setVisible(false)
    expect(hidden).toBe(1)
  })

  it('se déplace à la souris, reste dans l’écran, garde sa place une fois lâchée', () => {
    let b = { x: 1800, y: 900, width: 88, height: 88 }
    const moved: { x: number; y: number }[] = []
    const win = {
      isDestroyed: () => false,
      isVisible: () => true,
      showInactive: () => undefined,
      hide: () => undefined,
      setAlwaysOnTop: () => undefined,
      once: () => undefined,
      on: () => undefined,
      loadFile: () => Promise.resolve(),
      getBounds: () => b,
      setBounds: (n: typeof b) => void (b = n),
      webContents: { on: () => undefined, setWindowOpenHandler: () => undefined, send: () => undefined }
    }
    const mini = new MiniWindow({ createWindow: () => win as never, workArea: () => area, preloadPath: 'p', page: { file: 'f' }, openMain: () => undefined, onMoved: pos => moved.push(pos) })
    mini.setEnabled(true)
    mini.dragBy(-100, -50)
    expect(b).toEqual({ x: 1700, y: 850, width: 88, height: 88 })
    mini.dragBy(900, 900) // hors de l'écran : ramenée au bord
    expect(b).toEqual({ x: 1920 - 88, y: 1040 - 88, width: 88, height: 88 })
    mini.dragEnd()
    expect(moved).toEqual([{ x: 1920 - 88, y: 1040 - 88 }])
    expect(mini.bounds).toEqual(b)
  })
})
