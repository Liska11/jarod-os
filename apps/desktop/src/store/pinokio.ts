import { atom } from 'nanostores'
import type { PinokioState } from '../../shared/ipc.ts'
import { openWebWindow } from './web-windows.ts'
import { openApp } from './windows.ts'

/*
 * The Pinokio engine as the shell sees it (ADR-022): its state, mirrored from main, and where its pages open. The
 * engine's own UI is the `pinokio` window; an AI app's UI (a page on this computer the engine or its UI asks for) opens
 * as another `pinokio` window, which keeps the camera/microphone answer and sign-ins of the Pinokio partition; a link
 * that leaves this computer opens in an ordinary web window.
 */

export const $pinokio = atom<PinokioState>({ phase: 'stopped', url: 'http://127.0.0.1:42000', bundled: true, home: null })

let bound = false

/** Subscribe once to main's state pushes and page requests; refresh the state now. */
export function bindPinokio(): void {
  if (bound || !window.heraldOS?.pinokio) {
    return
  }

  bound = true
  window.heraldOS.pinokio.onState(state => $pinokio.set(state))
  window.heraldOS.pinokio.onOpenUrl(url => void showPinokioPage(url).catch(() => undefined))
  void window.heraldOS.pinokio
    .getState()
    .then(state => $pinokio.set(state))
    .catch(() => undefined)
}

/** A page on this computer (an app's UI, Pinokio's own pages). Mirrors electron/pinokio/guard.ts. */
export function isLocalPage(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url)
    const name = hostname.toLowerCase()

    return (protocol === 'http:' || protocol === 'https:') && (name === 'localhost' || name.endsWith('.localhost') || name === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name))
  } catch {
    return false
  }
}

/** Open the Pinokio window (its home page), or bring it forward. */
export function openPinokio(): string {
  bindPinokio()

  return openApp('pinokio')
}

/** Show `url`: a page on this computer in its own Pinokio window, anything else in a web window. */
export async function showPinokioPage(url: string): Promise<string> {
  bindPinokio()

  if (isLocalPage(url)) {
    let title = 'Pinokio'

    try {
      title = new URL(url).host
    } catch {
      // isLocalPage parsed it already.
    }

    return openApp('pinokio', { payload: { url }, title, singleton: false })
  }

  return openWebWindow(url)
}

/** Start the engine (or find the Pinokio app's); resolves with the resulting state. */
export async function startPinokio(): Promise<PinokioState> {
  bindPinokio()
  const state = await window.heraldOS.pinokio.start()
  $pinokio.set(state)

  return state
}

export async function stopPinokio(): Promise<PinokioState> {
  bindPinokio()
  const state = await window.heraldOS.pinokio.stop()
  $pinokio.set(state)

  return state
}
