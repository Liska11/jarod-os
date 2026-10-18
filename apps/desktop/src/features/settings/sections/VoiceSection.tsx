import { $echoFallback, setDuplex } from '../../../store/voice-echo.ts'
import { $voiceMetrics, median } from '../../../store/voice-metrics.ts'
import { useStore } from '@nanostores/react'
import { IconBellRinging, IconBolt, IconClockPause, IconCoin, IconEar, IconEye, IconHourglass, IconKeyboard, IconLanguage, IconListDetails, IconMicrophone, IconPlayerPlay, IconSpeakerphone, IconVolume, IconWaveSine } from '@tabler/icons-react'
import { useEffect, useState } from 'react'
import type { MicPermission, VoiceEngine, VoicePrefs } from '../../../../shared/ipc.ts'
import { GlassButton, Pill, Toggle } from '../../../components/ui/glass.tsx'
import { privacySettingsPath } from '../../../lib/platform-labels.ts'
import { rest } from '../../../lib/rest.ts'
import { $engineKind } from '../../../store/engine.ts'
import { JarodSpeechGroup } from './JarodSpeechGroup.tsx'
import { useBackendData } from '../../../lib/use-async.ts'
import { LOCAL_STT_MODELS } from '../../../lib/voice/stt-tuning.ts'
import { $prefs, updatePrefs } from '../../../store/backend.ts'
import { notify } from '../../../store/notifications.ts'
import { $voice, $voiceActive, LIVE_RATE_PER_MINUTE, liveSecondsToday, speakWithFreeFallback, startVoice } from '../../../store/voice.ts'
import { fetchLiveStatus, type LiveStatus } from '../../../store/voice-live-status.ts'
import { $wake, setWakeWordEnabled } from '../../../store/wake.ts'
import { errorText, focusSettings, InlineNote, markSaved, MenuDropdown, RadioCard, SectionTitle, SettingsGroup, SettingsRow, Stepper } from './shared.tsx'
import { t, useT } from '../../../lib/i18n.ts'

/*
 * Voice: the two engines (free chained pipeline, paid GPT-Live), how a conversation starts (wake
 * word, hotkey), the speech providers Hermes uses (written to the runtime's config.yaml through
 * PUT /api/config), and the Live cost controls. See docs/VOICE.md.
 */

interface HermesConfig {
  stt?: { provider?: string; local?: { model?: string }; [key: string]: unknown }
  tts?: { provider?: string; [key: string]: unknown }
  [key: string]: unknown
}

const STT_PROVIDERS = [
  { id: 'nous', label: 'Nous subscription', description: 'OpenAI transcription through the Nous gateway; no extra cost' },
  { id: 'local', label: 'On this device (faster-whisper)', description: 'Free and private; slower on long utterances' },
  { id: 'openai', label: 'OpenAI', description: 'gpt-4o-mini-transcribe with your OPENAI_API_KEY' },
  { id: 'groq', label: 'Groq Whisper', description: 'GROQ_API_KEY' },
  { id: 'mistral', label: 'Mistral Voxtral', description: 'MISTRAL_API_KEY' },
  { id: 'elevenlabs', label: 'ElevenLabs Scribe', description: 'ELEVENLABS_API_KEY' }
] as const

const TTS_PROVIDERS = [
  { id: 'nous', label: 'Nous subscription', description: 'gpt-4o-mini-tts through the Nous gateway; no extra cost' },
  { id: 'edge', label: 'Edge neural voices', description: 'Free, no key; whole sentences at a time' },
  { id: 'openai', label: 'OpenAI', description: 'gpt-4o-mini-tts, streams sentence by sentence' },
  { id: 'elevenlabs', label: 'ElevenLabs', description: 'Most expressive; streams; paid' },
  { id: 'neutts', label: 'NeuTTS (local)', description: 'Runs on this device; needs the neutts extra' },
  { id: 'kittentts', label: 'KittenTTS (local)', description: 'Tiny local model' },
  { id: 'piper', label: 'Piper (local)', description: 'Fast local voices' }
] as const

const IDLE_OPTIONS = [20, 30, 45, 60, 120, 300]
const CAP_OPTIONS = [0, 15, 30, 60, 120, 240]

