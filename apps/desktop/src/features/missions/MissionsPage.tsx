import { useStore } from '@nanostores/react'
import { IconPlus, IconTarget } from '@tabler/icons-react'
import { useEffect, useState } from 'react'
import { EmptyGlass, GlassButton, GlassCard, LinkAction, MoreButton, PageHeader, Section, Tabs, type TabDef } from '../../components/ui/glass.tsx'
import { $activeMissions, $activity, $completedMissions, $missionFocus, $reviewMissions } from '../../store/missions.ts'
import { ActivityTimeline } from './ActivityTimeline.tsx'
import { MissionCard } from './MissionCard.tsx'
import { MissionComposer } from './MissionComposer.tsx'
import { MissionDetail } from './MissionDetail.tsx'
import { type MessageKey, t, useT } from '../../lib/i18n.ts'

type TabId = 'active' | 'review' | 'completed'

const ACTIVITY_SHORT = 6
const ACTIVITY_LONG = 20

const EMPTY_COPY: Record<TabId, { title: MessageKey; description: MessageKey }> = {
  active: { title: 'missions.empty.active', description: 'missions.empty.active.hint' },
  review: { title: 'missions.empty.review', description: 'missions.empty.review.hint' },
  completed: { title: 'missions.empty.completed', description: 'missions.empty.completed.hint' }
}

export function MissionsPage() {
  useT()
  const active = useStore($activeMissions)
  const review = useStore($reviewMissions)
  const completed = useStore($completedMissions)
  const activity = useStore($activity)
  const [tab, setTab] = useState<TabId>('active')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [showAllActivity, setShowAllActivity] = useState(false)
  const [composing, setComposing] = useState(false)

  // A command (voice, agent) asked for a tab, a mission or the composer: follow it.
  const focus = useStore($missionFocus)

  useEffect(() => {
    if (!focus) {
      return
    }

    if (focus.tab) {
      setTab(focus.tab === 'queued' ? 'active' : focus.tab)
    }

    if (focus.missionId) {
      setSelectedId(focus.missionId)
    }

    if (focus.compose) {
      setComposing(true)
    }
  }, [focus])

  const tabs: readonly TabDef<TabId>[] = [
    { id: 'active', label: t('missions.tab.active'), count: active.length },
    { id: 'review', label: t('missions.tab.review'), count: review.length },
    { id: 'completed', label: t('missions.tab.completed'), count: completed.length }
  ]
  const list = tab === 'active' ? active : tab === 'review' ? review : completed
  // Auto-select the first mission of the current tab when nothing (or something gone) is selected.
  const selected = list.find(m => m.id === selectedId) ?? list[0] ?? null
  const recent = activity.slice(0, showAllActivity ? ACTIVITY_LONG : ACTIVITY_SHORT)

  const changeTab = (next: TabId) => {
    setTab(next)
    setSelectedId(null)
  }

  return (
    <div className="page-enter flex h-full flex-col">
      <PageHeader
        icon="missions"
        title={t('app.missions')}
        subtitle={t('missions.subtitle')}
        actions={
          <>
            <GlassButton onClick={() => setComposing(true)} aria-label={t('missions.new')}>
              <IconPlus />
              {t('missions.new')}
            </GlassButton>
            <MoreButton />
          </>
        }
      />

      <div className="flex min-h-0 flex-1 gap-4 px-6 pb-6">
        <div className="flex min-w-0 flex-1 flex-col gap-5 overflow-y-auto pr-1">
          <Tabs tabs={tabs} value={tab} onChange={changeTab} className="self-start" />

          {list.length === 0 ? (
            <EmptyGlass
              icon={<IconTarget />}
              title={t(EMPTY_COPY[tab].title)}
              description={t(EMPTY_COPY[tab].description)}
              action={
                tab === 'active' ? (
                  <GlassButton size="sm" variant="primary" onClick={() => setComposing(true)}>
                    <IconPlus />
                    {t('missions.new')}
                  </GlassButton>
                ) : undefined
              }
            />
          ) : (
            <div className="stagger flex flex-col gap-3">
              {list.map(mission => (
                <MissionCard key={mission.id} mission={mission} selected={selected?.id === mission.id} onSelect={() => setSelectedId(mission.id)} />
              ))}
            </div>
          )}

          <Section
            title={t('missions.activity')}
            action={
              activity.length > ACTIVITY_SHORT ? (
                <LinkAction onClick={() => setShowAllActivity(v => !v)}>{showAllActivity ? t('missions.showLess') : t('missions.viewAll')}</LinkAction>
              ) : undefined
            }
          >
            <ActivityTimeline entries={recent} />
          </Section>
        </div>

        <div className="flex w-[420px] shrink-0 flex-col gap-3">
          {composing && <MissionComposer onClose={() => setComposing(false)} />}
          <GlassCard className="flex min-h-0 flex-1 flex-col overflow-y-auto p-5">
            {selected ? (
              <MissionDetail key={selected.id} mission={selected} />
            ) : (
              <EmptyGlass icon={<IconTarget />} title={t('missions.select')} description={t('missions.select.hint')} className="flex-1" />
            )}
          </GlassCard>
        </div>
      </div>
    </div>
  )
}
