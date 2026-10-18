import { useStore } from '@nanostores/react'
import { IconLayoutSidebarLeftCollapse, IconLayoutSidebarLeftExpand, IconPlus } from '@tabler/icons-react'
import { $paneTab } from '../features/hermes/artifact-store.ts'
import { APPS_SECTION, MESSAGING_SECTION, openPaneApp, type PaneApp } from '../features/hermes/pane-apps.ts'
import { PaneAppIcon, usePaneAppName } from '../features/hermes/PaneApps.tsx'
import { useEffect, useRef, useState } from 'react'
import { AppGlyph, HermesAvatar } from '../components/app-icon.tsx'
import { cn } from '../lib/cn.ts'
import { appText, useT } from '../lib/i18n.ts'
import { shortcutLabel } from '../lib/platform-labels.ts'
import { $sidebar, SIDEBAR_COLLAPSED, SIDEBAR_MAX, SIDEBAR_MIN, SIDEBAR_SNAP, setSidebarCollapsed, setSidebarWidth, toggleSidebar } from '../store/sidebar.ts'
import { $activeSpace, $spaces, addSpace, setActiveSpace } from '../store/spaces.ts'
import { $page, showPage } from '../store/windows.ts'
import { PAGES } from './apps.ts'

/** The persistent left rail of the main Hermes window: identity, pages, spaces. Resizable; collapses to icons. */
export function Sidebar() {
  const page = useStore($page)
  const spaces = useStore($spaces)
  const active = useStore($activeSpace)
  const { width, collapsed } = useStore($sidebar)
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')
  const [dragging, setDragging] = useState(false)
  const { t, assistant } = useT()
  const drag = useRef<{ startX: number; startWidth: number; wasCollapsed: boolean } | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const origin = useRef<HTMLSpanElement>(null)

  useFloatingTips(scroller, origin)

  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) {
      return
    }

    event.preventDefault()
    drag.current = { startX: event.clientX, startWidth: collapsed ? SIDEBAR_COLLAPSED : width, wasCollapsed: collapsed }
    setDragging(true)

    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // Synthetic pointers (tests) cannot be captured; moves still arrive while over the handle.
    }
  }

  const moveResize = (event: React.PointerEvent<HTMLDivElement>) => {
    const state = drag.current

    if (!state) {
      return
    }

    const next = state.startWidth + (event.clientX - state.startX)

    if (next < SIDEBAR_SNAP) {
      setSidebarCollapsed(true)
    } else {
      // Leaving the collapsed rail: start from the minimum so the label column does not jump in at 92px.
      setSidebarWidth(Math.max(SIDEBAR_MIN, next))
    }
  }

  const endResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) {
      return
    }

    drag.current = null
    setDragging(false)

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  return (
    <aside
      className={cn('relative flex shrink-0 flex-col pt-4 pb-3 select-none', collapsed ? 'items-center px-2' : 'px-3', !dragging && 'transition-[width] duration-200 ease-(--ease-out)')}
      style={{ width: collapsed ? SIDEBAR_COLLAPSED : width }}
      data-collapsed={collapsed || undefined}
    >
      {/* Never scrolls: who this is, and the one control that folds the whole rail to icons (always reachable, even in a short window). */}
      <span ref={origin} aria-hidden="true" className="pointer-events-none fixed top-0 left-0 size-0" />
      <div className={cn('flex shrink-0', collapsed ? 'flex-col items-center gap-2' : 'items-start justify-between gap-2 px-1')}>
        <div className={cn(collapsed && 'flex justify-center')}>
          <HermesAvatar size={collapsed ? 36 : 44} rounded={collapsed ? 9 : 11} />
          {!collapsed && (
            <>
              <div className="mt-2.5 text-[15px] font-semibold leading-tight text-fg">{assistant}</div>
              <div className="mt-0.5 text-[11px] leading-snug text-fg-3 italic">{t('sidebar.tagline')}</div>
            </>
          )}
        </div>
        <button
          type="button"
          onClick={toggleSidebar}
          aria-label={collapsed ? t('sidebar.expandSidebar') : t('sidebar.collapseSidebar')}
          aria-expanded={!collapsed}
          title={t('sidebar.toggleHint', { action: collapsed ? t('sidebar.expandSidebar') : t('sidebar.collapseSidebar'), shortcut: shortcutLabel('\\') })}
          className="flex size-7 shrink-0 items-center justify-center rounded-lg text-fg-3 transition-colors duration-150 hover:bg-white/8 hover:text-fg"
        >
          {collapsed ? <IconLayoutSidebarLeftExpand size={16} stroke={1.9} /> : <IconLayoutSidebarLeftCollapse size={16} stroke={1.9} />}
        </button>
      </div>

      {/* The rest scrolls when the window is short: pages, apps and spaces stay reachable. */}
      <div ref={scroller} className={cn('side-scroll -mx-1 mt-5 flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto px-1', collapsed && 'w-full items-center')}>
      <nav className={cn('relative flex shrink-0 flex-col gap-0.5', collapsed && 'w-full items-center')} aria-label={t('sidebar.pages')}>
        {PAGES.map(def => {
          const activePage = def.id === page
          const name = appText(def.id, def).name

          return (
            <button
              key={def.id}
              type="button"
              onClick={() => showPage(def.id)}
              aria-current={activePage ? 'page' : undefined}
              aria-label={collapsed ? name : undefined}
              className={cn(
                'side-item group relative flex h-8 items-center rounded-lg text-[12.5px] transition-colors duration-150',
                collapsed ? 'w-9 justify-center' : 'gap-2.5 px-2.5',
                activePage ? 'bg-accent text-accent-fg shadow-[0_4px_16px_rgba(47,125,255,.45)]' : 'text-fg-2 hover:bg-white/8 hover:text-fg'
              )}
            >
              <AppGlyph id={def.icon} size={16} stroke={1.9} className={activePage ? 'text-accent-fg' : 'text-fg-2 group-hover:text-fg'} />
              {collapsed ? <span className="side-tip">{name}</span> : <span className="truncate">{name}</span>}
            </button>
          )
        })}
      </nav>

      <AppSection collapsed={collapsed} label={t('sidebar.apps')} apps={APPS_SECTION} />
      <AppSection collapsed={collapsed} label={t('sidebar.messaging')} apps={MESSAGING_SECTION} />

      <div className={cn('my-4 h-px bg-line', collapsed ? 'w-6' : 'mx-1')} />

      {collapsed ? (
        <div className="flex w-full flex-col items-center gap-1">
          {spaces.map(space => {
            const on = space.id === active.id

            return (
              <button
                key={space.id}
                type="button"
                onClick={() => setActiveSpace(space.id)}
                aria-label={t('sidebar.space', { name: space.name })}
                aria-pressed={on}
                className={cn('side-item group relative flex size-7 items-center justify-center rounded-lg transition-colors duration-150', on ? 'bg-white/14' : 'hover:bg-white/8')}
              >
                <span className={cn('rounded-full shadow-[0_0_8px_currentColor] transition-[width,height]', on ? 'size-2.5' : 'size-2')} style={{ background: space.color, color: space.color }} />
                <span className="side-tip">{space.name}</span>
              </button>
            )
          })}
          <button
            type="button"
            aria-label={t('sidebar.addSpace')}
            onClick={() => {
              setSidebarCollapsed(false)
              setAdding(true)
            }}
            className="side-item group relative flex size-7 items-center justify-center rounded-lg text-fg-3 hover:bg-white/10 hover:text-fg"
          >
            <IconPlus size={13} />
            <span className="side-tip">{t('sidebar.addSpace')}</span>
          </button>
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between px-2">
            <span className="text-[10px] font-semibold tracking-[0.14em] text-fg-3 uppercase">{t('sidebar.spaces')}</span>
            <button type="button" aria-label={t('sidebar.addSpace')} onClick={() => setAdding(true)} className="flex size-5 items-center justify-center rounded text-fg-3 hover:bg-white/10 hover:text-fg">
              <IconPlus size={13} />
            </button>
          </div>
          <div className="mt-1.5 flex flex-col gap-0.5">
            {spaces.map(space => {
              const on = space.id === active.id

              return (
                <button
                  key={space.id}
                  type="button"
                  onClick={() => setActiveSpace(space.id)}
                  className={cn('flex h-7 items-center gap-2.5 rounded-lg px-2.5 text-[12.5px] transition-colors duration-150', on ? 'bg-white/14 text-fg' : 'text-fg-2 hover:bg-white/8 hover:text-fg')}
                >
                  <span className="size-2 shrink-0 rounded-full shadow-[0_0_8px_currentColor]" style={{ background: space.color, color: space.color }} />
                  <span className="truncate">{space.name}</span>
                </button>
              )
            })}
            {adding && (
              <input
                autoFocus
                value={draft}
                onChange={e => setDraft(e.target.value)}
                onBlur={() => {
                  setAdding(false)
                  setDraft('')
                }}
                onKeyDown={e => {
                  if (e.key === 'Enter' && draft.trim()) {
                    addSpace(draft.trim())
                    setAdding(false)
                    setDraft('')
                  }

                  if (e.key === 'Escape') {
                    setAdding(false)
                    setDraft('')
                  }
                }}
                placeholder={t('sidebar.newSpace')}
                className="glass-input mt-1 h-7 rounded-lg px-2.5 text-[12.5px] outline-none"
              />
            )}
          </div>
        </>
      )}

      </div>

      {/* Resize handle: drag to resize, drag past the snap point to collapse, double-click to toggle. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t('sidebar.resize')}
        aria-valuemin={SIDEBAR_MIN}
        aria-valuemax={SIDEBAR_MAX}
        aria-valuenow={collapsed ? SIDEBAR_COLLAPSED : width}
        onPointerDown={startResize}
        onPointerMove={moveResize}
        onPointerUp={endResize}
        onPointerCancel={endResize}
        onDoubleClick={toggleSidebar}
        className={cn('side-handle absolute top-3 -right-1 bottom-3 w-2 cursor-col-resize', dragging && 'is-dragging')}
      />
    </aside>
  )
}

/**
 * The labels of a scrolling rail would be clipped by its own overflow: they are placed with `position: fixed`, measured from a zero-size
 * probe so that an ancestor's backdrop filter (which makes it the containing block of fixed elements) does not shift them.
 */
function useFloatingTips(scroller: React.RefObject<HTMLDivElement | null>, origin: React.RefObject<HTMLSpanElement | null>): void {
  useEffect(() => {
    const root = scroller.current

    if (!root) {
      return
    }

    const place = (event: Event) => {
      const item = (event.target as HTMLElement | null)?.closest?.('.side-item')
      const tip = item?.querySelector<HTMLElement>(':scope > .side-tip')
      const base = origin.current?.getBoundingClientRect()

      if (!item || !tip || !base) {
        return
      }

      const rect = item.getBoundingClientRect()
      tip.style.left = `${rect.right + 10 - base.left}px`
      tip.style.top = `${rect.top + rect.height / 2 - base.top}px`
    }

    root.addEventListener('pointerover', place)
    root.addEventListener('focusin', place)

    return () => {
      root.removeEventListener('pointerover', place)
      root.removeEventListener('focusin', place)
    }
  }, [scroller, origin])
}

/** A sidebar section of apps that open in the right pane, beside the chat (the Hermes page). */
function AppSection({ collapsed, label, apps }: { collapsed: boolean; label: string; apps: readonly PaneApp[] }) {
  const page = useStore($page)
  const tab = useStore($paneTab)
  const nameOf = usePaneAppName()

  return (
    <>
      <div className={cn('my-4 h-px bg-line', collapsed ? 'w-6' : 'mx-1')} />
      {!collapsed && <span className="mb-1.5 px-2 text-[10px] font-semibold tracking-[0.14em] text-fg-3 uppercase">{label}</span>}
      <nav className={cn('flex flex-col gap-0.5', collapsed && 'w-full items-center')} aria-label={label}>
        {apps.map(app => {
          const on = page === 'hermes' && tab === app
          const name = nameOf(app)

          return (
            <button
              key={app}
              type="button"
              onClick={() => openPaneApp(app)}
              aria-current={on ? 'true' : undefined}
              aria-label={collapsed ? name : undefined}
              className={cn(
                'side-item group relative flex h-8 items-center rounded-lg text-[12.5px] transition-colors duration-150',
                collapsed ? 'w-9 justify-center' : 'gap-2.5 px-2.5',
                on ? 'bg-white/14 text-fg' : 'text-fg-2 hover:bg-white/8 hover:text-fg'
              )}
            >
              <PaneAppIcon app={app} size={16} />
              {collapsed ? <span className="side-tip">{name}</span> : <span className="truncate">{name}</span>}
            </button>
          )
        })}
      </nav>
    </>
  )
}
