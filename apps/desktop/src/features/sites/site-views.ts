import { useStore } from '@nanostores/react'
import { atom, map } from 'nanostores'
import { type RefObject, useEffect } from 'react'
import type { WebViewEvent } from '../../../shared/ipc.ts'
import type { SiteId } from '../../../shared/web-sites.ts'
import { $windows, MAIN_WINDOW_ID, type OSWindow, showPage } from '../../store/windows.ts'
import { useNativeView } from '../web/native-view.ts'

/*
 * The Browser and Social pages: one native view per site (electron/ipc/web.ts openSite), opened the first time its page
 * shows and kept afterwards, so a conversation or a video carries on while another page is up. A site's link that
 * leaves it opens in the Browser page.
 */

export interface SiteViewState {
  id: string | null
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  error: string | null
}

const EMPTY: SiteViewState = { id: null, url: '', title: '', loading: false, canGoBack: false, canGoForward: false, error: null }

export const $siteViews = map<Partial<Record<SiteId, SiteViewState>>>({})

/** A page the Browser should show (a link out of a Social app); the Browser page takes it and clears it. */
export const $browserRequest = atom<string | null>(null)

const opening = new Set<SiteId>()
let bound = false

function siteOf(viewId: string): SiteId | null {
  for (const [site, state] of Object.entries($siteViews.get())) {
    if (state?.id === viewId) {
      return site as SiteId
    }
  }

  return null
}

function patch(site: SiteId, next: Partial<SiteViewState>): void {
  $siteViews.setKey(site, { ...EMPTY, ...$siteViews.get()[site], ...next })
}

export function onSiteEvent(event: WebViewEvent): void {
  const site = siteOf(event.id)

  if (!site) {
    return
  }

  switch (event.type) {
    case 'title':
      patch(site, { title: event.title })

      return
    case 'url':
      patch(site, { url: event.url, error: null })

      return
    case 'loading':
      patch(site, { loading: event.loading, ...(event.loading ? { error: null } : {}) })

      return
    case 'history':
      patch(site, { canGoBack: event.canGoBack, canGoForward: event.canGoForward })

      return
    case 'error':
      patch(site, { error: event.error, loading: false })

      return
    case 'external':
      openInBrowser(event.url)

      return
    case 'closed':
      $siteViews.setKey(site, undefined)

      return
    default:
      return
  }
}

function bind(): void {
  if (!bound) {
    bound = true
    window.heraldOS.web.onEvent(onSiteEvent)
  }
}

export async function openSiteView(site: SiteId): Promise<void> {
  if ($siteViews.get()[site]?.id || opening.has(site)) {
    return
  }

  bind()
  opening.add(site)

  try {
    const id = await window.heraldOS.web.openSite(site)
    patch(site, { id, loading: true })
  } catch (reason) {
    patch(site, { error: reason instanceof Error ? reason.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(reason) })
  } finally {
    opening.delete(site)
  }
}

/** Show a page in the Browser page (a link a Social app cannot show itself). */
export function openInBrowser(url: string): void {
  $browserRequest.set(url)
  showPage('browser')
}

/**
 * Keep `site`'s view over `element` while `active` (its page and tab are the ones showing). The view opens the first
 * time it is active and stays open, hidden, afterwards.
 */
export function useSiteView(site: SiteId, element: RefObject<HTMLElement | null>, active: boolean): SiteViewState & { visible: boolean; covered: boolean } {
  const state = useStore($siteViews)[site] ?? EMPTY
  const main = useStore($windows)[MAIN_WINDOW_ID]

  useEffect(() => {
    if (active) {
      void openSiteView(site)
    }
  }, [active, site])

  // The main window always exists while a page renders; without it the view simply stays hidden.
  const win: OSWindow = main ?? ({ id: MAIN_WINDOW_ID, phase: 'closing', z: 0, bounds: { x: 0, y: 0, width: 0, height: 0 } } as OSWindow)
  const { visible, covered, occluded } = useNativeView(state.id, element, win, { active: active && Boolean(main), followFrameRadius: false })

  return { ...state, visible, covered: covered || occluded }
}
