import { useStore } from '@nanostores/react'
import { type MessageKey, t, useT } from '../../../lib/i18n.ts'
import { IconCalendar, IconChevronDown, IconChevronUp, IconClock, IconGripVertical, IconRestore } from '@tabler/icons-react'
import { useState } from 'react'
import { clockText, type MenuBarClock, type MenuBarItem, normalizeMenuBar, PINNED_ITEMS } from '../../../../shared/menu-bar.ts'
import { Chips, GlassButton, Toggle } from '../../../components/ui/glass.tsx'
import { cn } from '../../../lib/cn.ts'
import { useClock } from '../../../shell/MenuBar.tsx'
import { $prefs } from '../../../store/backend.ts'
import { notify } from '../../../store/notifications.ts'
import { runCommand } from '../../../store/os-commands.ts'
import { Filterable, markSaved, SettingsGroup, SettingsRow } from './shared.tsx'

/*
 * The item names in the catalogue. `shared/menu-bar.ts` keeps its own English labels: the main
 * process matches user words against them ("Wi-Fi", "Plan usage"), so they are a contract, not copy.
 */
const ITEM_KEY: Record<MenuBarItem, MessageKey> = {
  search: 'menubar.item.search',
  widgets: 'menubar.item.widgets',
  voice: 'menubar.item.voice',
  indicators: 'menubar.item.indicators',
  usage: 'menubar.item.usage',
  wifi: 'menubar.item.wifi',
  bluetooth: 'menubar.item.bluetooth',
  sound: 'menubar.item.sound',
  battery: 'menubar.item.battery',
  notifications: 'menubar.item.notifications',
  clock: 'menubar.item.clock'
}

const HINTS: Partial<Record<MenuBarItem, MessageKey>> = {
  widgets: 'menubar.hint.widgets',
  voice: 'menubar.hint.voice',
  indicators: 'menubar.hint.indicators',
  usage: 'menubar.hint.usage',
  battery: 'menubar.hint.battery'
}

const HOURS: { id: MenuBarClock['hours']; label: MessageKey }[] = [
  { id: 'system', label: 'menubar.hours.auto' },
  { id: '12', label: 'menubar.hours.h12' },
  { id: '24', label: 'menubar.hours.h24' }
]

const DATES: { id: MenuBarClock['date']; label: MessageKey }[] = [
  { id: 'short', label: 'menubar.date.short' },
  { id: 'long', label: 'menubar.date.long' },
  { id: 'none', label: 'menubar.date.none' }
]

async function run(command: string, args: Record<string, unknown> = {}) {
  const result = await runCommand(command, args, { source: 'ui' })

  if (result.ok) {
    markSaved()
  } else {
    notify({ title: t('menubar.changeFailed'), body: result.error ?? result.summary, level: 'error' })
  }
}

