import { useStore } from '@nanostores/react'
import { IconBattery, IconBattery1, IconBattery2, IconBattery3, IconBattery4, IconBatteryCharging, IconBell, IconBluetooth, IconCheck, IconChevronDown, IconCoffee, IconCopy, IconGauge, IconMinus, IconMoon, IconSearch, IconSquare, IconSunset2, IconVolume, IconWifi, IconWifiOff, IconX } from '@tabler/icons-react'
import { Fragment, type ReactNode, useEffect, useRef, useState } from 'react'
import type { StatusPanelId, SwitchName } from '../../shared/ipc.ts'
import { clockText, type MenuBarItem, normalizeMenuBar, visibleMenuBarItems } from '../../shared/menu-bar.ts'
import { JarodLogo } from '../components/jarod-logo.tsx'
import { cn } from '../lib/cn.ts'
import { hostPlatform } from '../lib/platform-labels.ts'
import { planPercent } from '../lib/usage.ts'
import { $backend, $prefs, $windowState } from '../store/backend.ts'
import { $connection } from '../store/gateway.ts'
import { $notifications, $notificationsOpen } from '../store/notifications.ts'
import { runCommand } from '../store/os-commands.ts'
import { $usage, loadUsage } from '../store/usage.ts'
import { $activeSpace, $spaces, setActiveSpace } from '../store/spaces.ts'
import { $statusPanel, openStatusPanel } from '../store/status-panel.ts'
import { $switches, setSwitch } from '../store/switches.ts'
import { $recording } from '../store/capture.ts'
import { $dictation, toggleDictation } from '../store/dictation.ts'
import { MenuBarWidgets } from '../features/plugins/PluginSlots.tsx'
import { isMainSurface, relayToMain } from '../store/shell.ts'
import { toggleCommandBar } from '../store/surface.ts'
import { $systemStats, useNetworkStatus, useSystemStats } from '../store/system.ts'
import { $focusedTitle } from '../store/windows.ts'
import { VoiceIndicator } from '../features/voice/VoiceIndicator.tsx'
import { InternetSwitch } from './InternetSwitch.tsx'
import { quietly } from '../lib/native.ts'
import { type MessageKey, t, useT } from '../lib/i18n.ts'

export function useClock(intervalMs = 10_000): Date {
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), intervalMs)

    return () => clearInterval(timer)
  }, [intervalMs])

  return now
}

export const fmtTime = (d: Date) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
export const fmtDate = (d: Date) => d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })

/**
 * Right-hand status cluster: search, widgets, voice, status lights, network, sound, battery, the
 * notifications bell and the clock, in the order and with the clock format the person chose.
 * Shared with the panels-mode menu bar.
 */
