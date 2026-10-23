import { IconArrowDown, IconArrowUp, IconPencil, IconTrash } from '@tabler/icons-react'
import { useState } from 'react'
import { GlassButton, Pill } from '../../../components/ui/glass.tsx'
import { t, useT } from '../../../lib/i18n.ts'
import { jarod } from '../../../lib/jarod.ts'
import { notify } from '../../../store/notifications.ts'
import { reportEngineError } from './jarod-controls.tsx'
import {
  EMPTY_RULE_FORM,
  formOf,
  grantAction,
  kindOf,
  type PermissionRule,
  type PermissionsAction,
  RULE_FORM_DURATIONS,
  RULE_KIND_LABEL,
  ruleExpiryText,
  type RuleForm,
  ruleFormProblem,
  type RuleKind,
  ruleKey,
  ruleRef,
  ruleSpentText,
  updateAction
} from './jarod-settings-model.ts'
import { InlineNote } from './shared.tsx'

/*
 * The permission rules, edited through the engine's permissions service — the one `jarod permissions` uses. Adding or editing shows what
 * will change first (`permissions-plan`); applying (`permissions-apply`) asks a native confirmation when it gives the agent more power, and
 * re-reads the list just before writing, so a use the agent spent meanwhile is never handed back. Quick changes (decision, order, removal)
 * apply at once, under the same confirmation.
 */

const KINDS: readonly RuleKind[] = ['allow', 'auto', 'ask', 'deny']

type Plan = { summary: string[]; weakenings: string[]; action: PermissionsAction }

