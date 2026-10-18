import { IconRefresh } from '@tabler/icons-react'
import { useRef } from 'react'
import { SITES, type SiteId } from '../../../shared/web-sites.ts'
import { GlassButton } from '../../components/ui/glass.tsx'
import { Spinner } from '../../components/ui/primitives.tsx'
import { useT } from '../../lib/i18n.ts'
import { useSiteView } from './site-views.ts'
import { SiteSurface } from './SiteSurface.tsx'

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
