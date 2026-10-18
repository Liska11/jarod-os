import { useStore } from '@nanostores/react'
import { IconBrandInstagram, IconBrandTiktok, IconRefresh } from '@tabler/icons-react'
import { atom } from 'nanostores'
import { useRef } from 'react'
import { SITES, SOCIAL_SITES, type SiteId } from '../../../shared/web-sites.ts'
import { GlassButton, Tabs } from '../../components/ui/glass.tsx'
import { Spinner } from '../../components/ui/primitives.tsx'
import { useT } from '../../lib/i18n.ts'
import { $page } from '../../store/windows.ts'
import { useSiteView } from './site-views.ts'
import { SiteSurface } from './SiteSurface.tsx'

const ICONS: Partial<Record<SiteId, React.ReactNode>> = { tiktok: <IconBrandTiktok />, instagram: <IconBrandInstagram /> }

const STORE_KEY = 'jarod.social.tab'

function initialTab(): SiteId {
  try {
    const saved = localStorage.getItem(STORE_KEY)

    return SOCIAL_SITES.find(site => site === saved) ?? SOCIAL_SITES[0]
  } catch {
    return SOCIAL_SITES[0]
  }
}

const $socialTab = atom<SiteId>(initialTab())

function choose(site: SiteId): void {
  $socialTab.set(site)

  try {
    localStorage.setItem(STORE_KEY, site)
  } catch {
    // The tab is a convenience; without storage it starts on the first one.
  }
}

/** The Social page: TikTok and Instagram, each signed in in its own session. */
export function SocialPage() {
  const tab = useStore($socialTab)
  const pageActive = useStore($page) === 'social'

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b border-line px-3 py-2">
        <Tabs tabs={SOCIAL_SITES.map(id => ({ id, label: SITES[id].name, icon: ICONS[id] }))} value={tab} onChange={choose} />
      </div>
      {SOCIAL_SITES.map(site => (
        <SiteTab key={site} site={site} active={pageActive && tab === site} />
      ))}
    </div>
  )
}

/** One site's surface; only the active one takes room, the others keep their view open and hidden. */
export function SiteTab({ site, active, toolbar = true }: { site: SiteId; active: boolean; toolbar?: boolean }) {
  const { t } = useT()
  const surface = useRef<HTMLDivElement>(null)
  const state = useSiteView(site, surface, active)

  return (
    <div className={active ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
      {toolbar && (
        <div className="flex items-center gap-2 px-3 py-1.5 text-[11.5px] text-fg-3">
          <span className="min-w-0 flex-1 truncate">{state.title || SITES[site].name}</span>
          <GlassButton size="sm" variant="ghost" aria-label={t('sites.reload')} disabled={!state.id} onClick={() => state.id && void window.heraldOS.web.reload(state.id)}>
            {state.loading ? <Spinner /> : <IconRefresh />}
          </GlassButton>
        </div>
      )}
      <SiteSurface ref={surface} state={state} name={SITES[site].name} />
    </div>
  )
}