export function VoiceSection() {
  useT()
  const prefs = useStore($prefs)
  const voice = prefs.voice
  const echoFallback = useStore($echoFallback)
  const wake = useStore($wake)
  const live = useStore($voice).live
  const active = useStore($voiceActive)
  const engineKind = useStore($engineKind)
  const config = useBackendData(() => rest.get<HermesConfig>('/api/config'))
  const [liveStatus, setLiveStatus] = useState<LiveStatus | null>(live.status)
  const [mic, setMic] = useState<MicPermission>('unknown')
  const [hotkeyDraft, setHotkeyDraft] = useState(voice.hotkey)
  const [testing, setTesting] = useState(false)

  useEffect(() => {
    void fetchLiveStatus().then(setLiveStatus)
    void window.heraldOS.voice.microphoneStatus().then(setMic)
  }, [])

  useEffect(() => setHotkeyDraft(voice.hotkey), [voice.hotkey])

  const save = async (patch: Partial<VoicePrefs>) => {
    try {
      await updatePrefs({ voice: { ...$prefs.get().voice, ...patch } })
      markSaved()
    } catch (error) {
      notify({ title: t('settings.general.saveFailed'), body: errorText(error), level: 'error' })
    }
  }

  const saveConfig = async (section: 'stt' | 'tts', provider: string) => {
    try {
      await rest.put('/api/config', { config: { [section]: { provider } } })
      config.reload()
      markSaved()
    } catch (error) {
      notify({ title: t('settings.voice.configFailed'), body: errorText(error), level: 'error' })
    }
  }

  const setEngine = async (engine: VoiceEngine) => {
    if (engine === 'live' && liveStatus && !liveStatus.available) {
      notify({ title: t('settings.voice.liveUnavailable'), body: liveStatus.reason ?? t('settings.voice.liveUnavailable.body'), level: 'warn' })

      return
    }

    await save({ engine })
  }

  const requestMic = async () => {
    try {
      setMic(await window.heraldOS.voice.requestMicrophone())
    } catch (error) {
      notify({ title: t('settings.voice.microphone'), body: errorText(error), level: 'error' })
    }
  }

  const sayHello = async () => {
    setTesting(true)

    try {
      await speakWithFreeFallback(t('settings.voice.hello'))
      config.reload()
      markSaved()
    } catch (error) {
      notify({ title: t('settings.voice.testFailed'), body: errorText(error), level: 'error' })
    } finally {
      setTesting(false)
    }
  }

  const saveLocalModel = async (model: string) => {
    try {
      await rest.put('/api/config', { config: { stt: { local: { model } } } })
      await updatePrefs({ voice: { ...$prefs.get().voice, sttTuned: true } })
      config.reload()
      markSaved()
    } catch (error) {
      notify({ title: t('settings.voice.configFailed'), body: errorText(error), level: 'error' })
    }
  }

  const sttProvider = config.data?.stt?.provider ?? 'local'
  const localModel = config.data?.stt?.local?.model ?? 'base'
  const ttsProvider = config.data?.tts?.provider ?? 'edge'
  const todayMinutes = Math.round(liveSecondsToday(voice) / 60)
  const todayCost = ((liveSecondsToday(voice) / 60) * LIVE_RATE_PER_MINUTE).toFixed(2)

  return (
    <>
      <SectionTitle title={t('settings.voice.title')} subtitle={t('settings.voice.subtitle')} />

      <SettingsGroup title={t('settings.voice.title')}>
        <SettingsRow icon={<IconMicrophone />} label={t('settings.voice.enable')} description={t('settings.voice.enable.hint')} keywords="talk speak jarvis">
          <Toggle checked={voice.enabled} onChange={next => void save({ enabled: next, wakeWord: next ? voice.wakeWord : false })} label={t('settings.voice.enable')} />
        </SettingsRow>
        <SettingsRow
          icon={<IconMicrophone />}
          label={t('settings.voice.access')}
          description={mic === 'granted' ? t('settings.voice.access.granted') : mic === 'denied' || mic === 'restricted' ? t('settings.voice.access.denied', { path: privacySettingsPath('Microphone') }) : t('settings.voice.access.unknown')}
          keywords="permission privacy"
        >
          {mic !== 'granted' && (
            <GlassButton size="sm" onClick={() => void requestMic()} aria-label={t('settings.voice.access.request')}>
              {t('settings.voice.access.button')}
            </GlassButton>
          )}
        </SettingsRow>
        <SettingsRow icon={<IconListDetails />} label={t('settings.voice.commands')} description={t('settings.voice.commands.hint')} keywords="commands help list">
          <GlassButton size="sm" onClick={() => focusSettings({ section: 'commands' })} aria-label={t('settings.voice.commands.aria')}>
            {t('settings.voice.commands.button')}
          </GlassButton>
        </SettingsRow>
        <SettingsRow icon={<IconPlayerPlay />} label={t('settings.voice.try')} description={t('settings.voice.try.hint')}>
          <GlassButton size="sm" onClick={() => void sayHello()} disabled={testing} aria-label={t('settings.voice.try.aria')}>
            <IconVolume />
            {testing ? t('settings.voice.speaking') : t('settings.voice.sayHello')}
          </GlassButton>
          <GlassButton size="sm" variant="primary" onClick={() => void startVoice('button')} disabled={active} aria-label={t('settings.voice.start.aria')}>
            {active ? t('settings.voice.listening') : t('settings.voice.start')}
          </GlassButton>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title={t('settings.voice.engine')}>
        <SettingsRow
          label={t('settings.voice.engine.label')}
          description={t('settings.voice.engine.hint')}
          keywords="chained gpt-live realtime cost"
          below={
            <div className="flex flex-col gap-2">
              <div className="flex gap-2">
                <RadioCard icon={<IconWaveSine />} label={t('settings.voice.free')} description={t('settings.voice.free.hint')} selected={voice.engine === 'chained'} onSelect={() => void setEngine('chained')} />
                <RadioCard
                  icon={<IconBolt />}
                  label={t('settings.voice.live')}
                  description={liveStatus?.available ? t('settings.voice.live.rate', { price: LIVE_RATE_PER_MINUTE.toFixed(2) }) : t('settings.voice.live.needs')}
                  selected={voice.engine === 'live'}
                  onSelect={() => void setEngine('live')}
                  disabled={liveStatus ? !liveStatus.available : false}
                />
              </div>
              {liveStatus && !liveStatus.available && <InlineNote tone="info">{t('settings.voice.live.unavailable', { reason: liveStatus.reason ?? '' })}</InlineNote>}
            </div>
          }
        />
      </SettingsGroup>

      <SettingsGroup title={t('settings.voice.starting')}>
        <SettingsRow
          icon={<IconEar />}
          label={t('settings.voice.wake', { phrase: wake.phrase })}
          description={
            wake.listening
              ? wake.capture === 'local' ? t('settings.voice.wake.listeningLocal') : t('settings.voice.wake.listening')
              : wake.error
                ? wake.error
                : t('settings.voice.wake.hint')
          }
          keywords="hey hermes always listening"
        >
          {wake.listening && <Pill tone="ok" dot>{t('settings.voice.wake.armed')}</Pill>}
          <Toggle checked={voice.wakeWord} onChange={next => void setWakeWordEnabled(next).then(markSaved)} label={t('settings.voice.wake.toggle')} />
        </SettingsRow>
        <SettingsRow icon={<IconKeyboard />} label={t('settings.voice.hotkey')} description={t('settings.voice.hotkey.hint')} keywords="shortcut push to talk">
          <input
            value={hotkeyDraft}
            onChange={event => setHotkeyDraft(event.target.value)}
            onBlur={() => hotkeyDraft.trim() !== voice.hotkey && void save({ hotkey: hotkeyDraft.trim() })}
            onKeyDown={event => {
              if (event.key === 'Enter') {
                event.currentTarget.blur()
              }
            }}
            aria-label={t('settings.voice.hotkey.aria')}
            spellCheck={false}
            className="glass-input h-8 w-[200px] rounded-lg px-2.5 font-mono text-[12px] text-fg outline-none"
          />
        </SettingsRow>
        <SettingsRow icon={<IconHourglass />} label={t('settings.voice.followUp')} description={t('settings.voice.followUp.hint')} keywords="continue listening">
          <Stepper value={voice.followUpSeconds} min={0} max={30} onChange={next => void save({ followUpSeconds: next })} label={t('settings.voice.followUp.aria')} />
        </SettingsRow>
        <SettingsRow icon={<IconHourglass />} label={t('settings.voice.duplex')} description={echoFallback ? t('settings.voice.duplex.echo') : t('settings.voice.duplex.hint')} keywords="duplex interrupt barge-in echo headphones">
          <Toggle checked={voice.duplex !== false && !echoFallback} onChange={next => void setDuplex(next).then(() => markSaved())} label={t('settings.voice.duplex')} />
        </SettingsRow>
        <VoiceMetricsRow />
        <SettingsRow icon={<IconEye />} label={t('settings.voice.follow')} description={t('settings.voice.follow.hint')} keywords="watch show work">
          <Toggle checked={voice.followHermes} onChange={next => void save({ followHermes: next })} label={t('settings.voice.follow')} />
        </SettingsRow>
        <SettingsRow icon={<IconBellRinging />} label={t('settings.voice.announce')} description={t('settings.voice.announce.hint')} keywords="announce read aloud">
          <Toggle checked={voice.announceNotifications} onChange={next => void save({ announceNotifications: next })} label={t('settings.voice.announce')} />
        </SettingsRow>
      </SettingsGroup>

      {engineKind === 'jarod' ? (
        <JarodSpeechGroup />
      ) : (
      <SettingsGroup title={t('settings.voice.providers')}>
        <SettingsRow icon={<IconLanguage />} label={t('settings.voice.stt')} description={config.error ? t('settings.voice.configUnreadable', { error: config.error }) : t('settings.voice.stt.hint')} keywords="stt transcribe whisper">
          <MenuDropdown ariaLabel={t('settings.voice.stt.aria')} label={STT_PROVIDERS.find(p => p.id === sttProvider)?.label ?? sttProvider} value={sttProvider} items={STT_PROVIDERS} onSelect={id => void saveConfig('stt', id)} disabled={!config.data} />
        </SettingsRow>
        {sttProvider === 'local' && (
          <SettingsRow icon={<IconWaveSine />} label={t('settings.voice.model')} description={t('settings.voice.model.hint')} keywords="whisper accuracy model local">
            <MenuDropdown ariaLabel={t('settings.voice.model.aria')} label={LOCAL_STT_MODELS.find(m => m.id === localModel)?.label ?? localModel} value={localModel} items={LOCAL_STT_MODELS} onSelect={id => void saveLocalModel(id)} disabled={!config.data} />
          </SettingsRow>
        )}
        <SettingsRow icon={<IconSpeakerphone />} label={t('settings.voice.tts')} description={t('settings.voice.tts.hint')} keywords="tts voice speak">
          <MenuDropdown ariaLabel={t('settings.voice.tts.aria')} label={TTS_PROVIDERS.find(p => p.id === ttsProvider)?.label ?? ttsProvider} value={ttsProvider} items={TTS_PROVIDERS} onSelect={id => void saveConfig('tts', id)} disabled={!config.data} />
        </SettingsRow>
      </SettingsGroup>
      )}

      <SettingsGroup title={t('settings.voice.cost')}>
        <SettingsRow icon={<IconClockPause />} label={t('settings.voice.idle')} description={t('settings.voice.idle.hint')} keywords="idle timeout">
          <MenuDropdown ariaLabel={t('settings.voice.idle.aria')} label={`${voice.liveIdleSeconds} s`} value={String(voice.liveIdleSeconds)} items={IDLE_OPTIONS.map(s => ({ id: String(s), label: t('settings.voice.seconds', { count: s }) }))} onSelect={id => void save({ liveIdleSeconds: Number(id) })} />
        </SettingsRow>
        <SettingsRow icon={<IconCoin />} label={t('settings.voice.cap')} description={t('settings.voice.cap.hint', { minutes: todayMinutes, cost: todayCost })} keywords="budget limit spend">
          <MenuDropdown ariaLabel={t('settings.voice.cap.aria')} label={voice.liveDailyCapMinutes ? `${voice.liveDailyCapMinutes} min` : t('settings.voice.noCap')} value={String(voice.liveDailyCapMinutes)} items={CAP_OPTIONS.map(m => ({ id: String(m), label: m ? t('settings.voice.capOption', { minutes: m, cost: (m * LIVE_RATE_PER_MINUTE).toFixed(2) }) : t('settings.voice.noCap') }))} onSelect={id => void save({ liveDailyCapMinutes: Number(id) })} />
        </SettingsRow>
      </SettingsGroup>
    </>
  )
}

/** What was measured on this run's voice conversations (src/store/voice-metrics.ts). */
function VoiceMetricsRow() {
  const metrics = useStore($voiceMetrics)
  const first = median(metrics.firstAudioMs)
  const transcript = median(metrics.transcriptMs)
  const token = median(metrics.firstTokenMs)
  const stop = median(metrics.stopMs)
  const ms = (value: number | null) => (value === null ? t('settings.voice.metrics.na') : t('settings.voice.metrics.ms', { ms: value }))
  const empty = metrics.firstAudioMs.length === 0 && metrics.stopMs.length === 0

  return (
    <SettingsRow
      icon={<IconHourglass />}
      label={t('settings.voice.metrics')}
      description={empty ? t('settings.voice.metrics.none') : `${t('settings.voice.metrics.values', { transcript: ms(transcript), token: ms(token), first: ms(first), stop: ms(stop), bargeIns: metrics.bargeIns, falseBargeIns: metrics.falseBargeIns })} — ${t('settings.voice.metrics.hint')}`}
      keywords="latency measure echo"
    />
  )
}