/** Settings > Appearance > Menu bar: the items in order (drag or the arrows), each one's switch, and the clock. */
export function MenuBarSettings() {
  const { t } = useT()
  const prefs = useStore($prefs)
  const layout = normalizeMenuBar(prefs.menuBar)
  const [dragging, setDragging] = useState<MenuBarItem | null>(null)
  const [slot, setSlot] = useState<number | null>(null)
  const now = useClock(1000)
  const preview = clockText(now, layout.clock)
  const shown = (item: MenuBarItem) => (item === 'usage' ? Boolean(prefs.usageInMenuBar) : !layout.hidden.includes(item))
  const last = layout.order.length - 1

  const endDrag = () => {
    setDragging(null)
    setSlot(null)
  }

  const drop = () => {
    if (dragging && slot !== null) {
      const from = layout.order.indexOf(dragging)
      // Slots count the dragged row itself; positions are among the others, 1 being leftmost.
      void run('bar.move', { item: dragging, position: String((slot > from ? slot - 1 : slot) + 1) })
    }

    endDrag()
  }

  return (
    <SettingsGroup title={t('menubar.title')}>
      <Filterable label={t('menubar.filterLabel')} description={t('menubar.filterDesc')} keywords={t('menubar.filter')}>
        <div className="settings-row px-3.5 py-2.5">
          <div className="mb-1.5 text-[12px] text-fg-3">{t('menubar.dragHint')}</div>
          <ol aria-label={t('menubar.ariaItems')} className="flex flex-col">
            {layout.order.map((item, index) => {
              const name = t(ITEM_KEY[item])

              return (
                <li
                  key={item}
                  draggable
                  onDragStart={event => {
                    event.dataTransfer.effectAllowed = 'move'
                    event.dataTransfer.setData('text/plain', item)
                    setDragging(item)
                  }}
                  onDragOver={event => {
                    if (!dragging) {
                      return
                    }

                    event.preventDefault()
                    const box = event.currentTarget.getBoundingClientRect()
                    setSlot(event.clientY < box.top + box.height / 2 ? index : index + 1)
                  }}
                  onDrop={event => {
                    event.preventDefault()
                    drop()
                  }}
                  onDragEnd={endDrag}
                  className={cn('relative flex h-10 cursor-grab items-center gap-2.5 rounded-lg px-1.5 hover:bg-white/4', dragging === item && 'opacity-40')}
                >
                  {dragging && slot === index && <span aria-hidden="true" className="absolute inset-x-1 -top-px h-0.5 rounded-full bg-accent" />}
                  {dragging && slot === last + 1 && index === last && <span aria-hidden="true" className="absolute inset-x-1 -bottom-px h-0.5 rounded-full bg-accent" />}
                  <IconGripVertical size={14} className="shrink-0 text-fg-4" aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <div className={cn('text-[13px]', shown(item) ? 'text-fg' : 'text-fg-3')}>{name}</div>
                    {HINTS[item] && <div className="truncate text-[11.5px] text-fg-4">{t(HINTS[item])}</div>}
                  </div>
                  <GlassButton size="icon" variant="ghost" aria-label={t('menubar.moveEarlier', { label: name })} disabled={index === 0} onClick={() => void run('bar.move', { item, position: String(index) })}>
                    <IconChevronUp size={14} />
                  </GlassButton>
                  <GlassButton size="icon" variant="ghost" aria-label={t('menubar.moveLater', { label: name })} disabled={index === last} onClick={() => void run('bar.move', { item, position: String(index + 2) })}>
                    <IconChevronDown size={14} />
                  </GlassButton>
                  <Toggle checked={shown(item)} disabled={PINNED_ITEMS.includes(item)} onChange={next => void run(next ? 'bar.show' : 'bar.hide', { item })} label={t('menubar.showLabel', { label: name })} />
                </li>
              )
            })}
          </ol>
        </div>
      </Filterable>
      <SettingsRow icon={<IconClock />} label={t('menubar.clock')} description={<span className="tabular-nums">{[preview.date, preview.time].filter(Boolean).join('  ')}</span>} keywords={t('menubar.kw.clock')}>
        <Chips items={HOURS} value={layout.clock.hours} onChange={hours => void run('bar.clock', { hours })} />
      </SettingsRow>
      <SettingsRow icon={<IconClock />} label={t('menubar.seconds')} keywords={t('menubar.kw.seconds')}>
        <Toggle checked={layout.clock.seconds} onChange={seconds => void run('bar.clock', { seconds })} label={t('menubar.seconds')} />
      </SettingsRow>
      <SettingsRow icon={<IconCalendar />} label={t('menubar.date')} description={t('menubar.dateDesc')} keywords={t('menubar.kw.date')}>
        <Chips items={DATES} value={layout.clock.date} onChange={date => void run('bar.clock', { date })} />
      </SettingsRow>
      <SettingsRow icon={<IconRestore />} label={t('menubar.reset')} description={t('menubar.resetDesc')} keywords={t('menubar.kw.reset')}>
        <GlassButton size="sm" variant="ghost" onClick={() => void run('bar.reset')}>
          {t('menubar.resetBtn')}
        </GlassButton>
      </SettingsRow>
    </SettingsGroup>
  )
}
