import { useStore } from '@nanostores/react'
import { IconPalette, IconSunHigh, IconTargetArrow } from '@tabler/icons-react'
import { useEffect, useRef, useState } from 'react'
import { EmptyGlass, LinkAction, Section, StatusDot } from '../../components/ui/glass.tsx'
import { cn } from '../../lib/cn.ts'
import { greetingFor } from '../../lib/format.ts'
import { useT } from '../../lib/i18n.ts'
import { createChat, runSlash, sendPrompt } from '../../store/chat.ts'
import { $threads } from '../../store/continuity.ts'
import { $connection } from '../../store/gateway.ts'
import { $activeMissions, $reviewMissions } from '../../store/missions.ts'
import { useSystemInfo } from '../../store/system.ts'
import { showPage } from '../../store/windows.ts'
import { MissionCard } from './MissionCard.tsx'
import { OverviewComposer } from './OverviewComposer.tsx'
import { PickUp } from './PickUp.tsx'
import { RecentWork } from './RecentWork.tsx'
import { titleCase } from './shared.tsx'
import { TodayPanel } from './TodayPanel.tsx'

const MISSIONS_SHOWN = 3


/** Home of the main window: greeting, prompt, what is in motion and what needs the user. */
export function OverviewPage() {
  const connection = useStore($connection)
  const active = useStore($activeMissions)
  const review = useStore($reviewMissions)
  const threads = useStore($threads)
  const info = useSystemInfo()
  const [now, setNow] = useState(() => new Date())
  const [draft, setDraft] = useState<{ text: string; id: number }>()
  const rootRef = useRef<HTMLDivElement>(null)
  const narrow = useNarrow(rootRef, 900)
  const { t } = useT()

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000)

    return () => clearInterval(timer)
  }, [])

  const online = connection === 'open'
  const firstName = titleCase((info?.fullName || info?.userName || '').trim().split(/[\s._-]+/)[0] ?? '')
  const greeting = `${greetingFor(now)}${firstName ? `, ${firstName}` : ''}.`
  const missions = [...active, ...review].slice(0, MISSIONS_SHOWN)

  const submit = async (text: string) => {
    showPage('hermes')
    await (text.startsWith('/') ? runSlash(text) : sendPrompt(text))
  }

  const startMission = async () => {
    showPage('hermes')
    await createChat()
  }

  return (
    <div ref={rootRef} className="h-full overflow-y-auto">
      <div className={cn('flex min-h-full gap-6 px-6 pt-6 pb-8', narrow && 'flex-col gap-7')}>
        <main className="flex min-w-0 flex-1 flex-col gap-7">
          <div className="flex flex-col gap-5">
            <div className="flex items-center gap-2 text-[10.5px] font-medium tracking-[0.14em] text-fg-3 uppercase">
              <StatusDot tone={online ? 'ok' : 'warn'} pulse={!online} />
              {online ? t('overview.ready') : t('overview.connecting')}
            </div>
            <div>
              <h1 className="text-[28px] leading-tight font-semibold tracking-tight text-fg">{greeting}</h1>
              <div className="mt-1 text-[16px] text-fg-2">{threads.length > 0 ? t('overview.welcomeBack') : t('overview.subtitle')}</div>
            </div>
            <OverviewComposer disabled={!online} placeholder={online ? t('overview.composer') : t('overview.starting')} onSubmit={submit} draft={draft} />
            <div className="flex flex-wrap items-center gap-2">
              <QuickAction icon={<IconSunHigh />} label={t('overview.planMyDay')} disabled={!online} onClick={() => void submit(t('overview.planMyDay.prompt'))} />
              <QuickAction icon={<IconTargetArrow />} label={t('overview.startMission')} disabled={!online} onClick={() => void startMission()} />
              <QuickAction icon={<IconPalette />} label={t('overview.makeTheme')} disabled={!online} onClick={() => setDraft({ text: t('overview.makeTheme.draft'), id: Date.now() })} />
            </div>
          </div>

          <PickUp />

          <Section title={t('overview.activeMissions')} action={<LinkAction onClick={() => showPage('missions')}>{t('overview.seeAll')}</LinkAction>}>
            {missions.length === 0 ? (
              <EmptyGlass title={t('overview.noMissions')} description={t('overview.noMissions.hint')} />
            ) : (
              <div className="stagger flex flex-col gap-3">
                {missions.map(mission => (
                  <MissionCard key={mission.id} mission={mission} />
                ))}
              </div>
            )}
          </Section>

          <RecentWork />
        </main>

        {/* As a compositor tile the window can get narrow: stack the Today panel under the main column. */}
        {!narrow && <span aria-hidden="true" className="w-px shrink-0 self-stretch bg-line" />}

        <TodayPanel now={now} stacked={narrow} />
      </div>
    </div>
  )
}

/** True while the element is narrower than `threshold` px. */
function useNarrow(ref: React.RefObject<HTMLElement | null>, threshold: number): boolean {
  const [narrow, setNarrow] = useState(false)

  useEffect(() => {
    const el = ref.current

    if (!el) {
      return
    }

    const observer = new ResizeObserver(entries => {
      const width = entries[0]?.contentRect.width ?? el.clientWidth
      setNarrow(width < threshold)
    })
    observer.observe(el)
    setNarrow(el.clientWidth < threshold)

    return () => observer.disconnect()
  }, [ref, threshold])

  return narrow
}

function QuickAction({ icon, label, onClick, disabled }: { icon: React.ReactNode; label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex h-8 items-center gap-2 rounded-full border border-line bg-white/6 px-3.5 text-[12.5px] text-fg transition-colors duration-120 hover:border-line-strong hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40 [&_svg]:size-[15px] [&_svg]:text-accent-strong"
    >
      {icon}
      {label}
    </button>
  )
}
