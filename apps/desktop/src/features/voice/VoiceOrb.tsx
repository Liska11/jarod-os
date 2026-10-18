import { useStore } from '@nanostores/react'
import { type MessageKey, t, useT } from '../../lib/i18n.ts'
import { IconMicrophone, IconMicrophoneOff, IconPlayerStop, IconX } from '@tabler/icons-react'
import { cn } from '../../lib/cn.ts'
import { AvoidedByViews } from './ActionHud.tsx'
import type { VoiceState } from '../../lib/voice/engine.ts'
import { $prefs } from '../../store/backend.ts'
import { $echoFallback } from '../../store/voice-echo.ts'
import { $voiceMetrics } from '../../store/voice-metrics.ts'
import { $voice, $voiceActive, $voiceLevel, endConversation, interruptSpeech, LIVE_RATE_PER_MINUTE, toggleMute } from '../../store/voice.ts'

const LABEL: Record<VoiceState, MessageKey | null> = {
  off: null,
  armed: 'voiceOrb.armed',
  connecting: 'voiceOrb.connecting',
  listening: 'voiceOrb.listening',
  transcribing: 'voiceOrb.transcribing',
  thinking: 'voiceOrb.thinking',
  speaking: 'voiceOrb.speaking'
}

const TONE: Record<VoiceState, string> = {
  off: 'bg-fg-4',
  armed: 'bg-fg-3',
  connecting: 'bg-fg-3',
  listening: 'bg-accent-strong',
  transcribing: 'bg-progress',
  thinking: 'bg-progress',
  speaking: 'bg-ok'
}

function fmtSeconds(total: number): string {
  const minutes = Math.floor(total / 60)
  const seconds = Math.floor(total % 60)

  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

/** The animated presence: rings scale with the live audio level, colour follows the state. */
export function Orb({ state, level, size = 44, className }: { state: VoiceState; level: number; size?: number; className?: string }) {
  const prefs = useStore($prefs)
  const active = state !== 'off' && state !== 'armed'
  const scale = prefs.reduceMotion ? 1 : 1 + Math.min(0.6, level * 0.9)
  const pulse = !prefs.reduceMotion && (state === 'thinking' || state === 'connecting')

  return (
    <div className={cn('relative flex shrink-0 items-center justify-center', className)} style={{ width: size, height: size }} aria-hidden="true">
      <span
        className={cn('absolute inset-0 rounded-full opacity-25 transition-transform duration-75', TONE[state], pulse && 'animate-pulse-soft')}
        style={{ transform: `scale(${active ? scale : 0.9})` }}
      />
      <span className={cn('absolute inset-[18%] rounded-full opacity-45 transition-transform duration-75', TONE[state])} style={{ transform: `scale(${active ? 1 + (scale - 1) * 0.5 : 0.9})` }} />
      <span className={cn('absolute inset-[34%] rounded-full shadow-[0_0_18px_rgba(255,255,255,.25)]', TONE[state])} />
    </div>
  )
}

/**
 * Persistent conversation overlay: orb, state, captions and controls. Mounted once per Hermes
 * window beside Toasts/RequestHost; hidden while no conversation runs (the menu bar shows the
 * armed/mic state instead), so it never steals attention on its own.
 */
export function VoiceOrb({ offsetClass = 'bottom-24' }: { offsetClass?: string }) {
  useT()
  const voice = useStore($voice)
  const active = useStore($voiceActive)
  const level = useStore($voiceLevel)
  const prefs = useStore($prefs)
  const echoFallback = useStore($echoFallback)
  // The latest turn's breakdown (end of speech → transcript, first model text, first sound), read by e2e/voice-turn-latency.spec.ts.
  const lastTurn = useStore($voiceMetrics).lastTurn

  const label = LABEL[voice.state]

  if (!active) {
    return null
  }

  // The live engine ticks `sessionSeconds` once a second; today's total already includes past sessions.
  const liveSeconds = voice.live.sessionSeconds
  const estimate = ((voice.live.todaySeconds + liveSeconds) / 60) * LIVE_RATE_PER_MINUTE

  return (
    <div className={cn('pointer-events-none absolute inset-x-0 z-(--z-overlay) flex justify-center px-4', offsetClass)}>
      <AvoidedByViews role="status" aria-live="polite" data-voice-turn={lastTurn ? JSON.stringify(lastTurn) : undefined} className="float pointer-events-auto flex w-full max-w-xl items-center gap-3 rounded-2xl px-3.5 py-3 animate-rise">
        <Orb state={voice.state} level={level} />

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[11.5px] text-fg-3">
            <span className="font-medium text-fg-2">{label && t(label)}</span>
            {voice.muted ? (
              <span className="rounded-full bg-warn/20 px-1.5 text-warn">{t('voiceOrb.muted')}</span>
            ) : (
              voice.engine !== 'live' &&
              prefs.voice.duplex !== false &&
              (echoFallback ? (
                <span className="rounded-full bg-warn/20 px-1.5 text-warn" title={t('voiceOrb.echoClassic.title')}>
                  {t('voiceOrb.echoClassic')}
                </span>
              ) : (
                <span className="rounded-full bg-accent-soft px-1.5 text-accent-strong" title={t('voiceOrb.duplex.title')}>
                  {t('voiceOrb.duplex')}
                </span>
              ))
            )}
            {voice.engine === 'live' ? (
              <span className="ml-auto flex items-center gap-1.5 tabular-nums" title={t('voiceOrb.costTitle')}>
                <span className="rounded-full bg-accent-soft px-1.5 text-accent-strong">{t('voiceOrb.live')}</span>
                <span>{fmtSeconds(liveSeconds)}</span>
                <span className="text-fg-4">·</span>
                <span>≈ ${estimate.toFixed(2)} today</span>
              </span>
            ) : (
              <span className="ml-auto rounded-full bg-white/6 px-1.5 text-fg-4">{t('voiceOrb.free')}</span>
            )}
          </div>
          {voice.captions.user && <div className="mt-0.5 truncate text-[12.5px] text-fg-2">“{voice.captions.user}”</div>}
          {(voice.captions.assistant || voice.captions.interim) && <div className="mt-0.5 line-clamp-2 text-[13px] text-fg">{voice.captions.assistant || voice.captions.interim}</div>}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            aria-label={voice.muted ? t('voiceOrb.unmute') : t('voiceOrb.mute')}
            onClick={toggleMute}
            className={cn('flex size-8 items-center justify-center rounded-lg text-fg-2 hover:bg-white/10 hover:text-fg', voice.muted && 'text-warn')}
          >
            {voice.muted ? <IconMicrophoneOff size={16} /> : <IconMicrophone size={16} />}
          </button>
          {(voice.state === 'speaking' || voice.state === 'thinking') && (
            <button type="button" aria-label={t('voiceOrb.stop')} onClick={interruptSpeech} className="flex size-8 items-center justify-center rounded-lg text-fg-2 hover:bg-white/10 hover:text-fg">
              <IconPlayerStop size={16} />
            </button>
          )}
          <button type="button" aria-label={t('voiceOrb.end')} onClick={() => void endConversation('user')} className="flex size-8 items-center justify-center rounded-lg text-fg-2 hover:bg-danger/20 hover:text-danger">
            <IconX size={16} />
          </button>
        </div>
      </AvoidedByViews>
    </div>
  )
}
