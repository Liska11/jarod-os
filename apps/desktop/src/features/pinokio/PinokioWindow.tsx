import { useStore } from '@nanostores/react'
import { IconFolder, IconHome, IconPlayerPlay, IconPlayerStop, IconRefresh } from '@tabler/icons-react'
import { useEffect, useRef, useState } from 'react'
import { AppTile } from '../../components/app-icon.tsx'
import { GlassButton } from '../../components/ui/glass.tsx'
import { Spinner } from '../../components/ui/primitives.tsx'
import { cn } from '../../lib/cn.ts'
import { type MessageKey, t, useT } from '../../lib/i18n.ts'
import { $pinokio, bindPinokio, startPinokio, stopPinokio } from '../../store/pinokio.ts'
import { $webWindows, adoptWebView } from '../../store/web-windows.ts'
import type { OSWindow } from '../../store/windows.ts'
import { useNativeView } from '../web/native-view.ts'

/*
 * The Pinokio window (ADR-022): a slim bar (engine state, home, reload, folder, start/stop) over the engine's own UI,
 * which is a web view main owns (ipc/web.ts openPinokio). Opened with `payload.url`, it shows one page instead (an AI
 * app's UI on this computer). While the engine is not up, the content area explains why and offers to start it.
 */

const PHASE_TONE: Record<string, string> = {
  running: 'bg-ok',
  external: 'bg-ok',
  starting: 'bg-warn animate-pulse',
  stopping: 'bg-warn animate-pulse',
  error: 'bg-danger',
  stopped: 'bg-fg-4',
  unavailable: 'bg-fg-4'
}

export function PinokioWindow({ win }: { win: OSWindow }) {
  useT()
  const state = useStore($pinokio)
  const webWindows = useStore($webWindows)
  const pageUrl = typeof win.payload?.url === 'string' ? win.payload.url : null
  const [viewId, setViewId] = useState<string | null>(null)
  const [opening, setOpening] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Stopped from this window: wait for Start instead of starting the engine again right away.
  const [held, setHeld] = useState(false)
  const content = useRef<HTMLDivElement>(null)
  const entry = viewId ? webWindows[viewId] : undefined
  const { visible, covered, occluded } = useNativeView(viewId, content, win, { active: Boolean(entry) })
  const up = state.phase === 'running' || state.phase === 'external'

  useEffect(() => bindPinokio(), [])

  // Open the view once the engine answers (starting it if needed); the frame's closing takes the view with it.
  useEffect(() => {
    if (viewId || opening || held || win.phase === 'closing' || state.phase === 'unavailable' || state.phase === 'stopping' || (state.phase === 'error' && error)) {
      return
    }

    if (!up && state.phase !== 'stopped' && state.phase !== 'error') {
      return
    }

    setOpening(true)
    setError(null)
    window.heraldOS.pinokio
      .openView(pageUrl ?? undefined, { title: pageUrl ? undefined : t('pinokio.title') })
      .then(id => {
        adoptWebView(id, win.id, pageUrl ?? state.url, pageUrl ? win.title : t('pinokio.title'), !pageUrl)
        setViewId(id)
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(reason)))
      .finally(() => setOpening(false))
  }, [viewId, opening, held, up, state.phase, state.url, pageUrl, win.id, win.phase, win.title, error])

  // The engine stopped under the view: forget it, so starting again opens a fresh one.
  useEffect(() => {
    if (viewId && (state.phase === 'stopped' || state.phase === 'unavailable')) {
      void window.heraldOS.web.close(viewId).catch(() => undefined)
      setViewId(null)
    }
  }, [viewId, state.phase])

  const retry = () => {
    setError(null)
    setHeld(false)
    void startPinokio().catch((reason: unknown) => setError(String(reason)))
  }

  const stop = () => {
    setHeld(true)
    void stopPinokio().catch(() => undefined)
  }

  const phaseLabel = t(`pinokio.phase.${state.phase}` as MessageKey)
  const hint = error ?? (state.phase === 'unavailable' ? t('pinokio.unavailable.hint') : state.phase === 'starting' || opening ? t('pinokio.starting.hint') : state.phase === 'error' ? (state.error ?? '') : t('pinokio.stopped.hint'))

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-line px-3 text-[11.5px]">
        <span className={cn('size-2 shrink-0 rounded-full', PHASE_TONE[state.phase] ?? 'bg-fg-4')} aria-hidden="true" />
        <span className="truncate text-fg-2" title={state.version ? `pinokiod ${state.version}` : undefined}>
          {phaseLabel}
          {state.version && <span className="text-fg-4"> · {state.version}</span>}
        </span>
        {entry?.loading && <Spinner className="ml-1 shrink-0" />}
        <div className="ml-auto flex items-center gap-0.5">
          {!pageUrl && viewId && (
            <BarButton label={t('pinokio.home')} onClick={() => void window.heraldOS.web.navigate(viewId, state.url).catch(() => undefined)}>
              <IconHome size={14} />
            </BarButton>
          )}
          {viewId && (
            <BarButton label={t('pinokio.reload')} onClick={() => void window.heraldOS.web.reload(viewId).catch(() => undefined)}>
              <IconRefresh size={14} />
            </BarButton>
          )}
          {state.home && (
            <BarButton label={t('pinokio.folder')} onClick={() => void window.heraldOS.pinokio.openHome().catch(() => undefined)}>
              <IconFolder size={14} />
            </BarButton>
          )}
          {state.phase === 'running' && !pageUrl && (
            <BarButton label={t('pinokio.stop')} onClick={stop}>
              <IconPlayerStop size={14} />
            </BarButton>
          )}
        </div>
      </div>
      <div ref={content} className="relative min-h-0 flex-1 bg-black/20">
        {!visible && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-8 text-center text-[12.5px] text-fg-3">
            {viewId && entry ? (
              <span>{covered ? t('pinokio.hidden.covered') : occluded ? t('pinokio.hidden.occluded') : ''}</span>
            ) : (
              <>
                <AppTile id="pinokio" size={52} />
                <span className="text-[14px] font-medium text-fg">{t('pinokio.title')}</span>
                <span className="max-w-[420px]">{state.phase === 'external' ? t('pinokio.external.hint') : hint}</span>
                {(state.phase === 'starting' || opening) && <Spinner />}
                {(state.phase === 'error' || error) && state.bundled && (
                  <GlassButton size="sm" variant="primary" onClick={retry}>
                    {t('pinokio.retry')}
                  </GlassButton>
                )}
                {state.phase === 'stopped' && held && !opening && !error && (
                  <GlassButton size="sm" variant="primary" onClick={retry}>
                    <IconPlayerPlay size={14} />
                    {t('pinokio.start')}
                  </GlassButton>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function BarButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} className="flex size-6 items-center justify-center rounded-md text-fg-3 hover:bg-white/8 hover:text-fg">
      {children}
    </button>
  )
}
