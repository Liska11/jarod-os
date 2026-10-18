import { useStore } from '@nanostores/react'
import { IconBrandInstagram, IconBrandSignal, IconBrandTelegram, IconBrandTiktok, IconBrandWhatsapp, IconDeviceTv, IconMovie, IconPlayerPlay, IconWorld, IconX } from '@tabler/icons-react'
import type { MessageKey } from '../../lib/i18n.ts'
import { cn } from '../../lib/cn.ts'
import { useT } from '../../lib/i18n.ts'
import { $page } from '../../store/windows.ts'
import { Player } from '../player/Player.tsx'
import { BrowserView } from '../sites/BrowserView.tsx'
import { NativeAppPanel } from '../sites/NativeAppPanel.tsx'
import { SiteTab } from '../sites/SiteTab.tsx'
import { $paneTab, type PaneTab } from './artifact-store.ts'
import { $paneApps, $vlcTarget, closePaneApp, isPaneApp, type PaneApp } from './pane-apps.ts'

export const PANE_APP_LABEL: Record<PaneApp, MessageKey | string> = {
  browser: 'pane.app.browser',
  tiktok: 'TikTok',
  instagram: 'Instagram',
  telegram: 'Telegram',
  whatsapp: 'WhatsApp',
  signal: 'Signal',
  player: 'pane.app.player',
  moviebox: 'MovieBox',
  vlc: 'VLC'
}

export function PaneAppIcon({ app, size = 14 }: { app: PaneApp; size?: number }) {
  const props = { size, stroke: 1.9 }

  switch (app) {
    case 'browser':
      return <IconWorld {...props} />
    case 'tiktok':
      return <IconBrandTiktok {...props} />
    case 'instagram':
      return <IconBrandInstagram {...props} />
    case 'telegram':
      return <IconBrandTelegram {...props} />
    case 'whatsapp':
      return <IconBrandWhatsapp {...props} />
    case 'signal':
      return <IconBrandSignal {...props} />
    case 'player':
      return <IconPlayerPlay {...props} />
    case 'moviebox':
      return <IconMovie {...props} />
    case 'vlc':
      return <IconDeviceTv {...props} />
  }
}

export function usePaneAppName(): (app: PaneApp) => string {
  const { t } = useT()

  return app => {
    const label = PANE_APP_LABEL[app]

    return label.startsWith('pane.') ? t(label as MessageKey) : label
  }
}

const TAB = 'flex h-7 shrink-0 items-center gap-1.5 rounded-md text-[12.5px] transition-colors duration-150'
const ON = 'bg-accent text-accent-fg shadow-[0_2px_10px_rgba(47,125,255,.45)]'
const OFF = 'text-fg-2 hover:bg-white/6 hover:text-fg'

/** The pane's tabs: Preview and Sources, then the apps opened from the sidebar (each one closable). */
export function PaneTabs({ value }: { value: PaneTab }) {
  const { t } = useT()
  const apps = useStore($paneApps)
  const nameOf = usePaneAppName()

  return (
    <div className="flex items-center border-b border-line px-3 py-2">
      <div className="flex min-w-0 items-center gap-1 overflow-x-auto rounded-lg bg-black/15 p-1 hairline [scrollbar-width:none]" role="tablist">
        {(['preview', 'sources'] as const).map(id => (
          <button key={id} type="button" role="tab" aria-selected={value === id} onClick={() => $paneTab.set(id)} className={cn(TAB, 'px-3', value === id ? ON : OFF)}>
            {t(id === 'preview' ? 'pane.preview' : 'pane.sources')}
          </button>
        ))}
        {apps.map(app => {
          const on = value === app
          const name = nameOf(app)

          return (
            <span key={app} className={cn(TAB, 'pr-1 pl-2.5', on ? ON : OFF)}>
              <button type="button" role="tab" aria-selected={on} onClick={() => $paneTab.set(app)} className="flex h-full items-center gap-1.5">
                <PaneAppIcon app={app} />
                {name}
              </button>
              <button type="button" aria-label={t('pane.app.close', { name })} onClick={() => closePaneApp(app)} className="flex size-5 items-center justify-center rounded opacity-70 hover:bg-white/15 hover:opacity-100">
                <IconX size={12} />
              </button>
            </span>
          )
        })}
      </div>
    </div>
  )
}

/** Every open app, mounted (their views stay signed in and playing); only the active tab's one takes the room. */
export function PaneAppViews({ tab }: { tab: PaneTab }) {
  const apps = useStore($paneApps)
  const onPage = useStore($page) === 'hermes'
  const current = isPaneApp(tab) ? tab : null
  const vlcTarget = useStore($vlcTarget)

  return (
    <>
      {apps.map(app => {
        const active = onPage && current === app

        switch (app) {
          case 'browser':
            return <BrowserView key={app} active={active} />
          case 'player':
            return <Player key={app} active={current === app} />
          case 'signal':
            return <NativeAppPanel key={app} app="signal" name="Signal" icon={<IconBrandSignal />} installable active={active} />
          case 'moviebox':
            return <NativeAppPanel key={app} app="moviebox" name="MovieBox" icon={<IconMovie />} installable={false} active={active} />
          case 'vlc':
            return <NativeAppPanel key={app} app="vlc" name="VLC" icon={<IconDeviceTv />} installable active={active} target={vlcTarget} />
          default:
            return <SiteTab key={app} site={app} active={active} />
        }
      })}
    </>
  )
}
