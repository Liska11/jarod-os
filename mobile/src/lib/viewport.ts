/** The keyboard is "open" when the visible height has shrunk by more than this against the tallest seen. */
export const KEYBOARD_MIN_PX = 120

/** Pure: whether the visible height says the keyboard is up. */
export const keyboardOpen = (tallest: number, visible: number): boolean => tallest - visible > KEYBOARD_MIN_PX

/**
 * The tallest visible height seen at this width. A rotation changes the width: what was the tallest in
 * portrait says nothing in landscape, so the count starts again (or the shorter screen would read as a
 * keyboard).
 */
export function tallestAt(prev: { width: number; tallest: number }, width: number, visible: number): { width: number; tallest: number } {
  return width === prev.width ? { width, tallest: Math.max(prev.tallest, visible) } : { width, tallest: visible }
}

/**
 * Keeps `--app-h` at the visible height (the keyboard included) and `data-keyboard` on the root, so the
 * layout follows the keyboard whether the WebView resizes itself or only the visual viewport shrinks.
 * Returns what stops it.
 */
export function trackViewport(root: HTMLElement = document.documentElement): () => void {
  const vv = window.visualViewport
  let seen = { width: 0, tallest: 0 }
  const update = () => {
    const h = Math.round(vv?.height ?? window.innerHeight)
    seen = tallestAt(seen, window.innerWidth, Math.max(h, window.innerHeight))
    root.style.setProperty('--app-h', `${h}px`)
    root.dataset.keyboard = keyboardOpen(seen.tallest, h) ? '1' : '0'
  }
  update()
  const target: EventTarget = vv ?? window
  target.addEventListener('resize', update)
  window.addEventListener('resize', update)
  return () => {
    target.removeEventListener('resize', update)
    window.removeEventListener('resize', update)
  }
}
