import type { UsageModel } from '@herald-os/client'
import { describe, expect, it } from 'vitest'
import { formatDollars, formatTokens, limitAlertKey, planNote, planPercent, summariseUsage } from './usage.ts'

describe('summariseUsage', () => {
  it('adds up tokens, picks the busiest model and prefers the actual cost', () => {
    const summary = summariseUsage(
      {
        period_days: 7,
        totals: { total_input: 1_200_000, total_output: 300_000, total_estimated_cost: 4.2, total_actual_cost: 3.9, total_sessions: 12 },
        by_model: [
          { model: 'small', input_tokens: 100, output_tokens: 50 },
          { model: 'hermes-4', input_tokens: 1_100_000, output_tokens: 290_000 }
        ],
        daily: [{ day: '2026-10-05', input_tokens: 10, output_tokens: 5 }, { day: '2026-10-06', input_tokens: null, output_tokens: 7 }, {}]
      },
      7
    )

    expect(summary).toEqual({ days: 7, tokens: 1_500_000, input: 1_200_000, output: 300_000, sessions: 12, cost: 3.9, topModel: 'hermes-4', daily: [{ day: '2026-10-05', tokens: 15 }, { day: '2026-10-06', tokens: 7 }] })
  })

  it('survives an empty answer', () => {
    expect(summariseUsage({}, 30)).toMatchObject({ days: 30, tokens: 0, sessions: 0, cost: 0, topModel: null, daily: [] })
  })
})

describe('formatting', () => {
  it('shortens token counts and money', () => {
    expect(formatTokens(950)).toBe('950')
    expect(formatTokens(1234)).toBe('1.2k')
    expect(formatTokens(3_400_000)).toBe('3.4M')
    expect(formatTokens(250_000_000)).toBe('250M')
    expect(formatDollars(3.456)).toBe('$3.46')
    expect(formatDollars(240.4)).toBe('$240')
  })
})

describe('plan limits', () => {
  const plan = (pct: number | null, renews = '2026-11-01'): UsageModel => ({ available: true, plan_name: 'Pro', renews_at: renews, plan_bar: { kind: 'plan', remaining_display: '', total_display: '', spent_display: '', pct_used: pct, fill_fraction: (pct ?? 0) / 100 } })

  it('reads the percentage only from an available plan', () => {
    expect(planPercent(plan(72))).toBe(72)
    expect(planPercent({ available: false })).toBeNull()
    expect(planPercent(plan(null))).toBeNull()
  })

  it('alerts once per billing period past the threshold', () => {
    expect(limitAlertKey(plan(80), 90, null)).toBeNull()
    expect(limitAlertKey(plan(92), 90, null)).toBe('2026-11-01:90')
    expect(limitAlertKey(plan(95), 90, '2026-11-01:90')).toBeNull()
    expect(limitAlertKey(plan(91, '2026-12-01'), 90, '2026-11-01:90')).toBe('2026-12-01:90')
  })
})

describe('planNote', () => {
  it('says the engine has no plan reporting before suggesting a sign-in', () => {
    expect(planNote({ unavailable: true, loggedIn: false })).toBe('Not available in this version.')
    expect(planNote({ unavailable: true, loggedIn: true })).toBe('Not available in this version.')
    expect(planNote({ unavailable: false, loggedIn: true })).toBe('Your provider does not report plan limits.')
    expect(planNote({ unavailable: false, loggedIn: false })).toContain('Nous Portal')
  })
})
