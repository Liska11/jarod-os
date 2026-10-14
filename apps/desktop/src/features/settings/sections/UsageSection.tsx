import { useStore } from '@nanostores/react'
import { tn, useT } from '../../../lib/i18n.ts'
import { IconCalendarStats, IconChartBar, IconCoin, IconCreditCard, IconGauge, IconLayoutNavbar, IconRefresh } from '@tabler/icons-react'
import { useEffect, useState } from 'react'
import { GlassButton, ProgressBar, Toggle } from '../../../components/ui/glass.tsx'
import { formatDollars, formatTokens, planNote, planPercent, type UsageSummary } from '../../../lib/usage.ts'
import { $prefs, updatePrefs } from '../../../store/backend.ts'
import { $usage, loadUsage } from '../../../store/usage.ts'
import { openWebWindow } from '../../../store/web-windows.ts'
import { errorText, InlineNote, markSaved, SectionTitle, SettingsGroup, SettingsRow } from './shared.tsx'

/*
 * What Hermes has used: the provider plan's limits (Nous Portal reports them through `usage.bars`
 * and `billing.state`) and Hermes's own token accounting per session (`/api/analytics/usage`).
 */

export function UsageSection() {
  const { t } = useT()
  const usage = useStore($usage)
  const prefs = useStore($prefs)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = async () => {
    setLoading(true)

    try {
      await loadUsage()
      setError(null)
    } catch (reason) {
      setError(errorText(reason))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  const plan = usage?.plan
  const billing = usage?.billing
  const pct = planPercent(plan)

  return (
    <>
      <SectionTitle title={t('usage.title')} subtitle={t('usage.subtitle')} />

      <SettingsGroup title={t('usage.plan')}>
        {plan?.available ? (
          <>
            <SettingsRow
              icon={<IconGauge />}
              label={plan.plan_name || t('usage.yourPlan')}
              description={[plan.plan_bar ? t('usage.usedOf', { spent: plan.plan_bar.spent_display, total: plan.plan_bar.total_display }) : null, plan.renews_display ? t('usage.renews', { date: plan.renews_display }) : null].filter(Boolean).join(' · ') || undefined}
              keywords={t('usage.kw.plan')}
              below={plan.plan_bar ? <ProgressBar value={Math.round(pct ?? 0)} tone={pct !== null && pct >= 90 ? 'progress' : 'accent'} /> : undefined}
            >
              {pct !== null && <span className="text-[13px] font-medium tabular-nums text-fg">{Math.round(pct)}%</span>}
            </SettingsRow>
            {plan.topup_bar && (
              // A fuel gauge: `fill_fraction` is the share still left.
              <SettingsRow icon={<IconCoin />} label={t('usage.topup')} description={t('usage.leftOf', { remaining: plan.topup_bar.remaining_display, total: plan.topup_bar.total_display })} keywords={t('usage.kw.credit')} below={<ProgressBar value={Math.round((plan.topup_bar.fill_fraction ?? 0) * 100)} tone="ok" />} />
            )}
          </>
        ) : (
          <SettingsRow
            icon={<IconGauge />}
            label={t('usage.planLimits')}
            description={planNote({ unavailable: Boolean(usage?.planUnavailable), loggedIn: Boolean(billing?.logged_in) })}
            keywords={t('usage.kw.plan')}
          />
        )}
        {billing?.logged_in && (billing.balance_display || billing.monthly_cap) && (
          <SettingsRow
            icon={<IconCreditCard />}
            label={billing.org_name || t('usage.billing')}
            description={[billing.balance_display ? t('usage.balance', { amount: billing.balance_display }) : null, billing.monthly_cap ? t('usage.capThisMonth', { spent: billing.monthly_cap.spent_display, limit: billing.monthly_cap.limit_display }) : null].filter(Boolean).join(' · ')}
            keywords={t('usage.kw.billing')}
          >
            {billing.portal_url && (
              <GlassButton size="sm" onClick={() => void openWebWindow(billing.portal_url as string, { title: t('usage.billing') })}>
                {t('usage.manage')}
              </GlassButton>
            )}
          </SettingsRow>
        )}
      </SettingsGroup>

      <UsagePeriod title={t('usage.thisWeek')} icon={<IconChartBar />} summary={usage?.week ?? null} />
      <UsagePeriod title={t('usage.last30')} icon={<IconCalendarStats />} summary={usage?.month ?? null} />

      <SettingsGroup title={t('menubar.title')}>
        <SettingsRow icon={<IconLayoutNavbar />} label={t('usage.showInMenuBar')} description={t('usage.showInMenuBarDesc')} keywords={t('usage.kw.menubar')}>
          <Toggle checked={Boolean(prefs.usageInMenuBar)} onChange={next => void updatePrefs({ usageInMenuBar: next }).then(markSaved)} label={t('usage.showInMenuBar')} />
        </SettingsRow>
      </SettingsGroup>

      <div className="flex items-center justify-between gap-3">
        {error ? <InlineNote tone="danger">{error}</InlineNote> : <span className="text-[11.5px] text-fg-4">{usage ? t('usage.updated', { time: new Date(usage.loadedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }) : ''}</span>}
        <GlassButton size="sm" variant="ghost" disabled={loading} onClick={() => void refresh()}>
          <IconRefresh />
          {loading ? t('usage.refreshing') : t('usage.refresh')}
        </GlassButton>
      </div>
    </>
  )
}

function UsagePeriod({ title, icon, summary }: { title: string; icon: React.ReactNode; summary: UsageSummary | null }) {
  const { t } = useT()

  if (!summary) {
    return null
  }

  const peak = Math.max(1, ...summary.daily.map(day => day.tokens))

  return (
    <SettingsGroup title={title}>
      <SettingsRow
        icon={icon}
        label={t('usage.tokens', { count: formatTokens(summary.tokens) })}
        description={[tn('usage.sessions', summary.sessions), summary.cost > 0 ? t('usage.aboutCost', { cost: formatDollars(summary.cost) }) : null, summary.topModel ? t('usage.mostly', { model: summary.topModel }) : null].filter(Boolean).join(' · ')}
        keywords={t('usage.kw.tokens')}
        below={
          summary.daily.length > 1 ? (
            <div className="flex h-10 items-end gap-1" aria-label={t('usage.perDayAria', { period: title.toLowerCase() })}>
              {summary.daily.slice(-30).map(day => (
                <span key={day.day} title={t('usage.perDayTitle', { day: day.day, count: formatTokens(day.tokens) })} className="min-w-1 flex-1 rounded-t-sm bg-accent/60" style={{ height: `${Math.max(4, (day.tokens / peak) * 100)}%` }} />
              ))}
            </div>
          ) : undefined
        }
      >
        <span className="text-[12px] tabular-nums text-fg-3">
          {t('usage.inOut', { input: formatTokens(summary.input), output: formatTokens(summary.output) })}
        </span>
      </SettingsRow>
    </SettingsGroup>
  )
}
