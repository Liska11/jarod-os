/**
 * The back gesture, one layer at a time. Every layer that is open (a sheet, a dialog, a sub-page, the
 * live screen) sits on a stack; on Android the activity asks the page, through `window.__jarodBack()`
 * (MainActivity.java), before it lets the app leave: the top layer closes and the gesture is used up.
 * Only an empty stack lets the app go. The keyboard needs nothing here: Android closes it before the
 * gesture reaches the page.
 *
 * No browser history is involved on purpose: a WebView skips history entries a page adds without a
 * tap (its protection against pages that hijack the back button), so they cannot be relied on.
 */
interface Layer {
  close: () => void
}

const stack: Layer[] = []

/** Closes the top layer. True when there was one (the gesture is used), false when the app may leave. */
export function goBack(): boolean {
  const top = stack.pop()
  if (!top) return false
  top.close()
  return true
}

let installed = false

/** Opens a layer. `close` runs when the gesture dismisses it. Returns what to call when the page closes it. */
export function openLayer(close: () => void): () => void {
  if (!installed) {
    ;(window as unknown as { __jarodBack?: () => boolean }).__jarodBack = goBack
    installed = true
  }
  const layer: Layer = { close }
  stack.push(layer)
  return () => {
    const at = stack.indexOf(layer)
    if (at >= 0) stack.splice(at, 1)
  }
}

/** The native side asks even when no layer was ever opened: the hook exists from the start. */
export function installBackHook(): void {
  ;(window as unknown as { __jarodBack?: () => boolean }).__jarodBack = goBack
  installed = true
}

/** How many layers are open (the tests, and the diagnostics). */
export const openLayers = (): number => stack.length