export function PermissionRulesEditor({ rules, reload }: { rules: readonly PermissionRule[]; reload: () => void }) {
  useT()
  const [form, setForm] = useState<RuleForm>(EMPTY_RULE_FORM)
  const [editing, setEditing] = useState<{ ref: string; rule: PermissionRule } | null>(null)
  const [plan, setPlan] = useState<Plan | null>(null)
  const [busy, setBusy] = useState(false)
  const problem = form.tool.trim() ? ruleFormProblem(form) : null
  const set = (patch: Partial<RuleForm>) => {
    setForm(current => ({ ...current, ...patch }))
    setPlan(null)
  }

  const reset = () => {
    setForm(EMPTY_RULE_FORM)
    setEditing(null)
    setPlan(null)
  }

  const apply = async (action: PermissionsAction): Promise<boolean> => {
    setBusy(true)

    try {
      await jarod('permissions-apply', action)
      notify({ title: t('settings.agent.rulesApplied'), level: 'success' })

      return true
    } catch (error) {
      reportEngineError(t('controls.saveFailed'), error)

      return false
    } finally {
      setBusy(false)
      reload()
    }
  }

  const review = async () => {
    const action = editing ? updateAction(editing.ref, editing.rule, form) : grantAction(form)
    setBusy(true)

    try {
      const result = await jarod<{ summary: string[]; weakenings: string[] }>('permissions-plan', action)
      setPlan({ ...result, action })
    } catch (error) {
      reportEngineError(t('settings.agent.planFailed'), error)
    } finally {
      setBusy(false)
    }
  }

  const changeKind = (rule: PermissionRule, index: number, kind: RuleKind) => {
    const next = { ...formOf(rule), kind, ...(kind === 'ask' || kind === 'deny' ? { uses: '' } : {}) }
    void apply(updateAction(ruleRef(rule, index), rule, next))
  }

  return (
    <div className="flex flex-col gap-2" data-testid="permission-rules">
      {rules.length === 0 && <span className="text-[12px] text-fg-4">{t('settings.agent.noRules')}</span>}
      {rules.map((rule, index) => {
        const ref = ruleRef(rule, index)
        const spent = ruleSpentText(rule)

        return (
          <div key={ref} className="flex items-center gap-2" data-testid="permission-rule">
            <span className="w-5 text-right text-[11px] text-fg-4">{index + 1}</span>
            <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-fg-2" title={rule.note ?? undefined}>
              {ruleKey(rule)}
            </span>
            {rule.id && <span className="font-mono text-[10.5px] text-fg-4">{rule.id}</span>}
            {rule.by && <Pill tone="muted">{t(rule.by === 'commande' ? 'settings.agent.rule.byCommand' : 'settings.agent.rule.bySettings')}</Pill>}
            {kindOf(rule) === 'auto' && <Pill tone="warn">{t('settings.agent.rule.autonomous')}</Pill>}
            {rule.uses !== undefined && rule.uses > 0 && <Pill tone="warn">{t('settings.agent.rule.uses', { n: rule.uses })}</Pill>}
            {!spent && ruleExpiryText(rule) && <Pill tone="warn">{ruleExpiryText(rule)}</Pill>}
            {spent && <Pill tone="muted">{spent}</Pill>}
            <select value={kindOf(rule)} disabled={busy} onChange={event => changeKind(rule, index, event.target.value as RuleKind)} aria-label={t('settings.agent.decisionFor', { tool: ruleKey(rule) })} style={{ colorScheme: 'dark' }} className="glass-input h-7 rounded-md px-1.5 text-[12px] text-fg outline-none">
              {KINDS.map(kind => (
                <option key={kind} value={kind}>
                  {t(RULE_KIND_LABEL[kind])}
                </option>
              ))}
            </select>
            <GlassButton
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setEditing({ ref, rule })
                setForm(formOf(rule))
                setPlan(null)
              }}
              aria-label={t('settings.agent.editRule', { tool: ruleKey(rule) })}
            >
              <IconPencil />
            </GlassButton>
            <GlassButton size="sm" variant="ghost" disabled={busy || index === 0} onClick={() => void apply({ op: 'move', ref, to: index })} aria-label={t('settings.agent.moveUp', { name: ruleKey(rule) })}>
              <IconArrowUp />
            </GlassButton>
            <GlassButton size="sm" variant="ghost" disabled={busy || index === rules.length - 1} onClick={() => void apply({ op: 'move', ref, to: index + 2 })} aria-label={t('settings.agent.moveDown', { name: ruleKey(rule) })}>
              <IconArrowDown />
            </GlassButton>
            <GlassButton size="sm" variant="ghost" disabled={busy} onClick={() => void apply({ op: 'revoke', ref })} aria-label={t('settings.agent.removeRule', { tool: ruleKey(rule) })}>
              <IconTrash />
            </GlassButton>
          </div>
        )
      })}

      <form
        className="mt-1 flex flex-col gap-2 rounded-lg border border-white/8 p-2"
        aria-label={editing ? t('settings.agent.editRule', { tool: ruleKey(editing.rule) }) : t('settings.agent.addRule')}
        onSubmit={event => {
          event.preventDefault()

          if (form.tool.trim() && !problem) {
            void review()
          }
        }}
      >
        <div className="flex flex-wrap items-center gap-2">
          <Field label={t('settings.agent.newRule.tool')} value={form.tool} placeholder={t('settings.agent.newRule.placeholder')} disabled={Boolean(editing)} onChange={tool => set({ tool })} />
          <Field label={t('settings.agent.newRule.target')} value={form.target} placeholder={t('settings.agent.newRule.targetPlaceholder')} onChange={target => set({ target })} />
          <select value={form.kind} onChange={event => set({ kind: event.target.value as RuleKind })} aria-label={t('settings.agent.newRule.decision')} style={{ colorScheme: 'dark' }} className="glass-input h-8 rounded-lg px-2 text-[12.5px] text-fg outline-none">
            {KINDS.map(kind => (
              <option key={kind} value={kind}>
                {t(RULE_KIND_LABEL[kind])}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Field label={t('settings.agent.newRule.operation')} value={form.operation} placeholder={t('settings.agent.newRule.operation')} onChange={operation => set({ operation })} />
          <Field label={t('settings.agent.newRule.session')} value={form.session} placeholder={t('settings.agent.newRule.session')} onChange={session => set({ session })} />
          <Field label={t('settings.agent.newRule.uses')} value={form.uses} placeholder={t('settings.agent.newRule.uses')} onChange={uses => set({ uses })} narrow />
          <select value={form.hours} onChange={event => set({ hours: Number(event.target.value) })} aria-label={t('settings.agent.newRule.duration')} style={{ colorScheme: 'dark' }} className="glass-input h-8 rounded-lg px-2 text-[12.5px] text-fg outline-none">
            {editing?.rule.expiresAt !== undefined && <option value={-1}>{t('settings.agent.duration.keep', { when: ruleExpiryText(editing!.rule) ?? '' })}</option>}
            {RULE_FORM_DURATIONS.map(d => (
              <option key={d.hours} value={d.hours}>
                {t(d.label)}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Field label={t('settings.agent.newRule.note')} value={form.note} placeholder={t('settings.agent.newRule.note')} onChange={note => set({ note })} />
          {form.kind === 'auto' && (
            <label className="flex items-center gap-1.5 text-[12px] text-fg-3">
              <input type="checkbox" checked={form.broad} onChange={event => set({ broad: event.target.checked })} />
              {t('settings.agent.newRule.broad')}
            </label>
          )}
          <span className="flex-1" />
          {editing && (
            <GlassButton size="sm" variant="ghost" onClick={reset}>
              {t('settings.agent.cancel')}
            </GlassButton>
          )}
          <GlassButton type="submit" size="sm" variant="secondary" disabled={busy || !form.tool.trim() || Boolean(problem)}>
            {t('settings.agent.reviewRule')}
          </GlassButton>
        </div>
        {problem && <InlineNote tone="warn">{problem}</InlineNote>}
        {plan && (
          <div className="flex flex-col gap-1 rounded-md bg-white/5 p-2 text-[12px] text-fg-2" data-testid="permission-plan">
            <span className="text-fg-3">{t('settings.agent.plan.title')}</span>
            {plan.summary.map(line => (
              <span key={line}>{line}</span>
            ))}
            {plan.weakenings.length > 0 && (
              <>
                <span className="mt-1 text-warn">{t('settings.agent.plan.weakens')}</span>
                {plan.weakenings.map(line => (
                  <span key={line}>• {line}</span>
                ))}
              </>
            )}
            <div className="mt-1 flex justify-end gap-2">
              <GlassButton size="sm" variant="ghost" onClick={() => setPlan(null)}>
                {t('settings.agent.cancel')}
              </GlassButton>
              <GlassButton size="sm" variant="primary" disabled={busy} onClick={() => void apply(plan.action).then(ok => ok && reset())}>
                {t('settings.agent.apply')}
              </GlassButton>
            </div>
          </div>
        )}
      </form>
      <span className="text-[11.5px] text-fg-4">{t('settings.agent.rules.same')}</span>
    </div>
  )
}

function Field({ label, value, placeholder, onChange, disabled, narrow }: { label: string; value: string; placeholder: string; onChange: (value: string) => void; disabled?: boolean; narrow?: boolean }) {
  return (
    <label className={`glass-input flex h-8 min-w-0 items-center rounded-lg px-2.5 ${narrow ? 'w-28' : 'flex-1'}`}>
      <span className="sr-only">{label}</span>
      <input value={value} disabled={disabled} onChange={event => onChange(event.target.value)} placeholder={placeholder} spellCheck={false} className="min-w-0 flex-1 bg-transparent font-mono text-[12.5px] outline-none placeholder:text-fg-4 disabled:opacity-60" />
    </label>
  )
}
