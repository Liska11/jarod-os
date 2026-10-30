import type { BrowserWindow as BrowserWindowType, Rectangle } from 'electron'
import { MINI_SIZE } from './mini-window.ts'

/*
 * Le chat compact (30/10, idée vue dans brahma-ai-evo, principe seulement) : Jarod réduit, la bulle flotte à l'écran ; un clic sur elle rouvre
 * Jarod en PETITE fenêtre de conversation, toujours au premier plan, collée à la bulle — pas le bureau entier. « Agrandir » rend la fenêtre
 * d'avant (place, taille, plein écran, maximisée) ; réduire la remet en bulle.
 *
 * C'est la fenêtre principale elle-même qui change de forme : aucune seconde fenêtre du shell, donc aucun second accès au moteur à garder.
 */

export const COMPACT_SIZE = { width: 360, height: 520 }
/** La fenêtre est un peu translucide (comme le chat de brahma) : on devine ce qu'il y a derrière sans que le texte devienne illisible. */
export const COMPACT_OPACITY = 0.9
const GAP = 8

/**
 * Collée à la bulle : au-dessus d'elle si la bulle est dans la moitié basse de l'écran, dessous sinon ; alignée sur son bord droit si elle
 * est dans la moitié droite, gauche sinon. Toujours bornée à la zone de travail. Sans bulle (rien d'affiché), en bas à droite.
 */
export function compactBounds(workArea: Rectangle, anchor?: Rectangle | null): Rectangle {
  const width = Math.min(COMPACT_SIZE.width, workArea.width)
  const height = Math.max(320, Math.min(COMPACT_SIZE.height, workArea.height - 2 * GAP))
  const bubble = anchor ?? { x: workArea.x + workArea.width - MINI_SIZE.width - 16, y: workArea.y + workArea.height - MINI_SIZE.height - 16, ...MINI_SIZE }
  const bubbleInRight = bubble.x + bubble.width / 2 > workArea.x + workArea.width / 2
  const bubbleInLower = bubble.y + bubble.height / 2 > workArea.y + workArea.height / 2
  const x = bubbleInRight ? bubble.x + bubble.width - width : bubble.x
  const y = bubbleInLower ? bubble.y - GAP - height : bubble.y + bubble.height + GAP
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi))

  return {
    x: Math.round(clamp(x, workArea.x, workArea.x + workArea.width - width)),
    y: Math.round(clamp(y, workArea.y, workArea.y + workArea.height - height)),
    width,
    height
  }
}

interface Saved {
  bounds: Rectangle
  maximized: boolean
  fullscreen: boolean
}

export class CompactChat {
  private saved: Saved | null = null

  constructor(
    private readonly d: {
      window: () => BrowserWindowType | null
      workArea: () => Rectangle
      /** Où est la bulle en ce moment (le chat s'ouvre à côté d'elle, où qu'elle ait été posée). */
      anchor?: () => Rectangle | null
      /** Dit à la page de la fenêtre qu'elle est (ou n'est plus) en chat compact. */
      notify: (compact: boolean) => void
    }
  ) {}

  get active(): boolean {
    return this.saved !== null
  }

  /** Le chat est ouvert et visible (pas réduit) : un nouveau clic sur la bulle le referme. */
  get open(): boolean {
    const win = this.d.window()

    return this.saved !== null && Boolean(win) && win!.isVisible() && !win!.isMinimized()
  }

  enter(): void {
    const win = this.d.window()

    if (!win) {
      return
    }

    if (!this.saved) {
      this.saved = { bounds: win.getNormalBounds(), maximized: win.isMaximized(), fullscreen: win.isFullScreen() }
    }

    if (win.isFullScreen()) {
      win.setFullScreen(false)
    }

    if (win.isMaximized()) {
      win.unmaximize()
    }

    if (win.isMinimized()) {
      win.restore()
    }

    win.setBounds(compactBounds(this.d.workArea(), this.d.anchor?.()))
    win.setAlwaysOnTop(true, 'floating')
    win.setOpacity(COMPACT_OPACITY)
    this.d.notify(true)
    win.show()
    win.focus()
  }

  /** Rend la fenêtre d'avant. Sans état gardé, ne fait rien. */
  leave(): void {
    const win = this.d.window()
    const saved = this.saved
    this.saved = null

    if (!win || !saved) {
      return
    }

    win.setAlwaysOnTop(false)
    win.setOpacity(1)
    win.setBounds(saved.bounds)

    if (saved.maximized) {
      win.maximize()
    }

    if (saved.fullscreen) {
      win.setFullScreen(true)
    }

    this.d.notify(false)
    win.show()
    win.focus()
  }
}
