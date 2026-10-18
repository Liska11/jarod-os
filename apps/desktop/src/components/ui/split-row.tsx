import { IconLayoutSidebarRightExpand } from '@tabler/icons-react'
import { type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { cn } from '../../lib/cn.ts'
import { DEFAULT_SPLIT, dragTo, leftWidth, nudge, parseSplit, type SplitLimits, type SplitState } from '../../lib/split.ts'
import { $webViewsPaused } from '../../store/web-windows.ts'

/** Width of the divider, which is also the gap between the panes. */
const DIVIDER = 16
const STEP = 24
const BIG_STEP = 96

function load(key: string): SplitState {
  try {
    return parseSplit(window.localStorage.getItem(key))
  } catch {
    return DEFAULT_SPLIT
  }
}

function save(key: string, state: SplitState): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(state))
  } catch {
    // Private window or blocked storage: the layout simply is not remembered.
  }
}

/**
 * Two panes side by side with a divider the person can drag (or move with the arrow keys). The right pane can be
 * pulled away entirely to give the left one the whole row; a tab at the right edge brings it back. The layout is
 * remembered on this device. While the divider is held, native web views are hidden: they would swallow the pointer.
 */
export function SplitRow({ storageKey, limits, left, right, rightLabel, reveal = 0 }: { storageKey: string; limits: SplitLimits; left: ReactNode; right: ReactNode; rightLabel: string; reveal?: number }) {
  const row = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [state, setState] = useState<SplitState>(() => load(storageKey))
  const [dragging, setDragging] = useState(false)
  const latest = useRef(state)
  latest.current = state

  useLayoutEffect(() => {
    const node = row.current

    if (!node) {
      return
    }

    const measure = () => setWidth(node.getBoundingClientRect().width)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)

    return () => observer.disconnect()
  }, [])

  useEffect(() => () => $webViewsPaused.set(false), [])

  // Something asked for the right pane (an app opened from the sidebar): bring it back if it was pulled away.
  useEffect(() => {
    if (reveal > 0 && latest.current.collapsed) {
      setState(DEFAULT_SPLIT)
      save(storageKey, DEFAULT_SPLIT)
    }
  }, [reveal, storageKey])

  // The room for the panes: the row without the divider (nothing is shown between them when the right pane is hidden).
  const showDivider = !state.collapsed || dragging
  const total = Math.max(0, width - (showDivider ? DIVIDER : 0))
  const leftPx = leftWidth(total, state, limits)

  const apply = useCallback(
    (next: SplitState, persist: boolean) => {
      setState(next)

      if (persist) {
        save(storageKey, next)
      }
    },
    [storageKey]
  )

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) {
      return
    }

    const node = row.current
    const target = event.currentTarget

    if (!node) {
      return
    }

    target.setPointerCapture?.(event.pointerId)
    $webViewsPaused.set(true)
    setDragging(true)
    event.preventDefault()
    const origin = node.getBoundingClientRect().left

    const move = (e: PointerEvent) => {
      const room = Math.max(0, node.getBoundingClientRect().width - DIVIDER)
      apply(dragTo(room, e.clientX - origin - DIVIDER / 2, limits), false)
    }
    const end = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
      $webViewsPaused.set(false)
      setDragging(false)
      save(storageKey, latest.current)
    }

    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? BIG_STEP : STEP

    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault()
      apply(nudge(total, state, event.key === 'ArrowLeft' ? -step : step, limits), true)
    } else if (event.key === 'Home') {
      event.preventDefault()
      apply(dragTo(total, 0, limits), true)
    } else if (event.key === 'End') {
      event.preventDefault()
      apply(dragTo(total, total, limits), true)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      apply(DEFAULT_SPLIT, true)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 px-6 pb-6">
      <div ref={row} className="relative flex min-h-0 min-w-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-col" style={{ width: leftPx, flexShrink: 0 }}>
          {left}
        </div>
        {state.collapsed && !dragging && (
          <button
            type="button"
            aria-label={`Show ${rightLabel}`}
            title={`Show ${rightLabel}`}
            onClick={() => apply(DEFAULT_SPLIT, true)}
            className="glass-card glass-card-hover absolute top-1/2 right-0 z-10 flex h-14 w-5 -translate-y-1/2 items-center justify-center rounded-l-lg text-fg-3 hover:text-fg"
          >
            <IconLayoutSidebarRightExpand size={15} />
          </button>
        )}
        {showDivider && (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label={`Resize the conversation and the ${rightLabel}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={total > 0 ? Math.round((leftPx / total) * 100) : 0}
            tabIndex={0}
            data-split-divider=""
            onPointerDown={onPointerDown}
            onKeyDown={onKeyDown}
            onDoubleClick={() => apply(DEFAULT_SPLIT, true)}
            className="group relative z-10 flex shrink-0 cursor-col-resize items-stretch justify-center outline-none touch-none"
            style={{ width: DIVIDER }}
          >
            <span className={cn('my-6 w-0.5 rounded-full bg-line-strong/70 transition-colors group-hover:bg-accent group-focus-visible:bg-accent', dragging && 'bg-accent')} />
          </div>
        )}
        {/* Kept mounted while hidden: the preview keeps its page and its place. */}
        <div className={cn('min-h-0 min-w-0 flex-1 flex-col', state.collapsed ? 'hidden' : 'flex')}>{right}</div>
      </div>
    </div>
  )
}
