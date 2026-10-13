import { afterEach, describe, expect, it } from 'vitest'
import { en } from '../locales/en.ts'
import { fr } from '../locales/fr.ts'
import { $backend, $prefs } from '../store/backend.ts'
import { assistantNameFor, format, pluralKey, resolveLocale, t, tn, translate } from './i18n.ts'

const initialPrefs = $prefs.get()
const initialBackend = $backend.get()

afterEach(() => {
  $prefs.set(initialPrefs)
  $backend.set(initialBackend)
})

describe('resolveLocale', () => {
  it('follows the setting first, then a French system, else English', () => {
    expect(resolveLocale('fr', 'en-US')).toBe('fr')
    expect(resolveLocale('en', 'fr-FR')).toBe('en')
    expect(resolveLocale('auto', 'fr-CA')).toBe('fr')
    expect(resolveLocale(undefined, 'de-DE')).toBe('en')
    expect(resolveLocale(undefined, undefined)).toBe('en')
  })
})

describe('assistantNameFor', () => {
  it('uses the chosen name, else the engine’s', () => {
    expect(assistantNameFor('Ada', 'jarod')).toBe('Ada')
    expect(assistantNameFor('  ', 'managed')).toBe('Hermes')
    expect(assistantNameFor(undefined, 'jarod')).toBe('Jarod')
    expect(assistantNameFor(undefined, 'attached')).toBe('Jarod')
    expect(assistantNameFor(undefined, undefined)).toBe('Jarod')
  })
})

describe('translate', () => {
  it('fills the assistant and the caller’s placeholders, and keeps unknown ones visible', () => {
    expect(translate('fr', 'overview.ready', {}, 'Jarod')).toBe('Jarod est prêt')
    expect(translate('en', 'recent.openFailed', { name: 'a.txt' })).toBe('Could not open "a.txt"')
    expect(format('{a} and {b}', { a: 1 })).toBe('1 and {b}')
  })

  it('picks plural forms the way each language does', () => {
    expect(pluralKey('en', 0)).toBe('other')
    expect(pluralKey('fr', 0)).toBe('one')
    expect(pluralKey('fr', 2)).toBe('other')
  })

  it('follows the stores: language setting and assistant name', () => {
    $prefs.set({ ...initialPrefs, language: 'fr', assistantName: undefined })
    $backend.set({ ...initialBackend, runtime: { kind: 'managed', label: 'Hermes', root: null, command: [] } as never })

    expect(t('overview.connecting')).toBe('Connexion à Hermes')
    expect(tn('memory.count', 1)).toBe('1 élément mémorisé')
    expect(tn('memory.count', 3)).toBe('3 éléments mémorisés')

    $prefs.set({ ...initialPrefs, language: 'en', assistantName: 'Ada' })

    expect(t('overview.connecting')).toBe('Connecting to Ada')
  })
})

describe('catalogues', () => {
  it('give French every key, with the same placeholders as English', () => {
    const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort()

    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      expect(fr[key], key).toBeTruthy()
      expect(placeholders(fr[key]), key).toEqual(placeholders(en[key]))
    }
  })
})
