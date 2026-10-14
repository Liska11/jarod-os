import { useState } from 'react'
import { dateLocale, t, useT } from '../../../lib/i18n.ts'
import { GlassButton, Toggle } from '../../../components/ui/glass.tsx'
import { jarod } from '../../../lib/jarod.ts'
import { useBackendData } from '../../../lib/use-async.ts'
import { notify } from '../../../store/notifications.ts'
import { isUserRefusal, type JarodSettings, settingErrorText } from './jarod-settings-model.ts'
import { InlineNote, markSaved, SettingsRow } from './shared.tsx'

/*
 * Controls shared by the sections that edit Jarod's own settings. A change goes to the engine as one `set-jarod-settings` patch; the engine validates it and,
 * when it gives the agent more power or sends data elsewhere, asks for a native confirmation. Pressing Cancel there is reported as "not changed", not as an error.
 */

export interface JarodSettingsApi {
  settings: JarodSettings | null
  error: string | null
  loading: boolean
  saving: boolean
  reload: () => void
  /** Resolves true when the engine stored the change. */
  save: (patch: Record<string, unknown>, title?: string) => Promise<boolean>
}

/** One way to report a refused or failed engine call: a Cancel on the engine's native confirmation is "not changed", anything else is the engine's own sentence. */
export function reportEngineError(title: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)

  if (isUserRefusal(message)) {
    notify({ title: t('controls.notChanged'), body: t('controls.cancelled'), level: 'info' })
  } else {
    notify({ title, body: settingErrorText(message), level: 'error' })
  }
}

export function useJarodSettings(): JarodSettingsApi {
  const data = useBackendData(() => jarod<JarodSettings>('get-jarod-settings'))
  const [saving, setSaving] = useState(false)
  const reload = data.reload

  const save = async (patch: Record<string, unknown>, title = t('controls.saved')): Promise<boolean> => {
    setSaving(true)

    try {
      await jarod('set-jarod-settings', patch)
      markSaved()
      notify({ title, level: 'success' })

      return true
    } catch (error) {
      reportEngineError(t('controls.saveFailed'), error)

      return false
    } finally {
      setSaving(false)
      reload()
    }
  }

  return { settings: data.data, error: data.error, loading: data.loading, saving, reload, save }
}

type RowShell = { icon?: React.ReactNode; label: string; description?: React.ReactNode; keywords?: string }

export function SwitchRow({ value, onChange, disabled, ...row }: RowShell & { value: boolean; onChange: (value: boolean) => void; disabled?: boolean }) {
  return (
    <SettingsRow {...row}>
      <Toggle checked={value} onChange={onChange} label={row.label} disabled={disabled} />
    </SettingsRow>
  )
}

