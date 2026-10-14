import { IconLanguage, IconSpeakerphone, IconWaveSine } from '@tabler/icons-react'
import { useT } from '../../../lib/i18n.ts'
import { jarod } from '../../../lib/jarod.ts'
import { useBackendData } from '../../../lib/use-async.ts'
import { ChoiceRow, NumberRow, TextRow, useJarodSettings } from './jarod-controls.tsx'
import type { JarodOptions } from './jarod-settings-model.ts'
import { InlineNote, SettingsGroup } from './shared.tsx'
import { rateProblem, speechSummary, type SttProviderOption } from './speech-model.ts'

/*
 * Speech with the Jarod engine: which service turns your voice into text (a hosted one with a key, or a server on this PC), and which voice of this PC reads the
 * answers. The engine transcribes through `/api/audio/transcribe` and renders the voice as audio the window plays; nothing is spoken on the engine's own speaker.
 */

type VoiceOptions = JarodOptions & { sttProviders?: SttProviderOption[]; voices?: string[] }

export function JarodSpeechGroup() {
  const { t } = useT()
  const api = useJarodSettings()
  const options = useBackendData(() => jarod<VoiceOptions>('get-jarod-options'))
  const voice = api.settings?.voice
  const stt = options.data?.sttProviders ?? []
  const voices = options.data?.voices ?? []
  const current = stt.find(p => p.id === voice?.sttProvider)

  if (!voice) {
    return api.error ? <InlineNote tone="danger">{t('speech.readFailed', { error: api.error })}</InlineNote> : null
  }

  return (
    <SettingsGroup title={t('speech.group')}>
      <ChoiceRow
        icon={<IconLanguage />}
        label={t('speech.stt')}
        description={speechSummary(current)}
        keywords={t('speech.sttKw')}
        value={voice.sttProvider}
        options={(stt.length ? stt : [{ id: voice.sttProvider, name: voice.sttProvider, local: false, configured: true, defaultModel: '' }]).map(p => ({ id: p.id, label: `${p.name}${p.local && !/local|whisper/i.test(p.name) ? t('speech.thisPc') : ''}${p.configured ? '' : t('speech.needsKey')}` }))}
        disabled={api.saving}
        onChange={value => void api.save({ voice: { sttProvider: value } }, t('speech.sttChanged'))}
      />
      <TextRow
        icon={<IconWaveSine />}
        label={t('speech.model')}
        description={current?.defaultModel ? t('speech.leaveEmpty', { model: current.defaultModel }) : t('speech.modelHint')}
        keywords={t('speech.modelKw')}
        value={voice.sttModel}
        mono
        allowEmpty
        disabled={api.saving}
        onSave={value => api.save({ voice: { sttModel: value } }, t('speech.modelSaved'))}
      />
      <ChoiceRow
        icon={<IconSpeakerphone />}
        label={t('speech.voice')}
        description={voices.length ? t('speech.voiceHint') : t('speech.noVoice')}
        keywords={t('speech.voiceKw')}
        value={voice.ttsVoice}
        options={[{ id: '', label: t('speech.defaultVoice') }, ...voices.map(name => ({ id: name, label: name })), ...(voice.ttsVoice && !voices.includes(voice.ttsVoice) ? [{ id: voice.ttsVoice, label: t('speech.notFound', { name: voice.ttsVoice }) }] : [])]}
        disabled={api.saving}
        onChange={value => void api.save({ voice: { ttsVoice: value } }, t('speech.voiceChanged'))}
      />
      <NumberRow icon={<IconSpeakerphone />} label={t('speech.speed')} description={t('speech.speedDesc')} keywords={t('speech.speedKw')} value={voice.ttsRate} format={rate => `${rate}×`} validate={rateProblem} disabled={api.saving} onSave={value => api.save({ voice: { ttsRate: value } }, t('speech.speedSaved'))} />
    </SettingsGroup>
  )
}
