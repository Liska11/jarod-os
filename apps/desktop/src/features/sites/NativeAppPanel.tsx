import { useStore } from '@nanostores/react'
import { IconAlertTriangle, IconDownload, IconPlayerPlay, IconStack2 } from '@tabler/icons-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { WebViewBounds } from '../../../shared/ipc.ts'
import type { NativeAppId } from '../../../shared/web-sites.ts'
import { EmptyGlass, GlassButton } from '../../components/ui/glass.tsx'
import { Spinner } from '../../components/ui/primitives.tsx'
import { useT } from '../../lib/i18n.ts'
import { $windows, MAIN_WINDOW_ID, type OSWindow } from '../../store/windows.ts'
import { useNativeView } from '../web/native-view.ts'
import { useNativeApp } from './native-app.ts'

type Phase = 'idle' | 'opening' | 'embedded' | 'gone' | 'error'

const clean = (reason: unknown): string => (reason instanceof Error ? reason.message : String(reason)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/**
 * A desktop app inside the right pane (Signal, MovieBox, VLC): its own window, frameless, kept exactly over this tab
 * (electron/platform/window-embed.ts). The first time the tab shows, the app starts (or its running window is taken);
 * `target` is a file to open (VLC). When the app is missing it is installed with winget when it can be (`installable`).
 */
export function NativeAppPanel({ app, name, icon, installable, active, target }: { app: NativeAppId; name: string; icon: React.ReactNode; installable: boolean; active: boolean; target?: string | null }) {
  const { t } = useT()
  const native = useNativeApp(app, name)
  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState<string | null>(null)
  const surface = useRef<HTMLDivElement>(null)
  const main = useStore($windows)[MAIN_WINDOW_ID]
  const win: OSWindow = main ?? ({ id: MAIN_WINDOW_ID, phase: 'closing', z: 0, bounds: { x: 0, y: 0, width: 0, height: 0 } } as OSWindow)
  const embedded = phase === 'embedded'
  const place = useCallback((bounds: WebViewBounds, visible: boolean) => window.heraldOS.nativeApps.place(app, bounds, visible), [app])
  const { visible, covered, occluded } = useNativeView(embedded ? app : null, surface, win, { active: active && embedded, followFrameRadius: false, place })
  const lastTarget = useRef<string | null>(null)

  const open = useCallback(
    (file?: string | null) => {
      setPhase('opening')
      setError(null)
      window.heraldOS.nativeApps
        .embed(app, file ?? undefined)
        .then(() => setPhase('embedded'))
        .catch((reason: unknown) => {
          setError(clean(reason))
          setPhase('error')
        })
    },
    [app]
  )

  // The first time the tab shows with the app installed, bring it in; a new file for VLC goes to it too.
  useEffect(() => {
    if (!active || !native.installed) {
      return
    }

    const fresh = target && target !== lastTarget.current

    if (phase === 'idle' || fresh) {
      lastTarget.current = target ?? null
      open(target)
    }
  }, [active, native.installed, phase, target, open])

  useEffect(
    () =>
      window.heraldOS.nativeApps.onGone(gone => {
        if (gone === app) {
          setPhase('gone')
        }
      }),
    [app]
  )

  // Hidden tab: the window hides with it (useNativeView only reports while the tab is active).
  useEffect(() => {
    if (embedded && !active) {
      window.heraldOS.nativeApps.place(app, { x: 0, y: 0, width: 1, height: 1 }, false)
    }
  }, [embedded, active, app])

  if (!active) {
    return null
  }

  if (embedded) {
    return (
      <div ref={surface} className="relative min-h-0 flex-1 overflow-hidden rounded-b-xl bg-black/30">
        {!visible && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center text-[12.5px] text-fg-3">
            <IconStack2 className="size-7" />
            <span>{covered || occluded ? t('sites.covered', { name }) : t('sites.loading', { name })}</span>
          </div>
        )}
      </div>
    )
  }

  const description =
    phase === 'opening'
      ? t('sites.native.waiting', { name })
      : phase === 'gone'
        ? t('sites.native.gone', { name })
        : (error ?? native.error ?? (native.installed === false ? t(installable ? 'sites.native.missing' : 'sites.native.missingManual', { name }) : t('sites.native.hint', { name })))

  return (
    <div className="flex flex-1 items-center justify-center p-4">
      <EmptyGlass
        className="w-full max-w-lg"
        icon={phase === 'error' ? <IconAlertTriangle /> : icon}
        title={name}
        description={description}
        action={
          native.installed === null || phase === 'opening' ? (
            <Spinner />
          ) : native.installed ? (
            <GlassButton variant="primary" onClick={() => open(target)}>
              <IconPlayerPlay />
              {t('sites.native.open', { name })}
            </GlassButton>
          ) : installable ? (
            <GlassButton variant="primary" disabled={native.installing} onClick={() => void native.install()}>
              {native.installing ? <Spinner /> : <IconDownload />}
              {native.installing ? t('sites.native.installing', { name }) : t('sites.native.install', { name })}
            </GlassButton>
          ) : null
        }
      />
    </div>
  )
}
