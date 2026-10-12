import { useStore } from '@nanostores/react'
import { memo, useCallback, useEffect, useRef } from 'react'
import { SurfaceErrorBoundary } from '../../components/error-boundary.tsx'
import { cn } from '../../lib/cn.ts'
import { type Edge, resizeBounds } from '../../lib/window-geometry.ts'
import { $focusedWindowId, closeWindow, desktopArea, focusWindow, MAIN_WINDOW_ID, minimizeWindow, minSizeOf, type OSWindow, setBounds, toggleMaximize } from '../../store/windows.ts'

const EDGES: Edge[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']
// The handles sit on the frame's outline, 4px outside it: the frame clips its children to its rounded corners,
// which left the corner handles almost out of reach. The corners come last so they win over the edges.
const EDGE_CLASS: Record<Edge, string> = {
  n: '-top-1 left-5 right-5 h-2 cursor-ns-resize',
  s: '-bottom-1 left-5 right-5 h-2 cursor-ns-resize',
  e: '-right-1 top-5 bottom-5 w-2 cursor-ew-resize',
  w: '-left-1 top-5 bottom-5 w-2 cursor-ew-resize',
  ne: '-top-1 -right-1 size-6 cursor-nesw-resize',
  nw: '-top-1 -left-1 size-6 cursor-nwse-resize',
  se: '-right-1 -bottom-1 size-6 cursor-nwse-resize',
  sw: '-bottom-1 -left-1 size-6 cursor-nesw-resize'
}

/**
 * A floating glass window. Drag on the titlebar, resize on the edges, focus on pointer-down.
 * Content stays mounted while minimized (visibility is not lifecycle).
 */
export const Window = memo(function Window({ win, children, chrome = true }: { win: OSWindow; children: React.ReactNode; chrome?: boolean }) {
  const focusedId = useStore($focusedWindowId)
  const focused = focusedId === win.id
  const frame = useRef<HTMLDivElement>(null)
  const gesture = useRef<{ kind: 'move' | 'resize'; edge?: Edge; startX: number; startY: number; start: OSWindow['bounds']; raf: number; pending: OSWindow['bounds'] | null } | null>(null)

  const onPointerMove = useCallback(
    (event: PointerEvent) => {
      const g = gesture.current

      if (!g) {
        return
      }

      const dx = event.clientX - g.startX
      const dy = event.clientY - g.startY
      // A resize keeps the edge opposite the one held where it is; a move keeps the size (the store brings it back inside the desktop).
      const next = g.kind === 'move' || !g.edge ? { ...g.start, x: g.start.x + dx, y: g.start.y + dy } : resizeBounds(g.start, g.edge, dx, dy, desktopArea(), minSizeOf(win.appId))

      g.pending = next

      if (!g.raf) {
        g.raf = requestAnimationFrame(() => {
          if (gesture.current?.pending) {
            setBounds(win.id, gesture.current.pending)
          }

          if (gesture.current) {
            gesture.current.raf = 0
          }
        })
      }
    },
    [win.id, win.appId]
  )

  const endGesture = useCallback(() => {
    const g = gesture.current
    gesture.current = null
    window.removeEventListener('pointermove', onPointerMove)
    window.removeEventListener('pointerup', endGesture)
    window.removeEventListener('pointercancel', endGesture)
    document.body.style.cursor = ''

    if (g?.pending) {
      setBounds(win.id, g.pending, true)
    }
  }, [onPointerMove, win.id])

  const startGesture = (event: React.PointerEvent, kind: 'move' | 'resize', edge?: Edge) => {
    if (event.button !== 0 || (win.maximized && kind === 'resize')) {
      return
    }

    focusWindow(win.id)
    gesture.current = { kind, edge, startX: event.clientX, startY: event.clientY, start: win.bounds, raf: 0, pending: null }
    // Held by the element that started it: the gesture follows the pointer over the page, and ends if the system takes the pointer away.
    event.currentTarget.setPointerCapture?.(event.pointerId)
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', endGesture)
    window.addEventListener('pointercancel', endGesture)
    event.preventDefault()
  }

  useEffect(() => () => endGesture(), [endGesture])

  const hidden = win.phase === 'minimized'
  const main = win.id === MAIN_WINDOW_ID

  return (
    <div
      className={cn('absolute', hidden && 'invisible pointer-events-none')}
      style={{ left: win.bounds.x, top: win.bounds.y, width: win.bounds.width, height: win.bounds.height, zIndex: win.z, willChange: gesture.current ? 'left, top, width, height' : undefined }}
    >
      <div
        ref={frame}
        role="dialog"
        aria-label={win.title}
        data-window-id={win.id}
        onPointerDownCapture={() => {
          if (!focused) {
            focusWindow(win.id)
          }
        }}
        className={cn(
          'glass absolute inset-0 flex flex-col overflow-hidden rounded-2xl',
          win.phase === 'opening' && 'window-enter',
          win.phase === 'closing' && 'window-leave',
          win.phase === 'minimizing' && 'window-minimize',
          !focused && !hidden && 'opacity-95',
          focused ? 'border-line-strong' : 'border-line'
        )}
      >
        {chrome && (
          <div
            className="flex h-10 shrink-0 items-center gap-3 px-3 select-none"
            onPointerDown={event => {
              if ((event.target as HTMLElement).closest('button')) {
                return
              }

              if (!win.maximized || main) {
                startGesture(event, 'move')
              }
            }}
            onDoubleClick={() => toggleMaximize(win.id)}
          >
            <div className="group flex items-center gap-2">
              <TrafficLight color="#ff5f57" label={main ? 'Hide' : 'Close'} onClick={() => closeWindow(win.id)} glyph="×" />
              <TrafficLight color="#febc2e" label="Minimize" onClick={() => minimizeWindow(win.id)} glyph="–" />
              <TrafficLight color="#28c840" label="Zoom" onClick={() => toggleMaximize(win.id)} glyph="+" />
            </div>
            <div className={cn('min-w-0 flex-1 truncate text-center text-[12.5px] font-medium', focused ? 'text-fg' : 'text-fg-3')}>{win.title}</div>
            <div className="w-[62px]" />
          </div>
        )}
        <div className="relative min-h-0 flex-1">
          <SurfaceErrorBoundary label={win.title}>{children}</SurfaceErrorBoundary>
        </div>
      </div>
      {!win.maximized && win.phase !== 'closing' && EDGES.map(edge => <div key={edge} data-resize-edge={edge} className={cn('absolute z-10', EDGE_CLASS[edge])} onPointerDown={event => startGesture(event, 'resize', edge)} />)}
    </div>
  )
})

function TrafficLight({ color, label, onClick, glyph }: { color: string; label: string; onClick: () => void; glyph: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={event => {
        event.stopPropagation()
        onClick()
      }}
      className="flex size-3 items-center justify-center rounded-full text-[9px] leading-none font-bold text-black/0 shadow-[inset_0_0_0_1px_rgba(0,0,0,.15)] transition-colors group-hover:text-black/60"
      style={{ background: color }}
    >
      {glyph}
    </button>
  )
}
