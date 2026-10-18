import { useStore } from '@nanostores/react'
import { type RefObject, useLayoutEffect, useMemo } from 'react'
import { $viewAvoid, trimAround } from '../../store/view-avoid.ts'
import { $webViewsCovered, $webViewsPaused } from '../../store/web-windows.ts'
import { $windows, type Bounds, type OSWindow } from '../../store/windows.ts'
import type { WebViewBounds } from '../../../shared/ipc.ts'

const intersects = (a: Bounds, b: Bounds): boolean => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

/** Another window stacked above this one and overlapping it (a native view cannot sit under DOM). */
function isOccluded(win: OSWindow, windows: Record<string, OSWindow>): boolean {
  return Object.values(windows).some(other => other.id !== win.id && other.z > win.z && other.phase !== 'minimized' && other.phase !== 'minimizing' && other.phase !== 'closing' && intersects(other.bounds, win.bounds))
}

export interface NativeViewState {
  visible: boolean
  covered: boolean
  occluded: boolean
}

/**
 * Keep a native web view (owned by main) placed exactly over `element` inside window `win`. The view
 * shows only while the window is fully open and nothing the user needs sits above it (a Hermes panel,
 * a window stacked on top); it leaves room for the voice pill and action captions.
 */
export function useNativeView(viewId: string | null, element: RefObject<HTMLElement | null>, win: OSWindow, options: { active?: boolean; followFrameRadius?: boolean; place?: (bounds: WebViewBounds, visible: boolean) => void } = {}): NativeViewState {
  const windows = useStore($windows)
  const covered = useStore($webViewsCovered)
  const paused = useStore($webViewsPaused)
  const avoid = useStore($viewAvoid)
  const occluded = useMemo(() => isOccluded(win, windows), [win, windows])
  const active = options.active ?? true
  const visible = Boolean(viewId) && active && win.phase === 'open' && !covered && !occluded && !paused
  const followFrameRadius = options.followFrameRadius ?? true

  useLayoutEffect(() => {
    const node = element.current

    if (!viewId || !node) {
      return
    }

    const report = () => {
      const rect = node.getBoundingClientRect()
      // The view's corners follow the frame's radius so the page hugs the glass window's outline.
      const frame = followFrameRadius ? node.closest('[role="dialog"]') : null
      const radius = frame ? Number.parseFloat(getComputedStyle(frame).borderBottomLeftRadius) || 0 : 0
      // Leave room for the voice pill and action captions; a sliver of page is not worth showing.
      const trimmed = trimAround({ x: rect.left, y: rect.top, width: rect.width, height: rect.height }, Object.values(avoid))
      const show = visible && trimmed.height >= 60 && trimmed.width >= 60
      options.place ? options.place({ ...trimmed, radius }, show) : window.heraldOS.web.setBounds(viewId, { ...trimmed, radius }, show)
    }

    report()
    const observer = new ResizeObserver(report)
    observer.observe(node)
    window.addEventListener('resize', report)

    return () => {
      observer.disconnect()
      window.removeEventListener('resize', report)
    }
  }, [viewId, visible, avoid, element, followFrameRadius, options.place, win.bounds.x, win.bounds.y, win.bounds.width, win.bounds.height])

  return { visible, covered, occluded }
}