export function ChoiceRow<T extends string>({ value, options, onChange, disabled, ...row }: RowShell & { value: T; options: readonly { id: T; label: string }[]; onChange: (value: T) => void; disabled?: boolean }) {
  return (
    <SettingsRow {...row}>
      <select value={value} disabled={disabled} onChange={event => onChange(event.target.value as T)} aria-label={row.label} style={{ colorScheme: 'dark' }} className="glass-input h-8 max-w-[260px] rounded-lg px-2 text-[12.5px] text-fg outline-none">
        {options.map(option => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
    </SettingsRow>
  )
}

/** A value shown in the description, edited inline as text; Save sends the parsed number. */
export function NumberRow({ value, format, validate, onSave, disabled, hint, ...row }: RowShell & { value: number; format?: (value: number) => string; validate: (text: string) => string | null; onSave: (value: number) => Promise<boolean>; disabled?: boolean; hint?: string }) {
  const { t } = useT()
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState('')
  const problem = editing ? validate(text) : null

  return (
    <SettingsRow
      {...row}
      description={
        <>
          {row.description} <span className="text-fg-2">{t('controls.now', { value: format ? format(value) : value.toLocaleString(dateLocale() ?? 'en-US') })}</span>
        </>
      }
      below={
        editing && (
          <form
            className="flex flex-col gap-2 pt-1"
            onSubmit={event => {
              event.preventDefault()

              if (!problem) {
                void onSave(Number(text.trim())).then(ok => ok && setEditing(false))
              }
            }}
          >
            <label className="glass-input flex h-9 items-center rounded-lg px-3">
              <span className="sr-only">{row.label}</span>
              <input autoFocus value={text} onChange={event => setText(event.target.value)} inputMode="decimal" className="min-w-0 flex-1 bg-transparent font-mono text-[12.5px] outline-none" />
            </label>
            {problem && <InlineNote tone="warn">{problem}</InlineNote>}
            {hint && <div className="text-[11.5px] text-fg-4">{hint}</div>}
            <div className="flex justify-end gap-2">
              <GlassButton type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>
                {t('controls.cancel')}
              </GlassButton>
              <GlassButton type="submit" size="sm" variant="primary" disabled={Boolean(problem) || disabled}>
                {t('controls.save')}
              </GlassButton>
            </div>
          </form>
        )
      }
    >
      <GlassButton size="sm" variant="secondary" disabled={disabled} onClick={() => (setText(String(value)), setEditing(true))} aria-label={t('controls.changeAria', { label: row.label })}>
        {t('controls.change')}
      </GlassButton>
    </SettingsRow>
  )
}

/** A text value shown in the description, edited inline; Save sends the trimmed text (empty allowed when `allowEmpty`). */
export function TextRow({ value, validate, onSave, disabled, placeholder, mono, allowEmpty, ...row }: RowShell & { value: string; validate?: (text: string) => string | null; onSave: (value: string) => Promise<boolean>; disabled?: boolean; placeholder?: string; mono?: boolean; allowEmpty?: boolean }) {
  const { t } = useT()
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState('')
  const problem = editing ? (!text.trim() && !allowEmpty ? t('controls.required') : (validate?.(text.trim()) ?? null)) : null

  return (
    <SettingsRow
      {...row}
      description={
        <>
          {row.description}{' '}
          <span className="text-fg-2">
            {t('controls.nowPrefix')} {value ? <span className={mono ? 'font-mono' : ''}>{value}</span> : t('controls.notSet')}.
          </span>
        </>
      }
      below={
        editing && (
          <form
            className="flex flex-col gap-2 pt-1"
            onSubmit={event => {
              event.preventDefault()

              if (!problem) {
                void onSave(text.trim()).then(ok => ok && setEditing(false))
              }
            }}
          >
            <label className="glass-input flex h-9 items-center rounded-lg px-3">
              <span className="sr-only">{row.label}</span>
              <input autoFocus value={text} onChange={event => setText(event.target.value)} placeholder={placeholder} spellCheck={false} className={`min-w-0 flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-fg-4 ${mono ? 'font-mono' : ''}`} />
            </label>
            {problem && <InlineNote tone="warn">{problem}</InlineNote>}
            <div className="flex justify-end gap-2">
              <GlassButton type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>
                {t('controls.cancel')}
              </GlassButton>
              <GlassButton type="submit" size="sm" variant="primary" disabled={Boolean(problem) || disabled}>
                {t('controls.save')}
              </GlassButton>
            </div>
          </form>
        )
      }
    >
      <GlassButton size="sm" variant="secondary" disabled={disabled} onClick={() => (setText(value), setEditing(true))} aria-label={t('controls.changeAria', { label: row.label })}>
        {t('controls.change')}
      </GlassButton>
    </SettingsRow>
  )
}

/** A list of short strings (programs, folders, tool names): remove with the cross, add through the field. `validate` answers instantly; the engine decides. */
export function ChipsEditor({ items, validate, onChange, disabled, placeholder, label }: { items: readonly string[]; validate: (item: string) => string | null; onChange: (items: string[]) => Promise<boolean>; disabled?: boolean; placeholder: string; label: string }) {
  const { t } = useT()
  const [draft, setDraft] = useState('')
  const problem = draft.trim() ? validate(draft) : null
  const duplicate = items.includes(draft.trim())

  const add = async () => {
    const item = draft.trim()

    if (item && !problem && !duplicate && (await onChange([...items, item]))) {
      setDraft('')
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1.5">
        {items.length === 0 && <span className="text-[12px] text-fg-4">{t('controls.none')}</span>}
        {items.map(item => (
          <span key={item} className="flex items-center gap-1 rounded-md bg-white/8 px-2 py-1 font-mono text-[12px] text-fg-2">
            {item}
            <button type="button" disabled={disabled} onClick={() => void onChange(items.filter(other => other !== item))} aria-label={t('controls.removeAria', { item, label })} className="text-fg-4 hover:text-fg disabled:opacity-40">
              ×
            </button>
          </span>
        ))}
      </div>
      <form
        className="flex items-center gap-2"
        onSubmit={event => {
          event.preventDefault()
          void add()
        }}
      >
        <label className="glass-input flex h-8 min-w-0 flex-1 items-center rounded-lg px-2.5">
          <span className="sr-only">{t('controls.addToAria', { label })}</span>
          <input value={draft} onChange={event => setDraft(event.target.value)} placeholder={placeholder} spellCheck={false} className="min-w-0 flex-1 bg-transparent font-mono text-[12.5px] outline-none placeholder:text-fg-4" />
        </label>
        <GlassButton type="submit" size="sm" variant="secondary" disabled={disabled || !draft.trim() || Boolean(problem) || duplicate}>
          {t('controls.add')}
        </GlassButton>
      </form>
      {(problem || duplicate) && <InlineNote tone="warn">{duplicate ? t('controls.alreadyListed') : problem}</InlineNote>}
    </div>
  )
}
