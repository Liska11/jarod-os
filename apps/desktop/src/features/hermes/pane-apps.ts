import { atom } from 'nanostores'
import type { SiteId } from '../../../shared/web-sites.ts'
import { showPage } from '../../store/windows.ts'
import { $paneTab } from './artifact-store.ts'

/*
 * Apps that open as tabs of the Hermes page's right pane, beside Preview and Sources, so they stay in sight while the
 * person talks with the assistant: the browser, TikTok, Instagram, the player, MovieBox, Telegram, WhatsApp and Signal. The
 * sidebar's Apps and Messaging sections open them; an app's tab can be closed (its view stays signed in, hidden).
 */

export type PaneApp = SiteId | 'signal' | 'player' | 'moviebox' | 'vlc'

/** The sidebar's Apps section, then its Messaging section. */
export const APPS_SECTION: readonly PaneApp[] = ['browser', 'tiktok', 'instagram', 'player', 'moviebox']
export const MESSAGING_SECTION: readonly PaneApp[] = ['telegram', 'whatsapp', 'signal']

/** VLC is not in the sidebar: the player opens it for a file it cannot play itself. */
export const PANE_APPS: readonly PaneApp[] = [...APPS_SECTION, ...MESSAGING_SECTION, 'vlc']

/** Desktop apps whose own window sits in the tab (electron/platform/window-embed.ts). */
export const EMBEDDED_APPS: readonly PaneApp[] = ['signal', 'moviebox', 'vlc']

/** The file VLC's tab opens (the player's fallback). */
export const $vlcTarget = atom<string | null>(null)

export function openInVlc(file: string): void {
  $vlcTarget.set(file)
  openPaneApp('vlc')
}

export const isPaneApp = (value: unknown): value is PaneApp => typeof value === 'string' && (PANE_APPS as readonly string[]).includes(value)

const STORE_KEY = 'jarod.pane.apps'

function load(): PaneApp[] {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) ?? '[]')

    return Array.isArray(saved) ? saved.filter(isPaneApp) : []
  } catch {
    return []
  }
}

function save(apps: PaneApp[]): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(apps))
  } catch {
    // The open tabs are a convenience: without storage the pane starts with Preview and Sources only.
  }
}

/** The app tabs open in the pane, in the order they were opened. */
export const $paneApps = atom<PaneApp[]>(load())

/** Bumped when an app asks to be seen: the split brings the pane back if it was pulled away. */
export const $paneReveal = atom(0)

/** Open `app` in the right pane beside the chat (the Hermes page) and show it. */
export function openPaneApp(app: PaneApp): void {
  if (!$paneApps.get().includes(app)) {
    const next = [...$paneApps.get(), app]
    $paneApps.set(next)
    save(next)
  }

  $paneTab.set(app)
  $paneReveal.set($paneReveal.get() + 1)
  showPage('hermes')
}

/** Close an app's tab; the pane goes back to Preview when it was the one showing. */
export function closePaneApp(app: PaneApp): void {
  // A desktop app's window gets its frame back when its tab closes.
  if (EMBEDDED_APPS.includes(app)) {
    void window.heraldOS.nativeApps.release(app).catch(() => undefined)
  }

  const next = $paneApps.get().filter(item => item !== app)
  $paneApps.set(next)
  save(next)

  if ($paneTab.get() === app) {
    $paneTab.set('preview')
  }
}
