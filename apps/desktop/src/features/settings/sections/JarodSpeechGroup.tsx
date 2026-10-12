import { IconLanguage, IconSpeakerphone, IconWaveSine } from '@tabler/icons-react'
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
  const api = useJarodSettings()
  const options = useBackendData(() => jarod<VoiceOptions>('get-jarod-options'))
  const voice = api.settings?.voice
  const stt = options.data?.sttProviders ?? []
  const voices = options.data?.voices ?? []
  const current = stt.find(p => p.id === voice?.sttProvider)

  if (!voice) {
    return api.error ? <InlineNote tone="danger">Could not read the speech settings: {api.error}</InlineNote> : null
  }

  return (
    <SettingsGroup title="Speech (Jarod engine)">
      <ChoiceRow
        icon={<IconLanguage />}
        label="Speech to text"
        description={speechSummary(current)}
        keywords="stt transcribe whisper openai groq lm studio"
        value={voice.sttProvider}
        options={(stt.length ? stt : [{ id: voice.sttProvider, name: voice.sttProvider, local: false, configured: true, defaultModel: '' }]).map(p => ({ id: p.id, label: `${p.name}${p.local && !/local|whisper/i.test(p.name) ? ' (this PC)' : ''}${p.configured ? '' : ' — needs a key'}` }))}
        disabled={api.saving}
        onChange={value => void api.save({ voice: { sttProvider: value } }, 'Speech to text changed')}
      />
      <TextRow
        icon={<IconWaveSine />}
        label="Transcription model"
        description={current?.defaultModel ? `Leave empty for ${current.defaultModel}.` : 'The model name the service knows.'}
        keywords="stt model whisper"
        value={voice.sttModel}
        mono
        allowEmpty
        disabled={api.saving}
        onSave={value => api.save({ voice: { sttModel: value } }, 'Model saved')}
      />
      <ChoiceRow
        icon={<IconSpeakerphone />}
        label="Voice"
        description={voices.length ? 'The voice of this PC that reads the answers.' : 'No voice found on this PC: reading aloud is unavailable.'}
        keywords="tts voice speak hortense zira"
        value={voice.ttsVoice}
        options={[{ id: '', label: 'Default voice' }, ...voices.map(name => ({ id: name, label: name })), ...(voice.ttsVoice && !voices.includes(voice.ttsVoice) ? [{ id: voice.ttsVoice, label: `${voice.ttsVoice} (not found)` }] : [])]}
        disabled={api.saving}
        onChange={value => void api.save({ voice: { ttsVoice: value } }, 'Voice changed')}
      />
      <NumberRow icon={<IconSpeakerphone />} label="Speaking speed" description="1 is normal; 0.25 to 4." keywords="tts rate speed" value={voice.ttsRate} format={rate => `${rate}×`} validate={rateProblem} disabled={api.saving} onSave={value => api.save({ voice: { ttsRate: value } }, 'Speed saved')} />
    </SettingsGroup>
  )
}
