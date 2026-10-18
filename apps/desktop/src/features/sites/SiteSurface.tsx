import { IconAlertTriangle, IconStack2 } from '@tabler/icons-react'
import { forwardRef } from 'react'
import { Spinner } from '../../components/ui/primitives.tsx'
import { useT } from '../../lib/i18n.ts'
import type { SiteViewState } from './site-views.ts'

/**
 * Where a site's native view sits. The view paints above the DOM, so this area only shows through while it is hidden:
 * loading, an error, or a window / panel covering it.
 */
export const SiteSurface = forwardRef<HTMLDivElement, { state: SiteViewState & { visible: boolean; covered: boolean }; name: string }>(function SiteSurface({ state, name }, ref) {
  const { t } = useT()

  return (
    <div ref={ref} className="relative min-h-0 flex-1 overflow-hidden rounded-b-xl bg-white/[0.03]">
      {!state.visible && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center text-[12.5px] text-fg-3">
          {state.error && !state.id ? (
            <>
              <IconAlertTriangle className="size-7 text-warn" />
              <span>{t('sites.error', { name })}</span>
              <span className="max-w-md text-[11.5px] text-fg-4">{state.error}</span>
            </>
          ) : state.covered ? (
            <>
              <IconStack2 className="size-7" />
              <span>{t('sites.covered', { name })}</span>
            </>
          ) : (
            <>
              <Spinner />
              <span>{t('sites.loading', { name })}</span>
            </>
          )}
        </div>
      )}
      {state.visible && state.error && <div className="absolute inset-x-0 top-0 z-10 bg-warn/15 px-3 py-1.5 text-[11.5px] text-warn">{state.error}</div>}
    </div>
  )
})
