import type { AppIconId } from '../shell/apps.ts'
// Imported (not a `/brand/...` public URL) so Vite rewrites it relative to `base`; absolute public
// paths resolve to the filesystem root under the packaged `file://` renderer.
import hermesAvatarUrl from '../assets/brand/hermes-avatar.jpg'
import { cn } from '../lib/cn.ts'
import { useT } from '../lib/i18n.ts'

const PATHS: Record<AppIconId, React.ReactNode> = {
  // Pinokio: a cube (an app in a box) with a spark.
  pinokio: (
    <>
      <path d="M12 3.5 19.5 7.5v9L12 20.5 4.5 16.5v-9z" />
      <path d="M4.5 7.5 12 11.5l7.5-4M12 11.5v9" />
    </>
  ),
  hermes: null,
  overview: <path d="M4 11.5 12 5l8 6.5V19a1 1 0 0 1-1 1h-4v-5h-6v5H5a1 1 0 0 1-1-1z" />,
  missions: (
    <>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="4" />
      <circle cx="12" cy="12" r="1" fill="currentColor" />
    </>
  ),
  memory: (
    <>
      <path d="M12 4v16" />
      <path d="M7 7.5c2.5 0 3.5 1.5 5 1.5s2.5-1.5 5-1.5" />
      <path d="M7 16.5c2.5 0 3.5-1.5 5-1.5s2.5 1.5 5 1.5" />
      <circle cx="7" cy="7.5" r="1.4" />
      <circle cx="17" cy="7.5" r="1.4" />
      <circle cx="7" cy="16.5" r="1.4" />
      <circle cx="17" cy="16.5" r="1.4" />
    </>
  ),
  files: <path d="M3.5 7.5A1.5 1.5 0 0 1 5 6h4.2l1.8 2h8a1.5 1.5 0 0 1 1.5 1.5V17A1.5 1.5 0 0 1 19 18.5H5A1.5 1.5 0 0 1 3.5 17z" />,
  automations: (
    <>
      <path d="M20 12a8 8 0 1 1-2.3-5.7" />
      <path d="M20 4v4h-4" />
    </>
  ),
  kanban: (
    <>
      <rect x="4" y="4.5" width="4.6" height="15" rx="1.2" />
      <rect x="9.7" y="4.5" width="4.6" height="9" rx="1.2" />
      <rect x="15.4" y="4.5" width="4.6" height="12" rx="1.2" />
    </>
  ),
  connections: (
    <>
      <path d="M10 14 14 10" />
      <path d="M8.5 15.5 6.7 17.3a3 3 0 0 1-4.2-4.2l3-3a3 3 0 0 1 4.2 0" />
      <path d="M15.5 8.5l1.8-1.8a3 3 0 0 1 4.2 4.2l-3 3a3 3 0 0 1-4.2 0" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3.5v2.2M12 18.3v2.2M3.5 12h2.2M18.3 12h2.2M6 6l1.6 1.6M16.4 16.4 18 18M6 18l1.6-1.6M16.4 7.6 18 6" />
    </>
  ),
  terminal: (
    <>
      <path d="M5 8l4 4-4 4" />
      <path d="M11 16h8" />
    </>
  ),
  system: (
    <>
      <rect x="3.5" y="5" width="17" height="11" rx="1.8" />
      <path d="M8 19.5h8" />
    </>
  ),
  code: <path d="M9 7 4 12l5 5M15 7l5 5-5 5M13 5l-2 14" />,
  studio: <path d="M12 3.5 5 20h3l1.4-3.5h5.2L16 20h3zM10.3 14 12 9.4l1.7 4.6z" />,
  documents: (
    <>
      <path d="M7 3.5h7l4 4V19a1.5 1.5 0 0 1-1.5 1.5h-9.5A1.5 1.5 0 0 1 5.5 19V5A1.5 1.5 0 0 1 7 3.5z" />
      <path d="M14 3.5v4h4M8.5 12h7M8.5 15.5h7" />
    </>
  ),
  grid: (
    <>
      <circle cx="7" cy="7" r="1.6" fill="currentColor" />
      <circle cx="12" cy="7" r="1.6" fill="currentColor" />
      <circle cx="17" cy="7" r="1.6" fill="currentColor" />
      <circle cx="7" cy="12" r="1.6" fill="currentColor" />
      <circle cx="12" cy="12" r="1.6" fill="currentColor" />
      <circle cx="17" cy="12" r="1.6" fill="currentColor" />
      <circle cx="7" cy="17" r="1.6" fill="currentColor" />
      <circle cx="12" cy="17" r="1.6" fill="currentColor" />
      <circle cx="17" cy="17" r="1.6" fill="currentColor" />
    </>
  ),
  trash: (
    <>
      <path d="M5 7h14M9 7V5h6v2M7 7l1 12h8l1-12" />
      <path d="M10 11v5M14 11v5" />
    </>
  )
}

/** The Hermes avatar: the same mark the mockups use, on a white tile. */
export function HermesAvatar({ size = 40, className, rounded = 10 }: { size?: number; className?: string; rounded?: number }) {
  const { assistant } = useT()

  return (
    <img
      src={hermesAvatarUrl}
      alt={assistant}
      width={size}
      height={size}
      draggable={false}
      className={cn('shrink-0 bg-paper object-cover shadow-[0_2px_10px_rgba(0,10,60,.45)]', className)}
      style={{ borderRadius: rounded }}
    />
  )
}

export function AppGlyph({ id, size = 22, className, stroke = 1.7 }: { id: AppIconId; size?: number; className?: string; stroke?: number }) {
  if (id === 'hermes') {
    return <HermesAvatar size={size} rounded={Math.round(size * 0.22)} className={className} />
  }

  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" className={cn('shrink-0', className)} aria-hidden="true">
      {PATHS[id]}
    </svg>
  )
}

/** Rounded blue-glass tile with a glyph (the launcher / header icon treatment). */
export function AppTile({ id, size = 44, className, glyph }: { id: AppIconId; size?: number; className?: string; glyph?: number }) {
  if (id === 'hermes') {
    return <HermesAvatar size={size} rounded={Math.round(size * 0.24)} className={className} />
  }

  return (
    <span className={cn('icon-tile', className)} style={{ width: size, height: size, borderRadius: Math.round(size * 0.24) }}>
      <AppGlyph id={id} size={glyph ?? Math.round(size * 0.5)} />
    </span>
  )
}
