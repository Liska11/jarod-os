import { useStore } from '@nanostores/react'
import { IconArrowLeft, IconArrowRight, IconHome, IconRefresh } from '@tabler/icons-react'
import { useEffect, useRef, useState } from 'react'
import { SITES, addressToUrl } from '../../../shared/web-sites.ts'
import { GlassButton } from '../../components/ui/glass.tsx'
import { Spinner } from '../../components/ui/primitives.tsx'
import { useT } from '../../lib/i18n.ts'
import { $browserRequest, $siteViews, openSiteView, useSiteView } from './site-views.ts'
import { SiteSurface } from './SiteSurface.tsx'

function go(url: string): void {
  const id = $siteViews.get().browser?.id

  if (id) {
    void window.jarodOS.web.navigate(id, url).catch(() => undefined)
  }
}

/** The browser in the right pane: the web beside the chat, searched with Brave Search. */
export function BrowserView({ active }: { active: boolean }) {
  const { t } = useT()
  const surface = useRef<HTMLDivElement>(null)
  const state = useSiteView('browser', surface, active)
  const request = useStore($browserRequest)
  const [address, setAddress] = useState('')
  const [editing, setEditing] = useState(false)

  // The address bar follows the page unless the person is typing in it.
  useEffect(() => {
    if (!editing) {
      setAddress(state.url)
    }
  }, [state.url, editing])

  // A link out of a Social or Messaging app: open the view if needed, then show the page.
  useEffect(() => {
    if (!request) {
      return
    }

    if (state.id) {
      $browserRequest.set(null)
      go(request)
    } else {
      void openSiteView('browser')
    }
  }, [request, state.id])

  const submit = () => {
    const url = addressToUrl(address)

    if (url) {
      go(url)
      setEditing(false)
      ;(document.activeElement as HTMLElement | null)?.blur()
    }
  }

  return (
    <div className={active ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
      <div className="flex items-center gap-1 border-b border-line px-2 py-1.5">
        <GlassButton size="icon" variant="ghost" aria-label={t('sites.back')} disabled={!state.canGoBack} onClick={() => state.id && void window.jarodOS.web.history(state.id, 'back')}>
          <IconArrowLeft />
        </GlassButton>
        <GlassButton size="icon" variant="ghost" aria-label={t('sites.forward')} disabled={!state.canGoForward} onClick={() => state.id && void window.jarodOS.web.history(state.id, 'forward')}>
          <IconArrowRight />
        </GlassButton>
        <GlassButton size="icon" variant="ghost" aria-label={t('sites.reload')} disabled={!state.id} onClick={() => state.id && void window.jarodOS.web.reload(state.id)}>
          {state.loading ? <Spinner /> : <IconRefresh />}
        </GlassButton>
        <GlassButton size="icon" variant="ghost" aria-label={t('sites.home')} disabled={!state.id} onClick={() => go(SITES.browser.home)}>
          <IconHome />
        </GlassButton>
        <input
          value={address}
          onChange={event => setAddress(event.target.value)}
          onFocus={event => {
            setEditing(true)
            event.target.select()
          }}
          onBlur={() => setEditing(false)}
          onKeyDown={event => {
            if (event.key === 'Enter') {
              submit()
            }

            if (event.key === 'Escape') {
              setAddress(state.url)
              ;(event.target as HTMLInputElement).blur()
            }
          }}
          placeholder={t('sites.address')}
          aria-label={t('sites.address')}
          spellCheck={false}
          className="glass-input h-8 min-w-0 flex-1 rounded-lg px-3 text-[12.5px] outline-none"
        />
      </div>
      <SiteSurface ref={surface} state={state} name={t('app.browser')} />
    </div>
  )
}