export function MenuBarStatus({ onSearch, onBell, bellActive }: { onSearch: () => void; onBell: () => void; bellActive?: boolean }) {
  const prefs = useStore($prefs)
  const notifications = useStore($notifications)
  const stats = useStore($systemStats)
  const network = useNetworkStatus()
  const openPanel = useStore($statusPanel)
  const layout = normalizeMenuBar(prefs.menuBar)
  const now = useClock(layout.clock.seconds ? 1000 : 10_000)
  useSystemStats()

  const unread = notifications.filter(n => !n.read).length
  const battery = stats?.battery
  const clock = clockText(now, layout.clock)
  const iconButton = (panel: StatusPanelId) => cn('flex h-6 items-center justify-center gap-1.5 rounded-md px-1 hover:bg-white/10', openPanel === panel && 'bg-white/10')

  const items: Record<MenuBarItem, ReactNode> = {
    search: (
      <button type="button" aria-label={t('menubar.search')} onClick={onSearch} className="flex size-6 items-center justify-center rounded-md hover:bg-white/10">
        <IconSearch size={15} />
      </button>
    ),
    widgets: <MenuBarWidgets />,
    voice: <VoiceIndicator />,
    indicators: <SwitchIndicators />,
    usage: <UsageMeter />,
    wifi: (
      <button type="button" aria-label={t('menubar.item.wifi')} title={network?.wifi?.connected ? t('menubar.wifiSsid', { ssid: network.wifi.ssid ?? '' }).trim() : network?.online ? t('menubar.wired') : t('menubar.offlineShort')} onClick={() => openStatusPanel('wifi')} className={iconButton('wifi')}>
        {network?.online === false ? <IconWifiOff size={15} className="text-fg-3" /> : <IconWifi size={15} />}
      </button>
    ),
    bluetooth: (
      <button type="button" aria-label={t('menubar.item.bluetooth')} onClick={() => openStatusPanel('bluetooth')} className={iconButton('bluetooth')}>
        <IconBluetooth size={15} />
      </button>
    ),
    sound: (
      <button type="button" aria-label={t('menubar.item.sound')} onClick={() => openStatusPanel('audio')} className={iconButton('audio')}>
        <IconVolume size={15} />
      </button>
    ),
    battery: battery?.present ? (
      <button type="button" aria-label={`Battery ${battery.percent ?? ''}%`} onClick={() => openStatusPanel('power')} className={cn(iconButton('power'), 'tabular-nums')}>
        {battery.charging ? <IconBatteryCharging size={17} /> : (battery.percent ?? 0) > 80 ? <IconBattery4 size={17} /> : (battery.percent ?? 0) > 55 ? <IconBattery3 size={17} /> : (battery.percent ?? 0) > 30 ? <IconBattery2 size={17} /> : (battery.percent ?? 0) > 10 ? <IconBattery1 size={17} /> : <IconBattery size={17} />}
        <span className="text-[12px]">{battery.percent}%</span>
      </button>
    ) : null,
    notifications: (
      <button type="button" aria-label={t('menubar.notifications')} onClick={onBell} className={cn('relative flex size-6 items-center justify-center rounded-md hover:bg-white/10', bellActive && 'bg-white/10')}>
        <IconBell size={15} />
        {unread > 0 && <span className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-accent-strong" />}
      </button>
    ),
    clock: (
      <button type="button" aria-label={t('menubar.calendar')} onClick={() => openStatusPanel('clock')} className={cn(iconButton('clock'), 'gap-2 tabular-nums')}>
        {clock.date && <span>{clock.date}</span>}
        <span className="font-medium">{clock.time}</span>
      </button>
    )
  }

  return (
    <div className="no-drag flex items-center gap-3">
      {/* Always shown, whatever the layout: whether Jarod may reach the Internet must never be hidden. */}
      <InternetSwitch />
      {visibleMenuBarItems(layout).map(item => (
        <Fragment key={item}>{items[item]}</Fragment>
      ))}
    </div>
  )
}

/**
 * Minimize, maximize / restore and close for the frameless window. Only Windows needs them: macOS
 * has its own and Jarod-OS Linux is the whole session. The same quiet buttons as the status cluster;
 * close turns red on hover like the system's.
 */
export function WindowControls() {
  const state = useStore($windowState)

  if (hostPlatform() !== 'win32') {
    return null
  }

  const filled = state.fullscreen || state.maximized
  const base = 'flex h-6 w-8 items-center justify-center rounded-md text-fg-2 hover:text-fg'

  return (
    <div className="no-drag flex items-center gap-0.5" role="group" aria-label={t('menubar.windowControls')}>
      <button type="button" aria-label={t('menubar.minimize')} title={t('menubar.minimize')} onClick={() => void quietly(() => window.jarodOS.window.minimize())} className={cn(base, 'hover:bg-white/10')}>
        <IconMinus size={15} />
      </button>
      <button type="button" aria-label={filled ? t('menubar.restore') : t('menubar.maximize')} title={state.fullscreen ? t('menubar.leaveFullscreen') : filled ? t('menubar.restore') : t('menubar.maximize')} onClick={() => void quietly(() => window.jarodOS.window.toggleMaximize())} className={cn(base, 'hover:bg-white/10')}>
        {filled ? <IconCopy size={14} /> : <IconSquare size={13} />}
      </button>
      <button type="button" aria-label={t('menubar.close')} title={t('menubar.close')} onClick={() => void quietly(() => window.jarodOS.window.close())} className={cn(base, 'hover:bg-danger/80 hover:text-white')}>
        <IconX size={15} />
      </button>
    </div>
  )
}

/** Small icons while a switch is on (do not disturb, staying awake, night light); clicking turns it off. */
function SwitchIndicators() {
  const switches = useStore($switches)
  const recording = useStore($recording)
  const dictation = useStore($dictation)
  const items = [
    switches.doNotDisturb && { name: 'doNotDisturb' as const, icon: <IconMoon size={15} /> },
    switches.stayAwake && { name: 'stayAwake' as const, icon: <IconCoffee size={15} /> },
    switches.nightLight && { name: 'nightLight' as const, icon: <IconSunset2 size={15} /> }
  ].filter(Boolean) as { name: SwitchName; icon: React.ReactNode }[]

  return (
    <>
      {dictation.phase !== 'idle' && (
        <button type="button" aria-label={t('menubar.stopDictating')} title={t('menubar.stopDictating.title')} onClick={() => (isMainSurface ? toggleDictation() : relayToMain({ type: 'dictate' }))} className="flex h-6 items-center gap-1.5 rounded-md px-1.5 text-[12px] text-accent-strong hover:bg-white/10">
          <span className={cn('size-2 rounded-full bg-accent-strong', dictation.phase === 'listening' && 'animate-pulse-soft')} />
          {dictation.phase === 'listening' ? t('menubar.dictating') : t('menubar.typing')}
        </button>
      )}
      {recording.recording && (
        <button type="button" aria-label={t('menubar.stopRecording')} title={t('menubar.stopRecording.title')} onClick={() => void window.jarodOS.capture.record('stop').catch(() => undefined)} className="flex h-6 items-center gap-1.5 rounded-md px-1.5 text-[12px] text-danger hover:bg-white/10">
          <span className="size-2 animate-pulse-soft rounded-full bg-danger" />
          {t('menubar.recording')}
        </button>
      )}
      {items.map(item => (
        <button key={item.name} type="button" aria-label={t('menubar.turnOff', { name: t(SWITCH_KEY[item.name]).toLowerCase() })} title={t('menubar.switchOn', { name: t(SWITCH_KEY[item.name]) })} onClick={() => void setSwitch(item.name, false).catch(() => undefined)} className="flex size-6 items-center justify-center rounded-md text-accent-strong hover:bg-white/10">
          {item.icon}
        </button>
      ))}
    </>
  )
}

/** The model plan's usage, when the person turned it on and the plan reports a limit. */
function UsageMeter() {
  const prefs = useStore($prefs)
  const usage = useStore($usage)
  const connection = useStore($connection)
  const enabled = Boolean(prefs.usageInMenuBar)

  useEffect(() => {
    if (!enabled || connection !== 'open') {
      return
    }

    // The menu bar is its own window in panels mode, so it keeps its own copy fresh.
    void loadUsage().catch(() => undefined)
    const timer = setInterval(() => void loadUsage().catch(() => undefined), 15 * 60_000)

    return () => clearInterval(timer)
  }, [enabled, connection])

  const pct = planPercent(usage?.plan)

  if (!enabled || pct === null) {
    return null
  }

  return (
    <button type="button" aria-label={`Plan usage ${Math.round(pct)}%`} title={`${usage?.plan?.plan_name ?? 'Plan'}: ${Math.round(pct)}% used`} onClick={() => void runCommand('usage.show', {}, { source: 'ui' })} className={cn('flex items-center gap-1 rounded-md px-1 text-[12px] tabular-nums hover:bg-white/10', pct >= 90 && 'text-warn')}>
      <IconGauge size={15} />
      {Math.round(pct)}%
    </button>
  )
}

/** Backend/gateway health badge shown next to the brand while Hermes is not reachable. */
export function BackendBadge() {
  useT()
  const backend = useStore($backend)
  const connection = useStore($connection)
  const online = backend.phase === 'ready' && connection === 'open'

  if (online) {
    return null
  }

  return <span className="ml-2 rounded-full bg-warn/20 px-2 py-0.5 text-[11px] text-warn">{backend.phase === 'failed' ? t('menubar.offline') : t('menubar.starting')}</span>
}

/*
 * The switch names in the catalogue. `SWITCH_LABELS` in the store keeps its English
 * labels: the command registry answers with them ('Night light on'), so they are a contract.
 */
const SWITCH_KEY: Record<SwitchName, MessageKey> = {
  nightLight: 'menubar.switch.nightLight',
  doNotDisturb: 'menubar.switch.doNotDisturb',
  stayAwake: 'menubar.switch.stayAwake',
  screensaver: 'menubar.switch.screensaver'
}

export function MenuBar() {
  const title = useStore($focusedTitle)
  const space = useStore($activeSpace)
  const spaces = useStore($spaces)
  const notificationsOpen = useStore($notificationsOpen)
  const [spaceMenu, setSpaceMenu] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!spaceMenu) {
      return
    }

    const onDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        setSpaceMenu(false)
      }
    }
    window.addEventListener('mousedown', onDown)

    return () => window.removeEventListener('mousedown', onDown)
  }, [spaceMenu])

  return (
    <header className="drag-region absolute inset-x-0 top-0 z-(--z-menubar) flex h-(--menubar-h) items-center justify-between px-3 text-[12.5px] text-fg select-none" style={{ background: 'linear-gradient(180deg, var(--menubar-from, rgba(3,10,40,.55)), var(--menubar-to, rgba(3,10,40,.15)))' }}>
      <div className="flex items-center gap-2.5 pl-[74px]">
        <JarodLogo height={24} />
        <span className="font-semibold">Jarod-OS</span>
        {title !== 'Jarod-OS' && (
          <>
            <span className="text-fg-4">·</span>
            <span className="text-fg-2">{title}</span>
          </>
        )}
        <BackendBadge />
      </div>

      <div ref={menuRef} className="no-drag relative">
        <button
          type="button"
          onClick={() => setSpaceMenu(v => !v)}
          className="flex h-6 items-center gap-1.5 rounded-full border border-line-strong bg-accent/35 px-3 text-[12px] font-medium text-fg shadow-[0_2px_10px_rgba(47,125,255,.35)] hover:bg-accent/50"
        >
          <span className="size-1.5 rounded-full" style={{ background: space.color }} />
          {space.name}
          <IconChevronDown size={13} className="text-fg-2" />
        </button>
        {spaceMenu && (
          <div className="float absolute top-8 left-1/2 w-48 -translate-x-1/2 overflow-hidden rounded-xl p-1 animate-pop">
            {spaces.map(s => (
              <button
                key={s.id}
                type="button"
                onClick={() => {
                  setActiveSpace(s.id)
                  setSpaceMenu(false)
                }}
                className={cn('flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-[12.5px] hover:bg-white/8', s.id === space.id ? 'text-fg' : 'text-fg-2')}
              >
                <span className="size-2 rounded-full" style={{ background: s.color }} />
                <span className="flex-1 text-left">{s.name}</span>
                {s.id === space.id && <IconCheck size={14} className="text-accent-strong" />}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="flex items-center gap-3">
        <MenuBarStatus onSearch={() => toggleCommandBar(true)} onBell={() => $notificationsOpen.set(!notificationsOpen)} bellActive={notificationsOpen} />
        <WindowControls />
      </div>
    </header>
  )
}
