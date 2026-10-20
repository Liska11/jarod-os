import { useStore } from '@nanostores/react'
import { IconLanguage, IconRobot } from '@tabler/icons-react'
import { useEffect, useState } from 'react'
import type { JarodOSPrefs } from '../../../../shared/ipc.ts'
import { GlassButton } from '../../../components/ui/glass.tsx'
import { engineAssistantName, useT } from '../../../lib/i18n.ts'
import { $backend, $prefs, updatePrefs } from '../../../store/backend.ts'
import { notify } from '../../../store/notifications.ts'
import { errorText, markSaved, MenuDropdown, SettingsGroup, SettingsRow } from './shared.tsx'

type Language = NonNullable<JarodOSPrefs['language']>

/** General > Language and name: the interface language and what the assistant is called. */
export function LanguageSettings() {
  const prefs = useStore($prefs)
  const backend = useStore($backend)
  const { t } = useT()
  const fallback = engineAssistantName(backend.runtime?.kind)
  const [name, setName] = useState(prefs.assistantName ?? '')
  const language: Language = prefs.language ?? 'auto'
  const labels: Record<Language, string> = { auto: t('language.auto'), en: t('language.en'), fr: t('language.fr') }

  useEffect(() => setName(prefs.assistantName ?? ''), [prefs.assistantName])

  const save = async (patch: Partial<JarodOSPrefs>) => {
    try {
      await updatePrefs(patch)
      markSaved()
    } catch (error) {
      notify({ title: 'Could not save setting', body: errorText(error), level: 'error' })
    }
  }

  const changed = name.trim() !== (prefs.assistantName ?? '')

  return (
    <SettingsGroup title={t('language.group')}>
      <SettingsRow icon={<IconLanguage />} label={t('language.label')} description={t('language.description')} keywords="language langue français english locale">
        <MenuDropdown
          ariaLabel={t('language.label')}
          label={labels[language]}
          value={language}
          items={(['auto', 'en', 'fr'] as const).map(id => ({ id, label: labels[id] }))}
          onSelect={id => void save({ language: id })}
        />
      </SettingsRow>
      <SettingsRow icon={<IconRobot />} label={t('assistantName.label')} description={t('assistantName.description', { fallback })} keywords="assistant name nom jarod hermes">
        <form
          className="flex items-center gap-2"
          onSubmit={event => {
            event.preventDefault()
            void save({ assistantName: name.trim() || undefined })
          }}
        >
          <input
            value={name}
            maxLength={32}
            onChange={event => setName(event.target.value)}
            placeholder={t('assistantName.placeholder', { fallback })}
            aria-label={t('assistantName.label')}
            className="glass-input h-8 w-40 rounded-lg px-2.5 text-[12.5px] outline-none placeholder:text-fg-4"
          />
          {changed && (
            <GlassButton size="sm" type="submit">
              {t('assistantName.save')}
            </GlassButton>
          )}
          {!changed && prefs.assistantName && (
            <GlassButton size="sm" type="button" variant="ghost" onClick={() => void save({ assistantName: undefined })}>
              {t('assistantName.reset')}
            </GlassButton>
          )}
        </form>
      </SettingsRow>
    </SettingsGroup>
  )
}
