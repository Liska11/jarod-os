import { useStore } from '@nanostores/react'
import { computed } from 'nanostores'
import { useMemo } from 'react'
import type { BackendRuntime, JarodOSPrefs } from '../../shared/ipc.ts'
import { en, type MessageKey } from '../locales/en.ts'
import { fr } from '../locales/fr.ts'
import { $backend, $prefs } from '../store/backend.ts'

/*
 * The interface's language and the assistant's name. Strings live in `src/locales/<lang>.ts`; `t('key', { name })` picks the
 * current language and fills `{assistant}` and the caller's placeholders. Components use `useT()` so they redraw when the
 * language or the name changes.
 */

export type Locale = 'en' | 'fr'
export type { MessageKey }

const CATALOGS: Record<Locale, Record<MessageKey, string>> = { en, fr }

/** The language to show: the one chosen in Settings, else the system's when it is French, else English. */
export function resolveLocale(preference: JarodOSPrefs['language'], systemLanguage: string | undefined): Locale {
  if (preference === 'en' || preference === 'fr') {
    return preference
  }

  return systemLanguage?.toLowerCase().startsWith('fr') ? 'fr' : 'en'
}

/** The assistant's name: the one chosen in Settings, else the engine's (Hermes for a Hermes runtime, Jarod for the Jarod core and anything else). */
export function assistantNameFor(preference: string | undefined, runtime: BackendRuntime['kind'] | undefined): string {
  const chosen = preference?.trim()

  if (chosen) {
    return chosen
  }

  return engineAssistantName(runtime)
}

export function engineAssistantName(runtime: BackendRuntime['kind'] | undefined): string {
  return runtime === 'env' || runtime === 'managed' || runtime === 'path' ? 'Hermes' : 'Jarod'
}

/** The window's language (a test runner has no window: English, so tests read the same everywhere). */
function systemLanguage(): string | undefined {
  return typeof window !== 'undefined' && typeof navigator !== 'undefined' ? navigator.language : undefined
}

export const $locale = computed($prefs, prefs => resolveLocale(prefs.language, systemLanguage()))
export const $assistantName = computed([$prefs, $backend], (prefs, backend) => assistantNameFor(prefs.assistantName, backend.runtime?.kind))

export type Vars = Record<string, string | number>

/** Fill `{name}` placeholders; an unknown one stays visible rather than vanishing. */
export function format(template: string, vars: Vars): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole))
}

export function translate(locale: Locale, key: MessageKey, vars: Vars = {}, assistant = 'Jarod'): string {
  return format(CATALOGS[locale][key] ?? en[key] ?? key, { assistant, ...vars })
}

/** Plural form: French treats 0 and 1 as singular, English only 1. */
export function pluralKey(locale: Locale, count: number): 'one' | 'other' {
  return (locale === 'fr' ? Math.abs(count) < 2 : Math.abs(count) === 1) ? 'one' : 'other'
}

/** The current-language string for `key` (outside React; components use `useT`). */
export function t(key: MessageKey, vars?: Vars): string {
  return translate($locale.get(), key, vars, $assistantName.get())
}

/** `t` for a count: picks `<base>.one` or `<base>.other` and passes `{count}`. */
export function tn(base: string, count: number, vars: Vars = {}): string {
  const locale = $locale.get()

  return translate(locale, `${base}.${pluralKey(locale, count)}` as MessageKey, { count, ...vars }, $assistantName.get())
}

/**
 * `t` and `tn` bound to the current language and name; the component redraws when either changes. The functions keep
 * their identity until then, so listing `t` in hook dependencies does not rerun the hook on every render.
 */
export function useT(): { t: typeof t; tn: typeof tn; locale: Locale; assistant: string } {
  const locale = useStore($locale)
  const assistant = useStore($assistantName)

  return useMemo(
    () => ({
      t: (key, vars) => translate(locale, key, vars, assistant),
      tn: (base, count, vars = {}) => translate(locale, `${base}.${pluralKey(locale, count)}` as MessageKey, { count, ...vars }, assistant),
      locale,
      assistant
    }),
    [locale, assistant]
  )
}

/** The display name and tagline of an app (sidebar, dock, command bar), in the current language. */
export function appText(id: string, fallback: { name: string; tagline: string }): { name: string; tagline: string } {
  const nameKey = `app.${id}` as MessageKey
  const taglineKey = `app.${id}.tagline` as MessageKey

  return {
    name: nameKey in en ? t(nameKey) : fallback.name,
    tagline: taglineKey in en ? t(taglineKey) : fallback.tagline
  }
}

/** The locale for dates and numbers: the chosen language, or the system's own formats when it is left automatic. */
export function dateLocale(): string | undefined {
  const preference = $prefs.get().language

  return preference === 'en' || preference === 'fr' ? preference : undefined
}
